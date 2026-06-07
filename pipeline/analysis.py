"""
pipeline/analysis.py — Shared pure analysis functions (stdlib only).

All functions are stateless: in → out. No DB or file I/O.
Replaces the scattered utility functions in cache_utils.py and generate_cache.py.
"""

import math
from datetime import datetime, timezone


# ------------------------------------------------------------------
# Slicing
# ------------------------------------------------------------------

def last(arr: list, n: int) -> list:
    return arr[max(0, len(arr) - n):]


# ------------------------------------------------------------------
# Moving average
# ------------------------------------------------------------------

def calculate_ma(points: list, period: int) -> list:
    """Simple MA on [(timestamp, value), ...]. Returns same format."""
    result = []
    for i in range(period - 1, len(points)):
        total = sum(points[j][1] for j in range(i - period + 1, i + 1))
        result.append((points[i][0], total / period))
    return result


# ------------------------------------------------------------------
# Pivot detection
# ------------------------------------------------------------------

def find_pivot_highs(points: list, left_bars: int, right_bars: int) -> list:
    """ThinkScript-style pivot high detection. Returns [{idx, time, price}, ...]"""
    result = []
    for i in range(1, len(points) - 1):
        curr = points[i][1]
        is_pivot = True
        for j in range(1, min(left_bars, i) + 1):
            if points[i - j][1] >= curr:
                is_pivot = False
                break
        if is_pivot:
            for j in range(1, min(right_bars, len(points) - 1 - i) + 1):
                if points[i + j][1] >= curr:
                    is_pivot = False
                    break
        if is_pivot:
            result.append({'idx': i, 'time': points[i][0], 'price': points[i][1]})
    return result


def find_pivot_lows(points: list, left_bars: int, right_bars: int) -> list:
    """Mirror of find_pivot_highs for local lows."""
    result = []
    for i in range(1, len(points) - 1):
        curr = points[i][1]
        is_pivot = True
        for j in range(1, min(left_bars, i) + 1):
            if points[i - j][1] <= curr:
                is_pivot = False
                break
        if is_pivot:
            for j in range(1, min(right_bars, len(points) - 1 - i) + 1):
                if points[i + j][1] <= curr:
                    is_pivot = False
                    break
        if is_pivot:
            result.append({'idx': i, 'time': points[i][0], 'price': points[i][1]})
    return result


# ------------------------------------------------------------------
# Market structure
# ------------------------------------------------------------------

def classify_structure(points: list) -> tuple:
    """
    Pine Script-style market structure labeling.
    Returns (trend_label, all_pivots, last_high, last_low).
    """
    if not points:
        return 'Sideways →', None, None, None

    highs = find_pivot_highs(points, 1, 1)
    lows  = find_pivot_lows(points, 1, 1)

    pivots = sorted(
        [{'type': 'high', **h} for h in highs] + [{'type': 'low', **l} for l in lows],
        key=lambda x: x['idx']
    )

    if not pivots:
        return 'Sideways →', [], None, None

    running_high = points[0][1]
    running_low  = points[0][1]
    last_high = last_low = None
    all_pivots = []

    for p in pivots:
        if p['type'] == 'high':
            label = 'HH' if p['price'] > running_high else 'LH'
            if label == 'HH':
                running_high = p['price']
            last_high = {'time': p['time'], 'price': p['price'], 'label': label}
        else:
            label = 'LL' if p['price'] < running_low else 'HL'
            if label == 'LL':
                running_low = p['price']
            last_low = {'time': p['time'], 'price': p['price'], 'label': label}
        all_pivots.append({'time': p['time'], 'price': p['price'], 'label': label})

    # Unconfirmed HH/LL from last bar
    last_close      = points[-1][1]
    last_close_time = points[-1][0]
    if last_close > running_high:
        last_high = {'time': last_close_time, 'price': last_close, 'label': 'HH'}
    elif last_close < running_low:
        last_low  = {'time': last_close_time, 'price': last_close, 'label': 'LL'}

    hl = last_high['label'] if last_high else None
    ll = last_low['label']  if last_low  else None

    if   hl == 'HH' and ll == 'HL': trend_label = 'HH + HL ↗'
    elif hl == 'LH' and ll == 'LL': trend_label = 'LL + LH ↘'
    elif hl == 'LH' and ll == 'HL': trend_label = 'LH + HL →'
    elif hl == 'HH' and ll == 'LL': trend_label = 'HH + LL →'
    elif hl == 'HH':                trend_label = 'HH only ↗'
    elif ll == 'LL':                trend_label = 'LL only ↘'
    else:                           trend_label = 'Sideways →'

    return trend_label, all_pivots, last_high, last_low


def find_recent_pivot_highs(points: list, max_pivots: int, bars_each_side: int, mode: str) -> list:
    all_pivots = find_pivot_highs(points, bars_each_side, bars_each_side)
    if mode == "highest":
        all_pivots.sort(key=lambda x: x['price'], reverse=True)
        return sorted(all_pivots[:max_pivots], key=lambda x: x['time'])
    return all_pivots[-max_pivots:] if len(all_pivots) >= max_pivots else all_pivots


def find_highest_to_current(points: list, bars_each_side: int) -> list:
    if not points:
        return []
    current_idx = len(points) - 1
    exclude_bars = bars_each_side + 1
    historical = points[:-exclude_bars] if exclude_bars < len(points) else []
    if not historical:
        return []
    all_pivots = find_pivot_highs(historical, bars_each_side, bars_each_side)
    if not all_pivots:
        return []
    highest = max(all_pivots, key=lambda x: x['price'])
    return [highest, {'idx': current_idx, 'time': points[current_idx][0], 'price': points[current_idx][1]}]


def calculate_trend(pivots: list) -> str:
    if len(pivots) < 2:
        return "Sideways →"
    if pivots[1]['price'] > pivots[0]['price']:
        return "Higher Highs ↗"
    if pivots[1]['price'] < pivots[0]['price']:
        return "Lower Highs ↘"
    return "Sideways →"


def get_divergence_signal(trend1: str, trend2: str) -> str:
    true_up   = {'HH + HL ↗', 'HH only ↗'}
    true_down = {'LL + LH ↘', 'LL only ↘'}
    a1 = trend1[-1] if trend1 else ''
    a2 = trend2[-1] if trend2 else ''
    if trend1 in true_up and trend2 not in true_up:
        return f"⚠️ BEARISH {a1}{a2}"
    if trend2 in true_up and trend1 not in true_up:
        return f"⚠️ BULLISH {a1}{a2}"
    if trend1 in true_down and trend2 in true_down:
        return f"ALIGNED {a1}{a2}"
    if trend1 in true_up and trend2 in true_up:
        return f"ALIGNED {a1}{a2}"
    return f"⚖️ Mixed {a1}{a2}"


# ------------------------------------------------------------------
# Correlation
# ------------------------------------------------------------------

def log_returns(prices: list) -> list:
    result = []
    for i in range(1, len(prices)):
        prev, curr = prices[i - 1][1], prices[i][1]
        if prev > 0 and curr > 0:
            result.append((prices[i][0], math.log(curr / prev)))
    return result


def align_series(returns1: list, returns2: list) -> list:
    """Inner join on timestamp."""
    map2 = {ts: v for ts, v in returns2}
    aligned = [(ts, v, map2[ts]) for ts, v in returns1 if ts in map2]
    aligned.sort(key=lambda x: x[0])
    return aligned


def rolling_pearson(aligned: list, window: int) -> list:
    result = []
    n = len(aligned)
    for i in range(window - 1, n):
        xs = [aligned[j][1] for j in range(i - window + 1, i + 1)]
        ys = [aligned[j][2] for j in range(i - window + 1, i + 1)]
        ts = aligned[i][0]
        mean_x = sum(xs) / window
        mean_y = sum(ys) / window
        cov   = sum((xs[k] - mean_x) * (ys[k] - mean_y) for k in range(window))
        var_x = sum((xs[k] - mean_x) ** 2 for k in range(window))
        var_y = sum((ys[k] - mean_y) ** 2 for k in range(window))
        denom = math.sqrt(var_x * var_y)
        corr  = cov / denom if denom != 0 else 0
        result.append((ts, round(corr, 4)))
    return result


# ------------------------------------------------------------------
# Weekly aggregation
# ------------------------------------------------------------------

def aggregate_weekly(daily_points: list) -> list:
    weeks: dict = {}
    for t, c in daily_points:
        d = datetime.fromtimestamp(t, tz=timezone.utc).date()
        key = d.isocalendar()[:2]
        weeks[key] = (t, c)
    return sorted(weeks.values(), key=lambda x: x[0])
