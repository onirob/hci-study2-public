import os, logging, uuid, decimal, json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from subprocess import Popen, PIPE
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from psycopg import connect

# ------------ Config (env) ------------
PGHOST=os.getenv("PGHOST","db"); PGPORT=os.getenv("PGPORT","5432")
PGUSER=os.getenv("PGUSER","postgres"); PGPASSWORD=os.getenv("PGPASSWORD","")
PGDATABASE=os.getenv("PGDATABASE","hci_study")

BACKUP_DIR=Path(os.getenv("BACKUP_DIR","/backups"))
RETENTION_HOURS=int(os.getenv("RETENTION_HOURS","168"))          # keep 7 days
CRON=os.getenv("CRON","0 */2 * * *")
RUN_ONCE=os.getenv("RUN_ONCE","false").lower()=="true"
DUMP_GLOBALS=os.getenv("DUMP_GLOBALS","false").lower()=="true"

# Exclusions for pg_dump
EXCLUDE_TABLES=[s.strip() for s in os.getenv("EXCLUDE_TABLES","").split(",") if s.strip()]
EXCLUDE_TABLE_DATA=[s.strip() for s in os.getenv("EXCLUDE_TABLE_DATA","").split(",") if s.strip()]

# Analytics export
ANALYTICS=os.getenv("ANALYTICS","true").lower()=="true"
ANALYTICS_DIR=Path(os.getenv("ANALYTICS_DIR","/backups/analytics"))
ANALYTICS_WINDOW_HOURS=int(os.getenv("ANALYTICS_WINDOW_HOURS","720"))
ANALYTICS_STRIP_CONTENT=os.getenv("ANALYTICS_STRIP_CONTENT","false").lower()=="false"
ANALYTICS_PACKAGE=os.getenv("ANALYTICS_PACKAGE","zip").lower()   # zip | dir

# Always copy "latest" (Windows-safe)
FORCE_LATEST_COPY=True

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log=logging.getLogger("backupd")

# ------------ Helpers ------------
def ensure_dirs(): BACKUP_DIR.mkdir(parents=True, exist_ok=True)

def rotate():
    """Delete old .dump and .zip files beyond retention."""
    cutoff=datetime.now(timezone.utc)-timedelta(hours=RETENTION_HOURS)
    deleted=0
    for pat in ("*.dump","*.zip"):
        for p in BACKUP_DIR.glob(pat):
            try:
                m=datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
                if m < cutoff:
                    p.unlink(); deleted+=1
            except Exception:
                pass
    if deleted: log.info("Retention: deleted %d old file(s)", deleted)

def _point_latest(target_path: Path, latest_name: str):
    """Create a Windows-friendly 'latest.*' as a real copy (no symlink)."""
    import shutil
    latest = target_path.parent / latest_name
    try:
        if latest.exists() or latest.is_symlink():
            latest.unlink()
    except Exception:
        pass
    shutil.copyfile(target_path, latest)

def _normalize_for_parquet(df: pd.DataFrame) -> pd.DataFrame:
    # 1) tz-aware → UTC-naive
    for c in df.columns:
        dtype = df[c].dtype
        if isinstance(dtype, pd.DatetimeTZDtype):
            df[c] = pd.to_datetime(df[c], utc=True).dt.tz_localize(None)
        elif df[c].dtype == "object":
            v = next((x for x in df[c].values if x is not None), None)
            if isinstance(v, pd.Timestamp) and v.tz is not None:
                df[c] = pd.to_datetime(df[c], utc=True).dt.tz_localize(None)

    # 2) Object columns: coerce common Python types to portable scalars
    for c in df.columns:
        if df[c].dtype == "object":
            v = next((x for x in df[c].values if x is not None), None)
            if isinstance(v, uuid.UUID):
                df[c] = df[c].astype(str)
            elif isinstance(v, decimal.Decimal):
                df[c] = df[c].astype(float)
            elif isinstance(v, (dict, list, tuple)):
                df[c] = df[c].map(lambda x: json.dumps(x) if x is not None else None)
    return df

def _stream_query_to_parquet(query: str, out_path: Path, batch_rows: int = 100_000):
    dsn = f"host={PGHOST} port={PGPORT} dbname={PGDATABASE} user={PGUSER}"
    if PGPASSWORD:
        os.environ["PGPASSWORD"] = PGPASSWORD

    from psycopg import connect
    with connect(dsn) as conn:
        with conn.transaction():
            conn.execute("SET TRANSACTION READ ONLY")
            with conn.cursor(name="cur_stream") as cur:
                cur.execute(query)
                writer = None
                first = True
                try:
                    while True:
                        rows = cur.fetchmany(batch_rows)
                        if not rows:
                            break
                        cols = [d[0] for d in cur.description]
                        df = pd.DataFrame(rows, columns=cols)

                        # your existing normalization (tz→UTC-naive, UUID→str, Decimal→float, JSON→str)
                        df = _normalize_for_parquet(df)

                        table = pa.Table.from_pandas(df, preserve_index=False)
                        # 🔧 strip pandas metadata to avoid extension registration on read
                        table = table.replace_schema_metadata(None)

                        if first:
                            writer = pq.ParquetWriter(
                                out_path,
                                table.schema,
                                compression="zstd",  # keeps files compact
                            )
                            first = False
                        writer.write_table(table)
                finally:
                    if writer is not None:
                        writer.close()


# ------------ Analytics export ------------
def export_analytics(base: str) -> Path:
    import shutil, zipfile
    build_dir = ANALYTICS_DIR / f".{base}.analytics"
    if build_dir.exists(): shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True, exist_ok=True)

    win = ANALYTICS_WINDOW_HOURS
    ts_filter = f"WHERE ts >= now() - interval '{win} hours'"

    queries = {
        "participants.parquet": """
            SELECT id, prolific_pid, eligibility_status, ineligible_reason, status,
                    consented_at, created_at, completed_at,
                    prescreen_label,
                    prescreen_notes::text       AS prescreen_notes,   -- << cast to text
                    attention_passed,
                    attention_notes::text       AS attention_notes,   -- << cast to text
                    comprehension_passed,
                    comprehension_notes::text  AS comprehension_notes,  -- << cast to text
                    user_agent
            FROM participants
        """,
        "group_assignments.parquet": """
            SELECT participant_id, interface_cond, data_lit_score,
                   familiarity_dashboard, familiarity_chatbot, familiarity_index, assigned_at
            FROM group_assignments
        """,
        "sessions.parquet": "SELECT id, participant_id, started_at, ended_at FROM sessions",
        "task_responses.parquet": """
            SELECT id, participant_id, session_id, task_code, complexity, status,
                    answer::text            AS answer,
                   started_at, ended_at, duration_ms, accuracy_score, metadata::text AS metadata
            FROM task_responses
        """,
        "questionnaire_responses.parquet": """
            SELECT id, participant_id, session_id, questionnaire_name, task_code,
                   item_key, value_numeric, value_text, submitted_at
            FROM questionnaire_responses
        """,
        "bonuses.parquet": """
            SELECT id, participant_id, session_id, task_code, reason, amount_minor, created_at
            FROM bonuses
        """,
        "chat_conversations.parquet": """
            SELECT id, participant_id, session_id, task_code, model, started_at, ended_at
            FROM chat_conversations
        """,
        "dashboard_events.parquet": f"""
            SELECT participant_id, session_id, task_code, ts, event_type, target,
                   client_ts_ms, t_perf_ms, seq, vp_w, vp_h, client_event_id,
                   payload::text            AS payload
            FROM dashboard_events
            {ts_filter}
            ORDER BY ts
        """,
        "chat_messages.parquet": f"""
            SELECT conversation_id, ts, role,
                   content, tokens, latency_ms, tool_name, tool_params, client_msg_id
            FROM chat_messages
            {ts_filter}
            ORDER BY ts
        """,
        "ui_events.parquet": f"""
            SELECT participant_id, session_id, task_code, ts,
                   surface, route, event_type, target,
                   client_ts_ms, t_perf_ms, seq, vp_w, vp_h, client_event_id,
                   payload::text            AS payload
            FROM ui_events
            {ts_filter}
            ORDER BY ts
        """,
        "chatbot_events.parquet": f"""
            SELECT participant_id, session_id, conversation_id, task_code, ts,
                   event_type, target,
                   client_ts_ms, t_perf_ms, seq, vp_w, vp_h, client_event_id,
                   payload::text            AS payload
            FROM chatbot_events
            {ts_filter}
            ORDER BY ts
        """,
    }

    for fname, sql in queries.items():
        _stream_query_to_parquet(sql, build_dir / fname)

    if ANALYTICS_PACKAGE == "dir":
        final_dir = ANALYTICS_DIR / f"{base}.analytics"
        if final_dir.exists(): shutil.rmtree(final_dir)
        build_dir.rename(final_dir)
        return final_dir

    # default: ZIP (Windows-native)
    out_zip = BACKUP_DIR / f"{base}.analytics.zip"
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(build_dir.iterdir()):
            z.write(p, arcname=p.name)
    # cleanup temp folder
    shutil.rmtree(build_dir, ignore_errors=True)
    return out_zip

# ------------ Main dump ------------
def dump_once():
    ensure_dirs()
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = f"{PGDATABASE}_{ts}"
    env=dict(os.environ)
    if PGPASSWORD: env["PGPASSWORD"]=PGPASSWORD

    # 1) pg_dump custom format (-Fc) with built-in compression (-Z 9) → one .dump file
    out_bin = BACKUP_DIR / f"{base}.dump"
    tmp_bin = BACKUP_DIR / f".{base}.dump.tmp"
    args = ["pg_dump","-h",PGHOST,"-p",PGPORT,"-U",PGUSER,"-d",PGDATABASE,"-Fc","-Z","9"]
    for pat in EXCLUDE_TABLES:      args += ["-T", pat]
    for pat in EXCLUDE_TABLE_DATA:  args += ["--exclude-table-data", pat]

    log.info("pg_dump -Fc -Z9 → %s", out_bin)
    with open(tmp_bin, "wb") as f:
        p = Popen(args, stdout=f, env=env)
        rc = p.wait()
    if rc != 0:
        tmp_bin.unlink(missing_ok=True)
        raise SystemExit(f"pg_dump failed rc={rc}")
    tmp_bin.rename(out_bin)
    _point_latest(out_bin, "latest.dump")

    # 2) Analytics (Parquet per table) → ZIP or folder
    if ANALYTICS:
        ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            out_an = export_analytics(base)
            if out_an.is_dir():
                (ANALYTICS_DIR / "latest.analytics.txt").write_text(out_an.name, encoding="utf-8")
            else:
                _point_latest(out_an, "latest.analytics.zip")
            log.info("Analytics bundle: %s", out_an)
        except Exception as e:
            log.warning("Analytics export failed: %s", e)

    # 3) Optional globals (roles etc.) as plain SQL.gz? Keep simple: skip by default.
    if DUMP_GLOBALS:
        out_globals = BACKUP_DIR / f"{base}.globals.sql"
        tmp_globals = BACKUP_DIR / f".{base}.globals.sql.tmp"
        with open(tmp_globals, "wb") as f:
            p = Popen(["pg_dumpall","-h",PGHOST,"-p",PGPORT,"-U",PGUSER,"--globals-only"], stdout=f, env=env)
            rc = p.wait()
        if rc == 0:
            tmp_globals.rename(out_globals)
        else:
            tmp_globals.unlink(missing_ok=True)
            log.warning("globals dump failed rc=%s", rc)

    rotate()

# ------------ Scheduler ------------
if __name__=="__main__":
    if RUN_ONCE:
        dump_once(); raise SystemExit(0)
    from apscheduler.schedulers.blocking import BlockingScheduler
    from apscheduler.triggers.cron import CronTrigger
    sched=BlockingScheduler(timezone="UTC")
    sched.add_job(dump_once, CronTrigger.from_crontab(CRON), max_instances=1, coalesce=True)
    log.info("Scheduler started CRON=%s", CRON)
    try: sched.start()
    except (KeyboardInterrupt, SystemExit): log.info("Exiting")
