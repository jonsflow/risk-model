#!/usr/bin/env python3
"""
Fetch latest hourly data (including premarket/after-hours) for trading symbols.

Used by the morning GitHub Actions workflow (9 AM ET) to update hourly CSVs
with premarket bars before the trading session opens.

Reads trading symbols from trading_config.json.
Overwrites data/{symbol}_hourly.csv for trading symbols only (daily CSVs untouched).
"""

import yfinance as yf
import json
import sys
from pathlib import Path

DATA_DIR = Path('data')


def load_trading_config():
    config_path = Path('trading_config.json')
    if not config_path.exists():
        print("ERROR: trading_config.json not found", file=sys.stderr)
        sys.exit(1)
    with config_path.open() as f:
        config = json.load(f)
    symbols = []
    ticker_map = {}
    for entry in config['symbols']:
        symbol = entry['symbol']
        symbols.append(symbol)
        if 'ticker' in entry:
            ticker_map[symbol] = entry['ticker']
    return symbols, ticker_map


def fetch_trading_hourly(symbol, ticker_map):
    """Fetch 5 days of hourly data including pre/post market bars."""
    ticker_symbol = ticker_map.get(symbol, symbol)
    ticker = yf.Ticker(ticker_symbol)
    df = ticker.history(period='5d', interval='1h', prepost=True)

    if df.empty:
        print(f"WARNING: No hourly data for {symbol}", file=sys.stderr)
        return

    df = df.reset_index()
    df['Date'] = df['Datetime'].dt.strftime('%Y-%m-%d')
    df['Time'] = df['Datetime'].dt.strftime('%H:%M:%S')
    output_df = df[['Date', 'Time', 'Open', 'High', 'Low', 'Close', 'Volume']]

    csv_path = DATA_DIR / f'{symbol.lower()}_hourly.csv'
    output_df.to_csv(csv_path, index=False)
    print(f"✓ {symbol}: {len(output_df)} bars (prepost) → {csv_path}", file=sys.stderr)


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    symbols, ticker_map = load_trading_config()
    print(f"Fetching premarket hourly data for {len(symbols)} symbols: {', '.join(symbols)}...")
    for symbol in symbols:
        try:
            fetch_trading_hourly(symbol, ticker_map)
        except Exception as e:
            print(f"ERROR fetching {symbol}: {e}", file=sys.stderr)
    print("Done.")


if __name__ == '__main__':
    main()
