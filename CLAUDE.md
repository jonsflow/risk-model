# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Risk Divergence Dashboard is a static GitHub Pages site that displays divergence signals across multiple asset pairs (equities, bonds, gold, crypto). GitHub Actions fetches CSV data from Yahoo Finance, runs Python analysis (`generate_cache.py`), and writes precomputed JSON cache files. The browser fetches a single cache file and renders it — no client-side analysis.

**Key insight**: Python is the single source of truth for all analysis (pivot detection, divergence signals, regime scoring). JS is a pure renderer. This prevents logic drift between Python and JS. If cache is missing, the page shows a clear error — no silent fallback to client-side computation.

**Key insight**: This is a fully static site. GitHub Pages serves HTML, CSS, JS, CSV, and JSON files as static assets. No backend server required.

## Architecture

### Data Pipeline
1. **GitHub Actions workflow** (`.github/workflows/update-data.yml`) runs once daily at 21:00 UTC (4 PM ET market close)
2. Uses Python with `yfinance` library to fetch data from Yahoo Finance
3. **Fetches TWO datasets per symbol**:
   - Hourly data: Last 1 month (~143 bars for stocks, ~700 for crypto) → `data/{symbol}_hourly.csv`
   - Daily data: Max available history (thousands of bars) → `data/{symbol}.csv`
4. Runs `generate_cache.py` to precompute all analysis → `data/cache/*.json`
5. Commits CSV + cache files if changes are detected
6. GitHub Pages serves everything as static content (HTML + CSS + JS + CSV + JSON files)

### Symbols Fetched
- **SPY**: S&P 500 ETF
- **HYG**: High-yield corporate bond ETF
- **QQQ**: Nasdaq 100 ETF
- **TLT**: 20+ Year Treasury Bond ETF
- **GLD**: Gold ETF
- **IWM**: Russell 2000 Small Cap ETF
- **BTC**: Bitcoin (BTC-USD) - trades 24/7, so hourly data has ~700 bars

### Client-Side Processing
1. `index.html` / `macro.html` contain HTML structure
2. `styles.css` contains all styling
3. `app.js` / `macro_app.js` are pure renderers — no analysis logic
4. On page load:
   - Fetches precomputed cache JSON from `data/cache/` via `fetch()` with `cache: "no-store"`
   - Fetches hourly and daily CSV files (needed for TradingView chart rendering on divergence page)
   - Applies cached signals, trends, pivots, and regime scores to DOM
   - If cache file is missing: throws with message "Cache missing — run: python3 generate_cache.py"
5. Dropdown changes (lookback, pivot mode, swing window) fetch a different cache file — no recomputation

### Divergence Pairs (Modular Configuration)
Pairs are defined in `app.js` in the `PAIRS` array:
- **SPY ↔ HYG**: Equities vs high-yield bonds
- **QQQ ↔ TLT**: Tech vs treasuries
- **SPY ↔ GLD**: Equities vs gold
- **SPY ↔ IWM**: Large cap vs small cap
- **BTC ↔ SPY**: Crypto vs equities
- **BTC ↔ GLD**: Crypto vs gold

**Adding new pairs**: Add to `config.json` and re-run `generate_cache.py` — no HTML changes needed!

### Signal Logic
- **Bearish divergence**: Asset 1 makes higher highs while Asset 2 makes lower highs
- **Bullish divergence**: Asset 1 makes lower highs while Asset 2 makes higher highs
- **Aligned**: Both assets trending in the same direction (confirmation)

Default parameters (configurable via dropdown):
- `LOOKBACK_DAYS = 20`: Number of days to analyze (20, 50, or 100)
- `PIVOT_MODE = "recent"`: How to select pivot points ("recent", "highest", "highest-to-current")
- `SWING_WINDOW_DAYS = null`: Auto-scale or manual override for pivot detection window

## Development Commands

### Fetching Data and Generating Cache Locally
```bash
# Install yfinance (one-time)
pip install yfinance

# Fetch both hourly and daily data for all symbols
python3 fetch_data.py
# Creates: data/spy.csv, data/spy_hourly.csv, etc.

# Generate precomputed cache files (required — JS has no analysis fallback)
python3 generate_cache.py
# Creates: data/cache/divergence_*.json, data/cache/macro_*.json
```

### Triggering Data Updates (GitHub Actions)
The workflow can be manually triggered via GitHub Actions UI:
```bash
# Navigate to: Actions → "Update market data (Yahoo Finance → data/*.csv)" → Run workflow
```

Or commit and push changes to trigger a new deployment:
```bash
git add .
git commit -m "Update site"
git push
```

### Testing Locally
Since this is a static site that fetches CSV files, you need a local server to avoid CORS issues with the `file://` protocol:

```bash
# Using Python 3
python3 -m http.server 8000

# Using Node.js
npx http-server -p 8000

# Using PHP
php -S localhost:8000
```

Then visit `http://localhost:8000` in your browser.

**Note**: Local testing requires both CSV files and cache files. Run `python3 fetch_data.py` then `python3 generate_cache.py` first.

### Workflow Testing
To test workflow changes without waiting for the schedule:
1. Make changes to `.github/workflows/update-data.yml`
2. Push to `main`
3. Go to Actions tab and manually trigger "Update market data"

## File Structure

```
.
├── index.html                          # Divergence dashboard HTML
├── macro.html                          # Macro model dashboard HTML
├── styles.css                          # All CSS styling
├── app.js                              # Divergence page renderer (pure renderer, no analysis)
├── macro_app.js                        # Macro page renderer (pure renderer, no analysis)
├── config.json                         # Divergence pairs + symbol config
├── macro_config.json                   # Macro model categories + assets
├── fetch_data.py                       # Fetches hourly + daily CSVs from Yahoo Finance
├── generate_cache.py                   # Runs all analysis, writes data/cache/*.json
├── data/                               # Generated by GitHub Actions
│   ├── spy.csv, hyg.csv, etc.          # Daily OHLCV data (max history)
│   ├── spy_hourly.csv, etc.            # Hourly OHLCV data (last 1 month)
│   └── cache/                          # Precomputed JSON cache files
│       ├── divergence_*.json           # Per-combination divergence results
│       └── macro_*.json                # Per-combination macro regime results
├── .github/
│   └── workflows/
│       └── update-data.yml             # Scheduled data fetching + cache generation
├── CLAUDE.md                           # This file
└── README.md                           # Project documentation
```

## Important Technical Details

### Data Source
- **Yahoo Finance** via `yfinance` Python library
- No API key required (free, public data)
- Fetches both hourly (`interval='1h', period='1mo'`) and daily (`interval='1d', period='max'`)
- Bitcoin uses ticker `BTC-USD`, all others use standard symbols (SPY, HYG, etc.)

### CSV Format
**Daily data** (`spy.csv`):
```
Date,Open,High,Low,Close,Volume
2024-01-01,450.00,452.00,449.00,451.50,1000000
```

**Hourly data** (`spy_hourly.csv`):
```
Date,Time,Open,High,Low,Close,Volume
2024-01-01,09:30:00,450.00,451.00,449.50,450.25,500000
```

### Client-Side Functions (app.js — pure renderer)
- **loadCsvPoints()**: Parses daily CSV → `[timestamp, price]` array (used for chart data)
- **loadHourlyData()**: Parses hourly CSV (loaded into dataCache, available for charts)
- **calculateMA()**: Computes moving average for chart MA overlay only
- **renderChartTV()**: TradingView chart with price area, MA line, and pivot trend line
- **applyDivergenceCache()**: Reads cache JSON, populates trend/signal DOM elements, renders charts
- **loadAndRender()**: Fetches `data/cache/divergence_{lookback}_{mode}_{swing}.json`, calls applyDivergenceCache

### Client-Side Functions (macro_app.js — pure renderer)
- **renderSparkline()**: SVG sparkline with MA overlay using pre-computed price/MA points from cache
- **renderAssetCard()**: Renders individual asset card from cache data (price, pct change, signal)
- **applyMacroCache()**: Reads cache JSON, populates regime score, breadth bars, and asset cards
- **loadAndRender()**: Fetches `data/cache/macro_{lookback}_{ma}.json`, calls applyMacroCache

### Modular Architecture
- **config.json**: All divergence pairs and symbol definitions (source of truth for app.js)
- **macro_config.json**: All macro categories and assets (source of truth for macro_app.js)
- **generatePairHTML()**: Dynamically generates HTML for each pair from config
- **renderPairColumns()**: Injects pair UI into DOM on page load

### GitHub Actions Concurrency
The workflow uses `concurrency.cancel-in-progress: false` to prevent overlapping runs from stomping on each other during git operations. This is critical for data integrity.

## Adding New Divergence Pairs

1. Add the pair to `config.json` under `"pairs"` and the symbol under `"symbols"`
2. Add the symbol to `fetch_data.py` (including any Yahoo Finance ticker mapping)
3. Fetch data and regenerate cache:

```bash
python3 fetch_data.py
python3 generate_cache.py
```

No HTML changes needed — the UI is generated dynamically from config.

## Modifying the Divergence Logic

All analysis logic lives in `generate_cache.py`. After any change to analysis logic, re-run:

```bash
python3 generate_cache.py
```

Parameters are configurable via dropdowns in the UI (lookback period, pivot mode, swing window). Each combination maps to a precomputed cache file. To add new dropdown options, update both `index.html` and ensure `generate_cache.py` generates the corresponding cache files for each new combination.

To change defaults, edit `config.json`:

```json
{
  "defaults": {
    "lookback_days": 20,
    "pivot_mode": "recent",
    "swing_window_days": null
  }
}
```

## GitHub Pages Setup

Required settings (Settings → Pages):
- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

The site will be available at `https://<username>.github.io/<repo-name>/`

## Common Gotchas

1. **CORS errors during local development**: Must use a local HTTP server, not `file://` protocol. On GitHub Pages this is not an issue.
2. **Missing cache files locally**: Run `python3 fetch_data.py` then `python3 generate_cache.py` — JS has no analysis fallback and will show an error without cache files.
3. **Blank page / "Cache missing" error**: Cache file not found for the current dropdown combination. Re-run `python3 generate_cache.py`.
4. **Stale data in browser**: Files are fetched with `cache: "no-store"`, but browser DevTools may override this.
5. **Workflow schedule is UTC**: The cron `0 21 * * 1-5` runs at 21:00 UTC on weekdays (4 PM ET during EST, 5 PM ET during EDT)
6. **Data not appearing**: Ensure the workflow has run at least once (check Actions tab for green checkmark)
7. **Bitcoin has 24/7 data**: BTC trades around the clock, so hourly data has ~700 bars vs ~143 for stocks
8. **Yahoo Finance rate limits**: If fetching fails, wait a few minutes and retry. The free tier is generally reliable for this use case.
9. **Adding new symbols**: Update `fetch_data.py`, `config.json` (or `macro_config.json`), then re-run both `fetch_data.py` and `generate_cache.py`.

## Using Hourly Data (Future Enhancement)

Hourly CSVs are fetched and loaded into `dataCache` (as `{sym}_hourly`) but not used for analysis. To enable hourly analysis for the 20-day lookback, update `generate_cache.py` to use hourly data when `lookback == 20`, then re-run `python3 generate_cache.py`. The JS renderer requires no changes — it renders whatever pivots/signals the cache provides.
