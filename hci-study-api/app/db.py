# db.py
from pathlib import Path
from psycopg_pool import AsyncConnectionPool
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from .config import settings

pool = AsyncConnectionPool(
    conninfo=settings.DATABASE_URL,
    min_size=1,
    max_size=10,
    num_workers=3,
    open=False,  # we'll open on startup
)

async def open_pool():
    if pool.closed:
        await pool.open()

async def init_db():
    """Run init.sql idempotently at startup."""
    await open_pool()
    init_path = Path(__file__).resolve().parent / "sql" / "init.sql"
    async with pool.connection() as conn:  # type: AsyncConnection
        await conn.execute("SET client_min_messages TO WARNING;")
        if init_path.exists():
            sql_text = init_path.read_text(encoding="utf-8")
            await conn.execute(sql_text)

# ✅ FIXED: use row_factory on the cursor, not on the connection
async def with_cursor():
    """Async dependency that yields a dict-row cursor and commits/rolls back."""
    await open_pool()  # safe if already open
    conn = await pool.getconn()
    try:
        async with conn.cursor(row_factory=dict_row) as cur:
            yield cur
            await conn.commit()
    except Exception:
        try:
            await conn.rollback()
        finally:
            pass
        raise
    finally:
        await pool.putconn(conn)

# Helpers
async def assert_open_session(cur, participant_id: str, session_id: str):
    await cur.execute(
        "SELECT 1 FROM sessions WHERE id=%s AND participant_id=%s AND ended_at IS NULL;",
        (session_id, participant_id),
    )
    if not await cur.fetchone():
        from fastapi import HTTPException
        raise HTTPException(403, "invalid or closed session")
