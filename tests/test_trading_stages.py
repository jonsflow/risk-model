"""
tests/test_trading_stages.py — the trading generator's stages, as they land in real life.

Replays the latest session in risk_model.db the way the day's runs see it:
every earlier session is complete, and the latest one is still in progress.
At each run time the stages whose window has ended must exist and must equal
what the post-close run produces for them; the rest must be marked
not available.

    python3 -m unittest tests.test_trading_stages

Needs a local risk_model.db with 5-minute bars (run `pipeline.run fetch`).
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

# Run time → stages that must exist by then (window ends 09:00 / 09:35 / 10:00).
RUNS = {
    900:  {'premarket'},
    940:  {'premarket', 'open'},
    1300: {'premarket', 'open', 'opening_range'},
}


class LatestSessionAt(DBManager):
    """The database as a run at `hhmm` on the latest session would see it:
    that session's daily bar is absent before the open and partial after it,
    and no intraday bar ends after the run time."""

    def __init__(self, session, hhmm):
        super().__init__()
        h, m = divmod(hhmm, 100)
        self.session = session.isoformat()
        self.cut  = datetime(session.year, session.month, session.day, h, m, tzinfo=ET).timestamp()
        self.open = datetime(session.year, session.month, session.day, 9, 30, tzinfo=ET).timestamp()

    def load_daily_ohlcv(self, symbol, complete_only=False):
        out = []
        for ts, bar in super().load_daily_ohlcv(symbol, complete_only):
            if bar['session_date'] == self.session:
                if self.cut < self.open:
                    continue
                bar = dict(bar, is_complete=0)
            out.append((ts, bar))
        return out

    def load_hourly_ohlcv(self, symbol):
        return [p for p in super().load_hourly_ohlcv(symbol) if p[0] < self.cut]

    def load_5m_ohlcv(self, symbol):
        return [p for p in super().load_5m_ohlcv(symbol) if p[0] + 300 <= self.cut]


def _generate(db, session, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    _generate_trading_signals(db, out_dir, session)
    return json.loads((out_dir / f"trading_signals_{session.isoformat()}.json").read_text())


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
        # What the post-close run writes for the latest session.
        cls.final = _generate(db, cls.latest, cls.out / 'final')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_previous_session_is_complete(self):
        doc = _generate(DBManager(), self.previous, self.out / 'previous')
        for stage in STAGES:
            self.assertNotEqual(doc[stage].get('status'), 'not_available',
                                f"{self.previous} {stage} is not available")

    def test_latest_session_through_the_day(self):
        for hhmm, expected in RUNS.items():
            doc = _generate(LatestSessionAt(self.latest, hhmm), self.latest, self.out / str(hhmm))
            for stage in STAGES:
                with self.subTest(run=hhmm, stage=stage):
                    if stage in expected:
                        self.assertEqual(doc[stage], self.final[stage],
                                         f"{stage} at {hhmm} differs from the post-close run")
                    else:
                        self.assertEqual(doc[stage].get('status'), 'not_available',
                                         f"{stage} exists at {hhmm}")

    def test_latest_session_after_close(self):
        for stage in STAGES:
            self.assertNotEqual(self.final[stage].get('status'), 'not_available',
                                f"{self.latest} {stage} is not available after the close")


if __name__ == '__main__':
    unittest.main()
