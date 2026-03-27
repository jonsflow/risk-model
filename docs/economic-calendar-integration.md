# Economic Calendar Integration Guide — Finnhub API

Documentation for integrating Finnhub's economic calendar API to automatically fetch and flag major economic events for the trading rules framework.

---

## Overview

**Purpose**: Automatically populate the "Economic Calendar" input for the Day Quality Gate (Step 1 of trading-rules.md).

**Current state**: No economic calendar integration; events must be manually flagged.

**Proposed solution**: Fetch upcoming economic events from Finnhub API once per day, cache them, and use in day quality grading logic.

**Advantage over hardcoding**: Automatically catches schedule changes (shutdowns, rescheduled releases, emergency meetings).

---

## Why Finnhub?

| Criteria | Finnhub | Hardcoded | FRED |
|---|---|---|---|
| **Cost** | Free (50 calls/min) | Free | N/A |
| **Setup time** | 10 min | 5 min | N/A |
| **Catches schedule changes** | ✅ Yes | ❌ No | N/A |
| **Requires API key** | ✅ Yes | ❌ No | N/A |
| **Documentation** | ✅ Good | N/A | N/A |
| **Update frequency** | Real-time (official sources) | Annual manual | N/A |

---

## Architecture

### Data Flow

```
Finnhub API
    ↓
fetch_economic_calendar.py (new)
    ↓
data/economic_events.json (cache file)
    ↓
generate_cache.py (imports events)
    ↓
Day Quality Logic (checks for major events)
    ↓
Rendered in trading-rules output
```

### Files Involved

| File | Purpose | Action |
|---|---|---|
| `fetch_economic_calendar.py` | Fetch events from Finnhub | **NEW** |
| `data/economic_events.json` | Cached event list | **NEW** |
| `.env` | Store `FINNHUB_API_KEY` | **UPDATE** |
| `generate_cache.py` | Day quality grading logic | **UPDATE** |
| `.github/workflows/update-data.yml` | GitHub Actions workflow | **UPDATE** |

---

## Setup Steps

### Step 1 — Get Finnhub API Key

1. Go to [finnhub.io](https://finnhub.io)
2. Sign up (free, no credit card)
3. Copy API key from dashboard
4. Add to `.env`:
   ```
   FINNHUB_API_KEY=your_key_here
   ```

### Step 2 — Create `fetch_economic_calendar.py`

This script fetches upcoming economic events from Finnhub and caches them locally.

```python
#!/usr/bin/env python3
"""
Fetch economic calendar from Finnhub API.
Caches major economic events (FOMC, CPI, NFP, etc.) for use in day quality grading.

Updates data/economic_events.json with:
- Event name (FOMC, CPI, Non-Farm Payroll, etc.)
- Scheduled date/time
- Country
- Impact level (high, medium, low)
"""

import requests
import json
from pathlib import Path
from datetime import datetime, timedelta
import os
from dotenv import load_dotenv

def get_api_key():
    """Load Finnhub API key from .env"""
    load_dotenv()
    api_key = os.getenv('FINNHUB_API_KEY')
    if not api_key:
        raise ValueError("FINNHUB_API_KEY not found in .env")
    return api_key

def fetch_calendar(api_key, from_date=None, to_date=None):
    """
    Fetch economic calendar from Finnhub API.

    Args:
        api_key: Finnhub API key
        from_date: Start date (YYYY-MM-DD), default 30 days ago
        to_date: End date (YYYY-MM-DD), default 90 days from now

    Returns:
        List of economic events (filtered to US only, high/medium impact)
    """

    if not from_date:
        from_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    if not to_date:
        to_date = (datetime.now() + timedelta(days=90)).strftime('%Y-%m-%d')

    url = 'https://finnhub.io/api/v1/calendar/economic'
    params = {
        'token': api_key,
        'from': from_date,
        'to': to_date,
        'country': 'US'  # Focus on US events
    }

    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()

        if 'economicCalendar' not in data:
            print("WARNING: Unexpected response format from Finnhub")
            return []

        events = data['economicCalendar']
        return events

    except requests.exceptions.RequestException as e:
        print(f"ERROR: Failed to fetch from Finnhub: {e}", file=__import__('sys').stderr)
        return []

def filter_major_events(events):
    """
    Filter to major events only.

    Major events = FOMC, CPI, Non-Farm Payroll, Unemployment, Fed Rate Decision
    """

    MAJOR_EVENTS = {
        'FOMC',
        'Federal Funds Rate',
        'CPI',
        'Consumer Price Index',
        'Non-Farm Payroll',
        'NFP',
        'Unemployment Rate',
        'Initial Jobless Claims',
        'Fed',
        'Interest Rate',
        'NFIB Small Business Optimism',
        'ISM Manufacturing PMI',
        'ISM Services PMI'
    }

    filtered = []
    for event in events:
        event_name = event.get('event', '')
        impact = event.get('impact', 'low').lower()

        # Include if: major event name OR high impact
        if any(major in event_name for major in MAJOR_EVENTS) or impact == 'high':
            filtered.append(event)

    return filtered

def transform_events(events):
    """
    Transform Finnhub response to our internal format.

    Output schema:
    {
        "date": "2026-03-11",
        "time": "13:30",  # in ET
        "event": "CPI",
        "country": "US",
        "impact": "high",
        "forecast": "3.2%",
        "previous": "3.1%",
        "actual": null  # null until released
    }
    """

    transformed = []
    for event in events:
        transformed.append({
            'date': event.get('date', ''),
            'time': event.get('time', ''),
            'event': event.get('event', ''),
            'country': event.get('country', ''),
            'impact': event.get('impact', 'medium'),
            'forecast': event.get('forecast', ''),
            'previous': event.get('previous', ''),
            'actual': event.get('actual', None)
        })

    return transformed

def save_cache(events, output_path='data/economic_events.json'):
    """Save events to cache file"""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cache = {
        'last_updated': datetime.now().isoformat(),
        'events': events,
        'count': len(events)
    }

    with output_path.open('w') as f:
        json.dump(cache, f, indent=2)

    print(f"Saved {len(events)} major events to {output_path}")

def main():
    """Main entry point"""
    try:
        api_key = get_api_key()
        print("Fetching economic calendar from Finnhub...")

        events = fetch_calendar(api_key)
        print(f"Received {len(events)} total events")

        major_events = filter_major_events(events)
        print(f"Filtered to {len(major_events)} major events")

        transformed = transform_events(major_events)
        save_cache(transformed)

    except Exception as e:
        print(f"ERROR: {e}", file=__import__('sys').stderr)
        import sys
        sys.exit(1)

if __name__ == '__main__':
    main()
```

### Step 3 — Update `.env`

Add Finnhub API key to `.env` (already has `FRED_API_KEY`):

```bash
FRED_API_KEY=your_fred_key
FINNHUB_API_KEY=your_finnhub_key
```

### Step 4 — Update `generate_cache.py`

In the day quality grading function, load economic events and flag high-impact days:

```python
def load_economic_events():
    """Load cached economic events"""
    events_path = Path('data/economic_events.json')
    if not events_path.exists():
        return []

    with events_path.open('r') as f:
        cache = json.load(f)
        return cache.get('events', [])

def is_major_event_day(date, events):
    """
    Check if date has major economic event scheduled.

    Returns True if:
    - FOMC meeting
    - High-impact CPI, NFP, Fed rate decision
    """

    event_date = date.strftime('%Y-%m-%d')

    for event in events:
        if event.get('date') == event_date:
            impact = event.get('impact', 'medium').lower()
            if impact == 'high':
                return True

    return False

def grade_day_quality(date, atr_data, volume_data, events):
    """
    Grade trading day quality (A+/A/B/C/F).

    Updated to use economic calendar.
    """

    # ... existing checks ...

    # NEW: Check for major economic events
    if is_major_event_day(date, events):
        return 'F'  # Auto-grade F

    # ... rest of grading logic ...
```

### Step 5 — Update GitHub Actions Workflow

In `.github/workflows/update-data.yml`, add economic calendar fetch:

```yaml
- name: Fetch economic calendar
  run: python fetch_economic_calendar.py
  env:
    FINNHUB_API_KEY: ${{ secrets.FINNHUB_API_KEY }}

- name: Generate cache (with economic events)
  run: python3 generate_cache.py
  env:
    FRED_API_KEY: ${{ secrets.FRED_API_KEY }}
```

### Step 6 — Store API Key in GitHub Secrets

1. Go to repo Settings → Secrets and Variables → Actions
2. Add `FINNHUB_API_KEY` secret with your API key
3. Workflow can now access it as `${{ secrets.FINNHUB_API_KEY }}`

---

## Data Structure

### `data/economic_events.json` (Cache File)

```json
{
  "last_updated": "2026-03-25T14:30:00.000000",
  "count": 45,
  "events": [
    {
      "date": "2026-03-27",
      "time": "13:30",
      "event": "Non-Farm Payroll",
      "country": "US",
      "impact": "high",
      "forecast": "200K",
      "previous": "175K",
      "actual": null
    },
    {
      "date": "2026-04-01",
      "time": "08:30",
      "event": "CPI",
      "country": "US",
      "impact": "high",
      "forecast": "3.2%",
      "previous": "3.1%",
      "actual": null
    },
    {
      "date": "2026-05-19",
      "time": "18:00",
      "event": "FOMC",
      "country": "US",
      "impact": "high",
      "forecast": null,
      "previous": null,
      "actual": null
    }
  ]
}
```

---

## Integration Points

### In `trading-rules.md` (Day Quality Step 1)

```markdown
### Economic Calendar Check (Auto-Grade F)

**Implementation**:
1. Load `data/economic_events.json` at start of day
2. Check today's date against event dates
3. If date matches an event with impact="high" → auto-grade F
4. Stop analysis for that day

**Events that trigger F-grade**:
- FOMC meeting
- CPI release (high impact)
- Non-Farm Payroll release
- Unemployment Rate release
- Fed rate decision
- Any event with impact="high"
```

### In `generate_cache.py` (New Logic)

```python
def main():
    """Generate all cache files with economic events"""

    # Load economic events
    events = load_economic_events()

    # For each symbol, for each day:
    for date in date_range:
        # Check if major event day
        if is_major_event_day(date, events):
            day_grade = 'F'  # No trades
            continue

        # Otherwise grade normally
        day_grade = calculate_day_quality(date)

        # Add to output
        cache_output['day_grade'] = day_grade
        cache_output['events'] = [e for e in events if e['date'] == date.strftime('%Y-%m-%d')]
```

---

## Fallback Strategy

If Finnhub API fails or is unavailable:

1. **Check if cache file exists** (`data/economic_events.json`)
   - Use cached events from last successful fetch
   - System gracefully degrades

2. **If no cache**:
   - Fall back to hardcoded major dates (FOMC schedule)
   - User manually inputs major news days
   - Logs warning that calendar is stale

```python
def load_economic_events():
    """Load economic events with fallback"""
    events_path = Path('data/economic_events.json')

    if events_path.exists():
        with events_path.open('r') as f:
            cache = json.load(f)
            last_updated = cache.get('last_updated')
            print(f"Loaded events from cache (updated {last_updated})")
            return cache.get('events', [])

    # Fallback: hardcoded major dates
    print("WARNING: Using hardcoded economic calendar (cache not found)")
    return get_hardcoded_major_dates()
```

---

## Testing

### Manual Test

```bash
# Test API connection + data fetching
python fetch_economic_calendar.py

# Verify output
cat data/economic_events.json | jq '.events | length'
```

### Automated Test

```python
def test_fetch_calendar():
    """Unit test for calendar fetch"""
    api_key = os.getenv('FINNHUB_API_KEY')
    events = fetch_calendar(api_key, from_date='2026-03-01', to_date='2026-03-31')

    assert isinstance(events, list)
    assert len(events) > 0
    assert all('date' in e for e in events)

    print(f"✅ Fetch test passed ({len(events)} events)")
```

---

## Cost & Rate Limits

| Metric | Finnhub Free |
|---|---|
| Cost | $0 |
| API calls per minute | 50 |
| Daily fetch (once/day) | 1 call |
| Rate limit impact | Negligible |

**No cost or rate limit concerns for this use case.**

---

## Monitoring & Maintenance

### Daily

- `fetch_economic_calendar.py` runs once (during GitHub Actions workflow)
- Caches events for 90-day lookback
- Automatically catches rescheduled events

### Quarterly

- Check Finnhub API docs for breaking changes
- Verify major events (FOMC, CPI, NFP) are being captured
- Review event filtering logic if needed

### Annually

- Confirm Finnhub account still active
- Verify API key still valid
- Update filters if new major events emerge

---

## Advantages vs. Hardcoding

| Scenario | Hardcoded | Finnhub API |
|---|---|---|
| Normal operation | Works | Works |
| FOMC meeting rescheduled | ❌ Misses it | ✅ Catches it |
| Government shutdown delays NFP | ❌ Misses it | ✅ Catches it |
| Emergency Fed meeting | ❌ Misses it | ✅ Catches it |
| New major economic indicator added | ❌ Requires code change | ✅ Auto-included |

---

## When to Implement

**Implement if**:
- You want automatic schedule change detection
- You don't want to manually maintain event dates
- You're comfortable with external API dependency

**Skip if**:
- 1–2 missed events per year is acceptable
- You want zero external dependencies
- You prefer simple hardcoded dates

---

## References

- [Finnhub Economic Calendar API](https://finnhub.io/docs/api/economic-calendar)
- [Finnhub Sign Up](https://finnhub.io/)
- [Federal Reserve FOMC Calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)

