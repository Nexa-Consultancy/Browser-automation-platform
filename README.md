# Browser Automation

A self-hosted, web-based browser automation platform. Give it a target URL, a
set of users, and a plain-English step script, and it runs every user as an
isolated, parallel real-Chromium session — separate cookies, storage and
credentials, no shared state — while a live dashboard shows one box per user
with a screencast, the current step, a text feed of everything that happened,
full mouse-and-keyboard takeover into the live browser, and per-user and
global stop controls.

Runs can start themselves. A **group** saves a link, a task and a roster of
users, and the server launches it on the weekdays you pick, inside a daily
time window, with nobody at the dashboard — a class that joins itself every
weekday at 2 PM, a report that runs every morning. Everything is timezone-aware
and set to the region you deploy in.

It ships as a Docker Compose stack, meant to be deployed once on a server so a
whole team hits the same dashboard at a shared URL.

---

## Contents

- [Architecture](#architecture) — the moving parts
- [Quick start](#quick-start) — get it running
- [Groups](#groups--runs-that-start-themselves) — scheduled, unattended runs
- [The dashboard](#the-dashboard) — tabs and what each does
- [Step script](#step-script) — the automation language
- [Live control](#live-control--mouse-and-keyboard) — driving a session by hand
- [Settings](#settings) — proxy, email alerts, browser defaults
- [Email alerts](#email-alerts--gmail-setup) — including Gmail setup
- [Deploying on a server](#deploying-on-a-server)
- [Common commands](#common-commands) — the ones you'll actually use
- [Project layout](#project-layout)
- [Design decisions & gotchas](#design-decisions--gotchas)

---

## Architecture

```
dashboard (React, nginx)  ->  api (Fastify)  ->  Postgres  (jobs / sessions / events / groups / logs / settings)
                                   |
                                   |- group scheduler (fires groups on their windows)
                                   |- alert engine    (emails failures over SMTP)
                                   \----------->  Redis  --BullMQ-->  worker (Playwright / Chromium)
                                                  (control / events / screencast / alerts pub-sub)
```

- **api** — REST endpoints and a `/ws` WebSocket that relays live events,
  screencast frames and interactive input. Also runs the **group scheduler**
  and the **alert engine** — both live here because the API is the single
  clock/SMTP owner, and workers scale out beneath it.
- **worker** — consumes queued jobs, launches one Chromium instance per job
  and one isolated `BrowserContext` per user, parses each English step into a
  deterministic Playwright action, and streams status and screencast back over
  Redis. Scale with `docker compose up -d --scale worker=3`.
- **Postgres** — durable record of every job, session, event, group, system
  log and setting.
- **Redis** — the BullMQ job queue *and* the pub/sub bus for live control
  messages (stop / append-steps / input), events, screencast frames, and the
  failure-alert channel.

Node 20 + TypeScript monorepo (npm workspaces): `shared`, `db`, `queue`, `api`,
`worker`, `dashboard`.

---

## Quick start

```bash
cp .env.example .env          # then edit it — see below
docker compose up -d --build
```

Dashboard -> http://localhost:8080 · API -> http://localhost:4000

**Edit `.env` before the first run:**

- `POSTGRES_PASSWORD` — change it off the default.
- `TZ` — the region groups schedule against. **A container is UTC unless you
  set this**, so a group set for "2 PM" fires at 2 PM UTC until told
  otherwise. Use an IANA name, e.g. `America/Vancouver`, `Europe/London`.

The dashboard shows the timezone in effect next to every group, so it's
visible rather than assumed.

---

## Groups — runs that start themselves

The **Groups** tab is the front door. A group is a saved automation the server
runs on schedule. Open it and hit **+ Create new group**:

| Field | Meaning |
|---|---|
| Group name | What it's called in the list |
| Link | The page every user opens |
| Number of users | Typing `3` gives three name fields — one isolated browser session per name |
| Task (prompt) | The plain-English step script; the link is opened as step 1 for you. Hidden by default on saved groups, revealed with the eye toggle in **Edit** |
| Days | Mon–Sun checkboxes |
| Event time | When the thing you're automating actually happens |
| Start early by | Begin this many minutes *before* the event, so browsers are logged in before it starts (default 5) |
| End | When the run stops |
| Follow this schedule automatically | On: the server runs it. Off: *held off by hand* — runs only when you press **Join now** |

At the (lead-adjusted) start the server creates a real run — same session grid,
screencast and controls as a manual run — and at the end it stops every
session.

- **Join now** starts a group immediately without waiting for its window. A
  manual run is yours: the scheduler never stops it, and it doesn't consume the
  day's scheduled run.
- Overnight windows work (`21:00 -> 02:00`). The day filter applies to the day
  the window *opened*, so a Friday-only overnight group finishes Saturday
  morning.
- Scheduling is a level check ("are we inside the window?"), not an edge
  trigger, so a restart across the start minute catches up instead of silently
  missing the day. Firing once per window is enforced in Postgres, so it holds
  even across multiple API replicas.

**A one-off, unsaved run** lives under the **Custom run** tab.

---

## The dashboard

| Tab | What it's for |
|---|---|
| **Groups** | Create, edit, search and run scheduled automations |
| **Custom run** | A one-off automation that starts immediately and isn't saved |
| **View more** | History of every run + daily totals (completed / failed / stopped), searchable and filterable by date |
| **Settings** | Proxy egress, email alerts, browser defaults |

The top bar carries a live **egress badge** — the real outbound IP and city,
measured through the same path the browsers use, so a proxy that's set but
broken shows here immediately.

---

## Step script

One instruction per line, case-insensitive. `{{columnName}}` (or `{columnName}`)
pulls a value for that user; `{{url}}` defaults to the target URL and
`{{name}}` to the user's name.

The first step is always `open {{url}}` — injected automatically.

| Step | Effect |
|---|---|
| `open <url>` | navigate (auto-added as step 1) |
| `click <text or selector>` | button -> link -> menu item -> label -> visible text; raw CSS/`text=`/`xpath=` pass through |
| `fill <field> with <value>` | resolves by label -> placeholder -> name -> id -> role, then fills |
| `type <text>` | types into whatever is focused |
| `select <option> in <field>` | dropdown select |
| `check <field>` / `uncheck <field>` | checkbox |
| `press <key>` | e.g. `press Enter` |
| `wait for text "<text>"` | block until that text is visible |
| `wait for element "<selector>"` | block until a selector matches |
| `wait <n> seconds` | fixed pause |
| `wait for video` | poll every `<video>` until it ends; live elapsed timer, browser held open (cap `MAX_VIDEO_WAIT_MS`) |
| `screenshot` | capture a one-off frame |
| `#` or blank line | ignored |

**You do not need `wait N seconds` before an action.** `click`, `fill`,
`select` and `check` wait for their target to appear and fire the instant it
does — a page ready in 200 ms costs 200 ms, and one that's slow waits up to the
configured **Step timeout** (Settings, default 30 s). Use a fixed `wait` only
when you genuinely want a pause.

After the last step each session stays open ("waiting for you") rather than
closing — that's what lets you send a follow-up prompt or take over by hand
before you hit **Stop**.

---

## Live control — mouse and keyboard

Expand any session (**⤢**) and hit **Take mouse control**:

- **Click, double-click, right-click, scroll and hover** go straight to that
  user's real browser. Coordinates are mapped through the letterboxing, so a
  click lands where you aim even in a resized window.
- The **keyboard box** types live: every keystroke reaches the page as you make
  it, **Enter** sends, Tab and Backspace behave, paste is forwarded whole.
- Control defaults on when a session is parked and off mid-run (so a stray
  click can't derail a script), but can be armed for any still-open session —
  which is how you rescue a run stuck on something the script can't get past.

Per-session **Stop `<user>`** closes only that browser; **Stop all users (N)**
on the run toolbar closes every browser in the run.

---

## Settings

Everything here applies to every run, scheduled or one-off.

- **Network egress** — route all browser traffic through one HTTP or SOCKS5
  proxy. Off means traffic leaves from the server directly. (Chromium can't
  answer a SOCKS5 username/password challenge — for SOCKS, IP-allowlist the
  server with your provider and leave credentials blank.)
- **Email alerts** — SMTP host/port/credentials, sender and recipients, with a
  **Send test email** button.
- **Browser defaults** — step timeout, viewport, and whether to keep profiles
  between runs.

Secrets (proxy and SMTP passwords) are never sent back to the browser; a blank
field means "leave it unchanged", so you can't accidentally wipe a working
password by saving.

---

## Email alerts — Gmail setup

When a step fails or a session crashes, the platform emails you the group, the
user, the run, the error and a suggested first move. To use a Gmail account:

1. **Turn on 2-Step Verification** — myaccount.google.com -> Security. App
   Passwords don't exist without it.
2. **Create an App Password** — Security -> 2-Step Verification -> **App
   passwords** -> name it "Browser Automation" -> Google gives you 16
   characters like `abcd efgh ijkl mnop`.
3. **In Settings -> Email alerts:**

   | Field | Value |
   |---|---|
   | SMTP host | `smtp.gmail.com` |
   | Port | `587` |
   | Implicit TLS | **off** (587 uses STARTTLS; on is only for 465) |
   | Username | your full Gmail address |
   | Password | the 16-char App Password (**not** your Gmail password) |
   | Send from | your Gmail address |
   | Send alerts to | one or more addresses, comma-separated |

4. Toggle **Email me when something fails** on, **Save**, then **Send test
   email** to confirm.

Your normal Gmail password will always be rejected — Google blocks it for SMTP.

---

## Deploying on a server

Designed to run as a long-lived service. Sessions can stay open for hours, so
it belongs somewhere that stays up.

1. **Get the code and configure:**
   ```bash
   git clone https://github.com/Nexa-Consultancy/Browser-automation-platform.git
   cd Browser-automation-platform
   cp .env.example .env         # set POSTGRES_PASSWORD and TZ
   docker compose up -d --build
   ```
2. **Don't expose Postgres/Redis** — bind the web ports to localhost and put a
   reverse proxy with TLS and auth in front. The dashboard has no login of its
   own, so the proxy (Caddy, nginx, Traefik) must supply it. Forward the
   original `Host` header — the API rejects WebSocket connections whose `Origin`
   doesn't match, as a guard against other sites riding a live session's stream.
3. **Scale workers** for more parallel throughput:
   ```bash
   docker compose up -d --scale worker=3
   ```
4. **Update:** `git pull && docker compose up -d --build`. Postgres data
   persists in the `pgdata` named volume across rebuilds.

> **Memory:** Chromium is hungry — budget ~2 GB base plus 300–700 MB per active
> user. A 4 GB host handles a handful of users; scale RAM or workers beyond
> that or sessions get OOM-killed.

---

## Common commands

**Stack lifecycle** (run from the repo root):

```bash
docker compose up -d --build          # build + start everything
docker compose up -d --build api      # rebuild just one service
docker compose ps                     # what's running
docker compose logs -f api            # follow a service's logs
docker compose logs api | grep scheduler   # confirm the group scheduler started
docker compose down                   # stop everything (keeps the pgdata volume)
docker compose up -d --scale worker=3 # more parallel throughput
```

**Health checks:**

```bash
curl -s http://localhost:4000/health                 # API up?
curl -s http://localhost:4000/api/groups             # groups + server timezone
curl -s http://localhost:4000/api/system/egress-info # real outbound IP + location
curl -s http://localhost:4000/api/history            # run history + daily totals
```

**Local development (no Docker for the app):**

```bash
npm install
docker compose up -d postgres redis          # just the stateful bits
npx playwright install chromium --with-deps  # once, for the worker
npm run dev:api          # terminal 1
npm run dev:worker       # terminal 2
npm run dev:dashboard    # terminal 3 -> http://localhost:5173
```

**Checks:**

```bash
npm run typecheck   # all packages
npm test            # scheduling/timezone tests (packages/shared)
```

---

## Project layout

```
packages/
  shared/     types + step parser + timezone/window math (with tests)
  db/         Postgres access: jobs, sessions, groups, history, logs, settings
  queue/      Redis + BullMQ, pub/sub channel names
  api/        Fastify server: routes, group scheduler, alert engine
  worker/     Playwright runner, step executor, element resolution, screencast
  dashboard/  React + Vite front-end (served by nginx in prod)
docker-compose.yml
.env.example
```

---

## Design decisions & gotchas

- **Timezone:** group times are stored as `HH:MM` plus an IANA zone, never a
  fixed instant — the intent is "2 PM local, every day", which an instant would
  drift an hour on across DST. Set `TZ` in `.env`; a container is UTC otherwise.
- **Actions wait, they don't sleep.** Element resolution waits for the target
  and fires the instant it's visible, so scripts don't need padding waits.
- **The scheduler is a level check, not an edge trigger** — it survives
  restarts across a start time — and once-per-window is enforced by a
  conditional `UPDATE` in Postgres, not in-memory state.
- **Alerts:** the worker publishes failures on Redis; the API sends the email.
  The worker holds no SMTP credentials, and sending is best-effort — a broken
  SMTP config records the failure against the log row rather than taking down
  the thing reporting the problem.
- **Viewport** is fixed (default 1280x720) so the dashboard's screencast click
  passthrough maps displayed pixels to real page coordinates deterministically.
- **Sessions never auto-close** after their steps (success or failure); they
  idle until a follow-up or Stop.
- **Playwright is pinned to an exact version** in `packages/worker` to match its
  Docker base image tag — keep the two in sync when upgrading.

### Known limitations

- No built-in authentication — put it behind a reverse proxy with auth, a VPN,
  or an IP allowlist if it's reachable beyond your own machine.
- One shared Postgres/Redis; horizontal scaling is worker-side only.
- Screencast frames aren't persisted — only the structured event log is, so
  history survives a restart but you can't rewind video.

---

## Explicitly out of scope

This platform drives *your own* applications with deterministic, user-authored
steps. It does not automate third-party services on your behalf, and has no
credential-spoofing or identity-forging features — every session logs in with
the credentials you supply, nothing else.
