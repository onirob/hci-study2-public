# app/schemas_chatbot.py
from __future__ import annotations
from typing import Dict, List, Optional, Literal, Any
from pydantic import BaseModel, Field, RootModel
from datetime import datetime

Role = Literal["system","user","assistant","tool"]

RequestScope = Literal["single_assets", "overall"]
InterestType = Literal["time", "energy_and_cost", "production", "efficiency", "status"]
Granularity = Literal["daily", "hourly"]
Window = Literal["since_midnight", "latest", "last_minutes"]
TimeFormat = Literal["seconds", "hhmmss", "both"]  # <— NEW

class AssetMatch(BaseModel):
    machine_id: str
    name: Optional[str] = None
    type: Optional[str] = None
    aliases: Optional[List[str]] = None
    meta: Optional[dict] = None

class ResolveAssetsResponse(BaseModel):
    matches: List[AssetMatch]

class KPIGroup(RootModel[Dict[str, Optional[float]]]):
    """Map of KPI name -> numeric value (or None)."""
    pass

class KPITimeDisplay(RootModel[Dict[str, Optional[str]]]):  # <— NEW
    """Map of time KPI name -> HH:MM:SS (or None)."""
    pass

class StatusPayload(BaseModel):
    value: Optional[str] = None  # pass-through from latest row

class AggregationInfo(BaseModel):
    basis: Window
    rows_used: int
    fallback: bool = False

class SingleAssetPayload(BaseModel):
    machine_id: str
    name: Optional[str] = None
    sample_ts: Optional[str] = None  
    status: Optional[StatusPayload] = None
    kpis: Dict[str, KPIGroup] = Field(default_factory=dict)  # keys: 'time','energy_and_cost','production','efficiency'
    kpis_display: Optional[Dict[str, KPITimeDisplay]] = None  
    aggregation: Optional[AggregationInfo] = None

class OverallPayload(BaseModel):
    sample_ts: Optional[str] = None
    connected_machines: Optional[int] = None
    machines_total: Optional[int] = None
    kpis: Dict[str, KPIGroup] = Field(default_factory=dict)
    kpis_display: Optional[Dict[str, KPITimeDisplay]] = None  # <— NEW (only 'time' key used)

class CurrentContext(BaseModel):
    window: Window
    tz: str
    time_granularity: Granularity
    hour_range: Optional[List[str]] = None


class CurrentResponse(BaseModel):
    context: CurrentContext
    notes: List[str] = Field(default_factory=list)
    assets: Optional[List[SingleAssetPayload]] = None
    overall: Optional[OverallPayload] = None

# --- Conversation management ---
class ConversationStartRequest(BaseModel):
    model: Optional[str] = None
    task_code: str 
    meta: Optional[Dict[str, Any]] = None  # free-form

class ConversationStartResponse(BaseModel):
    conversation_id: str

class ChatMessageIn(BaseModel):
    role: Role
    content: Optional[str] = None
    ts: Optional[datetime] = None
    tokens: Optional[int] = None
    latency_ms: Optional[int] = None
    tool_name: Optional[str] = None
    tool_params: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None
    client_msg_id: Optional[str] = None

class ChatMessageBatchIn(BaseModel):
    conversation_id: str
    messages: List[ChatMessageIn]

class ConversationEndRequest(BaseModel):
    ended_at: Optional[datetime] = None
