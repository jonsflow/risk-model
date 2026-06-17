"""
pipeline/generators/trading_generator.py — Trading signals cache generator.

Replaces generate_trading_cache.py.
Reads OHLCV from SQLite; writes data/cache/trading_signals.json.

All computation logic is ported verbatim from generate_trading_cache.py.
"""

import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path

from pipeline.base_generator import BaseGenerator
from pipeline.analysis import find_pivot_highs, find_pivot_lows

DATA_DIR  = Path("data")
CACHE_DIR = Path("data/cache")


class TradingGenerator(BaseGenerator):
    def generate(self, target_date=None) -> None:
        _generate_trading_signals(self.db, self.cache_dir, target_date)


# ------------------------------------------------------------------
# All computation functions ported from generate_trading_cache.py
# ------------------------------------------------------------------

def _load_config() -> tuple:
    config_path = Path("config/trading_config.json")
    if not config_path.exists():
        raise FileNotFoundError("trading_config.json not found")
    config = json.loads(config_path.read_text())
    trading_symbols, regime_symbols, ticker_map = [], [], {}
    for entry in config["symbols"]:
        symbol = entry["symbol"]
        trading_symbols.append(symbol)
        if entry.get("regime"):
            regime_symbols.append(symbol)
        if "ticker" in entry:
            ticker_map[symbol] = entry["ticker"]
    return trading_symbols, regime_symbols, ticker_map


def _calculate_ema(values: list, period: int) -> list:
    if len(values) < period:
        return []
    multiplier = 2 / (period + 1)
    ema = sum(values[:period]) / period
    result = [ema]
    for val in values[period:]:
        ema = (val * multiplier) + (ema * (1 - multiplier))
        result.append(ema)
    return result


def _calculate_atr(points: list, period: int = 14) -> list:
    if len(points) < period:
        return []
    true_ranges, result = [], []
    for i, (ts, ohlcv) in enumerate(points):
        if i == 0:
            tr = ohlcv['high'] - ohlcv['low']
        else:
            pc = points[i - 1][1]['close']
            tr = max(ohlcv['high'] - ohlcv['low'], abs(ohlcv['high'] - pc), abs(ohlcv['low'] - pc))
        true_ranges.append(tr)
        if len(true_ranges) >= period:
            result.append((ts, sum(true_ranges[-period:]) / period))
    return result


def _calculate_rsi(points: list, period: int = 14) -> list:
    if len(points) < period + 1:
        return []
    closes = [p[1]['close'] for p in points]
    gains, losses = [], []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))
    if len(gains) < period:
        return []
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    result = []
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rs = avg_gain / avg_loss if avg_loss != 0 else 0
        result.append((points[i + 1][0], 100 - (100 / (1 + rs)) if rs >= 0 else 0))
    return result


def _calculate_macd(points: list, fast=12, slow=26, signal=9) -> dict:
    if len(points) < slow + signal:
        return {'line': [], 'signal': [], 'histogram': []}
    closes = [p[1]['close'] for p in points]
    ema_fast = _calculate_ema(closes, fast)
    ema_slow = _calculate_ema(closes, slow)
    macd_line = [f - s for f, s in zip(ema_fast, ema_slow)]
    signal_line = _calculate_ema(macd_line, signal) if len(macd_line) >= signal else []
    histogram = [m - s for m, s in zip(macd_line, signal_line)]

    def ts_align(vals, total_pts, pts_list):
        offset = len(pts_list) - len(vals)
        return [(pts_list[i + offset][0], v) for i, v in enumerate(vals) if i + offset < len(pts_list)]

    return {
        'line':      ts_align(macd_line, len(points), points),
        'signal':    ts_align(signal_line, len(points), points),
        'histogram': ts_align(histogram, len(points), points),
    }


def _calculate_moving_average(points: list, period: int) -> list:
    if len(points) < period:
        return []
    result = []
    for i in range(period - 1, len(points)):
        total = sum(points[j][1]['close'] for j in range(i - period + 1, i + 1))
        result.append((points[i][0], total / period))
    return result


def _get_session_bars(hourly_points, start_hhmm, end_hhmm, target_date=None):
    if not hourly_points:
        return []
    if target_date is None:
        target_date = datetime.fromtimestamp(hourly_points[-1][0], tz=timezone.utc).date()
    result = []
    for ts, ohlcv in hourly_points:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        if dt.date() != target_date:
            continue
        hhmm = dt.hour * 100 + dt.minute
        if start_hhmm <= hhmm < end_hhmm:
            result.append((ts, ohlcv))
    return result


def _calculate_vwap(hourly_points):
    if not hourly_points:
        return {'vwap': None, 'above_vwap': None, 'distance_pct': None}
    session = _get_session_bars(hourly_points, 930, 1600)
    if not session:
        return {'vwap': None, 'above_vwap': None, 'distance_pct': None}
    cum_tp_vol = sum(((b['high'] + b['low'] + b['close']) / 3) * b['volume'] for _, b in session)
    cum_vol    = sum(b['volume'] for _, b in session)
    if cum_vol == 0:
        return {'vwap': None, 'above_vwap': None, 'distance_pct': None}
    vwap  = cum_tp_vol / cum_vol
    close = session[-1][1]['close']
    dist  = ((close - vwap) / vwap * 100) if vwap else 0.0
    return {'vwap': round(vwap, 2), 'above_vwap': close > vwap, 'distance_pct': round(dist, 2)}


def _calculate_rsi_divergence(hourly_points, swing=3):
    unknown = {'signal': 'unknown', 'description': 'Insufficient data'}
    if len(hourly_points) < 30:
        return unknown
    close_points = [(p[0], p[1]['close']) for p in hourly_points]
    rsi_values   = _calculate_rsi(hourly_points, 14)
    if len(rsi_values) < 10:
        return unknown
    rsi_start_ts  = rsi_values[0][0]
    valid_closes  = [(ts, c) for ts, c in close_points if ts >= rsi_start_ts]
    if len(valid_closes) < swing * 2 + 1:
        return unknown

    def rsi_at(ts):
        return min(rsi_values, key=lambda x: abs(x[0] - ts))[1]

    bearish_div = bullish_div = False
    price_highs = find_pivot_highs(valid_closes, swing, swing)
    if len(price_highs) >= 2:
        ph1, ph2 = price_highs[-2], price_highs[-1]
        if ph2['price'] > ph1['price'] and rsi_at(ph2['time']) < rsi_at(ph1['time']):
            bearish_div = True
    price_lows = find_pivot_lows(valid_closes, swing, swing)
    if len(price_lows) >= 2:
        pl1, pl2 = price_lows[-2], price_lows[-1]
        if pl2['price'] < pl1['price'] and rsi_at(pl2['time']) > rsi_at(pl1['time']):
            bullish_div = True

    if bullish_div and bearish_div: return {'signal': 'both',    'description': 'Bullish + bearish divergence'}
    if bullish_div:                 return {'signal': 'bullish', 'description': 'Price LL, RSI HL'}
    if bearish_div:                 return {'signal': 'bearish', 'description': 'Price HH, RSI LH'}
    return {'signal': 'none', 'description': 'No divergence'}


def _calculate_squeeze(hourly_points):
    if len(hourly_points) < 20:
        return {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}

    def _at(pts):
        closes = [p[1]['close'] for p in pts]
        last20 = closes[-20:]
        sma20   = sum(last20) / 20
        variance = sum((c - sma20) ** 2 for c in last20) / 20
        bb_width = 4 * math.sqrt(variance)
        ema20_vals = _calculate_ema(closes, 20)
        if not ema20_vals: return None
        kc_mid = ema20_vals[-1]
        atr_vals = _calculate_atr(pts, 14)
        if not atr_vals: return None
        atr = atr_vals[-1][1]
        kc_1_5, kc_2_0, kc_2_5 = 2 * 1.5 * atr, 2 * 2.0 * atr, 2 * 2.5 * atr
        if bb_width < kc_1_5:   status = 'strong'
        elif bb_width < kc_2_0: status = 'normal'
        elif bb_width < kc_2_5: status = 'weak'
        else:                   status = 'none'
        last20_pts = pts[-20:]
        hh20, ll20 = max(p[1]['high'] for p in last20_pts), min(p[1]['low'] for p in last20_pts)
        midpoint = (hh20 + ll20 + (kc_mid + 2.0 * atr) + (kc_mid - 2.0 * atr)) / 4
        momentum = pts[-1][1]['close'] - midpoint
        return status, momentum

    result = _at(hourly_points)
    if result is None:
        return {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}
    status, momentum = result
    momentum_increasing = False
    if len(hourly_points) >= 23:
        prev = _at(hourly_points[:-3])
        if prev is not None:
            momentum_increasing = momentum > prev[1]
    return {'status': status, 'momentum': round(momentum, 4), 'momentum_increasing': momentum_increasing}


def _detect_gap(points):
    if len(points) < 2:
        return {'gap_pct': 0, 'gap_type': 'none', 'gap_significant': False, 'gap_strong': False}
    prev_close = points[-2][1]['close']
    today_open = points[-1][1]['open']
    gap_pct = ((today_open - prev_close) / prev_close * 100) if prev_close else 0
    if abs(gap_pct) < 0.1:  gap_type = 'none'
    elif gap_pct > 0:        gap_type = 'up'
    else:                    gap_type = 'down'
    return {'gap_pct': round(gap_pct, 2), 'gap_type': gap_type,
            'gap_significant': abs(gap_pct) > 1.0, 'gap_strong': abs(gap_pct) > 2.0}


def _detect_outside_day(points):
    if len(points) < 2: return 'none'
    today, prev = points[-1][1], points[-2][1]
    if not (today['high'] > prev['high'] and today['low'] < prev['low']): return 'none'
    rng = today['high'] - today['low']
    if rng == 0: return 'none'
    pct = (today['close'] - today['low']) / rng
    if pct >= 0.75: return 'up'
    if pct <= 0.25: return 'down'
    return 'none'


def _detect_engulfing(points, vol_20d_avg):
    if len(points) < 2: return 'none'
    prev, curr = points[-2][1], points[-1][1]
    if curr['volume'] <= vol_20d_avg: return 'none'
    prev_bull = prev['close'] > prev['open']
    curr_bull = curr['close'] > curr['open']
    if not prev_bull and curr_bull and curr['open'] <= prev['close'] and curr['close'] >= prev['open']:
        return 'bullish'
    if prev_bull and not curr_bull and curr['open'] >= prev['close'] and curr['close'] <= prev['open']:
        return 'bearish'
    return 'none'


def _percentile_rank(series, value):
    if not series: return 50.0
    return round(sum(1 for x in series if x <= value) / len(series) * 100, 1)


def _compute_premarket_metrics(hourly_points, target_date):
    no_data = {'rvol': {'score': 0, 'ratio': None, 'pm_vol_today': None, 'pm_vol_avg_20d': None},
               'range': {'score': 0, 'ratio': None, 'pm_range_today': None, 'pm_range_avg_20d': None},
               'has_data': False}
    if not hourly_points or target_date is None:
        return no_data
    pm_by_date: dict = {}
    for ts, ohlcv in hourly_points:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        hhmm = dt.hour * 100 + dt.minute
        if 800 <= hhmm < 930:
            pm_by_date.setdefault(dt.date(), []).append(ohlcv)
    today_bars = pm_by_date.get(target_date, [])
    if not today_bars: return no_data
    pm_vol_today   = sum(b['volume'] for b in today_bars)
    pm_high_today  = max(b['high'] for b in today_bars)
    pm_low_today   = min(b['low']  for b in today_bars)
    pm_range_today = pm_high_today - pm_low_today
    hist_dates = sorted(d for d in pm_by_date if d < target_date)[-20:]
    if not hist_dates: return no_data
    hist_vols   = [sum(b['volume'] for b in pm_by_date[d]) for d in hist_dates]
    hist_ranges = [max(b['high'] for b in pm_by_date[d]) - min(b['low'] for b in pm_by_date[d]) for d in hist_dates]
    avg_vol   = sum(hist_vols) / len(hist_vols)
    avg_range = statistics.median(hist_ranges)
    has_rvol  = avg_vol > 0 and pm_vol_today > 0
    has_range = avg_range > 0 and pm_range_today > 0
    rvol        = round(pm_vol_today / avg_vol, 2)   if has_rvol  else None
    range_ratio = round(pm_range_today / avg_range, 2) if has_range else None
    rvol_score  = (2 if rvol >= 1.5       else (1 if rvol >= 0.8       else 0)) if has_rvol  else 0
    range_score = (2 if range_ratio > 1.3 else (1 if range_ratio >= 0.7 else 0)) if has_range else 0
    return {
        'rvol':  {'score': rvol_score,  'ratio': rvol,        'pm_vol_today': pm_vol_today if has_rvol else None,   'pm_vol_avg_20d': round(avg_vol) if has_rvol else None},
        'range': {'score': range_score, 'ratio': range_ratio, 'pm_range_today': round(pm_range_today, 2) if has_range else None, 'pm_range_avg_20d': round(avg_range, 2) if has_range else None},
        'has_data': has_rvol or has_range, 'has_rvol': has_rvol, 'has_range': has_range,
    }


def _load_vix() -> dict:
    path = DATA_DIR / 'fred' / 'VIXCLS.csv'
    if not path.exists():
        return None
    import csv as _csv
    vals = []
    with open(path, newline='') as f:
        for row in _csv.DictReader(f):
            try:
                v = row.get('Value', '').strip()
                if v and v != '.':
                    vals.append(float(v))
            except ValueError:
                continue
    if not vals:
        return None
    current = vals[-1]
    avg_20d = sum(vals[-20:]) / min(20, len(vals))
    return {'current': round(current, 2), 'avg_20d': round(avg_20d, 2),
            'ratio': round(current / avg_20d, 2) if avg_20d else None}


def _compute_alignment_score(regime_symbols, hourly_data) -> tuple:
    directions = {}
    for sym in regime_symbols:
        h = hourly_data.get(sym, [])
        if len(h) >= 2:
            chg = (h[-1][1]['close'] - h[0][1]['close']) / h[0][1]['close']
            directions[sym] = 'up' if chg > 0.005 else 'down' if chg < -0.005 else 'flat'
    non_flat = [d for d in directions.values() if d != 'flat']
    if not non_flat:
        score = 1
    else:
        majority = max(set(non_flat), key=non_flat.count)
        agree = non_flat.count(majority)
        score = 2 if agree == len(non_flat) else (1 if agree >= 2 else 0)
    return score, directions


def _grade_day_quality(points, hourly_points, target_date, regime_label,
                       adr_5d=None, adr_20d=None, alignment_score=1, alignment_detail=None):
    if len(points) < 2:
        return 'B', {'total': 4, 'max': 8, 'has_data': False}
    prior_close = points[-1][1]['close']

    # Factor 1: Gap + Overnight Range (combined)
    pm = _compute_premarket_metrics(hourly_points, target_date)
    has_pm_range = pm.get('has_range') and (pm['range'].get('ratio') or 0) >= 0.7
    hist_gaps = [abs(points[i][1]['open'] - points[i-1][1]['close'])
                 for i in range(max(1, len(points) - 20), len(points))]
    median_gap = statistics.median(hist_gaps) if hist_gaps else 0.0
    est_open = None
    for ts, ohlcv in hourly_points:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        if dt.date() == target_date and dt.hour * 100 + dt.minute == 930:
            est_open = ohlcv['open']
            break
    if est_open is None:
        for ts, ohlcv in hourly_points:
            if datetime.fromtimestamp(ts, tz=timezone.utc).date() == target_date:
                est_open = ohlcv['open']
                break
    gap_pts   = abs(est_open - prior_close) if est_open is not None else 0.0
    gap_ratio = round(gap_pts / median_gap, 2) if median_gap > 0 else 0.0
    has_gap   = gap_ratio >= 0.5
    gap_range_score = 2 if (has_gap and has_pm_range) else 1 if (has_gap or has_pm_range) else 0

    # Factor 2: Structure
    structure_score = {'Trending': 2, 'Ranging': 1, 'Choppy': 0}.get(regime_label, 1)

    # Factor 3: ADR Trend (5d vs 20d)
    adr_ratio = (adr_5d / adr_20d) if (adr_5d and adr_20d) else 1.0
    adr_score = 2 if adr_ratio > 1.1 else 1 if adr_ratio >= 0.9 else 0

    # Factor 4: Index Alignment (pre-computed)
    total = gap_range_score + structure_score + adr_score + alignment_score
    grade = 'A+' if total >= 7 else 'A' if total >= 5 else 'B' if total >= 3 else 'C'

    scores = {
        'total': total, 'max': 8,
        'gap_range': {
            'score': gap_range_score, 'has_gap': has_gap, 'has_pm_range': has_pm_range,
            'gap_pts': round(gap_pts, 2), 'gap_ratio': gap_ratio,
            'median_gap': round(median_gap, 2), 'prior_close': round(prior_close, 2),
            'est_open': round(est_open, 2) if est_open is not None else None,
            'pm_range_ratio': pm['range'].get('ratio'),
            'pm_range_today': pm['range'].get('pm_range_today'),
            'pm_range_avg_20d': pm['range'].get('pm_range_avg_20d'),
        },
        'structure': {'score': structure_score, 'regime': regime_label},
        'adr': {'score': adr_score, 'adr_5d': adr_5d, 'adr_20d': adr_20d, 'ratio': round(adr_ratio, 2)},
        'alignment': {'score': alignment_score, 'detail': alignment_detail or {}},
        'has_data': pm.get('has_data', False),
    }
    return grade, scores


def _classify_vol_regime(points, atr_current):
    atr_vals   = _calculate_atr(points, 14)
    atr_series = [v[1] for v in atr_vals[:-1]]
    lookback   = atr_series[-252:] if len(atr_series) >= 252 else atr_series
    pct = _percentile_rank(lookback, atr_current)
    if pct > 85:   label = 'Extreme'
    elif pct > 60: label = 'Elevated'
    elif pct >= 25: label = 'Normal'
    else:           label = 'Low'
    return {'label': label, 'atr_percentile_1y': pct}


def _detect_regime(symbols, daily_data, hourly_data):
    aligned = True
    first_dir = None
    for sym in symbols:
        pts = hourly_data.get(sym, [])
        if pts:
            change = (pts[-1][1]['close'] - pts[0][1]['close']) / pts[0][1]['close']
            curr_dir = 'up' if change > 0.005 else 'down' if change < -0.005 else 'flat'
            if first_dir is None:
                first_dir = curr_dir
            elif curr_dir != first_dir and curr_dir != 'flat' and first_dir != 'flat':
                aligned = False
                break
    if not aligned:
        return {'label': 'Choppy', 'direction': 'mixed', 'atr_trend': 'unknown', 'index_alignment': 'diverging'}

    label, direction = 'Ranging', 'sideways'
    spy_points = daily_data.get('SPY', [])
    if len(spy_points) >= 20:
        ma20 = _calculate_moving_average(spy_points, 20)
        if len(ma20) >= 10:
            ma20_now = ma20[-1][1]
            ma20_ten = ma20[-10][1]
            close = spy_points[-1][1]['close']
            if close > ma20_now and ma20_now > ma20_ten: label, direction = 'Trending', 'up'
            elif close < ma20_now and ma20_now < ma20_ten: label, direction = 'Trending', 'down'

    atr_trend = 'normal'
    if spy_points:
        atr_vals = _calculate_atr(spy_points, 14)
        if len(atr_vals) >= 20:
            atr_now = atr_vals[-1][1]
            atr_avg = sum(a[1] for a in atr_vals[-20:]) / 20
            if atr_now > atr_avg * 1.1:   atr_trend = 'expanding'
            elif atr_now < atr_avg * 0.9: atr_trend = 'contracting'

    return {'label': label, 'direction': direction, 'atr_trend': atr_trend, 'index_alignment': 'aligned'}


def _calculate_eod_outcomes(points, hourly_points, gap, atr_14):
    result = {
        'orb_high': None, 'orb_low': None, 'orb_breached_up': False, 'orb_breached_down': False,
        'orb_breached': False, 'orb_direction': 'none', 'orb_hit_t1': False,
        'gap_filled': False, 'day_range': 0.0, 'day_range_pct': 0.0, 'day_atr_multiple': 0.0,
    }
    if len(points) < 2: return result
    today      = points[-1][1]
    prev_close = points[-2][1]['close']
    day_range  = today['high'] - today['low']
    result['day_range'] = round(day_range, 2)
    if today['low'] > 0 and atr_14 > 0:
        result['day_range_pct']    = round(day_range / today['low'] * 100, 2)
        result['day_atr_multiple'] = round(day_range / atr_14, 2)
    if gap['gap_type'] == 'up':
        result['gap_filled'] = today['low'] <= prev_close
    elif gap['gap_type'] == 'down':
        result['gap_filled'] = today['high'] >= prev_close
    if hourly_points:
        today_date = datetime.fromtimestamp(points[-1][0], tz=timezone.utc).date()
        session = _get_session_bars(hourly_points, 930, 1030, target_date=today_date)
        if session:
            orb_high = max(b[1]['high'] for b in session)
            orb_low  = min(b[1]['low']  for b in session)
            result.update({'orb_high': round(orb_high, 2), 'orb_low': round(orb_low, 2)})
            bu, bd = today['high'] > orb_high, today['low'] < orb_low
            result.update({'orb_breached_up': bu, 'orb_breached_down': bd, 'orb_breached': bu or bd})
            if bu and bd:
                result['orb_direction'] = 'up' if today['close'] > (orb_high + orb_low) / 2 else 'down'
            elif bu: result['orb_direction'] = 'up'
            elif bd: result['orb_direction'] = 'down'
            if atr_14 > 0:
                result['orb_hit_t1'] = (bu and today['high'] >= orb_high + 1.5 * atr_14) or \
                                       (bd and today['low'] <= orb_low - 1.5 * atr_14)
    return result


def _generate_trading_signals(db, cache_dir, target_date=None):
    trading_symbols, regime_symbols, _ = _load_config()
    symbols = trading_symbols
    if not symbols:
        raise ValueError("No trading symbols in trading_config.json")

    print(f"Generating trading signals for {len(symbols)} symbols...")
    now_utc = datetime.now(timezone.utc)

    daily_data:  dict = {s: db.load_daily_ohlcv(s)  for s in symbols}
    hourly_data: dict = {s: db.load_hourly_ohlcv(s) for s in symbols}

    if target_date:
        target_ts   = int(datetime(target_date.year, target_date.month, target_date.day, tzinfo=timezone.utc).timestamp())
        next_day_ts = target_ts + 86400
        for s in symbols:
            daily_data[s]  = [p for p in daily_data[s]  if p[0] <= target_ts]
            hourly_data[s] = [p for p in hourly_data[s] if p[0] < next_day_ts]

    spy_last = daily_data.get('SPY', [])
    data_day = datetime.fromtimestamp(spy_last[-1][0], tz=timezone.utc).date() if spy_last else now_utc.date()
    is_weekend = data_day.weekday() >= 5

    output = {
        'generated': now_utc.isoformat(),
        'market_closed': is_weekend,
        'day_quality': {},
        'regime': {},
        'symbols': {},
        'active_patterns': [],
    }

    def bar_time(bars, idx):
        if not bars: return None
        return datetime.fromtimestamp(bars[idx][0], tz=timezone.utc).strftime('%H:%M')

    spy_hourly = hourly_data.get('SPY', [])
    spy_daily  = daily_data.get('SPY', [])
    daily_latest  = datetime.fromtimestamp(spy_daily[-1][0],  tz=timezone.utc).date() if spy_daily  else None
    hourly_latest = datetime.fromtimestamp(spy_hourly[-1][0], tz=timezone.utc).date() if spy_hourly else None
    spy_date = hourly_latest if (hourly_latest and daily_latest and hourly_latest > daily_latest) else daily_latest

    pm_bars   = _get_session_bars(spy_hourly, 800,  930,  target_date=spy_date)
    orb_bars  = _get_session_bars(spy_hourly, 930,  1030, target_date=spy_date)
    sess_bars = _get_session_bars(spy_hourly, 930,  1600, target_date=spy_date)
    lh_bars   = _get_session_bars(spy_hourly, 1500, 1600, target_date=spy_date)

    output['windows'] = {
        'premarket':     {'from': bar_time(pm_bars,   0),  'to': bar_time(pm_bars,   -1)},
        'opening_range': {'from': bar_time(orb_bars,  0),  'to': bar_time(orb_bars,  -1)},
        'session':       {'from': bar_time(sess_bars, 0),  'to': bar_time(sess_bars, -1)},
        'last_hour':     {'from': bar_time(lh_bars,   0),  'to': bar_time(lh_bars,   -1)},
    }

    output['regime'] = _detect_regime(regime_symbols, daily_data, hourly_data)
    output['vix']    = _load_vix()

    _align_score, _align_detail = _compute_alignment_score(regime_symbols, hourly_data)

    for symbol in symbols:
        points = daily_data.get(symbol, [])
        if len(points) < 2:
            continue

        today_ts, today_ohlcv = points[-1]
        atr_vals = _calculate_atr(points, 14)
        atr_current   = atr_vals[-1][1] if atr_vals else 0.0
        atr_20day_avg = sum(a[1] for a in atr_vals[-20:]) / min(20, len(atr_vals)) if atr_vals else 0.0
        rsi_vals = _calculate_rsi(points, 14)
        rsi_current = rsi_vals[-1][1] if rsi_vals else 50.0
        macd = _calculate_macd(points)
        macd_line_val   = macd['line'][-1][1]   if macd['line']   else 0.0
        macd_signal_val = macd['signal'][-1][1] if macd['signal'] else 0.0
        ma20_vals = _calculate_moving_average(points, 20)
        ma20_current = ma20_vals[-1][1] if ma20_vals else today_ohlcv['close']

        vols = [p[1]['volume'] for p in points[-50:]]
        vol_20d_avg = sum(vols[-20:]) / 20 if len(vols) >= 20 else 0
        vol_50d_avg = sum(vols[-50:]) / 50 if len(vols) >= 50 else 0

        hourly = hourly_data.get(symbol, [])
        today_date = datetime.fromtimestamp(today_ts, tz=timezone.utc).date()
        pm_bars_sym  = _get_session_bars(hourly, 800,  930,  target_date=today_date) if hourly else []
        lh_bars_sym  = _get_session_bars(hourly, 1500, 1600, target_date=today_date) if hourly else []

        pm_sym = _compute_premarket_metrics(hourly, today_date) if hourly else None
        pm_range_active = (pm_sym['range']['ratio'] >= 0.7) if (pm_sym and pm_sym.get('has_range')) else (atr_current > atr_20day_avg)

        hist_gaps = [abs(points[i][1]['open'] - points[i-1][1]['close'])
                     for i in range(max(1, len(points) - 20), len(points))]
        sym_median_gap = statistics.median(hist_gaps) if hist_gaps else 0.0

        gap = _detect_gap(points)
        if sym_median_gap > 0:
            gap_pts_dollar = abs(points[-1][1]['open'] - points[-2][1]['close'])
            gap = {**gap,
                   'gap_significant': gap_pts_dollar >= 0.5 * sym_median_gap,
                   'gap_strong':      gap_pts_dollar >= 1.5 * sym_median_gap,
                   'median_overnight_gap': round(sym_median_gap, 2)}
        else:
            gap = {**gap, 'median_overnight_gap': None}

        outside_day_dir = _detect_outside_day(points)
        outside_day     = outside_day_dir in ['up', 'down']
        _orb_bars       = _get_session_bars(hourly, 930, 1030, target_date=today_date) if hourly else []
        opening_range   = (max(b[1]['high'] for b in _orb_bars) - min(b[1]['low'] for b in _orb_bars)) if _orb_bars else 0.0
        orb_qualified   = opening_range > 0.75 * atr_20day_avg if atr_20day_avg else False
        engulfing       = _detect_engulfing(points, vol_20d_avg)
        squeeze         = _calculate_squeeze(hourly) if hourly else {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}
        vwap            = _calculate_vwap(hourly) if hourly else {'vwap': None, 'above_vwap': None, 'distance_pct': None}
        rsi_div         = _calculate_rsi_divergence(hourly) if hourly else {'signal': 'unknown', 'description': 'No hourly data'}
        eod_outcome     = _calculate_eod_outcomes(points, hourly, gap, atr_current)

        # ADR: average daily range on prior complete bars only
        _prior = points[:-1]
        _ranges = [p[1]['high'] - p[1]['low'] for p in _prior if p[1]['high'] and p[1]['low']]
        adr_20d    = round(sum(_ranges[-20:]) / min(20, len(_ranges)), 2) if _ranges else None
        adr_5d     = round(sum(_ranges[-5:])  / min(5,  len(_ranges)), 2) if _ranges else None
        prev_range = round(_ranges[-1], 2) if _ranges else None

        if symbol == 'SPY':
            if is_weekend:
                output['day_quality'] = {'grade': 'N/A', 'scores': {}}
            else:
                regime_label = output['regime'].get('label', 'Ranging')
                day_grade, scores = _grade_day_quality(
                    points[:-1], hourly, spy_date, regime_label,
                    adr_5d=adr_5d, adr_20d=adr_20d,
                    alignment_score=_align_score, alignment_detail=_align_detail,
                )
                output['day_quality'] = {'grade': day_grade, 'scores': scores}
            output['vol_regime'] = _classify_vol_regime(points, atr_current)

        output['symbols'][symbol] = {
            'date':    datetime.fromtimestamp(today_ts, tz=timezone.utc).strftime('%Y-%m-%d'),
            'open':    round(today_ohlcv['open'],  2),
            'high':    round(today_ohlcv['high'],  2),
            'low':     round(today_ohlcv['low'],   2),
            'close':   round(today_ohlcv['close'], 2),
            'volume':  today_ohlcv['volume'],
            'volume_above_20d': today_ohlcv['volume'] > vol_20d_avg if vol_20d_avg > 0 else False,
            'atr_14':  round(atr_current, 2),
            'atr_20d_avg': round(atr_20day_avg, 2),
            'atr_above_avg': pm_range_active,
            'rsi_14':  round(rsi_current, 1),
            'macd_line':      round(macd_line_val, 4),
            'macd_signal':    round(macd_signal_val, 4),
            'macd_histogram': round(macd_line_val - macd_signal_val, 4),
            'ma_20': round(ma20_current, 2),
            'above_ma_20': today_ohlcv['close'] > ma20_current,
            'gap_pct': gap['gap_pct'], 'gap_type': gap['gap_type'],
            'gap_significant': gap['gap_significant'], 'gap_strong': gap['gap_strong'],
            'median_overnight_gap': gap.get('median_overnight_gap'),
            'outside_day': outside_day, 'outside_day_direction': outside_day_dir,
            'patterns': {
                'orb_qualified': orb_qualified,
                'gap_fill_candidate':         gap['gap_significant'] and gap['gap_type'] != 'none',
                'gap_continuation_candidate': gap['gap_strong']      and gap['gap_type'] != 'none',
                'outside_day': outside_day,
            },
            'engulfing': engulfing, 'squeeze': squeeze, 'vwap': vwap, 'rsi_divergence': rsi_div,
            'eod_outcome': eod_outcome,
            'adr_20d': adr_20d, 'adr_5d': adr_5d, 'prev_range': prev_range,
            'premarket': {
                'high':  round(max(b[1]['high'] for b in pm_bars_sym), 2) if pm_bars_sym else None,
                'low':   round(min(b[1]['low']  for b in pm_bars_sym), 2) if pm_bars_sym else None,
                'close': round(pm_bars_sym[-1][1]['close'], 2)             if pm_bars_sym else None,
            },
            'last_hour': {
                'high':  round(max(b[1]['high'] for b in lh_bars_sym), 2) if lh_bars_sym else None,
                'low':   round(min(b[1]['low']  for b in lh_bars_sym), 2) if lh_bars_sym else None,
                'close': round(lh_bars_sym[-1][1]['close'], 2)             if lh_bars_sym else None,
            },
        }

        # Active patterns (same logic as original)
        orb_has_levels = orb_qualified and opening_range > 0
        orb_watch = (not orb_has_levels) and output['regime'].get('label') == 'Trending' and pm_range_active

        gap_pattern_name = gap_direction = gap_notes = gap_levels = None
        if gap['gap_significant'] and gap['gap_type'] != 'none':
            market_regime = output['regime'].get('label', 'Ranging')
            is_up_gap = gap['gap_type'] == 'up'
            prev_close_val = round(points[-2][1]['close'], 2)
            today_open_val = round(today_ohlcv['open'], 2)
            gap_pts_abs = abs(today_open_val - prev_close_val)
            mult = 1 if is_up_gap else -1
            ratio_str = f"{gap_pts_abs / sym_median_gap:.1f}× median" if sym_median_gap else ""
            if gap['gap_strong'] and market_regime == 'Trending':
                gap_pattern_name, gap_direction = 'Gap Continuation', gap['gap_type']
                gap_notes  = f"Gap {gap['gap_pct']:+.2f}% · {gap_pts_abs:.2f} pts · {ratio_str} · Trending"
                gap_levels = {'prev_close': prev_close_val, 'today_open': today_open_val,
                              't1_continuation': round(today_open_val + 1.5 * atr_current * mult, 2),
                              't2_continuation': round(today_open_val + 2.0 * atr_current * mult, 2), 'atr': round(atr_current, 2)}
            else:
                gap_pattern_name, gap_direction = 'Gap Fill', ('down' if is_up_gap else 'up')
                gap_notes  = f"Gap {gap['gap_pct']:+.2f}% · {gap_pts_abs:.2f} pts · {ratio_str} · {market_regime}"
                gap_levels = {'prev_close': prev_close_val, 'today_open': today_open_val, 'fill_target': prev_close_val,
                              't1_continuation': round(today_open_val + 1.5 * atr_current * mult, 2), 'atr': round(atr_current, 2)}

        if orb_has_levels:
            orb_h = eod_outcome.get('orb_high') or 0.0
            orb_l = eod_outcome.get('orb_low')  or 0.0
            orb_levels = {
                'orb_high': eod_outcome.get('orb_high'), 'orb_low': eod_outcome.get('orb_low'),
                't1_up':   round(orb_h + 1.5 * atr_current, 2) if orb_h else None,
                't1_down': round(orb_l - 1.5 * atr_current, 2) if orb_l else None,
                't2_up':   round(orb_h + 2.0 * atr_current, 2) if orb_h else None,
                't2_down': round(orb_l - 2.0 * atr_current, 2) if orb_l else None,
                'atr': round(atr_current, 2),
            }
            if gap_levels:
                orb_levels.update({k: v for k, v in gap_levels.items() if k not in orb_levels})
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': f"ORB + {gap_pattern_name}" if gap_pattern_name else 'ORB',
                'direction': gap_direction if gap_pattern_name else 'watch',
                'notes': f"Range {opening_range:.2f} · {gap_notes}" if gap_notes else f"ATR {atr_current:.2f} > avg {atr_20day_avg:.2f}",
                'levels': orb_levels,
                'outcome': {'next_day': False, 'breached': eod_outcome.get('orb_breached', False),
                            'direction': eod_outcome.get('orb_direction', 'none'),
                            'hit_t1': eod_outcome.get('orb_hit_t1', False), 'filled': eod_outcome.get('gap_filled', False)},
            })
        elif orb_watch and gap_pattern_name:
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': f"ORB + {gap_pattern_name}", 'direction': gap_direction,
                'notes': f"Entry: ORB breakout · {gap_notes}",
                'levels': {**gap_levels, 'entry': 'ORB breakout at open'},
                'outcome': {'next_day': False, 'filled': eod_outcome.get('gap_filled', False)},
            })
        elif orb_watch:
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': 'ORB', 'direction': 'watch',
                'notes': "Trending regime · PM range active · no gap", 'levels': {}, 'outcome': {},
            })
        elif gap_pattern_name:
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': gap_pattern_name, 'direction': gap_direction,
                'notes': gap_notes, 'levels': gap_levels,
                'outcome': {'next_day': False, 'filled': eod_outcome.get('gap_filled', False)},
            })

        if engulfing in ['bullish', 'bearish']:
            is_up = engulfing == 'bullish'
            mult  = 1 if is_up else -1
            entry = round(today_ohlcv['high'] if is_up else today_ohlcv['low'], 2)
            stop  = round(today_ohlcv['low']  if is_up else today_ohlcv['high'], 2)
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': 'Engulfing', 'direction': 'up' if is_up else 'down',
                'notes': f"{'Bullish' if is_up else 'Bearish'} engulfing, vol confirmed",
                'levels': {'entry': entry, 'stop': stop,
                           't1': round(entry + 1.5 * atr_current * mult, 2),
                           't2': round(entry + 2.0 * atr_current * mult, 2), 'atr': round(atr_current, 2)},
                'outcome': {'next_day': True, 'note': f"Enter {'above' if is_up else 'below'} ${entry:.2f} next session"},
            })

        if outside_day:
            is_up = outside_day_dir == 'up'
            mult  = 1 if is_up else -1
            entry = round(today_ohlcv['high'] if is_up else today_ohlcv['low'], 2)
            stop  = round(today_ohlcv['low']  if is_up else today_ohlcv['high'], 2)
            od_range = today_ohlcv['high'] - today_ohlcv['low']
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': 'Outside Day', 'direction': outside_day_dir,
                'notes': f"Close {'upper' if is_up else 'lower'} 25%: {today_ohlcv['close']:.2f}",
                'levels': {'entry': entry, 'stop': stop,
                           't1': round(entry + 1.5 * od_range * mult, 2),
                           'range_size': round(od_range, 2), 'atr': round(atr_current, 2)},
                'outcome': {'next_day': True, 'note': f"Enter {'above' if is_up else 'below'} ${entry:.2f} next session"},
            })

    spy_pts  = daily_data.get('SPY', [])
    data_date = datetime.fromtimestamp(spy_pts[-1][0], tz=timezone.utc).date() if spy_pts else now_utc.date()

    dated_path = cache_dir / f"trading_signals_{data_date.isoformat()}.json"
    with open(dated_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"✓ {len(output['symbols'])} symbols, {len(output['active_patterns'])} patterns → {dated_path}")

    if target_date is None:
        canon = cache_dir / 'trading_signals.json'
        with open(canon, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"✓ Canonical → {canon}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default=None)
    args = parser.parse_args()
    from datetime import date as date_cls
    td = datetime.strptime(args.date, '%Y-%m-%d').date() if args.date else None
    TradingGenerator().generate(target_date=td)
