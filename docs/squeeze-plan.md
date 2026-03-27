# TTM Squeeze Implementation Plan

## Branch
`feature/premarket-signals` (create off `feature/daily-bias` after commit)

## Overview
Add John Carter TTM Squeeze indicator computed on hourly data to the trade tab.
Three squeeze levels (strong/normal/weak) + fired state. Used as confluence check
and displayed as badge on trade recommendation and confluence scoring cards.

---

## Tasks

### Task 1 — `generate_trading_cache.py`: add `calculate_squeeze()`
Inputs: hourly points list per symbol (stdlib only, no new deps)

**Bollinger Bands:**
- SMA(20), σ over last 20 closes
- bb_width = 4σ (upper - lower = 2×2σ)

**Keltner Channels:**
- Midline: EMA(20) via existing `_calculate_ema` helper
- ATR(14) via existing `calculate_atr` helper
- Three widths: 2×1.5×ATR, 2×2.0×ATR, 2×2.5×ATR

**Squeeze status:**
- `'strong'`: bb_width < kc at 1.5x
- `'normal'`: bb_width < kc at 2.0x (but ≥ 1.5x)
- `'weak'`:   bb_width < kc at 2.5x (but ≥ 2.0x)
- `'none'`:   bb outside all KC (fired)
- `'unknown'`: insufficient data

**Momentum:**
- midpoint = (HH20 + LL20 + kc_upper_2x + kc_lower_2x) / 4
- momentum = close[-1] − midpoint
- momentum_increasing = momentum > momentum 3 bars ago

**Returns:** `{status, momentum, momentum_increasing}`

---

### Task 2 — Wire squeeze into symbol output
In the per-symbol loop in `generate_trading_signals()`:
- Call `calculate_squeeze(hourly_data[symbol])`
- Add under `output['symbols'][symbol]['squeeze']`
- Handle empty hourly data gracefully (`status: 'unknown'`)

---

### Task 3 — `trade_app.js`: add squeeze confluence check
In `scoreConfluences()`, add to checks object:
- Key: `'Squeeze aligned'`
- Value: `squeeze.status !== 'none' && squeeze.status !== 'unknown'`
  AND momentum direction matches trade direction
  (long → `momentum_increasing === true`, short → `momentum_increasing === false`)
- Update score display from `/7` → `/8`

---

### Task 4 — Add squeeze badge to trade recommendation cards
In `renderRecommendations()`, add badge in the indicator row (alongside RSI/MACD/MA):
- Badge color by level: strong=red, normal=orange, weak=yellow, none=green, unknown=gray
- Show momentum arrow: ▲ increasing / ▼ decreasing
- Label examples: "Strong ▲", "Fired ▲", "Weak ▼"

---

### Task 5 — Add squeeze badge to confluence scoring cards
In Step 4 render section, show squeeze status on each card so user sees
squeeze context while reviewing confluence scores.

---

### Task 6 — Regenerate cache and verify
```bash
python3 generate_trading_cache.py
```
Check:
- All 9 symbols (SPY, QQQ, IWM, SMH, BTC, ETH, GLD, SLV, USO) generate
- Each symbol has `squeeze` key with valid status/momentum values
- No errors on symbols with thin hourly data (SLV, USO)

---

## Context Notes
- Hourly data already loaded per-symbol in `generate_trading_signals()` as `hourly_data[symbol]`
- Existing helpers to reuse: `_calculate_ema`, `calculate_atr`, `calculate_moving_average`
- `.pill` CSS class has `min-width: 200px` — use inline styles for inner card elements
- Trading symbols: `TRADING_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'SMH', 'BTC', 'ETH', 'GLD', 'SLV', 'USO']`
- Regime symbols (index only): `REGIME_SYMBOLS = ['SPY', 'QQQ', 'IWM']`
- Step 4 cards: 400px wide, flex-wrap
- Step 5 cards: 400px wide, flex-wrap
