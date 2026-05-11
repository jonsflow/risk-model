"""
pipeline/fetchers/yahoo_fetcher.py — Fetch Yahoo Finance data into SQLite.

Replaces fetch_data.py and fetch_trading_hourly.py.
Reads config.json + macro_config.json to determine which symbols to fetch.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

from pipeline.base_fetcher import BaseFetcher
from pipeline.db_manager import DBManager

# Symbols whose Yahoo Finance ticker differs from the symbol name
TICKER_MAP = {
    'BTC':    'BTC-USD',
    'ETH':    'ETH-USD',
    'VIX':    '^VIX',
    'USDJPY': 'USDJPY=X',
    'AUDUSD': 'AUDUSD=X',
}


def _load_symbols() -> tuple[list[str], dict[str, str]]:
    """Load all unique symbols from config.json + macro_config.json."""
    seen: set[str] = set()
    symbols: list[str] = []
    ticker_map: dict[str, str] = {}

    def add(symbol: str, ticker: str | None = None) -> None:
        if symbol not in seen:
            seen.add(symbol)
            symbols.append(symbol)
        t = ticker or TICKER_MAP.get(symbol, symbol)
        if t != symbol:
            ticker_map[symbol] = t

    config_path = Path('config.json')
    if config_path.exists():
        cfg = json.loads(config_path.read_text())
        for entry in cfg.get('symbols', []):
            add(entry['symbol'], entry.get('ticker'))

    macro_path = Path('macro_config.json')
    if macro_path.exists():
        mcfg = json.loads(macro_path.read_text())
        for cat in mcfg.get('macro_categories', []):
            for asset in cat.get('assets', []):
                add(asset['symbol'])
        for sym in mcfg.get('regime_signals', []):
            add(sym)

    trading_path = Path('trading_config.json')
    if trading_path.exists():
        tcfg = json.loads(trading_path.read_text())
        for entry in tcfg.get('symbols', []):
            add(entry['symbol'], entry.get('ticker'))

    correlation_path = Path('correlation_config.json')
    if correlation_path.exists():
        ccfg = json.loads(correlation_path.read_text())
        for pair in ccfg.get('pairs', []):
            add(pair['symbol1'])
            add(pair['symbol2'])

    return symbols, ticker_map


class YahooFetcher(BaseFetcher):
    def fetch(self) -> None:
        symbols, ticker_map = _load_symbols()
        print(f"Fetching {len(symbols)} symbols from Yahoo Finance...", file=sys.stderr)

        for symbol in symbols:
            try:
                print(f"  {symbol}...", file=sys.stderr)
                self._fetch_symbol(symbol, ticker_map)
            except Exception as e:
                print(f"  ERROR fetching {symbol}: {e}", file=sys.stderr)
                raise

        # Write timestamp
        ts_file = Path('data/last_updated.txt')
        ts_file.parent.mkdir(exist_ok=True)
        ts_file.write_text(datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'))
        print("Done.", file=sys.stderr)

    def _fetch_symbol(self, symbol: str, ticker_map: dict) -> None:
        ticker_symbol = ticker_map.get(symbol, symbol)
        ticker = yf.Ticker(ticker_symbol)
        self._fetch_daily(symbol, ticker)
        self._fetch_hourly(symbol, ticker)

    def _fetch_daily(self, symbol: str, ticker) -> None:
        last_ts = self.db.last_daily_timestamp(symbol.upper())
        if last_ts:
            start_date = datetime.fromtimestamp(last_ts, tz=timezone.utc).strftime('%Y-%m-%d')
            df = ticker.history(start=start_date, interval='1d')
        else:
            df = ticker.history(period='max', interval='1d')

        if df.empty:
            print(f"    WARNING: no daily data for {symbol}", file=sys.stderr)
            return

        df = df.reset_index()
        df['Date'] = df['Date'].dt.strftime('%Y-%m-%d')

        rows = []
        for _, row in df.iterrows():
            try:
                ts = int(datetime.strptime(row['Date'], '%Y-%m-%d')
                         .replace(tzinfo=timezone.utc).timestamp())
                rows.append((
                    symbol.upper(), ts, 'daily',
                    float(row.get('Open', 0) or 0),
                    float(row.get('High', 0) or 0),
                    float(row.get('Low', 0) or 0),
                    float(row['Close']),
                    int(row.get('Volume', 0) or 0),
                ))
            except (ValueError, KeyError, TypeError):
                continue

        if rows:
            self.db.upsert_prices(rows)
            print(f"    daily  {symbol}: {len(rows)} bars stored", file=sys.stderr)

    def _fetch_hourly(self, symbol: str, ticker) -> None:
        last_ts = self.db.last_hourly_timestamp(symbol.upper())
        if last_ts:
            start_date = datetime.fromtimestamp(last_ts, tz=timezone.utc).strftime('%Y-%m-%d')
            df = ticker.history(start=start_date, interval='1h', prepost=True)
        else:
            df = ticker.history(period='1mo', interval='1h', prepost=True)

        if df.empty:
            print(f"    WARNING: no hourly data for {symbol}", file=sys.stderr)
            return

        df = df.reset_index()

        rows = []
        for _, row in df.iterrows():
            try:
                dt = row['Datetime']
                ts = int(dt.timestamp())
                rows.append((
                    symbol.upper(), ts, 'hourly',
                    float(row.get('Open', 0) or 0),
                    float(row.get('High', 0) or 0),
                    float(row.get('Low', 0) or 0),
                    float(row['Close']),
                    int(row.get('Volume', 0) or 0),
                ))
            except (ValueError, KeyError, TypeError):
                continue

        if rows:
            self.db.upsert_prices(rows)
            print(f"    hourly {symbol}: {len(rows)} bars stored", file=sys.stderr)


if __name__ == '__main__':
    YahooFetcher().run()
