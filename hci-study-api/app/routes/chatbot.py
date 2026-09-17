from __future__ import annotations
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.types.json import Jsonb
from app.routes.deps import with_cursor, require_session
from datetime import datetime, timedelta, timezone
import logging

from app.services.chatbot_utils import (
    _exec, _fetchall, _fetchone, _row_to_map, _parse_hour_range, experiment_now_utc, since_midnight_bounds_utc, local_iso,
    _interest_to_cols, _rename_keys_for_output, _fetch_assets_meta, _history_window_utc,
    _secs_to_hms_str, _apply_time_format, _TIME_SEC_FIELDS, _fmt_util_rate_for_display
    )


from app.routes.deps import with_cursor
from app.schemas_chatbot import (
    ResolveAssetsResponse, AssetMatch,
    CurrentResponse, CurrentContext, SingleAssetPayload, OverallPayload,
    KPIGroup, KPITimeDisplay, StatusPayload, AggregationInfo,
    ConversationStartRequest, ConversationStartResponse,
    ChatMessageBatchIn, ConversationEndRequest,
)

# --- Logging -----------------------------------------------------------------
logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="/chatbot", tags=["chatbot"])



# --- Create conversation ------------------------------------------------------
def _idx_or_key(row, key, idx):
    """Works with either dict-like or tuple-like rows."""
    try:
        return row[key]
    except Exception:
        return row[idx]

@router.post("/conversations/start", response_model=ConversationStartResponse)
async def start_conversation(
    body: ConversationStartRequest,
    auth=Depends(require_session),
    cur=Depends(with_cursor),
):
    pid = auth["participant_id"]
    sid = auth["session_id"]

    # Reuse open convo for this task (matches ux_cc_open_by_task)
    await cur.execute(
        """
        SELECT id FROM chat_conversations
        WHERE participant_id=%s AND session_id=%s
          AND task_code=%s AND ended_at IS NULL
        LIMIT 1
        """,
        (pid, sid, body.task_code),
    )
    row = await cur.fetchone()
    if row:
        conv_id = _idx_or_key(row, "id", 0)
        return ConversationStartResponse(conversation_id=str(conv_id))

    await cur.execute(
        """
        INSERT INTO chat_conversations (participant_id, session_id, model, task_code, meta)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
        """,
        (pid, sid, body.model, body.task_code,
         Jsonb(body.meta) if body.meta is not None else None),
    )
    rec = await cur.fetchone()
    if not rec:
        raise HTTPException(status_code=500, detail="conversation_insert_failed")

    conv_id = _idx_or_key(rec, "id", 0)
    return ConversationStartResponse(conversation_id=str(conv_id))

@router.post("/messages/batch")
async def log_messages(
    body: ChatMessageBatchIn,
    auth=Depends(require_session),
    cur=Depends(with_cursor),
):
    # 1) Guard ownership
    await cur.execute(
        "SELECT participant_id, session_id FROM chat_conversations WHERE id = %s",
        (body.conversation_id,),
    )
    conv = await cur.fetchone()
    if not conv:
        raise HTTPException(status_code=404, detail="conversation_not_found")

    conv_pid = _idx_or_key(conv, "participant_id", 0)
    conv_sid = _idx_or_key(conv, "session_id", 1)
    if conv_pid != auth["participant_id"] or conv_sid != auth["session_id"]:
        raise HTTPException(status_code=403, detail="conversation_forbidden")

    # 2) Insert messages with idempotency (ux_cm_client_id)
    sql = """
    INSERT INTO chat_messages
    (conversation_id, ts, role, content, tokens, latency_ms, tool_name, tool_params, raw, client_msg_id)
    VALUES
    (%s, COALESCE(%s, now()), %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (client_msg_id) DO NOTHING
    """
    params = []
    for m in body.messages:
        params.append((
            body.conversation_id,
            m.ts, m.role, m.content, m.tokens, m.latency_ms,
            m.tool_name, m.tool_params,
            Jsonb(m.raw) if m.raw is not None else None,
            m.client_msg_id,
        ))

    if params:  # avoid executemany([]) on empty batches
        await cur.executemany(sql, params)

    return {"ok": True, "n": len(params)}

@router.post("/conversations/{conversation_id}/end")
async def end_conversation(
    conversation_id: str,
    body: ConversationEndRequest = ConversationEndRequest(),
    auth=Depends(require_session),
    cur=Depends(with_cursor),
):
    await cur.execute(
        "SELECT participant_id, session_id FROM chat_conversations WHERE id = %s",
        (conversation_id,),
    )
    conv = await cur.fetchone()
    if not conv:
        raise HTTPException(status_code=404, detail="conversation_not_found")

    conv_pid = _idx_or_key(conv, "participant_id", 0)
    conv_sid = _idx_or_key(conv, "session_id", 1)
    if conv_pid != auth["participant_id"] or conv_sid != auth["session_id"]:
        raise HTTPException(status_code=403, detail="conversation_forbidden")

    await cur.execute(
        "UPDATE chat_conversations SET ended_at = COALESCE(%s, now()) WHERE id = %s",
        (body.ended_at, conversation_id),
    )
    return {"ok": True}


# --- Endpoints --------------------------------------------------------------
MAX_ROWS = 130  # aligns with chatbot cap
@router.get("/assets/resolve", response_model=ResolveAssetsResponse)
async def resolve_assets(
    q: List[str] = Query(..., description="repeatable query terms (asset names/aliases)"),
    cur = Depends(with_cursor),
):
    patterns = [s.strip() for s in q if s and s.strip()]
    if not patterns:
        logger.info("chatbot.resolve_assets.missing_q")
        raise HTTPException(status_code=400, detail="At least one 'q' required.")

    hits: List[AssetMatch] = []
    for term in patterns:
        logger.info("chatbot.resolve_assets.query term=%s", term)
        await _exec(
            cur,
            """
            SELECT m.id, m.name, m.type, m.meta
            FROM machines m
            WHERE LOWER(m.name) = LOWER(%s)
               OR EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements_text(COALESCE(m.meta->'aliases','[]'::jsonb)) AS a(val)
                    WHERE LOWER(a.val) = LOWER(%s)
               )
            LIMIT 20
            """,
            (term, term),
        )
        rows = await _fetchall(cur)
        logger.info("chatbot.resolve_assets.matches term=%s count=%d", term, len(rows))
        for r in rows:
            rm = _row_to_map(cur, r)
            meta = rm.get("meta") or {}
            hits.append(
                AssetMatch(
                    machine_id=str(rm.get("id")),
                    name=rm.get("name"),
                    type=rm.get("type"),
                    aliases=meta.get("aliases") if isinstance(meta.get("aliases"), list) else None,
                    meta=meta or None,
                )
            )
    logger.info("chatbot.resolve_assets.total count=%d", len(hits))
    return ResolveAssetsResponse(matches=hits)

# --- Current endpoint --------------------------------------------------------


@router.get("/machines/current", response_model=CurrentResponse)
async def machines_current(
    request_scope: str = Query(..., pattern="^(single_assets|overall)$"),
    interest_type: str = Query(..., pattern="^(time|energy_and_cost|production|efficiency|status)$"),
    time_granularity: str = Query(..., pattern="^(daily|hourly)$"),
    machine_id: Optional[List[str]] = Query(None, description="repeatable machine ids"),
    hour_range: Optional[str] = Query(None, description="HH:MM,HH:MM (optional, hourly only)"),
    window: str = Query("since_midnight", pattern="^(since_midnight|latest|last_minutes)$"),
    minutes: Optional[int] = Query(None, ge=1, le=1440),
    tz: str = Query("Europe/Rome"),
    cur = Depends(with_cursor),
):
    logger.info(
        "chatbot.current.params scope=%s interest=%s granularity=%s window=%s minutes=%s tz=%s machine_ids=%s",
        request_scope, interest_type, time_granularity, window, minutes, tz,
        None if not machine_id else f"{len(machine_id)} ids"
    )

    if request_scope == "single_assets" and not machine_id:
        logger.info("chatbot.current.bad_request missing_machine_id_for_single_assets")
        raise HTTPException(status_code=400, detail="machine_id is required for single_assets")
    if request_scope == "overall" and machine_id:
        logger.info("chatbot.current.notice overall_ignores_machine_list count=%d", len(machine_id))
        machine_id = None

    group_cols = _interest_to_cols(interest_type)
    hour_pair = _parse_hour_range(hour_range) if hour_range else None

    # Map original time columns -> renamed JSON keys for the 'time' group
    renamed_time_keys = {
        c: list(_rename_keys_for_output("time", {c: 0}).keys())[0]
        for c in _TIME_SEC_FIELDS
        if any(c in v for v in group_cols.values())
    }

    tz = "Europe/Rome"  # force the experiment TZ

    ref_now_utc = experiment_now_utc()
    if window == "since_midnight":
        start_utc, end_utc = since_midnight_bounds_utc()
    elif window == "last_minutes":
        if not minutes:
            logger.info("chatbot.current.bad_request missing_minutes_for_last_minutes")
            raise HTTPException(status_code=400, detail="minutes is required when window=last_minutes")
        start_utc, end_utc = ref_now_utc - timedelta(minutes=minutes), ref_now_utc
    else:  # latest
        start_utc, end_utc = None, ref_now_utc

    logger.info(
        "chatbot.current.bounds start_utc=%s end_utc=%s hour_range=%s",
        start_utc.isoformat() if start_utc else None,
        end_utc.isoformat() if end_utc else None,
        hour_pair
    )

    ctx = CurrentContext(
        window=window,
        tz=tz,
        time_granularity=time_granularity,
        hour_range=list(hour_pair) if hour_pair else None,
    )
    notes: List[str] = []
    resp = CurrentResponse(context=ctx, notes=notes)

    # STATUS path
    if interest_type == "status":
        ids = machine_id or []
        if request_scope == "overall":
            where_ts = []
            params: Dict[str, Any] = {}
            if start_utc is not None:
                where_ts.append("mts.ts >= %(start_utc)s")
                params["start_utc"] = start_utc
            if end_utc is not None:
                where_ts.append("mts.ts <= %(end_utc)s")
                params["end_utc"] = end_utc
            where_sql = "WHERE " + " AND ".join(where_ts) if where_ts else ""

            await _exec(cur, f"SELECT MAX(mts.ts) AS sample_ts FROM machine_timeseries mts {where_sql}", params)
            row = await _fetchone(cur)
            sample_ts = None
            if row:
                rm = _row_to_map(cur, row)
                sample_ts = local_iso(rm.get("sample_ts"))
            logger.info("chatbot.current.status.overall sample_ts=%s (bounded)", sample_ts)
            resp.overall = OverallPayload(sample_ts=sample_ts, kpis={})
            return resp

        where_ts = []
        params_ids: Dict[str, Any] = {"ids": ids}
        if start_utc is not None:
            where_ts.append("mts.ts >= %(start_utc)s")
            params_ids["start_utc"] = start_utc
        if end_utc is not None:
            where_ts.append("mts.ts <= %(end_utc)s")
            params_ids["end_utc"] = end_utc
        and_ts = (" AND " + " AND ".join(where_ts)) if where_ts else ""

        await _exec(
            cur,
            f"""
            SELECT DISTINCT ON (mts.machine_id)
                mts.machine_id, mts.ts, mts.status
            FROM machine_timeseries mts
            WHERE mts.machine_id = ANY(%(ids)s)
            {and_ts}
            ORDER BY mts.machine_id, mts.ts DESC
            """,
            params_ids,
        )
        latest = await _fetchall(cur)
        logger.info("chatbot.current.status.assets count=%d", len(latest))
        meta = await _fetch_assets_meta(cur, ids)
        payloads: List[SingleAssetPayload] = []
        for r in latest:
            rm = _row_to_map(cur, r)
            ts = rm.get("ts")
            payloads.append(
                SingleAssetPayload(
                    machine_id=str(rm.get("machine_id")),
                    name=(meta.get(str(rm.get("machine_id"))) or {}).get("name"),
                    sample_ts=local_iso(ts),
                    status=StatusPayload(value=rm.get("status")),
                    kpis={},
                )
            )
        resp.assets = payloads
        return resp

    # KPI path (aggregations)
    cols = [c for cols in group_cols.values() for c in cols]
    ids_filter_sql = "" if (request_scope == "overall" or not machine_id) else "AND mts.machine_id = ANY(%(ids)s)"

    if time_granularity == "daily":
        logger.info("chatbot.current.kpi.daily start")
        sel_parts = []
        agg_map_sum = {
            "working_time", "idle_time", "offline_time", "alarm_time",
            "consumption_total", "consumption_working", "consumption_idle",
            "cycles", "good_cycles", "bad_cycles",
        }
        agg_map_avg = {"oee", "quality", "performance", "availability", "avg_cycle_time", "avg_cycle_cost", "power", "cost", "utilization_rate"}
        for c in cols:
            if c in agg_map_sum:
                sel_parts.append(f"SUM(mts.{c}) AS {c}")
            elif c in agg_map_avg:
                sel_parts.append(f"AVG(mts.{c}) AS {c}")
            else:
                sel_parts.append(f"AVG(mts.{c}) AS {c}")

        where_ts = []
        params: Dict[str, Any] = {}
        if start_utc is not None:
            where_ts.append("mts.ts >= %(start_utc)s")
            params["start_utc"] = start_utc
        if end_utc is not None:
            where_ts.append("mts.ts <= %(end_utc)s")
            params["end_utc"] = end_utc
        if ids_filter_sql:
            params["ids"] = machine_id

        where_sql = "WHERE " + " AND ".join(where_ts) if where_ts else ""
        select_sql = ", ".join(sel_parts)

        if request_scope == "overall":
            await _exec(
                cur,
                f"""
                SELECT MAX(mts.ts) AS sample_ts, {select_sql}
                FROM machine_timeseries mts
                {where_sql}
                """,
                params,
            )
            row = await _fetchone(cur)
            if row:
                rm = _row_to_map(cur, row)
                sample_ts = rm.get("sample_ts")
                sample_ts = local_iso(sample_ts)
                kpis_out: Dict[str, KPIGroup] = {}
                kpis_display: Dict[str, KPITimeDisplay] = {}
                for group_key, gcols in group_cols.items():
                    data = {k: rm.get(k) for k in gcols}
                    kpis_out[group_key] = KPIGroup.model_validate(_rename_keys_for_output(group_key, data))
                    if group_key == "time":
                        disp = _apply_time_format(kpis_out[group_key].model_dump(), "hhmmss", renamed_time_keys)
                        disp = _fmt_util_rate_for_display(disp)
                        kpis_display["time"] = KPITimeDisplay.model_validate(disp)
                resp.overall = OverallPayload(
                    sample_ts=sample_ts,
                    kpis=kpis_out,
                    kpis_display=kpis_display or None,
                )
                logger.info("chatbot.current.kpi.daily.overall ok sample_ts=%s", sample_ts)
            else:
                notes.append("No data available in the requested window.")
                logger.info("chatbot.current.kpi.daily.overall empty")
            return resp

        await _exec(
            cur,
            f"""
            SELECT mts.machine_id,
                   MAX(mts.ts) AS sample_ts,
                   {select_sql}
            FROM machine_timeseries mts
            {where_sql} {ids_filter_sql}
            GROUP BY mts.machine_id
            """,
            params,
        )
        rows = await _fetchall(cur)
        logger.info("chatbot.current.kpi.daily.assets count=%d", len(rows))
        meta = await _fetch_assets_meta(cur, machine_id or [])
        assets: List[SingleAssetPayload] = []
        for r in rows:
            rm = _row_to_map(cur, r)
            m_id = str(rm.get("machine_id"))
            sample_ts = rm.get("sample_ts")
            sample_ts = local_iso(sample_ts)
            kpis_out: Dict[str, KPIGroup] = {}
            kpis_display: Dict[str, KPITimeDisplay] = {}
            for group_key, gcols in group_cols.items():
                data = {k: rm.get(k) for k in gcols}
                kpis_out[group_key] = KPIGroup.model_validate(_rename_keys_for_output(group_key, data))
                if group_key == "time":
                    disp = _apply_time_format(kpis_out[group_key].model_dump(), "hhmmss", renamed_time_keys)
                    disp = _fmt_util_rate_for_display(disp)
                    kpis_display["time"] = KPITimeDisplay.model_validate(disp)
            assets.append(
                SingleAssetPayload(
                    machine_id=m_id,
                    name=(meta.get(m_id) or {}).get("name"),
                    sample_ts=sample_ts,
                    kpis=kpis_out,
                    kpis_display=kpis_display or None,
                    aggregation=AggregationInfo(basis=window, rows_used=-1, fallback=False),
                )
            )
        resp.assets = assets
        return resp

    else:  # hourly
        logger.info("chatbot.current.kpi.hourly start")
        where_ts = []
        params: Dict[str, Any] = {}
        if start_utc is not None:
            where_ts.append("mts.ts >= %(start_utc)s")
            params["start_utc"] = start_utc
        if end_utc is not None:
            where_ts.append("mts.ts <= %(end_utc)s")
            params["end_utc"] = end_utc
        if ids_filter_sql:
            params["ids"] = machine_id
        where_sql = "WHERE " + " AND ".join(where_ts) if where_ts else ""

        sel_parts = []
        agg_map_sum = {
            "working_time", "idle_time", "offline_time", "alarm_time",
            "consumption_total", "consumption_working", "consumption_idle",
            "cycles", "good_cycles", "bad_cycles",
        }
        agg_map_avg = {"oee", "quality", "performance", "availability", "avg_cycle_time", "avg_cycle_cost", "power", "cost", "utilization_rate"}
        for c in cols:
            if c in agg_map_sum:
                sel_parts.append(f"SUM(mts.{c}) AS {c}")
            elif c in agg_map_avg:
                sel_parts.append(f"AVG(mts.{c}) AS {c}")
            else:
                sel_parts.append(f"AVG(mts.{c}) AS {c}")
        select_sql = ", ".join(sel_parts)

        if request_scope == "overall":
            await _exec(
                cur,
                f"""
                SELECT date_trunc('hour', mts.ts) AS hour_bucket,
                       MAX(mts.ts) AS sample_ts,
                       {select_sql}
                FROM machine_timeseries mts
                {where_sql}
                GROUP BY hour_bucket
                ORDER BY hour_bucket ASC
                """,
                params,
            )
            rows = await _fetchall(cur)
            logger.info("chatbot.current.kpi.hourly.overall rows=%d", len(rows))
            if len(rows) > MAX_ROWS:
                notes.append("Too many hourly rows; falling back to daily aggregates.")
                logger.info("chatbot.current.kpi.hourly.overall fallback_to_daily rows=%d", len(rows))
                await _exec(
                    cur,
                    f"""
                    SELECT MAX(mts.ts) AS sample_ts, {select_sql}
                    FROM machine_timeseries mts
                    {where_sql}
                    """,
                    params,
                )
                row = await _fetchone(cur)
                if row:
                    rm = _row_to_map(cur, row)
                    sample_ts = rm.get("sample_ts")
                    sample_ts = local_iso(sample_ts)
                    kpis_out: Dict[str, KPIGroup] = {}
                    kpis_display: Dict[str, KPITimeDisplay] = {}
                    for group_key, gcols in group_cols.items():
                        data = {k: rm.get(k) for k in gcols}
                        kpis_out[group_key] = KPIGroup.model_validate(_rename_keys_for_output(group_key, data))
                        if group_key == "time":
                            disp = _apply_time_format(kpis_out[group_key].model_dump(), "hhmmss", renamed_time_keys)
                            disp = _fmt_util_rate_for_display(disp)
                            kpis_display["time"] = KPITimeDisplay.model_validate(disp)
                    resp.overall = OverallPayload(
                        sample_ts=sample_ts,
                        kpis=kpis_out,
                        kpis_display=kpis_display or None,
                    )
                return resp

            last = rows[-1] if rows else None
            if last:
                rm = _row_to_map(cur, last)
                sample_ts = rm.get("sample_ts")
                sample_ts = local_iso(sample_ts)
                kpis_out: Dict[str, KPIGroup] = {}
                kpis_display: Dict[str, KPITimeDisplay] = {}
                for group_key, gcols in group_cols.items():
                    data = {k: rm.get(k) for k in gcols}
                    kpis_out[group_key] = KPIGroup.model_validate(_rename_keys_for_output(group_key, data))
                    if group_key == "time":
                        disp = _apply_time_format(kpis_out[group_key].model_dump(), "hhmmss", renamed_time_keys)
                        disp = _fmt_util_rate_for_display(disp)
                        kpis_display["time"] = KPITimeDisplay.model_validate(disp)
                resp.overall = OverallPayload(
                    sample_ts=sample_ts,
                    kpis=kpis_out,
                    kpis_display=kpis_display or None,
                )
                logger.info("chatbot.current.kpi.hourly.overall ok sample_ts=%s", sample_ts)
            else:
                notes.append("No hourly data available.")
                logger.info("chatbot.current.kpi.hourly.overall empty")
            return resp

        # single_assets hourly
        await _exec(
            cur,
            f"""
            SELECT mts.machine_id,
                   date_trunc('hour', mts.ts) AS hour_bucket,
                   MAX(mts.ts) AS sample_ts,
                   {select_sql}
            FROM machine_timeseries mts
            {where_sql} {ids_filter_sql}
            GROUP BY mts.machine_id, hour_bucket
            ORDER BY mts.machine_id, hour_bucket ASC
            """,
            params,
        )
        rows = await _fetchall(cur)
        logger.info("chatbot.current.kpi.hourly.assets rows=%d", len(rows))
        if len(rows) > MAX_ROWS:
            notes.append("Too many hourly rows; falling back to daily aggregates.")
            logger.info("chatbot.current.kpi.hourly.assets fallback_to_daily rows=%d", len(rows))
            params_daily = dict(params)
            await _exec(
                cur,
                f"""
                SELECT mts.machine_id,
                       MAX(mts.ts) AS sample_ts,
                       {select_sql}
                FROM machine_timeseries mts
                {where_sql} {ids_filter_sql}
                GROUP BY mts.machine_id
                """,
                params_daily,
            )
            rows_daily = await _fetchall(cur)
            meta = await _fetch_assets_meta(cur, machine_id or [])
            assets: List[SingleAssetPayload] = []
            for r in rows_daily:
                rm = _row_to_map(cur, r)
                m_id = str(rm.get("machine_id"))
                sample_ts = rm.get("sample_ts")
                sample_ts = local_iso(sample_ts)
                kpis_out: Dict[str, KPIGroup] = {}
                kpis_display: Dict[str, KPITimeDisplay] = {}
                for group_key, gcols in group_cols.items():
                    data = {k: rm.get(k) for k in gcols}
                    kpis_out[group_key] = KPIGroup.model_validate(_rename_keys_for_output(group_key, data))
                    if group_key == "time":
                        disp = _apply_time_format(kpis_out[group_key].model_dump(), "hhmmss", renamed_time_keys)
                        disp = _fmt_util_rate_for_display(disp)
                        kpis_display["time"] = KPITimeDisplay.model_validate(disp)
                assets.append(
                    SingleAssetPayload(
                        machine_id=m_id,
                        name=(meta.get(m_id) or {}).get("name"),
                        sample_ts=sample_ts,
                        kpis=kpis_out,
                        kpis_display=kpis_display or None,
                        aggregation=AggregationInfo(basis=window, rows_used=len(rows), fallback=True),
                    )
                )
            return CurrentResponse(context=ctx, notes=notes, assets=assets)

        # summarize by last hour per machine
        by_machine: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            rm = _row_to_map(cur, r)
            by_machine[str(rm.get("machine_id"))] = rm  # last row per machine

        logger.info("chatbot.current.kpi.hourly.assets summarized count=%d", len(by_machine))
        meta = await _fetch_assets_meta(cur, list(by_machine.keys()))
        assets: List[SingleAssetPayload] = []
        for m_id, rm in by_machine.items():
            sample_ts = rm.get("sample_ts")
            sample_ts = local_iso(sample_ts)
            kpis_out: Dict[str, KPIGroup] = {}
            kpis_display: Dict[str, KPITimeDisplay] = {}
            for group_key, gcols in group_cols.items():
                data = {k: rm.get(k) for k in gcols}
                kpis_out[group_key] = KPIGroup.model_validate(_rename_keys_for_output(group_key, data))
                if group_key == "time":
                    disp = _apply_time_format(kpis_out[group_key].model_dump(), "hhmmss", renamed_time_keys)
                    disp = _fmt_util_rate_for_display(disp)
                    kpis_display["time"] = KPITimeDisplay.model_validate(disp)
            assets.append(
                SingleAssetPayload(
                    machine_id=m_id,
                    name=(meta.get(m_id) or {}).get("name"),
                    sample_ts=sample_ts,
                    kpis=kpis_out,
                    kpis_display=kpis_display or None,
                    aggregation=AggregationInfo(basis=window, rows_used=len(rows), fallback=False),
                )
            )
        return CurrentResponse(context=ctx, notes=notes, assets=assets)


# --- Historical endpoint -----------------------------------------------------

from dateutil.relativedelta import relativedelta


@router.get("/machines/history")
async def machines_history(
    request_scope: str = Query(..., pattern="^(single_assets|overall)$"),
    interest_type: str = Query(..., pattern="^(time|energy_and_cost|production|efficiency)$"),
    time_granularity: str = Query("aggregate", pattern="^(aggregate|daily|weekly|monthly)$"),
    machine_id: Optional[List[str]] = Query(None, description="repeatable machine ids"),
    timerange: str = Query(..., pattern="^(yesterday|this_week|last_week|this_month|last_month|last_trimester|last_semester|this_year|custom)$"),
    custom_start: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive), required if timerange=custom"),
    custom_end: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive), required if timerange=custom"),
    tz: str = Query("Europe/Rome"),
    cur = Depends(with_cursor),
):
    """
    Historical aggregates/time series over a chosen window.
    Returns either:
      - aggregate over the full window, or
      - per-day/week/month series.
    """
    logger.info(
        "chatbot.history.params scope=%s interest=%s granularity=%s timerange=%s tz=%s machine_ids=%s",
        request_scope, interest_type, time_granularity, timerange, tz,
        None if not machine_id else f"{len(machine_id)} ids"
    )

    if request_scope == "single_assets" and not machine_id:
        raise HTTPException(status_code=400, detail="machine_id is required for single_assets")
    if request_scope == "overall" and machine_id:
        machine_id = None  # ignore list

    # columns to fetch
    group_cols = _interest_to_cols(interest_type)
    cols = [c for cols in group_cols.values() for c in cols]

    # Map original time columns -> renamed JSON keys used in the 'time' group
    renamed_time_keys = {
        c: list(_rename_keys_for_output("time", {c: 0}).keys())[0]
        for c in _TIME_SEC_FIELDS
        if any(c in v for v in group_cols.values())
    }

    # window
    start_utc, end_utc = _history_window_utc(timerange, custom_start, custom_end)
    
    # --- clamp to experiment 'now' so we never go past 11:30 local ---
    exp_now = experiment_now_utc()
    if end_utc > exp_now:
        logger.info(
            "chatbot.history.bounds clamped end_utc from %s to experiment_now %s",
            end_utc.isoformat(), exp_now.isoformat()
        )
        end_utc = exp_now
    logger.info("chatbot.history.bounds start_utc=%s end_utc=%s", start_utc.isoformat(), end_utc.isoformat())


    ids_filter_sql = "" if (request_scope == "overall" or not machine_id) else "AND mts.machine_id = ANY(%(ids)s)"

    # aggregation policy
    agg_map_sum = {
        "working_time", "idle_time", "offline_time", "alarm_time",
        "consumption_total", "consumption_working", "consumption_idle",
        "cycles", "good_cycles", "bad_cycles",
    }
    agg_map_avg = {"oee", "quality", "performance", "availability", "avg_cycle_time", "avg_cycle_cost", "power", "cost", "utilization_rate"}

    def _select_parts(selected_cols: List[str]) -> List[str]:
        parts = []
        for c in selected_cols:
            if c in agg_map_sum:
                parts.append(f"SUM(mts.{c}) AS {c}")
            elif c in agg_map_avg:
                parts.append(f"AVG(mts.{c}) AS {c}")
            else:
                parts.append(f"AVG(mts.{c}) AS {c}")
        return parts

    where_sql = "WHERE mts.ts >= %(start)s AND mts.ts < %(end)s"
    params: Dict[str, Any] = {"start": start_utc, "end": end_utc}
    if ids_filter_sql:
        params["ids"] = machine_id

    # aggregate over full window
    if time_granularity == "aggregate":
        select_sql = ", ".join(_select_parts(cols))

        if request_scope == "overall":
            await _exec(
                cur,
                f"""
                SELECT {select_sql}
                FROM machine_timeseries mts
                {where_sql}
                """,
                params,
            )
            row = await _fetchone(cur)
            kpis_out: Dict[str, float] = {}
            kpis_display: Dict[str, Dict[str, Optional[str]]] = {}
            if row:
                rm = _row_to_map(cur, row)
                all_null = all(rm.get(c) is None for c in cols)
                notes = [] if not all_null else ["No data available in the requested window."]

                for group_key, gcols in group_cols.items():
                    data = {k: rm.get(k) for k in gcols}
                    grp = _rename_keys_for_output(group_key, data)
                    kpis_out[group_key] = grp  # numeric dict
                    if group_key == "time":
                        disp = _apply_time_format(grp, "hhmmss", renamed_time_keys)
                        kpis_display["time"] = disp
            else:
                notes = ["No data available in the requested window."]

            return {
                "context": {
                    "timerange": timerange,
                    "custom": [custom_start, custom_end] if timerange == "custom" else None,
                    "tz": tz,
                    "time_granularity": time_granularity,
                    "window_start": local_iso(start_utc),
                    "window_end": local_iso(end_utc),
                },
                "notes": notes,
                "assets": None,
                "overall": {
                    "aggregate": True,
                    "kpis": kpis_out if row else {},
                    "kpis_display": kpis_display or None,
                },
            }

        # single_assets aggregate
        await _exec(
            cur,
            f"""
            SELECT mts.machine_id, {", ".join(_select_parts(cols))}
            FROM machine_timeseries mts
            {where_sql} {ids_filter_sql}
            GROUP BY mts.machine_id
            """,
            params,
        )
        rows = await _fetchall(cur)
        meta = await _fetch_assets_meta(cur, machine_id or [])
        assets = []
        notes = []
        for r in rows or []:
            rm = _row_to_map(cur, r)
            m_id = str(rm.get("machine_id"))
            kpis_out: Dict[str, float] = {}
            kpis_display: Dict[str, Dict[str, Optional[str]]] = {}
            for group_key, gcols in group_cols.items():
                data = {k: rm.get(k) for k in gcols}
                grp = _rename_keys_for_output(group_key, data)
                kpis_out[group_key] = grp
                if group_key == "time":
                    disp = _apply_time_format(grp, "hhmmss", renamed_time_keys)
                    kpis_display["time"] = disp
            assets.append({
                "machine_id": m_id,
                "name": (meta.get(m_id) or {}).get("name"),
                "aggregate": True,
                "kpis": kpis_out,
                "kpis_display": kpis_display or None,
            })
        if not rows:
            notes.append("No data available in the requested window.")
        return {
            "context": {
                "timerange": timerange,
                "custom": [custom_start, custom_end] if timerange == "custom" else None,
                "tz": tz,
                "time_granularity": time_granularity,
                "window_start": start_utc.isoformat(),
                "window_end": end_utc.isoformat(),
            },
            "notes": notes,
            "assets": assets,
            "overall": None,
        }

    # -------------------- Time series (daily/weekly/monthly) --------------------
    if time_granularity in ("daily", "weekly", "monthly"):
        logger.info("chatbot.history.series start granularity=%s", time_granularity)

        bucket_expr_map = {
            "daily":   ("date_trunc('day', mts.ts)",   "date"),
            "weekly":  ("date_trunc('week', mts.ts)",  "week"),
            "monthly": ("date_trunc('month', mts.ts)", "month"),
        }
        bucket_sql, bucket_key = bucket_expr_map[time_granularity]
        select_sql = ", ".join(_select_parts(cols))

        # ---- OVERALL series
        if request_scope == "overall":
            await _exec(
                cur,
                f"""
                SELECT {bucket_sql} AS bucket,
                       {select_sql}
                FROM machine_timeseries mts
                {where_sql}
                GROUP BY bucket
                ORDER BY bucket ASC
                """,
                params,
            )
            rows = await _fetchall(cur)
            logger.info("chatbot.history.series.overall rows=%d granularity=%s", len(rows or []), time_granularity)

            series = []
            for r in rows or []:
                rm = _row_to_map(cur, r)
                b = rm.get("bucket")
                b_iso = b.date().isoformat() if hasattr(b, "date") else str(b)
                point: Dict[str, Any] = {"bucket": b_iso, bucket_key: b_iso}

                # numeric groups
                for group_key, gcols in group_cols.items():
                    data = {k: rm.get(k) for k in gcols}
                    grp = _rename_keys_for_output(group_key, data)
                    point[group_key] = grp
                    # formatted time as sibling group
                    if group_key == "time":
                        point["time_display"] = _apply_time_format(grp, "hhmmss", renamed_time_keys)

                series.append(point)

            notes = [] if series else ["No data available in the requested window."]
            return {
                "context": {
                    "timerange": timerange,
                    "custom": [custom_start, custom_end] if timerange == "custom" else None,
                    "tz": tz,
                    "time_granularity": time_granularity,
                    "window_start": start_utc.isoformat(),
                    "window_end": end_utc.isoformat(),
                },
                "notes": notes,
                "assets": None,
                "overall": {
                    "aggregate": False,
                    "granularity": time_granularity,
                    "series": series,
                },
            }

        # ---- SINGLE ASSETS series
        await _exec(
            cur,
            f"""
            SELECT mts.machine_id,
                   {bucket_sql} AS bucket,
                   {select_sql}
            FROM machine_timeseries mts
            {where_sql} {ids_filter_sql}
            GROUP BY mts.machine_id, bucket
            ORDER BY mts.machine_id, bucket ASC
            """,
            params,
        )
        rows = await _fetchall(cur)
        logger.info("chatbot.history.series.assets rows=%d granularity=%s", len(rows or []), time_granularity)

        by_machine: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows or []:
            rm = _row_to_map(cur, r)
            m_id = str(rm.get("machine_id"))
            b = rm.get("bucket")
            b_iso = b.date().isoformat() if hasattr(b, "date") else str(b)

            point: Dict[str, Any] = {"bucket": b_iso, bucket_key: b_iso}
            for group_key, gcols in group_cols.items():
                data = {k: rm.get(k) for k in gcols}
                grp = _rename_keys_for_output(group_key, data)
                point[group_key] = grp
                if group_key == "time":
                    point["time_display"] = _apply_time_format(grp, "hhmmss", renamed_time_keys)

            by_machine.setdefault(m_id, []).append(point)

        meta = await _fetch_assets_meta(cur, list(by_machine.keys()))
        assets = [{
            "machine_id": m_id,
            "name": (meta.get(m_id) or {}).get("name"),
            "aggregate": False,
            "granularity": time_granularity,
            "series": points
        } for m_id, points in by_machine.items()]

        notes = [] if assets else ["No data available in the requested window."]
        return {
            "context": {
                "timerange": timerange,
                "custom": [custom_start, custom_end] if timerange == "custom" else None,
                "tz": tz,
                "time_granularity": time_granularity,
                "window_start": start_utc.isoformat(),
                "window_end": end_utc.isoformat(),
            },
            "notes": notes,
            "assets": assets,
            "overall": None,
        }
