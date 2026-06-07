"""
pipeline/generators/correlation_generator.py — Correlation cache generator.

Replaces generate_correlation_cache.py. Full port of the logic.
Reads from SQLite; writes data/cache/correlations.json.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from pipeline.base_generator import BaseGenerator
from pipeline.analysis import log_returns, align_series, rolling_pearson

CONFIG_PATH = Path("config/correlation_config.json")


class CorrelationGenerator(BaseGenerator):
    def generate(self) -> None:
        if not CONFIG_PATH.exists():
            raise FileNotFoundError("correlation_config.json not found")
        config = json.loads(CONFIG_PATH.read_text())

        windows     = config["windows"]
        history_days = config["historyDays"]
        pairs_config = config["pairs"]

        print(f"Generating correlations for {len(pairs_config)} pairs...")

        results = []
        for pair in pairs_config:
            print(f"  Processing {pair['id']}...")
            result = _process_pair(pair, windows, history_days, self.db)
            if result:
                results.append(result)
                print(f"    ✓ regime={result['current']['regime']}, primary={result['current']['primary_corr']}")
            else:
                print(f"    WARNING: skipped {pair['id']}")

        cache = {
            'generated': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'),
            'pairs': results,
        }
        self.write_cache("correlations.json", cache)
        print(f"  Written correlations.json ({len(results)} pairs)")


def _classify_regime(primary_corr: float, expected_sign: int) -> str:
    adjusted = primary_corr * expected_sign
    if adjusted > 0.2:   return "NORMAL"
    if adjusted >= -0.2: return "WEAKENING"
    return "BROKEN"


def _ts_to_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _process_pair(pair: dict, windows: dict, history_days: int, db) -> dict | None:
    sym1 = pair["asset1"]["symbol"]
    sym2 = pair["asset2"]["symbol"]

    prices1 = db.load_daily_close(sym1)
    prices2 = db.load_daily_close(sym2)
    if not prices1 or not prices2:
        print(f"    WARNING: missing data for {sym1} or {sym2}")
        return None

    ret1 = log_returns(prices1)
    ret2 = log_returns(prices2)
    aligned = align_series(ret1, ret2)

    short_w      = windows["short"]
    primary_w    = windows["primary"]
    structural_w = windows["structural"]

    if len(aligned) < primary_w:
        print(f"    WARNING: only {len(aligned)} aligned bars, need {primary_w}")
        return None

    short_corrs   = rolling_pearson(aligned, short_w)
    primary_corrs = rolling_pearson(aligned, primary_w)

    primary_ts_map = {ts: c for ts, c in primary_corrs}
    short_ts_map   = {ts: c for ts, c in short_corrs}

    common_ts = sorted(set(primary_ts_map) & set(short_ts_map))
    if not common_ts:
        return None

    # Structural stats over last structural_w bars of primary corr
    structural_slice = primary_corrs[-structural_w:] if len(primary_corrs) >= structural_w else primary_corrs
    struct_vals      = [c for _, c in structural_slice]
    struct_mean      = sum(struct_vals) / len(struct_vals)
    struct_variance  = sum((v - struct_mean) ** 2 for v in struct_vals) / len(struct_vals)
    struct_std       = math.sqrt(struct_variance)

    # Dominant sign over full history
    all_primary_vals = [c for _, c in primary_corrs]
    all_mean         = sum(all_primary_vals) / len(all_primary_vals)
    pct_positive     = sum(1 for v in all_primary_vals if v > 0) / len(all_primary_vals)
    dominant_sign    = 1 if pct_positive >= 0.5 else -1
    dominant_corr_mean = round(all_mean, 4)
    dominant_pct     = round(pct_positive * 100, 1)
    dominant_bars    = len(all_primary_vals)

    # Current values
    latest_ts       = common_ts[-1]
    current_primary = primary_ts_map[latest_ts]
    current_short   = short_ts_map[latest_ts]
    regime          = _classify_regime(current_primary, dominant_sign)

    # Days since last INTACT
    days_since_intact = None
    if regime != "NORMAL":
        as_of_dt = datetime.fromtimestamp(latest_ts, tz=timezone.utc)
        for ts, corr in reversed(primary_corrs):
            if _classify_regime(corr, dominant_sign) == "NORMAL":
                intact_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                days_since_intact = (as_of_dt - intact_dt).days
                break

    current = {
        "short_corr":       round(current_short, 4),
        "primary_corr":     round(current_primary, 4),
        "structural_mean":  round(struct_mean, 4),
        "structural_std":   round(struct_std, 4),
        "regime":           regime,
        "days_since_intact": days_since_intact,
        "as_of":            _ts_to_date(latest_ts),
    }

    history_ts = common_ts[-history_days:]
    history = [
        {
            "date":         _ts_to_date(ts),
            "short_corr":   round(short_ts_map[ts], 4),
            "primary_corr": round(primary_ts_map[ts], 4),
        }
        for ts in history_ts
    ]

    return {
        "id":               pair["id"],
        "label":            pair["label"],
        "subtitle":         pair["subtitle"],
        "expectedSign":     pair["expectedSign"],
        "dominantSign":     dominant_sign,
        "dominantCorrMean": dominant_corr_mean,
        "dominantPct":      dominant_pct,
        "dominantBars":     dominant_bars,
        "asset1":           pair["asset1"],
        "asset2":           pair["asset2"],
        "current":          current,
        "history":          history,
    }


if __name__ == '__main__':
    CorrelationGenerator().run()
