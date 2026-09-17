-- Enable UUIDs
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- PARTICIPANTS
CREATE TABLE IF NOT EXISTS participants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prolific_pid       TEXT UNIQUE NOT NULL,
  prolific_study_id  TEXT,
  prolific_session_id TEXT,
  eligibility_status TEXT DEFAULT 'pending' CHECK (eligibility_status IN ('pending','eligible','ineligible')),
  ineligible_reason  TEXT,
  consented_at       TIMESTAMPTZ,
  consent_version    TEXT,
  status             TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','in_progress','completed','rejected','timed_out')),
  completed_at       TIMESTAMPTZ,
  completion_code    TEXT UNIQUE,
  prescreen_label    TEXT DEFAULT 'pass' CHECK (prescreen_label IN ('pass','review','exclude')),
  prescreen_notes    JSONB,
  attention_passed   BOOLEAN,
  attention_notes    JSONB,
  comprehension_passed   BOOLEAN,
  comprehension_notes    JSONB,
  ip_hash            TEXT,
  user_agent         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AUTH
CREATE TABLE IF NOT EXISTS auth_identities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id   UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  identifier       TEXT NOT NULL,
  secret_hash      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  UNIQUE (provider, identifier)
);

-- GROUP ASSIGNMENTS
CREATE TABLE IF NOT EXISTS group_assignments (
  participant_id     UUID PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  interface_cond     TEXT NOT NULL CHECK (interface_cond IN ('dashboard','chatbot')),
  data_lit_score     DOUBLE PRECISION,      -- numeric works too; double is simpler and fast
  familiarity_dashboard DOUBLE PRECISION,
  familiarity_chatbot  DOUBLE PRECISION,
  familiarity_index  DOUBLE PRECISION,
  assigned_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Helpful indexes when you monitor balance
CREATE INDEX IF NOT EXISTS idx_group_assignments_interface ON group_assignments(interface_cond);
CREATE INDEX IF NOT EXISTS idx_group_assignments_assigned_at ON group_assignments(assigned_at);


-- SESSIONS
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  write_token     TEXT
);
-- one open session per participant
CREATE UNIQUE INDEX IF NOT EXISTS ux_open_session_per_participant
ON sessions (participant_id) WHERE ended_at IS NULL;

-- TASK RESPONSES
CREATE TABLE IF NOT EXISTS task_responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_code       TEXT NOT NULL,
  complexity      INTEGER NOT NULL, -- integer level, per your design
  status          TEXT NOT NULL CHECK (status IN ('completed','overtime','aborted','skipped')),
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  duration_ms     INTEGER,
  accuracy_score  NUMERIC,
  answer          JSONB,
  metadata        JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_once ON task_responses (participant_id, task_code);
CREATE INDEX IF NOT EXISTS ix_task_session ON task_responses (session_id);

-- QUESTIONNAIRE RESPONSES
CREATE TABLE IF NOT EXISTS questionnaire_responses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id     UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id         UUID REFERENCES sessions(id) ON DELETE SET NULL,
  questionnaire_name TEXT NOT NULL,
  task_code          TEXT NOT NULL DEFAULT '',
  item_key           TEXT NOT NULL,
  value_numeric      INTEGER,
  value_text         TEXT,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_questionnaire_once
ON questionnaire_responses (participant_id, questionnaire_name, item_key, task_code);

CREATE INDEX IF NOT EXISTS idx_qr_part_qname_task
  ON questionnaire_responses (participant_id, questionnaire_name, task_code);

-- BONUSES
CREATE TABLE IF NOT EXISTS bonuses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id     UUID REFERENCES sessions(id) ON DELETE SET NULL,
  task_code      TEXT,
  reason         TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bonus_unique
  ON bonuses (participant_id, COALESCE(task_code,''), reason);

-- MACHINES
CREATE TABLE IF NOT EXISTS machines (
  id    TEXT PRIMARY KEY,
  name  TEXT,
  type  TEXT,
  meta  JSONB
);

-- MACHINE TIMESERIES (subset; extend as you need)
CREATE TABLE IF NOT EXISTS machine_timeseries (
  machine_id          TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  ts                  TIMESTAMPTZ NOT NULL,
  status              TEXT,
  working_time        INTEGER,
  idle_time           INTEGER,
  offline_time        INTEGER,
  alarm_time          INTEGER,
  avg_cycle_time      NUMERIC,
  avg_cycle_cost      NUMERIC,
  utilization_rate    NUMERIC,
  power               NUMERIC,
  consumption_total   NUMERIC,
  consumption_working NUMERIC,
  consumption_idle    NUMERIC,
  cycles              INTEGER,
  good_cycles         INTEGER,
  bad_cycles          INTEGER,
  alarm_start_count   INTEGER,
  oee                 NUMERIC,
  quality             NUMERIC,
  performance         NUMERIC,
  availability        NUMERIC,
  cost                NUMERIC,
  extras              JSONB,
  PRIMARY KEY (machine_id, ts)
);
CREATE INDEX IF NOT EXISTS ix_mts_ts ON machine_timeseries (ts);

-- 1) "Latest row per machine" (chatbot /machines/current status with DISTINCT ON)
CREATE INDEX IF NOT EXISTS ix_mts_latest_per_machine
  ON machine_timeseries (machine_id, ts DESC)
  INCLUDE (status);

-- 2) Time-first path for wide time windows across many machines
CREATE INDEX IF NOT EXISTS ix_mts_ts_machine
  ON machine_timeseries (ts, machine_id);

-- 3) BRIN to prune huge date ranges cheaply (complements the btrees above)
CREATE INDEX IF NOT EXISTS brin_mts_ts
  ON machine_timeseries USING BRIN (ts) WITH (pages_per_range = 64);

-- 4) Covering index for "time/status" KPIs (sums of time columns, alarm starts)
CREATE INDEX IF NOT EXISTS ix_mts_status_cover
  ON machine_timeseries (ts, machine_id)
  INCLUDE (working_time, idle_time, offline_time, alarm_time, alarm_start_count);

-- 5) Covering index for "energy & cost" KPIs (avg power, delta/working/idle consumption, cost)
CREATE INDEX IF NOT EXISTS ix_mts_energy_cover
  ON machine_timeseries (ts, machine_id)
  INCLUDE (power, consumption_total, consumption_working, consumption_idle, cost);

-- 6) (Optional, add only if productivity/efficiency queries are hot)
--    Large covering index for cycles/oee/quality/performance/availability
CREATE INDEX IF NOT EXISTS ix_mts_prod_cover
  ON machine_timeseries (ts, machine_id)
  INCLUDE (cycles, good_cycles, bad_cycles, oee, quality, performance, availability, avg_cycle_time, cost);

-- =========================

-- === GROUND-TRUTH LOOKUP (name-based) ===
CREATE TABLE IF NOT EXISTS decision_ground_truth (
  task_code TEXT NOT NULL CHECK (task_code IN ('T1','T2','T3')),

  -- names exactly as in CSV
  cutting_best_response     TEXT,  -- T2
  cutting_second_response   TEXT,  -- T2
  maintenance_name_response TEXT,  -- T3
  process_name_response     TEXT,  -- T3
  quality_name_response     TEXT,  -- T3

  -- T1 date
  date_response DATE,

  decision_score DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- IMMUTABLE-only key: lower+btrim on names; YYYYMMDD as integer→text
  key TEXT GENERATED ALWAYS AS (
    task_code || '|' ||
    lower(btrim(coalesce(cutting_best_response,'')))     || '|' ||
    lower(btrim(coalesce(cutting_second_response,'')))     || '|' ||
    lower(btrim(coalesce(maintenance_name_response,''))) || '|' ||
    lower(btrim(coalesce(process_name_response,'')))     || '|' ||
    lower(btrim(coalesce(quality_name_response,'')))     || '|' ||
    CASE WHEN date_response IS NULL THEN ''
         ELSE (
           (
             (extract(year  from date_response)::int * 10000) +
             (extract(month from date_response)::int * 100) +
             (extract(day   from date_response)::int)
           )::text
         )
    END
  ) STORED,
  PRIMARY KEY (key),

  CONSTRAINT gt_fields_valid CHECK (
    (task_code='T1'
      AND date_response IS NOT NULL
      AND cutting_best_response IS NULL
      AND cutting_second_response IS NULL
      AND maintenance_name_response IS NULL
      AND process_name_response IS NULL
      AND quality_name_response IS NULL)
    OR
    (task_code='T2'
      AND cutting_best_response IS NOT NULL
      AND cutting_second_response IS NOT NULL
      AND date_response IS NULL
      AND maintenance_name_response IS NULL
      AND process_name_response IS NULL
      AND quality_name_response IS NULL)
    OR
    (task_code='T3'
      AND maintenance_name_response IS NOT NULL
      AND process_name_response IS NOT NULL
      AND quality_name_response IS NOT NULL
      AND date_response IS NULL
      AND cutting_best_response IS NULL
      AND cutting_second_response IS NULL)
  )
);

-- Matching expression indexes for fast lookups
CREATE INDEX IF NOT EXISTS gt_t1_lookup ON decision_ground_truth (task_code, date_response) WHERE task_code='T1';

CREATE INDEX IF NOT EXISTS gt_t2_lookup ON decision_ground_truth (
  task_code,
  lower(btrim(cutting_best_response)),
  lower(btrim(cutting_second_response))
) WHERE task_code='T2';

CREATE INDEX IF NOT EXISTS gt_t3_lookup ON decision_ground_truth (
  task_code,
  lower(btrim(maintenance_name_response)),
  lower(btrim(process_name_response)),
  lower(btrim(quality_name_response))
) WHERE task_code='T3';


-- UI EVENTS (non-dashboard; append-only)
CREATE TABLE IF NOT EXISTS ui_events (
  id              BIGSERIAL PRIMARY KEY,
  participant_id  UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_code       TEXT,

  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server time
  surface         TEXT NOT NULL,                       -- e.g., 'questionnaire','familiarization','intro','end'
  route           TEXT,                                -- e.g., '/nasa-tlx' or 'NasaTlx'
  event_type      TEXT NOT NULL,                       -- e.g., 'page_view','click','item_change','submit','focus','blur'
  target          TEXT,                                -- CSS selector / data-testid / logical id

  client_ts_ms    BIGINT,                              -- Date.now() from client
  t_perf_ms       DOUBLE PRECISION,                    -- performance.now()
  seq             INTEGER,                             -- client sequence number (monotonic per page)
  vp_w            INTEGER,
  vp_h            INTEGER,
  client_event_id TEXT,                                -- UUID from client for dedupe

  payload         JSONB
);

CREATE INDEX IF NOT EXISTS ix_ue_session_ts ON ui_events (session_id, ts);
CREATE INDEX IF NOT EXISTS ix_ue_part_ts    ON ui_events (participant_id, ts);
CREATE INDEX IF NOT EXISTS ix_ue_surface_ts ON ui_events (surface, ts);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ue_dedupe
  ON ui_events (participant_id, client_event_id)
  WHERE client_event_id IS NOT NULL;



-- DASHBOARD EVENTS (append-only)
CREATE TABLE IF NOT EXISTS dashboard_events (
  id              BIGSERIAL PRIMARY KEY,
  participant_id  UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_code       TEXT,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      TEXT NOT NULL,
  target          TEXT,
  client_ts_ms    BIGINT,
  t_perf_ms       DOUBLE PRECISION,
  seq             INTEGER,
  vp_w            INTEGER,
  vp_h            INTEGER,
  client_event_id TEXT,
  payload         JSONB
);
CREATE INDEX IF NOT EXISTS ix_de_session_ts ON dashboard_events (session_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS ux_de_dedupe
  ON dashboard_events (participant_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

-- CHAT
CREATE TABLE IF NOT EXISTS chat_conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  task_code      TEXT NOT NULL,
  model          TEXT,
  meta           JSONB
);

-- One open conversation per (participant, session, task_code)
CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_open_by_task
  ON chat_conversations (participant_id, session_id, task_code)
  WHERE ended_at IS NULL;

-- Fast lookup / analytics
CREATE INDEX IF NOT EXISTS ix_cc_part_sess_task_started
  ON chat_conversations (participant_id, session_id, task_code, started_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  role             TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content          TEXT,
  tokens           INTEGER,
  latency_ms       INTEGER,
  tool_name        TEXT,
  tool_params      TEXT,
  raw              JSONB,
  client_msg_id    TEXT,
  CONSTRAINT ux_cm_client_id UNIQUE (client_msg_id) 
);
CREATE INDEX IF NOT EXISTS ix_cm_conv_ts ON chat_messages (conversation_id, ts);


-- CHATBOT UI EVENTS
CREATE TABLE IF NOT EXISTS public.chatbot_events (
  id              BIGSERIAL PRIMARY KEY,
  participant_id  UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
  task_code       TEXT,

  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      TEXT NOT NULL,
  target          TEXT,

  client_ts_ms    BIGINT,
  t_perf_ms       DOUBLE PRECISION,
  seq             INTEGER,
  vp_w            INTEGER,
  vp_h            INTEGER,
  client_event_id TEXT,
  payload         JSONB
);

CREATE INDEX IF NOT EXISTS ix_ce_conv_ts    ON chatbot_events (conversation_id, ts);
CREATE INDEX IF NOT EXISTS ix_ce_session_ts ON chatbot_events (session_id, ts);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ce_dedupe
  ON chatbot_events (participant_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
