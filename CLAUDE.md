# CLAUDE.md

## System Prompt

<!-- Behavioral rules for working in this repo. To be filled in. -->

## What This Is

A static GitHub Pages site visualizing market and macro data. `index.html` at the
repo root plus `pages/*.html`. No build step, no bundler, no package manager — the
browser loads ES modules directly.

## Architecture & Structure

Python computes, JavaScript renders. Generators in `pipeline/generators/` write JSON
to `data/cache/`; the JS reads it and draws it. A page is typically:

```
pages/trade.html → js/pages/trade.js → data/cache/trading_signals.json
                                     ← pipeline/generators/trading_generator.py
```

Pages reach data through `js/core/api.js`. `fetchCache` reads `data/cache/*.json`;
`fetchFredBundle` reads FRED CSVs and is analyzed client-side. Credit Spread uses
only `fetchFredBundle`; Gov Data uses both.

```
index.html         must stay at root — GitHub Pages serves it from there
pages/             all other HTML
js/pages/          one module per page
js/core/           api.js, chart-utils.js, utils.js
js/components/     shared UI (Navigation.js, etc.)
styles/            all CSS
config/            config, macro, fred, trading, correlation (JSON)
pipeline/          run.py (seed/fetch/generate), db_manager, market_time,
                   analysis, fetchers/, generators/
scripts/           standalone scripts, always run from repo root
docs/              reference docs — see Additional Knowledge
data/              workflow-owned; cache/ generated JSON, fred/ series CSVs
risk_model.db      SQLite, repo root
.env               FRED_API_KEY
```

## Running

```bash
python3 -m http.server 8000    # required — file:// breaks CORS

python3 -m pipeline.run seed       # CSVs → SQLite (idempotent)
python3 -m pipeline.run fetch      # Yahoo + FRED → SQLite
python3 -m pipeline.run generate   # SQLite → data/cache/*.json
```

Dependencies are not pinned: `pip install yfinance python-dotenv fredapi`

## Testing

There is no test suite. `.github/workflows/pr-validation.yml` runs on PRs to main,
validating `config/config.json` structure (required keys, symbol references in
pairs, hex color format) and syntax-checking `scripts/fetch_data.py`.

## Workflow Schedule

`.github/workflows/update-data-v2.yml` runs `seed → fetch → generate`, then commits
`data/`. Weekdays, year-round:

- `0 13 * * 1-5` — 09:00 ET, pre-market
- `15 20 * * 1-5` — 16:15 ET, post-close

GitHub cron is UTC-only. One cron per ET slot, updated by hand at each DST
changeover. A multi-cron + wall-time-gate version was tried and removed.

Runs fire late. The 09:00 run has committed as late as 11:10 ET. Never assume a
cache was written when its cron says.

`backfill-trading-history.yml` is manual — regenerates historical dated caches.

## Cache Phase Contract

`data/cache/trading_signals.json` stamps which run wrote it:

- `phase`: `"premarket" | "intraday" | "eod"`
- `session_complete`: true only when `phase == "eod"`

1. Anything scored before the close reads only bars dated strictly before
   `session_date`. Slice with `_prior_bars()` / `_completed_bars()`, never
   `points[:-1]` — the current day's bar may be partial, so positional slicing
   shifts the window by a day.
2. Anything describing the session itself stays empty until `session_complete`.

Consumers read `phase` / `session_complete` — never infer completeness from whether
a field is populated.

## Development Rules

- **Single source of truth.** Each page's analysis lives in exactly one file under
  `pipeline/generators/`. Never add a parallel implementation in `scripts/`. Read
  the workflow YAML before editing a generator — `scripts/` holds legacy files
  production does not call.
- **Commit source only.** Code and config: HTML, JS, Python, CSS, JSON config,
  workflow YAML. Never `data/` — no CSVs, no cache JSON. Those are committed
  exclusively by the workflow.
- **No attribution.** No `Co-Authored-By`, no session links, no generated-with
  footers in commit messages or PR bodies.
- **Commit ≠ push.** Never push, and never delete a remote branch, unless told to.
- **Cache commits aren't divergence.** If every commit separating a branch from main
  is a `chore: update caches` run, the branch is in sync.
- **Read the logs before fixing.** Pull `gh run view <id> --log` before writing code.

## Additional Knowledge

Reference docs in `docs/`. Read on demand — not part of initial context. Titles are
each file's own heading.

- `trading-rules.md` — Systematic Decision Framework
- `trading-cache-architecture.md` — Trading Cache Architecture
- `COMPREHENSIVE_TRADING_GUIDE.md` — Patterns, Indicators & Strategies
- `day-quality-grading.md` — Design Reference
- `morning-grading-rewrite.md` — Implementation Spec
- `squeeze-plan.md` — TTM Squeeze Implementation Plan
- `trade_quality.md` — (no heading)
- `pivot-logic.md` — Pivot Detection & Market Structure Labeling
- `pivot-testbed.md` — Pivot Detection Testbed
- `divergence-taxonomy.md` — Complete Reference
- `cross-asset-divergence.md` — Application Guide
- `pair-candidates.md` — Divergence Pair Candidates
- `fred-data.md` — FRED Data
- `portfolio-tracking.md` — Portfolio Allocation & Paper Trade Tracking
- `gov-risk-score-research.md` — Research & Implementation Plan
- `fomc-june-2026-research.md` — FOMC Meeting, June 17 2026
- `fomc-july-2026-review.md` — FOMC July 28–29, 2026: Statement, Warsh Press Conference, and the News Around It
- `economic-calendar-integration.md` — Finnhub API
- `data-requirements-analysis.md` — Trading Rules vs. Inventory
- `workflows.md` — GitHub Actions Workflows
- `fomc-config.md` — Updating the Fed Pages After an FOMC Meeting
- `components.md` — Component Reference
- `multi_agent_analyst_design.md` — Design Spec
