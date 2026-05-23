#!/usr/bin/env python3
"""
Shared utilities for generate_cache.py, generate_trading_cache.py, and fetch_data.py.
Uses stdlib only — no external dependencies.
"""

import csv
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path("data")

# Ticker overrides for symbols whose Yahoo Finance ticker differs from the symbol name.
# Used by generate_cache.py and fetch_data.py (as MACRO_TICKER_MAP).
TICKER_MAP = {
    'BTC':    'BTC-USD',
    'ETH':    'ETH-USD',
    'VIX':    '^VIX',
    'USDJPY': 'USDJPY=X',
    'AUDUSD': 'AUDUSD=X',
}


def last(arr: list, n: int) -> list:
    """Return the last n elements of arr."""
    return arr[max(0, len(arr) - n):]


def load_daily_csv(symbol: str) -> list:
    """Read data/{symbol}.csv, return [(timestamp_secs, close), ...]"""
    path = DATA_DIR / f"{symbol.lower()}.csv"
    if not path.exists():
        return []

    points = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            date  = row.get('Date', '').strip()
            close = row.get('Close', '').strip()
            if not date or not close or date == 'Date' or close == 'Close':
                continue
            try:
                t = int(datetime.strptime(date, '%Y-%m-%d')
                        .replace(tzinfo=timezone.utc).timestamp())
                c = float(close)
                points.append((t, c))
            except (ValueError, KeyError):
                continue

    points.sort(key=lambda x: x[0])
    return points


def load_hourly_close(symbol: str) -> list:
    """Read data/{symbol}_hourly.csv, return [(timestamp_secs, close), ...]"""
    path = DATA_DIR / f"{symbol.lower()}_hourly.csv"
    if not path.exists():
        return []
    points = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            date_str = row.get('Date', '').strip()
            time_str = row.get('Time', '').strip()
            close    = row.get('Close', '').strip()
            if not date_str or not time_str or not close:
                continue
            try:
                t = int(datetime.strptime(f"{date_str} {time_str}", '%Y-%m-%d %H:%M:%S')
                        .replace(tzinfo=timezone.utc).timestamp())
                points.append((t, float(close)))
            except (ValueError, KeyError):
                continue
    points.sort(key=lambda x: x[0])
    return points


def calculate_ma(points: list, period: int) -> list:
    """Simple moving average on [(timestamp, value), ...]. Returns same format."""
    ma_points = []
    for i in range(period - 1, len(points)):
        total = sum(points[j][1] for j in range(i - period + 1, i + 1))
        ma_points.append((points[i][0], total / period))
    return ma_points


def find_pivot_highs(points: list, left_bars: int, right_bars: int) -> list:
    """ThinkScript-style pivot high detection. Returns [{idx, time, price}, ...]"""
    pivot_highs = []
    for i in range(1, len(points) - 1):
        curr = points[i][1]
        is_pivot = True

        check_before = min(left_bars, i)
        for j in range(1, check_before + 1):
            if points[i - j][1] >= curr:
                is_pivot = False
                break

        if is_pivot:
            check_after = min(right_bars, len(points) - 1 - i)
            for j in range(1, check_after + 1):
                if points[i + j][1] >= curr:
                    is_pivot = False
                    break

        if is_pivot:
            pivot_highs.append({'idx': i, 'time': points[i][0], 'price': points[i][1]})

    return pivot_highs


def find_pivot_lows(points: list, left_bars: int, right_bars: int) -> list:
    """Mirror of find_pivot_highs for local lows. Returns [{idx, time, price}, ...]"""
    pivot_lows = []
    for i in range(1, len(points) - 1):
        curr = points[i][1]
        is_pivot = True

        check_before = min(left_bars, i)
        for j in range(1, check_before + 1):
            if points[i - j][1] <= curr:
                is_pivot = False
                break

        if is_pivot:
            check_after = min(right_bars, len(points) - 1 - i)
            for j in range(1, check_after + 1):
                if points[i + j][1] <= curr:
                    is_pivot = False
                    break

        if is_pivot:
            pivot_lows.append({'idx': i, 'time': points[i][0], 'price': points[i][1]})

    return pivot_lows
