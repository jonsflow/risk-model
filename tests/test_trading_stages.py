"""
tests/test_trading_stages.py — the trading generator's stages, as they land in real life.

Replays the latest session in risk_model.db into one day file, the way the
day's runs build it: every earlier session is complete, and the latest one is
in progress. Each run appends the latest stage whose window has ended. After
every run the expected sections exist, the sections written earlier are
unchanged byte for byte, and each section equals what a fresh backfill writes.

    python3 -m unittest tests.test_trading_stages

Needs a local risk_model.db with 5-minute bars (run `pipeline.run fetch`).
Writes only to a temporary directory.
"""

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pipeline.db_manager import DBManager
from pipeline.generators.trading_generator import _generate_trading_signals
from pipeline.market_time import bar_session_date

ET = ZoneInfo('America/New_York')
STAGES = ('premarket', 'open', 'opening_range', 'recap')

# Run time → stages that must exist by then (window ends 09:00 / 09:35 / 10:00 /
# the close). 1700 is after the close: the session's daily bar is complete.
RUNS = {
    900:  {'premarket'},
    940:  {'premarket', 'open'},
    1300: {'premarket', 'open', 'opening_range'},
    1700: set(STAGES),
}


class LatestSessionAt(DBManager):
    """The database as a run at `hhmm` on the latest session would see it:
    that session's daily bar is absent before the open, partial until the
    close and as stored after it, and no intraday bar ends after the run time."""

    def __init__(self, session, hhmm):
        super().__init__()
        h, m = divmod(hhmm, 100)
        self.session = session.isoformat()
        self.cut  = datetime(session.year, session.month, session.day, h, m, tzinfo=ET).timestamp()
        self.open = datetime(session.year, session.month, session.day, 9, 30, tzinfo=ET).timestamp()
        self.close = datetime(session.year, session.month, session.day, 16, 0, tzinfo=ET).timestamp()

    def load_daily_ohlcv(self, symbol, complete_only=False):
        out = []
        for ts, bar in super().load_daily_ohlcv(symbol, complete_only):
            if bar['session_date'] == self.session and self.cut < self.close:
                if self.cut < self.open:
                    continue
                bar = dict(bar, is_complete=0)
            out.append((ts, bar))
        return out

    def load_hourly_ohlcv(self, symbol):
        return [p for p in super().load_hourly_ohlcv(symbol) if p[0] < self.cut]

    def load_5m_ohlcv(self, symbol):
        return [p for p in super().load_5m_ohlcv(symbol) if p[0] + 300 <= self.cut]


def _read(out_dir, session):
    return json.loads((out_dir / f"trading_signals_{session.isoformat()}.json").read_text())


def _run(db, session, out_dir, stage_name=None):
    """One generator run: appends one stage to the day file in out_dir."""
    out_dir.mkdir(parents=True, exist_ok=True)
    _generate_trading_signals(db, out_dir, session, stage_name)
    return _read(out_dir, session)


def _backfill(db, session, out_dir):
    """What scripts/backfill_trading_history.py writes: every stage, in order."""
    for stage in STAGES:
        _run(db, session, out_dir, stage)
    return _read(out_dir, session)


def _bytes(section):
    return json.dumps(section, sort_keys=True)


class TradingStagesTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        db = DBManager()
        bars = db.load_5m_ohlcv('SPY')
        if not bars:
            raise unittest.SkipTest('risk_model.db has no SPY 5-minute bars')
        sessions = sorted({bar_session_date(ts) for ts, _ in bars})
        cls.latest, cls.previous = sessions[-1], sessions[-2]
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_previous_session_backfills_every_stage(self):
        doc = _backfill(DBManager(), self.previous, self.out / 'previous')
        for stage in STAGES:
            self.assertNotEqual(doc[stage].get('status'), 'not_available',
                                f"{self.previous} {stage} is not available")

    def test_latest_session_through_the_day(self):
        # The last run sees the whole session, as a backfill does. If the
        # latest session hasn't closed, the 1700 run can't append the recap.
        backfill = _backfill(LatestSessionAt(self.latest, 1700), self.latest, self.out / 'backfill')
        live_dir = self.out / 'live'
        written = {}
        for hhmm, expected in RUNS.items():
            doc = _run(LatestSessionAt(self.latest, hhmm), self.latest, live_dir)
            for stage in STAGES:
                with self.subTest(run=hhmm, stage=stage):
                    if stage not in expected:
                        self.assertEqual(doc[stage].get('status'), 'not_available',
                                         f"{stage} exists at {hhmm}")
                        continue
                    self.assertNotEqual(doc[stage].get('status'), 'not_available',
                                        f"{stage} missing at {hhmm}")
                    if stage in written:
                        self.assertEqual(_bytes(doc[stage]), written[stage],
                                         f"{stage} changed at {hhmm}")
                    written[stage] = _bytes(doc[stage])
                    self.assertEqual(doc[stage], backfill[stage],
                                     f"{stage} at {hhmm} differs from the backfill")

    def test_stage_is_written_once(self):
        out_dir = self.out / 'once'
        db = LatestSessionAt(self.latest, 900)
        first = _run(db, self.latest, out_dir, 'premarket')
        again = _run(db, self.latest, out_dir, 'premarket')
        self.assertEqual(_bytes(first['premarket']), _bytes(again['premarket']))


if __name__ == '__main__':
    unittest.main()
