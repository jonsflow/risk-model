# Component Reference

Detailed documentation for each page, renderer, and algorithm in the Risk Divergence Dashboard.

---

## Pages

### 1. Divergence (`index.html` + `app.js`)

Displays 6 asset-pair divergence signals. Each pair gets a card with trend labels, a signal badge, and a TradingView price chart with pivot markers.

**Data flow**: `fetch_data.py` → `data/{sym}.csv` → `generate_cache.py` → `data/cache/divergence_{lookback}_{mode}_{swing}.json` → `app.js` renders

**Dropdowns** (each triggers a new cache file fetch, no recomputation):
- Lookback: 20 / 50 / 100 days
- Pivot mode: `recent` | `highest` | `highest-to-current`
- Swing window: auto or manual day count

**Key functions in `app.js`**:
- `loadAndRender()` — fetches cache JSON, calls `applyDivergenceCache()`
- `applyDivergenceCache()` — populates trend/signal DOM, calls `renderChartTV()` per pair
- `renderChartTV()` — TradingView Lightweight Charts area series + MA line + pivot trend line
- `loadCsvPoints()` — parses daily CSV → `[timestamp, price]` for chart data
- `generatePairHTML()` / `renderPairColumns()` — builds pair UI dynamically from `config.json`

---

### 2. Macro Model (`macro.html` + `macro_app.js`)

Displays 40+ assets across 8 categories. Each asset gets a card showing price, % change, MA signal (above/below), and an SVG sparkline. A breadth score and regime reading sit at the top.

**Data flow**: `fetch_data.py` → `data/{sym}.csv` → `generate_cache.py` → `data/cache/macro_{lookback}_{ma}.json` → `macro_app.js` renders

**Dropdowns**: Lookback (20/50/100d), MA Period (20/50/100d)

**Key functions in `macro_app.js`**:
- `loadAndRender()` — fetches macro cache, calls `applyMacroCache()`
- `applyMacroCache()` — renders regime score, breadth bars, and all asset cards
- `renderAssetCard()` — builds `.asset-card` with sparkline, price, change, signal badge
- `renderSparkline()` — SVG sparkline with MA overlay; green/red shading when price crosses MA
- `renderStackedSparkline()` — normalized multi-asset sparkline for the overview tab

---

### 3. Credit Spread (`credit.html` + `credit_app.js`)

Single-series page for HY OAS Spread (`BAMLH0A0HYM2`). Shows signal (Risk On/Off), current spread, percentile rank, and a full TradingView chart with MA overlay.

**Data flow**: `fetch_fred.py` → `data/fred/BAMLH0A0HYM2.csv` → `credit_app.js` computes client-side

**Analysis (all client-side)**:
- `computeMA(points, period)` — simple moving average
- `computePercentile(points, value, windowDays)` — % of values below current in the window
- `levelScore(pct)` — maps percentile to ±2 score
- `momentumScore(value, ma)` — +1 if below MA (spread falling = risk on), −1 if above
- `signalLabel(score)` — maps combined score to STRONG RISK ON / RISK ON / NEUTRAL / RISK OFF / STRONG RISK OFF

**Dropdowns**: MA Period, Percentile Window, Chart History

---

### 4. Gov Data (`gov_data.html` + `gov_data_app.js`)

Overview of 20 FRED economic series across 4 categories. Each series gets a card with current value, a frequency-aware change figure with label, latest data date, and an SVG sparkline.

**Data flow**: `fetch_fred.py` → `data/fred/{SERIES_ID}.csv` → `gov_data_app.js` computes client-side

**Categories and series**: see `fred_config.json`

**Analysis (all client-side)**:

`computeStats(points, display, freq)` handles three display modes:
- `"level"` — raw current value + absolute change from freq-appropriate prior point
- `"pct_yoy"` — `(current - priorYear) / |priorYear| × 100`; prior year found by date search
- `"pct_mom"` — `(current - prior) / |prior| × 100` using freq-appropriate prior point

`findPriorPoint(points, currentDate, lookbackDays)` — finds nearest data point at or before `currentDate - lookbackDays`. Lookback values per frequency:

| Frequency | `lookbackDays` | Finds |
|-----------|---------------|-------|
| daily | 1 | Yesterday / last trading day |
| weekly | 6 | Previous week's release |
| monthly | 25 | Previous month's release |

Change figures are labeled inline: `+0.04 1d chg`, `+2,000 1wk chg`, `+0.1 1mo chg`.

**Dropdown**: Chart History (1yr / 2yr / 5yr) — controls sparkline window only, re-renders without refetching

---

## Pivot Detection Algorithm

Used in `generate_cache.py` for divergence signals. Implemented in Python, results cached to JSON.

### Step 1 — Detect Pivot Points

For each bar `i` in a price series (skip first and last):
```
Pivot HIGH: price[i] > price[i-1] AND price[i] > price[i+1]
Pivot LOW:  price[i] < price[i-1] AND price[i] < price[i+1]
```

Window `N` controls sensitivity (auto-scaled from lookback or manually set via dropdown).

### Step 2 — Label Each Pivot (HH / HL / LH / LL)

Seed: `lastHigh = lastLow = points[0].value` (window's opening price)

Walk pivots chronologically:
```
Pivot HIGH:
  if price > lastHigh → label = HH, advance lastHigh
  else               → label = LH  (do NOT advance lastHigh)

Pivot LOW:
  if price < lastLow  → label = LL, advance lastLow
  else               → label = HL  (do NOT advance lastLow)
```

**Key rule**: `lastHigh` only advances on a HH. A LH does not reset the baseline — the next high still competes against the true running high.

### Step 3 — Read Final Structure

From the last pivot high and last pivot low in the window:

| Last High | Last Low | Structure |
|-----------|----------|-----------|
| HH | HL | `HH + HL ↗` (uptrend) |
| HH | LL | `HH only ↗` |
| LH | LL | `LL + LH ↘` (downtrend) |
| LH | HL | `LH + HL ↔` (sideways) |

### Marker Colors

| Label | Color |
|-------|-------|
| HH | Teal `#14b8a6` |
| HL | Green `#4ade80` |
| LH | Orange `#f97316` |
| LL | Red `#ff4d4d` |

### Divergence Detection

Compare pivot structure across two assets over the same lookback window:
- **Bearish divergence**: Asset 1 → HH, Asset 2 → LH (Asset 1 up, Asset 2 failing)
- **Bullish divergence**: Asset 1 → LL, Asset 2 → HL (Asset 1 down, Asset 2 holding)
- **Aligned up**: Both HH
- **Aligned down**: Both LL

---

## Regime Framework (Research / Future Feature)

Documented in `docs/regime-card-research.md`. Not yet implemented. Summary:

The macro model's breadth score (% of assets above MA) will gain an **interpretation layer** that maps signals onto a 2-axis regime quadrant:

```
                    INFLATION HIGH
  STAGFLATION           │         INFLATIONARY BOOM
  (worst for stocks     │         (commodities, energy, TIPS)
   and bonds)           │
──────────────────────────────────────────────────
  RECESSION /           │         GOLDILOCKS
  DEFLATION             │         (equities, credit —
  (long bonds, gold)    │          best broad environment)
                    INFLATION LOW
```

**Growth axis** (key assets): HYG × 2 weight, IWM × 1.5, SPY × 1, XLY/XLP ratio, EEM
**Inflation axis** (key assets): TIP × 2, TLT inverted × 1.5, GLD, USO, DBC

**Warning flags** (trigger on specific combinations):
- `CARRY RISK` — FXY above MA (yen strengthening = carry unwind)
- `INFLATION` — TIP above MA + TLT below MA simultaneously
- `CREDIT STRESS` — HYG rapid break below MA
- `CHINA` — FXI below MA while EEM broadly holds
- `VOL SPIKE` — VIXY above MA

Implementation plan: Python computes scores → `data/cache/regime_{lookback}_{ma}.json` → JS renders card. No client-side computation.

---

## CSS Architecture

Single `styles.css` file shared across all pages. Key reusable classes:

| Class | Used by |
|-------|---------|
| `.card` | All pages — main container block |
| `.site-nav` / `.nav-link` | All pages — top navigation |
| `.asset-card` | Macro, Gov Data — individual series cards |
| `.assets-grid` | Macro, Gov Data — responsive card grid |
| `.asset-sparkline` | Macro, Gov Data — SVG sparkline container (52px height) |
| `.asset-price`, `.asset-change` | Macro, Gov Data — value display with `.positive` / `.negative` |
| `.pair-column` | Divergence — per-pair chart column |
| `.risk-cards-container` | Credit — metric cards row |
| `.macro-score` | Macro — top regime score banner |
| `.header-section` / `.controls-row` / `.pill` | All pages — header + dropdown controls |

---

## Config Files

### `config.json`
Controls divergence pairs and Yahoo Finance symbols. Defaults for dropdowns. Adding a pair requires only editing this file + re-running `generate_cache.py`.

### `macro_config.json`
Controls macro model categories (Equities, Bonds, Commodities, etc.) and their assets. Adding an asset requires editing this + `fetch_data.py` + re-running `generate_cache.py`.

### `fred_config.json`
Controls Gov Data categories and FRED series. `fetch_fred.py` derives a flat series list from `categories` automatically. Adding a series requires editing this + re-running `fetch_fred.py`.
