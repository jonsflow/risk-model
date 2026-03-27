# Trading Cache Architecture

Document describing the new `trading_signals.json` cache file and how it supports the trading-rules.md framework.

---

## Overview

**Problem**: The trading-rules.md framework requires calculating ATR, RSI, MACD, volume averages, gap detection, regime, and day quality grade daily. Reading 40+ raw CSV files and recalculating all indicators on every analysis run is inefficient.

**Solution**: Pre-compute all trading indicators once per day using `generate_trading_cache.py`, output to a single JSON file (`data/cache/trading_signals.json`). Daily analysis reads one file — no CSV parsing, no math.

---

## Architecture

### Data Pipeline

```
Daily Workflow (21:00 UTC on weekdays)
│
├─ fetch_data.py
│  └─ Fetches Yahoo Finance CSVs → data/{symbol}.csv, data/{symbol}_hourly.csv
│
├─ generate_cache.py
│  └─ Computes divergence + macro analysis → data/cache/divergence_*.json, macro_*.json
│
├─ generate_trading_cache.py (NEW)
│  ├─ Reads all daily + hourly CSVs
│  ├─ Computes trading indicators
│  └─ Outputs → data/cache/trading_signals.json
│
└─ GitHub Actions commits all cache files
```

### File Locations

| File | Purpose |
|---|---|
| `data/cache/trading_signals.json` | Daily trading signals — read-only after generation |
| `generate_trading_cache.py` | Script to generate cache (runs daily in GitHub Actions) |
| `.github/workflows/update-data.yml` | Workflow that runs the script |

---

## Cache File Schema

### Top Level

```json
{
  "generated": "2026-03-25T21:00:00+00:00",
  "day_quality": {...},
  "regime": {...},
  "symbols": {...},
  "active_patterns": [...]
}
```

### day_quality Object

Global trading day grade (applies to all symbols):

```json
{
  "grade": "A",
  "modifiers": {
    "atr_above_avg": true,
    "volume_above_20d": true,
    "volume_above_50d": true,
    "prior_day_move_pct": -0.62
  }
}
```

**Grades:**
- `A+` — Ideal day: ATR above avg, volume above avg, prior move < 3%, strong trend
- `A` — Good day: ATR above avg, volume above avg, prior move < 3%
- `B` — Moderate day: Mixed signals (ATR ok, volume low or vice versa)
- `C` — Low probability: ATR below avg AND volume below avg
- `F` — No trades: Prior move > 10% OR major economic event

**Weekday Modifiers**: Mon/Fri grade down 1 level (e.g., A → B on Friday)

### regime Object

Market regime classification (Trending / Ranging / Choppy):

```json
{
  "label": "Ranging",
  "direction": "sideways",
  "atr_trend": "contracting",
  "index_alignment": "aligned"
}
```

**Regimes:**
- `Trending` — Clear 4-hour trend + ATR expanding → ORB, gap continuation trades valid
- `Ranging` — No clear trend + ATR contracting → gap fills, outside day reversals valid
- `Choppy` — Indices diverging (SPY up, IWM down) → No pattern trades allowed

### symbols Object

Per-symbol indicators and pattern flags:

```json
{
  "SPY": {
    "date": "2026-03-25",
    "open": 552.10,
    "high": 558.30,
    "low": 549.80,
    "close": 555.40,
    "volume": 82500000,

    "atr_14": 8.42,
    "atr_20d_avg": 7.91,
    "atr_above_avg": true,

    "rsi_14": 42.3,

    "macd_line": -1.2,
    "macd_signal": -0.8,
    "macd_histogram": -0.4,

    "ma_20": 561.2,
    "above_ma_20": false,

    "gap_pct": -0.82,
    "gap_type": "down",
    "gap_significant": false,
    "gap_strong": false,

    "outside_day": false,

    "patterns": {
      "orb_qualified": true,
      "gap_fill_candidate": false,
      "gap_continuation_candidate": false,
      "outside_day": false
    }
  }
}
```

**Indicators:**
- `atr_14`: Average True Range (14 periods)
- `atr_20d_avg`: ATR 20-day average (for volatility comparison)
- `rsi_14`: Relative Strength Index (14 periods)
- `macd_line`: MACD line (12-26 EMA difference)
- `macd_signal`: Signal line (9-period EMA of MACD)
- `macd_histogram`: Difference (MACD - Signal)
- `ma_20`: 20-day moving average

**Gap Detection:**
- `gap_pct`: % change from previous close to today's open
- `gap_type`: `"up"`, `"down"`, or `"none"` (< 0.1%)
- `gap_significant`: `True` if |gap| > 1%
- `gap_strong`: `True` if |gap| > 2%

**Pattern Flags:**
- `orb_qualified`: Opening range suitable for ORB trade (range > 0.75 × avg daily range)
- `gap_fill_candidate`: Significant up gap (fill expectation)
- `gap_continuation_candidate`: Strong gap (continuation expectation)
- `outside_day`: High > prev high AND low < prev low

### active_patterns Array

List of patterns detected today (highest probability candidates):

```json
[
  {
    "symbol": "SPY",
    "pattern": "ORB",
    "direction": "watch",
    "notes": "ATR 8.42 > avg 7.91, range 8.50"
  },
  {
    "symbol": "QQQ",
    "pattern": "Gap",
    "direction": "down",
    "notes": "Gap -2.15%"
  }
]
```

---

## How to Use in Analysis

### Step 1: Load the cache

```python
import json

with open('data/cache/trading_signals.json', 'r') as f:
    cache = json.load(f)

day_grade = cache['day_quality']['grade']
regime = cache['regime']['label']
symbols = cache['symbols']
patterns = cache['active_patterns']
```

### Step 2: Run trading rules (from trading-rules.md)

```python
# Step 1: Check day quality
if day_grade in ['C', 'F']:
    print("No trades today")
else:
    # Step 2: Check regime
    print(f"Regime: {regime}")

    # Step 3: Identify valid patterns for regime
    for pattern in patterns:
        symbol = pattern['symbol']
        pattern_name = pattern['pattern']

        # Check if pattern is valid for current regime
        if regime == 'Trending' and pattern_name in ['ORB', 'Gap']:
            print(f"Valid: {symbol} {pattern_name}")
        elif regime == 'Ranging' and pattern_name in ['Gap', 'Outside Day']:
            print(f"Valid: {symbol} {pattern_name}")

    # Step 4: Score confluences
    for symbol, data in symbols.items():
        confluence_score = 0

        if data['atr_above_avg']:
            confluence_score += 1
        if data['rsi_14'] < 35 or data['rsi_14'] > 65:
            confluence_score += 1
        if data['above_ma_20']:
            confluence_score += 1

        if confluence_score >= 3:
            # Calculate position size, entry, stop, targets...
            print(f"{symbol}: {confluence_score} confluences - trade")
```

---

## Key Advantages Over Raw CSV Approach

| Aspect | Raw CSVs | Trading Cache |
|---|---|---|
| **Files to read** | 44 (one per symbol) | 1 |
| **Parsing required** | Yes (CSV → numbers) | No (JSON ready) |
| **Calculation required** | Yes (ATR, RSI, MACD) | No (precomputed) |
| **Indicators available** | Close only | All (OHLCV + indicators) |
| **Pattern detection** | Must code from scratch | Pre-flagged |
| **Time to load** | Milliseconds (CSVs) → Seconds (math) | Milliseconds (JSON) |

---

## Data Freshness

- **Updated**: Daily at 21:00 UTC (4 PM ET)
- **Coverage**: All 44 symbols from `config.json` + `macro_config.json`
- **History**: Current day only (latest values)
- **Lag**: ~1-2 minutes after market close (GitHub Actions runtime)

---

## For Developers

### Running Locally

```bash
# Generate cache (after fetch_data.py has run)
python3 generate_trading_cache.py

# Verify output
cat data/cache/trading_signals.json | python3 -m json.tool | head -50
```

### Testing ATR Sanity

ATR values should be reasonable for each symbol:
- SPY: typically 8–15 per day
- BTC: typically 2000–5000 per day
- Small-cap stocks: typically 0.5–2.00 per day

If ATR is unexpectedly 0 or NaN, check:
1. Symbol CSV exists and has OHLC data
2. At least 14 bars of history (script requires period bars)
3. No missing price data in CSV

### Modifying Indicators

To add/change indicators:
1. Edit `generate_trading_cache.py`
2. Add calculation function (e.g., `calculate_stochastic()`)
3. Call it in the main loop (around line 450)
4. Add output field to `output['symbols'][symbol]`
5. Re-run: `python3 generate_trading_cache.py`

---

## Future Enhancements

### Phase 1 (Current)
- ✅ ATR, RSI, MACD, volume averages
- ✅ Gap detection
- ✅ Outside day detection
- ✅ Day quality grading (basic)
- ✅ ORB qualification

### Phase 2 (Planned)
- [ ] Economic calendar integration (flag high-impact days)
- [ ] 4-hour trend detection (classify_structure on hourly bars)
- [ ] Support/resistance level detection
- [ ] Engulfing pattern detection
- [ ] Stronger day quality logic (trend alignment, drawdown history)

### Phase 3 (Optional)
- [ ] Multi-timeframe signals (4-hour + daily confluence)
- [ ] Volatility regime scoring (VIX integration)
- [ ] Breadth analysis (% of symbols above MA)
- [ ] Correlation analysis between pairs

---

## References

- `docs/trading-rules.md` — How to use this cache in daily analysis
- `generate_trading_cache.py` — Source code for cache generation
- `.github/workflows/update-data.yml` — GitHub Actions workflow
