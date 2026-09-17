# utils.py
from __future__ import annotations
from datetime import datetime, timezone, date
from typing import Any, Dict, List, Optional, Set, Tuple
import re
from app.routes.deps import with_cursor 

DEFAULT_PREWARN = 60
DEFAULT_GRACE = 60
DEFAULT_FALLBACK_BUDGET = 300  # 5 minutes

# Per-task defaults (only used when client omits fields)
TASK_DEFAULTS: dict[str, dict[str, int]] = {
    "T1": {"budget_seconds": 180,  "prewarn": 60, "grace": 60, "complexity": 3},
    "T2": {"budget_seconds": 360, "prewarn": 90, "grace": 60, "complexity": 9},
    "T3": {"budget_seconds": 600, "prewarn": 120, "grace": 60, "complexity": 31},
}

def task_code_defaults(task_code: str) -> dict[str, int]:
    """
    Return per-task defaults when the client doesn't send them.
    Falls back to a simple pattern (T# => 90 + 30*(#-1)) and finally to globals.
    """
    if task_code in TASK_DEFAULTS:
        return TASK_DEFAULTS[task_code]

    m = re.match(r"^[A-Za-z_]*?(\d+)$", task_code or "")
    if m:
        n = int(m.group(1))
        # Example heuristic: 90s, 120s, 150s, …
        budget = max(30, 90 + (n - 1) * 30)
        return {"budget_seconds": budget, "prewarn": DEFAULT_PREWARN, "grace": DEFAULT_GRACE, "complexity": 0}

    return {"budget_seconds": DEFAULT_FALLBACK_BUDGET, "prewarn": DEFAULT_PREWARN, "grace": DEFAULT_GRACE, "complexity": 0}

def _utcnow_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


# --- Scoring Helpers ------------------------------------------------------------

MACHINE_CODE_TO_LABEL: dict[str, str] = {
    # Cutting
    "large_1":  "Large Capacity Cutting Machine 1",
    "large_2":  "Large Capacity Cutting Machine 2",
    "medium_1": "Medium Capacity Cutting Machine 1",
    "medium_2": "Medium Capacity Cutting Machine 2",
    "medium_3": "Medium Capacity Cutting Machine 3",
    "low_1":    "Low Capacity Cutting Machine 1",

    # Assembly
    "assem_1": "Assembly Machine 1",
    "assem_2": "Assembly Machine 2",
    "assem_3": "Assembly Machine 3",

    # Laser / Rivet / Cutter
    "cutter":  "Laser Cutter",
    "laser_1": "Laser Welding Machine 1",
    "laser_2": "Laser Welding Machine 2",
    "rivet":   "Riveting Machine",

    # Testing
    "test_1": "Testing Machine 1",
    "test_2": "Testing Machine 2",
    "test_3": "Testing Machine 3",
}




def _parse_date_answer(raw: Optional[str]) -> Optional[date]:
    """
    Accepts typical frontend date formats and converts to Python date.

    Expected most likely: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'.
    Falls back to 'DD-MM-YY' / 'DD-MM-YYYY' if needed.
    """
    if not raw:
        return None

    txt = raw.strip()
    if not txt:
        return None

    # Strip any time component
    txt = txt.split("T", 1)[0]

    # First try ISO: 2025-02-15
    try:
        return date.fromisoformat(txt)
    except ValueError:
        pass

    # Fallback: 15-02-25 or 15-02-2025
    try:
        d, m, y = txt.split("-")
        year = int(y)
        if year < 100:  # simple 2-digit year handling
            year += 2000
        return date(year, int(m), int(d))
    except Exception:
        return None


def _extract_score(row: Any) -> Optional[float]:
    """
    Extract decision_score from either a tuple row or dict row.
    """
    if row is None:
        return None

    if isinstance(row, dict):
        val = row.get("decision_score")
    else:  # tuple_row, etc.
        try:
            val = row[0]
        except Exception:
            val = None

    return float(val) if val is not None else None


# --- Main scoring function ----------------------------------------------

async def score_answer(cur, task_code: str, answer: Dict[str, Any] | None) -> float:
    """
    Lookup the participant's answer in decision_ground_truth and return decision_score.
    Uses the async cursor passed in by the caller. Returns 0.0 if no match.
    """
    if not answer:
        return 0.0

    # --- Task 1: date answer ------------------------------------------
    if task_code == "T1":
        dt = _parse_date_answer(answer.get("day"))
        if not dt:
            return 0.0

        await cur.execute(
            """
            SELECT decision_score
            FROM decision_ground_truth
            WHERE task_code = 'T1'
              AND date_response = %s
            """,
            (dt,),
        )
        row = await cur.fetchone()
        return float(row["decision_score"]) if row else 0.0

    # --- Task 2: single machine choice --------------------------------
    if task_code == "T2":
        best_code = answer.get("pick_best")
        second_code = answer.get("pick_second")
        if not (best_code and second_code):
            return 0.0

        # Map frontend value -> label stored in DB
        best_label = MACHINE_CODE_TO_LABEL.get(best_code, best_code)
        second_label = MACHINE_CODE_TO_LABEL.get(second_code, second_code)

        await cur.execute(
            """
            SELECT decision_score
            FROM decision_ground_truth
            WHERE task_code = 'T2'
            AND lower(btrim(cutting_best_response)) = lower(btrim(%s))
            AND lower(btrim(cutting_second_response)) = lower(btrim(%s))
            """,
            (best_label, second_label),
        )
        row = await cur.fetchone()
        return float(row["decision_score"]) if row else 0.0

    # --- Task 3: maintenance + process + quality combo ----------------
    if task_code == "T3":
        maint_code = answer.get("pick_maint")
        proc_code  = answer.get("pick_proc")
        qual_code  = answer.get("pick_qual")

        if not (maint_code and proc_code and qual_code):
            return 0.0

        maint_label = MACHINE_CODE_TO_LABEL.get(maint_code)
        proc_label  = MACHINE_CODE_TO_LABEL.get(proc_code)
        qual_label  = MACHINE_CODE_TO_LABEL.get(qual_code)

        if not (maint_label and proc_label and qual_label):
            return 0.0

        await cur.execute(
            """
            SELECT decision_score
            FROM decision_ground_truth
            WHERE task_code = 'T3'
            AND lower(btrim(maintenance_name_response)) = lower(btrim(%s))
            AND lower(btrim(process_name_response))     = lower(btrim(%s))
            AND lower(btrim(quality_name_response))     = lower(btrim(%s))
            """,
            (maint_label, proc_label, qual_label),
        )
        row = await cur.fetchone()
        return float(row["decision_score"]) if row else 0.0

    # Unknown task
    return 0.0



# ---- Constants (exact labels, normalized lowercase with single spaces) ----
_QN_START = "PrescreenStart"
_QN_END   = "PrescreenEnd"

_INDUSTRY_OK: Set[str] = {
    "manufacturing",
    "other manufacturing",
    "computer and electronics manufacturing",
    "automotive",
    "pharmaceuticals / bio-tech",
    "engineering",
    "mining",
    "oil and gas",
    "nuclear power",
    "utilities",
}

_ROLE_OK: Set[str] = {
    "upper management",
    "middle management",
    "junior management",
}

_RESP_TARGET: Set[str] = {
    "operations/production",
    "supply chain/logistics",
    "business strategy",
}

_RESP_NONE = "none"

# ---- Helpers ----
def _norm(s: Optional[str]) -> str:
    """lower + collapse spaces for robust matching."""
    if not s:
        return ""
    return " ".join(s.strip().split()).lower()

def _split_multi(s: Optional[str]) -> List[str]:
    """Parse pipe-joined multi-selects stored in value_text."""
    if not s:
        return []
    # your client joins via " | "
    parts = [p.strip() for p in s.split("|")]
    return [p for p in parts if p]

def _industry_ok(val: Optional[str]) -> bool:
    return _norm(val) in _INDUSTRY_OK

def _role_ok(val: Optional[str]) -> bool:
    return _norm(val) in _ROLE_OK

def _resp_ok(val: Optional[str]) -> bool:
    opts = [_norm(x) for x in _split_multi(val)]
    if not opts:
        return False
    if _RESP_NONE in opts:
        return False
    return any(o in _RESP_TARGET for o in opts)

def _jaccard(a: List[str], b: List[str]) -> float:
    sa = { _norm(x) for x in a if x }
    sb = { _norm(x) for x in b if x }
    if not sa and not sb:
        return 1.0
    denom = len(sa | sb)
    return 0.0 if denom == 0 else len(sa & sb) / denom

async def _load_form(cur, pid: str, qname: str) -> Optional[Dict[str, Any]]:
    """
    Return latest answers for a questionnaire name as {item_key: value_text, ...}.
    If none exist, return None.
    """
    await cur.execute("""
        SELECT item_key, value_text
        FROM questionnaire_responses
        WHERE participant_id = %s AND questionnaire_name = %s
        ORDER BY submitted_at DESC
    """, (pid, qname))
    rows = await cur.fetchall()
    if not rows:
        return None
    # keep latest per item_key
    form: Dict[str, Any] = {}
    for r in rows:
        k = r["item_key"]
        if k not in form:
            form[k] = r["value_text"]
    return form

def _compute_flags(form: Optional[Dict[str, Any]]) -> Tuple[bool, bool, bool, Dict[str, Any]]:
    if not form:
        return (False, False, False, {"industry": None, "industry_role": None,
                                      "decision_responsibilities": [], "company_size": None})
    industry  = form.get("industry")
    role      = form.get("industry_role")
    resp_raw  = form.get("decision_responsibilities")
    size      = form.get("company_size")

    ind_ok = _industry_ok(industry)
    rol_ok = _role_ok(role)
    rsp_ok = _resp_ok(resp_raw)

    snapshot = {
        "industry": industry,
        "industry_role": role,
        "decision_responsibilities": _split_multi(resp_raw),
        "company_size": size
    }
    return ind_ok, rol_ok, rsp_ok, snapshot