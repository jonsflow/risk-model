# Risk Model

**Static GitHub Pages site** — macro and market dashboards covering divergence signals, macro breadth, credit spreads, FRED economic data, FOMC policy, Fed Chair transitions, cross-asset correlations, trend structure, and daily trade signals.

Data lands in **SQLite** via a Python pipeline (`pipeline/`) run by **GitHub Actions**. Generators write precomputed JSON caches; the browser fetches those and renders — no backend, no build step.

🔗 **[Live Demo](https://jonsflow.github.io/risk-model/)**

---

## Pages

| Page | File | Data Source | Analysis |
|------|------|-------------|----------|
| **Divergence** | `index.html` | Yahoo daily + JSON cache | Python (`divergence_generator.py`) |
| **Macro Model** | `pages/macro.html` | Yahoo daily + JSON cache | Python (`macro_generator.py`) |
| **Trade** | `pages/trade.html` | Yahoo daily + hourly | Python (`trading_generator.py`) |
| **Correlation** | `pages/correlation.html` | Yahoo daily + JSON cache | Python (`correlation_generator.py`) |
| **Trend Structure** | `pages/trend_structure.html` | Yahoo daily + JSON cache | Python (via macro generator) |
| **Credit Spread** | `pages/credit.html` | FRED CSV (`BAMLH0A0HYM2`) | Client-side JS |
| **Gov Data** | `pages/gov_data.html` | FRED CSVs (`data/fred/`) | Client-side JS |
| **FOMC** | `pages/fomc.html` | FRED CSVs + JSON cache | Python + client-side JS |
| **Fed Chair** | `pages/fed_chair.html` | Yahoo + FRED | Client-side JS |

Python is the single source of truth for divergence, macro, trade, and correlation analysis; the JS on those pages is a pure renderer. Credit Spread, Gov Data, and Fed Chair do lightweight stats client-side (no pivot detection).

---

## Data Sources & Timeframes

| Source | Series | Grain | Coverage |
|---|---|---|---|
| Yahoo Finance (`yfinance`) | SPY, QQQ, IWM, SMH, HYG, GLD, IWM, BTC, ETH, and macro basket | **Daily** (`1d`) | `period='max'` on first fetch, incremental after |
| Yahoo Finance (`yfinance`) | Same universe | **Hourly** (`1h`, pre/post included) | `period='1mo'` on first fetch, incremental after |
| FRED (`fredapi`) | 32 series across 5 categories | Daily / weekly / monthly (series-dependent) | Full history |

**Smallest bar available today = 1 hour.** Yahoo supports finer grains (`1m` / `5m` / `15m`) with short lookback windows, but no sub-hourly fetcher is wired in.

---

## Quick Start

### 1. Enable GitHub Pages
Settings → Pages → Deploy from a branch → `main` → `/ (root)`

### 2. Add Secrets
- `FRED_API_KEY` — free key at [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)

### 3. Trigger the Pipeline
Actions → **"Update market data v2 (SQLite pipeline)"** → Run workflow.
Runs automatically at **14:00 UTC (pre-market)** and **21:00 UTC (post-close)** weekdays.

---

## Local Development

```bash
# Install deps
pip install yfinance fredapi python-dotenv

# FRED key
echo "FRED_API_KEY=your_key_here" > .env

# v2 SQLite pipeline
python3 -m pipeline.run seed      # seed SQLite from existing CSVs (idempotent)
python3 -m pipeline.run fetch     # pull Yahoo + FRED → SQLite
python3 -m pipeline.run generate  # write all data/cache/*.json

# Serve locally (file:// breaks fetch)
python3 -m http.server 8000
# → http://localhost:8000
```

---

## Architecture

```
Yahoo Finance ─┐
               ├─► pipeline/fetchers ─► SQLite ─► pipeline/generators ─► data/cache/*.json ─► browser
FRED API ──────┘                     ├─► data/*.csv (mirrored)
                                     └─► data/fred/*.csv (client-side pages read these)
```

- **`pipeline/`** — SQLite-backed fetch + generate framework.
  - `fetchers/yahoo_fetcher.py`, `fetchers/fred_fetcher.py`
  - `generators/{divergence,macro,trading,correlation,fomc,prices}_generator.py`
  - `run.py` — CLI: `seed` / `fetch` / `generate`
- **`js/`** — ES module frontend (`pages/`, `core/`, `components/`); no build step.
- **`config/`** — JSON config for symbols, pairs, FRED series, trading watchlist.
- **`scripts/`** — legacy standalone scripts (`fetch_data.py`, `generate_cache.py`, `fetch_fred.py`). Superseded by `pipeline/` but kept for one-off tasks.

---

## File Structure

```
├── index.html                  # Divergence dashboard (stays at root for Pages)
├── pages/                      # All other HTML pages
│   ├── macro.html · trade.html · credit.html · gov_data.html
│   ├── fomc.html · correlation.html · fed_chair.html · trend_structure.html
├── js/
│   ├── pages/                  # Page-specific ES modules
│   ├── core/                   # api.js, chart-utils.js, utils.js
│   └── components/             # Navigation.js, etc.
├── styles/                     # styles.css, base.css, charts.css, ...
├── config/
│   ├── config.json             # Divergence pairs + symbol config
│   ├── macro_config.json       # Macro categories + assets
│   ├── trading_config.json     # Trading symbols
│   ├── fred_config.json        # FRED series (display + freq)
│   └── correlation_config.json
├── pipeline/                   # v2 SQLite pipeline
│   ├── fetchers/               # yahoo_fetcher.py, fred_fetcher.py
│   ├── generators/             # divergence, macro, trading, correlation, fomc, prices
│   ├── run.py                  # `python3 -m pipeline.run {seed,fetch,generate}`
│   ├── db_manager.py · base_fetcher.py · base_generator.py · analysis.py
├── scripts/                    # Legacy standalone scripts (run from repo root)
├── data/
│   ├── *.csv                   # Yahoo daily OHLCV (max history)
│   ├── *_hourly.csv            # Yahoo 1h OHLCV (~1 month rolling)
│   ├── cache/                  # Generator outputs (divergence_*, macro_*, trading_signals.json, ...)
│   └── fred/                   # FRED series CSVs (Date,Value)
├── docs/                       # Technical documentation
└── .github/workflows/
    ├── update-data-v2.yml            # Active: 14:00 + 21:00 UTC weekdays
    ├── backfill-trading-history.yml  # Manual: regenerate dated trading caches
    └── pr-validation.yml             # PR checks
```

---

## Trade Page Signal Logic

Two tabs — **Morning Setup** and **End of Day** — driven off the same cache:

- **Day Quality Grade (A+ / A / B / C)** — combined gap + pre-market range, structure/regime, intraday range trend (8d vs 20d), and index alignment (SPY / QQQ / IWM).
- **Regime Detection** — SPY MA20 + slope for Trending/Ranging; ATR trend + last-day type refine to Choppy.
- **Pattern Scanner** — ORB, Gap Fill, Gap Continuation, Engulfing, Outside Day. Only patterns valid for the current regime are shown.
- **Confluence Score (0–8)** — volume, PM range, RSI extreme, MACD alignment, MA20 side, day grade, regime match, hourly squeeze. ≥6 = full size, ≥4 = 75%, ≥3 = 50%.
- **End of Day Outcomes** — real hit/miss resolution: ORB breached / T1 hit, Gap filled, Gap Continuation T1/T2 hit, and prior-session Engulfing/Outside Day setups resolved against today's high/low.

Configurable via dropdowns on Divergence: lookback (20/50/100/200), pivot mode (recent / highest / highest-to-current), swing window (auto or 2/3/5/7/10). Each combination is its own cache file.

---

## Tech Stack

- **Data**: Yahoo Finance (`yfinance`), FRED (`fredapi`)
- **Storage**: SQLite (`pipeline/db_manager.py`) + JSON caches
- **Automation**: GitHub Actions, twice weekdays (14:00 + 21:00 UTC)
- **Hosting**: GitHub Pages
- **Frontend**: Vanilla ES modules, no framework, no build step
- **Charts**: TradingView Lightweight Charts (divergence, credit), custom SVG (macro, gov data)

---

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — architecture rules and development guide for Claude Code
- [`docs/`](./docs/) — component reference, pivot algorithm, FRED series notes, pair candidates

---

## Commit Rules

- **Never commit data files locally.** `data/*.csv`, `data/cache/*.json`, and `data/fred/*.csv` are committed exclusively by the GitHub Actions workflow.
- Source files only from a dev environment: HTML, JS, Python, JSON configs, CSS, workflow YAML.

---

## Credits

- Data: [Yahoo Finance](https://finance.yahoo.com) via [yfinance](https://github.com/ranaroussi/yfinance) · [FRED](https://fred.stlouisfed.org) via [fredapi](https://github.com/mortada/fredapi)
- Built with [Claude Code](https://claude.ai/code)
