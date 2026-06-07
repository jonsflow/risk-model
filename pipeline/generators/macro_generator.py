"""
pipeline/generators/macro_generator.py — Macro model cache generator.

Replaces the macro section of generate_cache.py.
Reads from SQLite; writes data/cache/macro_{lookback}_{maPeriod}.json.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from pipeline.base_generator import BaseGenerator
from pipeline.analysis import last, calculate_ma

LOOKBACKS  = [20, 50, 100, 200]
MA_PERIODS = [20, 50, 100]

THRESHOLDS = {
    'breadth_strong':   0.70,
    'breadth_moderate': 0.50,
    'breadth_weak':     0.30,
}


class MacroGenerator(BaseGenerator):
    def generate(self) -> None:
        macro_path = Path('macro_config.json')
        if not macro_path.exists():
            raise FileNotFoundError("macro_config.json not found")
        macro_config = json.loads(macro_path.read_text())

        config_path = Path('config.json')
        if config_path.exists():
            cfg = json.loads(config_path.read_text())
            THRESHOLDS.update(cfg.get('thresholds', {}))

        categories      = macro_config['macro_categories']
        regime_signals  = macro_config.get('regime_signals', [])

        # Load all unique symbols
        all_syms: set[str] = set()
        for cat in categories:
            for a in cat['assets']:
                all_syms.add(a['symbol'].lower())
        for sym in regime_signals:
            all_syms.add(sym.lower())
        # Extra derived symbols
        all_syms.update({'tip', 'tlt'})

        data: dict[str, list] = {}
        for sym in all_syms:
            data[sym] = self.db.load_daily_close(sym)

        print(f"Generating {len(LOOKBACKS)} × {len(MA_PERIODS)} macro caches...")
        count = 0
        for lookback in LOOKBACKS:
            for ma_period in MA_PERIODS:
                cache = _generate_macro(categories, data, lookback, ma_period, regime_signals)
                self.write_cache(f"macro_{lookback}_{ma_period}.json", cache)
                count += 1
        print(f"  Written {count} macro cache files")


# ------------------------------------------------------------------
# Pure generation functions (ported verbatim from generate_cache.py)
# ------------------------------------------------------------------

def _generate_macro(categories, data, lookback, ma_period, regime_signals=None) -> dict:
    generated = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

    cache_categories = []
    total_above = total_count = 0
    signal_map: dict = {}

    for cat in categories:
        invert = cat.get('invert', False)
        cat_above = cat_total = regime_above = regime_total = 0
        cat_assets = []
        cat_signals: dict = {}

        for asset in cat['assets']:
            sym = asset['symbol'].lower()
            pts = data.get(sym, [])

            if len(pts) < 2:
                cat_assets.append({
                    'symbol': asset['symbol'], 'name': asset.get('name', asset['symbol']),
                    'price': None, 'pct_change': None, 'above_ma': None,
                    'ma_value': None, 'price_points': [], 'ma_points': [],
                })
                continue

            ma_pts        = calculate_ma(pts, ma_period)
            current_price = pts[-1][1]
            prev_price    = pts[-2][1]
            pct_change    = ((current_price - prev_price) / prev_price * 100) if prev_price else None
            current_ma    = ma_pts[-1][1] if ma_pts else None
            above_ma      = (current_price > current_ma) if current_ma is not None else None

            signal_map[asset['symbol']] = above_ma
            cat_signals[asset['symbol']] = above_ma

            if above_ma is not None:
                cat_total += 1
                if above_ma:
                    cat_above += 1
                regime_total += 1
                counts_as_above = (not above_ma) if invert else above_ma
                if counts_as_above:
                    regime_above += 1

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
            'theme':    _derive_category_theme(cat['id'], cat_signals),
            'leaders':  leaders,
            'laggards': laggards,
            'assets':   cat_assets,
        })

    for sym in (regime_signals or []):
        pts = data.get(sym.lower(), [])
        if len(pts) >= ma_period:
            ma_pts = calculate_ma(pts, ma_period)
            if ma_pts:
                signal_map[sym] = pts[-1][1] > ma_pts[-1][1]

    # TIPS spread
    tip_pts = data.get('tip', [])
    tlt_pts = data.get('tlt', [])
    if tip_pts and tlt_pts:
        tip_dict = {p[0]: p[1] for p in tip_pts}
        tlt_dict = {p[0]: p[1] for p in tlt_pts}
        common = sorted(set(tip_dict) & set(tlt_dict))
        ratio_pts = [(d, tip_dict[d] / tlt_dict[d]) for d in common if tlt_dict[d] != 0]
        if len(ratio_pts) >= ma_period:
            ratio_ma = calculate_ma(ratio_pts, ma_period)
            if ratio_ma:
                signal_map['TIPS_SPREAD'] = ratio_pts[-1][1] > ratio_ma[-1][1]

    pct = total_above / total_count if total_count > 0 else 0
    if   pct >= 0.70:  regime_label = '🟢 STRONG RISK ON'
    elif pct >= 0.55:  regime_label = '🟡 RISK ON'
    elif pct >= 0.45:  regime_label = '⚪ NEUTRAL'
    elif pct >= 0.25:  regime_label = '🟠 RISK OFF'
    else:              regime_label = '🔴 STRONG RISK OFF'

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
        'regime_card': _compute_regime_card(signal_map),
        'signal_map':  {k: bool(v) for k, v in signal_map.items() if v is not None},
        'categories':  cache_categories,
    }


def _derive_category_theme(cat_id: str, signals: dict) -> str:
    above = {s for s, v in signals.items() if v is True}

    if cat_id == 'us-sectors':
        defensive = {'XLV', 'XLP', 'XLU', 'XLRE'}
        cyclical  = {'XLK', 'XLF', 'XLY', 'XLC'}
        value     = {'XLE', 'XLI', 'XLB'}
        d, c, v = len(above & defensive), len(above & cyclical), len(above & value)
        if d + c + v == 0:          return 'Broad weakness'
        if d > c and d > v:         return 'Defensive rotation'
        if v > c and v > d:         return 'Value / reflation'
        if c > d and ('XLK' in above or 'XLC' in above): return 'Growth / tech led'
        if c > d:                   return 'Cyclical rotation'
        return 'Mixed'

    elif cat_id == 'fixed-income':
        if {'TLT', 'IEF'} <= above and not (above & {'HYG', 'LQD'}): return 'Flight to quality'
        if {'HYG', 'LQD'} <= above and 'TLT' not in above:           return 'Risk-on credit'
        if 'TIP' in above and 'TLT' not in above:                     return 'Inflation breakout'
        if not above:                                                  return 'Broad weakness'
        return 'Mixed signals'

    elif cat_id == 'commodities':
        precious = {'GLD', 'SLV', 'CPER'}
        energy   = {'USO', 'UNG'}
        p, e = len(above & precious), len(above & energy)
        total = len([v for v in signals.values() if v is not None])
        pct   = len(above) / total if total else 0
        if pct >= THRESHOLDS['breadth_strong']: return 'Broad inflation bid'
        if p >= 2 and e == 0: return 'Precious metals bid'
        if e >= 1 and p == 0: return 'Energy led'
        if not above:         return 'Broad weakness'
        return 'Mixed'

    elif cat_id == 'currencies':
        uup = signals.get('UUP')
        if uup is True:  return 'Dollar strength'
        if uup is False: return 'Dollar weakness'
        return 'Mixed'

    elif cat_id == 'volatility':
        if above & {'VIX', 'UVXY', 'VIXY'}: return 'Elevated vol'
        return 'Vol suppressed'

    elif cat_id == 'crypto':
        btc, eth = signals.get('BTC'), signals.get('ETH')
        if btc and eth:         return 'Risk-on'
        if not btc and not eth: return 'Risk-off'
        return 'Diverging'

    elif cat_id == 'international':
        em = len(above & {'EEM', 'FXI'})
        dm = 1 if signals.get('EFA') else 0
        total = len([v for v in signals.values() if v is not None])
        if len(above) == total and total > 0: return 'Global strength'
        if not above:  return 'Global weakness'
        if em > dm:    return 'EM outperforming'
        if dm > em:    return 'DM outperforming'
        return 'Mixed'

    elif cat_id == 'us-equities':
        total = len([v for v in signals.values() if v is not None])
        pct   = len(above) / total if total else 0
        spy, iwm = signals.get('SPY'), signals.get('IWM')
        if pct >= THRESHOLDS['breadth_strong']:                       return 'Broad strength'
        if pct >= THRESHOLDS['breadth_moderate'] and spy and not iwm: return 'Large-cap led'
        if pct >= THRESHOLDS['breadth_moderate'] and iwm and not spy: return 'Small-cap led'
        if pct >= THRESHOLDS['breadth_moderate']:                     return 'Moderate strength'
        if pct <= THRESHOLDS['breadth_weak']:                         return 'Broad weakness'
        return 'Mixed'

    else:
        total = len([v for v in signals.values() if v is not None])
        pct   = len(above) / total if total else 0
        if pct >= THRESHOLDS['breadth_strong']:   return 'Strong'
        if pct >= THRESHOLDS['breadth_moderate']: return 'Moderate'
        if pct <= THRESHOLDS['breadth_weak']:     return 'Weak'
        return 'Mixed'


def _score_pct(defs: list) -> tuple:
    signals_out = [{'label': label, 'firing': None if cond is None else bool(cond), 'weight': w}
                   for label, cond, w in defs]
    available = [(cond, w) for _, cond, w in defs if cond is not None]
    total_w   = sum(w for _, w in available)
    fire_w    = sum(w for c, w in available if c)
    pct       = round(fire_w / total_w * 100) if total_w > 0 else 0
    return round(fire_w, 2), round(total_w, 2), pct, signals_out


def _compute_regime_card(signal_map: dict) -> dict:
    g = signal_map.get
    tlt = g('TLT')
    tlt_below = (not tlt) if tlt is not None else None
    xly, xlp = g('XLY'), g('XLP')
    disc_over_staples = (bool(xly) and not xlp) if (xly is not None and xlp is not None) else None

    growth_defs = [
        ('HYG',     g('HYG'),          2.0),
        ('IWM',     g('IWM'),          1.5),
        ('SPY',     g('SPY'),          1.0),
        ('EEM',     g('EEM'),          1.0),
        ('EMB',     g('EMB'),          1.0),
        ('XLY>XLP', disc_over_staples, 1.0),
        ('USD/JPY', g('USDJPY'),       1.0),
    ]
    inflation_defs = [
        ('TIP',    g('TIP'),          2.0),
        ('TLT↓',   tlt_below,         1.5),
        ('GLD',    g('GLD'),          1.0),
        ('USO',    g('USO'),          1.0),
        ('DBC',    g('DBC'),          1.0),
        ('TIP/TLT', g('TIPS_SPREAD'), 1.5),
    ]

    gs, gmax, gpct, gsigs = _score_pct(growth_defs)
    is_, imax, ipct, isigs = _score_pct(inflation_defs)

    if   gpct >= 50 and ipct <  50: quadrant = '🟢 GOLDILOCKS'
    elif gpct >= 50 and ipct >= 50: quadrant = '🟡 INFLATIONARY BOOM'
    elif gpct <  50 and ipct <  50: quadrant = '🔵 RECESSION / DEFLATION'
    else:                           quadrant = '🔴 STAGFLATION'

    flags = {
        'carry_risk':       not signal_map.get('USDJPY', True) and bool(signal_map.get('UVXY') or signal_map.get('VIXY')),
        'inflation_regime': ipct >= 60,
        'credit_stress':    not signal_map.get('HYG', True) and not signal_map.get('LQD', True),
        'china_divergence': signal_map.get('FXI') != signal_map.get('SPY'),
        'vol_spike':        bool(signal_map.get('UVXY') or signal_map.get('VIXY')),
    }

    return {
        'quadrant':  quadrant,
        'growth':    {'score': gs,  'max': gmax, 'pct': gpct, 'signals': gsigs},
        'inflation': {'score': is_, 'max': imax, 'pct': ipct, 'signals': isigs},
        'flags':     flags,
    }


if __name__ == '__main__':
    MacroGenerator().run()
