from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal, Union
from datetime import datetime
from uuid import UUID

# --- Participants & auth ---

class ConsentDeclineIn(BaseModel):
    prolific_pid: str
    prolific_study_id: Optional[str] = None
    prolific_session_id: Optional[str] = None
    consent_version: str
    ineligible_reason: Optional[str] = "declined_consent"


class ConsentRegisterIn(BaseModel):
    prolific_pid: str
    prolific_study_id: str | None = None
    prolific_session_id: str | None = None
    consent_version: str

""" class RegisterParticipant(BaseModel):
    prolific_pid: str
    prolific_study_id: Optional[str] = None
    prolific_session_id: Optional[str] = None

class ConsentIn(BaseModel):
    participant_id: UUID
    consent_version: str """

class CompleteIn(BaseModel):
    participant_id: UUID

class GroupAssignmentIn(BaseModel):
    participant_id: UUID
    data_lit_score: Optional[float] = None
    familiarity_dashboard: Optional[float] = None
    familiarity_chatbot: Optional[float] = None
    force: bool = False

# --- Sessions ---
class StartSession(BaseModel):
    participant_id: UUID
    started_at: Optional[datetime] = None

class EndSessionIn(BaseModel):
    # session_id is optional; we'll verify if provided, but we don't trust it
    session_id: Optional[str] = None
    ended_at: Optional[str] = None  # ISO timestamp; if None → now()
    # Optional final participant status at end of run:
    # default behavior (if omitted) is 'completed'
    final_status: Optional[Literal['completed', 'timed_out', 'rejected']] = None
    # Optional additional bookkeeping
    attention_passed: Optional[bool] = None
    comprehension_passed: Optional[bool] = None
    ineligible_reason: Optional[str] = None
    completion_code: Optional[str] = None

class SessionGuardOut(BaseModel):
    ok: bool
    participant_id: str
    session_id: str
    participant_status: str | None = None
    session_started_at: str | None = None
    session_ended_at: str | None = None

# --- Task responses ---
TaskStatus = Literal['completed', 'overtime', 'aborted', 'skipped']

class TaskResponse(BaseModel):
    participant_id: UUID
    session_id: Optional[UUID] = None
    task_code: str
    complexity: int                               # integer level
    status: TaskStatus                            # 'completed' | 'overtime' | 'aborted' | 'skipped'
    started_at: Optional[datetime] = None         # IGNORED by server write (kept for legacy)
    ended_at: Optional[datetime] = None           # IGNORED by server write (kept for legacy)
    duration_ms: Optional[int] = None             # IGNORED by server write (computed server-side)
    accuracy_score: Optional[float] = None        # optional; server may compute
    answer: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None

# --- Task priming ---
class TaskPrimeRequest(BaseModel):
    ui: Optional[Literal['dashboard','chatbot']] = None
    cycle: Optional[int] = None
    page: Optional[str] = None
    client_render_ms: Optional[int] = None
    complexity: Optional[int] = None  # optional, will fall back to defaults

class TaskPrimeResponse(BaseModel):
    server_now_ms: int
    reading_seen_at_ms: int

# --- Task start / timeout ---
class TaskStartRequest(BaseModel):
    # If you don't have a tasks table, allow client to pass a budget fallback.
    budget_seconds: Optional[int] = Field(default=None, ge=10, le=60*60)
    prewarn_lead_sec: Optional[int] = Field(default=60, ge=0, le=600)
    grace_seconds: Optional[int] = Field(default=60, ge=10, le=600)
    # Optional: front-end may tell you the computed complexity to store early.
    complexity: Optional[int] = Field(default=None, ge=0, le=99)

class TaskStartResponse(BaseModel):
    server_now_ms: int
    started_at_ms: int
    ends_at_ms: int
    prewarn_lead_sec: int
    grace_seconds: int

class TaskTimeoutResponse(BaseModel):
    response_id: UUID
    status: TaskStatus

# --- Questionnaire responses ---
class QuestionnaireResponse(BaseModel):
    participant_id: UUID
    session_id: Optional[UUID] = None
    task_code: Optional[str] = None   
    questionnaire_name: str         # 'NASA-TLX', 'BDLI', ...
    item_key: str                   # 'mental_demand', 'Q5', ...
    value_numeric: Optional[int] = None
    value_text: Optional[str] = None
    submitted_at: Optional[datetime] = None

class QuestionnaireBatch(BaseModel):
    responses: List[QuestionnaireResponse] = Field(default_factory=list)

# --- Telemetry: dashboard ---
class DashboardEvent(BaseModel):
    participant_id: UUID
    session_id: UUID
    task_code: Optional[str] = None
    ts: datetime
    event_type: str                 # 'click', 'hover', 'filter_change', ...
    target: Optional[str] = None    # component/eid
    client_ts_ms: Optional[int] = None
    t_perf_ms: Optional[float] = None
    seq: Optional[int] = None
    vp_w: Optional[int] = None
    vp_h: Optional[int] = None
    payload: Optional[Dict[str, Any]] = None
    client_event_id: Optional[str] = None

class DashboardEventBatch(BaseModel):
    events: List[DashboardEvent] = Field(default_factory=list)

# --- Telemetry: chat ---
class StartConversation(BaseModel):
    participant_id: UUID
    session_id: UUID
    model: Optional[str] = None

class ChatMessageIn(BaseModel):
    conversation_id: UUID
    ts: Optional[datetime] = None
    role: str                       # 'system' | 'user' | 'assistant' | 'tool'
    content: Optional[str] = None
    tokens: Optional[int] = None
    latency_ms: Optional[int] = None
    tool_name: Optional[str] = None
    tool_params: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None
    client_msg_id: Optional[str] = None

class ChatMessageBatch(BaseModel):
    messages: List[ChatMessageIn] = Field(default_factory=list)

# --- Telemetry: generic events ---
class EventIn(BaseModel):
    client_event_id: Optional[str] = None
    event_type: str = Field(..., max_length=64)     # NOT NULL
    target: Optional[str] = Field(None, max_length=256)
    client_ts_ms: Optional[int] = None
    t_perf_ms: Optional[float] = None
    seq: Optional[int] = None
    vp_w: Optional[int] = None
    vp_h: Optional[int] = None
    payload: Optional[Dict[str, Any]] = None

class BatchIn(BaseModel):
    participant_id: Optional[UUID] = None  # optional; server verifies if present
    session_id: Optional[UUID] = None
    write_token: Optional[str] = None      # beacon fallback
    task_code: str | None = None  
    events: List[EventIn] = Field(..., min_items=1, max_items=2000)

# ---------- Attention checks (IMC) summary ----------
class AttentionEventIn(BaseModel):
    id: str
    page: str
    label: Optional[str] = None
    passed: bool
    response: Optional[Union[str, int, float]] = None
    ts: Optional[int] = None  # epoch ms

class AttentionLogIn(BaseModel):
    events: List[AttentionEventIn] = Field(default_factory=list)
    shown: int
    fails: int
    adaptive_shown: Optional[bool] = False
    screened_out: Optional[bool] = False
    attention_passed: Optional[bool] = None  # if None, computed as fails < 2
    notes: Optional[Dict[str, Any]] = None   # optional extra metadata

# --- Bonuses ---
class BonusIn(BaseModel):
    participant_id: UUID
    session_id: Optional[UUID] = None
    task_code: Optional[str] = None
    reason: str
    amount_minor: int
