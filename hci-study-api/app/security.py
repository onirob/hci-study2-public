from fastapi import Request, HTTPException
from .config import WRITE_TOKEN_HEADER

async def require_write_token(request: Request, cur, session_id: str):
    token = request.headers.get(WRITE_TOKEN_HEADER)
    if not token:
        raise HTTPException(401, f"Missing {WRITE_TOKEN_HEADER}")
    await cur.execute("SELECT 1 FROM sessions WHERE id=%s AND write_token=%s;", (session_id, token))
    if not await cur.fetchone():
        raise HTTPException(403, "Invalid write token")
