"""
Backfill trading signals cache for all available weekdays.
Run manually or via GitHub Actions workflow_dispatch.
Skips dates that already have a cache file unless --force is passed.

Usage:
  python3 backfill_trading_history.py           # skip existing
  python3 backfill_trading_history.py --force   # regenerate all
"""
import argparse
import subprocess
from datetime import date, timedelta
from pathlib import Path
import csv

DATA_DIR = Path("data")
CACHE_DIR = DATA_DIR / "cache"


MAX_BACKFILL_YEARS = 5

def get_backfill_date_range(lookback_days=90):
    """Return (start_date, end_date) for backfill — latest date from daily CSV, lookback_days back.
    Hard cap: never go further back than MAX_BACKFILL_YEARS years."""
    path = DATA_DIR / "spy.csv"
    with open(path) as f:
        rows = list(csv.DictReader(f))
    dates = sorted(set(r['Date'] for r in rows if r.get('Date')))
    end   = date.fromisoformat(dates[-1])
    start = end - timedelta(days=lookback_days)
    earliest = end.replace(year=end.year - MAX_BACKFILL_YEARS)
    return max(start, earliest), end


def weekdays_in_range(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:  # Mon–Fri
            yield d
        d += timedelta(days=1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true',
                        help='Regenerate cache files even if they already exist')
    parser.add_argument('--days', type=int, default=90,
                        help='How many calendar days back to backfill (default: 90)')
    args = parser.parse_args()

    start, end = get_backfill_date_range(lookback_days=args.days)
    print(f"Backfilling {start} → {end}{' (force)' if args.force else ''}")
    skipped = generated = 0
    for d in weekdays_in_range(start, end):
        out = CACHE_DIR / f"trading_signals_{d.isoformat()}.json"
        if out.exists() and not args.force:
            print(f"  skip {d} (already exists)")
            skipped += 1
            continue
        print(f"  generating {d}...")
        subprocess.run(['python3', 'generate_trading_cache.py', '--date', d.isoformat()], check=True)
        generated += 1
    print(f"\nDone — {generated} generated, {skipped} skipped")


if __name__ == '__main__':
    main()
