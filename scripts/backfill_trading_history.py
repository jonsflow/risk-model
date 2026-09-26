"""
Backfill trading signals cache for all available weekdays.
Run manually or via GitHub Actions workflow_dispatch.
Runs the generator once per stage, in session order, for each date. Stages
already in a day's file are left as they are; --force deletes the file first.

Usage:
  python3 scripts/backfill_trading_history.py           # add missing stages
  python3 scripts/backfill_trading_history.py --force   # regenerate all

Requires SQLite to be seeded first: python3 -m pipeline.run seed
"""
import argparse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path("data")
CACHE_DIR = DATA_DIR / "cache"


MAX_BACKFILL_YEARS = 5

def get_backfill_date_range(db, lookback_days=90):
    """Return (start_date, end_date) for backfill — latest SPY daily bar date
    in SQLite, lookback_days back. Hard cap: never go further back than
    MAX_BACKFILL_YEARS years. Uses SQLite because the workflow no longer
    mirrors daily fetches to data/spy.csv."""
    last_ts = db.last_daily_timestamp('SPY')
    if last_ts is None:
        raise RuntimeError("No SPY daily bars in SQLite — run `pipeline.run seed` and/or `pipeline.run fetch` first.")
    end   = datetime.fromtimestamp(last_ts, tz=timezone.utc).date()
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
                        help="Delete each day's file first and regenerate every stage")
    parser.add_argument('--days', type=int, default=90,
                        help='How many calendar days back to backfill (default: 90)')
    args = parser.parse_args()

    from pipeline.db_manager import DBManager
    from pipeline.generators.trading_generator import TradingGenerator, _load_config

    db = DBManager()
    generator = TradingGenerator(db, cache_dir=CACHE_DIR)
    stages = [st.name for st in _load_config().stages]

    # Actual trading days = dates with a SPY daily bar. Yahoo returns bars only
    # for sessions the market was open, so this excludes weekends and holidays.
    trading_days = {
        datetime.fromtimestamp(ts, tz=timezone.utc).date()
        for ts, _ in db.load_daily_ohlcv('SPY')
    }

    start, end = get_backfill_date_range(db, lookback_days=args.days)
    print(f"Backfilling {start} → {end}{' (force)' if args.force else ''}")
    skipped = generated = 0
    for d in weekdays_in_range(start, end):
        if d not in trading_days:
            print(f"  skip {d} (market closed — no daily bar)")
            skipped += 1
            continue
        out = CACHE_DIR / f"trading_signals_{d.isoformat()}.json"
        if args.force:
            out.unlink(missing_ok=True)
        print(f"  generating {d}...")
        for stage in stages:
            generator.generate(target_date=d, stage_name=stage)
        generated += 1
    print(f"\nDone — {generated} generated, {skipped} skipped")


if __name__ == '__main__':
    main()
