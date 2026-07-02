"""
pipeline/db_manager.py — SQLite schema, connection, and seed utilities.

The DB is the internal store for the v2 pipeline. The browser never touches it;
JSON cache files remain the browser-facing interface (unchanged from v1).

Schema:
  prices_daily  (symbol, timestamp, open, high, low, close, volume)
  prices_hourly (symbol, timestamp, open, high, low, close, volume)
  prices_5m     (symbol, timestamp, open, high, low, close, volume)
  fred_data     (series_id, date, value)
  run_log       (id, pipeline, started_at, finished_at, status, error)
"""

import csv
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


DB_PATH  = Path("risk_model.db")
DATA_DIR = Path("data")


class DBManager:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = Path(db_path)

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def create_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS prices_daily (
                    symbol    TEXT    NOT NULL,
                    timestamp INTEGER NOT NULL,
                    open      REAL,
                    high      REAL,
                    low       REAL,
                    close     REAL,
                    volume    INTEGER,
                    PRIMARY KEY (symbol, timestamp)
                );
                CREATE INDEX IF NOT EXISTS idx_prices_daily_symbol
                    ON prices_daily (symbol, timestamp);

                CREATE TABLE IF NOT EXISTS prices_hourly (
                    symbol    TEXT    NOT NULL,
                    timestamp INTEGER NOT NULL,
                    open      REAL,
                    high      REAL,
                    low       REAL,
                    close     REAL,
                    volume    INTEGER,
                    PRIMARY KEY (symbol, timestamp)
                );
                CREATE INDEX IF NOT EXISTS idx_prices_hourly_symbol
                    ON prices_hourly (symbol, timestamp);

                CREATE TABLE IF NOT EXISTS prices_5m (
                    symbol    TEXT    NOT NULL,
                    timestamp INTEGER NOT NULL,
                    open      REAL,
                    high      REAL,
                    low       REAL,
                    close     REAL,
                    volume    INTEGER,
                    PRIMARY KEY (symbol, timestamp)
                );
                CREATE INDEX IF NOT EXISTS idx_prices_5m_symbol
                    ON prices_5m (symbol, timestamp);

                CREATE TABLE IF NOT EXISTS fred_data (
                    series_id TEXT NOT NULL,
                    date      TEXT NOT NULL,
                    value     REAL,
                    PRIMARY KEY (series_id, date)
                );

                CREATE INDEX IF NOT EXISTS idx_fred_series
                    ON fred_data (series_id, date);

                CREATE TABLE IF NOT EXISTS run_log (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    pipeline    TEXT    NOT NULL,
                    started_at  TEXT    NOT NULL,
                    finished_at TEXT,
                    status      TEXT,
                    error       TEXT
                );
            """)
            self._migrate_legacy_prices(conn)

    def _migrate_legacy_prices(self, conn: sqlite3.Connection) -> None:
        """One-shot migration: copy rows out of the legacy `prices` table into
        prices_daily / prices_hourly, verify row counts match, then drop the
        legacy table. Idempotent — no-op once the legacy table is gone.
        """
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='prices'"
        ).fetchone()
        if row is None:
            return

        legacy_daily  = conn.execute("SELECT COUNT(*) FROM prices WHERE timeframe='daily'").fetchone()[0]
        legacy_hourly = conn.execute("SELECT COUNT(*) FROM prices WHERE timeframe='hourly'").fetchone()[0]

        conn.execute("""
            INSERT OR IGNORE INTO prices_daily (symbol, timestamp, open, high, low, close, volume)
            SELECT symbol, timestamp, open, high, low, close, volume
            FROM prices WHERE timeframe = 'daily'
        """)
        conn.execute("""
            INSERT OR IGNORE INTO prices_hourly (symbol, timestamp, open, high, low, close, volume)
            SELECT symbol, timestamp, open, high, low, close, volume
            FROM prices WHERE timeframe = 'hourly'
        """)

        new_daily  = conn.execute("SELECT COUNT(*) FROM prices_daily").fetchone()[0]
        new_hourly = conn.execute("SELECT COUNT(*) FROM prices_hourly").fetchone()[0]

        if new_daily < legacy_daily or new_hourly < legacy_hourly:
            raise RuntimeError(
                f"Migration count mismatch — refusing to drop prices. "
                f"legacy(daily={legacy_daily}, hourly={legacy_hourly}) "
                f"vs new(daily={new_daily}, hourly={new_hourly})"
            )

        conn.execute("DROP TABLE prices")
        print(f"Migrated legacy prices → prices_daily ({legacy_daily}), prices_hourly ({legacy_hourly}); dropped legacy table.")

    # ------------------------------------------------------------------
    # Price write
    # ------------------------------------------------------------------

    def upsert_daily(self, rows: list) -> int:
        """
        Insert or replace daily bars.
        rows: list of (symbol, timestamp, open, high, low, close, volume)
        Returns count inserted.
        """
        sql = """
            INSERT OR REPLACE INTO prices_daily
                (symbol, timestamp, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        with self.connect() as conn:
            conn.executemany(sql, rows)
        return len(rows)

    def upsert_hourly(self, rows: list) -> int:
        """
        Insert or replace hourly bars.
        rows: list of (symbol, timestamp, open, high, low, close, volume)
        Returns count inserted.
        """
        sql = """
            INSERT OR REPLACE INTO prices_hourly
                (symbol, timestamp, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        with self.connect() as conn:
            conn.executemany(sql, rows)
        return len(rows)

    def upsert_5m(self, rows: list) -> int:
        """
        Insert or replace 5-minute bars.
        rows: list of (symbol, timestamp, open, high, low, close, volume)
        Returns count inserted.
        """
        sql = """
            INSERT OR REPLACE INTO prices_5m
                (symbol, timestamp, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        with self.connect() as conn:
            conn.executemany(sql, rows)
        return len(rows)

    # ------------------------------------------------------------------
    # Price read
    # ------------------------------------------------------------------

    def load_daily_close(self, symbol: str) -> list:
        """Return [(timestamp_secs, close), ...] for daily bars, sorted asc."""
        sql = """
            SELECT timestamp, close FROM prices_daily
            WHERE symbol = ? AND close IS NOT NULL
            ORDER BY timestamp
        """
        with self.connect() as conn:
            return list(conn.execute(sql, (symbol.upper(),)))

    def load_hourly_close(self, symbol: str) -> list:
        """Return [(timestamp_secs, close), ...] for hourly bars, sorted asc."""
        sql = """
            SELECT timestamp, close FROM prices_hourly
            WHERE symbol = ? AND close IS NOT NULL
            ORDER BY timestamp
        """
        with self.connect() as conn:
            return list(conn.execute(sql, (symbol.upper(),)))

    def load_daily_ohlcv(self, symbol: str) -> list:
        """
        Return [(timestamp, {open,high,low,close,volume}), ...] for daily bars.
        """
        sql = """
            SELECT timestamp, open, high, low, close, volume FROM prices_daily
            WHERE symbol = ?
            ORDER BY timestamp
        """
        with self.connect() as conn:
            rows = conn.execute(sql, (symbol.upper(),)).fetchall()
        return [
            (r[0], {'open': r[1] or 0.0, 'high': r[2] or 0.0,
                    'low': r[3] or 0.0, 'close': r[4], 'volume': r[5] or 0})
            for r in rows if r[4] is not None
        ]

    def load_hourly_ohlcv(self, symbol: str) -> list:
        """
        Return [(timestamp, {open,high,low,close,volume}), ...] for hourly bars.
        """
        sql = """
            SELECT timestamp, open, high, low, close, volume FROM prices_hourly
            WHERE symbol = ?
            ORDER BY timestamp
        """
        with self.connect() as conn:
            rows = conn.execute(sql, (symbol.upper(),)).fetchall()
        return [
            (r[0], {'open': r[1] or 0.0, 'high': r[2] or 0.0,
                    'low': r[3] or 0.0, 'close': r[4], 'volume': r[5] or 0})
            for r in rows if r[4] is not None
        ]

    def last_daily_timestamp(self, symbol: str) -> int | None:
        """Return latest daily timestamp for symbol, or None."""
        sql = "SELECT MAX(timestamp) FROM prices_daily WHERE symbol=?"
        with self.connect() as conn:
            row = conn.execute(sql, (symbol.upper(),)).fetchone()
        return row[0] if row else None

    def last_hourly_timestamp(self, symbol: str) -> int | None:
        """Return latest hourly timestamp for symbol, or None."""
        sql = "SELECT MAX(timestamp) FROM prices_hourly WHERE symbol=?"
        with self.connect() as conn:
            row = conn.execute(sql, (symbol.upper(),)).fetchone()
        return row[0] if row else None

    def load_5m_ohlcv(self, symbol: str) -> list:
        """
        Return [(timestamp, {open,high,low,close,volume}), ...] for 5-minute bars.
        """
        sql = """
            SELECT timestamp, open, high, low, close, volume FROM prices_5m
            WHERE symbol = ?
            ORDER BY timestamp
        """
        with self.connect() as conn:
            rows = conn.execute(sql, (symbol.upper(),)).fetchall()
        return [
            (r[0], {'open': r[1] or 0.0, 'high': r[2] or 0.0,
                    'low': r[3] or 0.0, 'close': r[4], 'volume': r[5] or 0})
            for r in rows if r[4] is not None
        ]

    def last_5m_timestamp(self, symbol: str) -> int | None:
        """Return latest 5-minute timestamp for symbol, or None."""
        sql = "SELECT MAX(timestamp) FROM prices_5m WHERE symbol=?"
        with self.connect() as conn:
            row = conn.execute(sql, (symbol.upper(),)).fetchone()
        return row[0] if row else None

    # ------------------------------------------------------------------
    # FRED write/read
    # ------------------------------------------------------------------

    def upsert_fred(self, series_id: str, rows: list) -> int:
        """rows: list of (date_str 'YYYY-MM-DD', value_float)"""
        sql = "INSERT OR REPLACE INTO fred_data (series_id, date, value) VALUES (?, ?, ?)"
        data = [(series_id, d, v) for d, v in rows]
        with self.connect() as conn:
            conn.executemany(sql, data)
        return len(data)

    def load_fred_series(self, series_id: str) -> list:
        """Return [(date_str, value), ...] sorted by date asc."""
        sql = "SELECT date, value FROM fred_data WHERE series_id=? ORDER BY date"
        with self.connect() as conn:
            return list(conn.execute(sql, (series_id,)))

    def load_all_fred_series(self) -> dict:
        """Return {series_id: [(date_str, value), ...]} for all series."""
        sql = "SELECT series_id, date, value FROM fred_data ORDER BY series_id, date"
        result: dict[str, list] = {}
        with self.connect() as conn:
            for sid, date, val in conn.execute(sql):
                result.setdefault(sid, []).append((date, val))
        return result

    # ------------------------------------------------------------------
    # Run log
    # ------------------------------------------------------------------

    def start_run(self, pipeline: str) -> int:
        """Insert a running log entry, return its id."""
        now = datetime.now(timezone.utc).isoformat()
        sql = "INSERT INTO run_log (pipeline, started_at, status) VALUES (?, ?, 'running')"
        with self.connect() as conn:
            cur = conn.execute(sql, (pipeline, now))
            return cur.lastrowid

    def finish_run(self, run_id: int, status: str = 'success', error: str = None) -> None:
        now = datetime.now(timezone.utc).isoformat()
        sql = "UPDATE run_log SET finished_at=?, status=?, error=? WHERE id=?"
        with self.connect() as conn:
            conn.execute(sql, (now, status, error, run_id))

    # ------------------------------------------------------------------
    # Seed from existing v1 CSVs
    # ------------------------------------------------------------------

    def seed_from_csvs(self, data_dir: Path = DATA_DIR, verbose: bool = True) -> None:
        """
        One-time migration: import all existing v1 CSV files into SQLite.
        Safe to re-run — uses INSERT OR REPLACE.
        """
        self.create_schema()
        data_dir = Path(data_dir)
        total_daily = total_hourly = total_fred = 0

        # --- Yahoo Finance daily CSVs: data/{symbol}.csv ---
        for csv_path in sorted(data_dir.glob("*.csv")):
            name = csv_path.stem
            if name.endswith("_hourly"):
                continue  # handled separately
            symbol = name.upper()
            rows = []
            try:
                with open(csv_path, newline='', encoding='utf-8') as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        date = row.get('Date', '').strip()
                        close = row.get('Close', '').strip()
                        if not date or not close:
                            continue
                        try:
                            ts = int(datetime.strptime(date, '%Y-%m-%d')
                                     .replace(tzinfo=timezone.utc).timestamp())
                            rows.append((
                                symbol, ts,
                                _f(row.get('Open')),
                                _f(row.get('High')),
                                _f(row.get('Low')),
                                float(close),
                                _i(row.get('Volume')),
                            ))
                        except (ValueError, KeyError):
                            continue
                if rows:
                    self.upsert_daily(rows)
                    total_daily += len(rows)
                    if verbose:
                        print(f"  daily  {symbol}: {len(rows)} bars")
            except Exception as e:
                print(f"  WARNING: could not seed {csv_path}: {e}")

        # --- Yahoo Finance hourly CSVs: data/{symbol}_hourly.csv ---
        for csv_path in sorted(data_dir.glob("*_hourly.csv")):
            symbol = csv_path.stem.replace('_hourly', '').upper()
            rows = []
            try:
                with open(csv_path, newline='', encoding='utf-8') as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        date_str = row.get('Date', '').strip()
                        time_str = row.get('Time', '').strip()
                        close = row.get('Close', '').strip()
                        if not date_str or not time_str or not close:
                            continue
                        try:
                            ts = int(datetime.strptime(f"{date_str} {time_str}",
                                                       '%Y-%m-%d %H:%M:%S')
                                     .replace(tzinfo=timezone.utc).timestamp())
                            rows.append((
                                symbol, ts,
                                _f(row.get('Open')),
                                _f(row.get('High')),
                                _f(row.get('Low')),
                                float(close),
                                _i(row.get('Volume')),
                            ))
                        except (ValueError, KeyError):
                            continue
                if rows:
                    self.upsert_hourly(rows)
                    total_hourly += len(rows)
                    if verbose:
                        print(f"  hourly {symbol}: {len(rows)} bars")
            except Exception as e:
                print(f"  WARNING: could not seed {csv_path}: {e}")

        # --- FRED CSVs: data/fred/{SERIES_ID}.csv ---
        fred_dir = data_dir / 'fred'
        if fred_dir.exists():
            for csv_path in sorted(fred_dir.glob("*.csv")):
                series_id = csv_path.stem
                rows = []
                try:
                    with open(csv_path, newline='', encoding='utf-8') as f:
                        reader = csv.DictReader(f)
                        for row in reader:
                            date = row.get('Date', '').strip()
                            val  = row.get('Value', '').strip()
                            if not date or not val:
                                continue
                            try:
                                rows.append((date, float(val)))
                            except ValueError:
                                continue
                    if rows:
                        self.upsert_fred(series_id, rows)
                        total_fred += len(rows)
                        if verbose:
                            print(f"  fred   {series_id}: {len(rows)} rows")
                except Exception as e:
                    print(f"  WARNING: could not seed FRED {csv_path}: {e}")

        print(f"\nSeed complete: {total_daily} daily bars, {total_hourly} hourly bars, {total_fred} FRED rows")


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _f(val) -> float | None:
    if val is None:
        return None
    s = str(val).strip()
    return float(s) if s else None


def _i(val) -> int | None:
    if val is None:
        return None
    s = str(val).strip()
    try:
        return int(float(s)) if s else None
    except ValueError:
        return None


if __name__ == '__main__':
    db = DBManager()
    db.create_schema()
    print(f"Schema created at {db.db_path}")
    print("Seeding from existing CSVs...")
    db.seed_from_csvs()
