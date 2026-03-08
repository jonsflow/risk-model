#!/usr/bin/env python3
"""
Fetch both hourly and daily data from Yahoo Finance using yfinance.
Saves data to CSV files in data/ directory for use by the static site.

Reads configuration from config.json to determine which symbols to fetch.

- Hourly data: data/{symbol}_hourly.csv (last 1 month, ~143 bars)
- Daily data: data/{symbol}.csv (max available history for long-term analysis)
"""

import yfinance as yf
import pandas as pd
import sys
import json
from pathlib import Path
from datetime import datetime, timezone

def load_config():
    """Load configuration from config.json"""
    config_path = Path('config.json')
    if not config_path.exists():
        print("ERROR: config.json not found", file=sys.stderr)
        sys.exit(1)

    with config_path.open('r') as f:
        return json.load(f)

def load_macro_config():
    """Load macro configuration from macro_config.json"""
    macro_path = Path('macro_config.json')
    if not macro_path.exists():
        return None

    with macro_path.open('r') as f:
        return json.load(f)

def get_symbols_from_config(config):
    """Extract symbols and ticker mappings from config.json (divergence symbols)"""
    symbols = []
    ticker_map = {}

    for entry in config['symbols']:
        symbol = entry['symbol']
        ticker = entry.get('ticker', symbol)

        symbols.append(symbol)
        if ticker != symbol:
            ticker_map[symbol] = ticker

    return symbols, ticker_map

def get_symbols_from_macro_config(macro_config):
    """Extract unique symbols and ticker mappings from macro_config.json categories.

    macro_config.json only stores symbol names, not ticker overrides, so we
    need a hardcoded map for the symbols that require a non-standard Yahoo ticker.
    """
    MACRO_TICKER_MAP = {
        'BTC': 'BTC-USD',
        'ETH': 'ETH-USD',
        'VIX': '^VIX',
    }

    seen = set()
    symbols = []
    ticker_map = {}

    for category in macro_config.get('macro_categories', []):
        for asset in category.get('assets', []):
            symbol = asset['symbol']
            if symbol not in seen:
                seen.add(symbol)
                symbols.append(symbol)
                ticker = MACRO_TICKER_MAP.get(symbol, symbol)
                if ticker != symbol:
                    ticker_map[symbol] = ticker

    return symbols, ticker_map

def fetch_hourly(symbol, ticker_map, data_dir):
    """Fetch hourly data (last 1 month)"""
    ticker_symbol = ticker_map.get(symbol, symbol)
    ticker = yf.Ticker(ticker_symbol)
    df = ticker.history(period='1mo', interval='1h')

    if df.empty:
        print(f"WARNING: No hourly data returned for {symbol}", file=sys.stderr)
        return

    # Reset index to get Datetime as a column
    df = df.reset_index()

    # Convert datetime to separate Date and Time columns
    df['Date'] = df['Datetime'].dt.strftime('%Y-%m-%d')
    df['Time'] = df['Datetime'].dt.strftime('%H:%M:%S')

    # Format: Date,Time,Open,High,Low,Close,Volume
    output_df = df[['Date', 'Time', 'Open', 'High', 'Low', 'Close', 'Volume']]

    # Save to *_hourly.csv
    csv_path = data_dir / f'{symbol.lower()}_hourly.csv'
    output_df.to_csv(csv_path, index=False)

    print(f"✓ {symbol} hourly: {len(output_df)} bars → {csv_path}", file=sys.stderr)

def fetch_daily(symbol, ticker_map, data_dir):
    """Fetch daily data — incremental if existing CSV present, else full max history."""
    csv_path = data_dir / f'{symbol.lower()}.csv'

    # Read last date from existing CSV for incremental fetch
    last_date = None
    existing_df = None
    if csv_path.exists():
        try:
            existing_df = pd.read_csv(csv_path)
            if not existing_df.empty:
                last_date = existing_df['Date'].iloc[-1]
        except Exception:
            pass

    ticker_symbol = ticker_map.get(symbol, symbol)
    ticker = yf.Ticker(ticker_symbol)

    if last_date:
        # Fetch only from last known date (inclusive, so corrections are captured too)
        df = ticker.history(start=last_date, interval='1d')
    else:
        df = ticker.history(period='max', interval='1d')

    if df.empty:
        print(f"WARNING: No daily data returned for {symbol}", file=sys.stderr)
        return

    df = df.reset_index()
    df['Date'] = df['Date'].dt.strftime('%Y-%m-%d')
    new_df = df[['Date', 'Open', 'High', 'Low', 'Close', 'Volume']]

    if last_date and existing_df is not None:
        # Drop overlapping rows from existing, append fresh rows
        existing_df = existing_df[existing_df['Date'] < new_df['Date'].iloc[0]]
        combined_df = pd.concat([existing_df, new_df], ignore_index=True)
        added = len(combined_df) - len(existing_df)
        print(f"✓ {symbol} daily: +{added} new bars (total {len(combined_df)}) → {csv_path}", file=sys.stderr)
    else:
        combined_df = new_df
        print(f"✓ {symbol} daily: {len(combined_df)} bars → {csv_path}", file=sys.stderr)

    combined_df.to_csv(csv_path, index=False)

def main():
    # Load configuration from both config files
    config = load_config()
    divergence_symbols, divergence_tickers = get_symbols_from_config(config)

    macro_config = load_macro_config()
    macro_symbols, macro_tickers = get_symbols_from_macro_config(macro_config) if macro_config else ([], {})

    # Merge: deduplicate symbols, merge ticker maps
    seen = set(divergence_symbols)
    symbols = list(divergence_symbols)
    for sym in macro_symbols:
        if sym not in seen:
            seen.add(sym)
            symbols.append(sym)

    ticker_map = {**macro_tickers, **divergence_tickers}  # divergence takes precedence

    print(f"Loaded config: {len(divergence_symbols)} divergence + {len(macro_symbols)} macro symbols = {len(symbols)} total", file=sys.stderr)

    data_dir = Path('data')
    data_dir.mkdir(exist_ok=True)

    for symbol in symbols:
        try:
            print(f"Fetching {symbol}...", file=sys.stderr)

            # Fetch both hourly and daily
            fetch_hourly(symbol, ticker_map, data_dir)
            fetch_daily(symbol, ticker_map, data_dir)

        except Exception as e:
            print(f"ERROR fetching {symbol}: {e}", file=sys.stderr)
            sys.exit(1)

    print("✓ All data fetched successfully", file=sys.stderr)

    # Write timestamp file so browser knows when data was last updated
    timestamp_file = data_dir / 'last_updated.txt'
    with timestamp_file.open('w') as f:
        f.write(datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC'))

    print(f"✓ Updated timestamp: {timestamp_file}", file=sys.stderr)

if __name__ == '__main__':
    main()
