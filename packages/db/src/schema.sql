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

-- Reusable named users, each with their OWN captured Microsoft/Teams login
-- (as opposed to the one shared master profile every group can seed from).
-- The password is encrypted at rest with pgcrypto (enabled above); the key
-- lives only in the api process's CREDENTIALS_ENC_KEY env var, never here.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_enc BYTEA NOT NULL,
  -- The login-capture job this user is currently signing into, if any —
  -- mirrors groups.active_job_id, so Add-user/Re-sign-in can't be fired
  -- twice concurrently for the same user.
  active_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

-- A group's additional roster: real, reusable users linked in alongside the
-- existing free-text user_names. Additive — legacy groups with only
-- user_names keep working unchanged; user_ids is simply empty for them.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS user_ids JSONB NOT NULL DEFAULT '[]';

-- Reusable step scripts, so a group's Task doesn't have to be retyped every
-- time — pick one from the list when creating/editing a group.
CREATE TABLE IF NOT EXISTS step_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  steps JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A starting "Join meeting" template: works whether the session is a typed
-- guest name (userNames) or an already-authenticated linked user (userIds)
-- — the two "if visible" steps are exactly the no-op-when-absent behavior
-- that makes one script cover both without failing either path. Only
-- inserted once; freely editable afterward from Settings.
INSERT INTO step_templates (id, name, steps)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Join meeting',
  '["open {{url}}", "click if visible \"Continue on this browser\"", "click if visible \"Continue without audio or video\"", "fill if visible \"Type your name\" with {{name}}", "click \"Join\""]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- The script "Add user" runs to capture a Microsoft/Teams login: fills
-- email + password, handles the "Use your password" tile and "Stay signed
-- in?" when Microsoft shows them (both optional — see the two "if visible"
-- forms above), then stops for 2FA to be finished by hand. Editable here
-- like any other template; packages/api/src/routes/users.ts reads this row
-- by id at launch time, falling back to a hardcoded copy only if it's ever
-- deleted.
INSERT INTO step_templates (id, name, steps)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'Auto login',
  '["open https://teams.microsoft.com/", "fill \"Email, phone, or Skype\" with {{email}}", "click \"Next\"", "wait for 2 seconds", "click if visible \"Use your password\"", "wait for 1 seconds", "fill \"Password\" with {{password}}", "click \"Sign in\"", "wait for 2 seconds", "click if visible \"Yes\""]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Organizations: the top of the company → department → people hierarchy the
-- Organizations tab is built around. A group (department) belongs to one
-- organization; a user belongs to one organization and is linked into any
-- number of that organization's groups.
--
-- Both foreign keys are nullable and SET NULL rather than CASCADE. Groups
-- and users existed before organizations did, so "no organization" has to
-- stay a valid state — those show up under "Unassigned" in the UI instead
-- of disappearing. Deleting an organization that still holds anything is
-- refused at the API layer (see packages/api/src/routes/organizations.ts);
-- SET NULL is only the safety net behind that check.
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- Free-text, shown under the name on the org rail. Somewhere to put "US
  -- east coast clients" without inventing a field per use case.
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive: "Acme" and "acme" as two organizations is a mistake,
-- not a distinction, and the error is far easier to understand at creation
-- time than a duplicated rail six months later.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_name ON organizations (lower(name));

ALTER TABLE groups ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_groups_organization_id ON groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);
