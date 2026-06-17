# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Risk Model is a static GitHub Pages site with eight pages covering divergence signals, macro model, credit spreads, FRED economic data, FOMC policy, Fed Chair transitions, cross-asset correlations, and trade signals:

| Page | File | Data Source | Analysis |
|------|------|-------------|----------|
| Divergence | `index.html` / `js/pages/divergence.js` | Yahoo Finance CSVs + cache JSON | Python (`generate_cache.py`) |
| Macro Model | `pages/macro.html` / `js/pages/macro.js` | Yahoo Finance CSVs + cache JSON | Python (`generate_cache.py`) |
| Trade | `pages/trade.html` / `js/pages/trade.js` | trading_signals.json cache | Python (`pipeline/generators/trading_generator.py`) |
| Credit Spread | `pages/credit.html` / `js/pages/credit.js` | FRED CSV (`BAMLH0A0HYM2`) | Client-side JS |
| Gov Data | `pages/gov_data.html` / `js/pages/gov_data.js` | FRED CSVs (`data/fred/`) | Client-side JS |
| FOMC | `pages/fomc.html` / `js/pages/fomc.js` | FRED CSVs (`data/fred/`) | Client-side JS |

**Key architectural rule**: Python is the single source of truth for divergence and macro analysis. JS is a pure renderer for those pages. Gov Data and Credit Spread are exceptions — they do lightweight client-side analysis (no pivot detection, just stats).

## Data Pipelines

### v2 SQLite Pipeline (active — all pages)

Active workflow: `.github/workflows/update-data-v2.yml`
Schedule: 14:00 UTC (pre-market) + 21:00 UTC (post-market) weekdays

Steps:
1. `python3 -m pipeline.run seed` — seed SQLite from existing CSVs (idempotent)
2. `python3 -m pipeline.run fetch` — fetch Yahoo Finance + FRED → SQLite
3. `python3 -m pipeline.run generate` — run all generators → `data/cache/*.json`
4. Commit and push JSON cache files

**Single source of truth rule**: Each page's analysis logic lives in exactly one file under `pipeline/generators/`. Never create a parallel implementation in `scripts/`. Always read the workflow YAML first to confirm what runs in production before editing any generator.

| Generator | Output |
|---|---|
| `pipeline/generators/trading_generator.py` | `trading_signals.json` + dated history files |
| `pipeline/generators/divergence_generator.py` | `divergence_*.json` |
| `pipeline/generators/macro_generator.py` | `macro_*.json` |
| `pipeline/generators/correlation_generator.py` | `correlation_*.json` |

### FRED Pipeline (Credit + Gov Data)
1. `fetch_fred.py` fetches FRED series via `fredapi` → `data/fred/{SERIES_ID}.csv`
2. Requires `FRED_API_KEY` env var (store in `.env`, loaded via `python-dotenv`)
3. Config driven by `config/fred_config.json` (categories structure with `display` and `freq` fields)
4. JS loads CSVs directly and computes stats client-side — no cache files needed

## Development Commands

```bash
# v2 pipeline (trading signals + all caches)
python3 -m pipeline.run seed      # seed SQLite from existing CSVs
python3 -m pipeline.run fetch     # fetch fresh data → SQLite
python3 -m pipeline.run generate  # regenerate all cache files from SQLite

# Yahoo Finance CSVs (divergence + macro, legacy path)
python3 scripts/fetch_data.py          # fetch hourly + daily CSVs
python3 scripts/generate_cache.py      # regenerate divergence/macro cache files

# FRED data
python3 scripts/fetch_fred.py          # fetch all FRED series (reads FRED_API_KEY from .env)

# Local server (required — file:// causes CORS errors)
python3 -m http.server 8000
```

## File Structure

```
.
├── index.html              # Divergence dashboard (must stay at root for GitHub Pages)
├── pages/                  # All other HTML pages
│   ├── macro.html
│   ├── trade.html
│   ├── credit.html
│   ├── gov_data.html
│   ├── fomc.html
│   ├── correlation.html
│   ├── fed_chair.html
│   ├── trend_structure.html
├── js/                     # ES module frontend
│   ├── pages/              # Page-specific modules
│   ├── core/               # Shared utilities (api.js, chart-utils.js, utils.js)
│   └── components/         # UI components (Navigation.js, etc.)
├── styles/                 # All CSS
│   └── styles.css          # Main stylesheet (+ base.css, charts.css, etc.)
├── config/                 # JSON configuration files
│   ├── config.json         # Divergence pairs + symbol config
│   ├── macro_config.json   # Macro categories + assets
│   ├── fred_config.json    # FRED series (display + freq fields)
│   ├── trading_config.json # Trading symbols
│   └── correlation_config.json
├── pipeline/               # v2 SQLite pipeline architecture
├── scripts/                # All scripts (Python + shell), run from repo root
│   ├── fetch_data.py           # Fetches Yahoo Finance CSVs (hourly + daily)
│   ├── fetch_trading_hourly.py # Fetches intraday data for trading signals
│   ├── fetch_fred.py           # Fetches FRED series → data/fred/*.csv
│   ├── generate_cache.py       # Runs all analysis → data/cache/*.json
│   ├── generate_correlation_cache.py
│   ├── cache_utils.py          # Shared cache utilities
│   └── refresh.sh              # Full refresh (run from repo root)
├── docs/                   # Documentation
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
└── .github/workflows/
    ├── update-data-v2.yml      # active: 14:00 + 21:00 UTC weekdays
    └── backfill-trading-history.yml  # manual: regenerate historical dated cache files
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

## config/fred_config.json Schema

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
2. **Cache missing error**: Run `python3 -m pipeline.run generate` — JS has no analysis fallback
3. **FRED key not found**: Ensure `.env` has `FRED_API_KEY=...` and `python-dotenv` is installed
4. **Weekly change doubled**: `findPriorPoint` uses date-based lookback — daily=1, weekly=6, monthly=25 days
5. **BTC has 24/7 data**: ~700 hourly bars vs ~143 for stocks
6. **Workflow schedule**: two runs — 14:00 UTC (pre-market, 9 AM ET) and 21:00 UTC (post-market, 4 PM ET) weekdays
7. **Trading signal logic**: lives only in `pipeline/generators/trading_generator.py`. `scripts/generate_trading_cache.py` has been deleted. Always check the workflow YAML before editing any generator to confirm what actually runs in production.
