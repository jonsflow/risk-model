#!/usr/bin/env python3
"""
Generate trading signals cache for daily rule-based analysis.

Reads full daily + hourly OHLCV history, computes trading indicators once,
and writes only the latest values to a single JSON file.

Output: data/cache/trading_signals.json

Computes:
- ATR(14), RSI(14), MACD(12,26,9)
- Volume averages (20/50 day)
- Gap detection (today's open vs prev close)
- Outside day detection
- Day quality grade (A+/A/B/C/F)
- Market regime (Trending/Ranging/Choppy)
- Active pattern flags (ORB, gaps, engulfing, outside day)

Uses stdlib only — no new dependencies beyond what fetch_data.py requires.
"""

import csv
import json
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path("data")
CACHE_DIR = DATA_DIR / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

def load_trading_config() -> tuple:
    """
    Load trading_config.json.
    Returns (trading_symbols, regime_symbols, ticker_map).
    """
    config_path = Path("trading_config.json")
    if not config_path.exists():
        raise FileNotFoundError("trading_config.json not found")

    with config_path.open() as f:
        config = json.load(f)

    trading_symbols = []
    regime_symbols = []
    ticker_map = {}

    for entry in config["symbols"]:
        symbol = entry["symbol"]
        trading_symbols.append(symbol)
        if entry.get("regime"):
            regime_symbols.append(symbol)
        if "ticker" in entry:
            ticker_map[symbol] = entry["ticker"]

    return trading_symbols, regime_symbols, ticker_map

# =============================================================================
# DATA LOADING
# =============================================================================

def load_daily_csv(symbol: str) -> list:
    """
    Read data/{symbol}.csv, return [(timestamp_secs, ohlcv_dict), ...]

    Returns list of tuples: (timestamp, {'open': float, 'high': float, 'low': float, 'close': float, 'volume': int})
    """
    path = DATA_DIR / f"{symbol.lower()}.csv"
    if not path.exists():
        return []

    points = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            date   = row.get('Date', '').strip()
            open_  = row.get('Open', '').strip()
            high   = row.get('High', '').strip()
            low    = row.get('Low', '').strip()
            close  = row.get('Close', '').strip()
            volume = row.get('Volume', '').strip()

            if not date or not close:
                continue

            try:
                t = int(datetime.strptime(date, '%Y-%m-%d')
                        .replace(tzinfo=timezone.utc).timestamp())
                ohlcv = {
                    'open': float(open_) if open_ else 0.0,
                    'high': float(high) if high else 0.0,
                    'low': float(low) if low else 0.0,
                    'close': float(close),
                    'volume': int(float(volume)) if volume else 0
                }
                points.append((t, ohlcv))
            except (ValueError, KeyError):
                continue

    points.sort(key=lambda x: x[0])
    return points

def load_hourly_csv(symbol: str) -> list:
    """
    Read data/{symbol}_hourly.csv for intraday analysis.
    Returns list of tuples: (timestamp, ohlcv_dict)
    """
    path = DATA_DIR / f"{symbol.lower()}_hourly.csv"
    if not path.exists():
        return []

    points = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            date_str = row.get('Date', '').strip()
            time_str = row.get('Time', '').strip()
            open_   = row.get('Open', '').strip()
            high    = row.get('High', '').strip()
            low     = row.get('Low', '').strip()
            close   = row.get('Close', '').strip()
            volume  = row.get('Volume', '').strip()

            if not date_str or not time_str or not close:
                continue

            try:
                dt_str = f"{date_str} {time_str}"
                t = int(datetime.strptime(dt_str, '%Y-%m-%d %H:%M:%S')
                        .replace(tzinfo=timezone.utc).timestamp())
                ohlcv = {
                    'open': float(open_) if open_ else 0.0,
                    'high': float(high) if high else 0.0,
                    'low': float(low) if low else 0.0,
                    'close': float(close),
                    'volume': int(float(volume)) if volume else 0
                }
                points.append((t, ohlcv))
            except (ValueError, KeyError):
                continue

    points.sort(key=lambda x: x[0])
    return points

# =============================================================================
# TECHNICAL INDICATORS
# =============================================================================

def calculate_atr(points: list, period: int = 14) -> list:
    """
    Calculate Average True Range.
    Returns [(timestamp, atr_value), ...]
    """
    if len(points) < period:
        return []

    atr_values = []
    true_ranges = []

    for i in range(len(points)):
        if i == 0:
            tr = points[i][1]['high'] - points[i][1]['low']
        else:
            prev_close = points[i-1][1]['close']
            h = points[i][1]['high']
            l = points[i][1]['low']
            tr = max(h - l, abs(h - prev_close), abs(l - prev_close))

        true_ranges.append(tr)

        # Calculate ATR once we have enough TR values
        if len(true_ranges) >= period:
            atr = sum(true_ranges[-period:]) / period
            atr_values.append((points[i][0], atr))

    return atr_values

def calculate_rsi(points: list, period: int = 14) -> list:
    """
    Calculate Relative Strength Index.
    Returns [(timestamp, rsi_value), ...]
    """
    if len(points) < period + 1:
        return []

    closes = [p[1]['close'] for p in points]
    rsi_values = []

    gains = []
    losses = []

    for i in range(1, len(closes)):
        change = closes[i] - closes[i-1]
        if change > 0:
            gains.append(change)
            losses.append(0)
        else:
            gains.append(0)
            losses.append(abs(change))

    # Need enough data for EMA calculation
    if len(gains) < period:
        return []

    # Calculate initial averages
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    # Calculate RSI with EMA
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        rs = avg_gain / avg_loss if avg_loss != 0 else 0
        rsi = 100 - (100 / (1 + rs)) if rs >= 0 else 0

        rsi_values.append((points[i + 1][0], rsi))

    return rsi_values

def calculate_macd(points: list, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    """
    Calculate MACD.
    Returns {'line': [(ts, value), ...], 'signal': [...], 'histogram': [...]}
    """
    if len(points) < slow + signal:
        return {'line': [], 'signal': [], 'histogram': []}

    closes = [p[1]['close'] for p in points]

    # Calculate EMAs
    ema_fast = _calculate_ema(closes, fast)
    ema_slow = _calculate_ema(closes, slow)

    # MACD line = fast EMA - slow EMA
    macd_line = []
    for i in range(len(ema_slow)):
        if i < len(ema_fast):
            macd_line.append(ema_fast[i] - ema_slow[i])

    # Signal line = EMA of MACD line
    signal_line = _calculate_ema(macd_line, signal) if len(macd_line) >= signal else []

    # Histogram = MACD - Signal
    histogram = []
    for i in range(len(signal_line)):
        if i < len(macd_line):
            histogram.append(macd_line[i] - signal_line[i])

    # Align timestamps
    result = {'line': [], 'signal': [], 'histogram': []}
    offset = len(points) - len(macd_line)
    for i, val in enumerate(macd_line):
        if i + offset < len(points):
            result['line'].append((points[i + offset][0], val))

    offset = len(points) - len(signal_line)
    for i, val in enumerate(signal_line):
        if i + offset < len(points):
            result['signal'].append((points[i + offset][0], val))

    offset = len(points) - len(histogram)
    for i, val in enumerate(histogram):
        if i + offset < len(points):
            result['histogram'].append((points[i + offset][0], val))

    return result

def _calculate_ema(values: list, period: int) -> list:
    """Helper: calculate EMA of a value series"""
    if len(values) < period:
        return []

    ema_values = []
    multiplier = 2 / (period + 1)

    # Initialize with simple average
    ema = sum(values[:period]) / period
    ema_values.append(ema)

    # Calculate EMA
    for i in range(period, len(values)):
        ema = (values[i] * multiplier) + (ema * (1 - multiplier))
        ema_values.append(ema)

    return ema_values

def calculate_moving_average(points: list, period: int) -> list:
    """Simple moving average. Returns [(timestamp, ma_value), ...]"""
    if len(points) < period:
        return []

    ma_values = []
    for i in range(period - 1, len(points)):
        total = sum(points[j][1]['close'] for j in range(i - period + 1, i + 1))
        ma_values.append((points[i][0], total / period))

    return ma_values

def _find_pivot_highs(scalar_points: list, left_bars: int, right_bars: int) -> list:
    """
    ThinkScript-style pivot high detection on [(timestamp, scalar), ...].
    Returns [{'idx': int, 'time': int, 'price': float}, ...]
    """
    pivots = []
    for i in range(1, len(scalar_points) - 1):
        curr = scalar_points[i][1]
        is_pivot = True
        for j in range(1, min(left_bars, i) + 1):
            if scalar_points[i - j][1] >= curr:
                is_pivot = False
                break
        if is_pivot:
            for j in range(1, min(right_bars, len(scalar_points) - 1 - i) + 1):
                if scalar_points[i + j][1] >= curr:
                    is_pivot = False
                    break
        if is_pivot:
            pivots.append({'idx': i, 'time': scalar_points[i][0], 'price': curr})
    return pivots


def _find_pivot_lows(scalar_points: list, left_bars: int, right_bars: int) -> list:
    """
    ThinkScript-style pivot low detection on [(timestamp, scalar), ...].
    Returns [{'idx': int, 'time': int, 'price': float}, ...]
    """
    pivots = []
    for i in range(1, len(scalar_points) - 1):
        curr = scalar_points[i][1]
        is_pivot = True
        for j in range(1, min(left_bars, i) + 1):
            if scalar_points[i - j][1] <= curr:
                is_pivot = False
                break
        if is_pivot:
            for j in range(1, min(right_bars, len(scalar_points) - 1 - i) + 1):
                if scalar_points[i + j][1] <= curr:
                    is_pivot = False
                    break
        if is_pivot:
            pivots.append({'idx': i, 'time': scalar_points[i][0], 'price': curr})
    return pivots


def calculate_vwap(hourly_points: list) -> dict:
    """
    Calculate session VWAP anchored to the start of the current trading day.
    Returns {'vwap': float, 'above_vwap': bool, 'distance_pct': float}
    """
    if not hourly_points:
        return {'vwap': None, 'above_vwap': None, 'distance_pct': None}

    last_dt = datetime.fromtimestamp(hourly_points[-1][0], tz=timezone.utc)
    today_date = last_dt.date()

    today_bars = [p for p in hourly_points
                  if datetime.fromtimestamp(p[0], tz=timezone.utc).date() == today_date]

    if not today_bars:
        return {'vwap': None, 'above_vwap': None, 'distance_pct': None}

    cum_tp_vol = 0.0
    cum_vol = 0
    for _, ohlcv in today_bars:
        tp = (ohlcv['high'] + ohlcv['low'] + ohlcv['close']) / 3
        cum_tp_vol += tp * ohlcv['volume']
        cum_vol += ohlcv['volume']

    if cum_vol == 0:
        return {'vwap': None, 'above_vwap': None, 'distance_pct': None}

    vwap = cum_tp_vol / cum_vol
    close = hourly_points[-1][1]['close']
    distance_pct = ((close - vwap) / vwap) * 100 if vwap != 0 else 0.0

    return {
        'vwap': round(vwap, 2),
        'above_vwap': close > vwap,
        'distance_pct': round(distance_pct, 2)
    }


def calculate_rsi_divergence(hourly_points: list, swing: int = 3) -> dict:
    """
    Detect RSI divergence on hourly data using pivot detection.

    Bearish: price makes higher high, RSI makes lower high at same pivots
    Bullish: price makes lower low,  RSI makes higher low at same pivots

    Returns {'signal': 'bullish'|'bearish'|'none'|'unknown', 'description': str}
    """
    unknown = {'signal': 'unknown', 'description': 'Insufficient data'}

    if len(hourly_points) < 30:
        return unknown

    close_points = [(p[0], p[1]['close']) for p in hourly_points]
    rsi_values = calculate_rsi(hourly_points, 14)

    if len(rsi_values) < 10:
        return unknown

    # Only examine bars where RSI is available
    rsi_start_ts = rsi_values[0][0]
    valid_closes = [(ts, c) for ts, c in close_points if ts >= rsi_start_ts]

    if len(valid_closes) < swing * 2 + 1:
        return unknown

    # Map RSI by timestamp for fast lookup; interpolate to nearest bar
    def rsi_at(ts):
        return min(rsi_values, key=lambda x: abs(x[0] - ts))[1]

    bearish_div = False
    bullish_div = False

    # Bearish: price HH, RSI LH — look at last 2 pivot highs
    price_highs = _find_pivot_highs(valid_closes, swing, swing)
    if len(price_highs) >= 2:
        ph1, ph2 = price_highs[-2], price_highs[-1]
        if ph2['price'] > ph1['price'] and rsi_at(ph2['time']) < rsi_at(ph1['time']):
            bearish_div = True

    # Bullish: price LL, RSI HL — look at last 2 pivot lows
    price_lows = _find_pivot_lows(valid_closes, swing, swing)
    if len(price_lows) >= 2:
        pl1, pl2 = price_lows[-2], price_lows[-1]
        if pl2['price'] < pl1['price'] and rsi_at(pl2['time']) > rsi_at(pl1['time']):
            bullish_div = True

    if bullish_div and bearish_div:
        return {'signal': 'both', 'description': 'Bullish + bearish divergence'}
    if bullish_div:
        return {'signal': 'bullish', 'description': 'Price LL, RSI HL'}
    if bearish_div:
        return {'signal': 'bearish', 'description': 'Price HH, RSI LH'}
    return {'signal': 'none', 'description': 'No divergence'}


def calculate_squeeze(hourly_points: list) -> dict:
    """
    Calculate TTM Squeeze indicator on hourly data.

    Squeeze status:
      'strong'  — BB inside KC at 1.5x ATR multiplier
      'normal'  — BB inside KC at 2.0x (but not 1.5x)
      'weak'    — BB inside KC at 2.5x (but not 2.0x)
      'none'    — BB outside all KC (squeeze fired)
      'unknown' — insufficient data

    Returns {'status': str, 'momentum': float, 'momentum_increasing': bool}
    """
    if len(hourly_points) < 20:
        return {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}

    def _squeeze_at(pts):
        """Compute squeeze status and momentum for a given points slice."""
        closes = [p[1]['close'] for p in pts]
        last20_closes = closes[-20:]

        # Bollinger Bands: SMA(20) and stddev
        sma20 = sum(last20_closes) / 20
        variance = sum((c - sma20) ** 2 for c in last20_closes) / 20
        stddev = math.sqrt(variance)
        bb_width = 4 * stddev  # upper - lower = 2*2σ

        # Keltner Channel midline: EMA(20)
        ema20_vals = _calculate_ema(closes, 20)
        if not ema20_vals:
            return None
        kc_mid = ema20_vals[-1]

        # ATR(14) on available bars
        atr_vals = calculate_atr(pts, 14)
        if not atr_vals:
            return None
        atr = atr_vals[-1][1]

        # Three KC widths
        kc_1_5 = 2 * 1.5 * atr
        kc_2_0 = 2 * 2.0 * atr
        kc_2_5 = 2 * 2.5 * atr

        # Squeeze status
        if bb_width < kc_1_5:
            status = 'strong'
        elif bb_width < kc_2_0:
            status = 'normal'
        elif bb_width < kc_2_5:
            status = 'weak'
        else:
            status = 'none'

        # Momentum: midpoint of (HH20, LL20, KC upper 2x, KC lower 2x)
        last20 = pts[-20:]
        hh20 = max(p[1]['high'] for p in last20)
        ll20 = min(p[1]['low'] for p in last20)
        kc_upper_2x = kc_mid + 2.0 * atr
        kc_lower_2x = kc_mid - 2.0 * atr
        midpoint = (hh20 + ll20 + kc_upper_2x + kc_lower_2x) / 4
        momentum = pts[-1][1]['close'] - midpoint

        return status, momentum

    result = _squeeze_at(hourly_points)
    if result is None:
        return {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}

    status, momentum = result

    # Momentum increasing: compare to 3 bars ago
    momentum_increasing = False
    if len(hourly_points) >= 23:
        prev_result = _squeeze_at(hourly_points[:-3])
        if prev_result is not None:
            _, prev_momentum = prev_result
            momentum_increasing = momentum > prev_momentum

    return {
        'status': status,
        'momentum': round(momentum, 4),
        'momentum_increasing': momentum_increasing
    }

# =============================================================================
# PATTERN DETECTION
# =============================================================================

def detect_gap(points: list) -> dict:
    """
    Detect if today has a significant gap from yesterday.
    Returns {
        'gap_pct': float (-5.2 to +5.2 etc),
        'gap_type': 'up' | 'down' | 'none',
        'gap_significant': bool (> 1%),
        'gap_strong': bool (> 2%)
    }
    """
    if len(points) < 2:
        return {'gap_pct': 0, 'gap_type': 'none', 'gap_significant': False, 'gap_strong': False}

    prev_close = points[-2][1]['close']
    today_open = points[-1][1]['open']

    gap_pct = ((today_open - prev_close) / prev_close) * 100 if prev_close != 0 else 0

    if abs(gap_pct) < 0.1:
        gap_type = 'none'
    elif gap_pct > 0:
        gap_type = 'up'
    else:
        gap_type = 'down'

    return {
        'gap_pct': round(gap_pct, 2),
        'gap_type': gap_type,
        'gap_significant': abs(gap_pct) > 1.0,
        'gap_strong': abs(gap_pct) > 2.0
    }

def detect_outside_day(points: list) -> str:
    """
    Detect outside day and return directional bias.
    Returns 'up' (close in upper 25% of range), 'down' (close in lower 25%), or 'none'.
    Neutral closes (middle 50%) are skipped per trading rules.
    """
    if len(points) < 2:
        return 'none'

    today = points[-1][1]
    prev = points[-2][1]

    if not (today['high'] > prev['high'] and today['low'] < prev['low']):
        return 'none'

    day_range = today['high'] - today['low']
    if day_range == 0:
        return 'none'

    close_pct = (today['close'] - today['low']) / day_range
    if close_pct >= 0.75:
        return 'up'
    if close_pct <= 0.25:
        return 'down'
    return 'none'

def detect_orb_qualified(atr_current: float, atr_20day_avg: float, opening_range_size: float) -> bool:
    """
    Detect if today's opening range is qualified for ORB trading.
    Qualified = opening range > 0.75 * average daily range
    """
    if atr_20day_avg == 0:
        return False

    avg_daily_range = atr_20day_avg
    return opening_range_size > (0.75 * avg_daily_range)

def detect_engulfing(points: list, volume_20day_avg: float) -> str:
    """
    Detect bullish or bearish engulfing candle pattern.
    Requires volume confirmation (current candle volume > 20d avg).
    Returns 'bullish', 'bearish', or 'none'.
    """
    if len(points) < 2:
        return 'none'

    prev = points[-2][1]
    curr = points[-1][1]

    volume_confirmed = curr['volume'] > volume_20day_avg if volume_20day_avg > 0 else False
    if not volume_confirmed:
        return 'none'

    prev_bullish = prev['close'] > prev['open']
    curr_bullish = curr['close'] > curr['open']

    # Bullish engulfing: prev bearish, curr bullish body covers prev body
    if not prev_bullish and curr_bullish:
        if curr['open'] <= prev['close'] and curr['close'] >= prev['open']:
            return 'bullish'

    # Bearish engulfing: prev bullish, curr bearish body covers prev body
    if prev_bullish and not curr_bullish:
        if curr['open'] >= prev['close'] and curr['close'] <= prev['open']:
            return 'bearish'

    return 'none'


def calculate_opening_range(hourly_points: list) -> float:
    """
    Calculate opening range from first 2 hourly bars (first 2 hours, 9:30-11:30 AM EST).
    Returns high - low of that range.
    """
    if len(hourly_points) < 2:
        return 0.0

    # Take first 2 hourly bars
    high = max(hourly_points[0][1]['high'], hourly_points[1][1]['high'])
    low = min(hourly_points[0][1]['low'], hourly_points[1][1]['low'])

    return high - low


def calculate_eod_outcomes(points: list, hourly_points: list, gap: dict, atr_14: float) -> dict:
    """
    Compute end-of-day trade outcome metrics.

    Checks:
    - Whether a gap filled (intraday price crossed prior close)
    - Whether ORB was breached (daily high/low exceeded today's opening range)
    - Whether T1 target (1.5x ATR from ORB breakout) was hit
    - Day range stats (% range and ATR multiple)

    Returns dict with orb_* and gap_filled fields.
    """
    result = {
        'orb_high': None,
        'orb_low': None,
        'orb_breached_up': False,
        'orb_breached_down': False,
        'orb_breached': False,
        'orb_direction': 'none',
        'orb_hit_t1': False,
        'gap_filled': False,
        'day_range': 0.0,
        'day_range_pct': 0.0,
        'day_atr_multiple': 0.0,
    }

    if len(points) < 2:
        return result

    today = points[-1][1]
    prev_close = points[-2][1]['close']
    today_high = today['high']
    today_low = today['low']
    today_close = today['close']

    # Day range stats
    day_range = today_high - today_low
    result['day_range'] = round(day_range, 2)
    if today_low > 0 and atr_14 > 0:
        result['day_range_pct'] = round(day_range / today_low * 100, 2)
        result['day_atr_multiple'] = round(day_range / atr_14, 2)

    # Gap fill: did intraday price cross the prior close?
    if gap['gap_type'] == 'up':
        result['gap_filled'] = today_low <= prev_close
    elif gap['gap_type'] == 'down':
        result['gap_filled'] = today_high >= prev_close

    # ORB: find today's hourly bars by date
    if hourly_points:
        today_date_str = datetime.fromtimestamp(points[-1][0], tz=timezone.utc).strftime('%Y-%m-%d')
        today_bars = [
            bar for bar in hourly_points
            if datetime.fromtimestamp(bar[0], tz=timezone.utc).strftime('%Y-%m-%d') == today_date_str
        ]
        if len(today_bars) >= 2:
            orb_high = max(today_bars[0][1]['high'], today_bars[1][1]['high'])
            orb_low = min(today_bars[0][1]['low'], today_bars[1][1]['low'])
            result['orb_high'] = round(orb_high, 2)
            result['orb_low'] = round(orb_low, 2)

            breached_up = today_high > orb_high
            breached_down = today_low < orb_low
            result['orb_breached_up'] = breached_up
            result['orb_breached_down'] = breached_down
            result['orb_breached'] = breached_up or breached_down

            if breached_up and breached_down:
                # Both sides breached — direction follows the close
                midpoint = (orb_high + orb_low) / 2
                result['orb_direction'] = 'up' if today_close > midpoint else 'down'
            elif breached_up:
                result['orb_direction'] = 'up'
            elif breached_down:
                result['orb_direction'] = 'down'

            if atr_14 > 0:
                t1_up = orb_high + 1.5 * atr_14
                t1_down = orb_low - 1.5 * atr_14
                hit_up = breached_up and today_high >= t1_up
                hit_down = breached_down and today_low <= t1_down
                result['orb_hit_t1'] = hit_up or hit_down

    return result

# =============================================================================
# DAY QUALITY GRADING
# =============================================================================

def grade_day_quality(points: list, atr_current: float, atr_20day_avg: float,
                      volume_20day_avg: float, volume_50day_avg: float) -> str:
    """
    Grade today's trading day quality: A+, A, B, C, or F

    Rules (from trading-rules.md):
    F  → prior day move > 10%
    C  → ATR below 20-day avg AND volume below 50-day avg
    B  → mixed signals (ATR ok but volume low, or vice versa)
    A  → ATR above avg AND volume above avg AND prior move < 3%
    A+ → all A conditions + price above rising MA(20)
    """
    if len(points) < 2:
        return 'B'

    today = points[-1][1]
    prev = points[-2][1]

    prior_move_pct = abs((today['close'] - prev['close']) / prev['close']) * 100 if prev['close'] != 0 else 0

    if prior_move_pct > 10.0:
        return 'F'

    atr_above = atr_current > atr_20day_avg
    volume_above_20 = today['volume'] > volume_20day_avg if volume_20day_avg > 0 else False
    volume_above_50 = today['volume'] > volume_50day_avg if volume_50day_avg > 0 else False

    if not atr_above and not volume_above_50:
        return 'C'

    if atr_above and volume_above_50 and prior_move_pct < 3.0:
        # A+: additionally require price above a rising 20-day MA
        ma20_values = calculate_moving_average(points, 20)
        if len(ma20_values) >= 10:
            ma20_now = ma20_values[-1][1]
            ma20_ten_ago = ma20_values[-10][1]
            if today['close'] > ma20_now and ma20_now > ma20_ten_ago:
                return 'A+'
        return 'A'

    if atr_above and volume_above_50:
        return 'A'

    return 'B'

def apply_weekday_modifier(grade: str, timestamp: int) -> str:
    """
    Apply weekday modifier to grade: Mon/Fri grade down 1 level
    """
    dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    weekday = dt.weekday()  # 0=Mon, 4=Fri

    if weekday == 0 or weekday == 4:  # Monday or Friday
        grade_order = ['F', 'C', 'B', 'A', 'A+']
        try:
            idx = grade_order.index(grade)
            if idx > 0:
                return grade_order[idx - 1]
        except ValueError:
            pass

    return grade

# =============================================================================
# REGIME DETECTION
# =============================================================================

def detect_regime(symbols: list, daily_data: dict, hourly_data: dict) -> dict:
    """
    Detect market regime: Trending / Ranging / Choppy

    - Choppy:   indices not aligned (hourly direction disagrees)
    - Trending: SPY price above/below rising/falling MA(20)
    - Ranging:  MA(20) flat or price near MA
    """
    # Check index alignment using today's hourly direction
    aligned = True
    first_dir = None
    for sym in symbols:
        if sym in hourly_data and len(hourly_data[sym]) > 0:
            pts = hourly_data[sym]
            change = (pts[-1][1]['close'] - pts[0][1]['close']) / pts[0][1]['close']
            curr_dir = 'up' if change > 0.005 else 'down' if change < -0.005 else 'flat'
            if first_dir is None:
                first_dir = curr_dir
            elif curr_dir != first_dir and curr_dir != 'flat' and first_dir != 'flat':
                aligned = False
                break

    if not aligned:
        return {'label': 'Choppy', 'direction': 'mixed', 'atr_trend': 'unknown', 'index_alignment': 'diverging'}

    # Use SPY daily data to classify Trending vs Ranging
    label = 'Ranging'
    direction = 'sideways'

    spy_points = daily_data.get('SPY', [])
    if len(spy_points) >= 20:
        ma20 = calculate_moving_average(spy_points, 20)
        if len(ma20) >= 10:
            ma20_now = ma20[-1][1]
            ma20_ten_ago = ma20[-10][1]
            close = spy_points[-1][1]['close']
            ma_rising = ma20_now > ma20_ten_ago
            ma_falling = ma20_now < ma20_ten_ago
            price_above = close > ma20_now
            price_below = close < ma20_now

            if price_above and ma_rising:
                label, direction = 'Trending', 'up'
            elif price_below and ma_falling:
                label, direction = 'Trending', 'down'
            # else: Ranging (flat MA or price crossing MA)

    # ATR trend: compare current ATR to 20-day avg
    atr_trend = 'normal'
    spy_pts = daily_data.get('SPY', [])
    if spy_pts:
        atr_vals = calculate_atr(spy_pts, 14)
        if len(atr_vals) >= 20:
            atr_now = atr_vals[-1][1]
            atr_avg = sum(a[1] for a in atr_vals[-20:]) / 20
            if atr_now > atr_avg * 1.1:
                atr_trend = 'expanding'
            elif atr_now < atr_avg * 0.9:
                atr_trend = 'contracting'

    return {
        'label': label,
        'direction': direction,
        'atr_trend': atr_trend,
        'index_alignment': 'aligned'
    }

# =============================================================================
# MAIN GENERATION
# =============================================================================

def generate_trading_signals():
    """Generate trading signals cache file"""
    trading_symbols, regime_symbols, ticker_map = load_trading_config()
    symbols = trading_symbols
    if not symbols:
        print("ERROR: No trading symbols defined")
        return False

    print(f"Generating trading signals for {len(symbols)} symbols: {', '.join(symbols)}...")

    now_utc = datetime.now(timezone.utc)
    # 'morning' if generated before 21:00 UTC (before 4 PM ET close), else 'eod'
    cache_type = 'morning' if now_utc.hour < 21 else 'eod'

    output = {
        'generated': now_utc.isoformat(),
        'cache_type': cache_type,
        'day_quality': {},
        'regime': {},
        'symbols': {},
        'active_patterns': []
    }

    # Load all daily data first
    daily_data = {}
    hourly_data = {}
    for symbol in symbols:
        daily_data[symbol] = load_daily_csv(symbol)
        hourly_data[symbol] = load_hourly_csv(symbol)

    # Process each symbol
    for symbol in symbols:
        if not daily_data[symbol]:
            continue

        points = daily_data[symbol]
        if len(points) < 2:
            continue

        today = points[-1]
        today_ts = today[0]
        today_ohlcv = today[1]

        # Calculate indicators
        atr_values = calculate_atr(points, 14)
        atr_current = atr_values[-1][1] if atr_values else 0.0
        atr_20day_avg = sum(a[1] for a in atr_values[-20:]) / min(20, len(atr_values)) if atr_values else 0.0

        rsi_values = calculate_rsi(points, 14)
        rsi_current = rsi_values[-1][1] if rsi_values else 50.0

        macd = calculate_macd(points, 12, 26, 9)
        macd_line_val = macd['line'][-1][1] if macd['line'] else 0.0
        macd_signal_val = macd['signal'][-1][1] if macd['signal'] else 0.0

        ma20_values = calculate_moving_average(points, 20)
        ma20_current = ma20_values[-1][1] if ma20_values else today_ohlcv['close']

        # Volume averages
        volumes = [p[1]['volume'] for p in points[-50:]]
        volume_20day_avg = sum(volumes[-20:]) / 20 if len(volumes) >= 20 else 0
        volume_50day_avg = sum(volumes[-50:]) / 50 if len(volumes) >= 50 else 0

        # Pattern detection
        gap = detect_gap(points)
        outside_day_dir = detect_outside_day(points)
        outside_day = outside_day_dir in ['up', 'down']
        opening_range = calculate_opening_range(hourly_data[symbol]) if hourly_data[symbol] else 0.0
        orb_qualified = detect_orb_qualified(atr_current, atr_20day_avg, opening_range)
        engulfing = detect_engulfing(points, volume_20day_avg)
        squeeze = calculate_squeeze(hourly_data[symbol]) if hourly_data[symbol] else {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}
        vwap = calculate_vwap(hourly_data[symbol]) if hourly_data[symbol] else {'vwap': None, 'above_vwap': None, 'distance_pct': None}
        rsi_divergence = calculate_rsi_divergence(hourly_data[symbol]) if hourly_data[symbol] else {'signal': 'unknown', 'description': 'No hourly data'}
        eod_outcome = calculate_eod_outcomes(points, hourly_data.get(symbol, []), gap, atr_current)

        # Day quality (first symbol sets day grade)
        if symbol == 'SPY':
            day_grade = grade_day_quality(points, atr_current, atr_20day_avg, volume_20day_avg, volume_50day_avg)
            day_grade = apply_weekday_modifier(day_grade, today_ts)
            output['day_quality']['grade'] = day_grade
            output['day_quality']['modifiers'] = {
                'atr_above_avg': atr_current > atr_20day_avg,
                'volume_above_20d': today_ohlcv['volume'] > volume_20day_avg,
                'volume_above_50d': today_ohlcv['volume'] > volume_50day_avg,
                'prior_day_move_pct': gap['gap_pct']
            }

        # Store symbol data
        output['symbols'][symbol] = {
            'date': datetime.fromtimestamp(today_ts, tz=timezone.utc).strftime('%Y-%m-%d'),
            'open': round(today_ohlcv['open'], 2),
            'high': round(today_ohlcv['high'], 2),
            'low': round(today_ohlcv['low'], 2),
            'close': round(today_ohlcv['close'], 2),
            'volume': today_ohlcv['volume'],
            'atr_14': round(atr_current, 2),
            'atr_20d_avg': round(atr_20day_avg, 2),
            'atr_above_avg': atr_current > atr_20day_avg,
            'rsi_14': round(rsi_current, 1),
            'macd_line': round(macd_line_val, 4),
            'macd_signal': round(macd_signal_val, 4),
            'macd_histogram': round(macd_line_val - macd_signal_val, 4),
            'ma_20': round(ma20_current, 2),
            'above_ma_20': today_ohlcv['close'] > ma20_current,
            'gap_pct': gap['gap_pct'],
            'gap_type': gap['gap_type'],
            'gap_significant': gap['gap_significant'],
            'gap_strong': gap['gap_strong'],
            'outside_day': outside_day,
            'outside_day_direction': outside_day_dir,
            'patterns': {
                'orb_qualified': orb_qualified,
                'gap_fill_candidate': gap['gap_significant'] and gap['gap_type'] in ['up', 'down'],
                'gap_continuation_candidate': gap['gap_strong'] and gap['gap_type'] in ['up', 'down'],
                'outside_day': outside_day
            },
            'engulfing': engulfing,
            'squeeze': squeeze,
            'vwap': vwap,
            'rsi_divergence': rsi_divergence,
            'eod_outcome': eod_outcome
        }

        # Track active patterns (include pre-computed levels + outcome for EOD review)
        if orb_qualified:
            orb_h = eod_outcome.get('orb_high') or 0.0
            orb_l = eod_outcome.get('orb_low') or 0.0
            output['active_patterns'].append({
                'symbol': symbol,
                'pattern': 'ORB',
                'direction': 'watch',
                'notes': f"ATR {atr_current:.2f} > avg {atr_20day_avg:.2f}, range {opening_range:.2f}",
                'levels': {
                    'orb_high': eod_outcome.get('orb_high'),
                    'orb_low': eod_outcome.get('orb_low'),
                    't1_up':   round(orb_h + 1.5 * atr_current, 2) if orb_h else None,
                    't1_down': round(orb_l - 1.5 * atr_current, 2) if orb_l else None,
                    't2_up':   round(orb_h + 2.0 * atr_current, 2) if orb_h else None,
                    't2_down': round(orb_l - 2.0 * atr_current, 2) if orb_l else None,
                    'atr': round(atr_current, 2),
                },
                'outcome': {
                    'next_day': False,
                    'breached':  eod_outcome.get('orb_breached', False),
                    'direction': eod_outcome.get('orb_direction', 'none'),
                    'hit_t1':    eod_outcome.get('orb_hit_t1', False),
                }
            })

        if gap['gap_strong']:
            prev_close_val = round(points[-2][1]['close'], 2)
            today_open_val = round(today_ohlcv['open'], 2)
            is_up_gap = gap['gap_type'] == 'up'
            mult = 1 if is_up_gap else -1
            output['active_patterns'].append({
                'symbol': symbol,
                'pattern': 'Gap',
                'direction': gap['gap_type'],
                'notes': f"Gap {gap['gap_pct']:.2f}%",
                'levels': {
                    'prev_close':       prev_close_val,
                    'today_open':       today_open_val,
                    'fill_target':      prev_close_val,
                    't1_continuation':  round(today_open_val + 1.5 * atr_current * mult, 2),
                    't2_continuation':  round(today_open_val + 2.0 * atr_current * mult, 2),
                    'atr': round(atr_current, 2),
                },
                'outcome': {
                    'next_day': False,
                    'filled': eod_outcome.get('gap_filled', False),
                }
            })

        if engulfing in ['bullish', 'bearish']:
            is_up_eng = engulfing == 'bullish'
            mult_eng = 1 if is_up_eng else -1
            entry_eng = round(today_ohlcv['high'] if is_up_eng else today_ohlcv['low'], 2)
            stop_eng  = round(today_ohlcv['low']  if is_up_eng else today_ohlcv['high'], 2)
            output['active_patterns'].append({
                'symbol': symbol,
                'pattern': 'Engulfing',
                'direction': 'up' if is_up_eng else 'down',
                'notes': f"{'Bullish' if is_up_eng else 'Bearish'} engulfing, vol confirmed",
                'levels': {
                    'entry': entry_eng,
                    'stop':  stop_eng,
                    't1':    round(entry_eng + 1.5 * atr_current * mult_eng, 2),
                    't2':    round(entry_eng + 2.0 * atr_current * mult_eng, 2),
                    'atr':   round(atr_current, 2),
                },
                'outcome': {
                    'next_day': True,
                    'note': f"Enter {'above' if is_up_eng else 'below'} ${entry_eng:.2f} next session"
                }
            })

        if outside_day:
            is_up_od = outside_day_dir == 'up'
            mult_od = 1 if is_up_od else -1
            entry_od = round(today_ohlcv['high'] if is_up_od else today_ohlcv['low'], 2)
            stop_od  = round(today_ohlcv['low']  if is_up_od else today_ohlcv['high'], 2)
            od_range = today_ohlcv['high'] - today_ohlcv['low']
            output['active_patterns'].append({
                'symbol': symbol,
                'pattern': 'Outside Day',
                'direction': outside_day_dir,
                'notes': f"Close {'upper' if is_up_od else 'lower'} 25%: {today_ohlcv['close']:.2f} (H {today_ohlcv['high']:.2f} / L {today_ohlcv['low']:.2f})",
                'levels': {
                    'entry':      entry_od,
                    'stop':       stop_od,
                    't1':         round(entry_od + 1.5 * od_range * mult_od, 2),
                    'range_size': round(od_range, 2),
                    'atr':        round(atr_current, 2),
                },
                'outcome': {
                    'next_day': True,
                    'note': f"Enter {'above' if is_up_od else 'below'} ${entry_od:.2f} next session"
                }
            })

    output['regime'] = detect_regime(regime_symbols, daily_data, hourly_data)

    # Write cache file
    cache_path = CACHE_DIR / 'trading_signals.json'
    with cache_path.open('w') as f:
        json.dump(output, f, indent=2)

    print(f"✓ Generated {len(output['symbols'])} symbols, {len(output['active_patterns'])} patterns")
    print(f"✓ Saved to {cache_path}")

    return True

if __name__ == '__main__':
    success = generate_trading_signals()
    exit(0 if success else 1)
