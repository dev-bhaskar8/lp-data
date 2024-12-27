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
        "per_page": 100,
        "page": 1,
        "sparkline": False
    }
    
    try:
        response = session.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
        time.sleep(1)  # Rate limiting for CoinGecko
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching data from CoinGecko: {str(e)}")
        raise
    
    coins = []
    
    for coin in data:
        symbol = coin['symbol'].upper()
        
        # Skip coins with very low market cap
        if coin['market_cap'] is None or coin['market_cap'] < 1000000:  # $1M minimum
            continue
            
        coins.append((symbol, coin['market_cap']))
        
        if len(coins) >= 50:  # Stop after finding 50 valid coins
            break
            
    if not coins:
        raise Exception("No valid coins found")
        
    return coins

def get_historical_data(symbol, start_date, end_date, session=None):
    """Get historical price data from Binance with CoinGecko fallback"""
    if session is None:
        session = create_session()

    # Special handling for USDT
    if symbol == 'USDT':
        try:
            # Get USDC/USDT data and invert it
            df = _fetch_historical_data('USDCUSDT', start_date, end_date, session)
            df['close'] = 1 / df['close']  # Invert to get USDT/USDC
            df.name = symbol
            return df
        except Exception as e:
            logger.warning(f"Could not get USDT data via Binance USDC: {str(e)}")
            try:
                df = _fetch_coingecko_data(symbol, start_date, end_date, session)
                df.name = symbol
                return df
            except Exception as e2:
                raise Exception(f"Failed to get USDT data: Binance: {str(e)}, CoinGecko: {str(e2)}")

    # For all other coins, try Binance first
    try:
        df = _fetch_historical_data(f"{symbol}USDT", start_date, end_date, session)
        df.name = symbol
        return df
    except Exception as e:
        logger.warning(f"Could not get {symbol} data from Binance: {str(e)}")
        try:
            df = _fetch_coingecko_data(symbol, start_date, end_date, session)
            df.name = symbol
            return df
        except Exception as e2:
            raise Exception(f"Failed to get {symbol} data: Binance: {str(e)}, CoinGecko: {str(e2)}")

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
        data = response.json()
        
        if not data:
            raise Exception(f"No data available for {trading_pair}")
            
        df = pd.DataFrame(data, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume', 'close_time', 'quote_av', 'trades', 'tb_base_av', 'tb_quote_av', 'ignore'])
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
        df.set_index('timestamp', inplace=True)
        df['close'] = df['close'].astype(float)
        
        # Validate data quality
        if df['close'].isnull().sum() > len(df) * 0.1:  # More than 10% missing data
            raise Exception(f"Too many missing values in {trading_pair} data")
        
        # Fill small gaps (up to 3 days)
        df['close'] = df['close'].ffill(limit=3)
        
        return df[['close']]
            
    except requests.exceptions.RequestException as e:
        raise Exception(f"Network error fetching {trading_pair}: {str(e)}")
    except Exception as e:
        raise Exception(f"Error processing {trading_pair} data: {str(e)}")

def _fetch_coingecko_data(symbol, start_date, end_date, session):
    """Fetch historical data from CoinGecko"""
    # Get coin ID first
    url = "https://api.coingecko.com/api/v3/coins/list"
    response = session.get(url, timeout=10)
    response.raise_for_status()
    coins = response.json()
    
    # Find the coin ID (case-insensitive match)
    coin_id = None
    for coin in coins:
        if coin['symbol'].upper() == symbol.upper():
            coin_id = coin['id']
            break
    
    if not coin_id:
        raise Exception(f"Could not find CoinGecko ID for {symbol}")
    
    # Get historical data
    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart/range"
    params = {
        "vs_currency": "usd",
        "from": int(start_date.timestamp()),
        "to": int(end_date.timestamp())
    }
    
    response = session.get(url, params=params, timeout=10)
    response.raise_for_status()
    data = response.json()
    
    # Convert to DataFrame
    prices = data['prices']
    df = pd.DataFrame(prices, columns=['timestamp', 'close'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
    df.set_index('timestamp', inplace=True)
    
    # Resample to daily data to match Binance format
    df = df.resample('D').last()
    
    return df

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
        min_required_points = int(timeframe_days * 0.7)  # Require 70% of timeframe days
        
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
        # Get data for each coin against USDT
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

def get_historical_data_parallel(symbols, start_date, end_date, session=None):
    """Get historical price data for multiple symbols in parallel"""
    if session is None:
        session = create_session()

    def fetch_single_coin(symbol):
        try:
            if symbol == 'USDT':
                try:
                    df = _fetch_historical_data('USDCUSDT', start_date, end_date, session)
                    df['close'] = 1 / df['close']
                    df.name = symbol
                    return symbol, df, None
                except Exception as e:
                    try:
                        df = _fetch_coingecko_data(symbol, start_date, end_date, session)
                        df.name = symbol
                        return symbol, df, None
                    except Exception as e2:
                        return symbol, None, f"Failed to get USDT data: Binance: {str(e)}, CoinGecko: {str(e2)}"
            
            try:
                df = _fetch_historical_data(f"{symbol}USDT", start_date, end_date, session)
                df.name = symbol
                return symbol, df, None
            except Exception as e:
                try:
                    df = _fetch_coingecko_data(symbol, start_date, end_date, session)
                    df.name = symbol
                    return symbol, df, None
                except Exception as e2:
                    return symbol, None, f"Failed to get {symbol} data: Binance: {str(e)}, CoinGecko: {str(e2)}"
        except Exception as e:
            return symbol, None, str(e)

    results = {}
    errors = {}
    
    with ThreadPoolExecutor(max_workers=5) as executor:
        future_to_symbol = {executor.submit(fetch_single_coin, symbol): symbol for symbol, _ in symbols}
        for future in tqdm(as_completed(future_to_symbol), total=len(symbols), desc="Fetching historical data"):
            symbol = future_to_symbol[future]
            try:
                symbol, df, error = future.result()
                if df is not None:
                    results[symbol] = df
                if error:
                    errors[symbol] = error
            except Exception as e:
                errors[symbol] = str(e)
            time.sleep(0.2)  # Small delay to avoid rate limits
            
    return results, errors

def calculate_correlations(returns_data, threshold_points, all_coin_data):
    """Calculate correlations between all pairs efficiently"""
    results = []
    symbols = list(returns_data.keys())
    
    # Pre-calculate common dates for all pairs
    common_dates = {}
    for i, coin1 in enumerate(symbols):
        for coin2 in symbols[i+1:]:
            dates = returns_data[coin1].index.intersection(returns_data[coin2].index)
            if len(dates) >= threshold_points:
                common_dates[(coin1, coin2)] = dates
    
    # Calculate correlations for valid pairs
    for (coin1, coin2), dates in common_dates.items():
        try:
            # Get aligned returns
            coin1_returns = returns_data[coin1][dates]
            coin2_returns = returns_data[coin2][dates]
            
            # Calculate correlation using numpy for speed
            correlation = abs(np.corrcoef(coin1_returns, coin2_returns)[0, 1])
            
            # Calculate returns over the period
            coin1_data = all_coin_data[coin1]['data'].loc[dates, 'close']
            coin2_data = all_coin_data[coin2]['data'].loc[dates, 'close']
            total_return_1 = ((coin1_data.iloc[-1] - coin1_data.iloc[0]) / coin1_data.iloc[0]) * 100
            total_return_2 = ((coin2_data.iloc[-1] - coin2_data.iloc[0]) / coin2_data.iloc[0]) * 100
            combined_change = (total_return_1 + total_return_2) / 2
            
            # Get market caps
            combined_mcap = all_coin_data[coin1]['mcap'] + all_coin_data[coin2]['mcap']
            
            results.append({
                'Pair': f"{coin1}-{coin2}",
                'Correlation': round(correlation, 4),
                'Combined Market Cap': format_market_cap(combined_mcap),
                'Combined Change %': round(combined_change, 2)
            })
        except Exception as e:
            combined_mcap = all_coin_data[coin1]['mcap'] + all_coin_data[coin2]['mcap']
            results.append({
                'Pair': f"{coin1}-{coin2}",
                'Correlation': f"err:calc({str(e)[:50]})",
                'Combined Market Cap': format_market_cap(combined_mcap),
                'Combined Change %': None
            })
    
    return results

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
        
        # Fetch historical data for all coins in parallel
        start_date = datetime.now() - timedelta(days=365)
        end_date = datetime.now()
        
        all_coin_data = {}
        coin_data_results, errors = get_historical_data_parallel(top_coins, start_date, end_date, session)
        
        # Process successful results
        for symbol, df in coin_data_results.items():
            mcap = next(m for s, m in top_coins if s == symbol)
            all_coin_data[symbol] = {'data': df, 'mcap': mcap}
        
        # Process timeframes
        timeframes = {
            '7d': {'days': 7, 'threshold': 0.9},
            '30d': {'days': 30, 'threshold': 0.85},
            '90d': {'days': 90, 'threshold': 0.8},
            '180d': {'days': 180, 'threshold': 0.75},
            '365d': {'days': 365, 'threshold': 0.7}
        }
        
        # Calculate returns for all timeframes at once
        all_returns = {}
        for symbol, coin_info in all_coin_data.items():
            df = coin_info['data']
            all_returns[symbol] = df['close'].pct_change().dropna()
        
        # Process each timeframe
        for period, config in timeframes.items():
            days = config['days']
            threshold = config['threshold']
            required_points = int(days * threshold)
            
            # Filter returns for this timeframe
            period_start = datetime.now() - timedelta(days=days)
            returns_data = {
                symbol: returns[returns.index >= period_start]
                for symbol, returns in all_returns.items()
            }
            
            # Track coins without enough data
            coins_without_enough_data = {
                symbol: f"insufficient_data({len(returns)}/{required_points})"
                for symbol, returns in returns_data.items()
                if len(returns) < required_points
            }
            
            # Remove coins without enough data
            returns_data = {
                symbol: returns
                for symbol, returns in returns_data.items()
                if len(returns) >= required_points
            }
            
            # Calculate correlations efficiently
            results = calculate_correlations(returns_data, required_points, all_coin_data)
            
            # Add pairs with insufficient data
            all_symbols = list(all_coin_data.keys())
            for i, coin1 in enumerate(all_symbols):
                for coin2 in all_symbols[i+1:]:
                    if coin1 in coins_without_enough_data or coin2 in coins_without_enough_data:
                        error_coin = coin1 if coin1 in coins_without_enough_data else coin2
                        error_msg = coins_without_enough_data[error_coin]
                        combined_mcap = all_coin_data[coin1]['mcap'] + all_coin_data[coin2]['mcap']
                        results.append({
                            'Pair': f"{coin1}-{coin2}",
                            'Correlation': f"err:{error_coin}_{error_msg}",
                            'Combined Market Cap': format_market_cap(combined_mcap),
                            'Combined Change %': None
                        })
            
            # Save and display results
            if results:
                df_results = pd.DataFrame(results)
                df_results['is_error'] = df_results['Correlation'].apply(lambda x: str(x).startswith('err:'))
                df_results = df_results.sort_values(['is_error', 'Correlation'], ascending=[True, False])
                df_results = df_results.drop('is_error', axis=1)
                
                output_file = f'crypto_correlations_{period}.csv'
                df_results.to_csv(output_file, index=False)
                logger.info(f"Results saved to {output_file}")
                
                print(f"\nTop 10 most correlated pairs ({period}):")
                pd.set_option('display.max_columns', None)
                pd.set_option('display.width', None)
                valid_results = df_results[~df_results['Correlation'].astype(str).str.startswith('err:')]
                print(valid_results.head(10).to_string())
                
                error_results = df_results[df_results['Correlation'].astype(str).str.startswith('err:')]
                if not error_results.empty:
                    print(f"\nError summary for {period} ({len(error_results)} pairs):")
                    error_types = error_results['Correlation'].value_counts()
                    print(error_types.head().to_string())
            else:
                logger.warning(f"No valid results for {period}")
        
        # Display errors from data fetching
        if errors:
            print("\nErrors during data fetching:")
            for symbol, error in errors.items():
                print(f"{symbol}: {error}")
        
    except Exception as e:
        logger.error(f"Fatal error: {str(e)}")
        raise

if __name__ == "__main__":
    main()