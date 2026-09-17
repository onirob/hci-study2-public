# app/routers/telemetry.py
from fastapi import APIRouter, HTTPException, Request, Depends, Query
from app.db import with_cursor
import psycopg, logging, uuid
from app.schemas import BatchIn
from psycopg.types.json import Jsonb

router = APIRouter(prefix="/telemetry", tags=["telemetry"])
logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)


async def _resolve_session(body: BatchIn, request: Request, cur):
    token = request.headers.get("X-Session-Write-Token") or getattr(body, "write_token", None)
    if not token:
        raise HTTPException(401, detail={"code": "missing_token"})

    await cur.execute("""
        SELECT id, participant_id
          FROM sessions
         WHERE write_token=%s AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1;
    """, (token,))
    sess = await cur.fetchone()
    if not sess:
        raise HTTPException(403, detail={"code": "invalid_or_closed_token"})

    sid = sess["id"] if isinstance(sess, dict) else sess[0]
    pid = sess["participant_id"] if isinstance(sess, dict) else sess[1]

    # defense-in-depth
    if getattr(body, "session_id", None) and str(body.session_id) != str(sid):
        raise HTTPException(409, detail={"code": "session_id_mismatch"})
    if getattr(body, "participant_id", None) and str(body.participant_id) != str(pid):
        raise HTTPException(409, detail={"code": "participant_id_mismatch"})

    return pid, sid


def _payload_get(d, key):
    return d.get(key) if isinstance(d, dict) else None


def _parse_uuid_or_422(val, code: str):
    if val is None or val == "":
        return None
    try:
        return uuid.UUID(str(val))
    except Exception:
        raise HTTPException(422, detail={"code": code})


# ---------------- DASHBOARD (keep as-is) ----------------
@router.post("/dashboard/batch")
async def post_batch(body: BatchIn, request: Request, cur=Depends(with_cursor)):
    pid, sid = await _resolve_session(body, request, cur)
    events = body.events or []
    logger.info("Received telemetry batch (dashboard): %s events", len(events))

    rows = []
    for e in events:
        if not e.event_type:
            raise HTTPException(422, detail={"code": "event_type_required"})
        rows.append((
            str(pid),
            str(sid),
            body.task_code,
            e.event_type,
            e.target,
            e.client_ts_ms,
            e.t_perf_ms,
            e.seq,
            e.vp_w,
            e.vp_h,
            e.client_event_id,
            Jsonb(e.payload) if e.payload is not None else None,
        ))

    sql = """
    INSERT INTO public.dashboard_events
        (participant_id, session_id, task_code, event_type, target,
         client_ts_ms, t_perf_ms, seq, vp_w, vp_h, client_event_id, payload)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (participant_id, client_event_id)
      WHERE client_event_id IS NOT NULL
      DO NOTHING
    """
    try:
        if rows:
            await cur.executemany(sql, rows)
        return {"received": len(rows)}
    except psycopg.Error as e:
        logger.exception("dashboard_events insert failed: %s", getattr(e, "pgerror", str(e)))
        raise HTTPException(500, detail={"code": "db_error"})


# ---------------- UI (non-dashboard) ----------------
@router.post("/ui/batch")
async def post_ui_batch(
    body: BatchIn,
    request: Request,
    surface: str = Query(..., description="e.g. questionnaire|familiarization|intro"),
    route: str | None = Query(None, description="e.g. /nasa-tlx"),
    cur=Depends(with_cursor),
):
    pid, sid = await _resolve_session(body, request, cur)
    events = body.events or []
    logger.info("Received telemetry batch (ui): %s events (surface=%s route=%s)", len(events), surface, route)

    rows = []
    for e in events:
        if not e.event_type:
            raise HTTPException(422, detail={"code": "event_type_required"})

        # optional override from payload (if you want)
        p = e.payload if isinstance(e.payload, dict) else None
        ev_route = route or _payload_get(p, "route")

        rows.append((
            str(pid),
            str(sid),
            body.task_code,
            surface,
            ev_route,
            e.event_type,
            e.target,
            e.client_ts_ms,
            e.t_perf_ms,
            e.seq,
            e.vp_w,
            e.vp_h,
            e.client_event_id,
            Jsonb(e.payload) if e.payload is not None else None,
        ))

    sql = """
    INSERT INTO public.ui_events
        (participant_id, session_id, task_code, surface, route, event_type, target,
         client_ts_ms, t_perf_ms, seq, vp_w, vp_h, client_event_id, payload)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (participant_id, client_event_id)
      WHERE client_event_id IS NOT NULL
      DO NOTHING
    """
    try:
        if rows:
            await cur.executemany(sql, rows)
        return {"received": len(rows)}
    except psycopg.Error as e:
        logger.exception("ui_events insert failed: %s", getattr(e, "pgerror", str(e)))
        raise HTTPException(500, detail={"code": "db_error"})


# ---------------- CHATBOT UI EVENTS ----------------
@router.post("/chatbot/batch")
async def post_chatbot_batch(
    body: BatchIn,
    request: Request,
    conversation_id: str | None = Query(None, description="chat_conversations.id (uuid)"),
    cur=Depends(with_cursor),
):
    pid, sid = await _resolve_session(body, request, cur)
    events = body.events or []
    conv_uuid = _parse_uuid_or_422(conversation_id, "conversation_id_invalid") if conversation_id else None

    logger.info("Received telemetry batch (chatbot): %s events (conversation_id=%s)", len(events), conversation_id)

    rows = []
    for e in events:
        if not e.event_type:
            raise HTTPException(422, detail={"code": "event_type_required"})

        # allow payload to carry conversation_id per-event if you prefer
        p = e.payload if isinstance(e.payload, dict) else None
        ev_conv = conv_uuid or _parse_uuid_or_422(_payload_get(p, "conversation_id"), "conversation_id_invalid")

        rows.append((
            str(pid),
            str(sid),
            ev_conv,              # may be None
            body.task_code,
            e.event_type,
            e.target,
            e.client_ts_ms,
            e.t_perf_ms,
            e.seq,
            e.vp_w,
            e.vp_h,
            e.client_event_id,
            Jsonb(e.payload) if e.payload is not None else None,
        ))

    sql = """
    INSERT INTO public.chatbot_events
        (participant_id, session_id, conversation_id, task_code, event_type, target,
         client_ts_ms, t_perf_ms, seq, vp_w, vp_h, client_event_id, payload)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (participant_id, client_event_id)
      WHERE client_event_id IS NOT NULL
      DO NOTHING
    """
    try:
        if rows:
            await cur.executemany(sql, rows)
        return {"received": len(rows)}
    except psycopg.Error as e:
        logger.exception("chatbot_events insert failed: %s", getattr(e, "pgerror", str(e)))
        raise HTTPException(500, detail={"code": "db_error"})
