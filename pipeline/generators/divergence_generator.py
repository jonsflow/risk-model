"""
pipeline/generators/divergence_generator.py — Divergence + trend structure cache.

Replaces the divergence + trend-structure sections of generate_cache.py.
Reads from SQLite; writes data/cache/divergence_*.json + trend_structure.json.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from pipeline.base_generator import BaseGenerator
from pipeline.analysis import (
    last, calculate_ma, find_pivot_highs, find_pivot_lows,
    classify_structure, find_highest_to_current, calculate_trend,
    get_divergence_signal, aggregate_weekly,
)

LOOKBACKS   = [20, 50, 100, 200]
PIVOT_MODES = ["recent", "highest", "highest-to-current"]
SWINGS      = [2, 3, 5, 7, 10]

TREND_LOOKBACKS = {'hourly': 40, 'daily': 30, 'weekly': 13}

THRESHOLDS = {
    'breadth_strong':   0.70,
    'breadth_moderate': 0.50,
    'breadth_weak':     0.30,
}


class DivergenceGenerator(BaseGenerator):
    def generate(self) -> None:
        config_path = Path('config.json')
        if not config_path.exists():
            raise FileNotFoundError("config.json not found")
        config = json.loads(config_path.read_text())

        global THRESHOLDS
        THRESHOLDS.update(config.get('thresholds', {}))

        pairs   = config['pairs']
        symbols = config['symbols']

        # Load daily close data for all symbols in config
        all_syms = {s['symbol'].lower() for s in symbols}
        for p in pairs:
            all_syms.add(p['symbol1'].lower())
            all_syms.add(p['symbol2'].lower())

        data: dict[str, list] = {}
        for sym in all_syms:
            data[sym] = self.db.load_daily_close(sym)

        # --- Divergence caches ---
        print(f"Generating {len(LOOKBACKS)} × {len(PIVOT_MODES)} × {len(SWINGS)} divergence caches...")
        for lookback in LOOKBACKS:
            for pivot_mode in PIVOT_MODES:
                for swing in SWINGS:
                    cache = _generate_divergence(pairs, symbols, data, lookback, pivot_mode, swing)
                    fname = f"divergence_{lookback}_{pivot_mode}_{swing}.json"
                    self.write_cache(fname, cache)
        print(f"  Written {len(LOOKBACKS) * len(PIVOT_MODES) * len(SWINGS)} divergence files")

        # --- Trend structure cache ---
        print("Generating trend structure cache...")
        ts_cache = self._generate_trend_structure(config)
        self.write_cache("trend_structure.json", ts_cache)
        print("  Written trend_structure.json")

    def _generate_trend_structure(self, config: dict) -> dict:
        trend_assets = config.get('trend_assets', [])
        symbol_names = {s['symbol']: s['name'] for s in config.get('symbols', [])}

        daily_data  = {sym: self.db.load_daily_close(sym)  for sym in trend_assets}
        hourly_data = {sym: self.db.load_hourly_close(sym) for sym in trend_assets}
        weekly_data = {sym: aggregate_weekly(daily_data[sym]) for sym in trend_assets}

        source_map = {'hourly': hourly_data, 'daily': daily_data, 'weekly': weekly_data}

        timeframes: dict = {}
        for tf, lookback in TREND_LOOKBACKS.items():
            assets = []
            for sym in trend_assets:
                points = last(source_map[tf][sym], lookback)
                if len(points) < 3:
                    trend_label = 'Sideways →'
                else:
                    trend_label, _, _, _ = classify_structure(points)
                direction = 'up' if '↗' in trend_label else ('down' if '↘' in trend_label else 'sideways')
                score = 1 if direction == 'up' else (-1 if direction == 'down' else 0)
                assets.append({
                    'symbol':       sym,
                    'name':         symbol_names.get(sym, sym),
                    'trend_label':  trend_label,
                    'price_points': [[p[0], round(p[1], 4)] for p in points],
                    'score':        score,
                })
            total = sum(a['score'] for a in assets)
            timeframes[tf] = {'assets': assets, 'total_score': total, 'max_score': len(assets)}

        return {
            'generated': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'),
            'timeframes': timeframes,
        }


# ------------------------------------------------------------------
# Pure generation functions
# ------------------------------------------------------------------

def _generate_divergence(pairs, symbols, data, lookback, pivot_mode, swing) -> dict:
    generated = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

    # Risk score (MA hardcoded at 50)
    above_count = valid_total = 0
    details = []
    for sym_obj in symbols:
        sym = sym_obj['symbol'].lower()
        pts = data.get(sym, [])
        if not pts:
            continue
        ma50 = calculate_ma(pts, 50)
        if not ma50:
            continue
        valid_total += 1
        current_price = pts[-1][1]
        current_ma    = ma50[-1][1]
        label = sym_obj['symbol']
        if current_price > current_ma:
            above_count += 1
            details.append(f"{label}: Above 50 MA ✓")
        else:
            details.append(f"{label}: Below 50 MA ✗")

    pct = above_count / valid_total if valid_total else 0
    if   pct >= 0.75:  risk_signal = "🟢 STRONG RISK ON"
    elif pct >  0.50:  risk_signal = "🟡 RISK ON"
    elif pct >= 0.375: risk_signal = "⚪ NEUTRAL"
    elif pct >= 0.125: risk_signal = "🟠 RISK OFF"
    else:              risk_signal = "🔴 STRONG RISK OFF"

    # Per-pair analysis
    cache_pairs = []
    for pair in pairs:
        sym1 = pair['symbol1'].lower()
        sym2 = pair['symbol2'].lower()
        pts1 = data.get(sym1, [])
        pts2 = data.get(sym2, [])

        if not pts1 or not pts2:
            cache_pairs.append({
                'id': pair['id'], 'trend1': 'Sideways →', 'trend2': 'Sideways →',
                'signal': '⏳ No data available yet', 'pivots1': [], 'pivots2': [],
            })
            continue

        recent1 = last(pts1, lookback)
        recent2 = last(pts2, lookback)

        if pivot_mode == "highest-to-current":
            pivots1 = find_highest_to_current(recent1, swing)
            pivots2 = find_highest_to_current(recent2, swing)
            trend1 = calculate_trend(pivots1)
            trend2 = calculate_trend(pivots2)
        else:
            trend1, pivots1, _, _ = classify_structure(recent1)
            trend2, pivots2, _, _ = classify_structure(recent2)

        signal = get_divergence_signal(trend1, trend2)
        cache_pairs.append({
            'id':      pair['id'],
            'trend1':  trend1,
            'trend2':  trend2,
            'signal':  signal,
            'pivots1': [{'time': p['time'], 'price': round(p['price'], 4), 'label': p.get('label', '')} for p in (pivots1 or [])],
            'pivots2': [{'time': p['time'], 'price': round(p['price'], 4), 'label': p.get('label', '')} for p in (pivots2 or [])],
        })

    summary = _compute_divergence_summary(cache_pairs, pairs)

    return {
        'generated':  generated,
        'lookback':   lookback,
        'pivot_mode': pivot_mode,
        'swing':      swing,
        'risk_score': {
            'above_count': above_count,
            'total':       valid_total,
            'signal':      risk_signal,
            'details':     details,
        },
        'pairs':   cache_pairs,
        'summary': summary,
    }


def _compute_divergence_summary(cache_pairs, pairs_config) -> dict:
    id_to_label = {p['id']: f"{p['symbol1']} ↔ {p['symbol2']}" for p in pairs_config}
    bearish, bullish, details = [], [], []

    for p in cache_pairs:
        sig = p['signal']
        details.append({'id': p['id'], 'label': id_to_label.get(p['id'], p['id']), 'signal': sig})
        if 'BEARISH' in sig:
            bearish.append(p['id'])
        elif 'BULLISH' in sig:
            bullish.append(p['id'])

    net = len(bullish) - len(bearish)
    if bearish and bullish:   label = 'MIXED'
    elif bearish:             label = 'BEARISH'
    elif bullish:             label = 'BULLISH'
    else:                     label = 'NEUTRAL'

    return {
        'bearish_count': len(bearish),
        'bullish_count': len(bullish),
        'net_score':     net,
        'label':         label,
        'details':       details,
    }


if __name__ == '__main__':
    DivergenceGenerator().run()
