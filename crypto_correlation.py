import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import requests
from itertools import combinations
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm

def get_top_coins():
    url = "https://api.coingecko.com/api/v3/coins/markets"
    params = {
        "vs_currency": "usd",
        "order": "market_cap_desc",
        "per_page": 10,
        "page": 1,
        "sparkline": False
    }
    response = requests.get(url, params=params)
    if response.status_code != 200:
        raise Exception(f"CoinGecko API error: {response.status_code}")
    data = response.json()
    coins = []
    for coin in data:
        symbol = coin['symbol'].upper()
        # Include all coins including stablecoins
        if symbol in ['USDT', 'USDC']:
            coins.append((symbol, coin['market_cap']))
            continue
            
        check_url = f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}USDT"
        try:
            response = requests.get(check_url)
            if response.status_code == 200:
                coins.append((symbol, coin['market_cap']))
            time.sleep(0.5)
        except:
            continue
    return coins

def get_historical_data(symbol, start_date, end_date):
    # Determine the trading pair
    if symbol == 'USDT':
        trading_pair = 'USDCUSDT'  # Use USDC/USDT pair for USDT
    elif symbol == 'USDC':
        trading_pair = 'USDCUSDT'  # Use USDC/USDT pair for USDC
    else:
        trading_pair = f"{symbol}USDT"

    url = "https://api.binance.com/api/v3/klines"
    params = {
        "symbol": trading_pair,
        "interval": "1d",
        "startTime": int(start_date.timestamp() * 1000),
        "endTime": int(end_date.timestamp() * 1000),
        "limit": 1000
    }
    
    response = requests.get(url, params=params)
    if response.status_code != 200:
        raise Exception(f"Binance API error: {response.status_code}")
    
    klines = response.json()
    if not klines:
        raise Exception(f"No data available for {trading_pair}")
    
    df = pd.DataFrame(klines, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume', 'close_time', 'quote_av', 'trades', 'tb_base_av', 'tb_quote_av', 'ignore'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
    df.set_index('timestamp', inplace=True)
    df['close'] = df['close'].astype(float)
    
    # For USDT when using USDC/USDT pair, we need to invert the price
    if symbol == 'USDT':
        df['close'] = 1 / df['close']
    
    # Fill small gaps (up to 3 days)
    df['close'] = df['close'].ffill(limit=3)
    
    return df[['close']]

def calculate_correlation_metrics(coin1_data, coin2_data, coin1_mcap, coin2_mcap):
    # Special handling for stablecoin pairs
    if isinstance(coin1_data, pd.DataFrame) and isinstance(coin2_data, pd.DataFrame):
        if coin1_data['close'].equals(coin2_data['close']):  # Both are stablecoins
            correlation = 1.0
            combined_change = 0.0
            combined_mcap = coin1_mcap + coin2_mcap
            return correlation, combined_change, combined_mcap

    # Ensure both DataFrames have the same index
    common_dates = coin1_data.index.intersection(coin2_data.index)
    if len(common_dates) < 30:  # Require at least 30 days of data
        raise Exception("Insufficient data points for correlation calculation")
    
    # Get data for common dates
    coin1_prices = coin1_data.loc[common_dates, 'close']
    coin2_prices = coin2_data.loc[common_dates, 'close']
    
    # Drop any remaining NaN values
    valid_data = pd.DataFrame({'coin1': coin1_prices, 'coin2': coin2_prices}).dropna()
    if len(valid_data) < 30:
        raise Exception("Insufficient data points after removing NaN values")
    
    correlation = valid_data['coin1'].corr(valid_data['coin2'])
    pct_change_1 = ((valid_data['coin1'].iloc[-1] - valid_data['coin1'].iloc[0]) / valid_data['coin1'].iloc[0]) * 100
    pct_change_2 = ((valid_data['coin2'].iloc[-1] - valid_data['coin2'].iloc[0]) / valid_data['coin2'].iloc[0]) * 100
    combined_change = (pct_change_1 + pct_change_2) / 2
    combined_mcap = coin1_mcap + coin2_mcap
    
    return correlation, combined_change, combined_mcap

def format_market_cap(value):
    if value >= 1e12:
        return f"${value/1e12:.2f}T"
    if value >= 1e9:
        return f"${value/1e9:.2f}B"
    if value >= 1e6:
        return f"${value/1e6:.2f}M"
    return f"${value:.2f}"

def process_pair(pair_data):
    (coin1, mcap1), (coin2, mcap2) = pair_data
    start_date = datetime.now() - timedelta(days=365)
    end_date = datetime.now()
    
    try:
        coin1_data = get_historical_data(coin1, start_date, end_date)
        time.sleep(1)  # Rate limiting
        coin2_data = get_historical_data(coin2, start_date, end_date)
        
        correlation, combined_change, combined_mcap = calculate_correlation_metrics(
            coin1_data, coin2_data, mcap1, mcap2
        )
        
        return {
            'Pair': f"{coin1}-{coin2}",
            'Correlation': round(correlation, 4),
            'Combined Market Cap': format_market_cap(combined_mcap),
            'Combined Yearly Change %': round(combined_change, 2)
        }
    except Exception as e:
        print(f"Error processing pair {coin1}-{coin2}: {str(e)}")
        return None

def main():
    print("Fetching top 10 coins by market cap...")
    try:
        top_coins = get_top_coins()
        print(f"\nFound {len(top_coins)} coins:")
        for symbol, mcap in top_coins:
            print(f"{symbol}: {format_market_cap(mcap)}")
    except Exception as e:
        print(f"Error fetching top coins: {str(e)}")
        return
    
    pairs = list(combinations(top_coins, 2))
    total_pairs = len(pairs)
    print(f"\nCalculating correlations for {total_pairs} pairs using parallel processing...")
    
    results = []
    with ThreadPoolExecutor(max_workers=5) as executor:
        # Submit all pairs for processing
        future_to_pair = {executor.submit(process_pair, pair): pair for pair in pairs}
        
        # Process results as they complete with progress bar
        with tqdm(total=total_pairs, desc="Processing pairs") as pbar:
            for future in as_completed(future_to_pair):
                result = future.result()
                if result:
                    results.append(result)
                pbar.update(1)
    
    if not results:
        print("No valid results were obtained")
        return
    
    df_results = pd.DataFrame(results)
    df_results = df_results.sort_values('Correlation', ascending=False)
    
    output_file = 'crypto_correlations.csv'
    df_results.to_csv(output_file, index=False)
    print(f"\nResults saved to {output_file}")
    print("\nTop 5 most correlated pairs:")
    pd.set_option('display.max_columns', None)
    pd.set_option('display.width', None)
    print(df_results.head().to_string())

if __name__ == "__main__":
    main()