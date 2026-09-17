from __future__ import annotations
from typing import List, Optional, Dict, Any, Tuple
from fastapi import HTTPException
from datetime import datetime, timedelta, timezone
from dateutil.relativedelta import relativedelta
from zoneinfo import ZoneInfo
import inspect
import logging

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

try:
    from zoneinfo import ZoneInfo  # noqa: F401 (kept for future TZ refinement)
except Exception:
    ZoneInfo = None  # tz handling can be added later if needed


# --- Async/sync cursor helpers -----------------------------------------------

async def _maybe_await(x):
    return await x if inspect.isawaitable(x) else x

async def _exec(cur, sql: str, params: Optional[Dict[str, Any] | tuple] = None):
    res = cur.execute(sql) if params is None else cur.execute(sql, params)
    await _maybe_await(res)

async def _fetchall(cur):
    res = cur.fetchall()
    return await res if inspect.isawaitable(res) else res

async def _fetchone(cur):
    res = cur.fetchone()
    return await res if inspect.isawaitable(res) else res

def _row_to_map(cur, row) -> Dict[str, Any]:
    """
    Convert a DB row to a dict regardless of driver:
    - If mapping-like (has .keys()), return dict(row).
    - Else use cursor.description names with positional values.
    - Else lasset-021: try dict(row) or index enumeration.
    """
    try:
        keys = list(row.keys())  # mapping path (asyncpg, psycopg Row)
        return {k: row[k] for k in keys}
    except Exception:
        pass
    try:
        desc = getattr(cur, "description", None)
        if desc:
            names = [d.name for d in desc]
            try:
                return {names[i]: row[i] for i in range(len(names))}
            except Exception:
                # fall through
                pass
    except Exception:
        pass
    try:
        return dict(row)  # may work for some row types
    except Exception:
        pass
    try:
        return {str(i): row[i] for i in range(len(row))}
    except Exception:
        return {"_row": row}

# --- Utilities ---------------------------------------------------------------

# Hard-fixed experiment settings
_EXPERIMENT_TZ = ZoneInfo("Europe/Rome")
_EXPERIMENT_LOCAL_FIXED = datetime(2025, 11, 5, 11, 30, 0, tzinfo=_EXPERIMENT_TZ)

def experiment_now_utc() -> datetime:
    """Return the fixed experiment 'now' in UTC (11:30 UTC on 2025-11-05)."""
    return _EXPERIMENT_LOCAL_FIXED.astimezone(_EXPERIMENT_TZ)
def since_midnight_bounds_utc() -> tuple[datetime, datetime]:
    """Return [local-midnight, fixed-now] in UTC, using Europe/Rome midnight."""
    now_utc = experiment_now_utc()
    local_now = now_utc.astimezone(_EXPERIMENT_TZ)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return local_midnight.astimezone(_EXPERIMENT_TZ), now_utc

def local_iso(x):
    # Convert aware timestamps to Europe/Rome ISO; pass through if not datetime
    return x.astimezone(_EXPERIMENT_TZ).isoformat() if hasattr(x, "astimezone") else x


def _parse_hour_range(hour_range: Optional[str]) -> Optional[Tuple[str, str]]:
    if not hour_range:
        return None
    parts = [p.strip() for p in hour_range.split(",")]
    if len(parts) != 2:
        logger.info("chatbot.hour_range.invalid format=%s", hour_range)
        raise HTTPException(status_code=400, detail="hour_range must be 'HH:MM,HH:MM'")
    return parts[0], parts[1]


def _interest_to_cols(interest_type: str) -> Dict[str, List[str]]:
    if interest_type == "time":
        return {"time": ["working_time", "idle_time", "offline_time", "alarm_time", "utilization_rate"]}
    if interest_type == "energy_and_cost":
        return {
            "energy_and_cost": [
                "consumption_total",     # exposed as "consumption"
                "consumption_working",
                "consumption_idle",
                "power",
                "cost",
            ]
        }
    if interest_type == "production":
        return {
            "production": [
                "cycles", "good_cycles", "bad_cycles",
                "avg_cycle_time",       # exposed as "average_cycle_time"
                "avg_cycle_cost", 
            ]
        }
    if interest_type == "efficiency":
        return {"efficiency": ["availability", "performance", "quality", "oee"]}
    if interest_type == "status":
        return {"status": ["status"]}
    logger.info("chatbot.params.unknown_interest_type interest_type=%s", interest_type)
    raise HTTPException(status_code=400, detail=f"Unknown interest_type '{(interest_type or '')}'")

def _rename_keys_for_output(group_key: str, row: Dict[str, Any]) -> Dict[str, Optional[float]]:
    out: Dict[str, Optional[float]] = {}
    for k, v in row.items():
        if k is None:
            continue
        if group_key == "energy_and_cost" and k == "consumption_total":
            out["consumption"] = _num(v)
        elif group_key == "production" and k == "avg_cycle_time":
            out["average_cycle_time"] = _num(v)
        else:
            out[k] = _num(v)
    return out

def _num(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except Exception:
        return None

async def _fetch_assets_meta(cur, ids: List[str]) -> Dict[str, Dict[str, Any]]:
    if not ids:
        return {}
    await _exec(
        cur,
        "SELECT id, name, type, meta FROM machines WHERE id = ANY(%s)",
        (ids,)
    )
    rows = await _fetchall(cur)
    return {(_row_to_map(cur, r)["id"]): {
                "name": _row_to_map(cur, r).get("name"),
                "type": _row_to_map(cur, r).get("type"),
                "meta": _row_to_map(cur, r).get("meta"),
            }
            for r in rows}


def _fmt_util_rate_for_display(d: dict) -> dict:
    v = d.get("utilization_rate", None)
    if v is None or isinstance(v, str):
        return d
    try:
        x = float(v)
        # If it's a ratio (0–1), scale to 0–100; if it's already 0–100, leave it.
        if 0 <= x <= 1.0001:
            x *= 100.0
        d["utilization_rate"] = f"{x:.1f}%"
    except Exception:
        d["utilization_rate"] = None
    return d

# --- Historical  ------------------------------------------------
def _local_midnight_bounds_utc(tz_name: str, day: datetime) -> tuple[datetime, datetime]:
    """
    Compute [local midnight, next local midnight) for a given 'day' (UTC now by default),
    then convert both to UTC. If ZoneInfo is missing, fallback to simple UTC day bounds.
    """
    now_utc = day.astimezone(timezone.utc)
    if ZoneInfo is None:
        start_utc = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
        end_utc = start_utc + timedelta(days=1)
        return start_utc, end_utc
    tz = ZoneInfo(tz_name)
    local = now_utc.astimezone(tz)
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)

def _history_window_utc(timerange: str, custom_start: Optional[str], custom_end: Optional[str]) -> tuple[datetime, datetime]:
    """
    Returns (start_utc, end_utc) as half-open interval [start, end).
    Timeranges are interpreted in the *local* timezone where relevant, then converted to UTC.
    """
    now_utc = datetime.now(timezone.utc)
    tz = _EXPERIMENT_TZ
    exp_now_local = experiment_now_utc()                # this returns Europe/Rome tz-aware
    base_local = exp_now_local.astimezone(tz) if tz else exp_now_local

    def local_date(dt_local: datetime):
        # dt_local is already local; just take the date
        return dt_local.date()

    today_local = local_date(base_local)

    # helpers
    def loc_midnight(d):
        return datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=tz)


    if timerange == "yesterday":
        end_local = loc_midnight(today_local)  # start of today
        start_local = end_local - timedelta(days=1)
    elif timerange == "this_week":
        # Monday as start of week
        start_local = loc_midnight(today_local - timedelta(days=today_local.weekday()))
        end_local = loc_midnight(today_local) + (now_utc - now_utc)  # start of today; you may choose 'now'
    elif timerange == "last_week":
        this_week_start = loc_midnight(today_local - timedelta(days=today_local.weekday()))
        start_local = this_week_start - timedelta(days=7)
        end_local = this_week_start
    elif timerange == "this_month":
        start_local = loc_midnight(today_local.replace(day=1))
        end_local = loc_midnight(today_local)  # start of today; you may choose end=now
    elif timerange == "last_month":
        first_this_month = today_local.replace(day=1)
        last_month_end = first_this_month - timedelta(days=1)
        start_local = loc_midnight(last_month_end.replace(day=1))
        end_local = loc_midnight(first_this_month)
    elif timerange == "last_trimester":
        # previous 3 *full* months
        first_this_month = today_local.replace(day=1)
        start_local = loc_midnight((first_this_month - relativedelta(months=3)))
        end_local = loc_midnight(first_this_month)
    elif timerange == "last_semester":
        first_this_month = today_local.replace(day=1)
        start_local = loc_midnight((first_this_month - relativedelta(months=6)))
        end_local = loc_midnight(first_this_month)
    elif timerange == "this_year":
        start_local = loc_midnight(today_local.replace(month=1, day=1))
        end_local = loc_midnight(today_local)  # start of today; you may choose end=now
    elif timerange == "custom":
        if not (custom_start and custom_end):
            raise HTTPException(status_code=400, detail="custom_start and custom_end are required for timerange=custom (YYYY-MM-DD).")
        try:
            cs = datetime.strptime(custom_start, "%Y-%m-%d").date()
            ce = datetime.strptime(custom_end, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD.")
        if ce < cs:
            raise HTTPException(status_code=400, detail="custom_end must be >= custom_start.")
        start_local = loc_midnight(cs)
        end_local = loc_midnight(ce + timedelta(days=1))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown timerange '{timerange}'.")

    # convert to UTC if needed
    start_utc = start_local.astimezone(timezone.utc) if tz else start_local
    end_utc = end_local.astimezone(timezone.utc) if tz else end_local
    exp_now_utc = experiment_now_utc().astimezone(timezone.utc)
    if end_utc > exp_now_utc:
        end_utc = exp_now_utc

    return start_utc, end_utc


_TIME_SEC_FIELDS = {"working_time", "idle_time", "offline_time", "alarm_time"}

def _secs_to_hms_str(v: Optional[float | int]) -> Optional[str]:
    if v is None:
        return None
    total = int(round(float(v)))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    # hours can exceed 24; keep them as a wide field (at least 2 digits)
    return f"{h:02d}:{m:02d}:{s:02d}"

def _apply_time_format(d: Dict[str, Any], time_format: str, renamed_time_keys: Dict[str, str]) -> Dict[str, Any]:
    """Mutates a copy of `d` according to time_format for time fields only."""
    out = dict(d)
    for orig_key, out_key in renamed_time_keys.items():
        if out_key in out:
            hms = _secs_to_hms_str(out[out_key])
            if time_format == "hhmmss":
                out[out_key] = hms
            elif time_format == "both":
                out[out_key + "_hhmmss"] = hms
            # "seconds" => do nothing
    return out