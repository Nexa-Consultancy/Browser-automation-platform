import { pool } from "./pool.js";

export type SettingsMap = Record<string, string>;

/** Every setting the app understands, with a safe default. Anything not
 * listed here is ignored on write, so a stray key can't be smuggled in. */
export const SETTING_DEFAULTS: SettingsMap = {
  // --- network egress ---
  PROXY_ENABLED: "false",
  PROXY_TYPE: "http", // http | socks5
  PROXY_HOST: "",
  PROXY_PORT: "",
  PROXY_USER: "",
  PROXY_PASS: "",
  // --- email alerting ---
  ALERTS_ENABLED: "false",
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_SECURE: "false", // true for port 465, false for 587 STARTTLS
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_FROM: "",
  ALERT_TO: "", // comma-separated
  // --- Discord alerting (Incoming Webhook, no OAuth) ---
  DISCORD_WEBHOOK_URL: "",
  // --- Telegram alerting (Bot API) ---
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "", // negative for a group chat
  // --- browser defaults ---
  BROWSER_TIMEOUT_MS: "30000",
  VIEWPORT_WIDTH: "1280",
  VIEWPORT_HEIGHT: "720",
  PERSIST_PROFILES: "true",
};

/** Keys whose values must never be sent back to the browser. */
export const SECRET_KEYS = new Set(["PROXY_PASS", "SMTP_PASS", "DISCORD_WEBHOOK_URL", "TELEGRAM_BOT_TOKEN"]);

export async function getSettings(): Promise<SettingsMap> {
  const { rows } = await pool.query<{ key: string; value: string }>(`SELECT key, value FROM settings`);
  const map: SettingsMap = { ...SETTING_DEFAULTS };
  for (const r of rows) {
    if (r.key in SETTING_DEFAULTS) map[r.key] = r.value;
  }
  return map;
}

/**
 * Writes only known keys. An empty string for a secret means "leave it
 * alone" — the UI never receives the current secret, so it can't send it
 * back, and a blank field must not silently wipe a working password.
 */
export async function updateSettings(patch: SettingsMap): Promise<SettingsMap> {
  const entries = Object.entries(patch).filter(([k]) => k in SETTING_DEFAULTS);
  for (const [key, raw] of entries) {
    const value = String(raw ?? "");
    if (SECRET_KEYS.has(key) && value === "") continue;
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }
  return getSettings();
}

/** The same map with secrets replaced by a marker, for the settings UI. */
export function redactSettings(s: SettingsMap): SettingsMap {
  const out: SettingsMap = { ...s };
  for (const k of SECRET_KEYS) out[k] = s[k] ? "__SET__" : "";
  return out;
}
