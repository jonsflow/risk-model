# Government Data Risk Score — Research & Implementation Plan

## What Professional Investors Actually Do

### JPMorgan's 5-Factor Recession Model

JPMorgan Private Bank tracks recession probability using five independent models, each receiving **equal weight**, then averaged:

1. **Yield Curve** — shape of the 2s10s and 3m18m forward spreads via probit model. Inversion signals elevated risk but is sometimes discounted when distorted by unusual rate cycles.
2. **Private Sector Debt Service Ratio** — total private debt obligations relative to income. Rising = demand weakness ahead.
3. **Economic Momentum** — YoY change in real final sales + Philadelphia Fed coincident state activity diffusion index.
4. **Corporate Profit Margins** — deteriorating margins signal impending layoffs and demand destruction.
5. **Financial Markets** — risk asset pricing + sentiment measures. Markets move ahead of the economy.

**Key methodology note**: They run separate models for each factor rather than a single multivariate regression, specifically to avoid multicollinearity. Equal weighting is applied at the model output level.

---

### New York Fed Yield Curve Model

The most published single-indicator model. Uses a **probit regression** on the 10Y-3M Treasury spread:

```
P(Recession in 12 months) = Φ(−0.5333 − 0.6330 × Spread)
```

Where Φ is the standard normal CDF and Spread = 10Y yield minus 3M yield (%).

- Spread > 0 (normal curve) → low recession probability
- Spread = 0 (flat) → ~25% probability
- Spread = −1.5% (deeply inverted) → ~70%+ probability

**We have T10Y2Y (10Y−2Y) as a proxy** — not identical to 10Y−3M but highly correlated and widely watched.

---

### Federal Reserve Research (FEDS Notes, 2022)

The Fed's own recession risk framework uses **logistic regression** to predict probability of a "sizable unemployment increase" (above the 80th percentile of historical distribution). Their models:

- **Financial model**: Credit spread (Baa−10Y) + Term spread (10Y−FFR)
- **Macro model**: CPI inflation + Unemployment rate + Credit spread + Term spread
- **Combined model**: All of the above + OECD leading indicator composite

Weighting is data-driven (maximum likelihood), not equal. The most important single predictor across models is **the credit spread**.

---

### Sahm Rule (Labor Market Trigger)

Developed by economist Claudia Sahm at the Federal Reserve. Simple, real-time, highly reliable:

```
Sahm Indicator = 3-month MA of unemployment − 12-month low of unemployment
```

**Trigger**: When Sahm ≥ 0.5 percentage points → recession has likely already started.

- Has triggered in every recession since 1950
- Average lead time: ~3 months before NBER official declaration
- We can compute this client-side from UNRATE

---

### Chicago Fed NFCI

The NFCI is already a composite risk score — 105 financial indicators, each normalized to z-scores relative to history since 1971:

- **Value = 0**: Average financial conditions
- **Value > 0**: Tighter than average (risk-off signal)
- **Value < 0**: Looser than average (accommodative)

Three sub-indices: **Risk** (volatility/funding), **Credit** (household/business credit), **Leverage** (debt/equity ratios).

**We already have NFCI in our series** — it can serve directly as the financial conditions risk component without further computation.

---

### Nowcasting Approach (CEPR/Amazon Science)

Academic nowcasting uses a **Bayesian logit model** combining one macroeconomic indicator + one financial indicator. Key insight: financial conditions are useful not just for predicting downturns but for detecting when recessions end. Outperforms the Sahm Rule at identifying recovery beginnings.

In practice, hedge funds build proprietary versions using high-frequency data:
- **Daily**: market performance, yield curve
- **Weekly**: jobless claims, energy consumption
- **Monthly**: employment, inflation, retail sales

---

## What We Can Build (Client-Side)

### Normalization: Rolling Percentile Rank

The most practical approach for our setup — consistent with what we already do on the credit spread page:

```
percentile(series, value, window) = % of values in window below current value
```

- **Window**: 5 years (1260 trading days / ~60 monthly observations)
- **Interpretation**: Percentile 90 for VIX = current VIX is higher than 90% of the last 5 years = elevated stress
- **Directionality flipped** for risk indicators: high percentile of VIX = high risk; high percentile of UMCSENT = low risk

---

## Indicator Risk Mapping

For each series, define: direction (higher raw value = more or less risk), and a signal method.

### Financial Conditions

| Series | Higher = | Method | Notes |
|--------|----------|--------|-------|
| T10Y2Y | Less risk | Level threshold + percentile | < 0 = inverted = high risk |
| DGS10 | Context-dependent | Rate-of-change | Rising fast = tightening |
| T10YIE | More risk | Percentile | Rising breakevens = inflation risk |
| T5YIE | More risk | Percentile | Same |
| VIXCLS | More risk | Percentile | > 25 = elevated; > 35 = stress |
| BAMLH0A0HYM2 | More risk | Percentile | Widening spreads = credit stress |

### Labor Market

| Series | Higher = | Method | Notes |
|--------|----------|--------|-------|
| ICSA | More risk | Percentile + MoM trend | Rising claims = deterioration |
| CCSA | More risk | Percentile + MoM trend | Lagging but confirming |
| PAYEMS | Less risk | MoM absolute change | < 100K/month = slowing; negative = recession |
| UNRATE | More risk | Sahm Rule calculation | 3-month MA − 12-month low ≥ 0.5 = trigger |
| JTSJOL | Less risk | Percentile | Falling openings = demand destruction |

### Inflation

| Series | Direction | Method | Notes |
|--------|-----------|--------|-------|
| PCEPILFE | Risk if > 2% or rising | Distance from 2% target | Fed's preferred measure |
| CPILFESL | Risk if > 2% or rising | Distance from 2% target | — |
| CPIAUCSL | Risk if > 2% or rising | Distance from 2% target | Headline, more volatile |
| PPIACO | Risk if rising fast | MoM acceleration | Leads CPI by 1–3 months |

**Inflation is dual-directional**: too high = risk; too low (deflation) = also risk. Optimal zone is 1.5%–2.5% YoY.

### Growth & Activity

| Series | Higher = | Method | Notes |
|--------|----------|--------|-------|
| INDPRO | Less risk | MoM trend + percentile | Falling = contraction |
| UMCSENT | Less risk | Percentile | < 70 = stressed; < 55 = recessionary |
| RSAFS | Less risk | MoM pct change trend | Nominal; adjust for inflation ideally |
| FEDFUNDS | Context | Distance from neutral | Very high = restrictive = risk |
| NFCI | More risk if > 0 | Direct z-score | Already normalized; > 0.5 = elevated stress |

---

## Scoring Architecture

### Per-Category Score (0–100, higher = more risk)

```
Financial Conditions Score:
  = average of risk percentiles for [VIX, HY OAS, T10YIE]
  + yield curve penalty (0 if T10Y2Y > 0, scaled if inverted)

Labor Score:
  = average of [ICSA percentile, CCSA percentile, inverted JTSJOL percentile]
  + Sahm Rule bonus (0 or +20 if triggered)
  + inverted PAYEMS score

Inflation Score:
  = distance from 2% target × 10, capped at 100
  (symmetric — both deflation and high inflation score high)

Growth Score:
  = average of [inverted UMCSENT percentile, inverted INDPRO trend, inverted RSAFS trend]
  + NFCI contribution (rescaled from z-score to 0–100)
```

### Overall Composite Score

Equal-weight average of the four category scores:
```
Overall = (Financial + Labor + Inflation + Growth) / 4
```

### Risk Zones

| Score | Label | Color |
|-------|-------|-------|
| 0–25 | Low Risk | `#10b981` green |
| 25–50 | Moderate | `#84cc16` yellow-green |
| 50–70 | Elevated | `#f59e0b` amber |
| 70–85 | High | `#f97316` orange |
| 85–100 | Severe | `#ef4444` red |

---

## Implementation Plan

### What to Build

**All computation is client-side** — consistent with the Gov Data page approach. No changes to `generate_cache.py` or `fetch_fred.py`.

#### 1. `computeRiskSignal(series, points)` in `gov_data_app.js`

Returns `{ score: 0–100, signal: 'low'|'moderate'|'elevated'|'high'|'severe', label }` per series.

Uses the indicator risk mapping table above. Special cases:
- Yield curve: direct level check (inverted = high risk)
- NFCI: rescale z-score directly (z = +1 → score ≈ 70; z = +2 → score ≈ 90)
- Sahm Rule: computed from UNRATE rolling window
- Payrolls: MoM absolute change (not percentile)

#### 2. `computeCategoryScore(cat, allData)`

Averages series-level scores within a category. Returns `{ score, label, color }`.

#### 3. Risk Score Card at Top of `gov_data.html`

```
┌─────────────────────────────────────────────────────┐
│  OVERALL RISK SCORE           54 / 100  ELEVATED    │
│  ████████████████████░░░░░░░░░░░░░░░░░░░░  amber    │
│                                                     │
│  Financial Conditions  62 ▲   Labor Market   38 ▼  │
│  Inflation             71 ▲   Growth & Activity 45  │
└─────────────────────────────────────────────────────┘
```

#### 4. Per-Series Signal Dot on Each Card

Small colored dot on each `.asset-card` indicating `low / moderate / elevated / high / severe`. Replaces or supplements the current change figure.

#### 5. Category Color Bar

Each category section heading gets a mini progress bar showing category score.

### Files to Modify

| File | Change |
|------|--------|
| `gov_data_app.js` | Add `computeRiskSignal()`, `computeCategoryScore()`, `computeOverallScore()`, risk card render |
| `gov_data.html` | Add risk score card div above `#gov-categories` |
| `styles.css` | Add `.risk-score-card`, `.risk-bar`, `.signal-dot` classes if needed (or inline) |

### What NOT to Change

- `fred_config.json` — no new series needed
- `fetch_fred.py` — no new fetches needed
- `generate_cache.py` — not involved
- Any other page

---

## Key Design Decisions

1. **Percentile window**: 5 years (1260 points) — long enough to be meaningful, short enough to reflect current cycle
2. **Equal weighting within categories** — consistent with JPMorgan approach, avoids needing to tune weights
3. **Dual-risk inflation** — inflation too high OR too low both score as risk (distance from 2% target)
4. **NFCI used directly** — it's already a composite z-score, no further normalization needed
5. **Sahm Rule as binary trigger** — adds +20 to labor score if triggered, regardless of magnitude
6. **Yield curve inversion as threshold** — < 0 = inverted = elevated risk, regardless of percentile rank
7. **Score is explanatory, not predictive** — this is a current-conditions dashboard, not a 12-month forecast model

---

## Sources

- [JPMorgan — Five Factors for Recession Risk](https://privatebank.jpmorgan.com/nam/en/insights/markets-and-investing/five-factors-we-use-to-track-recession-risk-and-what-they-say-now)
- [NY Fed — Yield Curve as Leading Indicator](https://www.newyorkfed.org/research/capital_markets/ycfaq)
- [Federal Reserve — Financial and Macroeconomic Indicators of Recession Risk](https://www.federalreserve.gov/econres/notes/feds-notes/financial-and-macroeconomic-indicators-of-recession-risk-20220621.html)
- [Sahm Rule — Wikipedia](https://en.wikipedia.org/wiki/Sahm_rule)
- [CEPR — Nowcasting Recession Risk](https://cepr.org/publications/dp19483)
- [Chicago Fed — NFCI About](https://www.chicagofed.org/research/data/nfci/about)
- [YCharts — Recession Indicators 2025 Framework](https://get.ycharts.com/resources/blog/recession-indicators-2025-framework/)
- [Morningstar — Advisor's Cheat Sheet to Recession Indicators](https://www.morningstar.com/business/insights/blog/markets/leading-recession-indicators)
- [Recessionist Pro — Hedge Fund Economic Tools](https://recessionistpro.com/blog/what-tools-do-hedge-funds-use-to-track-the-economy)
