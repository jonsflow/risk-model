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
import datetime
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


def write_bundle(all_series):
    """Bundle all fetched series into a single JSON file for efficient client loading.

    Format: { "fetched_at": "ISO string", "series": { "ID": [[date, value], ...] } }
    Compact array pairs keep file size ~30% smaller than named-key objects.
    """
    bundle = {
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "series": {},
    }
    for series_id, s in all_series.items():
        bundle["series"][series_id] = [
            [str(d.date()), float(v)] for d, v in s.items()
        ]
    out_path = OUTPUT_DIR / "fred_cache.json"
    with open(out_path, "w") as f:
        json.dump(bundle, f, separators=(",", ":"))
    size_kb = out_path.stat().st_size / 1024
    print(f"  Bundle → {out_path}  ({len(all_series)} series, {size_kb:.0f} KB)")


def main():
    api_key = os.environ.get("FRED_API_KEY")
    if not api_key:
        raise EnvironmentError("FRED_API_KEY environment variable not set.")

    fred   = Fred(api_key=api_key)
    config = load_config()

    all_series = {}
    for entry in get_all_series(config):
        series_id = entry["id"]
        name      = entry["name"]
        print(f"Fetching {series_id} ({name})...")
        try:
            s = fetch_series(fred, series_id)
            save_csv(s, series_id)
            all_series[series_id] = s
        except Exception as e:
            print(f"  WARNING: failed to fetch {series_id}: {e}")

    write_bundle(all_series)


if __name__ == "__main__":
    main()
