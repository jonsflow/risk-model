# Day Quality Grading — Design Reference

Defines how the trade tab grades each trading day (A, B, C) and what data drives each factor. This is the authoritative spec for `grade_day_quality()` in `generate_trading_cache.py` and the Step 1 display in `trade_app.js`.

---

## Scoring Model

Grade is derived from a 0–8 point score across four factors. Each factor scores 0, 1, or 2.

| # | Factor | Measurement | Max |
|---|--------|-------------|-----|
| 1 | Relative Premarket Volume (RVOL) | Today premarket vol ÷ 20d avg premarket vol | 2 |
| 2 | Overnight Range Expansion | Premarket H-L ÷ 20d avg premarket range | 2 |
| 3 | Gap Significance | \|Est. open − prior close\| ÷ 14d ATR | 2 |
| 4 | Structure Clarity | Regime quality (Trending / Ranging / Choppy) | 2 |

**Grade thresholds:**

| Score | Grade | Meaning |
|-------|-------|---------|
| 7–8 | A | Full size, trend day likely |
| 5–6 | B | Reduced size, selective entries |
| 0–4 | C | No trades |

> **Note — Catalyst/Macro (future):** A 5th factor (0–2 pts, total 0–10) for scheduled events (FOMC, CPI, NFP, earnings) is planned but not yet implemented. When added, grade thresholds shift to: 8–10 = A, 5–7 = B, 0–4 = C.

---

## Factor Definitions

### Factor 1 — Relative Premarket Volume (RVOL)

```
RVOL = sum(premarket bar volumes today) / 20d avg premarket volume
```

Premarket window: **8:00–9:30 ET** (bars from hourly CSV filtered to this window on the target date).

20d avg premarket volume: average of the sum of premarket bar volumes across the last 20 trading days.

| RVOL | Score |
|------|-------|
| ≥ 1.5 | 2 |
| 0.8–1.5 | 1 |
| < 0.8 | 0 |

**Why not full-day volume?** For index ETFs like SPY, full-day volume is always large and doesn't differentiate days. Pre-market participation is a better signal of institutional interest and directional conviction before the open.

---

### Factor 2 — Overnight Range Expansion

```
RangeScore = (premarket high − premarket low) / 20d avg premarket range
```

Premarket range: H-L of the same 8:00–9:30 bars used for RVOL.

20d avg premarket range: average H-L across the last 20 premarket sessions.

| Range Ratio | Score |
|-------------|-------|
| > 1.3 | 2 |
| 0.7–1.3 | 1 |
| < 0.7 | 0 |

**Why this matters:** A wide overnight range signals price discovery and directional pressure. Tight overnight ranges often precede choppy, low-conviction sessions.

---

### Factor 3 — Gap Significance

```
GapRatio = |estimated open − prior close| / 14d ATR
```

Estimated open: first premarket bar's open, or prior close if no premarket data.

| Gap Ratio | Score |
|-----------|-------|
| > 0.5 | 2 |
| 0.2–0.5 | 1 |
| < 0.2 | 0 |

**Why this matters:** A gap larger than half an ATR signals emotional repricing — institutional actors forced to adjust overnight. These sessions often follow through or produce a strong gap-fill move, both of which are tradeable.

---

### Factor 4 — Structure Clarity

Uses the regime detection already computed in Step 2.

| Regime | Score |
|--------|-------|
| Trending | 2 |
| Ranging | 1 |
| Choppy | 0 |

**Why this matters:** Structure clarity tells you whether price has directional conviction. A trending regime on a high-RVOL day dramatically increases odds of a tradeable move. Choppy structure on any day raises whipsaw risk.

---

## Data Requirements

All four factors depend on **morning data** — data available before the regular session opens:

| Data | Source | When Available |
|------|--------|----------------|
| Premarket bars (8:00–9:30) | `{symbol}_hourly.csv` | After 9 AM workflow |
| Prior day close | `{symbol}.csv` | Previous EOD |
| 20d avg premarket vol/range | `{symbol}_hourly.csv` (last 20 sessions) | Previous EOD + today |
| 14d ATR | `{symbol}.csv` | Previous EOD |
| Regime | Computed from daily + hourly | Previous EOD |

If premarket bars for the target date are not yet in the hourly CSV (workflow hasn't run), RVOL and Range scores default to 0 and the grade reflects only gap + structure.

---

## Data Perspective — Morning vs EOD

**Critical:** day quality grades on **prior-day close data**, not the current day's close.

When generating `trading_signals_YYYY-MM-DD.json` for a target date T:
- Daily data sliced to **T-1** (day before T) — ATR, prior close, regime all from prior complete day
- Hourly data filtered to **only bars on date T** — premarket bars, opening range, session bars

This ensures the grade reflects what was knowable at 8:25 AM on day T, not what happened by 4 PM.

---

## What We Are NOT Using (and Why)

| Metric | Reason excluded |
|--------|----------------|
| Full-day closing volume | Unknown in the morning; raw SPY volume doesn't differentiate quality days |
| Prior close-to-close % move | Embedded in Gap Significance — a large prior move already implies a gap |
| Weekday modifier (Mon/Fri) | Removed — too blunt; Monday/Friday effects are already visible in RVOL/range |
| Grade F (> 10% prior move) | Subsumed by the score — an extreme prior move produces a large gap ratio (score 2) and likely high RVOL (score 2), surfacing the risk through the model rather than a hard override |
