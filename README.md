# Risk Divergence Dashboard

**Static GitHub Pages site** that displays divergence signals across multiple asset pairs (equities, bonds, gold, crypto).

Uses **GitHub Actions** to fetch data from **Yahoo Finance** (via `yfinance`), run Python analysis, and precompute results into JSON cache files. The browser fetches a single cache file and renders it — no client-side analysis required.

🔗 **[Live Demo](https://jonsflow.github.io/risk-divergence/)**

---

## Features

✅ **6 Divergence Pairs**:
- SPY ↔ HYG (Equities vs High-Yield Bonds)
- QQQ ↔ TLT (Tech vs Treasuries)
- SPY ↔ GLD (Equities vs Gold)
- SPY ↔ IWM (Large Cap vs Small Cap)
- BTC ↔ SPY (Crypto vs Equities)
- BTC ↔ GLD (Crypto vs Gold)

✅ **Configurable Analysis**:
- Lookback periods: 20, 50, or 100 days
- Pivot detection modes: Last 2 chronologically, 2 highest by price, Highest high → Last close
- Auto-scaling or manual swing window

✅ **Hourly + Daily Data**:
- Hourly data: Last 1 month (~143 bars for stocks, ~700 for Bitcoin)
- Daily data: Max available history (thousands of bars)
- Currently uses daily data; hourly available for future enhancements

✅ **Python as Single Source of Truth**:
- All pivot detection, divergence, and regime logic lives in `generate_cache.py`
- JS is a pure renderer — reads precomputed cache JSON, no analysis code
- Cache missing = clear error message, no silent wrong results

✅ **Fully Static**:
- No backend required
- Deployed on GitHub Pages

---

## Quick Start

### 1. Enable GitHub Pages
Settings → Pages → Deploy from a branch → `main` → `/ (root)`

### 2. Trigger Data Fetch
Actions → "Update market data (Yahoo Finance → data/*.csv)" → Run workflow

### 3. Visit Your Site
After the workflow commits the CSV files, visit your GitHub Pages URL.

---

## Local Development

### Fetch Data and Generate Cache Locally
```bash
# Install dependencies (one-time)
pip install yfinance

# Fetch both hourly and daily data
python3 fetch_data.py

# Generate precomputed cache files (required — JS has no analysis fallback)
python3 generate_cache.py
```

### Run Local Server
```bash
# Python
python3 -m http.server 8000

# Node.js
npx http-server -p 8000
```

Then visit `http://localhost:8000`

---

## Adding New Pairs

1. Edit `config.json` to add the pair and symbol
2. Add the symbol to `fetch_data.py`
3. Re-run data fetch and cache generation:

```bash
python3 fetch_data.py
python3 generate_cache.py
```

The UI is generated dynamically from config — no HTML changes needed.

---

## Files

```
├── index.html              # HTML structure (minimal, pairs generated dynamically)
├── macro.html              # Macro model dashboard
├── styles.css              # All styling
├── app.js                  # Divergence page renderer (reads cache, no analysis)
├── macro_app.js            # Macro page renderer (reads cache, no analysis)
├── fetch_data.py           # Fetches hourly + daily CSVs from Yahoo Finance
├── generate_cache.py       # Runs all analysis, writes data/cache/*.json
├── config.json             # Divergence pairs and symbol configuration
├── macro_config.json       # Macro model categories and assets
├── data/                   # Generated CSV files (hourly + daily)
│   └── cache/              # Precomputed JSON cache files (45+ files)
└── .github/workflows/      # Scheduled data fetching + cache generation
```

---

## Tech Stack

- **Data**: Yahoo Finance (via `yfinance` Python library)
- **Hosting**: GitHub Pages
- **Automation**: GitHub Actions (runs daily at 4 PM ET market close)
- **Frontend**: Vanilla JavaScript (no frameworks)
- **Charts**: TradingView Lightweight Charts (divergence page), custom SVG sparklines (macro page)

---

## Credits

- Data provided by [Yahoo Finance](https://finance.yahoo.com) via [yfinance](https://github.com/ranaroussi/yfinance)
- Inspired by [Trade Brigade](https://tradebrigade.co)
- Built with [Claude Code](https://claude.ai/code)

---

For detailed technical documentation, see [`CLAUDE.md`](./CLAUDE.md).
