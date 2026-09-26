# Trading Stages Plan

Captures the decisions from the 2026-09-23 review of the trade page and
`pipeline/generators/trading_generator.py`. Requirements only — the high-level
design comes next, after reviewing this against the current code.

## Why

- **Morning call is not stable.** The post-close run recomputes it from data the
  morning never had. Sep 23: day grade B at the morning run, A at the post-close
  run (4 → 5). The morning call must be what we were advised, so the recap can
  judge whether the advice was good.
- **Page blank until the day's run lands.** On load, `trade.js` reads
  `trading_signals.json` but only renders it when its SPY date equals today;
  otherwise it requests `trading_signals_<today>.json`, which doesn't exist yet.
  Changing the symbol dropdown renders it. Fix drafted on branch
  `fix/trade-load-today` (uncommitted); superseded if the page moves to loading
  by date.
- **Scheduled runs late.** Since GitHub's 2026-08-26 Actions incident the 09:00 ET
  run has started ~12:45–14:30 ET. A comment-only workflow edit (PR #47) was
  merged to test whether re-registering the schedule helps. Longer term: run our
  own scheduler and push to GitHub. Out of scope here — the code assumes the
  data is there.

## Principles

1. **Each stage has a hard data cutoff.** It reads only data before its cutoff,
   regardless of when it runs — live, late, or in a backfill. Recomputing a stage
   always gives the same answer, so nothing has to be frozen.
2. **Stages never overwrite each other.** Later stages add their section; they
   do not recompute or replace earlier ones.
3. **Daily bars are for structure, and only closed ones.** Today's daily bar is
   never read before the session closes.
4. **Same-day information comes from intraday bars** (5-min, hourly), sliced to
   the stage's cutoff.
5. **Hourly structure is a cross-check on daily structure.** Flag when they
   contradict.

## Data available

| Data | Table | Coverage |
|---|---|---|
| Daily bars (`session_date`, `is_complete`) | `prices_daily` | Full history |
| Hourly bars, incl. pre/post | `prices_hourly` | Stored since Jun 2026 (Yahoo serves ~1 mo) |
| 5-min bars, incl. pre/post from 04:00 ET | `prices_5m` | Stored since Apr 8 2026 (Yahoo serves ~60 d) |

VIX has daily and hourly, no 5-min. Backfills before Apr 8 2026 have no 5-min.

## Stages (decided)

| Section | Published | Data cutoff | Captures |
|---|---|---|---|
| **Premarket** | 09:00 ET | Closed daily + 5-min before 09:00 | Day grade, regime (daily trend + ATR trend), hourly vs daily structure, gap, premarket range, VIX, watchlist (gap setups; engulfing / outside day from the last closed bar) |
| **Open** | 09:35 ET | + first 5-min bar | First 5-min bar (O/H/L/C), gap vs prior close, gap fill / continuation signals. Recorded for later assessment — no targets. |
| **Opening range** | 09:30 + N min | + 5-min through the range | OR high/low, ORB qualification, targets, index alignment, confluence, sizing |
| **Recap** | After close | Full session, daily bar closed | Each section's calls graded against what happened |

- **One opening range**, 30 minutes by default, length set in config.
- **Config-driven timings** in `config/trading_config.json`: premarket cutoff
  (`09:00`), open bar (`5` min), opening range (`30` min).
- **Index alignment moves out of regime** into the opening-range stage (the
  rules check it at 10:00). Regime = daily trend + ATR trend only, premarket.
- **One dated cache per session**, `trading_signals_<date>.json`, one section per
  stage; a stage whose data doesn't exist yet is empty. Replaces the `phase`
  stamp and the date-mismatch logic.
- **Pages:** one live page updated through the day (sections appear as their
  stage lands), and a recap page. Both load by date.

## Current code vs. the stages

Audit of `trading_generator.py` as of 2026-09-23. ✗ = reads same-day data in the
morning call.

| Current step | Input | Uses today | Should use |
|---|---|---|---|
| 1 Day grade | Gap | Prior close + 5-min 09:30 open, else first bar of day ✗ | Prior close → last 5-min print before cutoff |
| | Premarket range | 5-min 08:00–09:30 | 5-min before 09:00 cutoff |
| | Structure | Regime label ✗ | Regime (daily only) |
| | Range trend 8d/20d | Prior daily | No change |
| | Index alignment | Hourly, today 09:30–16:00 ✗ | Opening-range stage |
| | VIX | Prior daily; today's bar at EOD ✗ | Closed daily + latest hourly before cutoff |
| | Vol regime | Daily incl. latest bar ✗ | Closed daily ATR |
| 2 Regime | MA20, ATR trend, day type | Prior daily | No change |
| | Index alignment flag | Hourly first→last over whole window (~1 mo) | Replace with hourly structure |
| | Expansion | 5-min premarket + gap; today's daily bar at EOD ✗ | Premarket only; realized range → recap |
| 3 Patterns | Gap, engulfing, outside day, ATR | Latest daily bar (today's once it exists) ✗ | Last closed daily bar + 5-min premarket |
| | Opening range | 5-min 09:30–10:30 ✗ (rules: 09:30–10:00) | Opening-range stage, N min from config |
| 4 Confluence | RSI, MACD, MA20, volume, squeeze | Prior daily / prior hourly | No change; moves to opening-range stage |
| | Day grade, regime match | Leaks via steps 1–2 ✗ | Fixed upstream |
| 5 Plan & sizing | Entry | Pattern levels from latest daily bar ✗ | Fixed upstream |
| | Stop/target distances | Prior daily ATR | No change |
| EOD | Outcomes, realized grade | Closed daily bar + 5-min session | No change; becomes recap |

## Open items

- How to use the first 5-min bar for later assessment (logic comes later).
- Whether the opening-range stage adds a gap-fill retest signal.
- Whether a mid-morning stage should carry signals beyond the opening range.
- Symbol dropdown: Steps 1–2 are SPY-only by design but sit above the per-symbol
  steps, so switching symbols looks like it does nothing.

## Decisions since the review (2026-09-23 → 09-25)

- **Terminology:** a stage has a *window end*, not a cutoff. Config key
  `premarket_window_end`; each section carries `window_end`.
- **Append-only day file.** A stage is calculated once and appended to
  `trading_signals_<date>.json`. Later stages never recalculate earlier ones;
  they may read the results already written. Only a backfill goes backwards.
- **Each stage scores its own calls.** Premarket scores its watchlist;
  opening range scores only its ORB setups; recap grades the earlier calls
  from their stored results.
- **Missing data is handled gracefully.** A stage whose data isn't there gets
  `{status: "not_available", window_end, message}`; the pages show the
  message and no data for that stage.
- **Scope is the last 60 days** (Yahoo's 5-min window). Nothing older is our
  responsibility.
- **Workflows are assumed to run on time**, just after each window end.

## Code design

### Built and committed (`feat/trading-stages`, 7f2f782b)

- `Stage(name, label, window_end, timeframes)` — built by
  `Stage.all_from_config`. Premarket reads daily/1h/5m; open, opening range and
  recap read daily/5m.
- `PriceHistory.load(db, symbols, through)` — every bar loaded once, keyed
  symbol → timeframe → bars; holds `session_date`.
- `PriceHistory.get_time_series(symbol, stage=None)` — no stage: all bars, all
  timeframes. With a stage: if every collected timeframe is there through the
  window end, each timeframe cut to bars that ended by it; otherwise
  `available=False`. A daily bar ends at its session's close once complete.
  Timeframes never collected for a symbol (VIX has no 5-min) are skipped.
- A stage is not available when SPY's data isn't there; other symbols without
  data are left out of the section.
- Pages: `trade.html` loads by date, renders each stage, shows the
  not-available message; `trade_recap.html` shows the recap.
  `js/core/trade-common.js` is shared.
- `tests/test_trading_stages.py`, `docs/trading-generator-architecture.html`.

**Still recalculated every stage on each run** — replaced by the append-only
change below.

### Built, uncommitted: append-only, one stage per run

- `SessionFile` — the day's file as an append-only record: `open(cache_dir,
  session_date, stages)` (existing JSON, or every stage not available),
  `has(name)`, `sections()` (a deep copy — nothing a builder does reaches the
  file), `append(name, section)` (raises if written), `save(generated)`.
- `_generate_trading_signals(db, cache_dir, target_date=None, stage_name=None)`
  computes **one** stage: `cfg.stage(stage_name)` if given
  (`pipeline.run trading --stage open`), else
  `history.current_stage(cfg.stages)` — the latest stage whose SPY data is
  there. No loop. It does nothing when:
  - no stage's data is there, or the chosen stage's data isn't there yet;
  - the stage is already written;
  - the stage is opening range or recap and premarket isn't written
    (`NEEDS_PREMARKET` — both read the premarket section).
- Intraday bar files (`data/cache/intraday/`) are still emitted on every run.
- `_score_setups(cfg, patterns, preopen_by_symbol, grade)` — confluence,
  sizing and plan, in place. Premarket scores its watchlist; opening range
  scores only its ORB setups and no longer copies the watchlist.
- `_stage_recap` grades `premarket.watchlist` and `opening_range.patterns`,
  each graded call tagged with the `stage` that made it.
- Pages: Steps 4–5 read the scored `premarket.watchlist` (shown once
  premarket lands). The Opening range card lists ORB setups with score,
  qualification and size tier. The recap page looks each call up in the stage
  that made it (`watchlist` for premarket, `patterns` for opening range).
- `scripts/backfill_trading_history.py` calls the generator once per stage, in
  order, per date. Without `--force` it fills in missing stages; `--force`
  deletes the day's file first.
- `tests/test_trading_stages.py` replays the latest session into one file at
  09:00, 09:40, 13:00 and 17:00 and checks: which sections exist, earlier
  sections unchanged byte-for-byte, each section equal to a fresh backfill.
  Also: the previous session backfills every stage; a stage is written once.
  3 tests pass (local DB through 2026-08-21).
- Verified in the browser against 08-19 (premarket only), 08-20 and 08-21:
  Steps 4–5, the ORB list, the recap's per-stage lookup, not-available
  messages. `data/cache` backed up and restored.
- Design doc: `docs/trading-session-file.html`.

## Open items

- Crypto gaps: BTC/ETH trade 24/7, so gap-to-last-print is ~2,000× median and
  flags a gap setup most days. Skip gap setups for crypto, or measure against
  their own prior 09:00 price?
- Update `CLAUDE.md` Cache Phase Contract (`phase` / `session_complete` are
  gone) and `docs/trading-cache-architecture.md`.
- Regenerate the last 60 days with the backfill script (`--days 60 --force`;
  the default is still 90).
- **Workflow slots.** `update-data-v2.yml` runs at 09:00 and 16:15 ET only, so
  live days get premarket and recap but never open or opening range. Add
  09:35 and 10:00 ET slots, each passing `--stage`.
- A missed run leaves that stage missing for the day — there is no catch-up
  loop. Backfill fills it.
- Crypto in the recap: BTC/ETH have no closed daily bar at 16:00, so their
  calls (including ORB) aren't graded. Same as before; part of the crypto item.
- `docs/trading-generator-architecture.html` still describes the old
  rewrite-every-run flow and opening-range scoring; update or fold into
  `docs/trading-session-file.html`.

## Working rules for this effort

- Before writing code for a change or a correction, restate the understanding
  and get confirmation. Only skip that when told to just go ahead.
- Test the way a real day runs: earlier sessions complete, the latest one in
  progress. `data/cache` is workflow-owned — back it up and restore it.
