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

-- Reusable named users, each with their OWN captured Microsoft/Teams login.
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

-- Superseded by idx_users_email_per_account further down: uniqueness is
-- per workspace now, not global. Recreating the global one here would fail
-- the moment two accounts share a person's email — and since this file is
-- replayed on every boot, that would be an unbootable server, not a
-- rejected write. Left as a note rather than a statement.


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
-- Superseded by idx_organizations_name_per_account (see the note on
-- idx_users_email above): two companies may both have an "Acme".


ALTER TABLE groups ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_groups_organization_id ON groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);

-- Which creation flow a template is THE default for: 'group' prefills a new
-- group's Task, 'user' is the sign-in script "Add user" runs. NULL for every
-- other template.
--
-- The partial unique index is what makes "the default" unambiguous: at most
-- one row can hold each scope, so setting a new default has to release the
-- old one rather than quietly leaving two.
ALTER TABLE step_templates ADD COLUMN IF NOT EXISTS default_for TEXT;

-- Superseded by idx_step_templates_default_per_account: each workspace
-- picks its own defaults, so "one row per scope" is per account.


-- Adopt the two seeded templates as the starting defaults, but only if
-- nothing already claims the scope — a real choice made in Settings must
-- never be overwritten by a later migration run.
--
-- 'user' preserves existing behaviour exactly: "Add user" already ran the
-- Auto login row by fixed id. 'group' matters more than it looks — a group's
-- Task is required, and the Task field now lives under a collapsed Advanced
-- section, so without a group default a new group could not be saved without
-- expanding it first.
UPDATE step_templates SET default_for = 'user'
 WHERE id = '00000000-0000-0000-0000-000000000002'
   AND NOT EXISTS (SELECT 1 FROM step_templates WHERE default_for = 'user');

UPDATE step_templates SET default_for = 'group'
 WHERE id = '00000000-0000-0000-0000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM step_templates WHERE default_for = 'group');

-- ============================================================
-- Accounts: who may sign into this platform at all.
--
-- Deliberately NOT the same thing as the `users` table. A row in `users` is
-- a PERSON an automation signs in AS (their Microsoft/Teams identity, added
-- to groups); a row here is a LOGIN to this dashboard. The two were briefly
-- given the same name and it was confusing enough to be worth the split.
--
-- Each account owns its own organizations, groups and people — see the
-- account_id columns further down. Nobody sees anyone else's.
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Both are login identities; either one gets you in. Email is also where
  -- a password reset is sent, so it is required even for the admin.
  email TEXT NOT NULL,
  username TEXT,
  name TEXT NOT NULL,
  -- What their space is called in the UI ("Nexa"). Distinct from the
  -- organizations they create inside it.
  workspace_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  -- Free text from the signup form: what they intend to use it for. Kept
  -- because it is the whole basis on which a signup is approved.
  purpose TEXT NOT NULL DEFAULT '',
  -- scrypt, stored as "scrypt$N$r$p$salt$hash" — see packages/api/src/auth/password.ts.
  -- No plaintext password is ever written to this table.
  password_hash TEXT NOT NULL,
  -- 'admin' sees every account and approves signups; 'owner' sees only
  -- their own workspace.
  role TEXT NOT NULL DEFAULT 'owner',
  -- 'pending' cannot log in — a signup waits here until an admin approves.
  status TEXT NOT NULL DEFAULT 'pending',
  approved_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (lower(email));
-- Partial: most accounts sign in by email and have no username at all, and
-- several NULLs must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username
  ON accounts (lower(username)) WHERE username IS NOT NULL;

-- Long-lived logins. The cookie carries a random token; only its SHA-256
-- lands here, so a database leak cannot be replayed as a live session.
-- Named auth_sessions because `sessions` already means "one browser a
-- worker is driving", which is an entirely different thing.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions(account_id);

-- Single-use, short-lived password reset links. Same hash-only rule as
-- sessions: the emailed token is never stored, so the table cannot be used
-- to take over an account.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_account ON password_resets(account_id);

-- ---------- tenancy ----------
-- Every tenant-owned table carries the account that owns it. CASCADE:
-- deleting an account takes its whole workspace with it, which is the only
-- coherent meaning of deleting an account when the data is private to it.
--
-- Nullable so the migration can run against a database that already has
-- rows; the first boot adopts every orphan row into the seeded owner
-- account (see adoptOrphanData in packages/api/src/auth/seed.ts).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE groups        ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE users         ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE step_templates ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE jobs          ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE system_logs   ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_organizations_account ON organizations(account_id);
CREATE INDEX IF NOT EXISTS idx_groups_account ON groups(account_id);
CREATE INDEX IF NOT EXISTS idx_users_account ON users(account_id);
CREATE INDEX IF NOT EXISTS idx_step_templates_account ON step_templates(account_id);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_system_logs_account ON system_logs(account_id);

-- Uniqueness is now per-workspace, not global: two different companies must
-- both be able to have an "IT department" person on ravi@example.com, and
-- an organization called "Acme". The old global unique indexes would have
-- made one tenant's data block another's.
DROP INDEX IF EXISTS idx_users_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_per_account ON users (account_id, lower(email));

DROP INDEX IF EXISTS idx_organizations_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_name_per_account
  ON organizations (account_id, lower(name));

-- Same for a template's default scope: each workspace picks its own.
DROP INDEX IF EXISTS idx_step_templates_default_for;
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_templates_default_per_account
  ON step_templates (account_id, default_for) WHERE default_for IS NOT NULL;

-- Repairs runs launched by "Join now" before that path passed an account.
-- They were written with account_id NULL, which made every account-scoped
-- read of them fail — the live view in particular, whose WebSocket checks
-- ownership before it will stream anything. A group already knows which
-- workspace it belongs to, so the run can be handed back to it exactly.
UPDATE jobs j
   SET account_id = g.account_id
  FROM groups g
 WHERE j.group_id = g.id
   AND j.account_id IS NULL
   AND g.account_id IS NOT NULL;

-- ============================================================
-- Assignments: the Assessment / Quiz module.
--
-- Everything here hangs off the tables that already exist — an assessment
-- is run BY a `users` row, FOR an `organizations` row, launched as a normal
-- `jobs` row by a normal `groups` row, and logged through the same
-- `session_events`. Nothing below duplicates a person, a schedule or a run;
-- these tables only hold what the existing ones have no place for: what a
-- person has and hasn't been asked, and what they answered.
-- ============================================================

-- ---------- templates gain a format ----------
-- The original plain-English script is 'plain', and a row that predates this
-- column reads as exactly that, so every existing template keeps working
-- untouched. 'json' and 'typescript' keep their source in `body`; both still
-- reduce to the same normalized workflow the plain script does.
ALTER TABLE step_templates ADD COLUMN IF NOT EXISTS template_type TEXT NOT NULL DEFAULT 'plain';
ALTER TABLE step_templates ADD COLUMN IF NOT EXISTS body TEXT;

-- The portal configuration for an assessment template: which selector finds
-- the quiz list, the question, the options, Next, Submit, the result.
-- Deliberately empty until the real portal is supplied — see
-- packages/shared/src/portalConfig.ts, which defines every field.
ALTER TABLE step_templates ADD COLUMN IF NOT EXISTS assessment JSONB;

CREATE INDEX IF NOT EXISTS idx_step_templates_type ON step_templates(account_id, template_type);

-- ---------- groups can be assessment groups ----------
-- Not a second kind of group: the same roster, days, window, timezone,
-- lead, Join now and the same scheduler. This only decides which runner the
-- job it launches routes to, which is what keeps one cron in the system.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS assessment_template_id UUID
  REFERENCES step_templates(id) ON DELETE SET NULL;

-- ---------- jobs know which runner to use ----------
-- Existing rows read as 'automation', which is what they are. Before this,
-- "is this a login capture?" was inferred from the job's NAME; a real column
-- is what lets a third kind exist without that trick growing.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'automation';
-- The portal config as it stood when the run was launched. Snapshotted
-- rather than looked up so editing a template mid-run cannot change what a
-- quiz already in progress is doing.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assessment JSONB;

-- ---------- a person's assessment state, carried between runs ----------
-- Distinct from their BROWSER profile (cookies and a login, on disk in the
-- worker's volume). This is what they have and haven't done — the durable
-- answer to "what is left?" that survives a worker restart, which is the
-- whole reason it is in Postgres and not in memory.
CREATE TABLE IF NOT EXISTS assessment_profiles (
  person_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  last_assessment_run TIMESTAMPTZ,
  last_successful_run TIMESTAMPTZ,
  total_quizzes INT NOT NULL DEFAULT 0,
  completed_quizzes INT NOT NULL DEFAULT 0,
  pending_quizzes INT NOT NULL DEFAULT 0,
  failed_quizzes INT NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_profiles_account ON assessment_profiles(account_id);

-- ---------- one quiz, as it stands for one person ----------
-- `portal_status` is what the portal last told us; `internal_status` is what
-- we did about it. Kept apart on purpose: that split is what lets a run
-- notice "the portal says submitted, we have no record" and fix OUR side
-- instead of retaking someone's quiz.
CREATE TABLE IF NOT EXISTS assessment_quizzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The portal's own id where it exposes one, else the quiz's name. This is
  -- the key a later run matches on, which is why the portal config has a
  -- quizIdAttribute worth filling in.
  external_quiz_id TEXT NOT NULL,
  quiz_name TEXT NOT NULL DEFAULT '',
  portal_status TEXT NOT NULL DEFAULT 'unknown',
  internal_status TEXT NOT NULL DEFAULT 'discovered',
  score NUMERIC(5,1),
  score_text TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per person per quiz. The upsert the worker does on discovery
-- depends on this, and so does "don't retake it": without the constraint a
-- second run would simply insert a second copy with no history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assessment_quizzes_person_external
  ON assessment_quizzes(person_id, external_quiz_id);
CREATE INDEX IF NOT EXISTS idx_assessment_quizzes_account ON assessment_quizzes(account_id);
CREATE INDEX IF NOT EXISTS idx_assessment_quizzes_org ON assessment_quizzes(organization_id);

-- ---------- one attempt at one quiz ----------
-- job_id/session_id link a quiz result straight back to the live view, the
-- event feed and the screencast it happened in, so a result is never a dead
-- end. ON DELETE SET NULL: run history is trimmed long before assessment
-- history should be.
CREATE TABLE IF NOT EXISTS quiz_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
  person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_name TEXT NOT NULL DEFAULT '',
  quiz_id UUID REFERENCES assessment_quizzes(id) ON DELETE SET NULL,
  quiz_name TEXT NOT NULL DEFAULT '',
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  questions_total INT NOT NULL DEFAULT 0,
  questions_answered INT NOT NULL DEFAULT 0,
  score NUMERIC(5,1),
  score_text TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quiz_runs_account ON quiz_runs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_runs_person ON quiz_runs(person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_runs_quiz ON quiz_runs(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_runs_job ON quiz_runs(job_id);

-- ---------- the question log ----------
-- The PRIMARY record of what happened, not a screenshot. Structured and
-- searchable: which question, which options were on screen, which one was
-- chosen, by which model, how sure it said it was, and how long it took.
-- A screenshot is an artefact (below); it is not a log.
CREATE TABLE IF NOT EXISTS quiz_question_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_run_id UUID NOT NULL REFERENCES quiz_runs(id) ON DELETE CASCADE,
  question_number INT NOT NULL,
  question_text TEXT NOT NULL DEFAULT '',
  question_type TEXT NOT NULL DEFAULT 'single_choice',
  -- [{ "id": "A", "text": "..." }, ...] exactly as extracted and as sent.
  options JSONB NOT NULL DEFAULT '[]',
  selected_option TEXT,
  provider TEXT,
  model TEXT,
  confidence NUMERIC(4,3),
  latency_ms INT,
  fallback_used BOOLEAN NOT NULL DEFAULT false,
  -- The model's stated reason, kept only when Settings says to: it is
  -- generated text about the contents of somebody's assessment.
  reason TEXT,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quiz_question_results_run
  ON quiz_question_results(quiz_run_id, question_number);

-- ---------- artefacts ----------
-- Screenshots, kept deliberately sparingly: the completion/result state and
-- a failure worth looking at. NOT one per question — that would be a video
-- recorder pretending to be a log, and the question rows above are the
-- searchable record.
CREATE TABLE IF NOT EXISTS assessment_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_run_id UUID NOT NULL REFERENCES quiz_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'completion',
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  caption TEXT NOT NULL DEFAULT '',
  byte_size INT NOT NULL DEFAULT 0,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_artifacts_run ON assessment_artifacts(quiz_run_id, created_at);
