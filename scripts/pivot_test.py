import csv
import sys

lookback = int(sys.argv[1]) if len(sys.argv) > 1 else 20

# Load data
rows = []
with open('data/spy.csv') as f:
    for row in csv.DictReader(f):
        rows.append({'date': row['Date'], 'close': float(row['Close'])})

pts = rows[-lookback:]

# Find N=1 pivots (skip first and last bar)
pivots = []
for i in range(1, len(pts) - 1):
    curr = pts[i]['close']
    prev = pts[i-1]['close']
    nxt  = pts[i+1]['close']
    if curr > prev and curr > nxt:
        pivots.append({'date': pts[i]['date'], 'close': curr, 'type': 'high', 'i': i})
    elif curr < prev and curr < nxt:
        pivots.append({'date': pts[i]['date'], 'close': curr, 'type': 'low', 'i': i})

# Label each pivot by comparing to previous same-type pivot (Pine Script style)
# Walk chronologically: each high vs prev high → HH/LH, each low vs prev low → LL/HL
labeled = []
last_high = None
last_low  = None

for p in pivots:
    if p['type'] == 'high':
        if last_high is None:
            label = 'HH'  # first high in window, no comparison yet
        elif p['close'] > last_high['close']:
            label = 'HH'
        else:
            label = 'LH'
        last_high = {**p, 'label': label}
        labeled.append(last_high)
    else:
        if last_low is None:
            label = 'LL'  # first low in window, no comparison yet
        elif p['close'] < last_low['close']:
            label = 'LL'
        else:
            label = 'HL'
        last_low = {**p, 'label': label}
        labeled.append(last_low)

# Build lookup for printing
label_map = {p['i']: p['label'] for p in labeled}

# Print all price points
print(f"=== {lookback}-day window ===")
for i, p in enumerate(pts):
    pivot_type = ''
    struct_label = ''
    if i in label_map:
        pl = [x for x in labeled if x['i'] == i][0]
        pivot_type = pl['type']
        struct_label = pl['label']
    marker = f"  {pivot_type:<4}  {struct_label}" if pivot_type else ''
    print(f"  [{i:2d}] {p['date']}  {p['close']:>8.2f}{marker}")

# Final structure = last label of each type
final_high_label = last_high['label'] if last_high else None
final_low_label  = last_low['label']  if last_low  else None

if final_high_label == 'HH' and final_low_label == 'HL':
    structure = 'HH + HL ↗'
elif final_high_label == 'HH':
    structure = 'HH only ↗'
elif final_high_label == 'LH' and final_low_label == 'LL':
    structure = 'LL + LH ↘'
elif final_low_label == 'LL':
    structure = 'LL only ↘'
else:
    structure = 'Sideways ↔'

print(f"\n=== Labeled pivots ===")
for p in labeled:
    print(f"  [{p['i']:2d}] {p['date']}  {p['close']:>8.2f}  {p['label']}")

print(f"\n=== Structure ===")
print(f"  Last high label : {final_high_label} ({last_high['date']} @ {last_high['close']:.2f})" if last_high else "  Last high: none")
print(f"  Last low label  : {final_low_label} ({last_low['date']} @ {last_low['close']:.2f})" if last_low else "  Last low: none")
print(f"  → {structure}")
