"""
pipeline/generators/trading_generator.py — Trading signals cache generator.

Reads OHLCV from SQLite; writes data/cache/trading_signals_<session_date>.json,
one file per session with one section per stage:

  premarket      closed daily bars + 5-min/hourly ending by the premarket window end
  open           + the first RTH 5-min bar
  opening_range  + 5-min bars through the opening range
  recap          the finished session, once its daily bar is complete

Each stage reads only data that ended by its window end, whenever the run happens —
live, late or in a backfill — so recomputing a stage always gives the same
answer and later stages never replace earlier ones. A stage whose data does
not exist yet is empty. Window ends come from the `stages` block in
config/trading_config.json.

Daily bars are read only once closed (is_complete, stamped at ingest).
Timezone questions go through pipeline/market_time.py.
"""

import json
import math
import statistics
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from pipeline.base_generator import BaseGenerator
from pipeline.analysis import classify_structure, find_pivot_highs, find_pivot_lows
from pipeline.market_time import (
    RTH_CLOSE, RTH_OPEN, bar_clock, bar_session_date, bar_start, market_datetime,
    parse_session_date, session_close_utc, session_open_utc,
)

DATA_DIR  = Path("data")
CACHE_DIR = Path("data/cache")


class TradingGenerator(BaseGenerator):
    def generate(self, target_date=None) -> None:
        _generate_trading_signals(self.db, self.cache_dir, target_date)


# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------

@dataclass(frozen=True)
class TradingConfig:
    symbols: list
    regime_symbols: list
    regimes: dict
    sizing: dict
    targets: dict
    stages: list        # [Stage], in session order


def _load_config() -> TradingConfig:
    config_path = Path("config/trading_config.json")
    if not config_path.exists():
        raise FileNotFoundError("trading_config.json not found")
    config = json.loads(config_path.read_text())
    trading_symbols = [e["symbol"] for e in config["symbols"]]
    regime_symbols  = [e["symbol"] for e in config["symbols"] if e.get("regime")]
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
    # Sizing and target multiples are config for the same reason regimes are:
    # the page used to hold its own copies, and the ATR multiples existed here
    # *and* in trade.js. Fail loudly rather than defaulting — a missing block
    # would silently size every trade at 100%.
    sizing = config.get("sizing")
    if not sizing:
        raise ValueError("trading_config.json has no `sizing` block")
    targets = config.get("targets")
    if not targets:
        raise ValueError("trading_config.json has no `targets` block")
    stages = config.get("stages")
    if not stages:
        raise ValueError("trading_config.json has no `stages` block")
    return TradingConfig(trading_symbols, regime_symbols, regimes, sizing, targets,
                         Stage.all_from_config(stages))


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
            bar_session_date(ts) == candidate and bar_start(ts).time() >= RTH_CLOSE
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



# ------------------------------------------------------------------
# Daily bars
# ------------------------------------------------------------------

def _bar_date(point):
    """Session a daily bar belongs to. Read from the stored session_date, which
    the fetcher sets — no timezone interpretation happens here."""
    sd = point[1].get('session_date')
    if sd:
        return parse_session_date(sd)
    return datetime.fromtimestamp(point[0], tz=timezone.utc).date()


def _completed_bars(points):
    """Bars whose session had closed when they were fetched. Completeness is
    stamped at ingest, so a partial bar simply isn't here."""
    return [p for p in points if p[1].get('is_complete')]


def _prior_bars(points, session_date):
    """Completed bars from sessions before session_date."""
    return [p for p in _completed_bars(points) if _bar_date(p) < session_date]


def _session_bar(points, session_date):
    """The daily bar for session_date, or None if it doesn't exist yet."""
    for p in reversed(points):
        if _bar_date(p) == session_date:
            return p[1]
    return None


# ------------------------------------------------------------------
# Stages and time series
# ------------------------------------------------------------------
# Every stage reads its data through get_time_series(). A stage's answer
# depends only on data that had ended by its window_end, so a live run, a
# late run and a backfill all agree.

DAILY    = timedelta(days=1)
ONE_HOUR = timedelta(hours=1)
FIVE_MIN = timedelta(minutes=5)
PREMARKET_START  = time(8, 0)   # the premarket range is measured from here
REFERENCE_SYMBOL = 'SPY'        # a stage is available once this symbol's data is there


@dataclass(frozen=True)
class Stage:
    """One stage of the session.

    window_end  market-local time the stage's window ends; it reads every bar
                that had ended by then
    timeframes  the bar intervals it reads
    """
    name: str
    label: str
    window_end: time
    timeframes: tuple

    @classmethod
    def all_from_config(cls, stages_config):
        def after_open(minutes):
            return (datetime.combine(date.min, RTH_OPEN) + timedelta(minutes=minutes)).time()
        return [
            cls('premarket', 'Premarket',
                time.fromisoformat(stages_config['premarket_window_end']), (DAILY, ONE_HOUR, FIVE_MIN)),
            cls('open', 'Open',
                after_open(stages_config['open_bar_min']), (DAILY, FIVE_MIN)),
            cls('opening_range', 'Opening range',
                after_open(stages_config['opening_range_min']), (DAILY, FIVE_MIN)),
            cls('recap', 'Recap', RTH_CLOSE, (DAILY, FIVE_MIN)),
        ]


@dataclass
class TimeSeries:
    """One symbol's bars, by timeframe — all of them, or one stage's window.
    `available` is False when the stage's data isn't there yet; bars is then
    empty."""
    symbol: str
    stage: Stage | None
    available: bool
    bars: dict

    @property
    def daily(self):
        return self.bars.get(DAILY, [])

    @property
    def hourly(self):
        return self.bars.get(ONE_HOUR, [])

    @property
    def five_min(self):
        return self.bars.get(FIVE_MIN, [])


def _bar_end(point, timeframe):
    """When a bar ended, or None if it hasn't. A daily bar ends at its
    session's close, once marked complete. Yahoo cuts hourly bars at the open
    and the close, so the 09:00 hourly bar ends at 09:30."""
    if timeframe == DAILY:
        return session_close_utc(_bar_date(point)) if point[1].get('is_complete') else None
    start = bar_start(point[0])
    end = start + timeframe
    for boundary in (RTH_OPEN, RTH_CLOSE):
        b = market_datetime(start.date(), boundary)
        if start < b < end:
            end = b
    return end


def _ended_by(bars, timeframe, end):
    """Bars that had ended by `end`. Intraday bars are mostly decided on their
    epoch alone; only one straddling `end` needs its real close worked out."""
    if timeframe == DAILY:
        return [p for p in bars if (e := _bar_end(p, DAILY)) is not None and e <= end]
    end_ts, span = end.timestamp(), timeframe.total_seconds()
    return [p for p in bars
            if p[0] + span <= end_ts or (p[0] < end_ts and _bar_end(p, timeframe) <= end)]


@dataclass
class PriceHistory:
    """Every stored bar for the symbols, loaded once, and the session they're
    being read for: the latest session with reference-symbol data (daily or
    5-min) on or before `through`."""
    session_date: date | None
    bars: dict          # symbol → {timeframe: bars}

    @classmethod
    def load(cls, db, symbols, through=None):
        bars = {s: {DAILY: db.load_daily_ohlcv(s),
                    ONE_HOUR: db.load_hourly_ohlcv(s),
                    FIVE_MIN: db.load_5m_ohlcv(s)} for s in symbols}
        found = []
        ref = bars.get(REFERENCE_SYMBOL, {})
        for d in (_bar_date(p) for p in reversed(ref.get(DAILY, []))):
            if through is None or d <= through:
                found.append(d)
                break
        for d in (bar_session_date(ts) for ts, _ in reversed(ref.get(FIVE_MIN, []))):
            if through is None or d <= through:
                found.append(d)
                break
        return cls(max(found) if found else None, bars)

    def get_time_series(self, symbol, stage=None):
        """A symbol's time series. No stage: every bar stored, in every
        timeframe. A stage: first checks the data reaches its window end — if
        not, returns it as unavailable — then the stage's timeframes, each cut
        to the bars that had ended by window_end."""
        by_tf = self.bars.get(symbol, {})
        if stage is None:
            return TimeSeries(symbol, None, True, dict(by_tf))
        end = market_datetime(self.session_date, stage.window_end)
        if not self._reaches(by_tf, stage, end):
            return TimeSeries(symbol, stage, False, {})
        return TimeSeries(symbol, stage, True,
                          {tf: _ended_by(by_tf.get(tf, []), tf, end) for tf in stage.timeframes})

    def _reaches(self, by_tf, stage, end):
        """Is every timeframe the stage reads there through its window end?
        Timeframes never collected for this symbol (VIX has no 5-min) are
        skipped; a symbol with none of them isn't available."""
        checked = False
        for tf in stage.timeframes:
            bars = by_tf.get(tf, [])
            if not bars:
                continue
            checked = True
            if not self._timeframe_reaches(bars, tf, end):
                return False
        return checked

    def _timeframe_reaches(self, bars, timeframe, end):
        """Daily: before the close, the latest bar from an earlier session is
        complete; at the close, the session's own bar is. Intraday: a bar from
        this session ended at or after the window end."""
        S = self.session_date
        if timeframe == DAILY:
            if end >= session_close_utc(S):
                bar = _session_bar(bars, S)
                return bool(bar and bar.get('is_complete'))
            prior = [p for p in bars if _bar_date(p) < S]
            return bool(prior and prior[-1][1].get('is_complete'))
        day_start = market_datetime(S, time.min).timestamp()
        next_day  = market_datetime(S + timedelta(days=1), time.min).timestamp()
        for p in reversed(bars):
            if p[0] < day_start:
                break
            if p[0] < next_day and _bar_end(p, timeframe) >= end:
                return True
        return False


def _not_available(stage):
    """The standard section for a stage whose data isn't there yet."""
    return {
        'status': 'not_available',
        'window_end': f"{stage.window_end:%H:%M}",
        'message': f"{stage.label} isn't available yet — it needs data through "
                   f"{stage.window_end:%H:%M} ET.",
    }


def _window(bars, session_date, start, end):
    """Bars of session_date that started in [start, end), market-local times."""
    lo = market_datetime(session_date, start).timestamp()
    hi = market_datetime(session_date, end).timestamp()
    return [p for p in bars if lo <= p[0] < hi]


def _last_print(bars, session_date):
    """Last 5-min close on session_date, in bars already cut to a stage."""
    last = None
    for ts, b in bars:
        if bar_session_date(ts) == session_date:
            last = b['close']
    return last


def _atr_prior(prior):
    """(ATR-14, its 20-day average) as of the last closed bar."""
    atr_vals = _calculate_atr(prior, 14)
    if not atr_vals:
        return 0.0, 0.0
    return atr_vals[-1][1], sum(a[1] for a in atr_vals[-20:]) / min(20, len(atr_vals))


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


def _classify_day_type(points):
    """Classify the most recent bar's range vs the prior bar.

    'inside'  — range fully contained in the prior bar (compression / coil).
    'outside' — range engulfs the prior bar on both sides (expansion).
    'normal'  — neither.
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


def _median_gap(prior):
    """Median absolute overnight gap over the last 20 closed sessions."""
    gaps = [abs(prior[i][1]['open'] - prior[i-1][1]['close'])
            for i in range(max(1, len(prior) - 20), len(prior))]
    return statistics.median(gaps) if gaps else 0.0


def _classify_gap(price, prior_close, median_gap):
    """Gap from prior close to `price`, sized against the median overnight gap."""
    if price is None or not prior_close:
        return {'gap_pts': None, 'gap_pct': None, 'gap_type': 'none',
                'gap_ratio': None, 'gap_significant': False, 'gap_strong': False}
    pts = price - prior_close
    pct = pts / prior_close * 100
    ratio = abs(pts) / median_gap if median_gap > 0 else None
    return {
        'gap_pts':  round(pts, 2),
        'gap_pct':  round(pct, 2),
        'gap_type': 'none' if abs(pct) < 0.1 else ('up' if pts > 0 else 'down'),
        'gap_ratio': round(ratio, 2) if ratio is not None else None,
        'gap_significant': ratio is not None and ratio >= 0.5,
        'gap_strong':      ratio is not None and ratio >= 1.5,
    }


# ------------------------------------------------------------------
# Premarket stage
# ------------------------------------------------------------------

def _compute_premarket_metrics(bars, target_date, window_end):
    """Premarket volume and range (PREMARKET_START → window_end) against the
    same window on the prior 20 sessions."""
    no_data = {'rvol': {'score': 0, 'ratio': None, 'pm_vol_today': None, 'pm_vol_avg_20d': None},
               'range': {'score': 0, 'ratio': None, 'pm_range_today': None, 'pm_range_avg_20d': None},
               'has_data': False}
    if not bars:
        return no_data
    pm_by_date: dict = {}
    for ts, ohlcv in bars:
        start = bar_start(ts)
        if PREMARKET_START <= start.time() < window_end:
            pm_by_date.setdefault(start.date(), []).append(ohlcv)
    today_bars = pm_by_date.get(target_date, [])
    if not today_bars: return no_data
    pm_vol_today   = sum(b['volume'] for b in today_bars)
    pm_range_today = max(b['high'] for b in today_bars) - min(b['low'] for b in today_bars)
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


def _load_vix(bars, vix_hourly, session_date):
    """VIX from closed daily bars, updated by the latest hourly print before
    the window end. The 20-day average is closed daily only."""
    closes = [b[1]['close'] for b in bars if b[1].get('close') is not None]
    if not closes:
        return None
    current, as_of = closes[-1], _bar_date(bars[-1]).isoformat()
    today = [p for p in vix_hourly if bar_session_date(p[0]) == session_date]
    if today:
        current = today[-1][1]['close']
        as_of = f"{session_date.isoformat()} {_bar_end(today[-1], ONE_HOUR):%H:%M}"
    avg_20d = sum(closes[-20:]) / min(20, len(closes))
    return {'current': round(current, 2), 'avg_20d': round(avg_20d, 2),
            'ratio': round(current / avg_20d, 2) if avg_20d else None,
            'as_of': as_of}


def _compute_expansion_evidence(prior, bars_cut, session_date, window_end):
    """Is the tape expanding, judged from the premarket range and the gap to
    the last print? ATR-14 alone can't answer this: it's a 14-day average."""
    pm = _compute_premarket_metrics(bars_cut, session_date, window_end)
    pm_ratio = pm['range'].get('ratio') if pm.get('has_range') else None
    gap_ratio = None
    if prior:
        gap = _classify_gap(_last_print(bars_cut, session_date),
                            prior[-1][1]['close'], _median_gap(prior))
        gap_ratio = gap['gap_ratio']
    expanding = (pm_ratio is not None and pm_ratio >= 1.0) or \
                (gap_ratio is not None and gap_ratio >= 1.5)
    return {'expanding': expanding, 'basis': 'premarket',
            'pm_range_ratio': pm_ratio, 'gap_ratio': gap_ratio}


def _detect_regime(spy_prior, expansion, regime_config):
    """Regime = daily trend (SPY vs MA20 and its slope) + ATR trend, from
    closed daily bars only. Index alignment is the opening-range stage's."""
    label, direction = 'Ranging', 'sideways'
    if len(spy_prior) >= 20:
        ma20 = _calculate_moving_average(spy_prior, 20)
        if len(ma20) >= 10:
            ma20_now, ma20_ten = ma20[-1][1], ma20[-10][1]
            close = spy_prior[-1][1]['close']
            if close > ma20_now and ma20_now > ma20_ten: label, direction = 'Trending', 'up'
            elif close < ma20_now and ma20_now < ma20_ten: label, direction = 'Trending', 'down'

    atr_trend = 'normal'
    atr_vals = _calculate_atr(spy_prior, 14)
    if len(atr_vals) >= 20:
        atr_now = atr_vals[-1][1]
        atr_avg = sum(a[1] for a in atr_vals[-20:]) / 20
        if atr_now > atr_avg * 1.1:   atr_trend = 'expanding'
        elif atr_now < atr_avg * 0.9: atr_trend = 'contracting'

    day_type = _classify_day_type(spy_prior) if len(spy_prior) >= 3 else 'normal'

    # "Choppy" means a sideways tape with a shrinking range. Any premarket
    # evidence of expansion, or an outside bar, disqualifies it.
    expanding = bool(expansion and expansion.get('expanding'))
    if label == 'Ranging' and atr_trend == 'contracting' \
            and day_type != 'outside' and not expanding:
        label, direction = 'Choppy', 'mixed'

    favored = (regime_config or {}).get(label, {})
    return {'label': label, 'direction': direction, 'atr_trend': atr_trend,
            'day_type': day_type, 'expansion': expansion or {},
            'favored': {'patterns': list(favored.get('patterns', [])),
                        'note': favored.get('note', '')}}


_STRUCTURE_SESSIONS = 5


def _structure_check(daily_direction, hourly_cut):
    """Hourly structure over the last few sessions, as a cross-check on the
    daily trend. Flags a contradiction when they point opposite ways."""
    dates = sorted({bar_session_date(ts) for ts, _ in hourly_cut})[-_STRUCTURE_SESSIONS:]
    if not dates:
        return {'hourly': None, 'hourly_direction': None, 'daily_direction': daily_direction,
                'contradicts': False}
    closes = [(ts, b['close']) for ts, b in hourly_cut if bar_session_date(ts) >= dates[0]]
    label, _, _, _ = classify_structure(closes)
    hourly_dir = 'up' if '↗' in label else 'down' if '↘' in label else 'sideways'
    contradicts = {daily_direction, hourly_dir} == {'up', 'down'}
    return {'hourly': label, 'hourly_direction': hourly_dir,
            'daily_direction': daily_direction, 'contradicts': contradicts,
            'sessions': len(dates)}


def _grade_day_quality(prior, bars_cut, session_date, window_end, regime_label, adr_8d, adr_20d):
    """Pre-open day grade, 0-8. Index alignment is not known until the opening
    range, so its factor is held at the neutral 1."""
    if len(prior) < 2:
        return 'B', {'total': 4, 'max': 8, 'has_data': False}
    prior_close = prior[-1][1]['close']

    # Factor 1: gap (prior close → last print before the window_end) + premarket range
    pm = _compute_premarket_metrics(bars_cut, session_date, window_end)
    has_pm_range = pm.get('has_range') and (pm['range'].get('ratio') or 0) >= 0.7
    median_gap = _median_gap(prior)
    last_print = _last_print(bars_cut, session_date)
    gap = _classify_gap(last_print, prior_close, median_gap)
    has_gap = gap['gap_significant']
    gap_range_score = 2 if (has_gap and has_pm_range) else 1 if (has_gap or has_pm_range) else 0

    # Factor 2: structure
    structure_score = {'Trending': 2, 'Ranging': 1, 'Choppy': 0}.get(regime_label, 1)

    # Factor 3: intraday range trend (8d vs 20d high-low)
    adr_ratio = (adr_8d / adr_20d) if (adr_8d and adr_20d) else 1.0
    adr_score = 2 if adr_ratio > 1.1 else 1 if adr_ratio >= 0.9 else 0

    # Factor 4: index alignment — neutral until the opening-range stage
    alignment_score = 1

    total = gap_range_score + structure_score + adr_score + alignment_score
    grade = 'A+' if total >= 7 else 'A' if total >= 5 else 'B' if total >= 3 else 'C'

    scores = {
        'total': total, 'max': 8,
        'gap_range': {
            'score': gap_range_score, 'has_gap': has_gap, 'has_pm_range': has_pm_range,
            'gap_pts': abs(gap['gap_pts']) if gap['gap_pts'] is not None else 0.0,
            'gap_ratio': gap['gap_ratio'] or 0.0,
            'gap_signed': gap['gap_pts'], 'gap_pct': gap['gap_pct'],
            'median_gap': round(median_gap, 2), 'prior_close': round(prior_close, 2),
            'last_print': round(last_print, 2) if last_print is not None else None,
            'pm_range_ratio': pm['range'].get('ratio'),
            'pm_range_today': pm['range'].get('pm_range_today'),
            'pm_range_avg_20d': pm['range'].get('pm_range_avg_20d'),
        },
        'structure': {'score': structure_score, 'regime': regime_label,
                      'day_type': _classify_day_type(prior)},
        'adr': {'score': adr_score, 'adr_8d': adr_8d, 'adr_20d': adr_20d, 'ratio': round(adr_ratio, 2)},
        'alignment': {'score': alignment_score, 'stage': 'opening_range'},
        'has_data': pm.get('has_data', False),
    }
    return grade, scores


def _classify_vol_regime(prior, atr_current):
    atr_vals   = _calculate_atr(prior, 14)
    atr_series = [v[1] for v in atr_vals[:-1]]
    lookback   = atr_series[-252:] if len(atr_series) >= 252 else atr_series
    pct = _percentile_rank(lookback, atr_current)
    if pct > 85:   label = 'Extreme'
    elif pct > 60: label = 'Elevated'
    elif pct >= 25: label = 'Normal'
    else:           label = 'Low'
    return {'label': label, 'atr_percentile_1y': pct}


def _prior_intraday(bars, session_date):
    """Intraday bars from sessions before session_date."""
    return [p for p in bars if bar_session_date(p[0]) < session_date]


def _premarket_indicators(prior, hourly, bars_cut, session_date, window_end):
    """Indicator values as they stood at the premarket window_end: closed daily
    bars, prior-session hourly bars, and the premarket window."""
    if not prior:
        return None
    last      = prior[-1][1]
    rsi_vals  = _calculate_rsi(prior, 14)
    macd      = _calculate_macd(prior)
    ma20_vals = _calculate_moving_average(prior, 20)
    vols      = [p[1]['volume'] for p in prior[-20:]]
    vol_20d   = sum(vols) / len(vols) if vols else 0
    macd_hist = (macd['line'][-1][1] - macd['signal'][-1][1]) \
                if macd['line'] and macd['signal'] else 0.0
    atr_prior, atr_prior_avg = _atr_prior(prior)

    pm = _compute_premarket_metrics(bars_cut, session_date, window_end) if bars_cut else None
    pm_range_active = (pm['range']['ratio'] >= 0.7) if (pm and pm.get('has_range')) \
                      else (atr_prior > atr_prior_avg)

    prior_hourly = _prior_intraday(hourly, session_date)
    squeeze = _calculate_squeeze(prior_hourly) if prior_hourly else \
              {'status': 'unknown', 'momentum': 0.0, 'momentum_increasing': False}
    rsi_div = _calculate_rsi_divergence(prior_hourly) if prior_hourly else \
              {'signal': 'unknown', 'description': 'No hourly data'}

    return {
        'prior_close':      round(last['close'], 2),
        'rsi_14':           round(rsi_vals[-1][1], 1) if rsi_vals else 50.0,
        'macd_histogram':   round(macd_hist, 4),
        'above_ma_20':      last['close'] > (ma20_vals[-1][1] if ma20_vals else last['close']),
        'volume_above_20d': last['volume'] > vol_20d if vol_20d > 0 else False,
        'pm_range_active':  pm_range_active,
        'squeeze':          squeeze,
        'rsi_divergence':   rsi_div,
        'atr_14':           round(atr_prior, 2),
        'atr_20d_avg':      round(atr_prior_avg, 2),
    }


def _pattern_keys(keys, favored_patterns):
    """Stamp a pattern with its component keys and whether they fit the regime."""
    return {'keys': list(keys),
            'regime_match': bool(set(keys) & set(favored_patterns or []))}


def _watchlist(symbol, prior, gap, last_print, atr, regime, targets_config):
    """Setups known at the premarket window end: gaps to the last print, and
    engulfing / outside day on the last closed bar."""
    favored = regime.get('favored', {}).get('patterns', [])
    t1_atr, t2_atr = targets_config['t1_atr'], targets_config['t2_atr']
    out = []
    last = prior[-1][1]

    if gap['gap_significant'] and gap['gap_type'] != 'none':
        is_up = gap['gap_type'] == 'up'
        mult  = 1 if is_up else -1
        prior_close = round(last['close'], 2)
        ratio_str = f"{gap['gap_ratio']:.1f}× median" if gap['gap_ratio'] is not None else ""
        notes = f"Gap {gap['gap_pct']:+.2f}% · {abs(gap['gap_pts']):.2f} pts · {ratio_str} · {regime['label']}"
        if gap['gap_strong'] and regime['label'] == 'Trending':
            out.append({
                'symbol': symbol, 'pattern': 'Gap Continuation', 'direction': gap['gap_type'],
                'notes': notes,
                'levels': {'prev_close': prior_close, 'last_print': round(last_print, 2),
                           't1_continuation': round(last_print + t1_atr * atr * mult, 2),
                           't2_continuation': round(last_print + t2_atr * atr * mult, 2),
                           'atr': round(atr, 2)},
                **_pattern_keys(['gap_continuation'], favored),
            })
        else:
            out.append({
                'symbol': symbol, 'pattern': 'Gap Fill', 'direction': 'down' if is_up else 'up',
                'notes': notes,
                'levels': {'prev_close': prior_close, 'last_print': round(last_print, 2),
                           'fill_target': prior_close, 'atr': round(atr, 2)},
                **_pattern_keys(['gap_fill'], favored),
            })

    vols = [p[1]['volume'] for p in prior[-20:]]
    engulfing = _detect_engulfing(prior, sum(vols) / len(vols) if vols else 0)
    if engulfing in ('bullish', 'bearish'):
        is_up = engulfing == 'bullish'
        mult  = 1 if is_up else -1
        entry = round(last['high'] if is_up else last['low'], 2)
        out.append({
            'symbol': symbol, 'pattern': 'Engulfing', 'direction': 'up' if is_up else 'down',
            'notes': f"{'Bullish' if is_up else 'Bearish'} engulfing, vol confirmed",
            'levels': {'entry': entry, 'stop': round(last['low'] if is_up else last['high'], 2),
                       't1': round(entry + t1_atr * atr * mult, 2),
                       't2': round(entry + t2_atr * atr * mult, 2), 'atr': round(atr, 2)},
            **_pattern_keys(['engulfing'], favored),
        })

    od = _detect_outside_day(prior)
    if od in ('up', 'down'):
        is_up = od == 'up'
        mult  = 1 if is_up else -1
        entry = round(last['high'] if is_up else last['low'], 2)
        od_range = last['high'] - last['low']
        out.append({
            'symbol': symbol, 'pattern': 'Outside Day', 'direction': od,
            'notes': f"Close {'upper' if is_up else 'lower'} 25%: {last['close']:.2f}",
            'levels': {'entry': entry, 'stop': round(last['low'] if is_up else last['high'], 2),
                       't1': round(entry + 1.5 * od_range * mult, 2),
                       'range_size': round(od_range, 2), 'atr': round(atr, 2)},
            **_pattern_keys(['outside_day'], favored),
        })
    return out


def _stage_premarket(cfg, stage, S, series, sections):
    window_end = stage.window_end
    spy = series[REFERENCE_SYMBOL]
    spy_prior = spy.daily
    spy_cut   = spy.five_min

    expansion = _compute_expansion_evidence(spy_prior, spy_cut, S, window_end)
    regime = _detect_regime(spy_prior, expansion, cfg.regimes)
    structure = _structure_check(regime['direction'], spy.hourly)

    section = {
        'window_end': f"{window_end:%H:%M}",
        'regime': regime,
        'structure_check': structure,
        'vix': _load_vix(series['VIX'].daily, series['VIX'].hourly, S) if 'VIX' in series else None,
        'symbols': {},
        'watchlist': [],
    }

    for symbol in cfg.symbols:
        sym = series.get(symbol)
        prior = sym.daily if sym else []
        if len(prior) < 2:
            continue
        bars_cut = sym.five_min
        atr, atr_avg = _atr_prior(prior)
        prior_close = prior[-1][1]['close']
        last_print = _last_print(bars_cut, S)
        gap = _classify_gap(last_print, prior_close, _median_gap(prior))
        pm_bars = _window(bars_cut, S, PREMARKET_START, window_end)
        ranges = [p[1]['high'] - p[1]['low'] for p in prior if p[1]['high'] and p[1]['low']]
        adr_20d = round(sum(ranges[-20:]) / min(20, len(ranges)), 2) if ranges else None
        adr_8d  = round(sum(ranges[-8:])  / min(8,  len(ranges)), 2) if ranges else None

        section['symbols'][symbol] = {
            'prior_date':  _bar_date(prior[-1]).isoformat(),
            'prior_close': round(prior_close, 2),
            'last_print':  round(last_print, 2) if last_print is not None else None,
            'gap': {**gap, 'median_overnight_gap': round(_median_gap(prior), 2)},
            'premarket': {
                'high': round(max(b[1]['high'] for b in pm_bars), 2) if pm_bars else None,
                'low':  round(min(b[1]['low']  for b in pm_bars), 2) if pm_bars else None,
                'last': round(pm_bars[-1][1]['close'], 2)             if pm_bars else None,
            },
            'adr_20d': adr_20d, 'adr_8d': adr_8d,
            'prev_range': round(ranges[-1], 2) if ranges else None,
            'day_type': _classify_day_type(prior),
            'preopen': _premarket_indicators(prior, sym.hourly,
                                             bars_cut, S, window_end),
        }
        section['watchlist'] += _watchlist(symbol, prior, gap, last_print, atr,
                                           regime, cfg.targets)

        if symbol == 'SPY':
            grade, scores = _grade_day_quality(prior, bars_cut, S, window_end, regime['label'],
                                               adr_8d, adr_20d)
            section['day_quality'] = {
                'grade': grade, 'scores': scores,
                'posture_factor': cfg.sizing['day_posture'].get(grade, 1.0),
            }
            section['vol_regime'] = _classify_vol_regime(prior, atr)
    return section


# ------------------------------------------------------------------
# Open stage
# ------------------------------------------------------------------

def _stage_open(cfg, stage, S, series, sections):
    """The first 5-min bar and the gap it opened on. Recorded for later
    assessment — no targets."""
    window_end = stage.window_end
    section = {'window_end': f"{window_end:%H:%M}", 'symbols': {}}
    for symbol in cfg.symbols:
        sym = series.get(symbol)
        prior = sym.daily if sym else []
        rth = _window(sym.five_min, S, RTH_OPEN, window_end) if sym else []
        if len(prior) < 2 or not rth:
            continue
        prior_close = prior[-1][1]['close']
        o = rth[0][1]['open']
        h = max(b[1]['high'] for b in rth)
        l = min(b[1]['low']  for b in rth)
        c = rth[-1][1]['close']
        gap = _classify_gap(o, prior_close, _median_gap(prior))
        if gap['gap_type'] == 'none':
            first_bar, filled = None, False
        else:
            is_up = gap['gap_type'] == 'up'
            toward = (c < o) if is_up else (c > o)
            first_bar = 'flat' if c == o else ('toward_fill' if toward else 'with_gap')
            filled = (l <= prior_close) if is_up else (h >= prior_close)
        section['symbols'][symbol] = {
            'bar': {'time': bar_clock(rth[0][0]), 'open': round(o, 2), 'high': round(h, 2),
                    'low': round(l, 2), 'close': round(c, 2)},
            'prior_close': round(prior_close, 2),
            'gap': gap,
            'first_bar': first_bar,
            'filled_in_first_bar': filled,
        }
    return section


# ------------------------------------------------------------------
# Opening-range stage
# ------------------------------------------------------------------

def _compute_alignment(regime_symbols, series, session_date, window_end):
    """Did SPY/QQQ/IWM move the same way from the open to the end of the
    opening range? Scored 0-2 like the day-grade factor it completes."""
    directions = {}
    for sym in regime_symbols:
        bars = _window(series[sym].five_min, session_date, RTH_OPEN, window_end) if sym in series else []
        if bars and bars[0][1]['open']:
            chg = bars[-1][1]['close'] / bars[0][1]['open'] - 1
            directions[sym] = 'up' if chg > 0.005 else 'down' if chg < -0.005 else 'flat'
    non_flat = [d for d in directions.values() if d != 'flat']
    if not non_flat:
        score = 1
    else:
        majority = max(set(non_flat), key=non_flat.count)
        agree = non_flat.count(majority)
        score = 2 if agree == len(non_flat) else (1 if agree >= 2 else 0)
    label = 'aligned' if score == 2 else 'diverging' if score == 0 else 'mixed'
    return {'score': score, 'label': label, 'detail': directions}


CONFLUENCE_MAX = 8


def _score_confluence(direction, pm, day_grade, regime_match):
    """Confluence score, 0-8, from premarket-stage inputs."""
    if pm is None:
        return None
    is_up   = direction == 'up'
    squeeze = pm['squeeze']
    checks = {
        'Volume > 20d avg (daily)': bool(pm['volume_above_20d']),
        'PM range active':          bool(pm['pm_range_active']),
        'RSI extreme (daily)':      pm['rsi_14'] < 35 or pm['rsi_14'] > 65,
        'MACD aligned (daily)':     pm['macd_histogram'] > 0 if is_up else pm['macd_histogram'] < 0,
        'MA(20) aligned (daily)':   bool(pm['above_ma_20']) if is_up else not pm['above_ma_20'],
        'Day A or A+':              day_grade in ('A', 'A+'),
        'Regime matches':           bool(regime_match),
        'Squeeze aligned (hourly)': squeeze['status'] not in ('none', 'unknown') and
                                    (squeeze['momentum_increasing'] is True if is_up
                                     else squeeze['momentum_increasing'] is False),
    }
    return {'score': sum(1 for v in checks.values() if v),
            'max': CONFLUENCE_MAX,
            'checks': checks}


def _size_trade(day_grade, score, sizing_config):
    """Position size as a percentage of normal: day posture × confluence tier."""
    day_factor = sizing_config['day_posture'].get(day_grade, 1.0)
    conf_factor, tier_label = 0.0, None
    for tier in sizing_config['confluence_tiers']:
        if score >= tier['min']:
            conf_factor, tier_label = tier['factor'], tier['label']
            break
    return {
        'day_factor':        day_factor,
        'confluence_factor': conf_factor,
        'effective_pct':     round(day_factor * conf_factor * 100, 1),
        'tier_label':        tier_label,
    }


def _plan_levels(direction, entry, atr, targets_config):
    """Stop and targets as ATR multiples off an entry. Distances are emitted
    even when there is no fixed entry."""
    mult = 1 if direction == 'up' else -1
    plan = {
        'stop_atr': targets_config['stop_atr'],
        't1_atr':   targets_config['t1_atr'],
        't2_atr':   targets_config['t2_atr'],
        'stop_distance': round(targets_config['stop_atr'] * atr, 2),
        't1_distance':   round(targets_config['t1_atr']   * atr, 2),
        't2_distance':   round(targets_config['t2_atr']   * atr, 2),
        'entry': None, 'stop': None, 't1': None, 't2': None,
    }
    if entry is not None:
        plan.update({
            'entry': round(entry, 2),
            'stop':  round(entry - mult * targets_config['stop_atr'] * atr, 2),
            't1':    round(entry + mult * targets_config['t1_atr']   * atr, 2),
            't2':    round(entry + mult * targets_config['t2_atr']   * atr, 2),
        })
    return plan


def _stage_opening_range(cfg, stage, S, series, sections):
    window_end = stage.window_end
    premarket = sections['premarket']
    targets = cfg.targets
    sizing  = cfg.sizing
    favored = premarket['regime'].get('favored', {}).get('patterns', [])
    grade   = premarket.get('day_quality', {}).get('grade')

    section = {
        'window_end': f"{window_end:%H:%M}",
        'minutes': int((market_datetime(S, window_end) - market_datetime(S, RTH_OPEN)) / timedelta(minutes=1)),
        'alignment': _compute_alignment(cfg.regime_symbols, series, S, window_end),
        'symbols': {},
        'patterns': [],
    }
    patterns = [dict(p) for p in premarket.get('watchlist', [])]

    for symbol in cfg.symbols:
        pre = premarket['symbols'].get(symbol)
        rth = _window(series[symbol].five_min, S, RTH_OPEN, window_end) if symbol in series else []
        if not pre or not rth:
            continue
        atr     = pre['preopen']['atr_14']
        atr_avg = pre['preopen']['atr_20d_avg']
        hi = max(b[1]['high'] for b in rth)
        lo = min(b[1]['low']  for b in rth)
        rng = hi - lo
        qualified = rng > 0.75 * atr_avg if atr_avg else False
        levels = {
            'or_high': round(hi, 2), 'or_low': round(lo, 2),
            't1_up':   round(hi + targets['t1_atr'] * atr, 2),
            't2_up':   round(hi + targets['t2_atr'] * atr, 2),
            't1_down': round(lo - targets['t1_atr'] * atr, 2),
            't2_down': round(lo - targets['t2_atr'] * atr, 2),
            'atr': atr,
        }
        section['symbols'][symbol] = {'high': levels['or_high'], 'low': levels['or_low'],
                                      'range': round(rng, 2), 'qualified': qualified,
                                      'levels': levels}
        if qualified:
            patterns.append({
                'symbol': symbol, 'pattern': 'ORB', 'direction': 'watch',
                'notes': f"Range {rng:.2f} > 0.75× ATR avg {atr_avg:.2f}",
                'levels': levels,
                **_pattern_keys(['orb'], favored),
            })

    for p in patterns:
        pre = premarket['symbols'].get(p['symbol'], {}).get('preopen')
        conf = _score_confluence(p['direction'], pre, grade, p.get('regime_match'))
        if not conf:
            continue
        p['confluence'] = conf
        p['qualifies']  = conf['score'] >= sizing['min_confluence']
        p['sizing']     = _size_trade(grade, conf['score'], sizing)
        entry = (p.get('levels') or {}).get('entry')
        p['plan'] = _plan_levels(p['direction'], entry if isinstance(entry, (int, float)) else None,
                                 pre['atr_14'], targets)
    section['patterns'] = patterns
    return section


# ------------------------------------------------------------------
# Recap stage
# ------------------------------------------------------------------

def _resolve_levels(bar, is_up, entry, stop, t1, t2=None):
    """Did a setup trigger, stop out, and reach its targets within `bar`?"""
    hi, lo = bar['high'], bar['low']
    triggered = (hi >= entry) if is_up else (lo <= entry)
    return {
        'triggered': triggered,
        'stop_hit':  triggered and ((lo <= stop) if is_up else (hi >= stop)),
        'hit_t1':    triggered and ((hi >= t1) if is_up else (lo <= t1)),
        'hit_t2':    triggered and (t2 is not None) and ((hi >= t2) if is_up else (lo <= t2)),
    }


def _resolve_pattern(p, bar, eod):
    lv = p.get('levels') or {}
    name = p['pattern']
    if name == 'Gap Fill':
        return {'filled': eod['gap_filled']}
    if name == 'Gap Continuation':
        is_up = p['direction'] == 'up'
        probe = bar['high'] if is_up else bar['low']
        return {
            'hit_t1_continuation': (probe >= lv['t1_continuation']) if is_up else (probe <= lv['t1_continuation']),
            'hit_t2_continuation': (probe >= lv['t2_continuation']) if is_up else (probe <= lv['t2_continuation']),
        }
    if name == 'ORB':
        return {'breached': eod['orb_breached'], 'direction': eod['orb_direction'],
                'hit_t1': eod['orb_hit_t1']}
    if name in ('Engulfing', 'Outside Day'):
        return _resolve_levels(bar, p['direction'] == 'up', lv['entry'], lv['stop'],
                               lv['t1'], lv.get('t2'))
    return {}


def _eod_outcome(bar, prior_close, atr, or_levels, t1_atr):
    rng = bar['high'] - bar['low']
    out = {
        'day_range': round(rng, 2),
        'day_range_pct': round(rng / bar['low'] * 100, 2) if bar['low'] else 0.0,
        'day_atr_multiple': round(rng / atr, 2) if atr else 0.0,
        'gap_filled': False,
        'orb_high': None, 'orb_low': None, 'orb_breached_up': False, 'orb_breached_down': False,
        'orb_breached': False, 'orb_direction': 'none', 'orb_hit_t1': False,
    }
    if bar['open'] > prior_close:
        out['gap_filled'] = bar['low'] <= prior_close
    elif bar['open'] < prior_close:
        out['gap_filled'] = bar['high'] >= prior_close
    if or_levels:
        oh, ol = or_levels['or_high'], or_levels['or_low']
        bu, bd = bar['high'] > oh, bar['low'] < ol
        out.update({'orb_high': oh, 'orb_low': ol, 'orb_breached_up': bu,
                    'orb_breached_down': bd, 'orb_breached': bu or bd})
        if bu and bd:
            out['orb_direction'] = 'up' if bar['close'] > (oh + ol) / 2 else 'down'
        elif bu: out['orb_direction'] = 'up'
        elif bd: out['orb_direction'] = 'down'
        if atr:
            out['orb_hit_t1'] = (bu and bar['high'] >= oh + t1_atr * atr) or \
                                (bd and bar['low'] <= ol - t1_atr * atr)
    return out


def _grade_realized(bar, prior, eod_outcome, forecast_grade, forecast_total):
    """What the session delivered, on the same 0-8 scale as the day grade."""
    atr, _ = _atr_prior(prior)
    rng = bar['high'] - bar['low']
    atr_multiple = round(rng / atr, 2) if atr > 0 else None
    close_loc = round((bar['close'] - bar['low']) / rng, 2) if rng > 0 else 0.5
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
        'day_type': _classify_day_type(prior + [(None, bar)]),
        'orb_breached': bool(eod_outcome.get('orb_breached')),
        'orb_hit_t1':   bool(eod_outcome.get('orb_hit_t1')),
        'gap_filled':   bool(eod_outcome.get('gap_filled')),
        'scores': {'range': range_score, 'direction': direction_score, 'follow_through': follow_score},
        'forecast_grade': forecast_grade, 'forecast_total': forecast_total,
        'verdict': verdict,
    }


def _stage_recap(cfg, stage, S, series, sections):
    """Each section's calls graded against the finished session."""
    premarket, open_, opening_range = sections['premarket'], sections['open'], sections['opening_range']
    if opening_range.get('status') == 'not_available':
        opening_range = {}
    t1_atr = cfg.targets['t1_atr']
    section = {'symbols': {}, 'patterns': []}

    for symbol in cfg.symbols:
        bar = _session_bar(series[symbol].daily, S) if symbol in series else None
        pre = premarket['symbols'].get(symbol)
        if not (bar and pre):
            continue
        or_sym = (opening_range.get('symbols') or {}).get(symbol)
        eod = _eod_outcome(bar, pre['prior_close'], pre['preopen']['atr_14'],
                           or_sym['levels'] if or_sym else None, t1_atr)
        entry = {'open': round(bar['open'], 2), 'high': round(bar['high'], 2),
                 'low': round(bar['low'], 2), 'close': round(bar['close'], 2),
                 'volume': bar['volume'], 'eod_outcome': eod}
        open_sym = (open_.get('symbols') or {}).get(symbol)
        if open_sym and open_sym['first_bar'] in ('toward_fill', 'with_gap'):
            entry['first_bar_call'] = {'call': open_sym['first_bar'],
                                       'correct': (open_sym['first_bar'] == 'toward_fill') == eod['gap_filled']}
        section['symbols'][symbol] = entry

    spy = section['symbols'].get('SPY')
    if spy:
        dq = premarket.get('day_quality', {})
        section['day_realized'] = _grade_realized(
            _session_bar(series['SPY'].daily, S), _prior_bars(series['SPY'].daily, S),
            spy['eod_outcome'],
            dq.get('grade'), dq.get('scores', {}).get('total'))

    calls = opening_range.get('patterns') if opening_range else premarket.get('watchlist', [])
    for p in calls or []:
        sym = p['symbol']
        if sym not in section['symbols']:
            continue
        section['patterns'].append({
            'symbol': sym, 'pattern': p['pattern'], 'direction': p['direction'],
            'stage': 'opening_range' if opening_range else 'premarket',
            'outcome': _resolve_pattern(p, _session_bar(series[sym].daily, S),
                                        section['symbols'][sym]['eod_outcome']),
        })
    return section


# ------------------------------------------------------------------
# Orchestration
# ------------------------------------------------------------------

STAGE_BUILDERS = {
    'premarket':     _stage_premarket,
    'open':          _stage_open,
    'opening_range': _stage_opening_range,
    'recap':         _stage_recap,
}


def _generate_trading_signals(db, cache_dir, target_date=None):
    cfg = _load_config()
    if not cfg.symbols:
        raise ValueError("No trading symbols in trading_config.json")

    print(f"Generating trading signals for {len(cfg.symbols)} symbols...")
    now_utc = datetime.now(timezone.utc)

    symbols = cfg.symbols + ['VIX']
    history = PriceHistory.load(db, symbols, through=target_date)
    session_date = history.session_date or now_utc.date()

    # Stages run in session order. Each reads its own time series per symbol
    # and the sections before it. A stage whose data isn't there yet gets the
    # standard not-available section.
    sections = {}
    for stage in cfg.stages:
        series = {s: history.get_time_series(s, stage) for s in symbols}
        if not series[REFERENCE_SYMBOL].available:
            sections[stage.name] = _not_available(stage)
            continue
        available = {s: ts for s, ts in series.items() if ts.available}
        sections[stage.name] = STAGE_BUILDERS[stage.name](cfg, stage, session_date, available, sections)

    output = {
        'session_date':  session_date.isoformat(),
        'generated':     now_utc.isoformat(),
        'market_closed': session_date.weekday() >= 5,
        **sections,
    }

    path = cache_dir / f"trading_signals_{session_date.isoformat()}.json"
    with open(path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"✓ {session_date} stages: "
          f"{', '.join(k for k, v in sections.items() if v.get('status') != 'not_available')} → {path}")

    _emit_intraday_bars(cache_dir, cfg.symbols, history, session_date)


def _emit_intraday_bars(cache_dir, symbols, history, session_date):
    """Emit per-symbol 5m OHLCV for overnight (prior 16:00 ET → session 09:30 ET)
    and RTH day session (09:30 ET → 16:00 ET) as data/cache/intraday/{SYM}_{DATE}.json."""
    if session_date is None:
        return
    intraday_dir = cache_dir / 'intraday'
    intraday_dir.mkdir(parents=True, exist_ok=True)

    def _serialize(bar_list):
        return [{
            'time':   ts,
            'open':   round(ohlcv['open'],  4),
            'high':   round(ohlcv['high'],  4),
            'low':    round(ohlcv['low'],   4),
            'close':  round(ohlcv['close'], 4),
            'volume': int(ohlcv.get('volume') or 0),
        } for ts, ohlcv in bar_list]

    written = 0
    for symbol in symbols:
        bars = history.get_time_series(symbol).five_min
        if not bars:
            continue
        overnight = _get_overnight_bars(bars, session_date)
        day       = _window(bars, session_date, RTH_OPEN, RTH_CLOSE)
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
    td = datetime.strptime(args.date, '%Y-%m-%d').date() if args.date else None
    TradingGenerator().generate(target_date=td)
