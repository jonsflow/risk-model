# Risk Divergence Dashboard

**Static GitHub Pages site** with six dashboards for monitoring macro risk signals.

Uses **GitHub Actions** to fetch data from **Yahoo Finance** (via `yfinance`) and **FRED** (via `fredapi`), run Python analysis, and serve everything as static files. The browser fetches precomputed cache JSON or raw CSVs and renders — no backend required.

🔗 **[Live Demo](https://jonsflow.github.io/risk-divergence/)**

---

## Pages

| Page | Description | Data |
|------|-------------|------|
| **Divergence** | 6 asset-pair divergence signals with pivot charts | Yahoo Finance → Python cache |
| **Macro Model** | 40+ assets across 8 categories, MA signals + breadth score | Yahoo Finance → Python cache |
| **Trade** | Intraday trading signals and session-aware filters | Yahoo Finance → Python cache |
| **Credit Spread** | HY OAS spread signal, percentile rank, MA overlay | FRED (client-side) |
| **Gov Data** | 32 FRED economic series across 5 categories with sparklines | FRED (client-side) |
| **FOMC** | Fed policy rates, balance sheet, and repo market data | FRED (client-side) |

---

## Quick Start

### 1. Enable GitHub Pages
Settings → Pages → Deploy from a branch → `main` → `/ (root)`

### 2. Add Secrets
- `FRED_API_KEY` — get a free key at [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)

### 3. Trigger Data Fetch
Actions → "Update market data" → Run workflow

---

## Local Development

```bash
# Install dependencies
pip install yfinance fredapi python-dotenv

# Set FRED API key
echo "FRED_API_KEY=your_key_here" > .env

# Fetch Yahoo Finance data + generate cache
python3 fetch_data.py
python3 generate_cache.py

# Fetch FRED data
python fetch_fred.py

# Run local server (required — file:// causes CORS errors)
python3 -m http.server 8000
# → http://localhost:8000
```

---

## Features

**Divergence** — 6 pairs, configurable lookback (20/50/100d), 3 pivot modes, auto/manual swing window

**Macro Model** — breadth score, per-category tabs, configurable MA period

**Credit Spread** — percentile rank over rolling window, momentum signal, combined Risk On/Off score

**Gov Data** — frequency-aware change labels (1d/1wk/1mo), YoY % for inflation series, chart history selector

---

## Files

```
├── index.html              # Divergence dashboard
├── macro.html              # Macro model dashboard
├── trade.html              # Trade signals dashboard
├── credit.html             # Credit spread signal
├── gov_data.html           # Government data (FRED) dashboard
├── fomc.html               # FOMC & policy rates dashboard
├── styles.css              # Shared CSS
├── app.js                  # Divergence renderer
├── macro_app.js            # Macro renderer
├── trade_app.js            # Trade signals renderer
├── credit_app.js           # Credit spread renderer
├── gov_data_app.js         # Gov data renderer
├── config.json             # Divergence pairs + symbol config
├── macro_config.json       # Macro categories + assets
├── fred_config.json        # FRED series config (categories, display, freq)
├── fetch_data.py           # Fetches Yahoo Finance CSVs
├── fetch_trading_hourly.py # Fetches intraday data for trading signals
├── generate_cache.py       # Runs analysis → data/cache/*.json
├── generate_trading_cache.py # Generates trading signals cache
├── fetch_fred.py           # Fetches FRED series → data/fred/*.csv
├── cache_utils.py          # Shared cache utilities
├── refresh.sh              # Local data refresh script
├── data/
│   ├── *.csv               # Yahoo Finance daily + hourly CSVs
│   ├── cache/              # Precomputed divergence + macro JSON
│   └── fred/               # FRED series CSVs (32 series)
└── docs/                   # Technical documentation
```

---

## Tech Stack

- **Data**: Yahoo Finance (`yfinance`), FRED (`fredapi`)
- **Hosting**: GitHub Pages
- **Automation**: GitHub Actions (daily at 4 PM ET)
- **Frontend**: Vanilla JavaScript, no frameworks
- **Charts**: TradingView Lightweight Charts (divergence/credit), custom SVG sparklines (macro/gov data)

---

## Documentation

- [`docs/components.md`](./docs/components.md) — page architecture, pivot algorithm, renderer functions
- [`docs/fred-data.md`](./docs/fred-data.md) — FRED series reference, release schedules, setup
- [`docs/pair-candidates.md`](./docs/pair-candidates.md) — future divergence pair ideas
- [`CLAUDE.md`](./CLAUDE.md) — Claude Code instructions and development guide

---

## Credits

- Data: [Yahoo Finance](https://finance.yahoo.com) via [yfinance](https://github.com/ranaroussi/yfinance) · [FRED](https://fred.stlouisfed.org) via [fredapi](https://github.com/mortada/fredapi)
- Built with [Claude Code](https://claude.ai/code)
