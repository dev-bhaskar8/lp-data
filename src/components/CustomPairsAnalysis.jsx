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

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const API_DELAY = 1100; // 1.1 seconds between API calls
const MAX_RETRIES = 3;

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

  const fetchWithRetry = async (url, params = {}, retries = MAX_RETRIES, delay = 2000) => {
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
      if (timeSinceLastFetch < API_DELAY) {
        await sleep(API_DELAY - timeSinceLastFetch);
      }
    }

    let lastError;
    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios.get(url, { 
          params,
          timeout: 10000 // 10 second timeout
        });
        // Cache the response
        globalCache.tokenData.set(cacheKey, response.data);
        globalCache.lastFetch.set(cacheKey, Date.now());
        return response;
      } catch (error) {
        lastError = error;
        if (error.response?.status === 429) {
          const waitTime = delay * Math.pow(2, i); // Exponential backoff
          await sleep(waitTime);
          continue;
        }
        if (error.code === 'ECONNABORTED') {
          throw new Error('Request timed out. Please try again.');
        }
        throw error;
      }
    }
    throw lastError;
  };

  // Update token list fetching
  useEffect(() => {
    const fetchTokens = async () => {
      if (globalCache.tokens) {
        setTokenOptions(globalCache.tokens);
        return;
      }

      setLoadingTokens(true);
      setError('');
      
      try {
        const response = await fetchWithRetry('https://api.coingecko.com/api/v3/coins/list', {
          include_platform: false
        });
        
        if (response.data && Array.isArray(response.data)) {
          globalCache.tokens = response.data;
          setTokenOptions(response.data);
        } else {
          throw new Error('Invalid response format');
        }
      } catch (error) {
        console.error('Error fetching tokens:', error);
        if (error.response?.status === 429) {
          setError('Rate limit reached. Please wait a moment and refresh.');
        } else if (error.code === 'ECONNABORTED') {
          setError('Request timed out. Please refresh the page.');
        } else {
          setError('Failed to fetch token list. Please try again later.');
        }
      } finally {
        setLoadingTokens(false);
      }
    };

    fetchTokens();
  }, []);

  // Filter tokens based on search input
  const getFilteredOptions = (searchText) => {
    if (!searchText) return [];
    const lowerSearch = searchText.toLowerCase();

    // First, find exact symbol matches and prioritize by length
    const exactSymbolMatches = tokenOptions.filter(token => 
      token.symbol.toLowerCase() === lowerSearch
    ).sort((a, b) => a.symbol.length - b.symbol.length);

    // Then, find partial symbol matches and prioritize by length
    const partialSymbolMatches = tokenOptions.filter(token => 
      token.symbol.toLowerCase().includes(lowerSearch) &&
      token.symbol.toLowerCase() !== lowerSearch
    ).sort((a, b) => a.symbol.length - b.symbol.length);

    // Finally, find name matches for remaining tokens
    const nameMatches = tokenOptions.filter(token => 
      token.name.toLowerCase().includes(lowerSearch) &&
      !token.symbol.toLowerCase().includes(lowerSearch)
    );

    // Combine all matches with priority order
    return [...exactSymbolMatches, ...partialSymbolMatches, ...nameMatches].slice(0, 100);
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
    try {
      // Fetch both price data and token info with retry logic
      const [data1, data2, info1, info2] = await Promise.all([
        fetchWithRetry(`https://api.coingecko.com/api/v3/coins/${token1.id}/market_chart`, {
          vs_currency: 'usd',
          days: selectedTimeframe,
          interval: 'daily'
        }),
        fetchWithRetry(`https://api.coingecko.com/api/v3/coins/${token2.id}/market_chart`, {
          vs_currency: 'usd',
          days: selectedTimeframe,
          interval: 'daily'
        }),
        fetchWithRetry(`https://api.coingecko.com/api/v3/coins/${token1.id}`),
        fetchWithRetry(`https://api.coingecko.com/api/v3/coins/${token2.id}`)
      ]).catch(error => {
        if (error.response?.status === 429) {
          throw new Error('Rate limit exceeded. Please wait a moment and try again.');
        } else if (error.response?.status === 404) {
          throw new Error('One or both tokens not found. Please try different tokens.');
        } else {
          throw new Error('Failed to fetch token data. Please try again.');
        }
      });

      // Extract prices and calculate percentage changes
      const prices1 = data1.data.prices.map(p => p[1]);
      const prices2 = data2.data.prices.map(p => p[1]);
      const dates = data1.data.prices.map(p => new Date(p[0]).toLocaleDateString());

      const changes1 = prices1.map((price, i) => 
        i === 0 ? 0 : ((price - prices1[i-1]) / prices1[i-1]) * 100
      );
      const changes2 = prices2.map((price, i) => 
        i === 0 ? 0 : ((price - prices2[i-1]) / prices2[i-1]) * 100
      );

      // Calculate correlation
      const correlation = calculateCorrelation(changes1, changes2);

      // Format market data
      const formatMarketCap = (value) => {
        if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
        if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
        if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
        return `$${value.toFixed(2)}`;
      };

      // Store token data
      setTokenData({
        token1: {
          price: info1.data.market_data.current_price.usd,
          marketCap: formatMarketCap(info1.data.market_data.market_cap.usd),
          volume24h: formatMarketCap(info1.data.market_data.total_volume.usd),
          priceChange24h: info1.data.market_data.price_change_percentage_24h,
          priceChange7d: info1.data.market_data.price_change_percentage_7d,
          priceChange30d: info1.data.market_data.price_change_percentage_30d,
        },
        token2: {
          price: info2.data.market_data.current_price.usd,
          marketCap: formatMarketCap(info2.data.market_data.market_cap.usd),
          volume24h: formatMarketCap(info2.data.market_data.total_volume.usd),
          priceChange24h: info2.data.market_data.price_change_percentage_24h,
          priceChange7d: info2.data.market_data.price_change_percentage_7d,
          priceChange30d: info2.data.market_data.price_change_percentage_30d,
        }
      });

      setAnalysisData({
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
      });
    } catch (error) {
      console.error('Error analyzing tokens:', error);
      setError(error.message || 'Failed to analyze tokens. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const renderTokenStats = (token, data) => {
    if (!data) return null;
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
          <Typography>${data.price.toLocaleString()}</Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="#888">Market Cap</Typography>
          <Typography>{data.marketCap}</Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="#888">24h Volume</Typography>
          <Typography>{data.volume24h}</Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="#888">24h Change</Typography>
          <Typography sx={{ color: data.priceChange24h >= 0 ? '#4EC9B0' : '#F14C4C' }}>
            {data.priceChange24h?.toFixed(2)}%
          </Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="#888">7d Change</Typography>
          <Typography sx={{ color: data.priceChange7d >= 0 ? '#4EC9B0' : '#F14C4C' }}>
            {data.priceChange7d?.toFixed(2)}%
          </Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="#888">30d Change</Typography>
          <Typography sx={{ color: data.priceChange30d >= 0 ? '#4EC9B0' : '#F14C4C' }}>
            {data.priceChange30d?.toFixed(2)}%
          </Typography>
        </Box>
      </Box>
    );
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
      <DialogTitle>Custom Pairs Analysis</DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Autocomplete
              value={token1}
              onChange={(event, newValue) => setToken1(newValue)}
              inputValue={searchToken1}
              onInputChange={(event, newInputValue) => setSearchToken1(newInputValue)}
              options={filteredOptions1}
              loading={loadingTokens}
              getOptionLabel={(option) => `${option.symbol.toUpperCase()} - ${option.name}`}
              renderOption={(props, option) => (
                <li {...props}>
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
                  placeholder="Enter token symbol..."
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
              noOptionsText={searchToken1.length < 2 ? "Type to search..." : "No tokens found"}
              sx={{ flex: 1 }}
            />
            <Autocomplete
              value={token2}
              onChange={(event, newValue) => setToken2(newValue)}
              inputValue={searchToken2}
              onInputChange={(event, newInputValue) => setSearchToken2(newInputValue)}
              options={filteredOptions2}
              loading={loadingTokens}
              getOptionLabel={(option) => `${option.symbol.toUpperCase()} - ${option.name}`}
              renderOption={(props, option) => (
                <li {...props}>
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
                  placeholder="Enter token symbol..."
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
              noOptionsText={searchToken2.length < 2 ? "Type to search..." : "No tokens found"}
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
              }
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
            }
          }}
        >
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
} 