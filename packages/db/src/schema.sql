CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  steps JSONB NOT NULL,
  concurrency INT NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_index INT NOT NULL,
  user_name TEXT NOT NULL,
  row_data JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  current_step_index INT NOT NULL DEFAULT -1,
  current_step_text TEXT,
  total_steps INT NOT NULL DEFAULT 0,
  error TEXT,
  video_wait_started_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_job_id ON sessions(job_id);

CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_session_events_job_id ON session_events(job_id, ts);

-- Scheduled groups: a saved link + task + user roster that the API's
-- scheduler launches by itself on a daily wall-clock window. Times are
-- stored as plain "HH:MM" text plus an IANA zone rather than TIMESTAMPTZ:
-- the intent is "5 PM local, every day", which is a wall-clock rule, not a
-- fixed instant — storing an instant would drift across DST.
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  steps JSONB NOT NULL,
  user_names JSONB NOT NULL DEFAULT '[]',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  -- Weekdays the window opens on, 0 = Sunday … 6 = Saturday. Defaults to
  -- every day, which is how groups behaved before days were selectable.
  days JSONB NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  timezone TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  active_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  -- Whether the held run was started by hand ("Run now") rather than by the
  -- clock. The scheduler only stops runs it started itself, so an ad-hoc
  -- run outside the window isn't killed by the next tick.
  active_job_manual BOOLEAN NOT NULL DEFAULT false,
  last_occurrence_key TEXT,
  last_started_at TIMESTAMPTZ,
  last_stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lets a job page say which group spawned it (and survives the group being
-- deleted, hence SET NULL rather than CASCADE).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_group_id ON jobs(group_id);

-- Groups created before weekday selection / manual-run tracking existed.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS days JSONB NOT NULL DEFAULT '[0,1,2,3,4,5,6]';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS active_job_manual BOOLEAN NOT NULL DEFAULT false;

-- How many minutes before start_time the run should actually begin, so the
-- browsers are logged in and settled before the event itself starts.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS lead_minutes INT NOT NULL DEFAULT 0;

-- Admin-configurable settings (proxy, SMTP, browser defaults). Key/value
-- rather than columns so adding a setting never needs a migration.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Everything worth telling someone about: failures, timeouts, and the
-- lifecycle events around them. Carries enough context (which user, which
-- group, which run) that an alert email can say where the problem happened
-- rather than just that one did.
CREATE TABLE IF NOT EXISTS system_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL DEFAULT 'INFO',
  source TEXT NOT NULL DEFAULT 'system',
  message TEXT NOT NULL,
  error_trace TEXT,
  job_id UUID,
  session_id UUID,
  user_name TEXT,
  group_name TEXT,
  alert_sent BOOLEAN NOT NULL DEFAULT false,
  alert_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level, created_at DESC);
