import { useState, useEffect } from 'react';
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
  { label: '30 Days', value: 30 },
  { label: '90 Days', value: 90 },
  { label: '180 Days', value: 180 },
  { label: '1 Year', value: 365 },
];

export default function CustomPairsAnalysis({ open, onClose }) {
  const [token1, setToken1] = useState(null);
  const [token2, setToken2] = useState(null);
  const [searchToken1, setSearchToken1] = useState('');
  const [searchToken2, setSearchToken2] = useState('');
  const [tokenOptions, setTokenOptions] = useState([]);
  const [selectedTimeframe, setSelectedTimeframe] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [analysisData, setAnalysisData] = useState(null);

  // Fetch token list from CoinGecko
  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/list');
        setTokenOptions(response.data);
      } catch (error) {
        console.error('Error fetching tokens:', error);
        setError('Failed to fetch token list');
      }
    };
    fetchTokens();
  }, []);

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
      // Fetch historical price data for both tokens
      const [data1, data2] = await Promise.all([
        axios.get(`https://api.coingecko.com/api/v3/coins/${token1.id}/market_chart`, {
          params: {
            vs_currency: 'usd',
            days: selectedTimeframe,
            interval: 'daily'
          }
        }),
        axios.get(`https://api.coingecko.com/api/v3/coins/${token2.id}/market_chart`, {
          params: {
            vs_currency: 'usd',
            days: selectedTimeframe,
            interval: 'daily'
          }
        })
      ]);

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
      setError('Failed to analyze tokens. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog 
      open={open} 
      onClose={onClose}
      maxWidth="md"
      fullWidth
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
              options={tokenOptions}
              getOptionLabel={(option) => `${option.name} (${option.symbol.toUpperCase()})`}
              renderInput={(params) => <TextField {...params} label="Token 1" />}
              sx={{ flex: 1 }}
            />
            <Autocomplete
              value={token2}
              onChange={(event, newValue) => setToken2(newValue)}
              inputValue={searchToken2}
              onInputChange={(event, newInputValue) => setSearchToken2(newInputValue)}
              options={tokenOptions}
              getOptionLabel={(option) => `${option.name} (${option.symbol.toUpperCase()})`}
              renderInput={(params) => <TextField {...params} label="Token 2" />}
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
              <Typography variant="h6" gutterBottom>
                Correlation: {analysisData.correlation.toFixed(4)}
              </Typography>
              <Box sx={{ height: 400, mt: 2 }}>
                <Line
                  data={analysisData.chartData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      title: {
                        display: true,
                        text: 'Daily Price Changes (%)'
                      },
                      legend: {
                        position: 'top'
                      }
                    },
                    scales: {
                      y: {
                        title: {
                          display: true,
                          text: 'Price Change (%)'
                        }
                      }
                    }
                  }}
                />
              </Box>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
} 