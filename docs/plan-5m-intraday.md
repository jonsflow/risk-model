# Plan — Add 5-Minute Intraday Collection

**Branch:** `feat/intraday-5m`
**Status:** planning (no code written yet)
**Owner:** clutchcoder + Claude

This plan is written to survive a context reset. A fresh session should be able to pick up cold from this file plus `CLAUDE.md`.

---

## Goal

Add 5-minute OHLCV collection for the 9 trading-page symbols so intraday-sensitive metrics (ORB, VWAP, pre-market range) run on real ranges instead of a single hourly bar. Hourly stays in place for the metrics that legitimately need a multi-day window.

## Locked-in decisions (from the review session)

- **Symbol scope: trading-9 only** — SPY, QQQ, IWM, SMH, BTC, ETH, GLD, SLV, USO. Not the full 45-symbol universe.
- **Both cron runs fetch 5m** — 14:00 UTC refreshes overnight + pre-market bars; 21:00 UTC fills the RTH session.
- **Keep hourly alongside 5m** — don't rip it out. Multi-day hourly features (squeeze over ~3 days, hourly RSI divergence) stay on 1h.
- **Migrate to 5m**: ORB, pre-market range, VWAP.
- **Stay on 1h**: squeeze, RSI divergence, alignment.
- **Include pre/post-market** (`prepost=True`), matching current hourly behavior.

## Yahoo API constraints (verified before planning)

- `interval='5m'` capped at `period='60d'` lookback. Fresh-clone edge case only; incremental (`start=<last ts>`) is unaffected after that.
- RTH 5m = 78 bars/day. With pre/post (04:00–20:00) ≈ 192 bars/day.
- 9 symbols × 192 × ~22 trading days ≈ 38k rows/month. Trivial for SQLite.

## Non-goals

- No 1m or 15m collection.
- No expansion of the trading universe.
- No change to the FRED pipeline.
- No change to daily fetch cadence or lookback.
- No touching macro / divergence / correlation generators (they don't consume intraday).
- No yfinance batching or rate-limit refactor as part of this PR — flag as follow-up.

---

## Implementation steps

Each step lists a success check. Do not advance to the next step until the check passes.

### Step 1 — SQLite schema

- [ ] Confirm the `prices` table's `grain` column accepts arbitrary strings (grep `pipeline/db_manager.py`). It does today for `'daily'` and `'hourly'`; `'5m'` should slot in with no migration.
- [ ] Add `last_5m_timestamp(symbol)` helper mirroring `last_hourly_timestamp` in `db_manager.py`.
- [ ] Add `load_5m_ohlcv(symbol)` helper mirroring `load_hourly_ohlcv`.
- **Success check:** `python3 -c "from pipeline.db_manager import DBManager; d=DBManager(); print(d.last_5m_timestamp('SPY'))"` returns `None` without errors.

### Step 2 — Yahoo fetcher

- [ ] In `pipeline/fetchers/yahoo_fetcher.py`, add `_fetch_5m(symbol, ticker)` mirroring `_fetch_hourly` but with `interval='5m'`, initial `period='60d'`, `prepost=True`.
- [ ] Load the trading-9 subset from `config/trading_config.json` inside the fetcher; call `_fetch_5m` only for those symbols (loop over the trading subset after the existing daily+hourly loop, or gate inside `_fetch_symbol`).
- [ ] Insert with `grain='5m'`.
- **Success check:** running `python3 -m pipeline.run fetch` locally logs `5m SPY: N bars stored` for each of the 9 symbols with N ≥ 1000 on a fresh fetch.

### Step 3 — Verify data landed

- [ ] Query SQLite: `SELECT COUNT(*), MIN(ts), MAX(ts) FROM prices WHERE symbol='SPY' AND grain='5m'`.
- [ ] Confirm timestamps are UTC epoch seconds aligned to `:00`, `:05`, `:10`, … (5-min boundaries).
- [ ] Confirm pre/post-market bars are present (bars outside 09:30–16:00 ET).
- **Success check:** SPY row count roughly matches (60 days × ~192 bars/day = ~11.5k) on first fetch.

### Step 4 — Wire 5m into trading generator

Migrate three metrics; leave the rest alone.

- [ ] `_get_session_bars` already takes any hourly-shape list. Add a `_load_5m` call and pass those bars to:
  - `_compute_premarket_metrics` (currently uses hourly)
  - VWAP anchor (`_calculate_vwap`)
  - ORB detection in `_calculate_eod_outcomes` (currently first hourly bar of 09:30–10:30)
- [ ] Leave `_calculate_squeeze` and `_calculate_rsi_divergence` on hourly.
- [ ] ORB definition on 5m: first 12 bars (09:30–10:30). Verify high/low aggregation is unchanged.
- **Success check:** `python3 -m pipeline.run generate` produces `trading_signals.json` where SPY's ORB high/low differ from the previous single-hourly-bar values, and pre-market range shows a real high–low delta rather than one bar's range.

### Step 5 — Update trade page copy

- [ ] `js/pages/trade.js` — header window labels (`renderHeader`) currently show `Opening range 10:00–10:00 ET`. Update the label to reflect 5m granularity; the underlying data will now show the real 30-min or 60-min window.
- [ ] No JSON schema changes — the cache still emits `orb_high` / `orb_low` etc.; only the values differ.
- **Success check:** Load `/pages/trade.html` locally; opening-range window label reads correctly and the ORB card in EOD Section 5 shows sensible levels.

### Step 6 — Workflow

- [ ] The workflow already runs `pipeline.run fetch` — no YAML change needed since `YahooFetcher.run()` now covers 5m internally.
- [ ] Confirm the workflow's 60-day incremental window works: after 60 days without a run (unlikely), `start=<last_ts>` still returns data.
- **Success check:** Trigger workflow manually via `gh workflow run`; verify commit shows `5m` bars in the SQLite mirror (or absence of errors in the run log).

### Step 7 — Docs

- [ ] Update `CLAUDE.md`:
  - Add `5m` grain to the Yahoo Finance section.
  - Note the trading-9 subset scope.
  - Add a "Common Gotcha" for the 60-day cap.
- [ ] Update `README.md` timeframes table — add `5m` row with lookback + scope.
- [ ] Delete this plan file (`docs/plan-5m-intraday.md`) — its job ends when the PR merges.

## Rollback

Single-commit revert on the fetcher change is safe: with no `_fetch_5m` call, no rows land under `grain='5m'` and generators fall back to hourly (assuming Step 4 is guarded — see risk note below).

## Risks + guards

- **Yahoo rate limiting.** 9 extra `Ticker.history()` calls per run is small. Skip proactive backoff; add if observed.
- **Timestamp alignment.** Yahoo 5m timestamps are in UTC via `Datetime` column, matching the hourly code path. If we see silent misalignment (bar-labeled-as-close vs bar-labeled-as-open), spot-check against Yahoo's public page for one symbol before merging.
- **Squeeze regression.** If Step 4 accidentally routes squeeze/RSI-divergence to 5m, it changes meaning silently. Guard: leave the `_calculate_squeeze(hourly_points)` call as-is and only swap the inputs to the three named metrics.
- **Generator falls over for a symbol that has no 5m yet.** Add a graceful fallback: if `load_5m_ohlcv(sym)` returns empty, generator uses hourly for those three metrics too. This lets any non-trading-9 symbol still generate.

## Deferred to follow-up PRs

- `yfinance.download()` batching for the daily/hourly loop (efficiency).
- Optional 5m for macro/correlation universe (probably not worth the storage).
- 1m fetch for pure ORB (7-day lookback limit; different design).

---

## Session handoff

If a future session lands here cold:

1. Confirm the branch: `git branch --show-current` should say `feat/intraday-5m`.
2. Confirm nothing has been committed toward this yet: `git log main..HEAD` should be empty.
3. Read this file top to bottom; then start at Step 1.
4. Do not skip the success checks — they exist because I'm not there to catch a bad assumption.
