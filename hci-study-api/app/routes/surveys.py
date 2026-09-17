from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.types.json import Jsonb
import json
from typing import Dict, Any
from datetime import datetime, timezone
import re
from collections import Counter
import logging

from ..db import with_cursor, assert_open_session
from .deps import require_session
from ..schemas import (
    TaskPrimeRequest, TaskPrimeResponse, TaskResponse, TaskStartRequest, TaskStartResponse, TaskTimeoutResponse, QuestionnaireBatch, AttentionEventIn, AttentionLogIn, BonusIn
)
from ..services.surveys_utils import (
    _utcnow_ms,
    DEFAULT_PREWARN,
    DEFAULT_GRACE,
    DEFAULT_FALLBACK_BUDGET,
    task_code_defaults,  
    score_answer,
    _norm,
    _jaccard,
    _load_form,
    _compute_flags,
    _QN_START,
    _QN_END,
)
from ..security import require_write_token



router = APIRouter(prefix="", tags=["responses"])
logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

def _to_bool(x: Any) -> bool:
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        return bool(x)
    if isinstance(x, str):
        s = x.strip().lower()
        return s in ("true", "1", "yes", "y", "t")
    return bool(x)


# -------------------------------------------------------------------
# Task start: record server-authoritative started_at and return times
# -------------------------------------------------------------------
@router.post("/tasks/{task_code}/prime", response_model=TaskPrimeResponse)
async def prime_task(
    task_code: str,
    body: TaskPrimeRequest,
    auth=Depends(require_session),
    cur=Depends(with_cursor),
):
    pid = auth["participant_id"]
    sid = auth["session_id"]

    # Pull per-task defaults (for complexity etc.)
    td = task_code_defaults(task_code)
    complexity = int(body.complexity) if body.complexity is not None else td["complexity"]

    # server-authoritative "reading seen" timestamp
    reading_seen_at = datetime.now(tz=timezone.utc)
    reading_seen_at_ms = int(reading_seen_at.timestamp() * 1000)
    server_now_ms = _utcnow_ms()

  
    meta = Jsonb({
        "reading_seen_at_ms": reading_seen_at_ms,
        "client_render_ms": body.client_render_ms,
    })

    await cur.execute(
        """
        INSERT INTO task_responses
          (participant_id, session_id, task_code, complexity, status,
           started_at, ended_at, duration_ms, accuracy_score, answer, metadata)
        VALUES (%s,%s,%s,%s,'aborted',%s,NULL,NULL,NULL,NULL,%s)
        ON CONFLICT (participant_id, task_code) DO UPDATE SET
          complexity = COALESCE(task_responses.complexity, EXCLUDED.complexity),
          started_at = LEAST(task_responses.started_at, EXCLUDED.started_at),
          metadata   = jsonb_strip_nulls(COALESCE(task_responses.metadata,'{}'::jsonb) || EXCLUDED.metadata)
        ;
        """,
        (str(pid), str(sid), task_code, complexity, reading_seen_at, meta),
    )

    return TaskPrimeResponse(server_now_ms=server_now_ms, reading_seen_at_ms=reading_seen_at_ms)
# -------------------------------------------------------------------
# Start task: lock in started_at, compute ends_at
@router.post("/tasks/{task_code}/start", response_model=TaskStartResponse)
async def start_task(
    task_code: str,
    body: TaskStartRequest = TaskStartRequest(),
    auth=Depends(require_session),
    cur=Depends(with_cursor),
):
    pid = auth["participant_id"]
    sid = auth["session_id"]

     # 1) Pull per-task defaults
    td = task_code_defaults(task_code)

    # 2) Body values override per-task defaults; otherwise use defaults
    budget_seconds = int(body.budget_seconds) if body.budget_seconds is not None else td["budget_seconds"]
    prewarn        = int(body.prewarn_lead_sec) if body.prewarn_lead_sec is not None else td["prewarn"]
    grace          = int(body.grace_seconds)    if body.grace_seconds    is not None else td["grace"]
    complexity     = int(body.complexity)       if body.complexity       is not None else td["complexity"]

    # server-authoritative times
    started_at = datetime.now(tz=timezone.utc)
    ends_at = started_at.timestamp() + budget_seconds
    server_now_ms = _utcnow_ms()
    started_at_ms = int(started_at.timestamp() * 1000)
    ends_at_ms = int(ends_at * 1000)

    # Upsert a provisional row (status='aborted') to lock in started_at
    await cur.execute(
        """
        INSERT INTO task_responses
          (participant_id, session_id, task_code, complexity, status,
           started_at, ended_at, duration_ms, accuracy_score, answer, metadata)
        VALUES (%s,%s,%s,%s,'aborted',%s,NULL,NULL,NULL,NULL,
                jsonb_build_object('prewarn_lead_sec', %s, 'grace_seconds', %s, 'budget_seconds', %s))
        ON CONFLICT (participant_id, task_code) DO UPDATE SET
          complexity = EXCLUDED.complexity,
          status = 'aborted',
          started_at = EXCLUDED.started_at,
          ended_at = NULL,
          duration_ms = NULL,
          accuracy_score = NULL,
          answer = NULL,
          metadata = jsonb_strip_nulls(
              COALESCE(task_responses.metadata, '{}'::jsonb) || EXCLUDED.metadata
          )
        ;
        """,
        (str(pid), str(sid), task_code, complexity, started_at, prewarn, grace, budget_seconds),
    )

    # Fetch metadata to see if we have a reading timestamp
    await cur.execute(
        "SELECT metadata FROM task_responses WHERE participant_id=%s AND task_code=%s LIMIT 1",
        (str(pid), task_code),
    )
    row = await cur.fetchone()
    meta = (row.get("metadata") if hasattr(row, "get") else getattr(row, "metadata", None))
    reading_ms = None

    if isinstance(meta, dict):
        rs = meta.get("reading_seen_at_ms")
        if isinstance(rs, int) and rs > 0:
            reading_ms = max(0, started_at_ms - rs)
            await cur.execute(
                """
                UPDATE task_responses
                SET metadata = jsonb_strip_nulls(
                        COALESCE(metadata,'{}'::jsonb) || %s
                    )
                WHERE participant_id=%s AND task_code=%s
                """,
                (Jsonb({"reading_ms": int(reading_ms)}), str(pid), task_code),
            )

    return TaskStartResponse(
        server_now_ms=server_now_ms,
        started_at_ms=started_at_ms,
        ends_at_ms=ends_at_ms,
        prewarn_lead_sec=int(prewarn),
        grace_seconds=int(grace),
    )

# -------------------------------------------------------------------
# Submit task response (completed / overtime / skipped / aborted)
# * Ignores client clocks; uses server started_at + now() for duration.
# * Computes accuracy for completed & overtime (stub provided).
# -------------------------------------------------------------------
@router.post("/task-responses")
async def post_task_response(
    tr: TaskResponse,
    auth=Depends(require_session),
    cur=Depends(with_cursor),
):
    if tr.status not in ('completed', 'overtime', 'aborted', 'skipped'):
        raise HTTPException(400, detail={"code": "invalid_status"})

    pid = auth["participant_id"]
    sid = auth["session_id"]

    # Security: participant/session must match token; ignore client ids
    if getattr(tr, "participant_id", None) and str(tr.participant_id) != str(pid):
        raise HTTPException(403, detail={"code": "pid_mismatch"})
    if getattr(tr, "session_id", None) and (tr.session_id and str(tr.session_id) != str(sid)):
        raise HTTPException(403, detail={"code": "sid_mismatch"})

    # Load server-started_at (from /start); if absent, create a synthetic start now.
    await cur.execute(
        """
        SELECT started_at FROM task_responses
        WHERE participant_id=%s AND task_code=%s
        """,
        (str(pid), tr.task_code),
    )
    row = await cur.fetchone()
    now_utc = datetime.now(tz=timezone.utc)
    if row and row["started_at"]:
        started_at = row["started_at"]
    else:
        started_at = now_utc  # fallback
        # ensure row exists so ON CONFLICT below works predictably
        await cur.execute(
            """
            INSERT INTO task_responses
              (participant_id, session_id, task_code, complexity, status, started_at)
            VALUES (%s,%s,%s,%s,'aborted',%s)
            ON CONFLICT (participant_id, task_code) DO NOTHING
            """,
            (str(pid), str(sid), tr.task_code, tr.complexity, started_at),
        )

    ended_at = now_utc
    duration_ms = int((ended_at - started_at).total_seconds() * 1000)

    # Compute accuracy for completed and overtime (server-side scoring)
    #accuracy: float = 0.0
    if tr.status in ('completed', 'overtime'):
        accuracy = await score_answer(cur, tr.task_code, tr.answer)
        logger.info(
            "score answer received. User answer: %s, accuracy: %.3f",
            tr.answer,
            accuracy,
        )

    # If 'skipped', force answer to NULL
    answer_json = None if tr.status == 'skipped' else (Jsonb(tr.answer) if tr.answer is not None else None)

    await cur.execute(
        """
        INSERT INTO task_responses
          (participant_id, session_id, task_code, complexity, status,
           started_at, ended_at, duration_ms, accuracy_score, answer, metadata)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (participant_id, task_code) DO UPDATE SET
          complexity    = EXCLUDED.complexity,
          status        = EXCLUDED.status,
          -- keep original started_at that was locked at /start
          ended_at      = EXCLUDED.ended_at,
          duration_ms   = EXCLUDED.duration_ms,
          accuracy_score= EXCLUDED.accuracy_score,
          answer        = EXCLUDED.answer,
          metadata      = jsonb_strip_nulls(COALESCE(task_responses.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb))
        RETURNING id;
        """,
        (
            str(pid), str(sid), tr.task_code, tr.complexity, tr.status,
            started_at, ended_at, duration_ms, accuracy,
            answer_json,
            Jsonb(tr.metadata) if tr.metadata is not None else None,
        ),
    )
    rid = (await cur.fetchone())["id"]
    return {"response_id": rid}

# -------------------------------------------------------------------
# Timeout: finalize as 'skipped' only if not already submitted
# Idempotent: if the row is already completed/overtime/skipped, no change.
# -------------------------------------------------------------------
@router.post("/tasks/{task_code}/timeout", response_model=TaskTimeoutResponse)
async def timeout_task(
    task_code: str,
    auth=Depends(require_session),
    cur=Depends(with_cursor),
):
    pid = auth["participant_id"]
    sid = auth["session_id"]

    # finalize only if status is still 'aborted' (i.e., started but not submitted)
    await cur.execute(
        """
        UPDATE task_responses
           SET status='skipped',
               ended_at=now(),
               duration_ms = EXTRACT(EPOCH FROM (now() - started_at))::int * 1000
         WHERE participant_id=%s AND session_id=%s AND task_code=%s AND status='aborted'
     RETURNING id, status;
        """,
        (str(pid), str(sid), task_code),
    )
    row = await cur.fetchone()

    # If nothing updated, select existing row to return a consistent payload
    if not row:
        await cur.execute(
            "SELECT id, status FROM task_responses WHERE participant_id=%s AND task_code=%s",
            (str(pid), task_code),
        )
        row = await cur.fetchone()
        if not row:
            # If absolutely no row exists (edge), create a skipped record
            await cur.execute(
                """
                INSERT INTO task_responses
                  (participant_id, session_id, task_code, complexity, status, started_at, ended_at, duration_ms)
                VALUES (%s,%s,%s,%s,'skipped', now(), now(), 0)
                RETURNING id, status;
                """,
                (str(pid), str(sid), task_code, TASK_COMPLEXITY.get(task_code, 0)), #check TASK_COMPLEXITY
            )
            row = await cur.fetchone()

    return TaskTimeoutResponse(response_id=row["id"], status=row["status"])


# ---------- Questionnaire (batch-friendly) ----------
@router.post("/questionnaires/responses/batch")
async def post_questionnaire_batch(batch: QuestionnaireBatch, auth=Depends(require_session), cur=Depends(with_cursor)):
    logger.info("post_questionnaire_batch received: %d responses", len(batch.responses))
    if not batch.responses:
        return {"inserted": 0}

    pid = auth["participant_id"]
    sid = auth["session_id"]

    rows = []
    for r in batch.responses:
        rows.append((
            str(pid),                 # participant_id (from token)
            str(sid),                 # session_id (from token)
            getattr(r, 'task_code', None),
            r.questionnaire_name,
            r.item_key,
            r.value_numeric,
            r.value_text
        ))

    await cur.executemany("""
        INSERT INTO questionnaire_responses
          (participant_id, session_id, task_code, questionnaire_name, item_key, value_numeric, value_text, submitted_at)
        VALUES (%s,%s,COALESCE(%s, ''),%s,%s,%s,%s,now())
        ON CONFLICT (participant_id, questionnaire_name, item_key, task_code) DO UPDATE SET
          value_numeric=EXCLUDED.value_numeric,
          value_text=EXCLUDED.value_text,
          submitted_at=questionnaire_responses.submitted_at;
    """, rows)

    return {"inserted": len(rows)}


# ---------- Prescreen scoring ----------
@router.post("/prescreen/summary")
async def post_prescreen_summary(auth=Depends(require_session), cur=Depends(with_cursor)):
    """
    Compute prescreen label from stored questionnaire responses (start/end if available),
    then persist {prescreen_label, prescreen_notes} on participants.
    """
    pid = str(auth["participant_id"])

    # Load start + end
    start = await _load_form(cur, pid, _QN_START)
    end   = await _load_form(cur, pid, _QN_END)

    if not start and not end:
        # Nothing to score yet
        return {"updated": False, "reason": "no prescreen answers found"}

    ind_ok_s, rol_ok_s, rsp_ok_s, snap_s = _compute_flags(start)
    ind_ok_e, rol_ok_e, rsp_ok_e, snap_e = _compute_flags(end)

    # Use END if present, otherwise START for the label
    use_end = end is not None
    ind_ok  = ind_ok_e if use_end else ind_ok_s
    rol_ok  = rol_ok_e if use_end else rol_ok_s
    rsp_ok  = rsp_ok_e if use_end else rsp_ok_s

    # Consistency (only if both present)
    inconsistent = False
    jaccard_resp = None
    if start and end:
        # exact for single-choice
        ind_cons = _norm(snap_s["industry"]) == _norm(snap_e["industry"])
        rol_cons = _norm(snap_s["industry_role"]) == _norm(snap_e["industry_role"])
        # Jaccard for multi
        jaccard_resp = _jaccard(snap_s["decision_responsibilities"], snap_e["decision_responsibilities"])
        resp_cons = (jaccard_resp is not None) and (jaccard_resp >= 2/3)  # 0.66…
        inconsistent = not (ind_cons and rol_cons and resp_cons)

    # Label
    if (not ind_ok) or (not rol_ok) or (not rsp_ok):
        label = "exclude"   # screen out if any fail
    else:
        label = "pass"

    notes = {
        "start": snap_s,
        "end": snap_e if end else None,
        "calc": {
            "industry_ok": ind_ok,
            "role_ok": rol_ok,
            "resp_ok": rsp_ok,
            "inconsistent": inconsistent,
            "jaccard_resp": jaccard_resp,
            "used_phase": "end" if use_end else "start",
            "last_updated": datetime.now(timezone.utc).isoformat()
        }
    }

    await cur.execute("""
        UPDATE participants
        SET prescreen_label = %s,
            prescreen_notes = %s
        WHERE id = %s
        RETURNING id
    """, (label, Jsonb(notes), pid))
    _ = await cur.fetchone()

    logger.info("prescreen summary updated for pid=%s: label=%s (ind_ok=%s, rol_ok=%s, rsp_ok=%s, inconsistent=%s)",
                pid, label, ind_ok, rol_ok, rsp_ok, inconsistent)
    
    # Early-stop pattern like /attention
    if label == "exclude":
        try:
            await cur.connection.commit()  # persist even if we raise
        except Exception:
            pass
        raise HTTPException(
            status_code=403,
            detail={
                "code": "prescreen_excluded",
                "industry_ok": ind_ok,
                "role_ok": rol_ok,
                "resp_ok": rsp_ok,
                "used_phase": "end" if use_end else "start",
            },
        )
    


    return {
        "updated": True,
        "participant_id": pid,
        "prescreen_label": label,
        "industry_ok": ind_ok,
        "role_ok": rol_ok,
        "resp_ok": rsp_ok,
        "inconsistent": inconsistent,
        "jaccard_resp": jaccard_resp,
    }


# ----------- Attention checks (IMC) ----------

def _score_imc(label: str, response: Any) -> bool:
    """
    Return True if the attention item is passed, based solely on label+response.
    Fall back to True for unknown/non-scored labels.
    """
    # normalize response to a simple string token
    r = (response or "").strip().lower() if isinstance(response, str) else response

    if label == "banana_check":          # simple attention check
        return r == "banana"

    if label == "bogus_statement_likert":      # IMC1
        # disagree or strongly disagree passes
        return r in ("d", "sd")

    if label == "triangle_check":              # IMC2
        return r == "triangle"

    # Unknown/other attention events: treat as non-scored (pass)
    return True

@router.post("/attention")
async def post_attention_summary(payload: AttentionLogIn,
                                 auth=Depends(require_session),
                                 cur=Depends(with_cursor)):
    pid = auth["participant_id"]
    now_iso = datetime.now(timezone.utc).isoformat()

    # 1) Lock + load row
    await cur.execute("""
        SELECT attention_notes
        FROM participants
        WHERE id = %s
        FOR UPDATE
    """, (str(pid),))
    row = await cur.fetchone()
    existing: Dict[str, Any] = (row["attention_notes"] or {}) if row else {}

    # 2) Merge events (dedup by id), but compute 'passed' SERVER-SIDE
    existing_events: Dict[str, Dict[str, Any]] = {}
    for ev in (existing.get("events") or []):
        if isinstance(ev, dict) and "id" in ev:
            ev_norm = dict(ev)
            # Re-score old events from stored response/label
            ev_norm["passed"] = _score_imc(str(ev_norm.get("label", "")), ev_norm.get("response"))
            existing_events[str(ev["id"])] = ev_norm

    for ev in payload.events:
        server_passed = _score_imc(ev.label, ev.response)
        existing_events[ev.id] = {
            "id": ev.id,
            "page": ev.page,
            "label": ev.label,
            "passed": server_passed,   # <— ignore client-provided 'passed'
            "response": ev.response,
            "ts": ev.ts,
        }

    merged_events = list(existing_events.values())

    # 3) Recompute on server (ignore client-provided fails/shown)
    prev_summary = existing.get("summary") or {}
    prev_fails = int(prev_summary.get("fails") or 0)

    # Only count scored items (where _score_imc may return True/False); by construction all have boolean passed
    fails = sum(1 for ev in merged_events if not bool(ev.get("passed", True)))
    shown = len(merged_events)
    passed = fails < 2  # keep your threshold

    # 4) Build merged notes (unchanged)
    summary = {
        "shown": shown,
        "fails": fails,
        "adaptive_shown": bool(payload.adaptive_shown),
        "screened_out": not passed,
        "last_updated": now_iso,
    }
    notes: Dict[str, Any] = {
        **({k: v for k, v in existing.items() if k not in ("events", "summary")}),
        "events": merged_events,
        "summary": summary,
    }
    if payload.notes:
        notes["extra"] = {**(existing.get("extra") or {}), **payload.notes}

    # 5) Persist updates
    await cur.execute("""
        UPDATE participants
        SET attention_passed = %s,
            attention_notes  = %s
        WHERE id = %s
        RETURNING id
    """, (passed, Jsonb(notes), str(pid)))
    _ = await cur.fetchone()

    # 6) If threshold newly crossed, raise 403 after writing
    if prev_fails < 2 and fails >= 2:
        try:
            await cur.connection.commit()  # ensure persistence even if exception triggers rollback
        except Exception:
            pass
        raise HTTPException(
            status_code=403,
            detail={"code": "attention_threshold_reached", "fails": fails, "shown": shown},
        )

    logger.info("attention summary updated for pid=%s (fails=%s, passed=%s, events=%d)",
                pid, fails, passed, len(merged_events))

    return {
        "updated": True,
        "participant_id": str(pid),
        "attention_passed": passed,
        "events_total": len(merged_events),
        "fails": fails,
        "shown": shown,
    }



# ---------- Comprehension checks ----------

def _json_maybe(x: Any) -> Any:
    if isinstance(x, str):
        try:
            return json.loads(x)
        except Exception:
            return x
    return x

def _score_cc(label: str, response: Any) -> bool:
    lab = (label or "").strip().lower()
    r = _json_maybe(response)

    if lab == "tlx_performance_direction":
        if isinstance(r, dict):
            r = r.get("ccPerf")
        return r == "higher_worse"

    if lab == "reliance_comprehension":
        if isinstance(r, dict):
            r = r.get("ccRel")
        return r == "both"

    return True

def _cc_base_id(eid: str) -> str:
    return re.sub(r'_a[12]$', '', str(eid))

@router.post("/comprehension")
async def post_comprehension_summary(payload: AttentionLogIn,
                                     auth=Depends(require_session),
                                     cur=Depends(with_cursor)):
    pid = auth["participant_id"]
    now_iso = datetime.now(timezone.utc).isoformat()

    # 1) Lock + load row
    await cur.execute("""
        SELECT comprehension_notes
        FROM participants
        WHERE id = %s
        FOR UPDATE
    """, (str(pid),))
    row = await cur.fetchone()
    existing: Dict[str, Any] = (row["comprehension_notes"] or {}) if row else {}

    # 2) Merge events (dedup by id), but compute 'passed' SERVER-SIDE
    existing_events: Dict[str, Dict[str, Any]] = {}
    for ev in (existing.get("events") or []):
        if isinstance(ev, dict) and "id" in ev:
            ev_norm = dict(ev)
            ev_norm["passed"] = _score_cc(str(ev_norm.get("label", "")), ev_norm.get("response"))
            existing_events[str(ev["id"])] = ev_norm

    for ev in payload.events:
        server_passed = _score_cc(ev.label, ev.response)
        existing_events[ev.id] = {
            "id": ev.id,
            "page": ev.page,
            "label": ev.label,
            "passed": server_passed,   # ignore client-passed
            "response": ev.response,
            "ts": ev.ts,
        }

    merged_events = list(existing_events.values())

    # 3) Recompute summary on server
    prev_summary = existing.get("summary") or {}
    prev_max_fails = int(prev_summary.get("max_fails_one_check") or 0)

    fails_total = sum(1 for ev in merged_events if not bool(ev.get("passed", True)))
    shown = len(merged_events)

    fails_by_check = Counter(
        _cc_base_id(ev.get("id"))
        for ev in merged_events
        if not bool(ev.get("passed", True))
    )
    max_fails_one_check = max(fails_by_check.values(), default=0)

    # policy rule: screen out only if ANY single CC has 2 fails
    passed = max_fails_one_check < 2

    summary = {
        "shown": shown,
        "fails_total": fails_total,                 # keep for debugging
        "max_fails_one_check": max_fails_one_check, # used for enforcement
        "fails_by_check": dict(fails_by_check),     # optional but very useful
        "adaptive_shown": bool(payload.adaptive_shown),
        "screened_out": not passed,
        "last_updated": now_iso,
    }

    notes: Dict[str, Any] = {
        **({k: v for k, v in existing.items() if k not in ("events", "summary")}),
        "events": merged_events,
        "summary": summary,
    }
    if payload.notes:
        notes["extra"] = {**(existing.get("extra") or {}), **payload.notes}

    # 4) Persist updates
    await cur.execute("""
        UPDATE participants
        SET comprehension_passed = %s,
            comprehension_notes  = %s
        WHERE id = %s
        RETURNING id
    """, (passed, Jsonb(notes), str(pid)))
    _ = await cur.fetchone()

    # 5) If threshold newly crossed, raise 403 after writing
    if prev_max_fails < 2 and max_fails_one_check >= 2:
        ...
        raise HTTPException(
            status_code=403,
            detail={
                "code": "comprehension_threshold_reached",
                "max_fails_one_check": max_fails_one_check,
                "fails_total": fails_total,
                "shown": shown
            },
        )


    logger.info(
    "comprehension summary updated pid=%s (fails_total=%s, max_fails_one_check=%s, passed=%s, events=%d)",
    pid, fails_total, max_fails_one_check, passed, len(merged_events)
    )


    return {
        "updated": True,
        "participant_id": str(pid),
        "comprehension_passed": passed,
        "events_total": len(merged_events),

        "fails": fails_total,
        "shown": shown,

        "max_fails_one_check": max_fails_one_check,
        "fails_by_check": dict(fails_by_check),
    }


# ---------- Bonuses (minimal ledger) ----------
@router.post("/bonuses")
async def create_bonus(b: BonusIn, request: Request, cur=Depends(with_cursor)):
    # If session_id provided, require ownership + token so only in-flow code can write
    if b.session_id:
        await assert_open_session(cur, str(b.participant_id), str(b.session_id))
        await require_write_token(request, cur, str(b.session_id))
    await cur.execute("""
        INSERT INTO bonuses (participant_id, session_id, task_code, reason, amount_minor)
        VALUES (%s,%s,%s,%s,%s)
        ON CONFLICT (participant_id, COALESCE(task_code,''), reason) DO NOTHING
        RETURNING id;
    """, (str(b.participant_id), str(b.session_id) if b.session_id else None, b.task_code, b.reason, b.amount_minor))
    row = await cur.fetchone()
    return {"bonus_id": row["id"] if row else None}
