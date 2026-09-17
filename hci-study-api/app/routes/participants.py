from fastapi import APIRouter, Depends, HTTPException, Request
import uuid
from psycopg.types.json import Jsonb
import logging
from typing import Dict
import psycopg.errors

from ..db import with_cursor
from .deps import require_session
from ..config import settings
from ..utils import ip_hash
from ..schemas import (
    ConsentRegisterIn, CompleteIn, GroupAssignmentIn, ConsentDeclineIn,
)
from ..services.assignment import (
    BIASED_COIN_P, LIT_CUT1, LIT_CUT2, RFI_CUT1, RFI_CUT2,
    literacy_to_stratum, relative_fam_index, rfi_to_stratum,
    composite_stratum, choose_arm,
)
from ..security import require_write_token

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="", tags=["participants"])

def policy_forbidden(code: str) -> None:
    raise HTTPException(
        status_code=403,
        detail={"code": code},
        headers={"X-Policy-Code": code},
    )

# ---------- Participants ----------

@router.post("/participants/consent_decline")
async def consent_decline(p: ConsentDeclineIn, request: Request, cur=Depends(with_cursor)):
    h  = ip_hash(request)
    ua = request.headers.get("user-agent")

    # Insert or flip invited→rejected. Allow re-running if already rejected (idempotent).
    await cur.execute("""
        WITH upsert AS (
            INSERT INTO participants
                (prolific_pid, prolific_study_id, prolific_session_id,
                 ip_hash, user_agent, consent_version,
                 eligibility_status, ineligible_reason, status)
            VALUES (%(pid)s, %(study)s, %(sess)s,
                    %(ip)s, %(ua)s, %(consent_ver)s,
                    'ineligible', %(reason)s, 'rejected')
            ON CONFLICT (prolific_pid) DO UPDATE
                SET ip_hash = EXCLUDED.ip_hash,
                    user_agent = EXCLUDED.user_agent,
                    consent_version = EXCLUDED.consent_version,
                    eligibility_status = 'ineligible',
                    ineligible_reason = %(reason)s,
                    status = CASE
                        WHEN participants.status IN ('invited','rejected') THEN 'rejected'
                        ELSE participants.status
                    END
            RETURNING id, status, TRUE AS touched
        )
        SELECT id, status, TRUE AS touched FROM upsert
        UNION ALL
        SELECT id, status, FALSE AS touched
        FROM participants
        WHERE prolific_pid = %(pid)s
          AND NOT EXISTS (SELECT 1 FROM upsert);
    """, {
        "pid": p.prolific_pid,
        "study": p.prolific_study_id,
        "sess": p.prolific_session_id,
        "ip": h,
        "ua": ua,
        "consent_ver": p.consent_version,
        "reason": p.ineligible_reason,
    })
    row = await cur.fetchone()
    if not row:
        raise HTTPException(500, detail={"code": "unexpected_empty_upsert"})

    pid, status, touched = row["id"], row["status"], row["touched"]

    # Respect terminal/active states
    if status == "completed":
        policy_forbidden("completed")
    if status == "in_progress":
        policy_forbidden("already_in_progress")
    if status == "timed_out" and not touched:
        policy_forbidden("timed_out")

    # If here, we’re in 'rejected' (new or idempotent). Return the id to the FE.
    return {"participant_id": str(pid), "status": status}



@router.post("/participants/consent_register")
async def consent_register(p: ConsentRegisterIn, request: Request, cur=Depends(with_cursor)):
    h = ip_hash(request)
    ua = request.headers.get("user-agent")

    # One atomic upsert that:
    # - INSERTs a fresh participant as 'in_progress'
    # - If PID exists and is 'invited', promotes to 'in_progress' once
    # - If PID exists and is in other terminal/active states, returns the row untouched
    await cur.execute("""
        WITH upsert AS (
            INSERT INTO participants
                (prolific_pid, prolific_study_id, prolific_session_id,
                 ip_hash, user_agent, consented_at, consent_version,
                 eligibility_status, status)
            VALUES (%(pid)s, %(study)s, %(sess)s,
                    %(ip)s, %(ua)s, now(), %(consent_ver)s,
                    'eligible', 'in_progress')
            ON CONFLICT (prolific_pid) DO UPDATE
                SET ip_hash = EXCLUDED.ip_hash,
                    user_agent = EXCLUDED.user_agent,
                    consent_version = EXCLUDED.consent_version,
                    consented_at = COALESCE(participants.consented_at, now()),
                    eligibility_status = 'eligible',
                    status = CASE
                        WHEN participants.status = 'invited' THEN 'in_progress'
                        ELSE participants.status
                    END
            WHERE participants.status IN ('invited')
            RETURNING id, status, TRUE AS touched
        )
        SELECT id, status, TRUE AS touched FROM upsert
        UNION ALL
        SELECT id, status, FALSE AS touched
        FROM participants
        WHERE prolific_pid = %(pid)s
          AND NOT EXISTS (SELECT 1 FROM upsert);
    """, {
        "pid": p.prolific_pid,
        "study": p.prolific_study_id,
        "sess": p.prolific_session_id,
        "ip": h,
        "ua": ua,
        "consent_ver": p.consent_version,
    })

    row = await cur.fetchone()
    if not row:
        raise HTTPException(500, detail={"code": "unexpected_empty_upsert"})

    pid, status, touched = row["id"], row["status"], row["touched"]

    # Enforce your policy: no double sessions/reloads
    if status == "completed":
        raise HTTPException(403, detail={"code": "completed"})
    if status == "rejected":
        raise HTTPException(403, detail={"code": "rejected"})
    if status == "in_progress" and not touched:
        # Row already existed and we didn't touch it this time → duplicate submit
        raise HTTPException(403, detail={"code": "already_in_progress"})
    if status == "timed_out" and not touched:
        # Row already existed and we didn't touch it this time → duplicate submit
        raise HTTPException(403, detail={"code": "timed_out"})

    # Idempotent auth identity
    await cur.execute("""
        INSERT INTO auth_identities (participant_id, provider, identifier)
        VALUES (%s, 'prolific', %s)
        ON CONFLICT (provider, identifier) DO NOTHING;
    """, (pid, p.prolific_pid))

    return {"participant_id": str(pid)}

@router.post("/participants/complete")
async def complete(e: CompleteIn, cur=Depends(with_cursor)):
    await cur.execute("""
        UPDATE participants SET completed_at=now(), status='completed',
               completion_code = encode(gen_random_bytes(6), 'hex')
        WHERE id=%s
        RETURNING completion_code;
    """, (str(e.participant_id),))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "participant not found")
    return {"completion_code": row["completion_code"]}

@router.post("/participants/assign")
async def assign_group(a: GroupAssignmentIn, cur=Depends(with_cursor)):
    """
    Post-questionnaires assignment with RFI stratification.
    Server computes BDLI (1..7) and familiarity (0..6 each) from DB to avoid FE scale/order issues.
    """
    logger.info("assign_group received: %s", a.dict())

    # 0) Build counts by composite stratum = (literacy × RFI bin)
    await cur.execute(
        """
        SELECT
        CASE
            WHEN ga.data_lit_score IS NULL OR ga.data_lit_score <= %s THEN 'lit_low'
            WHEN ga.data_lit_score <= %s THEN 'lit_mid'
            ELSE 'lit_high'
        END AS lit_stratum,
        CASE
            WHEN COALESCE(ga.familiarity_index, 0.0) <= %s THEN 'fam_lean_chat'
            WHEN COALESCE(ga.familiarity_index, 0.0) <= %s THEN 'fam_neutral'
            ELSE 'fam_lean_dash'
        END AS fam_stratum,
        ga.interface_cond,
        COUNT(*)::int AS n
        FROM group_assignments ga
        JOIN participants p ON p.id = ga.participant_id
        WHERE p.status NOT IN ('rejected', 'timed_out')
        AND p.eligibility_status = 'eligible'
        AND p.prescreen_label <> 'exclude'
        GROUP BY 1, 2, 3
        """,
        (LIT_CUT1, LIT_CUT2, RFI_CUT1, RFI_CUT2),
    )
    rows = await cur.fetchall()
    counts: Dict[str, Dict[str, int]] = {}
    lit_levels  = ("lit_low", "lit_mid", "lit_high")
    fam_levels  = ("fam_lean_chat", "fam_neutral", "fam_lean_dash")
    for L in lit_levels:
        for F in fam_levels:
            counts[composite_stratum(L, F)] = {"chatbot": 0, "dashboard": 0}
    for row in rows:
        lit_s, fam_s, arm_val, n_val = (row["lit_stratum"], row["fam_stratum"], row["interface_cond"], int(row["n"])) if isinstance(row, dict) else (row[0], row[1], row[2], int(row[3]))
        counts[composite_stratum(lit_s, fam_s)]["chatbot" if arm_val == "chatbot" else "dashboard"] = n_val

    # 1) Recompute BDLI (1..5 mean) and familiarity from DB for this participant
    #    - BDLI: average across numeric items
    #    - TechFam per side: sum(use_3m + capability) → 0..6
    await cur.execute(
        """
        WITH bdli AS (
          SELECT ROUND(AVG(value_numeric)::numeric, 2) AS bdli_mean
          FROM questionnaire_responses
          WHERE participant_id = %s AND questionnaire_name = 'BDLI'
        ),
        tf AS (
          SELECT
            COALESCE(MAX(CASE WHEN item_key='dashboard.use_3m'     THEN value_numeric END), 0) +
            COALESCE(MAX(CASE WHEN item_key='dashboard.capability' THEN value_numeric END), 0) AS f_dash,
            COALESCE(MAX(CASE WHEN item_key='chatbot.use_3m'       THEN value_numeric END), 0) +
            COALESCE(MAX(CASE WHEN item_key='chatbot.capability'   THEN value_numeric END), 0) AS f_chat
          FROM questionnaire_responses
          WHERE participant_id = %s AND questionnaire_name = 'TechFam'
        )
        SELECT bdli.bdli_mean::float, tf.f_dash::float, tf.f_chat::float
        FROM bdli CROSS JOIN tf
        """,
        (str(a.participant_id), str(a.participant_id)),
    )
    row = await cur.fetchone()
    bdli_mean, f_dash, f_chat = (row[0], row[1], row[2]) if row and not isinstance(row, dict) else (row.get("bdli_mean"), row.get("f_dash"), row.get("f_chat")) if row else (None, 0.0, 0.0)

    # Fallbacks (rare): if BDLI not found yet, use client value; same for fams
    data_lit_score = bdli_mean if bdli_mean is not None else a.data_lit_score
    f_dash = f_dash if f_dash is not None else (a.familiarity_dashboard or 0.0)
    f_chat = f_chat if f_chat is not None else (a.familiarity_chatbot  or 0.0)

    # 2) New participant’s composite stratum
    lit_s = literacy_to_stratum(data_lit_score, (LIT_CUT1, LIT_CUT2))
    rfi   = relative_fam_index(f_dash, f_chat)
    fam_s = rfi_to_stratum(rfi, RFI_CUT1, RFI_CUT2)
    key   = composite_stratum(lit_s, fam_s)

    # 3) Decide arm by minimization
    arm = choose_arm(counts, key, BIASED_COIN_P)



    # 4) Upsert assignment; persist recomputed values + derived index
    on_conflict = (
        "NOTHING" if not a.force else
        "UPDATE SET interface_cond = EXCLUDED.interface_cond, "
        "data_lit_score = EXCLUDED.data_lit_score, "
        "familiarity_dashboard = EXCLUDED.familiarity_dashboard, "
        "familiarity_chatbot  = EXCLUDED.familiarity_chatbot, "
        "familiarity_index    = EXCLUDED.familiarity_index, "
        "assigned_at          = NOW()"
    )
    try:
        await cur.execute(
            f"""
            INSERT INTO group_assignments
              (participant_id, interface_cond, data_lit_score,
               familiarity_dashboard, familiarity_chatbot, familiarity_index, assigned_at)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (participant_id) DO {on_conflict}
            RETURNING interface_cond
            """,
            (str(a.participant_id), arm, data_lit_score, f_dash, f_chat, rfi),
        )
        row2 = await cur.fetchone()
        if row2 is None:
            await cur.execute("SELECT interface_cond FROM group_assignments WHERE participant_id = %s", (str(a.participant_id),))
            row2 = await cur.fetchone()
        final_arm = (row2["interface_cond"] if isinstance(row2, dict) else row2[0]) or arm

        logger.info("assign_group computed: lit_s=%s fam_s=%s rfi=%.2f arm=%s counts=%s",
            lit_s, fam_s, rfi, final_arm, counts)

    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=404, detail="participant not found")

    return {
        "participant_id": str(a.participant_id),
        "interface_cond": final_arm,
        "stratum_lit": lit_s,
        "stratum_fam": fam_s,
        "familiarity_index": rfi,
        "data_lit_score": data_lit_score,
        "familiarity_dashboard": f_dash,
        "familiarity_chatbot": f_chat,
    }

