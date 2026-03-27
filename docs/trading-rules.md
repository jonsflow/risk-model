# Trading Rules — Systematic Decision Framework

Systematic step-by-step rulebook for evaluating and executing trades based on the Comprehensive Trading Guide. This is an executable framework, not a reference — follow the decision gates in order.

---

## Quick Reference Checklist

**Before entering ANY trade:**

```
[ ] Step 1 — Day quality: A or A+ (not C/F)
[ ] Step 2 — Regime: trending/ranging (not choppy)
[ ] Step 3 — Pattern: valid for today's regime
[ ] Step 4 — Confluence: minimum 3 signals aligned
[ ] Step 5 — Position size: calculated from ATR
[ ] Step 6 — Entry rule: matches pattern type
[ ] Step 7 — Stop loss: placed before entry
[ ] Step 8 — Targets: three-tier exit defined
[ ] Step 9 — Trade logged with metadata
```

---

## Step 1 — Day Quality Gate (Pre-Market Decision)

**Gate Rule**: If day grades C or F → no trades for that day. Stop here.

### Economic Calendar Check (Auto-Grade F)

Major economic releases on the calendar = automatic F grade. Do not trade.

**Auto-F Events:**
- Non-farm Payroll (1st Friday of month)
- FOMC Decision (8 times/year)
- CPI (monthly, mid-month)
- Unemployment Rate (monthly)
- Fed Funds Rate decision

**Action**: Check economic calendar before market open. If major event scheduled today → close terminal, avoid trading entirely.

### Technical Filters (Grade Assignment)

Run these checks each morning before market open:

| Check | Criteria | A+/A | B | C | F |
|-------|----------|------|---|---|---|
| **ATR vs History** | ATR > 20-day avg? | Yes | Yes | No | — |
| **Volume vs History** | Volume > 50-day avg? | Yes | Mod | Below | — |
| **Prior Day Move** | Move > 3% yesterday? | — | Down 1 | Down 1 | Yes |
| **Holiday Period?** | Within 1 day of holiday? | No | No | — | Yes |
| **Trend Clarity** | 4-hour trend clear? | Very | Moderate | Mixed | — |
| **Index Divergence** | Sectors aligned or split? | Aligned | Split | Split | Very split |

### Grade Assignment Logic

| Criteria Met | Grade | Trade? |
|---|---|---|
| All A+ checks (6/6) | A+ | **YES** — ideal day |
| 5/6 A checks, balanced | A | **YES** — good day |
| 4-5 checks, mixed | B | **Conditional** — reduce size 50% |
| 2-3 checks, many fails | C | **NO** — sit out |
| Major news or >10% move | F | **NO** — stay in cash |

### Weekday Modifier

Apply to base grade:

| Day | Modifier | Notes |
|---|---|---|
| **Monday** | Grade down 1 level | Gap risk from weekend; avoid overnight holds |
| **Tuesday** | None | Neutral baseline |
| **Wednesday** | None | Highest volatility; ATR often above average |
| **Thursday** | None | Neutral; trend-friendly |
| **Friday** | Grade down 1 level | Profit-taking pressure; close all positions EOD |

**Example**: Tuesday with 5/6 technical checks = A grade. Friday with same 5/6 = down to B. C-grade Friday = no trades.

---

## Step 2 — Market Regime Check

**Gate Rule**: Regime determines which patterns are valid. Choppy regime → no pattern trades allowed.

### Regime Definition (Check in This Order)

#### 1. Trend Direction (4-hour chart)

- **Uptrend**: HH + HL structure, 20-SMA rising and price above it
- **Downtrend**: LL + LH structure, 20-SMA falling and price below it
- **Ranging**: Price oscillating between support/resistance without new extremes

#### 2. ATR Trend (Volatility Expansion)

- **Expanding**: ATR rising, each day's ATR > previous 5-day ATR avg
- **Contracting**: ATR falling, each day's ATR < previous 5-day ATR avg
- **Neutral**: Flatline

#### 3. Index/Sector Alignment

Check at 10:00 AM (after opening chaos settles):

- **Aligned**: SPY, QQQ, IWM all moving same direction (>0.5% all up or all down)
- **Diverging**: Some up, some down; mixed signals
- **Choppy**: Sectors rotating; indices whipsawing (>1% in both directions within 1 hour)

### Regime Classification

| Trend | ATR | Index Alignment | **Regime** | **Pattern Menu** |
|---|---|---|---|---|
| Up | Expanding | Aligned | **Trending UP** | ORB, Gap continuation, Engulfing (with trend only) |
| Up | Contracting | Aligned | Weak uptrend | ORB only (lower prob); skip others |
| Up | — | Diverging | **Choppy** | **NO TRADES** |
| Down | Expanding | Aligned | **Trending DOWN** | ORB, Gap continuation, Engulfing (with trend only) |
| Down | Contracting | Aligned | Weak downtrend | ORB only (lower prob); skip others |
| Down | — | Diverging | **Choppy** | **NO TRADES** |
| — | Contracting | Aligned | **Ranging** | Gap fills, Outside day reversals, Engulfing at S/R |
| — | Contracting | Diverging | **Choppy** | **NO TRADES** |

---

## Step 3 — Pattern Identification

**Gate Rule**: Only patterns matching today's regime are candidates. Other patterns are blacklisted for today.

### 3A. Opening Range Breakout (ORB)

**Valid Regime**: Trending (up or down)

**Time Window**: 9:30–10:00 AM EST (first 30 minutes)

**Pattern Definition**:
- High of first 30 min = resistance level
- Low of first 30 min = support level
- Breakout = close above resistance OR close below support

**Breakout Confirmation**:
1. First 30 min establishes range (no action yet)
2. At 10:00 AM, compare range to average daily range
3. If opening range > 0.75x average daily range → qualified (higher probability)
4. If opening range < 0.5x average daily range → skip (low probability)
5. Watch for breakout (price close beyond range boundary)

**Valid Entry Times**: 10:00 AM – 11:30 AM (1st hour breakout window)

**Signal**:
- **Bullish**: Close above opening range high
- **Bearish**: Close below opening range low

---

### 3B. Gap Trading

**Valid Regime**: Depends on gap size and direction

**Gap Definition**:
- Previous close vs. current open
- > 1% = significant
- > 2% = strong

**Gap Type Decision**:

| Gap | Size | Regime | Strategy |
|---|---|---|---|
| Up | > 2% | Trending up | Continue (follow in direction) |
| Up | > 2% | Ranging | Fill (short to close gap) |
| Up | 1-2% | Any | Neutral — skip |
| Down | > 2% | Trending down | Continue (follow in direction) |
| Down | > 2% | Ranging | Fill (buy to close gap) |
| Down | 1-2% | Any | Neutral — skip |

**Fill Strategy** (for ranging regime):
1. Identify gap at open
2. Target = previous close (gap fill level)
3. Expected fill time: 1–3 trading days

**Continuation Strategy** (for trending regime):
1. Gap confirms direction
2. Look for 15-min consolidation after open
3. Trade continuation in gap direction (not reversal)

---

### 3C. Engulfing Pattern

**Valid Regime**: Any (but most reliable in trending or at S/R)

**Pattern Definition**:
- Previous candle: one direction (bullish or bearish)
- Current candle: opposite direction, **larger body**
- Current candle high > previous candle high
- Current candle low < previous candle low

**Bullish Engulfing**:
- Previous: red/bearish
- Current: green/bullish, body completely covers previous body
- Setup: Look for at support, after downtrend, or after multiple down candles

**Bearish Engulfing**:
- Previous: green/bullish
- Current: red/bearish, body completely covers previous body
- Setup: Look for at resistance, after uptrend, or after multiple up candles

**Volume Requirement**:
- Engulfing candle volume MUST be > 20-day average
- Without volume: skip pattern (false signal)

---

### 3D. Outside Day Pattern

**Valid Regime**: Any (most reliable in ranging or after consolidation)

**Pattern Definition**:
- Today's high > yesterday's high
- AND today's low < yesterday's low
- (Both conditions must be true)

**Direction Classification**:

| Close | Previous Range | Type | Signal |
|---|---|---|---|
| Upper 25% of range | Outside | Bullish outside day | Upside bias |
| Middle 50% of range | Outside | Neutral outside day | Weak signal |
| Lower 25% of range | Outside | Bearish outside day | Downside bias |

**Volume Requirement**:
- Volume > 20-day average = strong confirmation
- Volume < 20-day average = weak signal (skip)

**Setup for Trade**:
- Entry next day on breakout beyond today's high (bullish) or low (bearish)
- Not on the day it forms — trade the follow-through

---

### Invalid Patterns Today (Blacklist)

Once regime is set, patterns NOT on the valid menu are blacklisted:

- Trending regime: **DO NOT** trade gap fills or outside day reversals
- Ranging regime: **DO NOT** trade ORB or gap continuation
- Choppy regime: **DO NOT** trade ANY pattern

---

## Step 4 — Confluence Scoring (Minimum 3 Required)

**Gate Rule**: Each pattern must score at least 3 confluences. Fewer → skip the trade.

### Confluence Checklist

For any trade candidate, check each:

#### Technical Confluences

- [ ] **Volume** — Candle volume > 20-day average? (+1)
- [ ] **S/R Level** — Pattern at key support, resistance, or moving average? (+1)
- [ ] **RSI Aligned** — RSI < 35 (oversold for longs) or > 65 (overbought for shorts)? (+1)
- [ ] **MACD Signal** — MACD crossed in direction of intended trade within last 3 candles? (+1)
- [ ] **ATR Expansion** — ATR > 20-day average (volatility present)? (+1)

#### Macro Confluences

- [ ] **Weekday Edge** — Today's day-of-week favors this pattern type? (+1)
- [ ] **Day Grade** — Today grades A or A+? (not B)? (+1)
- [ ] **Regime Alignment** — Pattern perfectly matches regime, not just "allowed"? (+1)

#### Price Action Confluences

- [ ] **Trend Direction** — Trade aligns with 4-hour trend? (+1)
- [ ] **Multiple Signals** — This is 2nd or 3rd similar pattern attempt today, not first? (+1)

### Scoring Rule

Count each checked box = confluence score:

| Score | Position Sizing | Trade? |
|---|---|---|
| 6+ | Full position (100%) | **YES** — highest confidence |
| 4–5 | 75% position | **YES** — good confluence |
| 3 | 50% position | **YES** — minimum threshold |
| 0–2 | — | **NO** — skip the trade |

---

## Step 5 — Position Sizing & Risk Calculation

**Gate Rule**: Never fix a dollar amount or contract count. Always derive from ATR.

### Position Size Formula

```
Stop Distance (ATR-based) = 1.5x ATR (moderate) or 2x ATR (conservative)

Max Risk = Account × 1%
           (never exceed 2% even on very high confluence)

Position Size = Max Risk ÷ Stop Distance
```

### Example Calculations

**Account**: $50,000
**ATR (14)**: $2.00
**Pattern**: Engulfing (3 confluences)

```
Max Risk = $50,000 × 1% = $500
Stop Distance = 2 × $2.00 = $4.00
Position Size = $500 ÷ $4.00 = 125 contracts/shares
Confluence Modifier: 3 confluences = 50% size
Final Position = 125 × 0.50 = 62.5 contracts → round to 60
```

### Confluence Size Scaling

After calculating base size, apply confluence modifier:

| Confluence Score | Modifier | Action |
|---|---|---|
| 6+ | 100% | Use full calculated size |
| 4–5 | 75% | Multiply position by 0.75 |
| 3 | 50% | Multiply position by 0.50 |

### Risk Management Constraints

- **1% Rule** (recommended): Never risk > 1% of account on one trade
- **2% Rule** (experienced only): Max 2% risk on exceptional setups (6+ confluence)
- **Absolute Max**: Never exceed 2% per trade regardless of confluence
- **Account volatility cap**: If account down >5% this week, reduce all position sizes 50%

---

## Step 6 — Entry Rules (Per Pattern Type)

**Gate Rule**: Entry method is pattern-specific. Use exact entry rule for the pattern you identified in Step 3.

### Entry Rule — ORB (Opening Range Breakout)

**Setup**:
1. Opening range established 9:30–10:00 AM
2. High = resistance, Low = support
3. Qualify range: range size > 0.75x average daily range

**Entry Trigger** (10:00–11:30 AM window only):

**Bullish Entry**:
- Price closes above opening range high
- Entry order: limit order 0.25 ATR above opening range high (confirmation on close)
- OR: market order immediately after close above high

**Bearish Entry**:
- Price closes below opening range low
- Entry order: limit order 0.25 ATR below opening range low
- OR: market order immediately after close below low

**Time Constraint**: No ORB entries after 11:30 AM. Best window is 10:00–11:00 AM.

---

### Entry Rule — Gap Fill Strategy

**Setup**:
1. Gap > 2% identified at open
2. Regime = ranging
3. Target = previous day's close

**Entry Method**:

**For Up Gap (Short Gap Fill)**:
1. Monitor first 15 minutes of trading (9:30–9:45 AM)
2. If price momentum is weakening and volume dropping, entry signal
3. Entry: short below 9:45 AM candle low (or at support)
4. Stop: above gap high
5. Target: previous close (gap fill level)

**For Down Gap (Long Gap Fill)**:
1. Monitor first 15 minutes
2. If price momentum is weakening, entry signal
3. Entry: long above 9:45 AM candle high (or at support)
4. Stop: below gap low
5. Target: previous close

**Time Constraint**: Gap fills typically occur within 1–3 days. Don't hold if not filled by day 3.

---

### Entry Rule — Gap Continuation Strategy

**Setup**:
1. Gap > 2% identified at open
2. Regime = trending (up or down)
3. Trade in direction of gap

**Entry Method**:

**For Up Gap (Long Continuation)**:
1. After initial gap, wait for 15-min consolidation (9:45–10:00 AM)
2. Look for breakout above consolidation high
3. Entry: market order on breakout above consolidation high
4. Stop: below gap low
5. Target: 1.5x ATR above entry

**For Down Gap (Short Continuation)**:
1. Wait for 15-min consolidation
2. Look for breakout below consolidation low
3. Entry: market order on breakout below consolidation low
4. Stop: above gap high
5. Target: 1.5x ATR below entry

---

### Entry Rule — Engulfing Pattern

**Setup**:
1. Engulfing candle formed (previous + current)
2. Volume > 20-day average
3. At support (bullish) or resistance (bearish)

**Entry Method** (next-day, after pattern forms):

**Bullish Engulfing Entry**:
1. Pattern forms (red candle engulfed by green candle)
2. Wait for close of engulfing candle
3. Next day, entry: market order above engulfing candle high
4. Stop: below engulfing candle low
5. Target: 1.5x ATR above entry (or confluence-based target)

**Bearish Engulfing Entry**:
1. Pattern forms (green candle engulfed by red candle)
2. Wait for close
3. Next day, entry: market order below engulfing candle low
4. Stop: above engulfing candle high
5. Target: 1.5x ATR below entry

---

### Entry Rule — Outside Day Pattern

**Setup**:
1. Outside day formed (high > prev high, low < prev low)
2. Volume > 20-day average
3. Close in upper/lower 25% of range (strong directional bias)

**Entry Method** (next day, after pattern forms):

**Bullish Outside Day (Close in Upper 25%)**:
1. Pattern forms with close near high
2. Next day, entry: market order above outside day high
3. Stop: below outside day low
4. Target: 1.5x outside day range above entry

**Bearish Outside Day (Close in Lower 25%)**:
1. Pattern forms with close near low
2. Next day, entry: market order below outside day low
3. Stop: above outside day high
4. Target: 1.5x outside day range below entry

---

## Step 7 — Stop Loss Rules (Mandatory)

**Rule**: Stop-loss must be placed BEFORE submitting entry order. No exceptions.

### Stop Placement by Pattern

| Pattern | Long Stop | Short Stop |
|---|---|---|
| **ORB** | Below opening range low | Above opening range high |
| **Gap Fill** | Below gap low (or support + ATR) | Above gap high (or resistance + ATR) |
| **Gap Continuation** | Below gap low | Above gap high |
| **Engulfing** | Below engulfing candle low | Above engulfing candle high |
| **Outside Day** | Below outside day low | Above outside day high |

### Stop Adjustment Rules

- **Initial Stop**: Placed per pattern rule above
- **1st Partial Win** (1x ATR move in favor): Move stop to breakeven
- **2nd Partial Win** (additional 1x ATR): Move stop to +0.5x ATR
- **Never Move Away**: Stop can only move closer or stay; never move further away
- **Trailing Stop** (final third of position): Use 1x ATR trailing stop

### Time-Based Stop

- If no movement 2 hours after entry → close position at market
- Thesis has failed; preserve capital

---

## Step 8 — Profit Taking (3-Tier Framework)

**Rule**: Exit in three equal parts at fixed targets. Never hold "to the moon."

### Exit Targets (from entry price)

**Tier 1 (33% of position)**:
- Target = 1.5x ATR from entry
- Action: Close 33% of position
- Adjustment: Move remaining stop to breakeven

**Tier 2 (33% of position)**:
- Target = 2x ATR from entry
- Action: Close another 33%
- Adjustment: Move remaining stop to +0.5x ATR

**Tier 3 (33% of position)**:
- Target = trailing stop (1x ATR behind price)
- Action: Let final third ride with trailing stop
- Exit condition: Either hit trailing stop or end of day (never hold overnight)

### Time-Based Exits

| Duration | Action |
|---|---|
| **2 hours no move** | Close entire position |
| **Approaching 3:00 PM EST** | Prepare exit plan |
| **End of Day (3:55 PM EST)** | Close all positions; no overnight holds |
| **Friday EOD** | Force-close all positions; zero weekend risk |

### Exception: Multi-Day Patterns

Outside Day / Gap Fill patterns may hold 1–3 days if target not hit same day:
- Move stop to breakeven after 1st full day
- Close by end of day 3 regardless
- Do not hold past 3 trading days

---

## Step 9 — Trade Logging (Required for All Trades)

**Rule**: Every trade must be logged immediately after entry and updated on exit. No exceptions.

### Log Template

```
Date: ___________
Day Grade: [ ] A+  [ ] A  [ ] B
Regime: [ ] Trending Up  [ ] Trending Down  [ ] Ranging  [ ] Choppy
Pattern: [ ] ORB  [ ] Gap Fill  [ ] Gap Cont.  [ ] Engulfing  [ ] Outside Day
Confluence Score: _____ / 10

Entry:
  - Time: ___________
  - Price: ___________
  - Volume check: [ ] >20-day avg
  - Signal confirmation: [ ] Yes

Position:
  - Account Size: $___________
  - Stop Distance: _____ ATR ($_____)
  - Position Size: _____ shares/contracts
  - Risk: $ _____ (_____ % account)
  - R:R Target: 1:_____

Stop/Target:
  - Stop: ___________
  - Target 1 (1.5x ATR): ___________
  - Target 2 (2x ATR): ___________
  - Target 3 (trailing): 1x ATR trail

Exit:
  - Time: ___________
  - Price: ___________
  - Tier 1 closed at: ___________
  - Tier 2 closed at: ___________
  - Tier 3 closed at: ___________

Result:
  - Win / Loss: [ ] Win  [ ] Loss
  - Profit/Loss: $ ___________
  - R-multiple: _____x
  - Duration: _____ min/hours

Notes:
  - What was followed: _______________________
  - What was broken: _______________________
  - Lesson: _______________________
```

### Weekly Review Process

At end of each week:
1. Count total trades, wins, losses
2. Win rate = wins ÷ total trades
3. Avg win size × win count
4. Avg loss size × loss count
5. Profit factor = total wins ÷ total losses
6. Any patterns in failures? (oversizing, wrong regime, etc.)
7. Adjust Day Quality thresholds or Confluence scoring if needed

---

## Decision Tree Flowchart (Visual Quick Start)

```
START
  ↓
[STEP 1] Day Quality
  A+/A → Continue
  B → Reduce size
  C/F → STOP (no trades)
  ↓
[STEP 2] Market Regime
  Trending → ORB/Gap-Cont/Engulfing-with-trend
  Ranging → Gap-Fill/Outside-Day-Reverse/Engulfing-at-SR
  Choppy → STOP (no pattern trades)
  ↓
[STEP 3] Pattern Identification
  Valid for regime? → Continue
  Invalid → STOP
  ↓
[STEP 4] Confluence Score
  ≥3 → Continue
  <3 → STOP
  ↓
[STEP 5] Position Size Calc
  Size = (Account × 1% ÷ Stop Distance) × Confluence Mod
  ↓
[STEP 6] Entry Signal
  Pattern-specific rule met? → ENTER
  Not met → WAIT or CANCEL
  ↓
[STEP 7] Stop & Targets
  Place stop BEFORE entry
  Set 3-tier targets
  ↓
[STEP 8] Management
  Tier 1 @ 1.5x ATR → Move stop BE
  Tier 2 @ 2x ATR → Trail final third
  Tier 3 or EOD → Close position
  ↓
[STEP 9] Log Trade
  Record all metadata for review
  ↓
CYCLE REPEATS
```

---

## Common Violations & Consequences

| Violation | What Happens | Fix |
|---|---|---|
| Skip day quality gate (enter on F-grade day) | 80%+ loss rate on bad days | Force yourself to wait; use checklist |
| Trade pattern not in regime menu | High false breakout rate | Check regime before pattern ID |
| Less than 3 confluences | Low win rate, large stops | Increase minimum to 4 confluences |
| Position sized on fixed dollar amount | Over/under-leveraged | Always use ATR formula |
| No stop loss placed | Catastrophic loss possible | Place stop BEFORE entry order |
| Move stop further away | Converts winners to losers | Lock in rules: move stop closer only |
| Hold past EOD (except 3-day exceptions) | Weekend gap risk | Calendar reminder: close Fri EOD |
| No trade log | Can't improve | Habit: log immediately after entry |

---

## Checklist for Each Trading Day

### Pre-Market (Before 9:30 AM)

- [ ] Check economic calendar — any major news? (if yes: F-grade, skip day)
- [ ] Calculate ATR(14) vs 20-day average
- [ ] Check volume vs 50-day average
- [ ] Check 4-hour trend direction (up/down/ranging)
- [ ] Assign day grade: A+/A/B/C/F
- [ ] If C or F: **STOP, no trades today**
- [ ] If A+/A/B: identify market regime (trending/ranging/choppy)
- [ ] List valid patterns for today's regime
- [ ] Have position sizing spreadsheet open (ATR formula ready)

### During Market Hours (9:30 AM – 3:55 PM)

- [ ] Track opening range (9:30–10:00 AM)
- [ ] At 10:00 AM: qualify if ORB is valid trade
- [ ] Watch for gap, engulfing, outside day patterns
- [ ] For each potential pattern:
  - [ ] Check regime match
  - [ ] Score confluences (minimum 3)
  - [ ] Calculate position size from ATR
  - [ ] Verify entry rule for pattern type
  - [ ] **Place stop BEFORE entry order**
  - [ ] Submit entry order
- [ ] Monitor Tier 1 target (1.5x ATR)
- [ ] Move stop to breakeven on Tier 1 fill
- [ ] Monitor Tier 2 target (2x ATR)
- [ ] Set trailing stop for Tier 3
- [ ] Log trade immediately after entry

### End of Day (3:50 PM – 3:55 PM)

- [ ] Check any open positions
- [ ] Close all positions by 3:55 PM (no overnight holds)
- [ ] On Friday: force-close all positions (zero weekend risk)
- [ ] Update trade log with exit prices
- [ ] Mark win/loss and R-multiple

### After Market (Post-Close)

- [ ] Review today's trades: what was followed, what broke?
- [ ] Calculate daily win rate and profit factor
- [ ] Check: did you violate any rules? (over-trade, no confluence check, etc.)
- [ ] Adjust next day if needed

---

## Rule Review & Iteration

This framework is intentionally rigid because the goal is **consistency**, not cleverness. If you find yourself breaking these rules:

1. **Don't modify the rules mid-session** — document what you wanted to do and why
2. **Weekly review**: Do the rules work? (should see 50%+ win rate over 50+ trades)
3. **If win rate < 45%**: Increase confluence minimum to 4, increase day grade gate
4. **If over-trading**: Set max trades per day (e.g., 3 trades max)
5. **If stops hit constantly**: Widen stops to 2x ATR (conservative mode)

The goal is a profitable, repeatable edge — not a winning streak. Stick to the rules.

---

*Framework compiled from Comprehensive Trading Guide analysis. Use Step 1–9 in order, every day, every trade.*
