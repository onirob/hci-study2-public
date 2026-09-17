from fastapi import Header, HTTPException, Depends
from ..db import with_cursor

async def require_session(cur=Depends(with_cursor), x_session_write_token: str | None = Header(None)):
    if not x_session_write_token:
        raise HTTPException(401, detail={"code": "missing_token"})
    await cur.execute("""
        SELECT id, participant_id
          FROM sessions
         WHERE write_token=%s AND ended_at IS NULL
         LIMIT 1;
    """, (x_session_write_token,))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(403, detail={"code": "invalid_or_closed_token"})
    # Return canonical IDs — ignore anything from the client body
    return {"session_id": row["id"], "participant_id": row["participant_id"]}
