# STATE

GOAL: Web QA automation platform — URL + CSV of users + English step script
→ parallel isolated Playwright sessions, live per-user dashboard, per-user
and stop-all controls, interactive takeover, video-wait timers.

STACK: Node20/TS monorepo (npm workspaces). Fastify API, BullMQ+Redis queue
+ pub/sub, Postgres, Playwright worker, React/Vite dashboard, Docker Compose.

DONE:
- packages/shared: step DSL parser (open/click/fill/type/select/check/press/
  wait for text/wait N seconds/wait for element/wait for video/screenshot),
  CSV parsing, {{column}} templating.
- packages/db: Postgres schema (jobs/sessions/session_events) + queries.
- packages/queue: BullMQ run-job queue + Redis pub/sub channel helpers
  (control:session:*, events:job:*, screencast:session:*).
- packages/api: REST (create job w/ CSV upload, list/get, stop-all,
  append-steps job/session, per-session stop/input) + /ws relay.
- packages/worker: one Chromium per job, one isolated context per user,
  CDP screencast streaming, interruptible video-wait polling with tick
  events, control-channel listener (stop/append_steps/input passthrough),
  sessions stay open after their steps finish ("interactive") until a
  follow-up prompt or Stop.
- packages/dashboard: job creation form, live per-user boxes (screencast +
  click/type passthrough, step timeline with arrow marker, video timer,
  text event log, per-user stop + follow-up, job-level stop-all + broadcast
  follow-up), hash routing.
- docker-compose.yml + Dockerfiles (worker uses mcr.microsoft.com/playwright
  image pinned to 1.49.0 to match the npm package version) + nginx proxy
  for dashboard. Full workspace typecheck passes; dashboard `vite build`
  passes.

NOW: Nothing running yet — not launched via `docker compose up`. No commit
made (no git repo initialized in automation/ yet).

NEXT:
- `docker compose up -d --build`, smoke-test end to end against a real
  target URL with a small CSV.
- Optionally: git init + first commit if the user wants version control.

DECISIONS:
- Viewport fixed at 1280x720 in both worker (context creation) and
  dashboard (packages/dashboard/src/viewport.ts) so screencast click
  passthrough coordinates map correctly — keep these two in sync if changed.
- Sessions never auto-close after their step script finishes; they idle in
  "interactive" status so per-user/all "second prompt" follow-ups and the
  Stop button both still work. This means a forgotten job holds a worker
  slot open indefinitely — documented in README "Known limitations".
- Screencast frames are pub/sub only (not persisted to Postgres) — only
  structured events are durable.

GOTCHAS:
- worker/package.json pins playwright to exact "1.49.0" (no caret) — must
  stay equal to the Docker image tag `mcr.microsoft.com/playwright:v1.49.0-jammy`
  or browser binaries won't match.
- ioredis v5 default-export under NodeNext moduleResolution breaks TS
  ("Cannot use namespace as a type") — use the named `Redis` export instead
  of the default import (see packages/queue/src/redis.ts).
