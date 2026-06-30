"""
pipeline/generators/prices_generator.py — Per-symbol daily price cache.

Writes data/cache/prices_{symbol}.json for each symbol in config/config.json.
Used by divergence.js instead of reading raw CSVs (which are no longer updated by v2).
"""

import json
import sys
from pathlib import Path

from pipeline.base_generator import BaseGenerator


class PricesGenerator(BaseGenerator):
    def generate(self) -> None:
        config_path = Path('config/config.json')
        if not config_path.exists():
            raise FileNotFoundError("config.json not found")
        config = json.loads(config_path.read_text())

        symbols = {s['symbol'].lower() for s in config.get('symbols', [])}
        print(f"Generating price caches for {len(symbols)} symbols...", file=sys.stderr)

        for sym in sorted(symbols):
            rows = self.db.load_daily_close(sym)
            if not rows:
                print(f"  WARNING: no daily data for {sym}", file=sys.stderr)
                continue

            self.write_cache(f"prices_{sym}.json", {
                "symbol":    sym.upper(),
                "generated": self._now_utc(),
                "prices":    [[ts, close] for ts, close in rows],
            })
            print(f"  prices_{sym}.json: {len(rows)} bars", file=sys.stderr)
