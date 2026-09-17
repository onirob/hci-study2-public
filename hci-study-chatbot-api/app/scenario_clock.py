# app/scenario_clock.py
import os
from datetime import datetime, date, time

_TODAY_STR = os.getenv("SCENARIO_TODAY", "2025-11-05")     # YYYY-MM-DD
_TIME_STR  = os.getenv("SCENARIO_TIME",  "11:30:00")       # HH:MM:SS

def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()

def _parse_time(s: str) -> time:
    return datetime.strptime(s, "%H:%M:%S").time()

_SCENARIO_TODAY = _parse_date(_TODAY_STR)
_SCENARIO_TIME  = _parse_time(_TIME_STR)

# --- Public helpers (constant; no ticking) ---

def scenario_today_date() -> date:
    """Fixed 'today' date object."""
    return _SCENARIO_TODAY

def scenario_today_str(fmt: str = "%Y-%m-%d") -> str:
    """Fixed 'today' formatted as string."""
    return _SCENARIO_TODAY.strftime(fmt)

def scenario_time_str(fmt: str = "%H:%M:%S") -> str:
    """Fixed 'current time' (optional, if your UI prints a clock)."""
    return _SCENARIO_TIME.strftime(fmt)
