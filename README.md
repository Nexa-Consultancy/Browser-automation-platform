# QA Automation Platform

A self-hosted, web-based QA automation platform. Give it a target URL, a
CSV of users (or just a headcount), and a plain-English step script, and it
runs every user as an isolated, parallel real-Chromium browser session —
separate cookies/storage/credentials, no shared state — while a live
dashboard shows one box per user with a live screencast, the current step,
a "video is playing, 3:12 elapsed" timer for long video/meeting waits, a
text feed of everything that happened, click/type takeover into the live
browser, and per-user + global Stop buttons.

It ships as a Docker Compose stack — meant to be deployed once on a server
(a VPS, an internal box, whatever you've got) so your whole team hits the
same dashboard at a shared URL, rather than each person running it locally.
See [Deploying on a server](#deploying-on-a-server) below.

## Architecture

```
dashboard (React, nginx)  →  api (Fastify)  →  Postgres  (jobs/sessions/events)
                                   │
                                   └────────→  Redis  ──BullMQ──→  worker (Playwright)
                                                 (control/events/screencast pub-sub)
```

- **api** — REST endpoints to create/inspect jobs, stop sessions, and push
  follow-up steps; a WebSocket (`/ws`) relays live events, screencast
  frames, and interactive input passthrough.
- **worker** — consumes queued jobs, launches one Chromium instance per job
  and one isolated `BrowserContext` per user, parses each English step into
  a deterministic Playwright action, and streams status/screencast back
  over Redis pub/sub. Add more `worker` containers (`docker compose up -d
  --scale worker=3`) to scale out — this is the seam the whole design is
  built around for future multi-node scaling.
- **Postgres** — durable record of every job, session, and event (for the
  text log / audit trail).
- **Redis** — the BullMQ job queue *and* the pub/sub bus for live control
  messages (stop / append-steps / input), events, and screencast frames.

## Step script

One instruction per line, case-insensitive. `{{columnName}}` (or
`{columnName}` — both brace styles work) pulls that user's value from the
CSV row (matched case-insensitively). `{{url}}` defaults to the job's
Target URL field and `{{name}}` defaults to that user's name (from the CSV,
the dashboard's "Names" field, or the generated "User 1"/"User 2"/... if
neither is given) — so both work with no CSV at all. A CSV column literally
named `url` overrides the URL per user (e.g. per-user meeting links).

The first step is always `open {{url}}` — it's injected automatically, so
you don't need to write it (unless your own first step is already an
`open`/`go to`/`navigate to`, in which case yours is used instead).

Parallel sessions always equals the number of users — there's no separate
concurrency setting to configure or get out of sync.

| Step | Effect |
|---|---|
| `open <url>` | navigate (auto-added as step 1 — see above) |
| `click <text or selector>` | tries button → link → visible text → label; raw CSS/`text=`/`xpath=` selectors pass through untouched |
| `fill <field> with <value>` | resolves field by label → placeholder → `name` → `id` → role, then fills |
| `type <text>` | types into whatever is currently focused (freeform entry) |
| `select <option> in <field>` | dropdown select, by visible label or value |
| `check <field>` / `uncheck <field>` | checkbox |
| `press <key>` | e.g. `press Enter` |
| `wait for text "<text>"` | blocks until that text is visible |
| `wait <n> seconds` | fixed pause |
| `wait for element "<selector>"` | blocks until a CSS selector matches |
| `wait for video` | polls every native `<video>` element until it has ended; the session's status becomes "video playing" with a live elapsed timer, and the browser is held open for as long as it takes (default cap 3h, `MAX_VIDEO_WAIT_MS`). A manual Stop interrupts this immediately. Cross-origin embeds (YouTube/Vimeo iframes) can't be introspected due to browser same-origin rules — use `wait for text` or a fixed wait for those. |
| `screenshot` | captures a JPEG and pushes it as a one-off screencast frame |
| `#`  or blank line | ignored |

After the last step in a job, each session stays open ("waiting for you")
rather than closing — that's what lets you send a **second prompt**
(per-user or "send to all") later, or reach in and click/type directly via
the live screencast, before you explicitly hit **Stop**.

## Running it

```bash
cp .env.example .env   # optional — defaults already work
docker compose up -d --build
```

Dashboard: http://localhost:8080 · API: http://localhost:4000

To run more jobs in parallel across processes:

```bash
docker compose up -d --scale worker=3
```

### Local dev (no Docker)

```bash
npm install
docker compose up -d postgres redis   # just the stateful bits
npx playwright install chromium --with-deps   # once, for the worker
npm run dev:api        # terminal 1
npm run dev:worker     # terminal 2
npm run dev:dashboard  # terminal 3 → http://localhost:5173
```

## Deploying on a server

This is designed to run as a long-lived service on a server, not just on a
laptop — sessions can stay open for hours (a video wait, a session parked
"waiting for you"), so it belongs somewhere that stays up.

1. **Get the code onto the server** and `cd` into this directory:
   ```bash
   git clone <this-repo-url>
   cd automation
   ```
2. **Set real secrets** — copy `.env.example` to `.env` and change
   `POSTGRES_PASSWORD` from the default:
   ```bash
   cp .env.example .env
   ```
3. **Start the stack**:
   ```bash
   docker compose up -d --build
   ```
   The dashboard listens on port `8080`, the API on `4000`. Don't expose
   `5432`/`6379` (Postgres/Redis) publicly — the compose file maps them to
   the host for local debugging convenience; drop those port mappings (or
   firewall them) on a server.
4. **Put a reverse proxy with TLS in front of port 8080** (Caddy, nginx, or
   Traefik) so the dashboard is reachable at a real `https://` URL for your
   team — the dashboard's own nginx only serves plain HTTP. The dashboard
   has no login of its own, so also put it behind your proxy's basic auth,
   a VPN, or an IP allowlist unless you want it open to anyone who reaches
   that URL.
5. **Scale workers** for more parallel test-run throughput without
   redeploying anything else:
   ```bash
   docker compose up -d --scale worker=3
   ```
6. **Updates**: `git pull && docker compose up -d --build` — Postgres data
   persists in the `pgdata` named volume across rebuilds/restarts.

## Explicitly out of scope

This platform drives *your own* application under test with deterministic,
user-authored steps. It does not automate third-party services on your
behalf and has no credential-spoofing / identity-forging features — every
session logs in with the credentials you supplied in the CSV, nothing else.

## Known limitations (MVP)

- No built-in authentication — anyone who can reach the dashboard URL can
  create/stop jobs and see everything. Put it behind a reverse proxy with
  auth (or a VPN/IP allowlist) if it's reachable beyond your own machine.
- One shared Postgres/Redis; horizontal scaling is worker-side only for now.
- Screencast frames aren't persisted — only the structured event log is (so
  history survives a restart, but you can't rewind video).
- No cap on total simultaneously-live browsers per worker process — a run
  parked "waiting for you" (or "failed", waiting for a fix) stays open until
  someone clicks Stop, and dispatching new jobs never waits on that (see the
  comment in `packages/worker/src/index.ts`). If you leave many runs open at
  once, watch host memory/CPU; Stop unused ones, or scale out with more
  `worker` replicas.
