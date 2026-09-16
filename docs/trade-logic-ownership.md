# Moving Trade Logic Out of the Browser

**Status:** implemented, steps 1-7 complete. Verified numerically against the
values the page produced before the change; **not yet verified in a browser** —
an unresolved rendering issue remains, see "Open issue" below.

## Why

`js/pages/trade.js` still computes trading decisions, not just presentation. The
sizing tables, the selection cutoff, and the ATR target multiples live in the
browser — and the multiples live in the generator *as well*, so two
implementations are already in the tree.

This is the same defect we removed from confluence scoring. The score used to be
derived in the browser from whatever the cache held at load time, which made the
afternoon's number differ from the morning's and made the dated caches unusable
for replay. It now comes from the generator as a stamped fact.

The remaining values matter for the same reason: **the portfolio backtester needs
every one of them to size and resolve a single trade.** Building it against
Python copies would recreate the drift we just eliminated.

## Guiding assumption

This is a **relocation, not a retune.** Every number the page displays must be
identical before and after. A changed value is a bug, not an improvement — retune
later, on purpose, once there is one place to do it.

## Inventory — what moves

Verified locations as of this writing.

| # | Logic | Currently in | Notes |
|---|---|---|---|
| 1 | `DAY_POSTURE` — grade → 1 / 0.5 / 0 | `trade.js:86-91` | Python cannot see it |
| 2 | `confluenceFactor` — score → 1 / 0.75 / 0.5 | `trade.js:99-101` | " |
| 3 | `effectiveSize` — the product of the two | `trade.js:104-107` | " |
| 4 | Selection cutoff `score >= 3` | `trade.js:743` | Decides what appears at all |
| 5 | Size-label boundaries 6 / 4 | `trade.js:754`, `trade.js:1105` | Duplicated within the page |
| 6 | T1 ×1.5, T2 ×2.0, stop ×1.0 ATR | `trade.js:813-814` **and** `trading_generator.py` (ORB `t1_up`/`t2_up`, Engulfing, Outside Day) | **Already duplicated across languages** |
| 7 | Gap recomputed from `est_open − prior_close` | `renderDayQuality` | Generator already publishes `gap_pct` |

## What stays in the page

Presentation, and only presentation: colours, dot meters, grade badges, the prose
around a level ("Short ORB breakout — fade gap to prior close"), tab switching,
date navigation, and the `phase` / `session_complete` guards.

**The generator emits numbers and machine-readable rules; the page composes the
sentence.** It should not emit display strings — that moves presentation into
Python and is the opposite mistake.

## Design

**Values live in `config/trading_config.json`,** in two new blocks:

```json
"sizing": {
  "day_posture":       { "A+": 1.0, "A": 1.0, "B": 0.5, "C": 0.0, "F": 0.0 },
  "confluence_tiers":  [ { "min": 6, "factor": 1.0 },
                         { "min": 4, "factor": 0.75 },
                         { "min": 3, "factor": 0.5 } ],
  "min_confluence": 3
},
"targets": { "t1_atr": 1.5, "t2_atr": 2.0, "stop_atr": 1.0 }
```

**`trading_generator.py` applies them** and stamps two blocks onto each pattern
in `active_patterns`:

```json
"sizing": { "day_factor": 0.5, "confluence_factor": 0.75,
            "effective_pct": 37.5, "tier_label": "75%" },
"plan":   { "entry_rule": "orb_breakout", "stop": 761.4,
            "t1": 770.2, "t2": 773.1, "trail_atr": 1.0 }
```

plus a `qualifies` boolean from `min_confluence`, so the page and the backtester
filter on the same verdict rather than each applying their own threshold.

**`trade.js` renders those fields** and loses the tables, the multiples, and the
cutoff.

## Steps

Each step ends with a check. Do not proceed past a failing one.

**1 — Add the config blocks.**
No code reads them yet.
*Verify:* `python3 -m pipeline.run trading` succeeds and `data/cache/trading_signals.json`
is byte-identical to before.

**2 — Stamp `sizing` in the generator.**
*Verify:* for every pattern on a sample session, `effective_pct` equals
`DAY_POSTURE[grade].factor × confluenceFactor(score) × 100` computed by hand from
the JS tables. All nine symbols must match.

**3 — Stamp `plan` levels, replacing the generator's own inline 1.5 / 2.0.**
*Verify:* generated `t1`/`t2` match the numbers `trade.js` renders today for the
same session, before the page is touched. This is the step that collapses the
cross-language duplication, so the equality check is the whole point.

**4 — Stamp `qualifies` from `min_confluence`.**
*Verify:* the set of patterns with `qualifies: true` equals the set the page
currently shows under `score >= 3`.

**5 — Switch the page to render the stamped fields.** Delete `DAY_POSTURE`,
`confluenceFactor`, `effectiveSize`, the ATR multiples, and the `>= 3` filter.
*Verify:* A/B against `main` per `.claude/skills/verify` — the rendered numbers
must be identical, not merely plausible.

**6 — Drop the gap recompute**, reading `gap_pct` from the cache.
*Verify:* displayed gap matches `symbols.SPY.gap_pct`.

**7 — Backfill.**
Dispatch `backfill-trading-history.yml` with `force=true, days=200`.
*Verify:* every dated cache carries `sizing`, `plan` and `qualifies`; spot-check
that an old session's `effective_pct` matches its grade and score.

## Risks

- **Historical caches lack the new fields.** Same shape as the confluence change:
  the page must skip or fall back rather than throw, and the backfill is part of
  this work, not a follow-up.
- **Step 5 is the only step that can change what a user sees.** Steps 1–4 are
  additive and invisible; if something moves on screen before step 5, a stamp is
  wrong.
- **`qualifies` relocates a decision.** The page currently filters; afterwards the
  generator decides and the page obeys. Any disagreement in step 4 means the JS
  and config thresholds have drifted apart already.

## Out of scope

- Splitting `scoreConfluences()` into a pure selector plus a renderer. Ergonomics,
  not correctness — the view-model split already fixed the leak class.
- Retuning any value. See the guiding assumption.
- The portfolio backtester itself, which this unblocks.

## Open issue — pick up here

A rendering problem remains on the trade page, unresolved when this session
ended. It has not been characterised; the next session should reproduce it in a
browser first rather than guessing from the code.

**Everything to date was verified numerically, not visually.** Playwright was not
available on the machine this was written on, so each step was checked by
comparing generated values against the values the JavaScript produced before the
change. That catches wrong numbers. It does not catch a panel that fails to
render, a field read under the wrong name, or a layout that breaks.

### Resuming elsewhere

`data/` is deliberately not committed — CI owns it. So a fresh checkout has
caches *without* `confluence`, `sizing`, `plan`, `qualifies` or `preopen`, and the
page will render an empty Step 4 until they are regenerated. Before looking at
anything:

```bash
python3 -m pipeline.run seed
python3 -m pipeline.run fetch
python3 -m pipeline.run generate
PYTHONPATH=$(pwd) python3 scripts/backfill_trading_history.py --force --days 200
python3 -m http.server 8000
```

The backfill takes a few minutes and is what gives historical dates their scores.

### What to check in a browser

Roughly in order of likelihood of being wrong:

1. **Step 5 target prose.** The multiples are interpolated from `plan` now
   (`${mT1}x ATR`), replacing hard-coded "1.5x ATR" text. A template that did not
   substitute would read literally.
2. **Step 1 posture tile and gap.** `dayPosture()` takes the view rather than the
   grade, and gap now comes from `gap_signed` / `gap_pct`.
3. **Step 4 selection.** Filters on stamped `qualifies`; a date whose cache
   predates the field shows nothing.
4. **Morning vs EOD separation.** No session close, high, low, realised grade or
   outcome should appear on Morning Setup.
5. **Historical dates**, which exercise caches written before these fields.

## Related

- `docs/trading-rules.md` — the sizing tables and risk constraints being encoded
- `docs/portfolio-tracking.md` — the consumer this work unblocks
- `docs/trading-cache-architecture.md` — cache phase contract
