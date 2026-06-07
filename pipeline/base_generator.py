"""
pipeline/base_generator.py — Abstract base class for all cache generators.

Subclasses implement generate() which returns a dict.
Base class handles JSON output and run_log writes.
"""

import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path

from pipeline.db_manager import DBManager

CACHE_DIR = Path("data/cache")


class BaseGenerator(ABC):
    def __init__(self, db: DBManager | None = None, cache_dir: Path = CACHE_DIR):
        self.db = db or DBManager()
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    @abstractmethod
    def generate(self) -> None:
        """
        Run generation logic. Subclass calls self.write_cache() for each output file.
        """

    def write_cache(self, filename: str, data: dict) -> Path:
        path = self.cache_dir / filename
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        return path

    def _now_utc(self) -> str:
        return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

    def run(self) -> None:
        run_id = self.db.start_run(self.__class__.__name__)
        try:
            self.generate()
            self.db.finish_run(run_id, status='success')
        except Exception as e:
            self.db.finish_run(run_id, status='error', error=str(e))
            raise
