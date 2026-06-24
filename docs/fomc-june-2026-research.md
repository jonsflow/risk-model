# FOMC Meeting — June 17, 2026

**Research compiled:** June 17, 2026  
**Meeting:** June 17–18, 2026 (announcement June 17 at 2:00 PM ET)  
**Chair:** Kevin Warsh (first FOMC meeting as Chair; succeeded Jerome Powell in May 2026)

---

## Decision

The FOMC voted **12-0** to hold the federal funds rate target range at **3.50%–3.75%**.

No rate change, but the statement and dot plot signal the next move is more likely a **hike** than a cut.

---

## Statement Changes — Warsh Overhaul

Warsh dramatically shortened the policy statement from ~300+ words to ~130 words — the most significant communications overhaul in years.

Key changes:
- **Forward guidance removed entirely.** The old language suggesting a bias toward cuts was stripped. Warsh said forward guidance "is not well suited for the current policy conjuncture."
- **Inflation described as "elevated"** with acknowledgment of energy "supply shocks."
- Statement described by Warsh as intentionally **"curt"** — meant to reflect data dependency, not signal a direction.

---

## Press Conference Highlights (Warsh, 2:30 PM ET)

**On inflation:**
> "We recognize that inflation has been running well ahead of the Fed's long-stated inflation goal of 2%. That's been going on for more than five years. Persistently high prices are a burden for the American people, but the recent past need not be prologue."

**On forward guidance:**
- Warsh did not offer his own personal rate forecast — consistent with his pre-Chair skepticism of central bank forward guidance.
- Emphasized data dependence over commitment to any path.

**On institutional reform:**
- Announced **five task forces** to review Fed operations:
  1. Monetary policy operations
  2. Communications
  3. Data sources
  4. Productivity and labor market
  5. Causes of inflation

**On Powell:**
- Powell remains on the Board of Governors but has pledged to keep a low profile and not compete publicly with Warsh.

---

## Summary of Economic Projections (SEP / "Dot Plot")

June 2026 SEP vs. March 2026 projections:

| Metric | March 2026 Projection | June 2026 Projection | Change |
|---|---|---|---|
| Fed funds rate (median, end-2026) | 3.4% (1 cut) | 3.8% (1 hike) | +40 bps shift |
| PCE Inflation (end-2026) | 2.7% | 3.6% | +90 bps |
| Unemployment (end-2026) | 4.4% | 4.3% | -10 bps |
| Real GDP (end-2026) | 2.4% | 2.2% | -20 bps |

**Rate hike distribution among 18 FOMC participants:**
- 9 of 18 project at least one hike before year-end
- 6 of 18 project two hikes (2×25 bps)
- Represents a dramatic reversal from March, when the median projected a cut

---

## Macro Context

**CPI:** 4.2% annual rate in May 2026 — highest since April 2023.  
**Driver:** Iran war (started late February 2026) → energy supply shock → higher oil/gas prices.  
**EFFR as of June 16:** 3.63%  
**DFEDTARU (FRED, June 17):** 3.75%  
**DFEDTARL (FRED, June 17):** 3.50%  
**VIX (June 16):** 16.41  
**T10Y2Y (June 16):** 0.38 (curve steepening back toward normal)

---

## Data Integrity Notes (FRED as of June 17, 2026)

`fred_cache.json` fetched at **2026-06-17T15:12:06Z** — current.

| Series | Status | Notes |
|---|---|---|
| DFEDTARU / DFEDTARL | ✓ Current | June 17 data, 3.75 / 3.50 |
| EFFR | ✓ Current | June 16, 3.63% |
| SOFR | ✓ Current | June 4, 3.62% |
| IORB | ✓ Current | June 8, 3.65% |
| VIXCLS | ✓ Current | June 16, 16.41 |
| T10Y2Y | ✓ Current | June 16, 0.38 |
| FEDFUNDS | ~ Lagged | Monthly; latest May 2026 (expected) |
| FEDTARMD | ⚠ Pre-June SEP | 3 annual projections from March SEP — will update when FRED publishes June SEP data |
| MBST | ✗ Stale | Last value June 13, **2018** — FRED may have discontinued this series; needs investigation |

**Action items:**
- Investigate MBST discontinuation — FRED retired the series or changed methodology in 2018; may need to swap to an alternative (e.g., BOGMBASE or M1SL)
- FEDTARMD will self-correct when FRED updates June SEP — watch for it to shift from 3.4% to ~3.8%

---

## Sources

- [NPR — Fed holds rates steady, hints at rate hike (June 17)](https://www.npr.org/2026/06/17/nx-s1-5860084/fed-chief-warsh-first-fomc-meeting)
- [CNN Business — Fed leaves rates unchanged, signals higher rates ahead](https://www.cnn.com/2026/06/17/business/live-news/federal-reserve-interest-rate-kevin-warsh)
- [CNBC — Warsh drastically alters Fed rate statement](https://www.cnbc.com/2026/06/17/june-fed-meeting-redline.html)
- [CNBC — Fed meeting recap: Warsh announces task forces](https://www.cnbc.com/2026/06/17/fed-meeting-today-live-updates.html)
- [Fox Business — June FOMC: Fed holds steady as Warsh era begins](https://www.foxbusiness.com/economy/federal-reserve-interest-rate-decision-june-17-2026)
- [CBS News — Warsh set to lead first Fed rate meeting](https://www.cbsnews.com/news/federal-reserve-interest-rates-kevin-warsh-june-2026/)
- [Fed.gov — Warsh Press Conference Transcript (PDF)](https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20260617.pdf)
- [Fed.gov — April 2026 FOMC Statement](https://www.federalreserve.gov/newsevents/pressreleases/monetary20260429a.htm)
- [InvestingLive — Full FOMC Statement June 2026](https://investinglive.com/centralbank/the-full-fomc-statement-from-the-june-2026-meeting-20260617/)
- [Crypto Briefing — Fed signals rate hike, Warsh holds first press conference](https://cryptobriefing.com/fed-signals-rate-hike-2026-warsh/)
- [BondSavvy — June 2026 Fed Dot Plot](https://www.bondsavvy.com/fixed-income-investments-blog/fed-dot-plot)
