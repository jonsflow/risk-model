"""
pipeline/generators/trading_generator.py — Trading signals cache generator.

Replaces generate_trading_cache.py.
Reads OHLCV from SQLite; writes data/cache/trading_signals.json.
The premarket (9 AM ET) run and post-close (4:15 PM ET) run both write to
this same file. Which one produced it is stated explicitly in `phase`
("premarket" / "intraday" / "eod") and `session_complete` — consumers must
read those rather than inferring completeness from field shapes.

Completeness is a property of the data, not of the clock. The fetcher stamps
every daily bar with is_complete (collected_at >= that session's close), so:
  * _completed_bars() filters on that flag. Anything treating a bar as a
    finished session — ATR, MA, pivots, day classification — reads through it.
    A partial bar is never in the list, so no run can accidentally analyse one.
  * eod_outcome and day_realized are withheld until the session's own bar is
    marked complete. A late-firing morning run therefore cannot publish a
    half-finished day as a final result.
  * Dated history files are written only for finished sessions.

No timezone conversion happens in this module for daily bars — session identity
comes from the stored session_date. Intraday window questions (ORB, last hour)
go through pipeline/market_time.py.

day_quality is always the pre-open forecast. day_realized (EOD only) records
what the session actually delivered, so the two can be compared over time.
"""

import json
import math
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path
from pipeline.base_generator import BaseGenerator
from pipeline.analysis import find_pivot_highs, find_pivot_lows
from pipeline.market_time import (
    bar_clock, bar_minutes, bar_session_date, in_session_window,
    parse_session_date, session_close_utc, session_open_utc,
)

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
    # Regime → favoured patterns is the single source of truth for "does this
    # setup fit today's tape". The generator stamps the verdict; the page renders
    # it. `patterns` are keys (matched on), `note` is prose (displayed only).
    #
    # Fail loudly rather than defaulting to {}. An empty mapping scores every
    # setup as off-regime, which reads as a plausible page rather than an
    # outage — the same silent-wrong-answer failure this block was built to end.
    regimes = config.get("regimes")
    if not regimes:
        raise ValueError("trading_config.json has no `regimes` block")
    return trading_symbols, regime_symbols, ticker_map, regimes


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
    """Filter bars to a market-local session window (930 = 09:30 ET), so
    RTH-anchored filters (ORB, VWAP session, last hour) hit the intended bars
    regardless of DST. Timezone handling lives in market_time."""
    if not hourly_points:
        return []
    if target_date is None:
        target_date = bar_session_date(hourly_points[-1][0])
    return [(ts, ohlcv) for ts, ohlcv in hourly_points
            if in_session_window(ts, start_hhmm, end_hhmm, target_date)]


def _get_overnight_bars(bars, target_date):
    """Bars from the prior trading day's 16:00 ET close through target_date 09:30 ET.
    Walks back up to 7 calendar days to find the prior trading day, so this handles
    weekends and holidays."""
    if not bars or target_date is None:
        return []
    upper = session_open_utc(target_date).timestamp()
    prior_date = None
    for d in range(1, 8):
        candidate = target_date - timedelta(days=d)
        has_close_bars = any(
            bar_session_date(ts) == candidate and bar_minutes(ts) >= 1600
            for ts, _ in bars
        )
        if has_close_bars:
            prior_date = candidate
            break
    if prior_date is None:
        return []
    lower = session_close_utc(prior_date).timestamp()
    result = [(ts, ohlcv) for ts, ohlcv in bars if lower <= ts < upper]
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


_RTH_OPEN_HHMM = 930


def _bar_date(point):
    """Session a daily bar belongs to. Read from the stored session_date, which
    the fetcher sets — no timezone interpretation happens here."""
    sd = point[1].get('session_date')
    if sd:
        return parse_session_date(sd)
    return datetime.fromtimestamp(point[0], tz=timezone.utc).date()


def _completed_bars(points):
    """Bars whose session had closed when they were fetched.

    Completeness is stamped at ingest, so this needs no clock, no timezone, and
    no assumption about which run is executing. A partial bar simply isn't here.
    """
    return [p for p in points if p[1].get('is_complete')]


def _prior_bars(points, session_date):
    """Completed bars from sessions before session_date — the history a pre-open
    call is allowed to see."""
    completed = _completed_bars(points)
    if session_date is None:
        return completed
    return [p for p in completed if _bar_date(p) < session_date]


def _session_bar(points, session_date):
    """The daily bar for session_date, or None if it doesn't exist yet."""
    if session_date is None:
        return points[-1][1] if points else None
    for p in reversed(points):
        if _bar_date(p) == session_date:
            return p[1]
    return None


def _is_session_complete(points, session_date):
    """Has session_date's bar been fetched after that session closed?"""
    bar = _session_bar(points, session_date)
    return bool(bar and bar.get('is_complete'))


def _determine_phase(points, bars_5m, session_date):
    """'premarket' | 'intraday' | 'eod' for the session being reported.

    'eod' comes from the data itself — the session's bar is marked complete.
    The premarket/intraday split is only about display, and is answered by
    whether any regular-hours bar exists yet.
    """
    if session_date is None:
        return 'premarket'
    if _is_session_complete(points, session_date):
        return 'eod'
    for ts, _ in bars_5m or []:
        if bar_session_date(ts) == session_date and bar_minutes(ts) >= _RTH_OPEN_HHMM:
            return 'intraday'
    return 'premarket'


def _classify_day_type(points):
    """Classify the most recent completed bar's range vs the prior bar.

    'inside'  — range fully contained in the prior bar (compression / coil).
    'outside' — range engulfs the prior bar on both sides (expansion).
    'normal'  — neither (ordinary higher/lower bar). Direction is intentionally
    not distinguished here; candle-pattern refinement comes later.
    """
    if len(points) < 2:
        return 'normal'
    today, prev = points[-1][1], points[-2][1]
    if today['high'] <= prev['high'] and today['low'] >= prev['low']:
        return 'inside'
    if today['high'] > prev['high'] and today['low'] < prev['low']:
        return 'outside'
    return 'normal'


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
        if 800 <= bar_minutes(ts) < 930:
            pm_by_date.setdefault(bar_session_date(ts), []).append(ohlcv)
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


def _load_vix(vix_daily, session_date, session_complete) -> dict:
    """VIX level and its 20-day average, from the Yahoo daily bars in SQLite.

    VIX comes down the Yahoo path with every other price on this page — it is
    already in the fetch list via config/macro_config.json — rather than out of
    FRED. This previously read data/fred/VIXCLS.csv, deleted along with the other
    per-series CSVs, and so returned None on every run; the VIX row silently
    vanished from Step 1.

    Phase contract applies: before the close, only bars from prior sessions.
    """
    bars = _completed_bars(vix_daily) if session_complete else _prior_bars(vix_daily, session_date)
    # Never read past the session being reported. VIX is fetched independently of
    # the trading symbols, so it can be a session ahead of them — a backfill run
    # for an old date especially.
    if session_date:
        bars = [b for b in bars if _bar_date(b) <= session_date]
    closes = [b[1]['close'] for b in bars if b[1].get('close') is not None]
    if not closes:
        return None

    current = closes[-1]
    avg_20d = sum(closes[-20:]) / min(20, len(closes))
    return {'current': round(current, 2), 'avg_20d': round(avg_20d, 2),
            'ratio': round(current / avg_20d, 2) if avg_20d else None,
            'as_of': _bar_date(bars[-1]).isoformat()}


def _compute_alignment_score(regime_symbols, hourly_data, target_date) -> tuple:
    """Score whether the regime symbols (SPY/QQQ/IWM) moved the same direction
    today. Uses today's RTH session bars only — before this filter the function
    took the first→last bar of the whole ~30-day hourly window and reported
    the monthly trend, which is not what "today's index alignment" means.
    """
    directions = {}
    for sym in regime_symbols:
        h = hourly_data.get(sym, [])
        session = _get_session_bars(h, 930, 1600, target_date=target_date) if h else []
        if len(session) >= 2:
            chg = (session[-1][1]['close'] - session[0][1]['close']) / session[0][1]['close']
            directions[sym] = 'up' if chg > 0.005 else 'down' if chg < -0.005 else 'flat'
    non_flat = [d for d in directions.values() if d != 'flat']
    if not non_flat:
        score = 1
    else:
        majority = max(set(non_flat), key=non_flat.count)
        agree = non_flat.count(majority)
        score = 2 if agree == len(non_flat) else (1 if agree >= 2 else 0)
    return score, directions


def _compute_expansion_evidence(points, bars_5m, session_date, session_complete):
    """Is the tape expanding? Answered from whatever is legitimately known at
    this phase — realized range once the session is done, premarket range and
    gap size before it. ATR-14 alone can't answer this: it's a 14-day average,
    so it still reads "contracting" on a day that doubles its recent range.
    """
    prior = _prior_bars(points, session_date)
    atr_vals = _calculate_atr(prior, 14)
    atr = atr_vals[-1][1] if atr_vals else 0.0

    if session_complete:
        bar = _session_bar(points, session_date)
        if bar and atr > 0:
            mult = (bar['high'] - bar['low']) / atr
            return {'expanding': mult >= 1.0, 'basis': 'realized_range',
                    'atr_multiple': round(mult, 2)}
        return {'expanding': False, 'basis': 'no_data', 'atr_multiple': None}

    pm = _compute_premarket_metrics(bars_5m, session_date)
    pm_ratio = pm['range'].get('ratio') if pm.get('has_range') else None

    gap_ratio = None
    if prior:
        prior_close = prior[-1][1]['close']
        hist_gaps = [abs(prior[i][1]['open'] - prior[i-1][1]['close'])
                     for i in range(max(1, len(prior) - 20), len(prior))]
        median_gap = statistics.median(hist_gaps) if hist_gaps else 0.0
        est_open = _estimate_open(bars_5m, session_date)
        if est_open is not None and median_gap > 0:
            gap_ratio = round(abs(est_open - prior_close) / median_gap, 2)

    expanding = (pm_ratio is not None and pm_ratio >= 1.0) or \
                (gap_ratio is not None and gap_ratio >= 1.5)
    return {'expanding': expanding, 'basis': 'premarket',
            'pm_range_ratio': pm_ratio, 'gap_ratio': gap_ratio}


def _estimate_open(bars_5m, session_date):
    """Session open if RTH has started, else the last premarket print."""
    if not bars_5m or session_date is None:
        return None
    last_pm = None
    for ts, ohlcv in bars_5m:
        if bar_session_date(ts) != session_date:
            continue
        hhmm = bar_minutes(ts)
        if hhmm == _RTH_OPEN_HHMM:
            return ohlcv['open']
        if hhmm < _RTH_OPEN_HHMM:
            last_pm = ohlcv['close']
    return last_pm


def _grade_day_quality(points, hourly_points, target_date, regime_label,
                       adr_8d=None, adr_20d=None, alignment_score=1, alignment_detail=None):
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
        if bar_session_date(ts) == target_date and bar_minutes(ts) == 930:
            est_open = ohlcv['open']
            break
    if est_open is None:
        for ts, ohlcv in hourly_points:
            if bar_session_date(ts) == target_date:
                est_open = ohlcv['open']
                break
    gap_pts   = abs(est_open - prior_close) if est_open is not None else 0.0
    gap_ratio = round(gap_pts / median_gap, 2) if median_gap > 0 else 0.0
    has_gap   = gap_ratio >= 0.5
    gap_range_score = 2 if (has_gap and has_pm_range) else 1 if (has_gap or has_pm_range) else 0

    # Factor 2: Structure
    structure_score = {'Trending': 2, 'Ranging': 1, 'Choppy': 0}.get(regime_label, 1)
    day_type = _classify_day_type(points)

    # Factor 3: Intraday range trend (8d vs 20d high-low, gap-excluded). The
    # overnight gap is scored separately in gap_range, so this factor isolates
    # intraday follow-through — a gap day with a tight tape reads as compressed.
    # The 8-day recent window (~two weeks) tracks the current regime more closely
    # than a 5-day window while staying less noisy.
    adr_ratio = (adr_8d / adr_20d) if (adr_8d and adr_20d) else 1.0
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
        'structure': {'score': structure_score, 'regime': regime_label, 'day_type': day_type},
        'adr': {'score': adr_score, 'adr_8d': adr_8d, 'adr_20d': adr_20d, 'ratio': round(adr_ratio, 2)},
        'alignment': {'score': alignment_score, 'detail': alignment_detail or {}},
        'has_data': pm.get('has_data', False),
    }
    return grade, scores


def _grade_realized(points, session_date, eod_outcome, forecast_grade, forecast_total):
    """What the session actually delivered, scored on the same 0-8 scale as the
    pre-open forecast so the two are directly comparable. EOD only — this is the
    one block allowed to look at the session it describes.
    """
    bar = _session_bar(points, session_date)
    if not bar:
        return {}
    prior = _prior_bars(points, session_date)
    atr_vals = _calculate_atr(prior, 14)
    atr = atr_vals[-1][1] if atr_vals else 0.0
    rng = bar['high'] - bar['low']
    atr_multiple = round(rng / atr, 2) if atr > 0 else None

    # Where the close landed in the day's range: 1.0 = on the high, 0 = on the low.
    close_loc = round((bar['close'] - bar['low']) / rng, 2) if rng > 0 else 0.5
    # A trend day both expands and closes near an extreme — the profile that
    # actually pays, and the one the "Choppy" label was suppressing.
    trend_day = bool(atr_multiple and atr_multiple >= 1.0 and (close_loc >= 0.75 or close_loc <= 0.25))

    if atr_multiple is None:      expansion = 'unknown'
    elif atr_multiple >= 1.25:    expansion = 'expansion'
    elif atr_multiple >= 0.75:    expansion = 'normal'
    else:                         expansion = 'compression'

    range_score = 3 if (atr_multiple or 0) >= 1.25 else 2 if (atr_multiple or 0) >= 1.0 \
        else 1 if (atr_multiple or 0) >= 0.75 else 0
    direction_score = 2 if trend_day else 1 if (close_loc >= 0.65 or close_loc <= 0.35) else 0
    follow_score = (1 if eod_outcome.get('orb_breached') else 0) + \
                   (1 if eod_outcome.get('orb_hit_t1') else 0) + \
                   (1 if eod_outcome.get('gap_filled') else 0)
    total = range_score + direction_score + follow_score
    grade = 'A+' if total >= 7 else 'A' if total >= 5 else 'B' if total >= 3 else 'C'

    if trend_day:                       verdict = 'Trend day — directional follow-through'
    elif expansion == 'expansion':      verdict = 'Wide range, no clean direction'
    elif expansion == 'compression':    verdict = 'Compressed — little to trade'
    else:                               verdict = 'Ordinary range day'

    return {
        'grade': grade, 'total': total, 'max': 8,
        'range': round(rng, 2),
        'range_pct': round(rng / bar['low'] * 100, 2) if bar['low'] else None,
        'atr_multiple': atr_multiple,
        'expansion': expansion,
        'close_location': close_loc,
        'trend_day': trend_day,
        'day_type': _classify_day_type([p for p in points if _bar_date(p) <= session_date]
                                       if session_date else points),
        'orb_breached': bool(eod_outcome.get('orb_breached')),
        'orb_hit_t1':   bool(eod_outcome.get('orb_hit_t1')),
        'gap_filled':   bool(eod_outcome.get('gap_filled')),
        'scores': {'range': range_score, 'direction': direction_score, 'follow_through': follow_score},
        'forecast_grade': forecast_grade, 'forecast_total': forecast_total,
        'verdict': verdict,
    }


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


def _detect_regime(symbols, daily_data, hourly_data, session_date=None,
                   session_complete=False, expansion=None, regime_config=None):
    # Index divergence sets the alignment flag only — it no longer forces "Choppy".
    # The penalty for divergence is already applied separately via _compute_alignment_score.
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
    index_alignment = 'aligned' if aligned else 'diverging'

    # Always derive structure from SPY's MA20 position + slope. Anchored to the
    # last *completed* session so the label doesn't flip between the morning and
    # post-close runs just because Yahoo opened today's bar in between.
    label, direction = 'Ranging', 'sideways'
    spy_points = _completed_bars(daily_data.get('SPY', []))
    if len(spy_points) >= 20:
        ma20 = _calculate_moving_average(spy_points, 20)
        if len(ma20) >= 10:
            ma20_now = ma20[-1][1]
            ma20_ten = ma20[-10][1]
            close = spy_points[-1][1]['close']
            if close > ma20_now and ma20_now > ma20_ten: label, direction = 'Trending', 'up'
            elif close < ma20_now and ma20_now < ma20_ten: label, direction = 'Trending', 'down'

    # Always compute ATR trend (expanding / contracting / normal).
    atr_trend = 'normal'
    if spy_points:
        atr_vals = _calculate_atr(spy_points, 14)
        if len(atr_vals) >= 20:
            atr_now = atr_vals[-1][1]
            atr_avg = sum(a[1] for a in atr_vals[-20:]) / 20
            if atr_now > atr_avg * 1.1:   atr_trend = 'expanding'
            elif atr_now < atr_avg * 0.9: atr_trend = 'contracting'

    # Structure of the last completed bar. spy_points is already trimmed to
    # completed sessions, so [-1] is the right bar in every phase.
    day_type = _classify_day_type(spy_points) if len(spy_points) >= 3 else 'normal'

    # "Choppy" means a genuinely sideways tape with a shrinking range — not
    # merely that ATR-14, a two-week average, is below its own 20-day mean. Any
    # live evidence of expansion (an outside bar, a wide premarket, an outsized
    # gap, or a realized range >= 1x ATR) disqualifies the chop label.
    expanding = bool(expansion and expansion.get('expanding'))
    if label == 'Ranging' and atr_trend == 'contracting' \
            and day_type != 'outside' and not expanding:
        label, direction = 'Choppy', 'mixed'

    favored = (regime_config or {}).get(label, {})
    return {'label': label, 'direction': direction, 'atr_trend': atr_trend,
            'index_alignment': index_alignment, 'day_type': day_type,
            'expansion': expansion or {},
            'favored': {'patterns': list(favored.get('patterns', [])),
                        'note': favored.get('note', '')}}


def _pattern_keys(keys, favored_patterns):
    """Stamp a pattern with its component keys and whether they fit the regime.

    Keys are composed from what the generator actually built, so the page never
    has to parse the display string — that string-matching is exactly what let
    'Engulfing at S/R' silently fail to match the emitted 'Engulfing'.
    """
    return {'keys': list(keys),
            'regime_match': bool(set(keys) & set(favored_patterns or []))}


def _resolve_prior_setups(daily_points):
    """Detect Engulfing/Outside Day setups on the second-to-last bar and resolve
    against the last bar's high/low. `points[-2]` fires the setup, `points[-1]`
    is the execution session ("next session" from the setup's perspective).

    Emits per-pattern: entry, stop, t1, (t2), triggered, stop_hit, hit_t1, hit_t2.
    Returns [] if there aren't enough bars or no next-day pattern fired.
    """
    if len(daily_points) < 3:
        return []
    prior_slice   = daily_points[:-1]
    setup_bar     = daily_points[-2][1]
    execution_bar = daily_points[-1][1]

    prior_atr_vals = _calculate_atr(prior_slice, 14)
    prior_atr = prior_atr_vals[-1][1] if prior_atr_vals else 0.0
    prior_vols = [p[1]['volume'] for p in prior_slice[-20:]]
    prior_vol_20d = sum(prior_vols) / len(prior_vols) if prior_vols else 0

    resolutions = []

    def _resolve(is_up, entry, stop, t1, t2=None):
        hi, lo = execution_bar['high'], execution_bar['low']
        triggered = (hi >= entry) if is_up else (lo <= entry)
        stop_hit  = triggered and ((lo <= stop) if is_up else (hi >= stop))
        hit_t1    = triggered and ((hi >= t1) if is_up else (lo <= t1))
        hit_t2    = triggered and (t2 is not None) and ((hi >= t2) if is_up else (lo <= t2))
        return {'triggered': triggered, 'stop_hit': stop_hit, 'hit_t1': hit_t1, 'hit_t2': hit_t2}

    eng = _detect_engulfing(prior_slice, prior_vol_20d)
    if eng in ['bullish', 'bearish'] and prior_atr > 0:
        is_up = eng == 'bullish'
        mult  = 1 if is_up else -1
        entry = round(setup_bar['high'] if is_up else setup_bar['low'], 2)
        stop  = round(setup_bar['low']  if is_up else setup_bar['high'], 2)
        t1    = round(entry + 1.5 * prior_atr * mult, 2)
        t2    = round(entry + 2.0 * prior_atr * mult, 2)
        resolutions.append({
            'pattern': 'Engulfing', 'direction': 'up' if is_up else 'down',
            'entry': entry, 'stop': stop, 't1': t1, 't2': t2,
            **_resolve(is_up, entry, stop, t1, t2),
        })

    od = _detect_outside_day(prior_slice)
    if od in ['up', 'down']:
        is_up = od == 'up'
        mult  = 1 if is_up else -1
        entry = round(setup_bar['high'] if is_up else setup_bar['low'], 2)
        stop  = round(setup_bar['low']  if is_up else setup_bar['high'], 2)
        od_range = setup_bar['high'] - setup_bar['low']
        t1    = round(entry + 1.5 * od_range * mult, 2)
        resolutions.append({
            'pattern': 'Outside Day', 'direction': 'up' if is_up else 'down',
            'entry': entry, 'stop': stop, 't1': t1,
            **_resolve(is_up, entry, stop, t1),
        })

    return resolutions


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
    trading_symbols, regime_symbols, _, regime_config = _load_config()
    symbols = trading_symbols
    if not symbols:
        raise ValueError("No trading symbols in trading_config.json")

    print(f"Generating trading signals for {len(symbols)} symbols...")
    now_utc = datetime.now(timezone.utc)

    daily_data:   dict = {s: db.load_daily_ohlcv(s)  for s in symbols}
    hourly_data:  dict = {s: db.load_hourly_ohlcv(s) for s in symbols}
    five_min_data: dict = {s: db.load_5m_ohlcv(s)   for s in symbols}

    if target_date:
        target_ts   = int(datetime(target_date.year, target_date.month, target_date.day, tzinfo=timezone.utc).timestamp())
        next_day_ts = target_ts + 86400
        for s in symbols:
            daily_data[s]    = [p for p in daily_data[s]    if p[0] <= target_ts]
            hourly_data[s]   = [p for p in hourly_data[s]   if p[0] < next_day_ts]
            five_min_data[s] = [p for p in five_min_data[s] if p[0] < next_day_ts]

    spy_last = daily_data.get('SPY', [])
    data_day = datetime.fromtimestamp(spy_last[-1][0], tz=timezone.utc).date() if spy_last else now_utc.date()
    is_weekend = data_day.weekday() >= 5

    output = {
        'generated': now_utc.isoformat(),
        'market_closed': is_weekend,
        'day_quality': {},
        'day_realized': {},
        'regime': {},
        'symbols': {},
        'active_patterns': [],
    }

    def bar_time(bars, idx):
        if not bars: return None
        return bar_clock(bars[idx][0])

    spy_hourly = hourly_data.get('SPY', [])
    spy_5m     = five_min_data.get('SPY', [])
    spy_daily  = daily_data.get('SPY', [])
    daily_latest  = datetime.fromtimestamp(spy_daily[-1][0], tz=timezone.utc).date() if spy_daily else None
    intra_latest  = bar_session_date(spy_5m[-1][0]) if spy_5m else (
                    bar_session_date(spy_hourly[-1][0]) if spy_hourly else None)
    spy_date = intra_latest if (intra_latest and daily_latest and intra_latest > daily_latest) else daily_latest

    pm_bars   = _get_session_bars(spy_5m, 800,  930,  target_date=spy_date)
    orb_bars  = _get_session_bars(spy_5m, 930,  1030, target_date=spy_date)
    sess_bars = _get_session_bars(spy_5m, 930,  1600, target_date=spy_date)
    lh_bars   = _get_session_bars(spy_5m, 1500, 1600, target_date=spy_date)

    output['windows'] = {
        'premarket':     {'from': bar_time(pm_bars,   0),  'to': bar_time(pm_bars,   -1)},
        'opening_range': {'from': bar_time(orb_bars,  0),  'to': bar_time(orb_bars,  -1)},
        'session':       {'from': bar_time(sess_bars, 0),  'to': bar_time(sess_bars, -1)},
        'last_hour':     {'from': bar_time(lh_bars,   0),  'to': bar_time(lh_bars,   -1)},
    }

    # Frontend uses this to fetch data/cache/intraday/{SYM}_{session_date}.json.
    output['session_date'] = spy_date.isoformat() if spy_date else None

    # Stated explicitly rather than inferred downstream: consumers used to guess
    # completeness from whether eod_outcome was populated, which reads a partial
    # intraday bar as a finished session.
    phase = _determine_phase(spy_daily, spy_5m, spy_date)
    session_complete = (phase == 'eod')
    output['phase'] = phase
    output['session_complete'] = session_complete

    expansion = _compute_expansion_evidence(spy_daily, spy_5m, spy_date, session_complete)
    output['regime'] = _detect_regime(regime_symbols, daily_data, hourly_data,
                                      session_date=spy_date,
                                      session_complete=session_complete,
                                      expansion=expansion,
                                      regime_config=regime_config)
    output['vix']    = _load_vix(db.load_daily_ohlcv('VIX'), spy_date, session_complete)

    _align_score, _align_detail = _compute_alignment_score(regime_symbols, hourly_data, spy_date)

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
        bars_5m = five_min_data.get(symbol, [])
        today_date = datetime.fromtimestamp(today_ts, tz=timezone.utc).date()
        pm_bars_sym  = _get_session_bars(bars_5m, 800,  930,  target_date=today_date) if bars_5m else []
        lh_bars_sym  = _get_session_bars(bars_5m, 1500, 1600, target_date=today_date) if bars_5m else []

        pm_sym = _compute_premarket_metrics(bars_5m, today_date) if bars_5m else None
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
        _orb_bars     = _get_session_bars(bars_5m, 930, 1030, target_date=today_date) if bars_5m else []
        opening_range = (max(b[1]['high'] for b in _orb_bars) - min(b[1]['low'] for b in _orb_bars)) if _orb_bars else 0.0
        orb_qualified = opening_range > 0.75 * atr_20day_avg if atr_20day_avg else False
        # Suppressed until the session is actually over. Computing this on a
        # partial bar produces a plausible-looking but wrong "final" result.
        eod_outcome   = _calculate_eod_outcomes(points, bars_5m, gap, atr_current) \
                        if session_complete else {}
        engulfing       = _detect_engulfing(points, vol_20d_avg)
        squeeze         = _calculate_squeeze(hourly) if hourly else {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}
        vwap            = _calculate_vwap(bars_5m) if bars_5m else {'vwap': None, 'above_vwap': None, 'distance_pct': None}
        rsi_div         = _calculate_rsi_divergence(hourly) if hourly else {'signal': 'unknown', 'description': 'No hourly data'}

        # ADR: average daily range on prior complete bars only (date-anchored —
        # points[:-1] drops a real prior session whenever today's bar is absent).
        _prior = _prior_bars(points, spy_date)
        _ranges = [p[1]['high'] - p[1]['low'] for p in _prior if p[1]['high'] and p[1]['low']]
        adr_20d    = round(sum(_ranges[-20:]) / min(20, len(_ranges)), 2) if _ranges else None
        adr_8d     = round(sum(_ranges[-8:])  / min(8,  len(_ranges)), 2) if _ranges else None
        prev_range = round(_ranges[-1], 2) if _ranges else None

        if symbol == 'SPY':
            if is_weekend:
                output['day_quality'] = {'grade': 'N/A', 'scores': {}}
            else:
                regime_label = output['regime'].get('label', 'Ranging')
                # Pre-open forecast: prior sessions only, in every phase.
                day_grade, scores = _grade_day_quality(
                    _prior_bars(points, spy_date), bars_5m, spy_date, regime_label,
                    adr_8d=adr_8d, adr_20d=adr_20d,
                    alignment_score=_align_score, alignment_detail=_align_detail,
                )
                output['day_quality'] = {'grade': day_grade, 'scores': scores}
                output['day_realized'] = _grade_realized(
                    points, spy_date, eod_outcome, day_grade, scores.get('total'),
                ) if session_complete else {}
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
            # Resolve against completed bars only — otherwise a setup gets marked
            # hit/stopped against a session that is still running.
            'prior_setups': _resolve_prior_setups(_completed_bars(points)),
            'adr_20d': adr_20d, 'adr_8d': adr_8d, 'prev_range': prev_range,
            'day_type': _classify_day_type(_completed_bars(points)),
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
        orb_has_levels = orb_qualified and (opening_range or 0) > 0
        orb_watch = (not orb_has_levels) and output['regime'].get('label') == 'Trending' and pm_range_active

        favored_patterns = output['regime'].get('favored', {}).get('patterns', [])
        gap_pattern_name = gap_direction = gap_notes = gap_levels = None
        gap_key = None
        gap_continuation_hits = {}
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
                gap_key = 'gap_continuation'
                gap_notes  = f"Gap {gap['gap_pct']:+.2f}% · {gap_pts_abs:.2f} pts · {ratio_str} · Trending"
                t1_cont = round(today_open_val + 1.5 * atr_current * mult, 2)
                t2_cont = round(today_open_val + 2.0 * atr_current * mult, 2)
                gap_levels = {'prev_close': prev_close_val, 'today_open': today_open_val,
                              't1_continuation': t1_cont, 't2_continuation': t2_cont,
                              'atr': round(atr_current, 2)}
                # Resolve continuation targets against today's session extremes.
                # Up gap: continuation up → check today's high. Down gap: check today's low.
                probe = today_ohlcv['high'] if is_up_gap else today_ohlcv['low']
                gap_continuation_hits = {
                    'hit_t1_continuation': (probe >= t1_cont) if is_up_gap else (probe <= t1_cont),
                    'hit_t2_continuation': (probe >= t2_cont) if is_up_gap else (probe <= t2_cont),
                }
            else:
                gap_pattern_name, gap_direction = 'Gap Fill', ('down' if is_up_gap else 'up')
                gap_key = 'gap_fill'
                gap_notes  = f"Gap {gap['gap_pct']:+.2f}% · {gap_pts_abs:.2f} pts · {ratio_str} · {market_regime}"
                gap_levels = {'prev_close': prev_close_val, 'today_open': today_open_val, 'fill_target': prev_close_val,
                              'atr': round(atr_current, 2)}

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
                            'hit_t1': eod_outcome.get('orb_hit_t1', False),
                            'filled': eod_outcome.get('gap_filled', False),
                            **gap_continuation_hits},
                **_pattern_keys(['orb'] + ([gap_key] if gap_key else []), favored_patterns),
            })
        elif orb_watch and gap_pattern_name:
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': f"ORB + {gap_pattern_name}", 'direction': gap_direction,
                'notes': f"Entry: ORB breakout · {gap_notes}",
                'levels': {**gap_levels, 'entry': 'ORB breakout at open'},
                'outcome': {'next_day': False, 'filled': eod_outcome.get('gap_filled', False),
                            **gap_continuation_hits},
                **_pattern_keys(['orb', gap_key], favored_patterns),
            })
        elif orb_watch:
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': 'ORB', 'direction': 'watch',
                'notes': "Trending regime · PM range active · no gap", 'levels': {},
                'outcome': {'no_trade': True, 'reason': 'Range < 0.75× ATR'},
                **_pattern_keys(['orb'], favored_patterns),
            })
        elif gap_pattern_name:
            output['active_patterns'].append({
                'symbol': symbol, 'pattern': gap_pattern_name, 'direction': gap_direction,
                'notes': gap_notes, 'levels': gap_levels,
                'outcome': {'next_day': False, 'filled': eod_outcome.get('gap_filled', False),
                            **gap_continuation_hits},
                **_pattern_keys([gap_key], favored_patterns),
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
                **_pattern_keys(['engulfing'], favored_patterns),
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
                **_pattern_keys(['outside_day'], favored_patterns),
            })

    data_date = spy_date or now_utc.date()

    # Dated history is written only for finished sessions. It's the record used
    # to score the model over time, so a mid-session snapshot must never land in
    # it — if the post-close run fails, the day is simply absent rather than
    # silently wrong.
    if session_complete:
        dated_path = cache_dir / f"trading_signals_{data_date.isoformat()}.json"
        with open(dated_path, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"✓ {len(output['symbols'])} symbols, {len(output['active_patterns'])} patterns → {dated_path}")
    else:
        print(f"✓ {len(output['symbols'])} symbols, {len(output['active_patterns'])} patterns "
              f"(phase={phase}; dated history withheld until session closes)")

    # The canonical file is always written so the live page reflects the latest
    # run, with `phase` telling the frontend what it's looking at.
    if target_date is None:
        canon = cache_dir / 'trading_signals.json'
        with open(canon, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"✓ Canonical → {canon}")

    _emit_intraday_bars(cache_dir, symbols, five_min_data, spy_date)


def _emit_intraday_bars(cache_dir, symbols, five_min_data, session_date):
    """Emit per-symbol 5m OHLCV for overnight (prior 16:00 ET → session 09:30 ET)
    and RTH day session (09:30 ET → 16:00 ET) as data/cache/intraday/{SYM}_{DATE}.json."""
    if session_date is None:
        return
    intraday_dir = cache_dir / 'intraday'
    intraday_dir.mkdir(parents=True, exist_ok=True)

    def _serialize(bar_list):
        out = []
        for ts, ohlcv in bar_list:
            out.append({
                'time':   ts,
                'open':   round(ohlcv['open'],  4),
                'high':   round(ohlcv['high'],  4),
                'low':    round(ohlcv['low'],   4),
                'close':  round(ohlcv['close'], 4),
                'volume': int(ohlcv.get('volume') or 0),
            })
        return out

    written = 0
    for symbol in symbols:
        bars = five_min_data.get(symbol) or []
        if not bars:
            continue
        overnight = _get_overnight_bars(bars, session_date)
        day       = _get_session_bars(bars, 930, 1600, target_date=session_date)
        if not overnight and not day:
            continue
        payload = {
            'symbol':    symbol,
            'date':      session_date.isoformat(),
            'overnight': _serialize(overnight),
            'day':       _serialize(day),
        }
        path = intraday_dir / f"{symbol}_{session_date.isoformat()}.json"
        with open(path, 'w') as f:
            json.dump(payload, f, separators=(',', ':'))
        written += 1
    print(f"✓ Intraday bars → {intraday_dir} ({written} files for {session_date.isoformat()})")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default=None)
    args = parser.parse_args()
    from datetime import date as date_cls
    td = datetime.strptime(args.date, '%Y-%m-%d').date() if args.date else None
    TradingGenerator().generate(target_date=td)
