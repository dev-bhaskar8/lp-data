import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  CircularProgress,
  Autocomplete,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import axios from 'axios';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const timeframes = [
  { label: '7 Days', value: 7 },
  { label: '30 Days', value: 30 },
  { label: '90 Days', value: 90 },
  { label: '180 Days', value: 180 },
  { label: '1 Year', value: 365 },
];

// Move cache outside component
const globalCache = {
  tokens: null,
  tokenData: new Map(),
  lastFetch: new Map(),
};

// Move API key to top level constants
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const API_DELAY = 3000; // 3 seconds between API calls
const MAX_RETRIES = 3;
const HISTORICAL_DELAY = 5000; // 5 seconds for historical data
const BASE_URL = 'https://api.coingecko.com/api/v3';

// Read API key once from environment
const COINGECKO_API_KEY = (() => {
  // Log available environment variables in development
  if (import.meta.env.DEV) {
    console.log('Available environment variables:', Object.keys(import.meta.env));
  }

  // Try both environment variable formats
  const key = import.meta.env.VITE_COINGECKO_API_KEY;
  
  if (!key) {
    console.warn('CoinGecko API key not found. Please check your .env file has VITE_COINGECKO_API_KEY set.');
    return null;
  }

  console.log('CoinGecko API key loaded successfully');
  return key;
})();

// Add formatMarketCap function at the top level
const formatMarketCap = (value) => {
  if (!value && value !== 0) return 'N/A';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toFixed(2)}`;
};

export default function CustomPairsAnalysis({ open, onClose }) {
  const [token1, setToken1] = useState(null);
  const [token2, setToken2] = useState(null);
  const [searchToken1, setSearchToken1] = useState('');
  const [searchToken2, setSearchToken2] = useState('');
  const [tokenOptions, setTokenOptions] = useState([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [selectedTimeframe, setSelectedTimeframe] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [analysisData, setAnalysisData] = useState(null);
  const [tokenData, setTokenData] = useState({ token1: null, token2: null });

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const fetchWithRetry = async (url, params = {}, retries = MAX_RETRIES, delay = API_DELAY, isHistorical = false) => {
    // Check cache first
    const cacheKey = url + JSON.stringify(params);
    const cached = globalCache.tokenData.get(cacheKey);
    const lastFetchTime = globalCache.lastFetch.get(cacheKey);
    
    if (cached && lastFetchTime && (Date.now() - lastFetchTime < CACHE_DURATION)) {
      return { data: cached };
    }

    // If there was a recent fetch for any endpoint, wait
    const lastAnyFetch = Math.max(...Array.from(globalCache.lastFetch.values()));
    if (lastAnyFetch) {
      const timeSinceLastFetch = Date.now() - lastAnyFetch;
      const requiredDelay = isHistorical ? HISTORICAL_DELAY : delay;
      if (timeSinceLastFetch < requiredDelay) {
        await sleep(requiredDelay - timeSinceLastFetch);
      }
    }

    let lastError;
    for (let i = 0; i < retries; i++) {
      try {
        // Add delay between retries
        if (i > 0) {
          const retryDelay = isHistorical ? 
            HISTORICAL_DELAY * Math.pow(2, i) : // Longer exponential backoff for historical
            delay * Math.pow(1.5, i); // Shorter exponential backoff for other requests
          console.log(`Retry ${i + 1} after ${retryDelay}ms delay...`);
          await sleep(retryDelay);
        }

        // Check API key before each request
        const headers = {};
        if (COINGECKO_API_KEY) {
          headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
          console.log('Using API key for request to:', new URL(url).pathname);
        } else {
          console.log('No API key available, using public API for:', new URL(url).pathname);
        }

        // Add proxy to bypass CORS
        const proxyUrl = 'https://api.coingecko.com';
        const finalUrl = url.replace(proxyUrl, proxyUrl);

        const response = await axios.get(finalUrl, { 
          params,
          timeout: isHistorical ? 30000 : 10000, // 30 second timeout for historical
          headers,
          validateStatus: function (status) {
            return status >= 200 && status < 300; // Only accept success status codes
          }
        });
        
        // Validate response data
        if (!response.data) {
          console.error('Empty response received from:', url);
          throw new Error('Empty response received');
        }

        // For historical data, validate price data structure
        if (isHistorical && (!response.data.prices || !Array.isArray(response.data.prices))) {
          console.error('Invalid historical data format from:', url);
          throw new Error('Invalid historical data format');
        }

        // Cache the response
        globalCache.tokenData.set(url + JSON.stringify(params), response.data);
        globalCache.lastFetch.set(url + JSON.stringify(params), Date.now());

        // Add extra delay after successful historical data fetch
        if (isHistorical) {
          await sleep(HISTORICAL_DELAY);
        }

        return response;
      } catch (error) {
        lastError = error;
        console.error(`Attempt ${i + 1} failed for ${url}:`, error.message);
        
        if (error.response?.status === 429) {
          const waitTime = (isHistorical ? HISTORICAL_DELAY : delay) * Math.pow(2, i);
          console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
          await sleep(waitTime);
          continue;
        }

        if (error.response?.status === 404) {
          throw new Error('Token data not found. Please try different tokens.');
        }
        
        if (error.code === 'ECONNABORTED') {
          throw new Error(isHistorical ? 
            'Historical data request timed out. Please try again.' : 
            'Request timed out. Please try again.');
        }

        // For network errors, use longer delays and check API key
        if (error.code === 'ERR_NETWORK') {
          console.error('Network error details:', error);
          const networkRetryDelay = delay * Math.pow(3, i); // More aggressive backoff for network errors
          console.log(`Network error. Waiting ${networkRetryDelay}ms before retry... API Key present: ${!!COINGECKO_API_KEY}`);
          await sleep(networkRetryDelay);
          continue;
        }
        
        // For historical data, try one more time with a longer delay
        if (isHistorical && i === retries - 2) {
          console.log('Last attempt for historical data with extended delay...');
          await sleep(10000); // 10 second delay before last attempt
          continue;
        }
        
        if (i === retries - 1) {
          throw new Error('Network connection error. Please check your internet connection and try again.');
        }
      }
    }

    // If we've exhausted all retries, throw a user-friendly error
    if (isHistorical) {
      throw new Error('Unable to fetch historical data after multiple attempts. Please check your internet connection and try again.');
    } else {
      throw new Error('Request failed after multiple attempts. Please check your internet connection and try again.');
    }
  };

  // Update the fetchTokens function to be more efficient
  const fetchTokens = async (searchText) => {
    if (!searchText || searchText.length < 2) return;
    
    // Use cached tokens if available and search is short
    if (globalCache.tokens) {
      console.log(`Using cached tokens (${globalCache.tokens.length} tokens available)`);
      setTokenOptions(globalCache.tokens);
      return;
    }

    // Debounce the API call
    if (globalCache.searchTimeout) {
      clearTimeout(globalCache.searchTimeout);
    }

    // Wait 500ms before making API call to avoid rapid requests
    globalCache.searchTimeout = setTimeout(async () => {
      setLoadingTokens(true);
      setError('');
      
      try {
        // Fetch more tokens, up to 1000
        const topTokensResponse = await fetchWithRetry('https://api.coingecko.com/api/v3/coins/markets', {
          vs_currency: 'usd',
          order: 'market_cap_desc', // Changed to market cap for better coverage
          per_page: 1000,
          sparkline: false
        });
        
        if (topTokensResponse.data && Array.isArray(topTokensResponse.data)) {
          console.log(`Fetched ${topTokensResponse.data.length} tokens from API`);
          // Process top tokens
          const topTokens = topTokensResponse.data.map(token => ({
            id: token.id,
            symbol: token.symbol.toLowerCase(), // Store lowercase for easier comparison
            name: token.name,
            market_cap: token.market_cap || 0,
            volume: token.total_volume || 0
          }));

          globalCache.tokens = topTokens;
          console.log('Updated token cache with new data');
          setTokenOptions(topTokens);
        }
      } catch (error) {
        console.error('Error fetching tokens:', error);
        if (error.response?.status === 429) {
          setError('Rate limit reached. Please wait a moment and try again.');
        } else {
          setError('Failed to fetch token list. Please try again.');
        }
      } finally {
        setLoadingTokens(false);
      }
    }, 500);
  };

  // Update search handlers to trigger token fetch
  const handleSearchToken1 = (newValue) => {
    setSearchToken1(newValue);
    if (newValue.length >= 2) {
      fetchTokens(newValue);
    } else {
      setTokenOptions([]);
    }
  };

  const handleSearchToken2 = (newValue) => {
    setSearchToken2(newValue);
    if (newValue.length >= 2) {
      fetchTokens(newValue);
    } else {
      setTokenOptions([]);
    }
  };

  // Update the filtering logic to be more inclusive
  const getFilteredOptions = (searchText) => {
    if (!searchText) return [];
    const lowerSearch = searchText.toLowerCase();
    console.log(`Filtering tokens for search: "${lowerSearch}"`);

    // First, find exact matches (symbol or name)
    const exactMatches = tokenOptions.filter(token => 
      token.symbol === lowerSearch ||
      token.name.toLowerCase() === lowerSearch
    );

    // Then, find partial matches
    const partialMatches = tokenOptions.filter(token => 
      (token.symbol.includes(lowerSearch) || 
       token.name.toLowerCase().includes(lowerSearch)) &&
      !exactMatches.includes(token)
    );

    // Sort by market cap and volume
    const sortedResults = [...exactMatches, ...partialMatches]
      .sort((a, b) => {
        // Prioritize market cap, then volume
        if (a.market_cap !== b.market_cap) {
          return b.market_cap - a.market_cap;
        }
        return b.volume - a.volume;
      });

    console.log(`Found ${sortedResults.length} matches for "${lowerSearch}"`);
    return sortedResults.slice(0, 100);
  };

  // Memoize filtered options
  const filteredOptions1 = useMemo(() => getFilteredOptions(searchToken1), [searchToken1, tokenOptions]);
  const filteredOptions2 = useMemo(() => getFilteredOptions(searchToken2), [searchToken2, tokenOptions]);

  // Function to calculate correlation
  const calculateCorrelation = (prices1, prices2) => {
    const n = Math.min(prices1.length, prices2.length);
    let sum1 = 0, sum2 = 0, sum1Sq = 0, sum2Sq = 0, pSum = 0;

    for (let i = 0; i < n; i++) {
      sum1 += prices1[i];
      sum2 += prices2[i];
      sum1Sq += prices1[i] ** 2;
      sum2Sq += prices2[i] ** 2;
      pSum += prices1[i] * prices2[i];
    }

    const num = pSum - (sum1 * sum2 / n);
    const den = Math.sqrt((sum1Sq - sum1 ** 2 / n) * (sum2Sq - sum2 ** 2 / n));
    return num / den;
  };

  const analyzeTokens = async () => {
    if (!token1 || !token2) return;
    
    setLoading(true);
    setError('');
    const previousData = { analysisData, tokenData };

    try {
      // Fetch market data first
      const [info1, info2] = await Promise.all([
        fetchWithRetry(`${BASE_URL}/coins/${token1.id}`, {
          vs_currency: 'usd',
          localization: false,
          tickers: false,
          community_data: false,
          developer_data: false,
          sparkline: false,
          market_data: true,
          include_24h_vol: true,
          include_last_updated_at: true
        }),
        fetchWithRetry(`${BASE_URL}/coins/${token2.id}`, {
          vs_currency: 'usd',
          localization: false,
          tickers: false,
          community_data: false,
          developer_data: false,
          sparkline: false,
          market_data: true,
          include_24h_vol: true,
          include_last_updated_at: true
        })
      ]).catch(error => {
        console.error('Market data fetch error:', error);
        if (error.response?.status === 429) {
          throw new Error('Rate limit exceeded. Please wait a moment and try again.');
        } else if (error.response?.status === 404) {
          throw new Error('One or both tokens not found. Please try different tokens.');
        } else {
          throw new Error('Failed to fetch token data. Please try again.');
        }
      });

      const marketData1 = info1?.data?.market_data;
      const marketData2 = info2?.data?.market_data;

      if (!marketData1 || !marketData2) {
        throw new Error('Market data not available.');
      }

      // Add delay before fetching historical data
      await sleep(2000);

      // Fetch historical data once with max days needed
      const daysNeeded = Math.max(selectedTimeframe, 90); // Use 90 days for both correlation and price change
      const [data1, data2] = await Promise.all([
        fetchWithRetry(`${BASE_URL}/coins/${token1.id}/market_chart`, {
          vs_currency: 'usd',
          days: daysNeeded,
          interval: 'daily'
        }, MAX_RETRIES, API_DELAY, true),
        fetchWithRetry(`${BASE_URL}/coins/${token2.id}/market_chart`, {
          vs_currency: 'usd',
          days: daysNeeded,
          interval: 'daily'
        }, MAX_RETRIES, API_DELAY, true)
      ]).catch(error => {
        console.error('Historical data fetch error:', error);
        if (error.response?.status === 429) {
          throw new Error('Rate limit exceeded. Please wait 30 seconds and try again.');
        } else if (error.message.includes('timeout')) {
          throw new Error('Historical data request timed out. Please try again.');
        } else {
          throw new Error('Failed to fetch historical data. Please try again in a moment.');
        }
      });

      // Calculate 90d change from historical data
      const calculate90dChange = (prices) => {
        if (!Array.isArray(prices) || prices.length < 90) return null;
        const startPrice = prices[0][1];
        const endPrice = prices[89][1]; // Use exactly 90 days
        return ((endPrice - startPrice) / startPrice) * 100;
      };

      // Extract prices and calculate daily changes for correlation
      const prices1 = data1.data.prices.slice(-selectedTimeframe);
      const prices2 = data2.data.prices.slice(-selectedTimeframe);
      
      const changes1 = prices1.map((price, i) => 
        i === 0 ? 0 : ((price[1] - prices1[i-1][1]) / prices1[i-1][1]) * 100
      );
      const changes2 = prices2.map((price, i) => 
        i === 0 ? 0 : ((price[1] - prices2[i-1][1]) / prices2[i-1][1]) * 100
      );

      // Calculate correlation
      const correlation = calculateCorrelation(changes1, changes2);
      if (isNaN(correlation)) {
        throw new Error('Unable to calculate correlation. Please try different tokens.');
      }

      const dates = prices1.map(p => new Date(p[0]).toLocaleDateString());

      // Store token data with calculated 90d changes
      const newTokenData = {
        token1: {
          price: marketData1.current_price?.usd ?? 0,
          marketCap: formatMarketCap(marketData1.market_cap?.usd),
          volume24h: formatMarketCap(marketData1.total_volume?.usd),
          priceChange24h: marketData1.price_change_percentage_24h ?? null,
          priceChange7d: marketData1.price_change_percentage_7d ?? null,
          priceChange30d: marketData1.price_change_percentage_30d ?? null,
          priceChange90d: calculate90dChange(data1.data.prices),
          priceChange1y: marketData1.price_change_percentage_1y ?? null,
        },
        token2: {
          price: marketData2.current_price?.usd ?? 0,
          marketCap: formatMarketCap(marketData2.market_cap?.usd),
          volume24h: formatMarketCap(marketData2.total_volume?.usd),
          priceChange24h: marketData2.price_change_percentage_24h ?? null,
          priceChange7d: marketData2.price_change_percentage_7d ?? null,
          priceChange30d: marketData2.price_change_percentage_30d ?? null,
          priceChange90d: calculate90dChange(data2.data.prices),
          priceChange1y: marketData2.price_change_percentage_1y ?? null,
        }
      };

      const newAnalysisData = {
        correlation,
        chartData: {
          labels: dates,
          datasets: [
            {
              label: token1.symbol.toUpperCase(),
              data: changes1,
              borderColor: 'rgb(75, 192, 192)',
              tension: 0.1
            },
            {
              label: token2.symbol.toUpperCase(),
              data: changes2,
              borderColor: 'rgb(255, 99, 132)',
              tension: 0.1
            }
          ]
        }
      };

      // Update state only after all calculations are successful
      setTokenData(newTokenData);
      setAnalysisData(newAnalysisData);
    } catch (error) {
      console.error('Error analyzing tokens:', error);
      // Keep previous data on error
      setAnalysisData(previousData.analysisData);
      setTokenData(previousData.tokenData);
      setError(error.message || 'Failed to analyze tokens. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const renderTokenStats = (token, data) => {
    if (!token || !data) return null;

    const renderPriceChange = (value, label) => (
      <Box>
        <Typography variant="body2" color="#888">{label}</Typography>
        {value === null || value === undefined ? (
          <Typography color="#888">N/A</Typography>
        ) : (
          <Typography sx={{ color: value >= 0 ? '#4EC9B0' : '#F14C4C' }}>
            {value.toFixed(2)}%
          </Typography>
        )}
      </Box>
    );

    return (
      <Box sx={{ 
        p: 2, 
        bgcolor: 'rgba(45, 45, 45, 0.5)', 
        borderRadius: 1,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 2
      }}>
        <Typography variant="h6" sx={{ gridColumn: '1/-1', mb: 1 }}>
          {token.symbol.toUpperCase()} Stats
        </Typography>
        <Box>
          <Typography variant="body2" color="#888">Price</Typography>
          <Typography>${(data.price || 0).toLocaleString()}</Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="#888">Market Cap</Typography>
          <Typography>{data.marketCap || 'N/A'}</Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="#888">24h Volume</Typography>
          <Typography>{data.volume24h || 'N/A'}</Typography>
        </Box>
        {renderPriceChange(data.priceChange24h, "24h Change")}
        {renderPriceChange(data.priceChange7d, "7d Change")}
        {renderPriceChange(data.priceChange30d, "30d Change")}
        {renderPriceChange(data.priceChange90d, "90d Change")}
        {renderPriceChange(data.priceChange1y, "1y Change")}
      </Box>
    );
  };

  // Update the Autocomplete components to use unique keys
  const getOptionKey = (option) => `${option.id}-${option.symbol}-${option.name}`;

  // Update token change handlers to clear data when tokens are cleared
  const handleToken1Change = (event, newValue) => {
    setToken1(newValue);
    if (!newValue) {
      setTokenData(prev => ({ ...prev, token1: null }));
      setAnalysisData(null);
    }
  };

  const handleToken2Change = (event, newValue) => {
    setToken2(newValue);
    if (!newValue) {
      setTokenData(prev => ({ ...prev, token2: null }));
      setAnalysisData(null);
    }
  };

  return (
    <Dialog 
      open={open} 
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: '#252526',
          color: '#fff',
        }
      }}
    >
      <DialogTitle>Custom Pairs</DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Autocomplete
              value={token1}
              onChange={handleToken1Change}
              inputValue={searchToken1}
              onInputChange={(event, newInputValue) => handleSearchToken1(newInputValue)}
              options={filteredOptions1}
              loading={loadingTokens}
              getOptionLabel={(option) => `${option?.symbol?.toUpperCase()} - ${option?.name}`}
              renderOption={(props, option) => (
                <li {...props} key={getOptionKey(option)}>
                  <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                    <Typography component="span" sx={{ fontWeight: 'bold' }}>
                      {option.symbol.toUpperCase()}
                    </Typography>
                    <Typography component="span" sx={{ fontSize: '0.8rem', color: '#888' }}>
                      {option.name}
                    </Typography>
                  </Box>
                </li>
              )}
              renderInput={(params) => (
                <TextField 
                  {...params} 
                  label="Search Token 1"
                  placeholder="Search by symbol or name"
                  InputProps={{
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {loadingTokens ? <CircularProgress color="inherit" size={20} /> : null}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  }}
                />
              )}
              filterOptions={(x) => x}
              noOptionsText={searchToken1.length < 2 ? "Enter token symbol or name" : "No results found"}
              sx={{ flex: 1 }}
            />
            <Autocomplete
              value={token2}
              onChange={handleToken2Change}
              inputValue={searchToken2}
              onInputChange={(event, newInputValue) => handleSearchToken2(newInputValue)}
              options={filteredOptions2}
              loading={loadingTokens}
              getOptionLabel={(option) => `${option?.symbol?.toUpperCase()} - ${option?.name}`}
              renderOption={(props, option) => (
                <li {...props} key={getOptionKey(option)}>
                  <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                    <Typography component="span" sx={{ fontWeight: 'bold' }}>
                      {option.symbol.toUpperCase()}
                    </Typography>
                    <Typography component="span" sx={{ fontSize: '0.8rem', color: '#888' }}>
                      {option.name}
                    </Typography>
                  </Box>
                </li>
              )}
              renderInput={(params) => (
                <TextField 
                  {...params} 
                  label="Search Token 2"
                  placeholder="Search by symbol or name"
                  InputProps={{
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {loadingTokens ? <CircularProgress color="inherit" size={20} /> : null}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  }}
                />
              )}
              filterOptions={(x) => x}
              noOptionsText={searchToken2.length < 2 ? "Enter token symbol or name" : "No results found"}
              sx={{ flex: 1 }}
            />
            <FormControl sx={{ minWidth: 120 }}>
              <InputLabel>Timeframe</InputLabel>
              <Select
                value={selectedTimeframe}
                label="Timeframe"
                onChange={(e) => setSelectedTimeframe(e.target.value)}
              >
                {timeframes.map((tf) => (
                  <MenuItem key={tf.value} value={tf.value}>
                    {tf.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <Button
            variant="contained"
            onClick={analyzeTokens}
            disabled={!token1 || !token2 || loading}
            sx={{
              bgcolor: '#3B82F6',
              '&:hover': {
                bgcolor: '#2563EB',
              },
              '&.Mui-disabled': {
                bgcolor: 'rgba(59, 130, 246, 0.3)',
              },
              textTransform: 'none'
            }}
          >
            {loading ? <CircularProgress size={24} /> : 'Analyze'}
          </Button>

          {error && (
            <Typography color="error" sx={{ mt: 2 }}>
              {error}
            </Typography>
          )}

          {analysisData && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="h6" gutterBottom sx={{ 
                color: analysisData.correlation >= 0.5 ? '#4EC9B0' : '#F14C4C',
                fontSize: '1.5rem',
                textAlign: 'center',
                mb: 3
              }}>
                Correlation: {analysisData.correlation.toFixed(4)}
              </Typography>

              <Box sx={{ height: 400, mb: 4 }}>
                <Line
                  data={analysisData.chartData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      title: {
                        display: true,
                        text: 'Daily Price Changes (%)',
                        color: '#fff'
                      },
                      legend: {
                        position: 'top',
                        labels: {
                          color: '#fff'
                        }
                      }
                    },
                    scales: {
                      y: {
                        title: {
                          display: true,
                          text: 'Price Change (%)',
                          color: '#888'
                        },
                        grid: {
                          color: 'rgba(255, 255, 255, 0.1)'
                        },
                        ticks: {
                          color: '#888'
                        }
                      },
                      x: {
                        grid: {
                          color: 'rgba(255, 255, 255, 0.1)'
                        },
                        ticks: {
                          color: '#888'
                        }
                      }
                    }
                  }}
                />
              </Box>

              {renderTokenStats(token1, tokenData.token1)}
              <Box sx={{ my: 2 }} />
              {renderTokenStats(token2, tokenData.token2)}
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button 
          onClick={onClose}
          sx={{
            color: '#fff',
            '&:hover': {
              bgcolor: 'rgba(255, 255, 255, 0.1)'
            },
            textTransform: 'none'
          }}
        >
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
} 