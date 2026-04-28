#!/usr/bin/env python3
"""
Generate correlation cache for the Cross-Asset Correlation Monitor.
Reads correlation_config.json, computes rolling Pearson correlations
from daily CSVs, and writes data/cache/correlations.json.

Stdlib only + cache_utils.load_daily_csv.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from cache_utils import load_daily_csv

CONFIG_PATH = Path("correlation_config.json")
OUTPUT_PATH = Path("data/cache/correlations.json")


def log_returns(prices):
    """Convert [(timestamp, close), ...] to [(timestamp, log_return), ...] starting at index 1."""
    result = []
    for i in range(1, len(prices)):
        prev = prices[i - 1][1]
        curr = prices[i][1]
        if prev > 0 and curr > 0:
            result.append((prices[i][0], math.log(curr / prev)))
    return result


def align_series(returns1, returns2):
    """Inner join two [(timestamp, value), ...] lists on timestamp."""
    map2 = {ts: v for ts, v in returns2}
    aligned = [(ts, v, map2[ts]) for ts, v in returns1 if ts in map2]
    aligned.sort(key=lambda x: x[0])
    return aligned  # [(ts, r1, r2), ...]


def rolling_pearson(aligned, window):
    """
    Compute rolling Pearson correlation over a sliding window.
    Returns [(ts, corr), ...] for each bar where a full window is available.
    O(n * w) — fine for ~1500 rows × small windows.
    """
    result = []
    n = len(aligned)
    for i in range(window - 1, n):
        xs = [aligned[j][1] for j in range(i - window + 1, i + 1)]
        ys = [aligned[j][2] for j in range(i - window + 1, i + 1)]
        ts = aligned[i][0]

        mean_x = sum(xs) / window
        mean_y = sum(ys) / window

        cov = sum((xs[k] - mean_x) * (ys[k] - mean_y) for k in range(window))
        var_x = sum((xs[k] - mean_x) ** 2 for k in range(window))
        var_y = sum((ys[k] - mean_y) ** 2 for k in range(window))

        denom = math.sqrt(var_x * var_y)
        corr = cov / denom if denom > 1e-12 else 0.0
        # Clamp to [-1, 1] for floating-point safety
        corr = max(-1.0, min(1.0, corr))
        result.append((ts, corr))

    return result


def classify_regime(primary_corr, expected_sign):
    """Return NORMAL / WEAKENING / BROKEN based on sign-adjusted correlation.

    adjusted > 0.2:  relationship is in its expected direction — NORMAL
    -0.2 to 0.2:     relationship near zero, losing direction — WEAKENING
    < -0.2:          relationship has reversed from expected — BROKEN
    """
    adjusted = primary_corr * expected_sign
    if adjusted > 0.2:
        return "NORMAL"
    if adjusted >= -0.2:
        return "WEAKENING"
    return "BROKEN"


def ts_to_date(ts):
    """Convert UTC timestamp (seconds) to YYYY-MM-DD string."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def process_pair(pair, windows, history_days):
    sym1 = pair["asset1"]["symbol"]
    sym2 = pair["asset2"]["symbol"]

    prices1 = load_daily_csv(sym1)
    prices2 = load_daily_csv(sym2)

    if not prices1 or not prices2:
        print(f"  WARNING: missing data for {sym1} or {sym2}, skipping pair {pair['id']}")
        return None

    ret1 = log_returns(prices1)
    ret2 = log_returns(prices2)

    aligned = align_series(ret1, ret2)

    short_w = windows["short"]
    primary_w = windows["primary"]
    structural_w = windows["structural"]

    if len(aligned) < primary_w:
        print(f"  WARNING: only {len(aligned)} aligned bars for {pair['id']}, need {primary_w}")
        return None

    short_corrs = rolling_pearson(aligned, short_w)
    primary_corrs = rolling_pearson(aligned, primary_w)

    # Align short and primary to the same timestamps (primary starts later)
    primary_ts_map = {ts: c for ts, c in primary_corrs}
    short_ts_map = {ts: c for ts, c in short_corrs}

    # Build history: last history_days bars where both series overlap
    common_ts = sorted(set(primary_ts_map) & set(short_ts_map))
    if not common_ts:
        print(f"  WARNING: no overlapping bars for {pair['id']}")
        return None

    # Structural mean/std over last structural_w bars of primary corr
    structural_slice = primary_corrs[-structural_w:] if len(primary_corrs) >= structural_w else primary_corrs
    struct_vals = [c for _, c in structural_slice]
    struct_mean = sum(struct_vals) / len(struct_vals)
    struct_variance = sum((v - struct_mean) ** 2 for v in struct_vals) / len(struct_vals)
    struct_std = math.sqrt(struct_variance)

    # Dominant sign: what direction has the correlation actually spent most of its time?
    # Uses full primary_corrs history (all available data, not just display window).
    all_primary_vals = [c for _, c in primary_corrs]
    all_mean = sum(all_primary_vals) / len(all_primary_vals)
    pct_positive = sum(1 for v in all_primary_vals if v > 0) / len(all_primary_vals)
    dominant_sign = 1 if pct_positive >= 0.5 else -1
    dominant_corr_mean = round(all_mean, 4)
    dominant_pct = round(pct_positive * 100, 1)  # % of time correlation was positive
    dominant_bars = len(all_primary_vals)  # trading days used for dominant sign calc

    # Current bar values (latest common timestamp)
    latest_ts = common_ts[-1]
    current_primary = primary_ts_map[latest_ts]
    current_short = short_ts_map[latest_ts]
    expected_sign = pair["expectedSign"]
    # Use dominantSign for regime classification — data-derived, not hardcoded
    regime = classify_regime(current_primary, dominant_sign)

    # Days since last INTACT — scan full primary_corrs history (not just display window)
    days_since_intact = None
    if regime != "NORMAL":
        as_of_dt = datetime.fromtimestamp(latest_ts, tz=timezone.utc)
        for ts, corr in reversed(primary_corrs):
            if classify_regime(corr, dominant_sign) == "NORMAL":
                intact_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                days_since_intact = (as_of_dt - intact_dt).days
                break

    current = {
        "short_corr": round(current_short, 4),
        "primary_corr": round(current_primary, 4),
        "structural_mean": round(struct_mean, 4),
        "structural_std": round(struct_std, 4),
        "regime": regime,
        "days_since_intact": days_since_intact,
        "as_of": ts_to_date(latest_ts),
    }

    # History: last history_days bars
    history_ts = common_ts[-history_days:]
    history = [
        {
            "date": ts_to_date(ts),
            "short_corr": round(short_ts_map[ts], 4),
            "primary_corr": round(primary_ts_map[ts], 4),
        }
        for ts in history_ts
    ]

    return {
        "id": pair["id"],
        "label": pair["label"],
        "subtitle": pair["subtitle"],
        "expectedSign": pair["expectedSign"],
        "dominantSign": dominant_sign,
        "dominantCorrMean": dominant_corr_mean,
        "dominantPct": dominant_pct,
        "dominantBars": dominant_bars,
        "asset1": pair["asset1"],
        "asset2": pair["asset2"],
        "current": current,
        "history": history,
    }


def main():
    if not CONFIG_PATH.exists():
        print(f"ERROR: {CONFIG_PATH} not found")
        return

    with CONFIG_PATH.open() as f:
        config = json.load(f)

    windows = config["windows"]
    history_days = config["historyDays"]
    pairs_config = config["pairs"]

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    results = []
    for pair in pairs_config:
        print(f"Processing {pair['id']}...")
        result = process_pair(pair, windows, history_days)
        if result:
            results.append(result)
            print(f"  ✓ {pair['id']}: regime={result['current']['regime']}, "
                  f"primary={result['current']['primary_corr']}, "
                  f"as_of={result['current']['as_of']}")

    output = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "pairs": results,
    }

    with OUTPUT_PATH.open("w") as f:
        json.dump(output, f, separators=(",", ":"))

    print(f"\n✓ Wrote {len(results)} pairs → {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
