#!/usr/bin/env bash
# Fetch all data and regenerate all caches.
# Usage: ./refresh.sh

set -e

# Load FRED_API_KEY from .env if present
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

echo "==> [1/5] Fetching Yahoo Finance daily + hourly data..."
python3 fetch_data.py

echo "==> [2/5] Fetching trading hourly data (premarket)..."
python3 fetch_trading_hourly.py

echo "==> [3/5] Fetching FRED data..."
python3 fetch_fred.py

echo "==> [4/5] Generating divergence + macro cache..."
python3 generate_cache.py

echo "==> [5/5] Generating trading signals cache..."
python3 generate_trading_cache.py

echo ""
echo "Done. All data fetched and caches regenerated."
