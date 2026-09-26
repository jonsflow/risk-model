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
