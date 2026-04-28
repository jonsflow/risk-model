# Divergence Pair Candidates

Reference list of high-signal divergence pairs for future addition to `config.json`. Current pairs are marked ✅.

## 1. Equity ↔ Credit (risk appetite / funding stress)

| Pair | Signal |
|------|--------|
| ✅ SPY ↔ HYG | Equities vs high-yield credit — most reliable single divergence |
| SPY ↔ LQD | Equities vs investment-grade credit |
| SPY ↔ JNK | Alternative to HYG (another junk credit ETF) |
| SPY ↔ KRE | Equities vs regional banks (credit plumbing) |

## 2. Equity ↔ Rates / Duration (macro risk-off)

| Pair | Signal |
|------|--------|
| ✅ SPY ↔ QQQ | S&P 500 vs Nasdaq — large-cap breadth vs growth leadership |
| QQQ ↔ TLT | Growth vs rates sensitivity |
| SPY ↔ TLT | Equities vs long-duration bonds |

## 3. Equity ↔ Volatility (stress & distribution)

| Pair | Signal |
|------|--------|
| SPY ↔ VIX | Classic risk vs fear gauge |
| SPX ↔ VVIX | Volatility of volatility (early stress signal) |
| QQQ ↔ VXN | Nasdaq-specific volatility |

## 4. Equity ↔ Commodities (macro regime & inflation)

| Pair | Signal |
|------|--------|
| ✅ SPY ↔ GLD | Risk assets vs monetary hedge |
| SPY ↔ USO | Equities vs oil (growth expectations) |

## 5. Equity ↔ USD / Liquidity

| Pair | Signal |
|------|--------|
| SPY ↔ DXY | Equities vs dollar strength |
| QQQ ↔ DXY | Growth vs tightening liquidity |

## 6. Equity Breadth / Leadership (internal confirmation)

| Pair | Signal |
|------|--------|
| ✅ SPY ↔ IWM | Large-cap vs small-cap risk appetite |
| SPY ↔ MDY | Large-cap vs mid-cap |
| SPY ↔ RSP | Cap-weighted vs equal-weight breadth |

## 7. Sector Ratios (cyclical behavior)

| Pair | Signal |
|------|--------|
| ✅ SPY ↔ SMH | Equities vs semiconductors — tech/AI cycle leadership |
| XLY ↔ XLP | Discretionary vs staples — cleanest growth/recession read |
| XLF ↔ XLK | Financials vs tech |
| XLE ↔ SPY | Energy sector vs broad market |

## 8. Crypto

| Pair | Signal |
|------|--------|
| ✅ BTC ↔ SPY | Crypto vs equities |
| BTC ↔ GLD | Crypto vs gold |

## High-Signal Core Set (if expanding)

Priority additions based on signal quality:
1. **SPY ↔ VIX** — most direct fear measure
2. **XLY ↔ XLP** — consumer behavior regime read
3. **SPY ↔ KRE** — regional bank health (credit plumbing)
4. **SPY ↔ RSP** — breadth confirmation (equal weight vs cap weight)

## Adding a Pair

1. Add to `config.json` under `"pairs"` and symbol under `"symbols"`
2. Add symbol to `fetch_data.py` ticker mapping if needed
3. Run `python3 fetch_data.py && python3 generate_cache.py`
4. No HTML changes required
