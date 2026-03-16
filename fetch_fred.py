"""
fetch_fred.py — Fetch FRED economic time series to CSV.

Series are declared in fred_config.json. Each series is saved to:
  data/fred/{SERIES_ID}.csv

CSV format:
  Date,Value
  2024-01-02,3.45
  ...

API key is read from the FRED_API_KEY environment variable.
For local development, set it in your shell:
  export FRED_API_KEY=your_key_here

For GitHub Actions, store it as a repository secret named FRED_API_KEY.
"""

import os
import json
import pathlib
from dotenv import load_dotenv
from fredapi import Fred

load_dotenv()


CONFIG_PATH = pathlib.Path("fred_config.json")
OUTPUT_DIR  = pathlib.Path("data/fred")


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def fetch_series(fred, series_id):
    """Fetch full history for a FRED series, dropping NaN rows."""
    s = fred.get_series(series_id)
    s = s.dropna()
    return s


def save_csv(series, series_id):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{series_id}.csv"
    with open(path, "w") as f:
        f.write("Date,Value\n")
        for date, value in series.items():
            f.write(f"{date.date()},{value}\n")
    print(f"  Saved {len(series)} rows → {path}")


def get_all_series(config):
    """Flatten categories structure into a list of series dicts."""
    if 'categories' in config:
        seen, series = set(), []
        for cat in config['categories']:
            for s in cat['series']:
                if s['id'] not in seen:
                    seen.add(s['id'])
                    series.append(s)
        return series
    return config.get('series', [])


def main():
    api_key = os.environ.get("FRED_API_KEY")
    if not api_key:
        raise EnvironmentError("FRED_API_KEY environment variable not set.")

    fred   = Fred(api_key=api_key)
    config = load_config()

    for entry in get_all_series(config):
        series_id = entry["id"]
        name      = entry["name"]
        print(f"Fetching {series_id} ({name})...")
        try:
            series = fetch_series(fred, series_id)
            save_csv(series, series_id)
        except Exception as e:
            print(f"  WARNING: failed to fetch {series_id}: {e}")


if __name__ == "__main__":
    main()
