"""
pipeline/market_time.py — the one place market wall-clock time is interpreted.

Everything stored in the DB is UTC. The only questions that genuinely require a
market timezone are "when did this session close" and "which session does this
instant belong to", and they are answered here so no generator has to.

Rule for the rest of the pipeline: never convert a stored timestamp with
ZoneInfo("America/New_York") yourself. Call into this module instead.
"""

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

MARKET_TZ = ZoneInfo("America/New_York")

# Regular-session bounds, in market local time.
RTH_OPEN  = time(9, 30)
RTH_CLOSE = time(16, 0)


def session_close_utc(session_date: date) -> datetime:
    """The instant the regular session for session_date closes, as UTC.

    This is where DST lives: 16:00 ET is 20:00 UTC under EDT and 21:00 UTC
    under EST. ZoneInfo resolves that from the date itself, so the transition
    needs no manual maintenance.

    Early closes (1:00 PM ET on the day after Thanksgiving, Christmas Eve) are
    intentionally not modelled — treating them as 16:00 only ever delays a bar
    being marked complete, which errs toward not trusting partial data.
    """
    local = datetime.combine(session_date, RTH_CLOSE, tzinfo=MARKET_TZ)
    return local.astimezone(timezone.utc)


def session_open_utc(session_date: date) -> datetime:
    """The instant the regular session for session_date opens, as UTC."""
    local = datetime.combine(session_date, RTH_OPEN, tzinfo=MARKET_TZ)
    return local.astimezone(timezone.utc)


def is_session_complete(session_date: date, collected_at: datetime) -> bool:
    """True if collected_at is at or after session_date's close.

    A bar fetched before its own close is a partial snapshot — it has an open
    and a running high/low/close, and is indistinguishable from a final bar
    unless this is recorded at ingest.
    """
    if collected_at.tzinfo is None:
        collected_at = collected_at.replace(tzinfo=timezone.utc)
    return collected_at >= session_close_utc(session_date)


def session_date_of(instant: datetime) -> date:
    """Which trading session an intraday instant belongs to.

    Market-local calendar date. Pre-market and after-hours bars belong to the
    session they surround, which is what the local date already gives.
    """
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(MARKET_TZ).date()


def market_minutes(instant: datetime) -> int:
    """Market-local time of day as HHMM, for session-window comparisons."""
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    local = instant.astimezone(MARKET_TZ)
    return local.hour * 100 + local.minute


# ------------------------------------------------------------------
# Epoch-second helpers. Stored bar timestamps are UTC epoch ints, so these
# are what generators actually call — they keep datetime construction and
# tz handling out of the analysis code entirely.
# ------------------------------------------------------------------

def bar_session_date(ts: int) -> date:
    """Trading session an intraday bar belongs to."""
    return session_date_of(datetime.fromtimestamp(ts, tz=timezone.utc))


def bar_minutes(ts: int) -> int:
    """Market-local time of day as HHMM (930 = 09:30 ET)."""
    return market_minutes(datetime.fromtimestamp(ts, tz=timezone.utc))


def bar_start(ts: int) -> datetime:
    """An intraday bar's start as an aware market-local datetime."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(MARKET_TZ)


def market_datetime(session_date: date, local_time: time) -> datetime:
    """session_date at a market-local wall time, as an aware datetime."""
    return datetime.combine(session_date, local_time, tzinfo=MARKET_TZ)


def bar_clock(ts: int) -> str:
    """Market-local time of day as 'HH:MM', for display."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(MARKET_TZ).strftime('%H:%M')


def in_session_window(ts: int, start_hhmm: int, end_hhmm: int,
                      session_date: date | None = None) -> bool:
    """Is this bar inside [start_hhmm, end_hhmm) market-local, on session_date?"""
    if session_date is not None and bar_session_date(ts) != session_date:
        return False
    return start_hhmm <= bar_minutes(ts) < end_hhmm


def parse_session_date(value) -> date:
    """Accept a date, datetime, or 'YYYY-MM-DD' string."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value)[:10], '%Y-%m-%d').date()


def previous_session_date(session_date: date) -> date:
    """Prior weekday. Holidays are not modelled — callers that need real prior
    sessions should step through stored bars rather than calendar dates."""
    d = session_date - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d
