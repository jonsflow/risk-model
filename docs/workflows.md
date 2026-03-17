# GitHub Actions Workflows

This document covers every workflow in `.github/workflows/`, how they chain together, what they produce, and how to operate them.

---

## Overview

The site runs entirely on static files committed to `main`. GitHub Actions keeps the data fresh automatically — no server, no database. There are four workflows:

| Workflow | File | Trigger | Writes |
|----------|------|---------|--------|
| Update Yahoo Finance | `update-data.yml` | Daily 21:00 UTC weekdays | `data/*.csv`, `data/last_updated.txt` |
| Generate Cache | `generate-cache.yml` | After Yahoo update succeeds | `data/cache/*.json` |
| Update FRED | `update-fred.yml` | Daily 22:00 UTC weekdays | `data/fred/*.csv`, `data/fred/fred_cache.json` |
| PR Validation | `pr-validation.yml` | Pull requests to `main` | Nothing (read-only checks) |

---

## Data Flow Diagram

```
                    21:00 UTC (weekdays)
                           │
                    ┌──────▼───────┐
                    │  update-data │  fetch_data.py
                    │  (Yahoo)     │  yfinance API
                    └──────┬───────┘
                           │ on: workflow_run completed + success
                           │
                    ┌──────▼───────┐
                    │  generate-   │  generate_cache.py
                    │  cache       │  all analysis in Python
                    └──────┬───────┘
                           │ commits data/cache/*.json
                           │
                    ┌──────▼───────┐
                    │   main       │  GitHub Pages serves
                    │   branch     │  static files
                    └──────┬───────┘
                           │
                    22:00 UTC (weekdays, independent)
                           │
                    ┌──────▼───────┐
                    │  update-fred │  fetch_fred.py
                    │  (FRED API)  │  fredapi + python-dotenv
                    └─────────────┘
                      commits data/fred/*.csv
                              + data/fred/fred_cache.json

  Pull requests:
    ┌──────────────────┐
    │  pr-validation   │  JSON lint · config structure · Python syntax
    └──────────────────┘
```

---

## Concurrency Groups

Two concurrency groups prevent git push conflicts:

| Group | Workflows |
|-------|-----------|
| `update-data` | `update-data.yml`, `update-fred.yml` |
| `generate-cache` | `generate-cache.yml` |

With `cancel-in-progress: false`, queued jobs wait rather than being dropped. This means if Yahoo and FRED workflows happen to queue simultaneously, they serialize: one pushes, the other pulls → pushes cleanly.

---

## Workflow Reference

### 1. `update-data.yml` — Yahoo Finance

**Trigger:** `cron: "0 21 * * 1-5"` (21:00 UTC, Mon–Fri) + `workflow_dispatch`

**What it does:**
1. Checks out `main`
2. Installs `yfinance`
3. `git pull --rebase origin main` — picks up any FRED push that happened concurrently
4. Runs `python3 fetch_data.py` — fetches hourly and daily OHLCV CSVs for all symbols in `config.json` and `macro_config.json`
5. Stages `data/*.csv` and `data/last_updated.txt`
6. Commits only if there are changes, pushes

**Output files:**
- `data/{symbol}.csv` — daily OHLCV, max history available
- `data/{symbol}_hourly.csv` — hourly OHLCV, last ~1 month
- `data/last_updated.txt` — UTC timestamp of the run (displayed in page headers)

**Concurrency group:** `update-data`

---

### 2. `generate-cache.yml` — Analysis Cache

**Trigger:** `on: workflow_run` (fires when `update-data.yml` completes with `conclusion == 'success'`) + `workflow_dispatch`

The `if:` condition prevents the job from running if Yahoo Finance failed:
```yaml
if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
```

**What it does:**
1. Checks out `main`
2. `git pull --rebase origin main` — ensures freshly committed CSVs are present
3. Runs `python3 generate_cache.py` — reads all CSVs and runs pivot detection, divergence scoring, macro breadth analysis for every combination of (lookback × pivot mode × swing window)
4. Stages `data/cache/`
5. Commits only if there are changes, pushes

**Output files:**

| Pattern | Used by |
|---------|---------|
| `data/cache/divergence_{lookback}_{mode}_{swing}.json` | Divergence page (`app.js`) |
| `data/cache/macro_{lookback}_{ma}.json` | Macro Model page (`macro_app.js`) |

Each file is a complete pre-computed snapshot. JS fetches the relevant file based on the dropdown selection and renders — no computation in the browser.

**Why a separate workflow?**
`generate_cache.py` is the computational bottleneck — it runs all pivot analysis for every parameter combination. Separating it means a failed Yahoo fetch doesn't waste compute time, and the cache is always consistent with the data files that just landed.

**Concurrency group:** `generate-cache` (separate from `update-data` — these two can overlap safely since they write to different paths)

---

### 3. `update-fred.yml` — FRED Data

**Trigger:** `cron: "0 22 * * 1-5"` (22:00 UTC, Mon–Fri, 1 hour after Yahoo) + `workflow_dispatch`

**Required secret:** `FRED_API_KEY` — must be added under repository Settings → Secrets → Actions → New repository secret.

**What it does:**
1. Checks out `main`
2. Installs `fredapi` and `python-dotenv`
3. `git pull --rebase origin main`
4. Runs `python fetch_fred.py` with `FRED_API_KEY` injected as an env var
   - Fetches all 20 series declared in `fred_config.json`
   - Saves each as `data/fred/{SERIES_ID}.csv`
   - Writes `data/fred/fred_cache.json` — all series bundled into one compact JSON file
5. Stages `data/fred/`
6. Commits only if there are changes, pushes

**Why 22:00 UTC (not 21:00)?**
The 1-hour offset avoids both workflows hitting git push at exactly the same time. The shared `update-data` concurrency group serializes them if they do overlap, but the offset keeps the queue clear in the common case.

**Why no `generate-cache` dependency?**
FRED data feeds the Gov Data and Credit Spread pages, which do all analysis client-side. There are no Python-generated cache files for FRED — `gov_data_app.js` and `credit_app.js` compute stats in the browser directly from the fetched data.

**Output files:**
- `data/fred/{SERIES_ID}.csv` — individual series, `Date,Value` format, full history
- `data/fred/fred_cache.json` — single bundle used by the browser (`{fetched_at, series: {ID: [[date, value], ...]}}`)

**FRED data frequencies:**

| Frequency | Series | Notes |
|-----------|--------|-------|
| Daily | T10Y2Y, DGS10, T10YIE, T5YIE, VIXCLS, BAMLH0A0HYM2 | 1-business-day lag from FRED |
| Weekly | ICSA, CCSA, NFCI | Released Thursdays |
| Monthly | PAYEMS, UNRATE, JTSJOL, PCEPILFE, CPILFESL, CPIAUCSL, PPIACO, INDPRO, UMCSENT, RSAFS, FEDFUNDS | Varies by series |

The daily workflow captures same-day updates for daily series. Weekly and monthly series change infrequently so daily fetches are no-ops for most of the month — the commit step only pushes if `git diff --cached` is non-empty.

**Concurrency group:** `update-data`

---

### 4. `pr-validation.yml` — Pull Request Checks

**Trigger:** `pull_request` targeting `main`

**What it does (read-only, nothing committed):**

1. **`config.json` JSON lint** — `python3 -m json.tool config.json` catches malformed JSON before it can break the divergence page
2. **`config.json` structure validation** — Python script checks:
   - Required top-level keys (`symbols`, `pairs`, `defaults`)
   - Every pair references symbols that exist in the `symbols` array
   - Every `color1`/`color2` is a valid hex code (`#RGB` or `#RRGGBB`)
3. **Python syntax check** — `py_compile fetch_data.py`
4. **Import smoke test** — imports `fetch_data` to catch runtime import errors

**Intent:** Catches broken config edits and Python syntax errors before they land on `main` and break the automated data pipeline.

---

## Required Secrets

| Secret name | Used by | Where to get it |
|-------------|---------|-----------------|
| `FRED_API_KEY` | `update-fred.yml` | [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html) — free registration |

The `GITHUB_TOKEN` (used for `git push`) is automatically provided by Actions — no setup needed.

---

## Manual Triggers

All data workflows support `workflow_dispatch` — run them on demand from the Actions tab without waiting for the schedule:

```
GitHub → Actions → [workflow name] → Run workflow → Run workflow
```

Useful when:
- First-time setup (run all three in order: Yahoo → wait for cache → FRED)
- After adding a new symbol or FRED series to a config file
- Debugging a stale data issue

**Recommended order for a full refresh:**
1. Trigger `update-data.yml` manually
2. Wait for it to complete — `generate-cache.yml` fires automatically
3. Trigger `update-fred.yml` manually in parallel with step 1 (they use different APIs)

---

## Adding a New Series

### Yahoo Finance symbol (Divergence or Macro pages)
1. Edit `config.json` or `macro_config.json`
2. Edit `fetch_data.py` to include the symbol in the fetch list
3. Run `python3 fetch_data.py` locally
4. Run `python3 generate_cache.py` locally
5. Commit everything — the PR validation workflow checks `config.json` structure on the PR

### FRED series (Gov Data page)
1. Edit `fred_config.json` — add series entry with `id`, `name`, `units`, `display`, `freq`
2. Run `python fetch_fred.py` locally — generates updated CSVs and `fred_cache.json`
3. Commit `fred_config.json` and `data/fred/` — no cache regeneration needed, Gov Data is client-side

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Page shows "Loading…" forever | `data/cache/*.json` missing or stale | Trigger `generate-cache.yml` manually |
| Gov Data shows "Error: HTTP 404" | `fred_cache.json` not yet generated | Run `fetch_fred.py` locally and commit, or trigger `update-fred.yml` |
| FRED workflow fails with "FRED_API_KEY not set" | Secret not configured | Add `FRED_API_KEY` under repo Settings → Secrets → Actions |
| Two workflows push simultaneously, one fails with non-fast-forward | Race on the same concurrency group | Rerun the failed job — it will `git pull --rebase` and retry cleanly |
| `generate-cache.yml` never fires after Yahoo update | Yahoo workflow failed | Check the Yahoo run log; `generate-cache` is gated on `conclusion == 'success'` |
| Sparklines show no data for a series | CSV file is empty or series ID mismatch | Check `data/fred/{ID}.csv` exists; verify ID in `fred_config.json` matches FRED exactly |
