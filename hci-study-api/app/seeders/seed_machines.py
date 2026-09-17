# hci-study-api/app/seeders/seed_machines.py
import os, sys, json, math, glob, datetime
import numpy as np
import pandas as pd
import psycopg
from psycopg.rows import tuple_row
from psycopg.types.json import Jsonb
from dotenv import load_dotenv

load_dotenv()

DB_CONNINFO = {
    "host": os.environ.get("DB_HOST", "localhost"),
    "port": int(os.environ.get("DB_PORT", "5432")),
    "dbname": os.environ.get("DB_NAME", "hci_study"),
    "user": os.environ.get("DB_USER", "hci"),
    "password": os.environ.get("DB_PASSWORD", ""),
}
DATA_DIR = os.environ.get("SEED_DATA_DIR", "/seed_data")
DECISIONS_CSV = os.path.join(DATA_DIR, "decision_ground_truth.csv")

# ----- helpers -----
def none_if_nan(x):
    # Keep None as None; coerce NaN/NaT to None; pass everything else through
    if x is None:
        return None
    try:
        if pd.isna(x):
            return None
    except Exception:
        pass
    return x

def to_int_or_none(x):
    x = none_if_nan(x)
    if x is None:
        return None
    try:
        return int(round(float(x)))
    except Exception:
        return None

def infer_status(row):
    # Choose the state with the longest time in the 15m slot (break ties deterministically)
    wt = to_int_or_none(row.get("working_time")) or 0
    it = to_int_or_none(row.get("idle_time")) or 0
    ot = to_int_or_none(row.get("offline_time")) or 0
    at = to_int_or_none(row.get("alarm_time")) or 0
    pairs = [("alarm", at), ("working", wt), ("idle", it), ("offline", ot)]
    pairs.sort(key=lambda kv: kv[1], reverse=True)
    return pairs[0][0] if pairs[0][1] > 0 else "offline"

def to_jsonable(v):
    # pandas Timestamp → UTC ISO string
    if isinstance(v, pd.Timestamp):
        if v.tz is not None:
            v = v.tz_convert("UTC")
        else:
            v = v.tz_localize("UTC")
        return v.isoformat()
    # datetime/date → ISO
    if isinstance(v, (datetime.datetime, datetime.date)):
        # keep timezone if present; otherwise treat as UTC-naive ISO
        return v.isoformat()
    # numpy scalars
    if isinstance(v, (np.generic,)):
        return v.item()
    # pandas NaT / NaN
    if v is pd.NaT or (isinstance(v, float) and math.isnan(v)):
        return None
    # sets / tuples
    if isinstance(v, (set, tuple)):
        return list(v)
    return v

def normalize_meta(meta: dict) -> dict:
    return {k: to_jsonable(v) for k, v in meta.items()}

EXTRA_COLS = [
    "consumption_offline","consumption_alarm","consumption_maintenance",
    "maintenance","alarm_standard","alarm_from_work","alarm_from_idle",
    "alarm_from_off","ideal_cycle_time"
]

def load_one_pkl(cur, pkl_path: str):
    blob = pd.read_pickle(pkl_path)
    if not isinstance(blob, dict) or "data" not in blob:
        print(f"[WARN] {pkl_path} skipped: not a dict with 'data' key")
        return 0

    machine_id   = blob.get("machine_id")
    machine_name = blob.get("machine_name") or machine_id
    mtype        = blob.get("type") or "Production machine"  # fallback

    # everything except 'data' goes into meta
    meta = {k: v for k, v in blob.items() if k != "data"}
    meta.pop("machine_id", None)
    meta.pop("machine_name", None)
    meta.pop("type", None)
    meta = normalize_meta(meta)

    # Upsert machine
    cur.execute(
        """
        INSERT INTO machines (id, name, type, meta)
        VALUES (%s,%s,%s,%s)
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, type = EXCLUDED.type, meta = EXCLUDED.meta
        """,
        (machine_id, machine_name, mtype, Jsonb(meta))
    )

    df = blob["data"].copy()
    # Ensure tz-aware index → UTC
    if df.index.tz is None:
        raise ValueError(f"{pkl_path}: DataFrame index is not tz-aware")
    df.index = df.index.tz_convert("UTC")
    idx_name = df.index.name or "index"
    df = df.reset_index().rename(columns={idx_name: "ts"})

    # Remove any stray machine_id column inside the DF; we'll set it explicitly
    if "machine_id" in df.columns:
        df = df.drop(columns=["machine_id"])

    # Map columns → DB schema
    rename_map = {
        "average_cycle_time": "avg_cycle_time",
        "consumption": "consumption_total",
    }
    df = df.rename(columns=rename_map)

    # Build rows
    rows = []
    for rec in df.to_dict(orient="records"):
        ts = pd.to_datetime(rec["ts"]).to_pydatetime()  # tz-aware UTC
        rec["status"] = infer_status(rec)

        extras = {k: none_if_nan(rec.get(k)) for k in EXTRA_COLS if k in rec}
        extras = {k: to_jsonable(v) for k, v in extras.items()}

        row = (
            machine_id,
            ts,
            rec.get("status"),
            to_int_or_none(rec.get("working_time")),
            to_int_or_none(rec.get("idle_time")),
            to_int_or_none(rec.get("offline_time")),
            to_int_or_none(rec.get("alarm_time")),
            to_int_or_none(rec.get("alarm_start_count")),
            none_if_nan(rec.get("avg_cycle_time")),
            none_if_nan(rec.get("avg_cycle_cost")),
            none_if_nan(rec.get("power")),
            none_if_nan(rec.get("consumption_total")),
            none_if_nan(rec.get("consumption_working")),
            none_if_nan(rec.get("consumption_idle")),
            to_int_or_none(rec.get("cycles")),
            to_int_or_none(rec.get("good_cycles")),
            to_int_or_none(rec.get("bad_cycles")),
            none_if_nan(rec.get("oee")),
            none_if_nan(rec.get("quality")),
            none_if_nan(rec.get("performance")),
            none_if_nan(rec.get("availability")),
            none_if_nan(rec.get("utilization_rate")),
            none_if_nan(rec.get("cost")),
            Jsonb(extras),
        )
        rows.append(row)

    # Bulk insert in chunks
    sql = """
    INSERT INTO machine_timeseries
    (machine_id, ts, status, working_time, idle_time, offline_time, alarm_time, alarm_start_count,
     avg_cycle_time, avg_cycle_cost, power, consumption_total, consumption_working, consumption_idle,
     cycles, good_cycles, bad_cycles, oee, quality, performance, availability, utilization_rate, cost, extras)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (machine_id, ts) DO NOTHING
    """
    BATCH = 10_000
    inserted = 0
    for i in range(0, len(rows), BATCH):
        cur.executemany(sql, rows[i:i+BATCH])
        inserted += len(rows[i:i+BATCH])
    return inserted

def _clean_str(x):
    if x is None:
        return None
    s = str(x).strip()
    return s if s else None

def _parse_date_maybe(x):
    """Accept YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DDMMYYYY, etc. Return date() or None."""
    x = _clean_str(x)
    if not x:
        return None
    try:
        # 8 digits → DDMMYYYY
        if len(x) == 8 and x.isdigit():
            return datetime.datetime.strptime(x, "%d%m%Y").date()
        # ISO
        try:
            return datetime.date.fromisoformat(x)
        except Exception:
            pass
        # Common European formats
        for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y"):
            try:
                return datetime.datetime.strptime(x, fmt).date()
            except Exception:
                continue
        # Fallback to pandas parser
        return pd.to_datetime(x, dayfirst=True, errors="coerce").date()  # type: ignore
    except Exception:
        return None

def seed_decision_ground_truth(cur, csv_path: str) -> int:
    """
    Load /seed_data/decision_ground_truth.csv into decision_ground_truth.
    Columns expected (header names are case-sensitive here):
      task_code,cutting_best_response,cutting_second_response,maintenance_name_response,process_name_response,
      quality_name_response,date_response,decision_score
    """
    if not os.path.isfile(csv_path):
        print(f"[seed][GT] {csv_path} not found; skipping.")
        return 0

    try:
        df = pd.read_csv(csv_path, dtype=str).fillna("")
    except Exception as e:
        print(f"[seed][GT][ERROR] reading CSV: {e}", file=sys.stderr)
        return 0

    rows = []
    for i, r in df.iterrows():
        task_code = _clean_str(r.get("task_code"))
        if task_code:
            task_code = task_code.upper()
        c_best = _clean_str(r.get("cutting_best_response"))
        c_second = _clean_str(r.get("cutting_second_response"))
        maint  = _clean_str(r.get("maintenance_name_response"))
        proc   = _clean_str(r.get("process_name_response"))
        qual   = _clean_str(r.get("quality_name_response"))
        date_v = _parse_date_maybe(r.get("date_response"))
        try:
            decision_score = float(r.get("decision_score"))
        except Exception:
            print(f"[seed][GT][WARN] row {i}: invalid decision_score '{r.get('decision_score')}', defaulting 0.")
            decision_score = 0.0

        # Basic per-task validation to satisfy CHECK constraint
        ok = (
            (task_code == "T1" and date_v is not None and not any([c_best, c_second, maint, proc, qual])) or
            (task_code == "T2" and c_best, c_second is not None and date_v is None and not any([maint, proc, qual])) or
            (task_code == "T3" and all([maint, proc, qual]) and date_v is None and c_best, c_second is None)
        )
        if not ok:
            print(f"[seed][GT][WARN] row {i}: fields don't match task_code={task_code}; skipping.")
            continue

        rows.append((
            task_code, c_best, c_second, maint, proc, qual, date_v, decision_score
        ))

    if not rows:
        print("[seed][GT] no valid rows to insert; skipping.")
        return 0

    sql = """
    INSERT INTO decision_ground_truth
      (task_code, cutting_best_response, cutting_second_response,
       maintenance_name_response, process_name_response, quality_name_response,
       date_response, decision_score)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (key) DO UPDATE
      SET decision_score = EXCLUDED.decision_score,
          created_at     = now()
    """
    cur.executemany(sql, rows)
    return len(rows)


def main():
    if not os.path.isdir(DATA_DIR):
        print(f"[ERROR] SEED_DATA_DIR not found: {DATA_DIR}", file=sys.stderr)
        sys.exit(1)

    with psycopg.connect(**DB_CONNINFO, autocommit=False) as conn:
        conn.execute("SET TIME ZONE 'UTC'")
        with conn.cursor(row_factory=tuple_row) as cur:
            # Ensure schema exists
            cur.execute("""
                SELECT to_regclass('public.machines') IS NOT NULL
                   AND to_regclass('public.machine_timeseries') IS NOT NULL
                   AND to_regclass('public.decision_ground_truth') IS NOT NULL
            """)
            ok = cur.fetchone()[0]
            if not ok:
                print("[ERROR] Schema not found. Did init.sql run (incl. decision_ground_truth)?", file=sys.stderr)
                sys.exit(1)

            # Seed machine timeseries only if empty (idempotent guard)
            cur.execute("SELECT EXISTS(SELECT 1 FROM machine_timeseries)")
            mts_exists = cur.fetchone()[0]
            inserted = 0
            if mts_exists:
                print("[seed] machine_timeseries already populated; skipping timeseries.")
            else:
                total = 0
                for pkl in sorted(glob.glob(os.path.join(DATA_DIR, "*.pkl"))):
                    print(f"[seed] Loading {os.path.basename(pkl)} ...")
                    try:
                        n = load_one_pkl(cur, pkl)
                        total += n
                        conn.commit()
                    except Exception as e:
                        conn.rollback()
                        print(f"[ERROR] {pkl}: {e}", file=sys.stderr)
                        sys.exit(1)
                inserted = total
                print(f"[seed] Done. Inserted {inserted} timeseries rows.")

            # Always upsert decision ground truth (name-based)
            try:
                n_gt = seed_decision_ground_truth(cur, DECISIONS_CSV)
                conn.commit()
                print(f"[seed][GT] Upserted {n_gt} ground-truth rows from {os.path.basename(DECISIONS_CSV)}.")
            except Exception as e:
                conn.rollback()
                print(f"[seed][GT][ERROR] {e}", file=sys.stderr)
                sys.exit(1)

    print("[seed] Completed successfully.")


if __name__ == "__main__":
    main()
