#!/usr/bin/env python3
"""
Pre-compute analysis cache files for all parameter combinations.
Writes JSON files to data/cache/ to eliminate client-side computation.

Macro caches (9 files):   data/cache/macro_{lookback}_{maPeriod}.json
Divergence caches (45):   data/cache/divergence_{lookback}_{pivotMode}_{swing}.json

Uses stdlib only (csv, json, pathlib, datetime) — no new dependencies.
"""

import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path("data")
CACHE_DIR = DATA_DIR / "cache"

LOOKBACKS    = [20, 50, 100]
MA_PERIODS   = [20, 50, 100]
PIVOT_MODES  = ["recent", "highest", "highest-to-current"]
SWINGS       = [2, 3, 5, 7, 10]

# Ticker overrides matching fetch_data.py
TICKER_MAP = {
    'BTC': 'BTC-USD',
    'ETH': 'ETH-USD',
    'VIX': '^VIX',
}

# =============================================================================
# DATA LOADING
# =============================================================================

def load_daily_csv(symbol: str) -> list:
    """Read data/{symbol}.csv, return [(timestamp_secs, close), ...]"""
    path = DATA_DIR / f"{symbol.lower()}.csv"
    if not path.exists():
        return []

    points = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            date  = row.get('Date', '').strip()
            close = row.get('Close', '').strip()
            if not date or not close or date == 'Date' or close == 'Close':
                continue
            try:
                t = int(datetime.strptime(date, '%Y-%m-%d')
                        .replace(tzinfo=timezone.utc).timestamp())
                c = float(close)
                points.append((t, c))
            except (ValueError, KeyError):
                continue

    points.sort(key=lambda x: x[0])
    return points

# =============================================================================
# ANALYSIS: mirrors of app.js functions
# =============================================================================

def last(arr: list, n: int) -> list:
    return arr[max(0, len(arr) - n):]


def calculate_ma(points: list, period: int) -> list:
    """Simple moving average. Returns [(timestamp, ma), ...]"""
    ma_points = []
    for i in range(period - 1, len(points)):
        total = sum(points[j][1] for j in range(i - period + 1, i + 1))
        ma_points.append((points[i][0], total / period))
    return ma_points


def find_pivot_highs(points: list, left_bars: int, right_bars: int) -> list:
    """ThinkScript-style pivot detection. Returns [{idx, time, price}, ...]"""
    pivot_highs = []
    for i in range(1, len(points) - 1):
        curr = points[i][1]
        is_pivot = True

        check_before = min(left_bars, i)
        for j in range(1, check_before + 1):
            if points[i - j][1] >= curr:
                is_pivot = False
                break

        if is_pivot:
            check_after = min(right_bars, len(points) - 1 - i)
            for j in range(1, check_after + 1):
                if points[i + j][1] >= curr:
                    is_pivot = False
                    break

        if is_pivot:
            pivot_highs.append({'idx': i, 'time': points[i][0], 'price': points[i][1]})

    return pivot_highs


def find_pivot_lows(points: list, left_bars: int, right_bars: int) -> list:
    """Mirror of find_pivot_highs for local lows. Returns [{idx, time, price}, ...]"""
    pivot_lows = []
    for i in range(1, len(points) - 1):
        curr = points[i][1]
        is_pivot = True

        check_before = min(left_bars, i)
        for j in range(1, check_before + 1):
            if points[i - j][1] <= curr:
                is_pivot = False
                break

        if is_pivot:
            check_after = min(right_bars, len(points) - 1 - i)
            for j in range(1, check_after + 1):
                if points[i + j][1] <= curr:
                    is_pivot = False
                    break

        if is_pivot:
            pivot_lows.append({'idx': i, 'time': points[i][0], 'price': points[i][1]})

    return pivot_lows


def classify_structure(points: list) -> tuple:
    """
    Pine Script-style market structure labeling (matches test.js logic).

    Seeds lastHigh/lastLow from points[0] (window opening price).
    Walks N=1 pivots chronologically; each pivot compared to running extreme:
      - pivot high > running high  → HH (advance running high)
      - pivot high <= running high → LH (running high unchanged)
      - pivot low  < running low   → LL (advance running low)
      - pivot low  >= running low  → HL (running low unchanged)

    Returns (trend_label, last_high, last_low) where last_high/last_low are
    {time, price, label} dicts (or None) representing the most recent labeled pivot.
    """
    if not points:
        return 'Sideways \u2194', None, None

    highs = find_pivot_highs(points, 1, 1)
    lows  = find_pivot_lows(points,  1, 1)

    # Merge and walk in chronological order
    pivots = sorted(
        [{'type': 'high', **h} for h in highs] + [{'type': 'low', **l} for l in lows],
        key=lambda x: x['idx']
    )

    if not pivots:
        return 'Sideways \u2194', None, None

    # Seed from window opening price (first bar used as reference, not as pivot)
    running_high = points[0][1]
    running_low  = points[0][1]
    last_high = None
    last_low  = None
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

    hl = last_high['label'] if last_high else None
    ll = last_low['label']  if last_low  else None

    if   hl == 'HH' and ll == 'HL': trend_label = 'HH + HL \u2197'
    elif hl == 'LH' and ll == 'LL': trend_label = 'LL + LH \u2198'
    elif hl == 'LH' and ll == 'HL': trend_label = 'LH + HL \u2194'
    elif hl == 'HH' and ll == 'LL': trend_label = 'HH + LL \u2194'
    elif hl == 'HH':                trend_label = 'HH only \u2197'
    elif ll == 'LL':                trend_label = 'LL only \u2198'
    else:                           trend_label = 'Sideways \u2194'

    return trend_label, all_pivots, last_high, last_low


def find_recent_pivot_highs(points: list, max_pivots: int, bars_each_side: int, mode: str) -> list:
    """Configurable pivot selection: 'highest' or 'recent'."""
    all_pivots = find_pivot_highs(points, bars_each_side, bars_each_side)

    if mode == "highest":
        all_pivots.sort(key=lambda x: x['price'], reverse=True)
        top_n = all_pivots[:max_pivots]
        return sorted(top_n, key=lambda x: x['time'])
    else:  # "recent"
        return all_pivots[-max_pivots:] if len(all_pivots) >= max_pivots else all_pivots


def find_highest_to_current(points: list, bars_each_side: int) -> list:
    """Highest swing high + current price (2 points)."""
    if not points:
        return []

    current_idx = len(points) - 1
    current_price = points[current_idx][1]

    exclude_bars = bars_each_side + 1
    historical = points[:-exclude_bars] if exclude_bars < len(points) else []
    if not historical:
        return []

    all_pivots = find_pivot_highs(historical, bars_each_side, bars_each_side)
    if not all_pivots:
        return []

    highest = max(all_pivots, key=lambda x: x['price'])
    return [
        highest,
        {'idx': current_idx, 'time': points[current_idx][0], 'price': current_price}
    ]


def calculate_trend(pivots: list) -> str:
    if len(pivots) < 2:
        return "Sideways \u2194"
    if pivots[1]['price'] > pivots[0]['price']:
        return "Higher Highs \u2197"
    if pivots[1]['price'] < pivots[0]['price']:
        return "Lower Highs \u2198"
    return "Sideways \u2194"


def get_divergence_signal(trend1: str, trend2: str, name1: str, name2: str) -> str:
    up   = {'HH + HL \u2197', 'HH only \u2197'}
    down = {'LL + LH \u2198', 'LL only \u2198'}

    if trend1 in up   and trend2 in down:
        return f"\u26a0\ufe0f BEARISH: {name1} HH+HL, {name2} LL+LH"
    if trend1 in down and trend2 in up:
        return f"\u26a0\ufe0f BULLISH: {name2} HH+HL, {name1} LL+LH"
    if trend1 in up   and trend2 in up:
        return "\u2705 ALIGNED: Both HH+HL"
    if trend1 in down and trend2 in down:
        return "\U0001f534 ALIGNED: Both LL+LH"
    return "\u2696\ufe0f Mixed / No clear divergence"

# =============================================================================
# CATEGORY THEME DERIVATION
# =============================================================================

def derive_category_theme(cat_id: str, signals: dict) -> str:
    """Derive a human-readable theme label for a category based on above-MA signals."""
    above = {s for s, v in signals.items() if v is True}

    if cat_id == 'us-sectors':
        defensive = {'XLV', 'XLP', 'XLU', 'XLRE'}
        cyclical  = {'XLK', 'XLF', 'XLY', 'XLC'}
        value     = {'XLE', 'XLI', 'XLB'}
        d = len(above & defensive); c = len(above & cyclical); v = len(above & value)
        if d + c + v == 0:              return 'Broad weakness'
        if d > c and d > v:             return 'Defensive rotation'
        if v > c and v > d:             return 'Value / reflation'
        if c > d and ('XLK' in above or 'XLC' in above): return 'Growth / tech led'
        if c > d:                       return 'Cyclical rotation'
        return 'Mixed'

    elif cat_id == 'fixed-income':
        if {'TLT','IEF'} <= above and not (above & {'HYG','LQD'}): return 'Flight to quality'
        if {'HYG','LQD'} <= above and 'TLT' not in above:          return 'Risk-on credit'
        if 'TIP' in above and 'TLT' not in above:                  return 'Inflation breakout'
        if not above:                                               return 'Broad weakness'
        return 'Mixed signals'

    elif cat_id == 'commodities':
        precious = {'GLD','SLV','CPER'}; energy = {'USO','UNG'}
        p = len(above & precious); e = len(above & energy)
        total = len([v for v in signals.values() if v is not None])
        pct   = len(above) / total if total else 0
        if pct >= 0.70:        return 'Broad inflation bid'
        if p >= 2 and e == 0:  return 'Precious metals bid'
        if e >= 1 and p == 0:  return 'Energy led'
        if not above:          return 'Broad weakness'
        return 'Mixed'

    elif cat_id == 'currencies':
        uup = signals.get('UUP')
        if uup is True:  return 'Dollar strength'
        if uup is False: return 'Dollar weakness'
        return 'Mixed'

    elif cat_id == 'volatility':
        if above & {'VIX','UVXY','VIXY'}: return 'Elevated vol'
        return 'Vol suppressed'

    elif cat_id == 'crypto':
        btc, eth = signals.get('BTC'), signals.get('ETH')
        if btc and eth:         return 'Risk-on'
        if not btc and not eth: return 'Risk-off'
        return 'Diverging'

    elif cat_id == 'international':
        em = len(above & {'EEM','FXI'})
        dm = 1 if signals.get('EFA') else 0
        total = len([v for v in signals.values() if v is not None])
        if len(above) == total and total > 0: return 'Global strength'
        if not above:          return 'Global weakness'
        if em > dm:            return 'EM outperforming'
        if dm > em:            return 'DM outperforming'
        return 'Mixed'

    elif cat_id == 'us-equities':
        total = len([v for v in signals.values() if v is not None])
        pct   = len(above) / total if total else 0
        spy, iwm = signals.get('SPY'), signals.get('IWM')
        if pct >= 0.70:                     return 'Broad strength'
        if pct >= 0.50 and spy and not iwm: return 'Large-cap led'
        if pct >= 0.50 and iwm and not spy: return 'Small-cap led'
        if pct >= 0.50:                     return 'Moderate strength'
        if pct <= 0.30:                     return 'Broad weakness'
        return 'Mixed'

    else:
        total = len([v for v in signals.values() if v is not None])
        pct   = len(above) / total if total else 0
        if pct >= 0.70: return 'Strong'
        if pct >= 0.50: return 'Moderate'
        if pct <= 0.30: return 'Weak'
        return 'Mixed'


# =============================================================================
# REGIME CARD
# =============================================================================

def compute_regime_card(signal_map: dict) -> dict:
    """Compute 4-quadrant Growth x Inflation regime classification from above-MA signals."""

    growth_max    = 8.5
    inflation_max = 6.5

    # Growth score: risk/growth assets above MA
    growth_score = 0.0
    if signal_map.get('HYG'):  growth_score += 2.0
    if signal_map.get('IWM'):  growth_score += 1.5
    if signal_map.get('SPY'):  growth_score += 1.0
    if signal_map.get('EEM'):  growth_score += 1.0
    if signal_map.get('EMB'):  growth_score += 1.0
    # XLY>XLP: discretionary outperforming staples = growth signal
    if signal_map.get('XLY') and not signal_map.get('XLP'):
        growth_score += 1.0

    # Inflation score
    inflation_score = 0.0
    if signal_map.get('TIP'):        inflation_score += 2.0
    if not signal_map.get('TLT'):    inflation_score += 1.5  # TLT below MA = inflation
    if signal_map.get('GLD'):        inflation_score += 1.0
    if signal_map.get('USO'):        inflation_score += 1.0
    if signal_map.get('DBC'):        inflation_score += 1.0

    growth_pct    = round(growth_score    / growth_max    * 100)
    inflation_pct = round(inflation_score / inflation_max * 100)

    # 4-quadrant classification (50% threshold on each axis)
    if   growth_pct >= 50 and inflation_pct <  50: quadrant = '\U0001f7e2 GOLDILOCKS'
    elif growth_pct >= 50 and inflation_pct >= 50: quadrant = '\U0001f7e1 INFLATIONARY BOOM'
    elif growth_pct <  50 and inflation_pct <  50: quadrant = '\U0001f535 RECESSION / DEFLATION'
    else:                                           quadrant = '\U0001f534 STAGFLATION'

    # Risk-off warning flags
    flags = {
        'carry_risk':       not signal_map.get('HYG', True),
        'inflation_regime': inflation_pct >= 60,
        'credit_stress':    not signal_map.get('HYG', True) and not signal_map.get('LQD', True),
        'china_divergence': signal_map.get('FXI') != signal_map.get('SPY'),
        'vol_spike':        bool(signal_map.get('UVXY') or signal_map.get('VIXY')),
    }

    return {
        'quadrant':  quadrant,
        'growth':    {'score': round(growth_score, 2), 'max': growth_max,    'pct': growth_pct},
        'inflation': {'score': round(inflation_score, 2), 'max': inflation_max, 'pct': inflation_pct},
        'flags':     flags,
    }

# =============================================================================
# MACRO CACHE GENERATION
# =============================================================================

def generate_macro_cache(categories: list, data: dict, lookback: int, ma_period: int) -> dict:
    generated = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

    cache_categories = []
    total_above  = 0  # regime count (with invert)
    total_count  = 0
    signal_map   = {}  # symbol -> above_ma (for regime card)

    for cat in categories:
        invert = cat.get('invert', False)
        cat_above  = 0  # breadth bar (no invert)
        cat_total  = 0
        regime_above = 0
        regime_total = 0
        cat_assets = []
        cat_signals = {}  # symbol -> above_ma for theme derivation

        for asset in cat['assets']:
            sym  = asset['symbol'].lower()
            pts  = data.get(sym, [])

            if len(pts) < 2:
                cat_assets.append({
                    'symbol':       asset['symbol'],
                    'name':         asset.get('name', asset['symbol']),
                    'price':        None,
                    'pct_change':   None,
                    'above_ma':     None,
                    'ma_value':     None,
                    'price_points': [],
                    'ma_points':    [],
                })
                continue

            ma_pts        = calculate_ma(pts, ma_period)
            current_price = pts[-1][1]
            prev_price    = pts[-2][1]
            pct_change    = ((current_price - prev_price) / prev_price * 100
                             if prev_price != 0 else None)
            current_ma    = ma_pts[-1][1] if ma_pts else None
            above_ma      = (current_price > current_ma) if current_ma is not None else None

            signal_map[asset['symbol']] = above_ma
            cat_signals[asset['symbol']] = above_ma

            # Breadth bar (no invert)
            if above_ma is not None:
                cat_total += 1
                if above_ma:
                    cat_above += 1

            # Regime (with invert)
            if above_ma is not None:
                regime_total += 1
                counts_as_above = (not above_ma) if invert else above_ma
                if counts_as_above:
                    regime_above += 1

            # Filter to lookback window for sparkline
            recent_pts = last(pts, lookback)
            window_start = recent_pts[0][0] if recent_pts else 0
            recent_ma = [p for p in ma_pts if p[0] >= window_start]

            cat_assets.append({
                'symbol':       asset['symbol'],
                'name':         asset.get('name', asset['symbol']),
                'price':        round(current_price, 4),
                'pct_change':   round(pct_change, 4) if pct_change is not None else None,
                'above_ma':     above_ma,
                'ma_value':     round(current_ma, 4) if current_ma is not None else None,
                'price_points': [[p[0], round(p[1], 4)] for p in recent_pts],
                'ma_points':    [[p[0], round(p[1], 4)] for p in recent_ma],
            })

        total_above += regime_above
        total_count += regime_total

        leaders  = [s for s, v in cat_signals.items() if v is True]
        laggards = [s for s, v in cat_signals.items() if v is False]
        cache_categories.append({
            'id':       cat['id'],
            'breadth':  {'above': cat_above, 'total': cat_total},
            'theme':    derive_category_theme(cat['id'], cat_signals),
            'leaders':  leaders,
            'laggards': laggards,
            'assets':   cat_assets,
        })

    pct = total_above / total_count if total_count > 0 else 0
    if   pct >= 0.70:  regime_label = '\U0001f7e2 STRONG RISK ON'
    elif pct >= 0.55:  regime_label = '\U0001f7e1 RISK ON'
    elif pct >= 0.45:  regime_label = '\u26aa NEUTRAL'
    elif pct >= 0.25:  regime_label = '\U0001f7e0 RISK OFF'
    else:              regime_label = '\U0001f534 STRONG RISK OFF'

    return {
        'generated':   generated,
        'lookback':    lookback,
        'ma_period':   ma_period,
        'regime': {
            'label': regime_label,
            'above': total_above,
            'total': total_count,
            'pct':   round(pct * 100),
        },
        'regime_card': compute_regime_card(signal_map),
        'categories':  cache_categories,
    }

# =============================================================================
# DIVERGENCE CACHE GENERATION
# =============================================================================

def generate_divergence_cache(pairs: list, symbols: list, data: dict,
                               lookback: int, pivot_mode: str, swing: int) -> dict:
    generated = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

    # Risk score (MA hardcoded at 50 matching app.js calculateRiskScore)
    score   = 0
    details = []
    for sym_obj in symbols:
        sym  = sym_obj['symbol'].lower()
        pts  = data.get(sym, [])
        if not pts:
            continue
        ma50 = calculate_ma(pts, 50)
        if not ma50:
            continue
        current_price = pts[-1][1]
        current_ma    = ma50[-1][1]
        label         = sym_obj['symbol']
        if current_price > current_ma:
            score += 1
            details.append(f"{label}: Above 50 MA \u2713")
        else:
            score -= 1
            details.append(f"{label}: Below 50 MA \u2717")

    total = len(symbols)
    if   score >= math.ceil(total * 0.7):   risk_signal = "\U0001f7e2 STRONG RISK ON"
    elif score >= math.ceil(total * 0.3):   risk_signal = "\U0001f7e1 RISK ON"
    elif score >= -math.ceil(total * 0.3):  risk_signal = "\u26aa NEUTRAL"
    elif score >= -math.ceil(total * 0.7):  risk_signal = "\U0001f7e0 RISK OFF"
    else:                                   risk_signal = "\U0001f534 STRONG RISK OFF"

    # Per-pair analysis
    cache_pairs = []
    for pair in pairs:
        sym1 = pair['symbol1'].lower()
        sym2 = pair['symbol2'].lower()
        pts1 = data.get(sym1, [])
        pts2 = data.get(sym2, [])

        if not pts1 or not pts2:
            cache_pairs.append({
                'id':      pair['id'],
                'trend1':  'Sideways \u2194',
                'trend2':  'Sideways \u2194',
                'signal':  '\u23f3 No data available yet',
                'pivots1': [],
                'pivots2': [],
            })
            continue

        recent1 = last(pts1, lookback)
        recent2 = last(pts2, lookback)

        if pivot_mode == "highest-to-current":
            pivots1 = find_highest_to_current(recent1, swing)
            pivots2 = find_highest_to_current(recent2, swing)
            trend1 = calculate_trend(pivots1)
            trend2 = calculate_trend(pivots2)
            signal = get_divergence_signal(trend1, trend2, pair['symbol1'], pair['symbol2'])
        else:
            trend1, pivots1, _, _ = classify_structure(recent1)
            trend2, pivots2, _, _ = classify_structure(recent2)
            signal = get_divergence_signal(trend1, trend2, pair['symbol1'], pair['symbol2'])

        cache_pairs.append({
            'id':      pair['id'],
            'trend1':  trend1,
            'trend2':  trend2,
            'signal':  signal,
            'pivots1': [{'time': p['time'], 'price': round(p['price'], 4), 'label': p.get('label', '')} for p in pivots1],
            'pivots2': [{'time': p['time'], 'price': round(p['price'], 4), 'label': p.get('label', '')} for p in pivots2],
        })

    return {
        'generated':  generated,
        'lookback':   lookback,
        'pivot_mode': pivot_mode,
        'swing':      swing,
        'risk_score': {
            'score':   score,
            'signal':  risk_signal,
            'details': details,
        },
        'pairs': cache_pairs,
    }

# =============================================================================
# MAIN
# =============================================================================

def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Load configs
    with open('config.json', encoding='utf-8') as f:
        config = json.load(f)
    with open('macro_config.json', encoding='utf-8') as f:
        macro_config = json.load(f)

    pairs      = config['pairs']
    symbols    = config['symbols']
    categories = macro_config['macro_categories']

    # Collect all unique symbols from both configs
    all_syms = set()
    for s in symbols:
        all_syms.add(s['symbol'].lower())
    for cat in categories:
        for a in cat['assets']:
            all_syms.add(a['symbol'].lower())

    print(f"Loading {len(all_syms)} symbols...")
    data = {}
    missing = []
    for sym in sorted(all_syms):
        pts = load_daily_csv(sym)
        data[sym] = pts
        if pts:
            print(f"  {sym.upper()}: {len(pts)} points")
        else:
            print(f"  {sym.upper()}: NOT FOUND (skipped)")
            missing.append(sym)

    if missing:
        print(f"\nWarning: {len(missing)} symbols missing data: {', '.join(s.upper() for s in missing)}")

    # --- Macro caches (9 files) ---
    print(f"\nGenerating macro caches ({len(LOOKBACKS)} x {len(MA_PERIODS)} = {len(LOOKBACKS)*len(MA_PERIODS)} files)...")
    macro_count = 0
    for lookback in LOOKBACKS:
        for ma_period in MA_PERIODS:
            cache = generate_macro_cache(categories, data, lookback, ma_period)
            path  = CACHE_DIR / f"macro_{lookback}_{ma_period}.json"
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(cache, f, ensure_ascii=False, separators=(',', ':'))
            macro_count += 1
    print(f"  Written {macro_count} macro cache files")

    # --- Divergence caches (45 files) ---
    div_total = len(LOOKBACKS) * len(PIVOT_MODES) * len(SWINGS)
    print(f"\nGenerating divergence caches ({len(LOOKBACKS)} x {len(PIVOT_MODES)} x {len(SWINGS)} = {div_total} files)...")
    div_count = 0
    for lookback in LOOKBACKS:
        for pivot_mode in PIVOT_MODES:
            for swing in SWINGS:
                cache = generate_divergence_cache(pairs, symbols, data, lookback, pivot_mode, swing)
                path  = CACHE_DIR / f"divergence_{lookback}_{pivot_mode}_{swing}.json"
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(cache, f, ensure_ascii=False, separators=(',', ':'))
                div_count += 1
    print(f"  Written {div_count} divergence cache files")

    print(f"\nDone! {macro_count} macro + {div_count} divergence = {macro_count + div_count} total cache files in {CACHE_DIR}/")


if __name__ == "__main__":
    main()
