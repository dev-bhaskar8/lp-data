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
        "per_page": 100,  # Get more coins in case some are not available on Binance
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
    stablecoins = {'USDT', 'USDC', 'BUSD', 'DAI', 'USDS', 'TUSD', 'USDP'}  # Known stablecoins
    
    for coin in data:
        symbol = coin['symbol'].upper()
        
        # Skip coins with very low market cap
        if coin['market_cap'] is None or coin['market_cap'] < 1000000:  # $1M minimum
            continue
            
        # Always include stablecoins if they meet market cap requirement
        if symbol in stablecoins:
            coins.append((symbol, coin['market_cap']))
            continue
            
        # For non-stablecoins, check if they have a trading pair
        try:
            # Try USDT pair first
            check_url = f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}USDT"
            response = session.get(check_url, timeout=10)
            response.raise_for_status()
            coins.append((symbol, coin['market_cap']))
            time.sleep(0.75)  # Rate limiting for Binance
        except requests.exceptions.RequestException:
            try:
                # Try BUSD pair as fallback
                check_url = f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}BUSD"
                response = session.get(check_url, timeout=10)
                response.raise_for_status()
                coins.append((symbol, coin['market_cap']))
                time.sleep(0.75)  # Rate limiting for Binance
            except requests.exceptions.RequestException:
                logger.warning(f"Skipping {symbol} - not available on Binance")
                continue
            
        if len(coins) >= 50:  # Stop after finding 50 valid coins
            break
            
    if not coins:
        raise Exception("No valid coins found")
        
    return coins

def get_historical_data(symbol, start_date, end_date, session=None):
    """Get historical price data from Binance or CoinGecko"""
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
            # Fallback to CoinGecko
            try:
                df = _fetch_coingecko_data(symbol, start_date, end_date, session)
                df.name = symbol
                return df
            except Exception as e2:
                raise Exception(f"Could not get USDT data from either source: Binance: {str(e)}, CoinGecko: {str(e2)}")

    # For all other coins, try Binance first
    try:
        df = _fetch_historical_data(f"{symbol}USDT", start_date, end_date, session)
        df.name = symbol
        return df
    except Exception as e:
        # For stablecoins and failed Binance requests, try CoinGecko
        try:
            df = _fetch_coingecko_data(symbol, start_date, end_date, session)
            df.name = symbol
            return df
        except Exception as e2:
            raise Exception(f"Could not get data for {symbol} from either source: Binance: {str(e)}, CoinGecko: {str(e2)}")

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
        
        # Fetch historical data for all coins against USDT
        logger.info("Fetching historical data for all coins...")
        start_date = datetime.now() - timedelta(days=365)
        end_date = datetime.now()
        
        all_coin_data = {}
        skipped_coins = []
        
        for symbol, mcap in tqdm(top_coins, desc="Fetching USDT pairs"):
            try:
                df = get_historical_data(symbol, start_date, end_date, session)
                all_coin_data[symbol] = {'data': df, 'mcap': mcap}
                time.sleep(1)  # Rate limiting
            except Exception as e:
                logger.warning(f"Could not get data for {symbol}: {str(e)}")
                skipped_coins.append(symbol)
                continue
        
        # Calculate returns for all coins
        logger.info("Calculating returns and correlations...")
        timeframes = {
            '7d': {'days': 7, 'threshold': 0.9},    # 90% for 7 days (need 6-7 days)
            '30d': {'days': 30, 'threshold': 0.85},  # 85% for 30 days (need 26 days)
            '90d': {'days': 90, 'threshold': 0.8},   # 80% for 90 days (need 72 days)
            '180d': {'days': 180, 'threshold': 0.75}, # 75% for 180 days (need 135 days)
            '365d': {'days': 365, 'threshold': 0.7}   # 70% for 365 days (need 256 days)
        }
        
        # Process each timeframe
        for period, config in timeframes.items():
            results = []
            days = config['days']
            threshold = config['threshold']
            end_date = datetime.now()
            start_date = end_date - timedelta(days=days)
            
            # Get returns for all coins in this timeframe
            returns_data = {}
            coins_without_enough_data = {}  # Track coins and their data points
            
            for symbol, coin_info in all_coin_data.items():
                df = coin_info['data']
                df = df[df.index >= start_date]
                if len(df) > 0:
                    returns = df['close'].pct_change().dropna()
                    required_points = int(days * threshold)
                    if len(returns) >= required_points:
                        returns_data[symbol] = returns
                    else:
                        coins_without_enough_data[symbol] = f"insufficient_data({len(returns)}/{required_points})"
                else:
                    coins_without_enough_data[symbol] = f"no_data"
            
            # Add all possible pairs with insufficient data to results
            all_symbols = list(all_coin_data.keys())
            for i, coin1 in enumerate(all_symbols):
                for coin2 in all_symbols[i+1:]:
                    pair = f"{coin1}-{coin2}"
                    combined_mcap = all_coin_data[coin1]['mcap'] + all_coin_data[coin2]['mcap']
                    
                    # If either coin lacks data, add to results with error
                    if coin1 in coins_without_enough_data:
                        results.append({
                            'Pair': pair,
                            'Correlation': f"err:{coin1}_{coins_without_enough_data[coin1]}",
                            'Combined Market Cap': format_market_cap(combined_mcap),
                            'Combined Change %': None
                        })
                        continue
                    elif coin2 in coins_without_enough_data:
                        results.append({
                            'Pair': pair,
                            'Correlation': f"err:{coin2}_{coins_without_enough_data[coin2]}",
                            'Combined Market Cap': format_market_cap(combined_mcap),
                            'Combined Change %': None
                        })
                        continue
            
            # Calculate correlations between all pairs with sufficient data
            symbols = list(returns_data.keys())
            for i, coin1 in enumerate(symbols):
                for coin2 in symbols[i+1:]:
                    pair = f"{coin1}-{coin2}"
                    try:
                        # Align returns by date
                        coin1_returns = returns_data[coin1]
                        coin2_returns = returns_data[coin2]
                        common_dates = coin1_returns.index.intersection(coin2_returns.index)
                        required_points = int(days * threshold)
                        
                        if len(common_dates) >= required_points:
                            # Calculate correlation
                            correlation = abs(coin1_returns[common_dates].corr(coin2_returns[common_dates]))
                            
                            # Calculate returns over the period
                            coin1_data = all_coin_data[coin1]['data'].loc[common_dates, 'close']
                            coin2_data = all_coin_data[coin2]['data'].loc[common_dates, 'close']
                            total_return_1 = ((coin1_data.iloc[-1] - coin1_data.iloc[0]) / coin1_data.iloc[0]) * 100
                            total_return_2 = ((coin2_data.iloc[-1] - coin2_data.iloc[0]) / coin2_data.iloc[0]) * 100
                            combined_change = (total_return_1 + total_return_2) / 2
                            
                            # Get market caps
                            combined_mcap = all_coin_data[coin1]['mcap'] + all_coin_data[coin2]['mcap']
                            
                            results.append({
                                'Pair': pair,
                                'Correlation': round(correlation, 4),
                                'Combined Market Cap': format_market_cap(combined_mcap),
                                'Combined Change %': round(combined_change, 2)
                            })
                        else:
                            results.append({
                                'Pair': pair,
                                'Correlation': f"err:overlap({len(common_dates)}/{required_points})",
                                'Combined Market Cap': format_market_cap(combined_mcap),
                                'Combined Change %': None
                            })
                    except Exception as e:
                        results.append({
                            'Pair': pair,
                            'Correlation': f"err:calc({str(e)[:50]})",
                            'Combined Market Cap': format_market_cap(combined_mcap),
                            'Combined Change %': None
                        })
                        continue
            
            # Save results
            if results:
                df_results = pd.DataFrame(results)
                # Sort with errors at the bottom
                df_results['is_error'] = df_results['Correlation'].apply(lambda x: str(x).startswith('err:'))
                df_results = df_results.sort_values(['is_error', 'Correlation'], ascending=[True, False])
                df_results = df_results.drop('is_error', axis=1)
                
                output_file = f'crypto_correlations_{period}.csv'
                df_results.to_csv(output_file, index=False)
                logger.info(f"Results saved to {output_file}")
                
                # Display top correlations
                print(f"\nTop 10 most correlated pairs ({period}):")
                pd.set_option('display.max_columns', None)
                pd.set_option('display.width', None)
                valid_results = df_results[~df_results['Correlation'].astype(str).str.startswith('err:')]
                print(valid_results.head(10).to_string())
                
                # Display error summary
                error_results = df_results[df_results['Correlation'].astype(str).str.startswith('err:')]
                if not error_results.empty:
                    print(f"\nError summary for {period} ({len(error_results)} pairs):")
                    error_types = error_results['Correlation'].value_counts()
                    print(error_types.head().to_string())
            else:
                logger.warning(f"No valid results for {period}")
        
        # Display skipped coins
        if skipped_coins:
            print("\nSkipped coins (failed to fetch data):")
            for symbol in sorted(skipped_coins):
                print(symbol)
        
    except Exception as e:
        logger.error(f"Fatal error: {str(e)}")
        raise

if __name__ == "__main__":
    main()