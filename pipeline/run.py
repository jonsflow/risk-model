"""
pipeline/run.py — Top-level runner for the v2 pipeline.

Usage:
  python -m pipeline.run fetch          # fetch Yahoo Finance + FRED
  python -m pipeline.run generate       # generate all caches from SQLite
  python -m pipeline.run all            # fetch + generate
  python -m pipeline.run seed           # seed SQLite from existing v1 CSVs (one-time)
  python -m pipeline.run trading [--date YYYY-MM-DD]
"""

import argparse
import sys

from pipeline.db_manager import DBManager


def cmd_seed(args):
    db = DBManager()
    db.create_schema()
    print("Seeding SQLite from existing CSV files...")
    db.seed_from_csvs()


def cmd_fetch(args):
    from pipeline.fetchers.yahoo_fetcher import YahooFetcher
    from pipeline.fetchers.fred_fetcher import FREDFetcher
    YahooFetcher().run()
    try:
        FREDFetcher().run()
    except EnvironmentError as e:
        print(f"FRED fetch skipped: {e}", file=sys.stderr)


def cmd_generate(args):
    from pipeline.generators.divergence_generator import DivergenceGenerator
    from pipeline.generators.macro_generator import MacroGenerator
    from pipeline.generators.trading_generator import TradingGenerator
    from pipeline.generators.correlation_generator import CorrelationGenerator

    db = DBManager()
    DivergenceGenerator(db).run()
    MacroGenerator(db).run()
    TradingGenerator(db).run()
    CorrelationGenerator(db).run()


def cmd_trading(args):
    from pipeline.generators.trading_generator import TradingGenerator
    from datetime import datetime
    target_date = datetime.strptime(args.date, '%Y-%m-%d').date() if args.date else None
    gen = TradingGenerator()
    gen.generate(target_date=target_date)


def main():
    parser = argparse.ArgumentParser(description="Risk Model v2 pipeline runner")
    sub = parser.add_subparsers(dest='command')

    sub.add_parser('seed',     help='Seed SQLite from existing v1 CSVs')
    sub.add_parser('fetch',    help='Fetch fresh data from Yahoo Finance + FRED')
    sub.add_parser('generate', help='Generate all cache files from SQLite')
    sub.add_parser('all',      help='Fetch + generate')

    trading_parser = sub.add_parser('trading', help='Generate trading signals only')
    trading_parser.add_argument('--date', default=None, help='Target date YYYY-MM-DD')

    args = parser.parse_args()

    if args.command == 'seed':
        cmd_seed(args)
    elif args.command == 'fetch':
        cmd_fetch(args)
    elif args.command == 'generate':
        cmd_generate(args)
    elif args.command == 'all':
        cmd_fetch(args)
        cmd_generate(args)
    elif args.command == 'trading':
        cmd_trading(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
