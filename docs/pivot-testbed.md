# Pivot Detection Testbed

`test.html` / `test.js` is an interactive visual testbed for comparing pivot detection algorithms on SPY daily data. Use it to evaluate candidate algorithms before promoting one to `generate_cache.py`.

## Running It

```bash
python3 -m http.server 8000
# then open http://localhost:8000/test.html
```

File access via `file://` will fail due to CORS — the local server is required.

## Controls

| Control | Description |
|---------|-------------|
| Lookback dropdown | How many days of SPY data to show (20 / 50 / 100) |
| Pivot mode dropdown | Which detection algorithm to use |
| Param input | Algorithm-specific parameter (disabled for Fixed N modes) |

Changing any control immediately re-renders the chart with updated pivot labels.

## Detection Modes

### Fixed N=1 (default)
A bar is a pivot high/low if it beats **both immediate neighbors** (N=1 on each side). This is the current production logic in `generate_cache.py`. Use it as the baseline.

- **Param**: none
- **Tendency**: sensitive — labels every minor wiggle in choppy markets

### Fixed N=2
Same as Fixed N=1 but requires the bar to beat the **2 neighbors on each side**. Produces fewer, stronger pivots.

- **Param**: none
- **Tendency**: cleaner in trending markets, may miss real turns in tight ranges

### ZigZag %
Tracks a running directional leg. Only records a pivot when price reverses by at least `pct`% from the current leg's extreme. Immune to bar-by-bar noise.

- **Param**: reversal threshold in percent (default `1.5`)
- **Tendency**: no clustering; fewer pivots; param-sensitive — too low = noisy, too high = misses moves

### ATR-based
Computes a 14-period ATR (close-to-close), derives N as `round((ATR / medianBarMove) × multiplier)`, then runs Fixed-N with that adaptive window. Quiet regimes get a tight N; volatile regimes get a wider N.

- **Param**: multiplier (default `1.0`)
- **Tendency**: self-adjusting; useful when volatility regime changes across the lookback window

### Prominence %
Starts from all N=1 pivots, then filters to only those where the pivot stands out by at least `pct`% from the nearest opposing extreme within a ±5 bar window. Structural turns survive; micro-wiggles are dropped.

- **Param**: prominence threshold in percent (default `0.5`)
- **Tendency**: retains timing of N=1 detection but cuts noise; tweak the window size in code if needed

## Pivot Labels

All modes feed into the same HH/LH/HL/LL labeling loop:

| Label | Meaning | Color |
|-------|---------|-------|
| HH | Higher High | teal |
| LH | Lower High | orange |
| HL | Higher Low | green |
| LL | Lower Low | red |

The sequence of these labels is what the divergence model reads — a clean, non-repetitive sequence is what you're looking for.

## What to Look For

A good algorithm for production should:

1. **Not cluster** — avoid 3+ pivots of the same type in a row with no opposing pivot between them
2. **Catch real turns** — major swing highs/lows on the chart should have a pivot marker
3. **Be stable under lookback change** — switching 20d → 50d → 100d shouldn't dramatically flip which pivots appear in the overlapping window
4. **Produce a readable HH/LH/HL/LL sequence** — the label series should tell a coherent market structure story

## Promoting a Winner to Production

Once you settle on an algorithm:

1. Port the detection function into `generate_cache.py` (replace or augment `find_pivots()`)
2. Run `python3 generate_cache.py` to regenerate all cache files
3. Verify the divergence dashboard (`index.html`) renders correctly
4. Commit source files only — cache files are handled by the GitHub Actions workflow
