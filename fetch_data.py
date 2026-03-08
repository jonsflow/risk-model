#!/usr/bin/env python3
"""
Fetch both hourly and daily data from Yahoo Finance using yfinance.
Saves data to CSV files in data/ directory for use by the static site.

Reads configuration from config.json to determine which symbols to fetch.

- Hourly data: data/{symbol}_hourly.csv (last 1 month, ~143 bars)
- Daily data: data/{symbol}.csv (max available history for long-term analysis)
"""

import yfinance as yf
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
    """Fetch daily data — incremental if existing CSV present, else full max history.

    Existing rows are never re-parsed through pandas to avoid float reformatting,
    which would cause spurious git diffs across thousands of rows.
    """
    csv_path = data_dir / f'{symbol.lower()}.csv'

    # Read last date directly from the file (no pandas) to preserve original formatting
    last_date = None
    existing_lines = None
    if csv_path.exists():
        try:
            with open(csv_path, 'r') as f:
                existing_lines = f.readlines()
            if len(existing_lines) > 1:
                last_date = existing_lines[-1].split(',')[0].strip()
        except Exception:
            pass

    ticker_symbol = ticker_map.get(symbol, symbol)
    ticker = yf.Ticker(ticker_symbol)

    if last_date:
        # Fetch from last known date inclusive (catches any price corrections too)
        df = ticker.history(start=last_date, interval='1d')
    else:
        df = ticker.history(period='max', interval='1d')

    if df.empty:
        print(f"WARNING: No daily data returned for {symbol}", file=sys.stderr)
        return

    df = df.reset_index()
    df['Date'] = df['Date'].dt.strftime('%Y-%m-%d')
    new_df = df[['Date', 'Open', 'High', 'Low', 'Close', 'Volume']]

    if last_date and existing_lines:
        # Keep existing lines that predate new fetch; drop overlap so corrections apply
        first_new_date = new_df['Date'].iloc[0]
        header = existing_lines[0]
        kept = [l for l in existing_lines[1:] if l.split(',')[0] < first_new_date]
        new_csv = new_df.to_csv(index=False, header=False)
        with open(csv_path, 'w') as f:
            f.write(header)
            f.writelines(kept)
            f.write(new_csv)
        print(f"✓ {symbol} daily: +{len(new_df)} new bars (total {len(kept) + len(new_df)}) → {csv_path}", file=sys.stderr)
    else:
        new_df.to_csv(csv_path, index=False)
        print(f"✓ {symbol} daily: {len(new_df)} bars → {csv_path}", file=sys.stderr)

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
