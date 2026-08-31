import type { FastifyInstance } from "fastify";
import { getSettings, listLogs, redactSettings, updateSettings, type LogLevel } from "@automation/db";
import { serverTimezone } from "@automation/shared";
import { sendTestEmail } from "../alerts.js";

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

  app.get("/api/logs", async (req) => {
    const q = req.query as { level?: string; limit?: string };
    const level = ["INFO", "WARN", "ERROR"].includes(q.level ?? "") ? (q.level as LogLevel) : undefined;
    return { logs: await listLogs({ level, limit: Number(q.limit) || 300 }) };
  });

  /**
   * What the outside world currently sees us as. Deliberately fetched
   * through the same proxy the browsers use, so this reports the real
   * egress rather than the API container's own address.
   */
  app.get("/api/system/egress-info", async (reply) => {
    const s = await getSettings();
    const proxy = proxyFromSettings(s);
    try {
      const { request } = await import("undici");
      const dispatcher = proxy ? await buildDispatcher(proxy) : undefined;
      const res = await request("https://ipapi.co/json/", {
        dispatcher,
        headersTimeout: 8000,
        bodyTimeout: 8000,
      });
      const data = (await res.body.json()) as Record<string, unknown>;
      return {
        ip: String(data.ip ?? "unknown"),
        city: String(data.city ?? ""),
        region: String(data.region ?? ""),
        country: String(data.country_name ?? ""),
        proxied: Boolean(proxy),
      };
    } catch (err) {
      return {
        ip: null,
        city: "",
        region: "",
        country: "",
        proxied: Boolean(proxy),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

async function buildDispatcher(proxy: { server: string; username?: string; password?: string }) {
  const { ProxyAgent } = await import("undici");
  const url = new URL(proxy.server);
  if (proxy.username) {
    url.username = encodeURIComponent(proxy.username);
    if (proxy.password) url.password = encodeURIComponent(proxy.password);
  }
  return new ProxyAgent(url.toString());
}
