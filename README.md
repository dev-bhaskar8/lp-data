# Best Pairs for Liquidity - Crypto Correlation Analysis

A web application that helps traders find highly correlated cryptocurrency pairs sorted by market cap and price movement. The project automatically fetches and analyzes data from CoinGecko and Binance APIs, updating every 4 days through GitHub Actions.

## Features

- **Data Collection**:
  - Fetches top 300 cryptocurrencies by market cap
  - Retrieves historical price data from Binance (with CoinGecko fallback)
  - Calculates correlation coefficients between pairs
  - Updates data automatically every 4 days

- **Web Interface**:
  - Dark mode modern UI
  - Sort by correlation, market cap, or price movement
  - Filter by minimum correlation (0.5 to 0.9)
  - Search functionality for specific pairs
  - Pagination (100 entries per page)
  - Responsive design
  - Custom scrollbar for better UX

- **Data Analysis**:
  - Multiple timeframes (7d, 30d, 90d)
  - Combined market cap calculation
  - Price movement analysis
  - Correlation coefficient calculation

## Technical Stack

- **Frontend**:
  - React
  - Material-UI
  - Papa Parse (CSV parsing)
  - Vite (Build tool)

- **Backend**:
  - Python script for data collection
  - Pandas for data analysis
  - CoinGecko API
  - Binance API

- **Automation**:
  - GitHub Actions for scheduled updates
  - Environment variables for API keys
  - Automatic deployment to GitHub Pages

## Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/dev-bhaskar8/lp-data.git
   cd lp-data
   ```

2. **Install Dependencies**:
   ```bash
   # Frontend
   npm install

   # Backend
   pip install pandas requests python-dotenv tqdm
   ```

3. **Environment Variables**:
   Create a `.env` file:
   ```
   COINGECKO_API_KEY=your_api_key_here
   ```

4. **Run Locally**:
   ```bash
   # Generate data
   python crypto_correlation.py

   # Start development server
   npm run dev
   ```

## GitHub Actions Setup

1. Add `COINGECKO_API_KEY` to repository secrets
2. Enable Actions read & write permissions
3. Data updates automatically every 4 days
4. Manual triggers available in Actions tab

## Project Structure

```
lp-data/
├── src/                    # React frontend code
├── assets/                 # Static assets
├── .github/workflows/      # GitHub Actions configuration
├── crypto_correlation.py   # Data collection script
├── requirements.txt        # Python dependencies
└── *.csv                  # Generated correlation data
```

## Data Sources

- **Primary**: Binance API for historical price data
- **Fallback**: CoinGecko API when Binance data unavailable
- **Market Data**: CoinGecko API for market caps and rankings

## Contributing

Feel free to open issues or submit pull requests. Please ensure:
1. Code follows existing style
2. Tests pass (if added)
3. Documentation is updated
4. Commit messages are clear

## License

MIT License - feel free to use and modify as needed.

## Acknowledgments

Made with 💙 by Vaas
