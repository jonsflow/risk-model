"""
pipeline/generators/fomc_generator.py — FOMC / policy rates data bundle.

Reads FRED series from SQLite and writes data/fred/fred_cache.json
(same format as fetch_fred.py's write_bundle, but sourced from DB).

This generator is optional — FREDFetcher already writes the bundle during fetch.
Use this when you need to regenerate the bundle from the DB without re-fetching.
"""

import json
from datetime import datetime, timezone

from pipeline.base_generator import BaseGenerator

BUNDLE_PATH_REL = "data/fred/fred_cache.json"


class FOMCGenerator(BaseGenerator):
    """Regenerate fred_cache.json from SQLite without re-fetching from FRED API."""

    def generate(self) -> None:
        all_series = self.db.load_all_fred_series()
        bundle = {
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "series": {sid: rows for sid, rows in all_series.items()},
        }
        import pathlib
        out = pathlib.Path(BUNDLE_PATH_REL)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, 'w') as f:
            json.dump(bundle, f, separators=(",", ":"))
        size_kb = out.stat().st_size / 1024
        print(f"FRED bundle → {out}  ({len(all_series)} series, {size_kb:.0f} KB)")


if __name__ == '__main__':
    FOMCGenerator().run()
