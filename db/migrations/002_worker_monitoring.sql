-- 002: worker monitoring, pause/resume, usage-limit waiting, one-at-a-time queue.
-- Additive only (no drops, no rewrites); safe to run while the current app is live and safe to re-run.
-- Run as the schema owner (Supabase "postgres"); the app role bom_app only gets DML.

-- Worker heartbeat (POST /api/worker/heartbeat every 60 s)
ALTER TABLE bom.worker_heartbeat
  ADD COLUMN IF NOT EXISTS node_version   text,
  ADD COLUMN IF NOT EXISTS claude_version text,
  ADD COLUMN IF NOT EXISTS login_ok       boolean,      -- claude.ai login still valid (null = unknown)
  ADD COLUMN IF NOT EXISTS login_detail   text,
  ADD COLUMN IF NOT EXISTS last_poll      timestamptz,  -- last GET /api/worker/next
  ADD COLUMN IF NOT EXISTS last_error     text,
  ADD COLUMN IF NOT EXISTS limit_until    timestamptz,  -- Claude plan usage limit resets at
  ADD COLUMN IF NOT EXISTS started_at     timestamptz;  -- worker process start

-- Pages: new status 'waiting_limit' (status is plain text, no constraint to change)
ALTER TABLE bom.job_pages
  ADD COLUMN IF NOT EXISTS retry_at    timestamptz,     -- waiting_limit: claimable again from here
  ADD COLUMN IF NOT EXISTS duration_ms integer,         -- Claude Code time for the final attempt
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;     -- reached done / error

CREATE INDEX IF NOT EXISTS job_pages_queue_idx ON bom.job_pages (status, retry_at);

-- Global switches (single row)
CREATE TABLE IF NOT EXISTS bom.settings (
  id        int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paused    boolean NOT NULL DEFAULT false,
  paused_by text,
  paused_at timestamptz
);
INSERT INTO bom.settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Alerts: one open row per kind at most (offline | logout | usage_limit)
CREATE TABLE IF NOT EXISTS bom.worker_alerts (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  message     text NOT NULL,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notified_at timestamptz                               -- set when an email/notification was sent
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_alerts_one_open ON bom.worker_alerts (kind) WHERE resolved_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON bom.settings, bom.worker_alerts TO bom_app;
GRANT USAGE, SELECT ON SEQUENCE bom.worker_alerts_id_seq TO bom_app;
