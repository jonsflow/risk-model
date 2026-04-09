# FRED Data

## What is FRED?

**FRED** (Federal Reserve Economic Data) is a free public database maintained by the Research Division of the **Federal Reserve Bank of St. Louis**. It provides 840,000+ economic time series from 100+ sources including the BEA, BLS, Census Bureau, and international organizations.

Data is fetched via the `fredapi` Python library using a free API key from [fred.stlouisfed.org](https://fred.stlouisfed.org).

## Setup

```bash
# Install dependency
pip install fredapi python-dotenv

# Store API key in .env (gitignored)
echo "FRED_API_KEY=your_key_here" > .env

# Fetch all series
python fetch_fred.py
# Writes: data/fred/{SERIES_ID}.csv
```

## CSV Format

```
Date,Value
2024-01-02,3.45
2024-01-03,3.47
...
```

## Series Reference

All series defined in `fred_config.json`. The `display` field controls the card stat; `freq` controls the change calculation lookback.

### Financial Conditions (daily)

| ID | Name | Units | Display |
|----|------|-------|---------|
| T10Y2Y | Yield Curve (10Y−2Y) | % | level |
| DGS10 | 10Y Treasury Yield | % | level |
| T10YIE | 10Y Breakeven Inflation | % | level |
| T5YIE | 5Y Breakeven Inflation | % | level |
| VIXCLS | VIX | idx | level |
| BAMLH0A0HYM2 | HY OAS Spread | % | level |

**HY OAS Spread** (BAMLH0A0HYM2): ICE BofA US High Yield Index Option-Adjusted Spread over Treasuries. Measures extra yield investors demand for junk bonds vs risk-free Treasuries. **Wider = more fear / credit stress. Tighter = risk-on.** Also drives the Credit Spread page signal.

**Yield Curve** (T10Y2Y): 10-year minus 2-year Treasury yield. **Negative = inverted = recession warning.**

**Breakeven Inflation** (T10YIE, T5YIE): Market-implied inflation expectations derived from TIPS vs nominal Treasury spread. **Rising = market pricing more inflation.**

### Labor Market (weekly / monthly)

| ID | Name | Units | Freq | Notes |
|----|------|-------|------|-------|
| ICSA | Initial Jobless Claims | persons | weekly | Seasonally adjusted; released every Thursday |
| CCSA | Continued Claims | persons | weekly | Released with 1-week lag vs ICSA |
| PAYEMS | Nonfarm Payrolls | thousands | monthly | BLS jobs report; first Friday of month |
| UNRATE | Unemployment Rate | % | monthly | From same BLS jobs report |
| JTSJOL | Job Openings (JOLTS) | thousands | monthly | Released ~6 weeks after reference month |

### Inflation (monthly)

| ID | Name | Units | Display | Notes |
|----|------|-------|---------|-------|
| PCEPILFE | Core PCE | YoY% | pct_yoy | Fed's preferred inflation measure |
| CPILFESL | Core CPI | YoY% | pct_yoy | Excludes food & energy |
| CPIAUCSL | Headline CPI | YoY% | pct_yoy | All items including food & energy |
| PPIACO | PPI All Commodities | YoY% | pct_yoy | Producer prices; leads CPI |

**Release lags**: PCE is released ~4–5 weeks after month end. CPI is ~2–3 weeks. This is why inflation cards show older dates than daily series — that IS the latest available data.

### Growth & Activity (mixed)

| ID | Name | Units | Freq | Display |
|----|------|-------|------|---------|
| INDPRO | Industrial Production | idx | monthly | level |
| UMCSENT | Consumer Sentiment | idx | monthly | level |
| RSAFS | Retail Sales | $M | monthly | pct_mom |
| FEDFUNDS | Fed Funds Rate | % | monthly | level |
| NFCI | Chicago Fed Conditions | idx | weekly | level |

**NFCI**: National Financial Conditions Index. Values below zero = looser than average; above zero = tighter. A key leading indicator of financial stress.

### FOMC & Policy Rates (daily / weekly / monthly)

| ID | Name | Units | Freq | Display |
|----|------|-------|------|---------|
| DFEDTARU | Fed Funds Target — Upper | % | daily | level |
| DFEDTARL | Fed Funds Target — Lower | % | daily | level |
| EFFR | Effective Fed Funds Rate | % | daily | level |
| IORB | Interest on Reserve Balances | % | daily | level |
| SOFR | SOFR (Overnight) | % | daily | level |
| SOFR30DAYAVG | 30-Day Avg SOFR | % | daily | level |
| WALCL | Fed Balance Sheet | $B | weekly | level |
| FEDTARMD | SEP Median Rate Projection | % | monthly | level |
| RRPONTSYD | Overnight Reverse Repo | $B | daily | level |
| WRESBAL | Reserve Balances | $B | weekly | level |
| TREAST | Treasuries Held by Fed | $M | weekly | level |
| MBST | MBS Held by Fed | $M | weekly | level |

**Fed Funds Target** (DFEDTARU / DFEDTARL): The FOMC's upper and lower bounds for the federal funds rate target range. Changes only at FOMC meetings (8 per year).

**EFFR**: The actual rate at which banks lend reserves overnight — should trade within the target range. Deviations signal liquidity stress.

**SOFR**: Secured Overnight Financing Rate, the benchmark that replaced LIBOR. Reflects the cost of borrowing cash overnight collateralized by Treasuries.

**Fed Balance Sheet** (WALCL): Total assets held by Federal Reserve banks. Expansion = QE (quantitative easing); contraction = QT (quantitative tightening).

**Overnight Reverse Repo** (RRPONTSYD): Cash parked at the Fed overnight by money market funds. High levels indicate excess liquidity; rapid drawdown can signal tightening financial conditions.

**Reserve Balances** (WRESBAL): Bank reserves held at the Fed. A key measure of banking system liquidity.

**Treasuries / MBS Held** (TREAST / MBST): Breakdown of the Fed's securities portfolio — tracks the composition of QE/QT.

## Adding New Series

1. Add entry to `fred_config.json` under the appropriate category
2. Run `python fetch_fred.py` to fetch the new CSV
3. The Gov Data page will render it automatically — no JS changes needed

To find a series ID, search [fred.stlouisfed.org](https://fred.stlouisfed.org) and use the ID from the URL (e.g., `fred.stlouisfed.org/series/T10Y2Y` → ID is `T10Y2Y`).
