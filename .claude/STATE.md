# STATE

GOAL: Web QA automation platform — URL + CSV/names of users + English step
script → parallel isolated Playwright sessions, live per-user dashboard,
per-user and stop-all controls, interactive takeover, video-wait timers.

REPO: https://github.com/Nexa-Consultancy/Browser-automation-platform
(renamed from qa-automation-platform).
Local dir is the git repo (git init'd, not a submodule/nested repo issue).
Commits authored as `abhinay0 <ab4h1@proton.me>` only — no AI attribution,
per global CLAUDE.md. Push after any change the user should see live.

STACK: Node20/TS monorepo (npm workspaces). Fastify API, BullMQ+Redis queue
+ pub/sub, Postgres, Playwright worker, React/Vite dashboard, Docker Compose.

DONE (beyond initial build):
- Fixed `{{url}}`/`{{name}}` templating: both default sensibly (target URL,
  generated/CSV/manual name) instead of printing literally; both `{{x}}`
  and `{x}` brace styles accepted.
- `open {{url}}` auto-injected as step 1 — no longer something users must
  type themselves.
- Dashboard "Names" field for manual (non-CSV) users, validated against
  user count. Removed the separate "Parallel sessions" field — concurrency
  always equals user count now.
- Failed sessions no longer close their browser — they park exactly like a
  normal finish (fixable via the screencast or a follow-up step) until an
  explicit Stop. stop-all route fixed to match (was skipping "failed").
- Fixed a real scheduling bug: the BullMQ processor used to await a run to
  full completion, so a handful of parked/long-lived runs could exhaust
  worker concurrency and silently strand all new job submissions forever.
  Processor is now fire-and-forget; BullMQ is just a dispatch trigger, real
  job lifecycle lives in Postgres + the live event feed.
- Security pass (found by an automated review): `open` step blocks
  non-http(s) schemes (was allowing file:// reads) and the cloud metadata
  IP range; WebSocket now rejects cross-origin connections. Auth is still
  fully absent — deliberately not built without the user's go-ahead (see
  README "Known limitations" + last conversation turn on this).
- Screencast: worker now caches each session's latest frame in Redis (1h
  TTL) and the API replays it on subscribe — fixes "waiting for stream…"
  persisting forever after a refresh on an idle/static page (CDP only
  pushes frames on repaint). Added an expand-to-popup modal per session.
- **postgres/redis had no `restart:` policy in docker-compose.yml** — a
  Docker Desktop restart left them stopped while api/worker crash-looped
  forever trying to reach them (looked like "nothing works, Stop is
  broken" but was actually the whole backend being down). Fixed.
- Full visual redesign: "broadcast control room" identity — warm-graphite
  palette (not generic dark-blue), Space Grotesk + IBM Plex Sans/Mono,
  viewfinder corner-brackets + pulsing tally-dot on every live screencast
  (grid card and modal). Form reorganized into labeled panels (TARGET/
  USERS/SCRIPT). See git log for the full commit message/rationale.
- **Groups** (scheduled, unattended runs): a Groups tab + "create new
  group" popup taking a link, a task script, a user count that renders that
  many name fields, and a start/end time. The API process runs the
  scheduler (packages/api/src/scheduler.ts): every 20s it asks, per group,
  "is the wall clock inside this window, in this group's zone?" and starts
  a normal job / stops every session accordingly. Manual and scheduled runs
  share one launch path (packages/api/src/services/launch.ts), so a
  scheduled run is the same kind of job as a hand-started one.
  Groups also carry weekday checkboxes (days, 0=Sun..6=Sat) and a "follow
  this schedule automatically" toggle (the existing `enabled` column) —
  off means the group only runs on "Join now".
  Added packages/shared/src/time.ts + its tests (`npm test`, the repo's
  first) — the window math is where the quiet failures live (DST, midnight
  crossing, weekday filtering, double-fire).

- Bug sweep across the three areas the user flagged (meeting join/worker
  steps, live view, groups/scheduler):
  * locators.ts "prefer a visible match" never ran — `loc.locator(":visible")`
    searches DESCENDANTS, so an <input> matched nothing and a <button>
    matched its inner span. Worse, the wait was `union.first().waitFor(
    visible)`, and `.or()` resolves in DOM order — a hidden duplicate
    earlier in the document ate the whole timeout while the real control
    was on screen. Now polls each strategy every 250ms.
  * click/fill/check re-resolve and retry once on detach/re-render errors
    (NOT on a plain timeout — that would only double the wait).
  * fill() verifies the value landed and falls back to pressSequentially:
    a pre-join guest-name box is a controlled component that ignores the
    one-shot write, so Join stayed disabled and the NEXT step looked broken.
  * The session now follows the tab it is on (activePage.ts). Everything
    was bound to `context.pages()[0]` for the life of the run, so a
    meeting link opening a second tab froze the picture on the abandoned
    first tab and ran the rest of the script against it.
  * Screencast publishes a frame on attach and a keepalive after 10s of
    quiet — CDP only pushes on repaint, so a parked/static page emitted
    nothing at all.
  * Scheduler: `getUsersByIds(ids, accountId ?? "")` on a group with no
    account asks Postgres for `uuid = ''`, which is an ERROR, not an empty
    result — it threw out of evaluateGroup every tick, so the group never
    ran. Also: an empty roster launched a session-less job that "completed"
    instantly (now says so and skips), and a launch that threw retried
    every 20s for the whole window (now consumes the occurrence, alerts
    once).
  * WS: guarded sends (a frame published during teardown threw out of the
    Redis callback), subscribe marked before awaiting, 30s ping.
  * JobView polls the run every 10s and reconciles — the view was 100%
    WebSocket-driven, so events missed during a drop were gone for good and
    the grid froze silently. A resynced status is logged as such.
- UX pass: dashboard task rows are actionable (Watch/Join now/Stop +
  countdown) instead of read-only; group card's Delete/Clear-saved-logins
  moved behind a "⋯" menu (they were two of six same-sized buttons, on the
  way to Edit); step syntax was documented 3x as a run-on paragraph and had
  already drifted — now one shared collapsed table (StepReference.tsx);
  dashboard empty state is the 3 ordered steps with links.
- Grid card now offers mouse control any time the browser is open, matching
  the modal. It previously offered it only when parked, so clicking a card
  mid-script silently did nothing.

NEXT: user said more features are coming later; nothing specific queued
right now. Open decision point from an earlier turn: whether to add a
lightweight shared-API-token auth gate before this goes on a real server
(not yet answered).

DECISIONS:
- Groups fire on a *level* check ("are we inside the window?") not an edge
  trigger ("did the clock just pass 17:00?"), so an API restart across the
  start minute catches up instead of silently missing the day. Once-per-
  window is enforced by a conditional UPDATE on groups.last_occurrence_key
  in Postgres, not by in-process state, so it survives replicas/restarts.
- Group times are stored as "HH:MM" text + an IANA zone, never TIMESTAMPTZ:
  the intent is "5 PM local, every day", a wall-clock rule — an instant
  would drift an hour across DST.
- Stopping a group's run early consumes that day's occurrence, so it isn't
  instantly relaunched by the next tick while the window is still open.
- "Join now" (manual run) deliberately does NOT consume the occurrence —
  the scheduled run still happens on time — and is flagged
  groups.active_job_manual so the scheduler never stops it. Without that
  flag a manual run started outside the window was killed by the very next
  tick, since "outside the window + a run open" reads as "window closed".
- The weekday filter is applied to the date the window *started* on, so a
  Friday-only 21:00->02:00 group runs through to Saturday 2 AM.
- minutesUntilStart searches forward up to 7 days (not just "later today"),
  so the countdown is honest for a group that runs once a week.
- Viewport fixed at 1280x720 in both worker (context creation) and
  dashboard (packages/dashboard/src/viewport.ts) — keep in sync.
- Sessions never auto-close after their steps (success OR failure); they
  idle until a follow-up or Stop. No cap on total simultaneously-live
  browsers per worker process — documented tradeoff, not a bug.
- Screencast frames: live via pub/sub + last-frame cached in Redis (not
  Postgres) — only structured events are durably persisted.

GOTCHAS:
- A container's clock is UTC unless TZ is set, so a group set to "5 PM"
  fires at 5 PM UTC. docker-compose passes TZ through to the api service
  and .env.example documents it; the dashboard shows the zone in effect
  next to every group so it's visible rather than assumed.
- worker/package.json pins playwright to exact "1.49.0" (no caret) — must
  match the Docker image tag `mcr.microsoft.com/playwright:v1.49.0-jammy`.
- ioredis v5 default-export under NodeNext moduleResolution breaks TS
  ("Cannot use namespace as a type") — use the named `Redis` export.
- nginx `$host` strips the port; use `$http_host` when proxying anything
  the origin/host check downstream cares about (bit us on the WS Origin
  check once already).
- Local git on this machine: the global ~/.gitconfig includeIf is written
  as `gitdir:C:/ABHI/` but the real path is `C:/Abhi`, so it does NOT match
  and repos here have no user.name/email or credential helper. Set them
  repo-locally, or change the global to `gitdir/i:`. The credential file
  C:/Abhi/.git-credentials was also written with a UTF-8 BOM and CRLF line
  endings — git's credential-store parses the  as part of the hostname,
  so it silently returns nothing and every fetch/push falls through to a
  GUI prompt. A `git fetch` failing this way prints NOTHING and leaves
  origin/main stale, which then makes `git pull` say "Already up to date"
  on a branch that is genuinely behind. Both fixed in place.
- Local Chrome-devtools screenshot/zoom tool is flaky in this environment
  (times out) independent of app state — verify UI via computed-style
  JS checks through the same tool instead of fighting for a screenshot.
