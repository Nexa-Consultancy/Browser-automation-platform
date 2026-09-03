import type { FastifyInstance } from "fastify";
import {
  getSettings,
  listGroups,
  listLogs,
  listJobs,
  redactSettings,
  releaseGroupRun,
  updateSettings,
  type LogLevel,
} from "@automation/db";
import { serverTimezone } from "@automation/shared";
import { raiseAlert, sendTestEmail, sendTestDiscord, sendTestTelegram, detectTelegramChats } from "../alerts.js";
import { stopJob } from "../services/launch.js";
import { accountId, requireAuth } from "../auth/context.js";

/** Builds the Playwright-shaped proxy object from settings, or null when
 * egress routing is off. Shared by the worker (via the API) and the egress
 * probe so both always agree on what "the current proxy" means. */
export function proxyFromSettings(s: Record<string, string>): {
  server: string;
  username?: string;
  password?: string;
} | null {
  if (s.PROXY_ENABLED !== "true" || !s.PROXY_HOST || !s.PROXY_PORT) return null;
  const scheme = s.PROXY_TYPE === "socks5" ? "socks5" : "http";
  return {
    server: `${scheme}://${s.PROXY_HOST}:${s.PROXY_PORT}`,
    ...(s.PROXY_USER ? { username: s.PROXY_USER } : {}),
    ...(s.PROXY_PASS ? { password: s.PROXY_PASS } : {}),
  };
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/settings", async () => {
    const s = await getSettings();
    return { settings: redactSettings(s), serverTimezone: serverTimezone() };
  });

  app.put("/api/settings", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    // A secret arrives as the "__SET__" marker when the user didn't retype
    // it; treat that as "unchanged" rather than writing the marker itself.
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) patch[k] = v === "__SET__" ? "" : String(v ?? "");
    const saved = await updateSettings(patch);
    reply.send({ settings: redactSettings(saved) });
  });

  app.post("/api/settings/test-email", async () => sendTestEmail());
  app.post("/api/settings/test-discord", async () => sendTestDiscord());
  app.post("/api/settings/test-telegram", async () => sendTestTelegram());
  // Lists chats the Telegram bot can currently see, so setting up a group
  // doesn't require reading raw getUpdates JSON by hand.
  app.get("/api/settings/telegram-chats", async () => detectTelegramChats());

  app.get("/api/system/status", async () => {
    const s = await getSettings();
    return { paused: s.SCHEDULER_PAUSED === "true" };
  });

  /**
   * The emergency brake: stops every browser session running anywhere right
   * now (group-driven or a standalone custom run) and sets the pause flag
   * the scheduler checks on every tick, so nothing new starts either. A
   * still-open group window just waits — see /resume below.
   */
  app.post("/api/system/stop-all", async (req) => {
    const account = accountId(req);
    await updateSettings({ SCHEDULER_PAUSED: "true" });

    let stoppedGroups = 0;
    for (const group of await listGroups(account)) {
      if (!group.activeJobId) continue;
      await stopJob(group.activeJobId);
      await releaseGroupRun(group.id, null, true);
      stoppedGroups += 1;
    }

    let stoppedJobs = 0;
    for (const job of await listJobs(account)) {
      if (job.groupId) continue; // already covered above
      if (job.status === "pending" || job.status === "running") {
        await stopJob(job.id);
        stoppedJobs += 1;
      }
    }

    void raiseAlert({
      level: "INFO",
      lifecycle: true,
      source: "system",
      message: `Stop all — ${stoppedGroups} group(s) and ${stoppedJobs} standalone run(s) stopped, scheduler paused`,
    });

    return { ok: true, stoppedGroups, stoppedJobs };
  });

  /**
   * Un-pauses the scheduler for future occurrences. Deliberately does NOT
   * relaunch anything stop-all just stopped — a still-open window simply
   * waits for its next occurrence, same as any other "outside the window"
   * state the scheduler already handles.
   */
  app.post("/api/system/resume", async () => {
    await updateSettings({ SCHEDULER_PAUSED: "false" });
    void raiseAlert({
      level: "INFO",
      lifecycle: true,
      source: "system",
      message: "Resumed — the schedule is running again",
    });
    return { ok: true };
  });

  app.get("/api/logs", async (req) => {
    const q = req.query as { level?: string; limit?: string };
    const level = ["INFO", "WARN", "ERROR"].includes(q.level ?? "") ? (q.level as LogLevel) : undefined;
    return { logs: await listLogs(accountId(req), { level, limit: Number(q.limit) || 300 }) };
  });

  /**
   * What the outside world currently sees us as.
   *
   * Deliberately fetched through the same proxy the browsers use, so this
   * reports the real egress rather than the API container's own address.
   *
   * Several providers are tried in turn because the free tiers rate-limit
   * aggressively — ipapi.co starts returning {"error": true} well before
   * any real quota is reached, and a single-provider probe then reports
   * "unknown egress" when nothing is actually wrong.
   */
  app.get("/api/system/egress-info", async () => {
    const s = await getSettings();
    const proxy = proxyFromSettings(s);
    const dispatcher = proxy ? await buildDispatcher(proxy) : undefined;
    const errors: string[] = [];

    for (const probe of EGRESS_PROBES) {
      try {
        const { request } = await import("undici");
        const res = await request(probe.url, { dispatcher, headersTimeout: 8000, bodyTimeout: 8000 });
        const data = (await res.body.json()) as Record<string, unknown>;
        const parsed = probe.parse(data);
        if (parsed?.ip) return { ...parsed, proxied: Boolean(proxy) };
        errors.push(`${probe.url}: no ip in response`);
      } catch (err) {
        errors.push(`${probe.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      ip: null,
      city: "",
      region: "",
      country: "",
      proxied: Boolean(proxy),
      error: errors.join(" | "),
    };
  });
}

interface EgressResult {
  ip: string;
  city: string;
  region: string;
  country: string;
}

/** Free IP-geolocation endpoints, tried in order. Each returns a slightly
 * different shape, so each carries its own parser. */
const EGRESS_PROBES: { url: string; parse: (d: Record<string, unknown>) => EgressResult | null }[] = [
  {
    url: "https://ipinfo.io/json",
    parse: (d) =>
      d.ip
        ? {
            ip: String(d.ip),
            city: String(d.city ?? ""),
            region: String(d.region ?? ""),
            country: String(d.country ?? ""),
          }
        : null,
  },
  {
    url: "https://ipapi.co/json/",
    parse: (d) =>
      d.ip && !d.error
        ? {
            ip: String(d.ip),
            city: String(d.city ?? ""),
            region: String(d.region ?? ""),
            country: String(d.country_name ?? d.country ?? ""),
          }
        : null,
  },
  {
    url: "https://ifconfig.co/json",
    parse: (d) =>
      d.ip
        ? {
            ip: String(d.ip),
            city: String(d.city ?? ""),
            region: String(d.region_name ?? ""),
            country: String(d.country ?? ""),
          }
        : null,
  },
];

async function buildDispatcher(proxy: { server: string; username?: string; password?: string }) {
  const { ProxyAgent } = await import("undici");
  const url = new URL(proxy.server);
  if (proxy.username) {
    url.username = encodeURIComponent(proxy.username);
    if (proxy.password) url.password = encodeURIComponent(proxy.password);
  }
  return new ProxyAgent(url.toString());
}
