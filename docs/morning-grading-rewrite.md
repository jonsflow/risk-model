# Morning Setup Grading — Implementation Spec

## Background

The trade tab "Step 1 — Day Quality Gate" currently grades days using full-day closing volume and ATR percentile rank against a 50-day window. This is wrong for a morning setup — it uses data that doesn't exist at market open and ignores pre-market signals.

This spec defines the rewrite. Reference: `docs/day-quality-grading.md` for the scoring model rationale.

---

## Scoring Model (4 factors, 0–8 pts)

| Factor | Measurement | 0 pts | 1 pt | 2 pts |
|--------|-------------|-------|------|-------|
| Pre-market RVOL | Today PM vol ÷ 20d avg PM vol | < 0.8× | 0.8–1.5× | ≥ 1.5× |
| Overnight Range | PM H-L ÷ 20d avg PM H-L | < 0.7× | 0.7–1.3× | > 1.3× |
| Gap vs ATR | \|est. open − prior close\| ÷ 14d ATR | < 0.2× | 0.2–0.5× | > 0.5× |
| Structure | Regime label | Choppy | Ranging | Trending |

**Grades:** 7–8 = A (Full Size) · 5–6 = B (Reduced Size) · 0–4 = C (No Trades)

**Removed:** Grade F (prior move > 10%) and weekday modifier (Mon/Fri downgrade) — both replaced by the scoring model naturally.

Pre-market window = **8:00–9:29 ET** bars from `{symbol}_hourly.csv`.

---

## Files to Change

| File | Change |
|------|--------|
| `generate_trading_cache.py` | 6 targeted changes (see below) |
| `trade_app.js` | Rewrite `renderDayQuality` |

---

## generate_trading_cache.py — 6 Changes

### Change 1 — Fix `spy_date` derivation (~line 939)

**Problem:** Live morning workflow fetches May 1 pre-market bars but daily only goes to April 30. `spy_date = April 30` so session bar lookups find April 30's pre-market instead of May 1's.

**Replace:**
```python
spy_hourly = hourly_data.get('SPY', [])
spy_daily  = daily_data.get('SPY', [])
spy_date   = datetime.fromtimestamp(spy_daily[-1][0], tz=timezone.utc).date() if spy_daily else None
```

**With:**
```python
spy_hourly    = hourly_data.get('SPY', [])
spy_daily     = daily_data.get('SPY', [])
daily_latest  = datetime.fromtimestamp(spy_daily[-1][0],  tz=timezone.utc).date() if spy_daily  else None
hourly_latest = datetime.fromtimestamp(spy_hourly[-1][0], tz=timezone.utc).date() if spy_hourly else None
# Use hourly date when newer (morning run: daily=T-1, hourly has T bars)
spy_date = hourly_latest if (hourly_latest and daily_latest and hourly_latest > daily_latest) else daily_latest
```

---

### Change 2 — Move `detect_regime` before the per-symbol loop (~line 954)

Factor 4 (structure) needs the regime label during grading. Currently regime is computed after the loop.

**Add before `for symbol in symbols:`:**
```python
output['regime'] = detect_regime(regime_symbols, daily_data, hourly_data)
```

**Delete** the existing `detect_regime` call near the bottom of the function (~line 1154):
```python
output['regime'] = detect_regime(regime_symbols, daily_data, hourly_data)  # DELETE THIS LINE
```

---

### Change 3 — New function `compute_premarket_metrics`

Add in the **TECHNICAL INDICATORS** section (after `calculate_moving_average`, before `grade_day_quality`).

```python
def _premarket_no_data() -> dict:
    return {
        'rvol':  {'score': 0, 'ratio': None, 'pm_vol_today': None, 'pm_vol_avg_20d': None},
        'range': {'score': 0, 'ratio': None, 'pm_range_today': None, 'pm_range_avg_20d': None},
        'has_data': False,
    }


def compute_premarket_metrics(hourly_points: list, target_date) -> dict:
    """
    Compute pre-market RVOL and overnight range for target_date vs 20-day averages.
    Pre-market window: 08:00–09:29 ET (stored as UTC in CSV).
    Returns dict with scores (0/1/2) and raw values for UI display.
    """
    if not hourly_points or target_date is None:
        return _premarket_no_data()

    # Group pre-market bars (08:00–09:29) by date
    pm_by_date = {}
    for ts, ohlcv in hourly_points:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        hhmm = dt.hour * 100 + dt.minute
        if 800 <= hhmm < 930:
            d = dt.date()
            pm_by_date.setdefault(d, []).append(ohlcv)

    today_bars = pm_by_date.get(target_date, [])
    if not today_bars:
        return _premarket_no_data()

    pm_vol_today   = sum(b['volume'] for b in today_bars)
    pm_high_today  = max(b['high']   for b in today_bars)
    pm_low_today   = min(b['low']    for b in today_bars)
    pm_range_today = pm_high_today - pm_low_today

    # 20-day historical averages (exclude target_date)
    hist_dates = sorted(d for d in pm_by_date if d < target_date)[-20:]
    if not hist_dates:
        return _premarket_no_data()

    hist_vols   = [sum(b['volume'] for b in pm_by_date[d]) for d in hist_dates]
    hist_ranges = [max(b['high'] for b in pm_by_date[d]) - min(b['low'] for b in pm_by_date[d])
                   for d in hist_dates]

    avg_vol   = sum(hist_vols)   / len(hist_vols)
    avg_range = sum(hist_ranges) / len(hist_ranges)

    rvol        = round(pm_vol_today   / avg_vol,   2) if avg_vol   > 0 else 0.0
    range_ratio = round(pm_range_today / avg_range, 2) if avg_range > 0 else 0.0

    rvol_score  = 2 if rvol >= 1.5        else (1 if rvol >= 0.8        else 0)
    range_score = 2 if range_ratio > 1.3  else (1 if range_ratio >= 0.7 else 0)

    return {
        'rvol':  {'score': rvol_score,  'ratio': rvol,
                  'pm_vol_today': pm_vol_today, 'pm_vol_avg_20d': round(avg_vol)},
        'range': {'score': range_score, 'ratio': range_ratio,
                  'pm_range_today': round(pm_range_today, 2), 'pm_range_avg_20d': round(avg_range, 2)},
        'has_data': True,
    }
```

---

### Change 4 — Rewrite `grade_day_quality` (lines 715–762)

**Replace the entire function:**

```python
def grade_day_quality(points: list, hourly_points: list, target_date, regime_label: str) -> tuple:
    """
    Grade the trading day using a 4-factor pre-market scoring model (0–8 pts).
    Reference: docs/day-quality-grading.md

    points        — daily bars through T-1 (prior complete day — pass points[:-1] from caller)
    hourly_points — all available hourly bars (pre-market window filtered internally)
    target_date   — the trading date being graded (date object)
    regime_label  — 'Trending' | 'Ranging' | 'Choppy'

    Returns (grade, scores_dict)
    Grades: 'A' (7–8 pts), 'B' (5–6 pts), 'C' (0–4 pts)
    """
    if len(points) < 2:
        return 'B', {'total': 4, 'max': 8, 'has_data': False}

    prior_close = points[-1][1]['close']
    atr_vals    = calculate_atr(points, 14)
    atr_14      = atr_vals[-1][1] if atr_vals else 0.0

    # Factors 1 + 2: Pre-market RVOL and Overnight Range
    pm = compute_premarket_metrics(hourly_points, target_date)
    rvol_score  = pm['rvol']['score']
    range_score = pm['range']['score']

    # Factor 3: Gap vs ATR
    # Est. open = first bar of target_date in hourly (pre-market or regular session)
    est_open = None
    for ts, ohlcv in hourly_points:
        if datetime.fromtimestamp(ts, tz=timezone.utc).date() == target_date:
            est_open = ohlcv['open']
            break

    gap_pts   = abs(est_open - prior_close) if est_open is not None else 0.0
    gap_ratio = round(gap_pts / atr_14, 2)  if atr_14 > 0 else 0.0
    gap_score = 2 if gap_ratio > 0.5 else (1 if gap_ratio >= 0.2 else 0)

    # Factor 4: Structure Clarity
    structure_score = {'Trending': 2, 'Ranging': 1, 'Choppy': 0}.get(regime_label, 1)

    total = rvol_score + range_score + gap_score + structure_score
    grade = 'A' if total >= 7 else ('B' if total >= 5 else 'C')

    scores = {
        'total': total,
        'max':   8,
        'rvol':      {**pm['rvol'],  'score': rvol_score},
        'range':     {**pm['range'], 'score': range_score},
        'gap':       {
            'score': gap_score, 'ratio': gap_ratio,
            'gap_pts': round(gap_pts, 2), 'atr_14': round(atr_14, 2),
            'prior_close': round(prior_close, 2),
            'est_open': round(est_open, 2) if est_open is not None else None,
        },
        'structure': {'score': structure_score, 'regime': regime_label},
        'has_data':  pm['has_data'],
    }
    return grade, scores
```

---

### Change 5 — Update call site in per-symbol loop (~line 1005)

**Replace:**
```python
if symbol == 'SPY':
    if is_weekend:
        output['day_quality']['grade'] = 'N/A'
        output['day_quality']['modifiers'] = {}
    else:
        day_grade, percentiles = grade_day_quality(points, atr_current, today_ohlcv['volume'])
        day_grade = apply_weekday_modifier(day_grade, today_ts)
        output['day_quality']['grade'] = day_grade
        prev_close = points[-2][1]['close'] if len(points) >= 2 else today_ohlcv['close']
        prior_close_to_close_pct = round(
            abs((today_ohlcv['close'] - prev_close) / prev_close) * 100, 2
        ) if prev_close != 0 else 0.0
        output['day_quality']['modifiers'] = {
            'atr_percentile':    percentiles.get('atr_percentile', 50.0),
            'volume_percentile': percentiles.get('volume_percentile', 50.0),
            'prior_day_move_pct': prior_close_to_close_pct,
            'atr_above_avg':     percentiles.get('atr_percentile', 50.0) >= 50,
            'volume_above_20d':  percentiles.get('volume_percentile', 50.0) >= 50,
            'volume_above_50d':  percentiles.get('volume_percentile', 50.0) >= 75,
        }
    output['vol_regime'] = classify_vol_regime(points, atr_current)
```

**With:**
```python
if symbol == 'SPY':
    if is_weekend:
        output['day_quality'] = {'grade': 'N/A', 'scores': {}}
    else:
        regime_label = output['regime'].get('label', 'Ranging')
        # points[:-1] = daily data through T-1 (morning perspective, excludes today's close)
        day_grade, scores = grade_day_quality(
            points[:-1], hourly_data.get('SPY', []), spy_date, regime_label
        )
        output['day_quality'] = {'grade': day_grade, 'scores': scores}
    output['vol_regime'] = classify_vol_regime(points, atr_current)
```

---

### Change 6 — Delete `apply_weekday_modifier` (lines 793–810)

Delete the entire function. It is no longer called.

---

## trade_app.js — Rewrite `renderDayQuality`

Replace the entire `renderDayQuality` function (lines 196–274):

```javascript
function renderDayQuality() {
  const grade     = cacheData.day_quality.grade;
  const scores    = cacheData.day_quality.scores || {};
  const volRegime = cacheData.vol_regime || {};

  if (cacheData.market_closed) {
    document.getElementById('step1Content').innerHTML = `
      <div style="background: #1e2330; border-left: 4px solid #6b7280; padding: 12px; border-radius: 4px;">
        <strong style="color: #9ca3af;">Market Closed — Weekend</strong><br>
        <span class="muted">No grading until Monday.</span>
      </div>`;
    return;
  }

  const scoreColor = (s) => s === 2 ? '#10b981' : s === 1 ? '#f59e0b' : '#ef4444';
  const scoreDots  = (s) => [0,1,2].map(i =>
    `<span style="color:${i < s ? scoreColor(s) : '#374151'}">●</span>`
  ).join('');

  const regimeColors = { Low: '#3b82f6', Normal: '#10b981', Elevated: '#f59e0b', Extreme: '#ef4444' };
  const regimeColor  = regimeColors[volRegime.label] || '#6b7280';

  const total    = scores.total ?? '–';
  const max      = scores.max   ?? 8;
  const hasData  = scores.has_data !== false;

  const gradeColor = grade === 'A' ? '#10b981' : grade === 'B' ? '#f59e0b' : '#ef4444';
  const gradeLabel = grade === 'A' ? 'Full Size' : grade === 'B' ? 'Reduced Size' : 'No Trades';

  const rvol  = scores.rvol      || {};
  const range = scores.range     || {};
  const gap   = scores.gap       || {};
  const struc = scores.structure || {};

  const noDataMsg = '<span class="muted" style="font-size:0.8em;">No pre-market data</span>';
  const fmt = (n, suffix='') => n != null ? n + suffix : '–';

  let html = '';

  // Vol regime badge
  if (volRegime.label) {
    html += `<div style="margin-bottom: 12px;">
      <span class="muted" style="margin-right: 8px;">Vol Regime:</span>
      <span style="background: ${regimeColor}; color: white; padding: 3px 10px; border-radius: 4px; font-weight: bold; font-size: 0.9em;">${volRegime.label}</span>
      <span class="muted" style="margin-left: 8px; font-size: 0.85em;">${volRegime.atr_percentile_1y}th pct of 1-year ATR range</span>
    </div>`;
  }

  // Score summary banner
  html += `
  <div style="background: #1e2330; border-left: 4px solid ${gradeColor}; padding: 12px; border-radius: 4px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
    <div>
      <strong style="color: ${gradeColor};">Grade ${grade} — ${gradeLabel}</strong>
      ${grade === 'C' ? '<br><span class="muted" style="font-size:0.9em;">Score below threshold for active trading</span>' : ''}
    </div>
    <span style="font-size: 1.5em; font-weight: bold; color: ${gradeColor};">${total}/${max}</span>
  </div>`;

  // 4 factor score pills
  html += `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Pre-market RVOL</div>
        <span>${scoreDots(rvol.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(rvol.score ?? 0)}; font-size:1.1em;">
        ${fmt(rvol.ratio, '×')}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">
        ${rvol.ratio != null
          ? `${(rvol.pm_vol_today/1e6).toFixed(1)}M today · ${(rvol.pm_vol_avg_20d/1e6).toFixed(1)}M 20d avg`
          : noDataMsg}
      </div>
    </div>

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Overnight Range</div>
        <span>${scoreDots(range.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(range.score ?? 0)}; font-size:1.1em;">
        ${fmt(range.ratio, '×')}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">
        ${range.ratio != null
          ? `$${range.pm_range_today} today · $${range.pm_range_avg_20d} 20d avg`
          : noDataMsg}
      </div>
    </div>

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Gap vs ATR</div>
        <span>${scoreDots(gap.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(gap.score ?? 0)}; font-size:1.1em;">
        ${fmt(gap.ratio, '× ATR')}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">
        ${gap.gap_pts != null ? `$${gap.gap_pts} gap · ATR $${gap.atr_14}` : 'No gap data'}
      </div>
    </div>

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Structure</div>
        <span>${scoreDots(struc.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(struc.score ?? 0)}; font-size:1.1em;">
        ${struc.regime ?? '–'}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">Trending=2 · Ranging=1 · Choppy=0</div>
    </div>

  </div>`;

  if (!hasData) {
    html += `<div class="muted" style="font-size:0.8em;">
      ⚠ Pre-market bars not available — RVOL and Range scored 0. Grade based on Gap + Structure only.
    </div>`;
  }

  document.getElementById('step1Content').innerHTML = html;
}
```

---

## Output JSON Shape

```json
{
  "day_quality": {
    "grade": "B",
    "scores": {
      "total": 5,
      "max": 8,
      "has_data": true,
      "rvol":      { "score": 2, "ratio": 1.82, "pm_vol_today": 5200000, "pm_vol_avg_20d": 2860000 },
      "range":     { "score": 1, "ratio": 1.1,  "pm_range_today": 3.2,   "pm_range_avg_20d": 2.9 },
      "gap":       { "score": 1, "ratio": 0.35, "gap_pts": 2.4, "atr_14": 6.73, "prior_close": 718.66, "est_open": 721.06 },
      "structure": { "score": 1, "regime": "Ranging" }
    }
  }
}
```

---

## What Is NOT Changing

- `calculate_eod_outcomes` — unchanged, still uses full daily `points` (T included) + hourly
- All pattern detection — gap, engulfing, ORB, outside day — unchanged
- EOD tab rendering — unchanged, full-day volume stays there
- `classify_vol_regime` — unchanged, vol regime badge stays in Step 1
- `detect_regime` logic — unchanged, just moved before the per-symbol loop

---

## Verification

```bash
python3 generate_trading_cache.py
python3 -c "
import json, pprint
d = json.load(open('data/cache/trading_signals.json'))
print('grade:', d['day_quality']['grade'])
pprint.pprint(d['day_quality']['scores'])
"
# Then regenerate all historical files
python3 backfill_trading_history.py
# Open http://localhost:8000/trade.html — Step 1 should show 4-factor score cards
```
