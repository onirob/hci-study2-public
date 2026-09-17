import os
import asyncio
from typing import Dict, Optional, List, Literal

import time, uuid
from fastapi import FastAPI, Depends, HTTPException, Request, APIRouter
import inspect
from pydantic import BaseModel, Field, constr
import httpx
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()  # Retrieval modules read the API URL at import time.

from app.Zero import Zero 

STUDY_API_BASE_URL = os.getenv("STUDY_API_BASE_URL", "http://127.0.0.1:8787/api")
#API_BASE_URL = os.getenv("API_BASE_URL", "http://api:8787")
REQUEST_TIMEOUT = float(os.getenv("CHAT_REQUEST_TIMEOUT", "60"))
COMPANY_PREFIX = os.getenv("COMPANY_PREFIX", "")
JOB_PROFILE    = os.getenv("JOB_PROFILE", "other")
WKS_ID         = os.getenv("WORKSPACE_ID", "public-scenario")

app = FastAPI(title="Study Chatbot API")

router = APIRouter(prefix="/chat", tags=["chatbot"])



# -------------------- Schemas --------------------

Role = Literal["system", "user", "assistant", "tool"]

class Message(BaseModel):
    role: Role
    content: str = Field(..., min_length=1)

class ChatRequest(BaseModel):
    user_id: constr(min_length=1)
    messages: List[Message] = Field(..., min_items=1)
    conversation_id: Optional[str] = None
    streaming: Optional[bool] = False
    job_profile: Optional[str] = "other"          # defaults aligned with your Zero.run_conversation
    company_prefix: Optional[str] = ""            # can be injected by API or caller
    task_code: str = "default"

class ChatResponse(BaseModel):
    reply: str
    conversation_id: Optional[str] = None

# -------------------- HTTP client dep --------------------

async def get_client():
    async with httpx.AsyncClient(base_url=STUDY_API_BASE_URL, timeout=REQUEST_TIMEOUT) as client:
        yield client

# -------------------- Zero per-user registry --------------------

_bots: Dict[str, Zero] = {}
_locks: Dict[str, asyncio.Lock] = {}

def _get_lock(user_id: str) -> asyncio.Lock:
    lock = _locks.get(user_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[user_id] = lock
    return lock

async def fetch_chat_config(client, user_id: str) -> dict:
    """
    Return fixed chatbot config for all users. No network calls.
    """
    return {
        "company_prefix": COMPANY_PREFIX,
        "job_profile": JOB_PROFILE,
        "wks": WKS_ID,
    }


async def get_bot(user_id: str, client: httpx.AsyncClient) -> Zero:
    bot = _bots.get(user_id)
    if bot is not None:
        return bot

    cfg = await fetch_chat_config(client, user_id)
    wks = cfg.get("wks")

    try:
        bot = Zero(wks=wks)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Configure server-side Azure settings; see docs/SETUP.md.") from exc

    _bots[user_id] = bot
    return bot

# -------------------- Helpers --------------------
def _forward_auth_headers(request: Request) -> dict:
    out = {}

    # Header-based auth only
    xswt = request.headers.get("x-session-write-token")
    if xswt:
        out["X-Session-Write-Token"] = xswt

    for k, v in request.headers.items():
        lk = k.lower()
        if lk.startswith("x-") and lk not in ("x-session-write-token",):
            out[k] = v

    return out

async def _ensure_conversation_id(client: httpx.AsyncClient, headers: dict, current: Optional[str], model: Optional[str], meta: dict, task_code: str) -> str:
    if current:
        return current
    r = await client.post(
        "/chatbot/conversations/start",
        json={"model": model, "task_code": task_code, "meta": meta},
        headers=headers,
    )
    r.raise_for_status()
    return r.json()["conversation_id"]

# -------------------- Routes --------------------

@router.get("/health")
def health():
    return {"ok": True}


@router.post("/messages", response_model=ChatResponse)
async def messages(
    req: ChatRequest,
    request: Request,
    client: httpx.AsyncClient = Depends(get_client)
):
    bot = await get_bot(req.user_id, client)
    lock = _get_lock(req.user_id)

    cfg = await fetch_chat_config(client, req.user_id)
    if not (req.company_prefix and req.company_prefix.strip()):
        req.company_prefix = cfg["company_prefix"]
    if not (req.job_profile and req.job_profile.strip()):
        req.job_profile = cfg["job_profile"]

    headers = _forward_auth_headers(request)

    conversation_id = await _ensure_conversation_id(
        client, headers, req.conversation_id, model="Zero",
        meta={"job_profile": req.job_profile, "company_prefix": req.company_prefix},
        task_code=req.task_code,
    )

    # Pick the LAST user message (don’t assume messages[-1] is user)
    last_user = next((m for m in reversed(req.messages) if m.role == "user"), None)
    if last_user is None:
        raise HTTPException(status_code=400, detail="no_user_message_found")

    user_ts = datetime.now(timezone.utc)
    user_client_id = str(uuid.uuid4())

    user_msg = {
        "role": "user",
        "content": last_user.content,
        "ts": user_ts.isoformat(),
        "client_msg_id": user_client_id,
    }

    # 1) Persist USER message immediately (best-effort).
    # Shield = even if the request gets cancelled (client/proxy timeout),
    # this call has a much better chance to complete.
    try:
        await asyncio.shield(
            client.post(
                "/chatbot/messages/batch",
                json={"conversation_id": conversation_id, "messages": [user_msg]},
                headers=headers,
            )
        )
    except Exception:
        pass  # don't fail the chat on logging problems

    # 2) Now compute assistant reply
    t0 = time.monotonic()
    try:
        async with lock:
            ret = bot.run_conversation(
                messages=[m.model_dump() for m in req.messages],
                streaming=bool(req.streaming),
                job_profile=req.job_profile or "other",
                company_prefix=req.company_prefix or "",
            )

            if inspect.isasyncgen(ret):
                chunks = []
                async for chunk in ret:
                    chunks.append(
                        chunk.get("delta") or chunk.get("content") or chunk.get("reply") or ""
                        if isinstance(chunk, dict) else str(chunk)
                    )
                result = "".join(chunks)
            elif inspect.isawaitable(ret):
                result = await ret
            else:
                result = ret

    except asyncio.CancelledError:
        # IMPORTANT: request was cancelled (client/proxy timeout).
        # User message is already logged above. Re-raise to respect cancellation.
        raise
    except Exception as e:
        # User message is already logged. Keep your previous behavior:
        raise HTTPException(status_code=500, detail="chatbot_error: check server configuration and logs")

    dt_ms = int((time.monotonic() - t0) * 1000)
    assistant_ts = datetime.now(timezone.utc)

    reply_text = (
        result.get("reply") or result.get("content")
        if isinstance(result, dict)
        else (result if isinstance(result, str) else str(result))
    )
    if not reply_text:
        raise HTTPException(status_code=500, detail="chatbot_returned_empty_reply")

    assistant_msg = {
        "role": "assistant",
        "content": reply_text,
        "ts": assistant_ts.isoformat(),
        "latency_ms": dt_ms,
        "client_msg_id": str(uuid.uuid4()),
        # optionally: "raw": {"in_reply_to": user_client_id},
    }

    # 3) Persist ASSISTANT message (best-effort)
    try:
        await asyncio.shield(
            client.post(
                "/chatbot/messages/batch",
                json={"conversation_id": conversation_id, "messages": [assistant_msg]},
                headers=headers,
            )
        )
    except Exception:
        pass

    return ChatResponse(reply=reply_text, conversation_id=conversation_id)


@router.delete("/sessions/{user_id}")
async def reset_session(user_id: str):
    """Clear a user's bot and lock (useful during testing)."""
    _bots.pop(user_id, None)
    _locks.pop(user_id, None)
    return {"ok": True}

app.include_router(router)
