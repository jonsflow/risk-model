# Market Structure: HH / HL / LH / LL

Reference for the pivot-based market structure used in this codebase.

---

## The Four Labels

| Label | Full Name    | Pivot Type | Definition |
|-------|-------------|------------|------------|
| HH    | Higher High | HIGH pivot | Highest swing high in the window |
| HL    | Higher Low  | LOW pivot  | The pivot LOW immediately before HH (the "protected level") |
| LH    | Lower High  | HIGH pivot | First pivot HIGH after LL (the bounce after the low) |
| LL    | Lower Low   | LOW pivot  | Lowest swing low in the window |

---

## Key Rules

1. **LH only forms after LL** — a Lower High is always a bounce after a Lower Low.
   It is NOT the first pullback after a HH.

2. **Uptrend holds while the pivot LOW before HH is not breached.**
   The HL is the "protected level". Price must stay above it for the uptrend to remain valid.

3. **Downtrend begins when price breaks below the HL** (the pivot low before HH).
   That break creates the first LL. After LL, the first bounce high becomes the LH.

---

## Uptrend Structure

```
Sequence: HL → HH → HL → HH ...

          HH2
         /
    HH1 /
   /   X
  /  HL2
HL1
```

- Each swing HIGH is higher than the last → HH
- Each swing LOW (before each HH) is higher than the last → HL
- **Uptrend is intact** as long as price stays above the most recent HL
- **HL = last pivot LOW before the HH** (the support level protecting the uptrend)

---

## Transition: Uptrend → Downtrend

```
        HH (peak — cannot go higher)
       /  \
      /    \  ← price falls
  HL /      \
----+--------\----- HL level (protected level)
              \
               LL  ← HL is breached → first LL → downtrend begins
```

1. Price makes a HH
2. Price pulls back — the pullback low is the **HL** (protected level)
3. Price **fails to hold above HL** → closes below it
4. That break below HL creates the first **LL** → downtrend is now confirmed
5. Price bounces from LL → that bounce high is the first **LH**

---

## Downtrend Structure

```
Sequence: LL → LH → LL → LH ...

LH1
   \      LH2
    \     /  \
     LL1 /    \
         \     LL2
```

- Price breaks below previous HL → first LL forms
- Price bounces from LL → bounce high is the **LH** (always after a LL)
- Each LH is lower than the previous HH
- Then price breaks below LH → new LL forms
- Sequence repeats: **LL → LH → LL → LH ...**

---

## Algorithm

### Inputs
- `points`: array of `{time, value}` ordered oldest → newest (a fixed lookback window, e.g. 20/50/100 days)

### Step 1 — Pivot detection (N=1)
```
for i in 1 .. len-2:          # skip first and last bars
    if price[i] > price[i-1] AND price[i] > price[i+1]  → pivot HIGH
    if price[i] < price[i-1] AND price[i] < price[i+1]  → pivot LOW
```
First and last bars are **excluded from pivot detection** but used as the initial reference (see Step 2).

### Step 2 — Seed reference from window open
Before walking pivots, initialise:
```
lastHigh = { value: points[0].value }   # window's opening price
lastLow  = { value: points[0].value }   # window's opening price
```
This ensures the first pivot is compared against where the window started, not labeled unconditionally.

### Step 3 — Label each pivot (Pine Script style)
Walk all pivots in chronological order. For each:

**Pivot HIGH:**
```
if price > lastHigh.value → label = HH,  update lastHigh  (new running high)
else                       → label = LH  (below current high, don't update lastHigh)
```

**Pivot LOW:**
```
if price < lastLow.value  → label = LL,  update lastLow   (new running low)
else                       → label = HL  (above current low, don't update lastLow)
```

Key rule: `lastHigh` only advances on a confirmed HH; `lastLow` only advances on a confirmed LL.
This means a LH does not reset the high baseline — the next high still compares against the true running high.

### Step 4 — Final structure label
Read the label of the **last** pivot high and **last** pivot low in the window:

| Last high label | Last low label | Structure |
|-----------------|----------------|-----------|
| HH | HL | `HH + HL ↗` |
| HH | LL | `HH only ↗` |
| LH | LL | `LL + LH ↘` |
| LH | HL | `LH + HL ↔` |
| — | — | `Sideways ↔` |

### Marker colors
| Label | Color |
|-------|-------|
| HH | Teal `#14b8a6` |
| HL | Green `#4ade80` |
| LH | Orange `#f97316` |
| LL | Red `#ff4d4d` |

---

## Future: Equal High / Equal Low

When two pivots of the same type are within a threshold (e.g. 0.1% of price), they may be labeled:
- **EH** (Equal High) — potential trend change signal, neither HH nor LH
- **EL** (Equal Low) — potential trend change signal, neither LL nor HL

Not yet implemented. `lastHigh` / `lastLow` advancement rules will need a third branch.
