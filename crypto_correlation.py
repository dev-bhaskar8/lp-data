import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import requests
from itertools import combinations
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm
from requests.adapters import HTTPAdapter
from requests.packages.urllib3.util.retry import Retry
import logging

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def create_session():
    """Create a requests session with retries"""
    session = requests.Session()
    retries = Retry(
        total=5,
        backoff_factor=0.5,
        status_forcelist=[500, 502, 503, 504, 429],
    )
    session.mount('http://', HTTPAdapter(max_retries=retries))
    session.mount('https://', HTTPAdapter(max_retries=retries))
    return session

def get_top_coins(session=None):
    """Get top coins by market cap from CoinGecko"""
    if session is None:
        session = create_session()
        
    url = "https://api.coingecko.com/api/v3/coins/markets"
    params = {
        "vs_currency": "usd",
        "order": "market_cap_desc",
        "per_page": 30,  # Get more coins in case some are not available on Binance
        "page": 1,
        "sparkline": False
    }
    
    try:
        response = session.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching data from CoinGecko: {str(e)}")
        raise
    
    coins = []
    for coin in data:
        symbol = coin['symbol'].upper()
        
        # Skip coins with very low market cap
        if coin['market_cap'] is None or coin['market_cap'] < 1000000:  # $1M minimum
            continue
            
        # Always add USDT since it's our base currency
        if symbol == 'USDT':
            coins.append((symbol, coin['market_cap']))
            continue
            
        # For all other coins, check if they have a USDT trading pair
        try:
            check_url = f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}USDT"
            response = session.get(check_url, timeout=10)
            response.raise_for_status()
            coins.append((symbol, coin['market_cap']))
            time.sleep(0.5)  # Rate limiting
        except requests.exceptions.RequestException:
            # If direct pair fails, try reverse pair (for stablecoins like USDC)
            try:
                check_url = f"https://api.binance.com/api/v3/ticker/price?symbol=USDT{symbol}"
                response = session.get(check_url, timeout=10)
                response.raise_for_status()
                coins.append((symbol, coin['market_cap']))
                time.sleep(0.5)  # Rate limiting
            except requests.exceptions.RequestException:
                logger.warning(f"Skipping {symbol} - not available on Binance")
                continue
            
        if len(coins) >= 20:  # Stop after finding 20 valid coins
            break
            
    if not coins:
        raise Exception("No valid coins found")
        
    return coins

def get_historical_data(symbol, start_date, end_date, session=None):
    """Get historical price data from Binance"""
    if session is None:
        session = create_session()

    # If symbol is USDT, we need to handle it specially since it's our base
    if symbol == 'USDT':
        raise Exception("USDT data should be derived from the other coin in the pair")

    # For all other coins, try both directions
    pairs_to_try = [
        (f"{symbol}USDT", False),
        (f"USDT{symbol}", True)
    ]
    
    last_error = None
    for trading_pair, should_invert in pairs_to_try:
        try:
            df = _fetch_historical_data(trading_pair, start_date, end_date, session)
            if should_invert:
                df['close'] = 1 / df['close']
            return df
        except Exception as e:
            last_error = e
            continue
    
    # If all pairs failed, raise the last error
    raise Exception(f"Could not get data for {symbol} from any trading pair: {str(last_error)}")

def _fetch_historical_data(trading_pair, start_date, end_date, session):
    """Helper function to fetch historical data from Binance"""
    url = "https://api.binance.com/api/v3/klines"
    params = {
        "symbol": trading_pair,
        "interval": "1d",
        "startTime": int(start_date.timestamp() * 1000),
        "endTime": int(end_date.timestamp() * 1000),
        "limit": 1000
    }
    
    try:
        response = session.get(url, params=params, timeout=10)
        response.raise_for_status()
        klines = response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching data for {trading_pair}: {str(e)}")
        raise
    
    if not klines:
        raise Exception(f"No data available for {trading_pair}")
    
    df = pd.DataFrame(klines, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume', 'close_time', 'quote_av', 'trades', 'tb_base_av', 'tb_quote_av', 'ignore'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
    df.set_index('timestamp', inplace=True)
    df['close'] = df['close'].astype(float)
    
    # Validate data quality
    if df['close'].isnull().sum() > len(df) * 0.1:  # More than 10% missing data
        raise Exception(f"Too many missing values in {trading_pair} data")
    
    # Fill small gaps (up to 3 days)
    df['close'] = df['close'].ffill(limit=3)
    
    return df[['close']]

def calculate_correlation_metrics(coin1_data, coin2_data, coin1_mcap, coin2_mcap, timeframe_days):
    """Calculate correlation and other metrics between two coins for a specific timeframe"""
    try:
        # Filter data for timeframe
        end_date = coin1_data.index.max()
        start_date = end_date - pd.Timedelta(days=timeframe_days)
        
        coin1_data = coin1_data[coin1_data.index >= start_date]
        coin2_data = coin2_data[coin2_data.index >= start_date]
        
        # Ensure both DataFrames have the same index
        common_dates = coin1_data.index.intersection(coin2_data.index)
        min_required_points = int(timeframe_days * 0.8)  # Require 80% of timeframe days
        
        if len(common_dates) < min_required_points:
            raise Exception(f"Insufficient data points for {timeframe_days}-day correlation calculation (need {min_required_points}, got {len(common_dates)})")
        
        # Get data for common dates
        coin1_prices = coin1_data.loc[common_dates, 'close']
        coin2_prices = coin2_data.loc[common_dates, 'close']
        
        # Calculate returns instead of using raw prices
        coin1_returns = coin1_prices.pct_change().dropna()
        coin2_returns = coin2_prices.pct_change().dropna()
        
        # Drop any remaining NaN values
        valid_data = pd.DataFrame({
            'coin1': coin1_returns,
            'coin2': coin2_returns
        }).dropna()
        
        if len(valid_data) < min_required_points:
            raise Exception(f"Insufficient data points after removing NaN values for {timeframe_days}-day period")
        
        # Calculate correlation using returns
        correlation = valid_data['coin1'].corr(valid_data['coin2'])
        if not -1 <= correlation <= 1:
            raise Exception("Invalid correlation value")
            
        # Normalize correlation to always be positive
        correlation = abs(correlation)
            
        # Calculate total returns for the timeframe
        total_return_1 = ((coin1_prices.iloc[-1] - coin1_prices.iloc[0]) / coin1_prices.iloc[0]) * 100
        total_return_2 = ((coin2_prices.iloc[-1] - coin2_prices.iloc[0]) / coin2_prices.iloc[0]) * 100
        combined_change = (total_return_1 + total_return_2) / 2
        combined_mcap = coin1_mcap + coin2_mcap
        
        return correlation, combined_change, combined_mcap
        
    except Exception as e:
        logger.error(f"Error calculating metrics: {str(e)}")
        raise

def format_market_cap(value):
    """Format market cap value into human-readable string"""
    try:
        if not isinstance(value, (int, float)) or value < 0:
            raise ValueError("Invalid market cap value")
            
        if value >= 1e12:
            return f"${value/1e12:.2f}T"
        if value >= 1e9:
            return f"${value/1e9:.2f}B"
        if value >= 1e6:
            return f"${value/1e6:.2f}M"
        return f"${value:.2f}"
    except Exception as e:
        logger.error(f"Error formatting market cap: {str(e)}")
        return "N/A"

def get_usdt_data(start_date, end_date, session):
    """Get USDT price data using USDC as reference"""
    try:
        df = _fetch_historical_data('USDCUSDT', start_date, end_date, session)
        df['close'] = 1 / df['close']  # Invert to get USDT/USDC
        return df
    except Exception as e:
        raise Exception(f"Could not get USDT data via USDC: {str(e)}")

def process_pair(pair_data, session=None):
    """Process a single pair of coins for all timeframes"""
    if session is None:
        session = create_session()
        
    (coin1, mcap1), (coin2, mcap2) = pair_data
    start_date = datetime.now() - timedelta(days=365)
    end_date = datetime.now()
    
    try:
        # Get data for each coin
        if coin1 == 'USDT':
            coin1_data = get_usdt_data(start_date, end_date, session)
            coin2_data = get_historical_data(coin2, start_date, end_date, session)
        elif coin2 == 'USDT':
            coin1_data = get_historical_data(coin1, start_date, end_date, session)
            coin2_data = get_usdt_data(start_date, end_date, session)
        else:
            coin1_data = get_historical_data(coin1, start_date, end_date, session)
            time.sleep(1)  # Rate limiting
            coin2_data = get_historical_data(coin2, start_date, end_date, session)
        
        # Calculate metrics for each timeframe
        timeframes = {
            '7d': 7,
            '30d': 30,
            '90d': 90,
            '180d': 180,
            '365d': 365
        }
        
        results = {}
        for period, days in timeframes.items():
            try:
                correlation, combined_change, combined_mcap = calculate_correlation_metrics(
                    coin1_data, coin2_data, mcap1, mcap2, days
                )
                
                results[period] = {
                    'Pair': f"{coin1}-{coin2}",
                    'Correlation': round(correlation, 4),
                    'Combined Market Cap': format_market_cap(combined_mcap),
                    'Combined Change %': round(combined_change, 2)
                }
            except Exception as e:
                logger.warning(f"Could not calculate {period} metrics for {coin1}-{coin2}: {str(e)}")
                results[period] = None
        
        return results
    except Exception as e:
        logger.error(f"Error processing pair {coin1}-{coin2}: {str(e)}")
        return None

def main():
    """Main function to run the correlation analysis"""
    try:
        logger.info("Starting cryptocurrency correlation analysis")
        session = create_session()
        
        # Get top coins
        logger.info("Fetching top coins by market cap...")
        top_coins = get_top_coins(session)
        logger.info(f"Found {len(top_coins)} coins:")
        for symbol, mcap in top_coins:
            logger.info(f"{symbol}: {format_market_cap(mcap)}")
        
        # Generate pairs and process
        pairs = list(combinations(top_coins, 2))
        total_pairs = len(pairs)
        logger.info(f"Calculating correlations for {total_pairs} pairs using parallel processing...")
        
        # Dictionary to store results for each timeframe
        timeframe_results = {
            '7d': [],
            '30d': [],
            '90d': [],
            '180d': [],
            '365d': []
        }
        
        # Track skipped pairs
        skipped_pairs = []
        
        with ThreadPoolExecutor(max_workers=5) as executor:
            future_to_pair = {executor.submit(process_pair, pair, session): pair for pair in pairs}
            
            with tqdm(total=total_pairs, desc="Processing pairs") as pbar:
                for future in as_completed(future_to_pair):
                    pair = future_to_pair[future]
                    results = future.result()
                    if results:
                        for period, result in results.items():
                            if result:
                                timeframe_results[period].append(result)
                    else:
                        skipped_pairs.append(f"{pair[0][0]}-{pair[1][0]}")
                    pbar.update(1)
        
        # Create and save results for each timeframe
        for period, results in timeframe_results.items():
            if not results:
                logger.warning(f"No valid results for {period}")
                continue
                
            df_results = pd.DataFrame(results)
            df_results = df_results.sort_values('Correlation', ascending=False)
            
            output_file = f'crypto_correlations_{period}.csv'
            df_results.to_csv(output_file, index=False)
            logger.info(f"Results saved to {output_file}")
            
            # Display top correlations for each timeframe
            print(f"\nTop 5 most correlated pairs ({period}):")
            pd.set_option('display.max_columns', None)
            pd.set_option('display.width', None)
            print(df_results.head().to_string())
        
        # Display skipped pairs
        if skipped_pairs:
            print("\nSkipped pairs:")
            for pair in sorted(skipped_pairs):
                print(pair)
        
    except Exception as e:
        logger.error(f"Fatal error: {str(e)}")
        raise

if __name__ == "__main__":
    main()