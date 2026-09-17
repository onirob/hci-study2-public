from fastapi import APIRouter, Depends, HTTPException, Request
import uuid
from psycopg.types.json import Jsonb
import logging
from decimal import Decimal

from ..db import with_cursor
from .deps import require_session
from ..schemas import (
    StartSession, EndSessionIn, SessionGuardOut
)

from ..security import require_write_token

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="/sessions", tags=["sessions"])

BONUS_THRESHOLD = Decimal("0.90")  # accuracy cutoff
# amounts in minor units (cents)
BONUS_REASON = f"accuracy>={BONUS_THRESHOLD:.2f}"

# ---------- Sessions ----------
@router.post("/start")
async def start_session(s: StartSession, cur=Depends(with_cursor)):
    # block returners
    await cur.execute("SELECT status FROM participants WHERE id=%s;", (str(s.participant_id),))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "participant not found")
    if row["status"] == "completed":
        raise HTTPException(403, "participant already completed")

    ## idempotent: return existing open session
    #await cur.execute("""
    #    SELECT id, write_token FROM sessions
    #    WHERE participant_id=%s AND ended_at IS NULL
    #    ORDER BY started_at DESC LIMIT 1;
    #""", (str(s.participant_id),))
    #open_row = await cur.fetchone()
    #if open_row:
    #    return {"session_id": open_row["id"], "write_token": open_row["write_token"]}
    
    # if an open session exists → hard stop (no resume token)
    await cur.execute("""
        SELECT 1 FROM sessions
        WHERE participant_id=%s AND ended_at IS NULL
        LIMIT 1;
    """, (str(s.participant_id),))
    if await cur.fetchone():
        raise HTTPException(409, detail={"code": "session_already_started"})
    
    # Mark participant as in_progress (idempotent)
    await cur.execute("""
        UPDATE participants
           SET status = 'in_progress',
               user_agent = COALESCE(user_agent, ''),  -- optional, fill if you pass it
               consented_at = consented_at  -- unchanged here
         WHERE id=%s AND status IN ('invited','in_progress')
         RETURNING status;
    """, (str(s.participant_id),))
    await cur.fetchone()  # ignore value; just ensure it ran


    # create new
    token = str(uuid.uuid4())
    #await cur.execute("""
    #    INSERT INTO sessions (participant_id, started_at, write_token)
    #    VALUES (%s,COALESCE(%s, now()),%s)
    #    RETURNING id, write_token;
    #""", (str(s.participant_id), s.started_at, token))
    #
    #row = await cur.fetchone()
    #if row is None:
    #    # someone else created it concurrently—fetch it
    #    await cur.execute("""
    #        SELECT id, write_token
    #        FROM sessions
    #        WHERE participant_id=%s AND ended_at IS NULL
    #        ORDER BY started_at DESC LIMIT 1;
    #    """, (str(s.participant_id),))
    #    row = await cur.fetchone()

    await cur.execute("""
        INSERT INTO sessions (participant_id, started_at, write_token)
        VALUES (%s, COALESCE(%s, now()), %s)
        RETURNING id, write_token;
    """, (str(s.participant_id), s.started_at, token))
    row2 = await cur.fetchone()

    return {"session_id": row2["id"], "write_token": row2["write_token"]}

@router.post("/end")
async def end_session(e: EndSessionIn, auth=Depends(require_session), cur=Depends(with_cursor)):
    """
    Close the current open session (idempotent) and update participant status.
    - Derives session_id/participant_id from the write token.
    - If e.session_id is sent and mismatches, reject.
    - final_status defaults to 'completed' (your policy: single uninterrupted run).
    - If final status is 'completed', award per-task bonuses by reading stored
      accuracies from task_responses (T1=€0.50, T2=€1.00, T3=€1.50, threshold=0.90).
    """
    pid = auth["participant_id"]
    sid = auth["session_id"]

    # Optional: reject mismatched session_id if the client sent one
    if e.session_id and str(e.session_id) != str(sid):
        raise HTTPException(403, detail={"code": "sid_mismatch"})

    # 1) End the session (idempotent: only if still open)
    await cur.execute("""
        UPDATE sessions
           SET ended_at = COALESCE(%s, now())
         WHERE id = %s
           AND ended_at IS NULL
        RETURNING ended_at;
    """, (e.ended_at, str(sid)))
    row = await cur.fetchone()
    # If row is None, the session was already ended earlier; fetch its ended_at for return
    if not row:
        await cur.execute("SELECT ended_at FROM sessions WHERE id=%s;", (str(sid),))
        row = await cur.fetchone()
    session_ended_at = (row["ended_at"] if isinstance(row, dict) else row[0]) if row else None

    # 2) participant status update (use booleans, not `%s IS NOT NULL`)
    final_status: str = e.final_status or "completed"
    is_completed = (final_status == "completed")
    is_rejected  = (final_status == "rejected")
    has_inelig_reason = bool(e.ineligible_reason)  # True only if non-empty string

    await cur.execute("""
        UPDATE participants
        SET status = %s,
            completed_at = CASE
                WHEN %s THEN COALESCE(completed_at, now())   -- is_completed
                ELSE completed_at
            END,
            eligibility_status = CASE
                WHEN %s AND %s THEN 'ineligible'             -- is_rejected AND has_inelig_reason
                ELSE eligibility_status
            END,
            ineligible_reason = COALESCE(%s, ineligible_reason),
            attention_passed  = COALESCE(%s, attention_passed),
            comprehension_passed = COALESCE(%s, comprehension_passed), 
            completion_code   = COALESCE(%s, completion_code)
        WHERE id = %s
    RETURNING status, completed_at, eligibility_status, ineligible_reason, attention_passed, comprehension_passed, completion_code;
    """, (
        final_status,
        is_completed,
        is_rejected, has_inelig_reason,
        e.ineligible_reason,
        e.attention_passed,
        e.comprehension_passed,
        e.completion_code,
        str(pid),
    ))
    prow = await cur.fetchone()
    if not prow:
        raise HTTPException(404, detail={"code": "participant_not_found"})

    bonuses_created = 0

    # 3) Award bonuses (completers-only), using stored accuracies from task_responses. Here you set the thresholds per task
    if is_completed:
        await cur.execute("""
            WITH rules(task_code, threshold, amount_minor) AS (
            VALUES
                ('T1', 0.95,  10),   -- £0.10 if accuracy ≥ 0.95
                ('T2', 0.95, 40),   -- £0.40 if accuracy ≥ 0.95
                ('T3', 0.90, 100)    -- £1 if accuracy ≥ 0.90
            ),
            elig AS (
            SELECT
                tr.participant_id,
                tr.session_id,
                tr.task_code,
                r.amount_minor,
                -- Build a stable, human-readable reason string per task/threshold
                CONCAT('accuracy>=', to_char(r.threshold::numeric, 'FM0.00')) AS reason_txt
            FROM task_responses tr
            JOIN rules r USING (task_code)
            WHERE tr.session_id = %s
                AND tr.status IN ('completed','overtime')
                AND tr.accuracy_score IS NOT NULL
                AND tr.accuracy_score >= r.threshold
            )
            INSERT INTO bonuses (participant_id, session_id, task_code, reason, amount_minor)
            SELECT e.participant_id, e.session_id, e.task_code, e.reason_txt, e.amount_minor
            FROM elig e
            ON CONFLICT (participant_id, COALESCE(task_code,''), reason) DO NOTHING
            RETURNING id;
        """, (str(sid),))
        rows = await cur.fetchall()
        bonuses_created = len(rows)

    # Fetch a detailed list of bonuses for this session (only the participant's own)
    await cur.execute("""
        SELECT task_code, amount_minor, reason, created_at
        FROM bonuses
        WHERE participant_id = %s AND session_id = %s
        ORDER BY created_at, task_code;
    """, (str(pid), str(sid)))
    bonus_rows = await cur.fetchall()

    def _row_get(r, k, idx):
        return r[k] if isinstance(r, dict) else r[idx]

    bonuses_detail = [{
        "task_code": _row_get(r, "task_code", 0),
        "amount_minor": int(_row_get(r, "amount_minor", 1) or 0),
        "amount_eur": float((_row_get(r, "amount_minor", 1) or 0) / 100.0),
        "reason": _row_get(r, "reason", 2),
        "created_at": (
            _row_get(r, "created_at", 3).isoformat()
            if _row_get(r, "created_at", 3) else None
        ),
    } for r in bonus_rows]


    # 4) Return a compact summary
    out = {
        "ok": True,
        "session_id": str(sid),
        "participant_id": str(pid),
        "session_ended_at": session_ended_at.isoformat() if session_ended_at else None,
        "participant_status": (prow["status"] if isinstance(prow, dict) else prow[0]),
        "completed_at": (prow["completed_at"] if isinstance(prow, dict) else prow[1]),
        "eligibility_status": (prow["eligibility_status"] if isinstance(prow, dict) else prow[2]),
        "ineligible_reason": (prow["ineligible_reason"] if isinstance(prow, dict) else prow[3]),
        "attention_passed": (prow["attention_passed"] if isinstance(prow, dict) else prow[4]),
        "comprehension_passed": (prow["comprehension_passed"] if isinstance(prow, dict) else prow[5]),
        "completion_code": (prow["completion_code"] if isinstance(prow, dict) else prow[5]),
        "bonuses_created": bonuses_created,
        "bonuses_detail": bonuses_detail, 
    }
    # normalize timestamps
    if isinstance(out["completed_at"], str):
        pass
    elif out["completed_at"]:
        out["completed_at"] = out["completed_at"].isoformat()
    return out


@router.get("/guard", response_model=SessionGuardOut)
async def session_guard(
    path: str | None = None,            # optional: page path for your own logs
    auth = Depends(require_session),
    cur = Depends(with_cursor),
):
    """
    Confirms the write token is valid and the session is still open.
    Returns a tiny snapshot the client can also cache.
    """
    pid = auth["participant_id"]
    sid = auth["session_id"]

    # Make sure participant still exists and hasn’t been force-completed/rejected
    await cur.execute("""
        SELECT status FROM participants WHERE id=%s LIMIT 1;
    """, (str(pid),))
    prow = await cur.fetchone()
    if not prow:
        raise HTTPException(404, detail={"code": "participant_not_found"})
    pstatus = prow["status"] if isinstance(prow, dict) else prow[0]
    if pstatus in ("completed", "rejected", "timed_out"):
        # Token could still be open if end flow crashed—treat as forbidden to continue
        raise HTTPException(403, detail={"code": "participant_closed_status", "status": pstatus})

    # Re-read minimal session info (guaranteed open by require_session)
    await cur.execute("""
        SELECT started_at, ended_at
          FROM sessions
         WHERE id=%s AND ended_at IS NULL
         LIMIT 1;
    """, (str(sid),))
    srow = await cur.fetchone()
    if not srow:
        # Shouldn’t happen if require_session passed, but keep this for race safety
        raise HTTPException(403, detail={"code": "invalid_or_closed_token"})

    started_at = srow["started_at"] if isinstance(srow, dict) else srow[0]
    ended_at   = srow["ended_at"]   if isinstance(srow, dict) else srow[1]

    return SessionGuardOut(
        ok=True,
        participant_id=str(pid),
        session_id=str(sid),
        participant_status=pstatus,
        session_started_at=started_at.isoformat() if started_at else None,
        session_ended_at=ended_at.isoformat() if ended_at else None,
    )