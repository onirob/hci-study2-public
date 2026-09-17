# app/services/assignment.py
from __future__ import annotations
from typing import Dict, Tuple, Optional, Literal
from random import random
import os

Arm = Literal["chatbot", "dashboard"]
ARMS: tuple[Arm, Arm] = ("chatbot", "dashboard")

Stratum = str

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except Exception:
        return default

# Tunables (use BDLI 1–5 cuts by default)
BIASED_COIN_P: float = _env_float("ASSIGNMENT_BIASED_P", 0.80)
LIT_CUT1: float = _env_float("LITERACY_CUT1", 5.0)   # 1..7 scale
LIT_CUT2: float = _env_float("LITERACY_CUT2", 6.0)   # 1..7 scale
RFI_CUT1: float = _env_float("RFI_CUT1", -0.33)
RFI_CUT2: float = _env_float("RFI_CUT2",  0.33)

def literacy_to_stratum(score: Optional[float], cuts: Tuple[float, float]) -> str:
    if score is None:
        return "lit_mid"
    c1, c2 = cuts
    if score <= c1: return "lit_low"
    if score <= c2: return "lit_mid"
    return "lit_high"

def relative_fam_index(f_dash: Optional[float], f_chat: Optional[float], _ignored: float = 0.0) -> float:
    """Scale-free: (d - c) / (d + c), robust to 0..6, 0..100, etc."""
    d = (f_dash or 0.0)
    c = (f_chat or 0.0)
    s = d + c
    if s <= 0.0:
        return 0.0
    v = (d - c) / s
    return max(-1.0, min(1.0, v))

def rfi_to_stratum(rfi: float, c1: float, c2: float) -> str:
    if rfi <= c1:  return "fam_lean_chat"
    if rfi <= c2:  return "fam_neutral"
    return "fam_lean_dash"

def composite_stratum(lit_stratum: str, fam_stratum: str) -> Stratum:
    return f"{lit_stratum}__{fam_stratum}"

def _clone_counts(counts: Dict[Stratum, Dict[Arm, int]]) -> Dict[Stratum, Dict[Arm, int]]:
    return {s: dict(v) for s, v in counts.items()}

def compute_imbalance_score(counts: Dict[Stratum, Dict[Arm, int]]) -> int:
    score = 0
    for s in counts.keys():
        c = counts.get(s, {})
        score += abs(c.get("chatbot", 0) - c.get("dashboard", 0))
    tot_chat = sum(v.get("chatbot", 0) for v in counts.values())
    tot_dash = sum(v.get("dashboard", 0) for v in counts.values())
    score += abs(tot_chat - tot_dash)
    return score

def choose_arm(counts: Dict[Stratum, Dict[Arm, int]], stratum: Stratum, biased_p: float) -> Arm:
    scores = {}
    for arm in ARMS:
        c = _clone_counts(counts)
        c.setdefault(stratum, {"chatbot": 0, "dashboard": 0})
        c[stratum][arm] = c[stratum].get(arm, 0) + 1
        scores[arm] = compute_imbalance_score(c)
    if scores["chatbot"] < scores["dashboard"]:
        preferred: Arm = "chatbot"
    elif scores["dashboard"] < scores["chatbot"]:
        preferred = "dashboard"
    else:
        preferred = "chatbot" if random() < 0.5 else "dashboard"
    return preferred if (random() < biased_p) else ("dashboard" if preferred == "chatbot" else "chatbot")
