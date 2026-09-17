# app/routes/dashboard.py
import re
from datetime import datetime, timezone
from typing import List, Optional, Tuple
from fastapi import APIRouter, Depends, HTTPException, Query
from ..db import with_cursor
import logging

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="", tags=["dashboard"])  # single router

SCENARIO_CUTOFF_UTC = datetime(2025, 11, 5, 10, 30, 0, tzinfo=timezone.utc)  # 11:30 Rome

def build_bucket_sql(bucket: str, ts_local_expr: str) -> Tuple[str, list]:
    b = bucket.strip().lower()

    m = re.fullmatch(r'(\d+)\s*m', b)
    if m:
        b = f"{int(m.group(1))} minutes"

    h = re.fullmatch(r'(\d+)\s*h', b)
    if h:
        n = int(h.group(1))
        b = "1 day" if n == 24 else f"{n} hours"

    d = re.fullmatch(r'(\d+)\s*d', b)
    if d:
        n = int(d.group(1))
        b = "day" if n == 1 else f"{n} days"  # ← singular for 1

    # Canonicals
    if b in ("minute", "minutes", "1 minute"):
        return f"date_trunc('minute', {ts_local_expr})", []
    if b in ("hour", "hours", "1 hour"):
        return f"date_trunc('hour', {ts_local_expr})", []

    # Day(s)
    if b in ("day", "1 day"):                       # ← now 1d → "day"
        return f"date_trunc('day', {ts_local_expr})", []
    # (Optional) tolerate “1 days” or “days?” just in case:
    m = re.fullmatch(r'(\d+)\s*days?', b)
    if m and int(m.group(1)) == 1:
        return f"date_trunc('day', {ts_local_expr})", []

    # N minutes within hour
    m = re.fullmatch(r'(\d+)\s*minutes?', b)
    if m:
        n = int(m.group(1))
        if n <= 0 or n >= 60:
            raise HTTPException(400, "minutes bucket must be in 1..59")
        sql = (
            f"date_trunc('hour', {ts_local_expr}) "
            f"+ make_interval(mins => (extract(minute from {ts_local_expr})::int / %s) * %s)"
        )
        return sql, [n, n]

    # N hours within day
    m = re.fullmatch(r'(\d+)\s*hours?', b)
    if m:
        n = int(m.group(1))
        if n <= 0 or n >= 24:
            raise HTTPException(400, "hours bucket must be in 1..23")
        sql = (
            f"date_trunc('day', {ts_local_expr}) "
            f"+ make_interval(hours => (extract(hour from {ts_local_expr})::int / %s) * %s)"
        )
        return sql, [n, n]

    raise HTTPException(400, "invalid bucket. Try: 'minute','hour','day','15 minutes','6 hours','15m','6h','1 day'.")





@router.get("/dashboard")
async def get_timeseries(
    from_iso: str,
    to_iso: str,
    facet: Optional[str] = Query(None, description="one of: status | consumption | productivity"),
    machine_ids: Optional[str] = Query(None, description="comma-separated machine ids"),
    bucket: str = Query("1h", description="time bucket, e.g., '15m','1h','6h','day'"),
    tz: str = Query("Europe/Rome", description="IANA time zone for bucketing"),
    cur=Depends(with_cursor),
):
    # Parse ISO safely
    try:
        t_from = datetime.fromisoformat(from_iso.replace("Z", "+00:00"))
        t_to   = datetime.fromisoformat(to_iso.replace("Z", "+00:00"))
        if t_from > SCENARIO_CUTOFF_UTC:
            t_from = SCENARIO_CUTOFF_UTC
        if t_to > SCENARIO_CUTOFF_UTC:
            t_to = SCENARIO_CUTOFF_UTC

        # if window collapses, return empty
        if t_to <= t_from:
            return {"series": [], "bucket": bucket}
    except Exception:
        raise HTTPException(400, "invalid iso date")

    ids: Optional[List[str]] = [s for s in (machine_ids or "").split(",") if s] or None
    # --- build the local-time expressions once ---
    ts_local_expr = "(mts.ts AT TIME ZONE %s)"                  # tz → local wall time (timestamp without time zone)
    bucket_local_expr, bucket_params = build_bucket_sql(bucket, ts_local_expr)

    # how many times did we embed ts_local_expr? (15m / 6h have it twice)
    tz_uses_in_bucket = bucket_local_expr.count(ts_local_expr)

    # CRUCIAL: parenthesize the whole local expression before converting back to UTC
    t_bucket_expr = f"(({bucket_local_expr}) AT TIME ZONE %s)"

    # param prefix shared by all facets:
    #   [tz × tz_uses_in_bucket] + [numeric bucket params] + [tz for the OUTER AT TIME ZONE]
    common_prefix = [*([tz] * tz_uses_in_bucket), *bucket_params, tz]

    # ---------------------------------------
    # FACET: STATUS
    # mapping: status, working_time, idle_time, offline_time, alarm_time, alarm_start_count
    # Aggregation: sum time fields per bucket; also sum alarm starts.
    # ---------------------------------------
    if facet == "status":
        sql = f"""
        SELECT
        m.id   AS machine_id,
        m.name AS machine_name,
        {t_bucket_expr} AS t_bucket,
        COALESCE(SUM(mts.working_time), 0)      AS working_time,
        COALESCE(SUM(mts.idle_time), 0)         AS idle_time,
        COALESCE(SUM(mts.offline_time), 0)      AS offline_time,
        COALESCE(SUM(mts.alarm_time), 0)        AS alarm_time,
        COALESCE(SUM(mts.alarm_start_count), 0) AS alarm_start_count,
        AVG(mts.utilization_rate) * 100          AS utilization_rate
        FROM machine_timeseries mts
        JOIN machines m ON m.id = mts.machine_id
        WHERE mts.ts >= %s AND mts.ts < %s
        {"AND mts.machine_id = ANY(%s)" if ids else ""}
        GROUP BY 1,2,3
        ORDER BY 3,2;
        """
        params = [*common_prefix, t_from, t_to] + ([ids] if ids else [])

       

    # ---------------------------------------
    # FACET: CONSUMPTION (and POWER alias)
    # mapping: power, consumption_total, consumption_working, consumption_idle, cost
    # Aggregation:
    #   - avg_power: AVG(power)
    #   - delta_kwh: MAX(consumption_total) - MIN(consumption_total)   (cumulative counter)
    #   - kwh_working / kwh_idle: SUM(consumption_working / consumption_idle)
    #   - cost: SUM(cost)
    # ---------------------------------------
    elif facet == "consumption":
        sql = f"""
        SELECT
        m.id   AS machine_id,
        m.name AS machine_name,
        {t_bucket_expr} AS t_bucket,
        AVG(mts.power)                                         AS power,
        COALESCE(SUM(mts.consumption_total),
        SUM(mts.consumption_working) + 
        SUM(mts.consumption_idle), 0)                          AS consumption_total,
        COALESCE(SUM(mts.consumption_working), 0)              AS consumption_working,
        COALESCE(SUM(mts.consumption_idle), 0)                 AS consumption_idle,
        COALESCE(SUM(mts.cost), 0)                             AS cost
        FROM machine_timeseries mts
        JOIN machines m ON m.id = mts.machine_id
        WHERE mts.ts >= %s AND mts.ts < %s
        {"AND mts.machine_id = ANY(%s)" if ids else ""}
        GROUP BY 1,2,3
        ORDER BY 3,2;
        """
        params = [*common_prefix, t_from, t_to] + ([ids] if ids else [])

    # ---------------------------------------
    # FACET: PRODUCTIVITY
    # mapping: cycles, good_cycles, bad_cycles, oee, quality, performance, availability, cost
    # Aggregation:
    #   - cycles/good/bad: SUM
    #   - oee/quality/performance/availability: AVG (per-bucket mean)
    #   - avg_cycle_time: AVG (useful for tiles; included even if not in mapping)
    #   - cost: SUM
    # ---------------------------------------
    elif facet == "productivity":
        sql = f"""
        SELECT
        m.id   AS machine_id,
        m.name AS machine_name,
        {t_bucket_expr} AS t_bucket,
        COALESCE(SUM(mts.cycles), 0)        AS cycles,
        COALESCE(SUM(mts.good_cycles), 0)   AS good_cycles,
        COALESCE(SUM(mts.bad_cycles), 0)    AS bad_cycles,
        AVG(mts.oee) * 100                  AS oee,
        AVG(mts.quality) * 100              AS quality,
        AVG(mts.performance) * 100          AS performance,
        AVG(mts.availability) * 100         AS availability,
        AVG(mts.avg_cycle_time)             AS avg_cycle_time,
        AVG(mts.avg_cycle_cost)             AS avg_cycle_cost,
        COALESCE(SUM(mts.cost), 0)          AS cost
        FROM machine_timeseries mts
        JOIN machines m ON m.id = mts.machine_id
        WHERE mts.ts >= %s AND mts.ts < %s
        {"AND mts.machine_id = ANY(%s)" if ids else ""}
        GROUP BY 1,2,3
        ORDER BY 3,2;
        """
        params = [*common_prefix, t_from, t_to] + ([ids] if ids else [])
    if not sql:
        raise HTTPException(400, "unsupported facet")

    # Single execute/fetch/return
    try:
        await cur.execute(sql, params)
        rows = await cur.fetchall()
        # --- DEBUG: log starts only when alarm_time > 0 ---
        if facet == "status":
            # Make sure we can access by column name even if fetchall() returned tuples
            try:
                cols = [d[0] for d in cur.description]
                rows_dict = [r if isinstance(r, dict) else dict(zip(cols, r)) for r in rows]
            except Exception:
                rows_dict = rows  # already dicts

            filtered = [
                {
                    "machine_id": r.get("machine_id"),
                    "t_bucket":   r.get("t_bucket"),
                    "alarm_time": r.get("alarm_time"),
                    "alarm_start_count": r.get("alarm_start_count"),
                }
                for r in rows_dict
                if (r.get("alarm_time") or 0) > 0
            ]

            # quick summary + a small sample to avoid log spam
            n = len(filtered)
            n_with_starts = sum(1 for r in filtered if (r.get("alarm_start_count") or 0) > 0)
            #logger.info(
            #    "status debug: %d rows with alarm_time>0; %d rows have alarm_start_count>0; sample=%s",
            #    n, n_with_starts, filtered[:8]
            #)

            # (optional) aggregate by machine for faster eyeballing
            if n:
                from collections import defaultdict
                agg = defaultdict(lambda: {"alarm_time": 0.0, "alarm_start_count": 0})
                for r in filtered:
                    mid = r["machine_id"]
                    agg[mid]["alarm_time"] += float(r["alarm_time"] or 0)
                    agg[mid]["alarm_start_count"] += int(r["alarm_start_count"] or 0)
                # log first few machines
                sample_agg = [
                    {"machine_id": k, **v} for k, v in list(agg.items())[:5]
                ]
                #logger.info("status debug agg (first 5): %s", sample_agg)
    except Exception as e:
        # Only catch unexpected DB errors -> 500
        raise HTTPException(500, f"query failed: {e}")  # or log and re-raise
    
    return {"series": rows, "bucket": bucket}