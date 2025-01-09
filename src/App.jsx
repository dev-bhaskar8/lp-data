import { useState, useEffect } from 'react';
import { 
  ThemeProvider, 
  createTheme, 
  CssBaseline,
  Container,
  Typography,
  Box,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  Pagination,
} from '@mui/material';
import Papa from 'papaparse';

// Create minimal theme
const minimalTheme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#1E1E1E',
      paper: '#252526',
    },
  },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          // Webkit browsers (Chrome, Safari, Edge)
          '&::-webkit-scrollbar': {
            width: '10px',
            height: '10px',
          },
          '&::-webkit-scrollbar-track': {
            background: '#1E1E1E',
          },
          '&::-webkit-scrollbar-thumb': {
            background: '#3D3D3D',
            borderRadius: '5px',
            '&:hover': {
              background: '#4D4D4D',
            },
          },
          // Firefox
          scrollbarWidth: 'thin',
          scrollbarColor: '#3D3D3D #1E1E1E',
        },
        // Horizontal scrollbar for the table
        '*::-webkit-scrollbar': {
          width: '10px',
          height: '10px',
        },
        '*::-webkit-scrollbar-track': {
          background: '#1E1E1E',
        },
        '*::-webkit-scrollbar-thumb': {
          background: '#3D3D3D',
          borderRadius: '5px',
          '&:hover': {
            background: '#4D4D4D',
          },
        },
      },
    },
  },
});

// Timeframe options
const timeframes = ['7d', '30d', '90d'];

function App() {
  const [correlationData, setCorrelationData] = useState({});
  const [currentTimeframe, setCurrentTimeframe] = useState('7d');
  const [orderBy, setOrderBy] = useState('Correlation');
  const [order, setOrder] = useState('desc');
  const [correlationFilter, setCorrelationFilter] = useState(0.9);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const entriesPerPage = 100;
  const [lastUpdated, setLastUpdated] = useState('Loading...');

  useEffect(() => {
    // Fetch last update time from GitHub API
    fetch('https://api.github.com/repos/dev-bhaskar8/lp-data/commits?path=crypto_correlations_7d.csv&page=1&per_page=1')
      .then(response => response.json())
      .then(data => {
        if (data && data[0] && data[0].commit) {
          const date = new Date(data[0].commit.committer.date);
          const now = new Date();
          const hoursAgo = Math.floor((now - date) / (1000 * 60 * 60));
          const formattedDate = date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZoneName: 'short'
          });
          setLastUpdated(`${hoursAgo}h ago (${formattedDate})`);
        }
      })
      .catch(error => {
        console.error('Error fetching last update time:', error);
        setLastUpdated('Unable to fetch update time');
      });

    // Load CSV files from root directory
    Promise.all(timeframes.map(timeframe => 
      fetch(`/lp-data/crypto_correlations_${timeframe}.csv`)
        .then(response => response.text())
        .then(csv => {
          const result = Papa.parse(csv, { header: true });
          return { [timeframe]: result.data };
        })
    )).then(results => {
      const combined = Object.assign({}, ...results);
      setCorrelationData(combined);
    }).catch(error => {
      console.error('Error loading CSV files:', error);
    });
  }, []);

  const handleTimeframeChange = (timeframe) => {
    setCurrentTimeframe(timeframe);
  };

  const handleRequestSort = (property) => {
    const isAsc = orderBy === property && order === 'asc';
    setOrder(isAsc ? 'desc' : 'asc');
    setOrderBy(property);
  };

  const sortData = (data) => {
    return data.sort((a, b) => {
      let aValue = a[orderBy];
      let bValue = b[orderBy];

      if (!aValue) aValue = '';
      if (!bValue) bValue = '';

      if (orderBy === 'Correlation' || orderBy === 'Combined Change %') {
        aValue = parseFloat(aValue) || 0;
        bValue = parseFloat(bValue) || 0;
      } else if (orderBy === 'Combined Market Cap') {
        const parseMarketCap = (value) => {
          if (!value || typeof value !== 'string') return 0;
          const numStr = value.replace(/[^0-9.TBM]/g, '');
          let num = parseFloat(numStr) || 0;
          if (value.includes('T')) num *= 1000;
          if (value.includes('M')) num *= 0.001;
          return num;
        };
        aValue = parseMarketCap(aValue);
        bValue = parseMarketCap(bValue);
      }

      if (bValue < aValue) {
        return order === 'desc' ? -1 : 1;
      }
      if (bValue > aValue) {
        return order === 'desc' ? 1 : -1;
      }
      return 0;
    });
  };

  const filterByCorrelation = (data) => {
    if (correlationFilter === 0) return data;
    
    return data.filter(row => {
      const correlation = parseFloat(row.Correlation);
      if (isNaN(correlation)) return false;
      return correlation >= correlationFilter;
    });
  };

  const filterBySearch = (data) => {
    if (!searchQuery) return data;
    const query = searchQuery.toLowerCase().trim();
    
    // Split the search query to handle multiple coins
    const searchTerms = query.split(/[-\s]+/).filter(Boolean);
    
    return data.filter(row => {
      const pairLower = row.Pair.toLowerCase();
      // If searching for multiple terms, all must match
      if (searchTerms.length > 1) {
        return searchTerms.every(term => pairLower.includes(term));
      }
      // Single term search
      return pairLower.includes(query);
    });
  };

  const handlePageChange = (event, newPage) => {
    setPage(newPage);
  };

  const currentData = correlationData[currentTimeframe] || [];
  // Filter out empty rows before sorting
  const filteredData = currentData.filter(row => 
    row.Pair && 
    row.Correlation && 
    row['Combined Market Cap'] && 
    row['Combined Change %']
  );
  const correlationFilteredData = filterByCorrelation(filteredData);
  const searchFilteredData = filterBySearch(correlationFilteredData);
  const sortedData = sortData([...searchFilteredData]);
  
  // Calculate pagination
  const totalPages = Math.ceil(sortedData.length / entriesPerPage);
  const startIndex = (page - 1) * entriesPerPage;
  const paginatedData = sortedData.slice(startIndex, startIndex + entriesPerPage);

  return (
    <ThemeProvider theme={minimalTheme}>
      <CssBaseline />
      <Container 
        maxWidth="lg" 
        sx={{ 
          py: 6,
          px: { xs: 2, sm: 3 },
        }}
      >
        <Typography 
          variant="h3" 
          component="h1" 
          align="center" 
          sx={{ 
            mb: 2,
            fontSize: '2rem',
            fontWeight: 500,
            color: '#fff',
          }}
        >
          Best Pairs for Liquidity
        </Typography>

        <Typography 
          variant="subtitle1" 
          align="center" 
          sx={{ 
            mb: 2,
            color: '#888',
            fontSize: '1rem',
          }}
        >
          Find highly correlated cryptocurrency pairs sorted by market cap and price movement
        </Typography>

        <Typography 
          variant="body2" 
          align="center" 
          sx={{ 
            mb: 5,
            color: '#666',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          Last updated: {lastUpdated}
        </Typography>

        <Box 
          sx={{ 
            mb: 4,
            display: 'flex',
            gap: 2,
            justifyContent: 'center',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {timeframes.map(timeframe => (
            <button
              key={timeframe}
              onClick={() => handleTimeframeChange(timeframe)}
              style={{
                background: 'none',
                border: 'none',
                color: currentTimeframe === timeframe ? '#fff' : '#666',
                fontSize: '0.9rem',
                padding: '8px 16px',
                cursor: 'pointer',
                transition: 'color 0.2s',
                fontFamily: 'inherit',
              }}
            >
              {timeframe.toUpperCase()}
            </button>
          ))}
          
          <FormControl 
            size="small" 
            sx={{ 
              minWidth: 200,
              '& .MuiOutlinedInput-root': {
                color: '#fff',
                '& fieldset': {
                  borderColor: '#666',
                },
                '&:hover fieldset': {
                  borderColor: '#888',
                },
              },
              '& .MuiInputLabel-root': {
                color: '#888',
              },
            }}
          >
            <InputLabel id="correlation-filter-label">Min Correlation</InputLabel>
            <Select
              labelId="correlation-filter-label"
              value={correlationFilter}
              label="Min Correlation"
              onChange={(e) => setCorrelationFilter(e.target.value)}
            >
              <MenuItem value={0.9}>0.9</MenuItem>
              <MenuItem value={0.8}>0.8</MenuItem>
              <MenuItem value={0.7}>0.7</MenuItem>
              <MenuItem value={0.6}>0.6</MenuItem>
              <MenuItem value={0.5}>0.5</MenuItem>
              <MenuItem value={0}>All</MenuItem>
            </Select>
          </FormControl>

          <TextField
            size="small"
            placeholder="Search pairs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{
              minWidth: 200,
              '& .MuiOutlinedInput-root': {
                color: '#fff',
                '& fieldset': {
                  borderColor: '#666',
                },
                '&:hover fieldset': {
                  borderColor: '#888',
                },
                '& input::placeholder': {
                  color: '#888',
                  opacity: 1,
                },
              },
            }}
          />
        </Box>

        <Box sx={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.9rem',
          }}>
            <thead>
              <tr style={{ backgroundColor: '#2D2D2D' }}>
                {[
                  { id: 'Pair', label: 'Pair', align: 'left' },
                  { id: 'Correlation', label: 'Correlation', align: 'right' },
                  { id: 'Combined Market Cap', label: 'Combined Market Cap', align: 'right' },
                  { id: 'Combined Change %', label: 'Combined Change %', align: 'right' }
                ].map((column) => (
                  <th
                    key={column.id}
                    style={{
                      padding: '12px 16px',
                      textAlign: column.align,
                      fontWeight: 500,
                      color: '#CCCCCC',
                      cursor: 'pointer',
                      borderBottom: '1px solid #3D3D3D',
                    }}
                    onClick={() => handleRequestSort(column.id)}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      {column.label}
                      {orderBy === column.id && (
                        <span style={{ fontSize: '0.8rem', color: '#858585' }}>
                          {order === 'desc' ? '↓' : '↑'}
                        </span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginatedData.map((row, index) => (
                <tr 
                  key={index}
                  style={{
                    backgroundColor: index % 2 === 0 ? '#252526' : '#2D2D2D',
                    transition: 'background-color 0.2s',
                  }}
                >
                  <td style={{ 
                    padding: '12px 16px', 
                    borderBottom: '1px solid #3D3D3D',
                    color: '#CCCCCC',
                  }}>
                    {row.Pair}
                  </td>
                  <td 
                    style={{ 
                      padding: '12px 16px', 
                      textAlign: 'right',
                      color: parseFloat(row.Correlation) > 0.5 ? '#4EC9B0' : '#F14C4C',
                      borderBottom: '1px solid #3D3D3D',
                    }}
                  >
                    {parseFloat(row.Correlation).toFixed(4)}
                  </td>
                  <td 
                    style={{ 
                      padding: '12px 16px', 
                      textAlign: 'right',
                      borderBottom: '1px solid #3D3D3D',
                      color: '#CCCCCC',
                    }}
                  >
                    {row['Combined Market Cap']}
                  </td>
                  <td 
                    style={{ 
                      padding: '12px 16px', 
                      textAlign: 'right',
                      color: parseFloat(row['Combined Change %']) > 0 ? '#4EC9B0' : '#F14C4C',
                      borderBottom: '1px solid #3D3D3D',
                    }}
                  >
                    {row['Combined Change %']}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>

        {totalPages > 1 && (
          <Box 
            sx={{ 
              mt: 4, 
              display: 'flex', 
              justifyContent: 'center',
              '& .MuiPagination-ul': {
                '& .MuiPaginationItem-root': {
                  color: '#fff',
                  '&.Mui-selected': {
                    backgroundColor: '#3D3D3D',
                  },
                  '&:hover': {
                    backgroundColor: '#4D4D4D',
                  },
                },
              },
            }}
          >
            <Pagination 
              count={totalPages} 
              page={page} 
              onChange={handlePageChange}
              color="primary"
              size="large"
            />
          </Box>
        )}

        <Typography 
          variant="body2" 
          sx={{ 
            mt: 2,
            textAlign: 'center',
            color: '#666',
          }}
        >
          Showing {startIndex + 1}-{Math.min(startIndex + entriesPerPage, sortedData.length)} of {sortedData.length} entries
        </Typography>

        <Typography 
          variant="body2" 
          sx={{ 
            mt: 4,
            mb: 2,
            textAlign: 'center',
            color: '#666',
            '& span': {
              color: '#3B82F6', // Blue heart color
              fontWeight: 'bold',
            }
          }}
        >
          Made with <span>❤</span> by Vaas
        </Typography>
      </Container>
    </ThemeProvider>
  );
}

export default App;
