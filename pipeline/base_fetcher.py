"""
pipeline/base_fetcher.py — Abstract base class for all fetchers.

Subclasses implement fetch() and write results to SQLite via DBManager.
"""

from abc import ABC, abstractmethod
from datetime import datetime, timezone

from pipeline.db_manager import DBManager


class BaseFetcher(ABC):
    def __init__(self, db: DBManager | None = None):
        self.db = db or DBManager()
        self.db.create_schema()

    @abstractmethod
    def fetch(self) -> None:
        """Fetch data and write to SQLite. Must be implemented by subclass."""

    def _now_utc(self) -> str:
        return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')

    def run(self) -> None:
        run_id = self.db.start_run(self.__class__.__name__)
        try:
            self.fetch()
            self.db.finish_run(run_id, status='success')
        except Exception as e:
            self.db.finish_run(run_id, status='error', error=str(e))
            raise
