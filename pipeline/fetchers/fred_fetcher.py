"""
pipeline/fetchers/fred_fetcher.py — Fetch FRED series into SQLite + JSON bundle.

Replaces fetch_fred.py.
Reads fred_config.json for series list.
Requires FRED_API_KEY env var (loaded from .env via python-dotenv).
"""

import datetime
import json
import os
import pathlib
from pathlib import Path

from dotenv import load_dotenv
from fredapi import Fred

from pipeline.base_fetcher import BaseFetcher

load_dotenv()

CONFIG_PATH = pathlib.Path("fred_config.json")
FRED_OUT_DIR = pathlib.Path("data/fred")
BUNDLE_PATH = FRED_OUT_DIR / "fred_cache.json"


def _get_all_series(config: dict) -> list[dict]:
    if 'categories' in config:
        seen, series = set(), []
        for cat in config['categories']:
            for s in cat['series']:
                if s['id'] not in seen:
                    seen.add(s['id'])
                    series.append(s)
        return series
    return config.get('series', [])


class FREDFetcher(BaseFetcher):
    def fetch(self) -> None:
        api_key = os.environ.get("FRED_API_KEY")
        if not api_key:
            raise EnvironmentError("FRED_API_KEY environment variable not set.")

        fred = Fred(api_key=api_key)
        config = json.loads(CONFIG_PATH.read_text())
        FRED_OUT_DIR.mkdir(parents=True, exist_ok=True)

        all_fetched: dict = {}

        for entry in _get_all_series(config):
            series_id = entry["id"]
            name = entry["name"]
            print(f"Fetching {series_id} ({name})...")
            try:
                s = fred.get_series(series_id).dropna()
                rows = [(str(d.date()), float(v)) for d, v in s.items()]
                self.db.upsert_fred(series_id, rows)
                # Also write individual CSV (kept for reference / backwards compat)
                _save_csv(series_id, rows)
                all_fetched[series_id] = rows
            except Exception as e:
                print(f"  WARNING: failed to fetch {series_id}: {e}")

        _write_bundle(all_fetched)


def _save_csv(series_id: str, rows: list) -> None:
    path = FRED_OUT_DIR / f"{series_id}.csv"
    with open(path, 'w') as f:
        f.write("Date,Value\n")
        for date, value in rows:
            f.write(f"{date},{value}\n")
    print(f"  Saved {len(rows)} rows → {path}")


def _write_bundle(all_series: dict) -> None:
    bundle = {
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "series": {sid: rows for sid, rows in all_series.items()},
    }
    with open(BUNDLE_PATH, 'w') as f:
        json.dump(bundle, f, separators=(",", ":"))
    size_kb = BUNDLE_PATH.stat().st_size / 1024
    print(f"  Bundle → {BUNDLE_PATH}  ({len(all_series)} series, {size_kb:.0f} KB)")


if __name__ == '__main__':
    FREDFetcher().run()
