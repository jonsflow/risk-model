# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Risk Model is a static GitHub Pages site with eight pages covering divergence signals, macro model, credit spreads, FRED economic data, FOMC policy, Fed Chair transitions, cross-asset correlations, and trade signals:

| Page | File | Data Source | Analysis |
|------|------|-------------|----------|
| Divergence | `index.html` / `app.js` | Yahoo Finance CSVs + cache JSON | Python (`generate_cache.py`) |
| Macro Model | `macro.html` / `macro_app.js` | Yahoo Finance CSVs + cache JSON | Python (`generate_cache.py`) |
| Trade | `trade.html` / `trade_app.js` | trading_signals.json cache | Python (`generate_trading_cache.py`) |
| Credit Spread | `credit.html` / `credit_app.js` | FRED CSV (`BAMLH0A0HYM2`) | Client-side JS |
| Gov Data | `gov_data.html` / `gov_data_app.js` | FRED CSVs (`data/fred/`) | Client-side JS |
| FOMC | `fomc.html` | FRED CSVs (`data/fred/`) | Client-side JS |

**Key architectural rule**: Python is the single source of truth for divergence and macro analysis. JS is a pure renderer for those pages. Gov Data and Credit Spread are exceptions — they do lightweight client-side analysis (no pivot detection, just stats).

## Data Pipelines

### Yahoo Finance Pipeline (Divergence + Macro)
1. GitHub Actions runs daily at 21:00 UTC (4 PM ET)
2. `fetch_data.py` fetches hourly + daily CSVs via `yfinance`
3. `generate_cache.py` runs all pivot/divergence/regime analysis → `data/cache/*.json`
4. JS fetches cache JSON and renders — no recomputation in browser

### FRED Pipeline (Credit + Gov Data)
1. `fetch_fred.py` fetches FRED series via `fredapi` → `data/fred/{SERIES_ID}.csv`
2. Requires `FRED_API_KEY` env var (store in `.env`, loaded via `python-dotenv`)
3. Config driven by `fred_config.json` (categories structure with `display` and `freq` fields)
4. JS loads CSVs directly and computes stats client-side — no cache files needed

```bash
# Fetch FRED data locally
source .env && python fetch_fred.py
# or: python-dotenv handles .env automatically
python fetch_fred.py
```

## Development Commands

```bash
# Yahoo Finance data
python3 fetch_data.py          # fetch hourly + daily CSVs
python3 generate_cache.py      # regenerate all cache files (required after logic changes)

# FRED data
python fetch_fred.py           # fetch all FRED series (reads FRED_API_KEY from .env)

# Local server (required — file:// causes CORS errors)
python3 -m http.server 8000
```

## File Structure

```
.
├── index.html              # Divergence dashboard
├── macro.html              # Macro model dashboard
├── trade.html              # Trade signals dashboard
├── credit.html             # Credit spread signal
├── gov_data.html           # Government data (FRED) dashboard
├── fomc.html               # FOMC & policy rates dashboard
├── styles.css              # All CSS — shared across all pages
├── app.js                  # Divergence renderer (pure renderer, reads cache)
├── macro_app.js            # Macro renderer (pure renderer, reads cache)
├── trade_app.js            # Trade signals renderer (pure renderer, reads cache)
├── credit_app.js           # Credit renderer (client-side analysis)
├── gov_data_app.js         # Gov data renderer (client-side analysis)
├── config.json             # Divergence pairs + symbol config
├── macro_config.json       # Macro categories + assets
├── fred_config.json        # FRED series organized by category (display + freq fields)
├── fetch_data.py           # Fetches Yahoo Finance CSVs (hourly + daily)
├── fetch_trading_hourly.py # Fetches intraday data for trading signals
├── generate_cache.py       # Runs all analysis → data/cache/*.json
├── generate_trading_cache.py # Generates trading signals cache
├── fetch_fred.py           # Fetches FRED series → data/fred/*.csv
├── cache_utils.py          # Shared cache utilities
├── refresh.sh              # Local data refresh script
├── .env                    # FRED_API_KEY (gitignored)
├── data/
│   ├── spy.csv, etc.       # Daily OHLCV (max history)
│   ├── spy_hourly.csv, etc.# Hourly OHLCV (last 1 month)
│   ├── cache/              # Precomputed JSON cache files
│   │   ├── divergence_*.json
│   │   ├── macro_*.json
│   │   └── trading_signals.json
│   └── fred/               # FRED series CSVs (Date,Value format)
│       ├── BAMLH0A0HYM2.csv
│       ├── T10Y2Y.csv, DGS10.csv, VIXCLS.csv, ...
│       └── (32 series total)
└── .github/workflows/update-data.yml
```

## Symbols & Series

### Yahoo Finance (SPY, HYG, QQQ, SMH, GLD, IWM, BTC-USD)
Divergence pairs: SPY↔HYG, SPY↔QQQ, SPY↔IWM, SPY↔SMH, SPY↔GLD, SPY↔BTC

### FRED Series (32 total, 5 categories)
- **Financial Conditions**: T10Y2Y, DGS10, T10YIE, T5YIE, VIXCLS, BAMLH0A0HYM2
- **Labor Market**: ICSA, CCSA, PAYEMS, UNRATE, JTSJOL
- **Inflation**: PCEPILFE, CPILFESL, CPIAUCSL, PPIACO
- **Growth & Activity**: INDPRO, UMCSENT, RSAFS, FEDFUNDS, NFCI
- **FOMC & Policy Rates**: DFEDTARU, DFEDTARL, EFFR, IORB, SOFR, SOFR30DAYAVG, WALCL, FEDTARMD, RRPONTSYD, WRESBAL, TREAST, MBST

## fred_config.json Schema

Each series has three fields beyond `id` and `name`:
- `"units"`: display label (%, K, idx, YoY%, $M)
- `"display"`: `"level"` | `"pct_yoy"` | `"pct_mom"` — controls the stat shown on the card
- `"freq"`: `"daily"` | `"weekly"` | `"monthly"` — controls lookback for change calculation

## Signal Logic (Divergence — Python only)

- **Bearish divergence**: Asset 1 makes higher highs, Asset 2 makes lower highs
- **Bullish divergence**: Asset 1 makes lower highs, Asset 2 makes higher highs
- **Aligned**: Both trending same direction

Configurable via dropdowns: lookback (20/50/100d), pivot mode (recent/highest/highest-to-current), swing window (auto or manual). Each combination = one cache file.

## Commit Rules

- **Do not commit data files locally**: `data/*.csv`, `data/cache/*.json`, `data/fred/*.csv` are committed exclusively by the GitHub Actions workflow — do not stage or commit them from a dev environment.
- **Only commit source files**: HTML, JS, Python, JSON configs, CSS, and workflow YAML.
- The daily workflow at 21:00 UTC handles all data fetching, cache regeneration, and data commits automatically.

## Common Gotchas

1. **CORS errors**: Use `python3 -m http.server 8000`, not `file://`
2. **Cache missing error**: Run `python3 generate_cache.py` — JS has no analysis fallback
3. **FRED key not found**: Ensure `.env` has `FRED_API_KEY=...` and `python-dotenv` is installed
4. **Weekly change doubled**: `findPriorPoint` uses date-based lookback — daily=1, weekly=6, monthly=25 days
5. **BTC has 24/7 data**: ~700 hourly bars vs ~143 for stocks
6. **Workflow schedule**: cron `0 21 * * 1-5` = 21:00 UTC weekdays (4 PM ET)
