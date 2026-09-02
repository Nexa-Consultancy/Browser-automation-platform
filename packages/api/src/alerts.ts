import nodemailer from "nodemailer";
import { getSettings, markAlert, writeLog, type LogLevel, type SettingsMap } from "@automation/db";

export interface AlertInput {
  level: LogLevel;
  source: string;
  message: string;
  errorTrace?: string | null;
  jobId?: string | null;
  sessionId?: string | null;
  userName?: string | null;
  groupName?: string | null;
  /** A group starting or stopping, not a failure — gated by
   * ALERT_ON_LIFECYCLE instead of (or in addition to) level === "ERROR". */
  lifecycle?: boolean;
}

function recipients(s: SettingsMap): string[] {
  return (s.ALERT_TO ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

export function smtpConfigured(s: SettingsMap): boolean {
  return Boolean(s.SMTP_HOST && s.SMTP_PORT && s.SMTP_FROM && recipients(s).length > 0);
}

export function discordConfigured(s: SettingsMap): boolean {
  return Boolean(s.DISCORD_WEBHOOK_URL);
}

export function telegramConfigured(s: SettingsMap): boolean {
  return Boolean(s.TELEGRAM_BOT_TOKEN && s.TELEGRAM_CHAT_ID);
}

export function buildTransport(s: SettingsMap) {
  return nodemailer.createTransport({
    host: s.SMTP_HOST,
    port: Number(s.SMTP_PORT) || 587,
    // Port 465 speaks TLS from the first byte; 587 starts plain and upgrades
    // with STARTTLS. Getting this backwards is the usual reason a Gmail
    // app password "doesn't work".
    secure: s.SMTP_SECURE === "true",
    auth: s.SMTP_USER ? { user: s.SMTP_USER, pass: s.SMTP_PASS } : undefined,
  });
}

/**
 * Turns an error into something someone can act on without opening the
 * server. A bare stack trace in an inbox gets ignored; naming the user, the
 * group and a likely first move does not.
 */
function suggestion(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("proxy") || m.includes("err_proxy") || m.includes("tunnel")) {
    return "Check the proxy settings — host, port, and credentials — under Settings → Network egress.";
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return "The page did not respond in time. Check the target URL is reachable, or raise the browser timeout in Settings.";
  }
  if (m.includes("net::err_name_not_resolved") || m.includes("dns")) {
    return "The hostname could not be resolved. Check the link on the group is still correct.";
  }
  if (m.includes("login") || m.includes("password") || m.includes("credential")) {
    return "Sign-in appears to have failed. The saved profile may be stale — try Clear profile for this user.";
  }
  if (m.includes("not visible") || m.includes("selector") || m.includes("waiting for")) {
    return "A step could not find what it expected on the page. The site may have changed — review the group's prompt.";
  }
  return "Open the run in the dashboard to see the live browser and the step that failed.";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function renderEmail(a: AlertInput, when: string): { subject: string; html: string; text: string } {
  const who = [a.groupName, a.userName].filter(Boolean).join(" / ") || "system";
  const subject = `[${a.level}] Browser Automation — ${who}: ${a.message.slice(0, 90)}`;
  const fix = suggestion(a.message);

  const rows: [string, string][] = [
    ["When", when],
    ["Level", a.level],
    ["Source", a.source],
    ["Group", a.groupName ?? "—"],
    ["User", a.userName ?? "—"],
    ["Run ID", a.jobId ?? "—"],
    ["Session ID", a.sessionId ?? "—"],
  ];

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#101828;max-width:640px">
      <h2 style="margin:0 0 4px;font-size:18px">Browser Automation alert</h2>
      <p style="margin:0 0 16px;color:#5b6474;font-size:14px">${escapeHtml(a.message)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:16px">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:6px 10px;background:#f4f6fa;border:1px solid #d8dee9;width:120px;font-weight:600">${k}</td>
                   <td style="padding:6px 10px;border:1px solid #d8dee9">${escapeHtml(String(v))}</td></tr>`,
          )
          .join("")}
      </table>
      <div style="padding:12px 14px;background:#eef4ff;border-left:3px solid #1d64d8;font-size:13px;margin-bottom:16px">
        <strong>Suggested first step:</strong> ${escapeHtml(fix)}
      </div>
      ${
        a.errorTrace
          ? `<div style="font-size:12px"><strong>Trace</strong><pre style="background:#f4f6fa;border:1px solid #d8dee9;padding:10px;overflow-x:auto;white-space:pre-wrap">${escapeHtml(
              a.errorTrace.slice(0, 4000),
            )}</pre></div>`
          : ""
      }
    </div>`;

  const text = [
    `Browser Automation alert`,
    a.message,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    `Suggested first step: ${fix}`,
    a.errorTrace ? `\nTrace:\n${a.errorTrace.slice(0, 4000)}` : "",
  ].join("\n");

  return { subject, html, text };
}

interface DiscordPayload {
  embeds: {
    title: string;
    description: string;
    color: number;
    fields: { name: string; value: string; inline?: boolean }[];
    footer: { text: string };
  }[];
}

function renderDiscord(a: AlertInput, when: string): DiscordPayload {
  const who = [a.groupName, a.userName].filter(Boolean).join(" / ") || "system";
  const fix = suggestion(a.message);
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Source", value: a.source, inline: true },
    { name: "Group", value: a.groupName ?? "—", inline: true },
    { name: "User", value: a.userName ?? "—", inline: true },
    { name: "Run ID", value: a.jobId ?? "—", inline: true },
    { name: "Suggested first step", value: fix, inline: false },
  ];
  if (a.errorTrace) {
    fields.push({ name: "Trace", value: "```" + a.errorTrace.slice(0, 1000) + "```", inline: false });
  }
  return {
    embeds: [
      {
        title: `[${a.level}] ${who}`,
        // Discord's embed description caps at 4096 chars.
        description: a.message.slice(0, 3900),
        color: a.level === "ERROR" ? 0xd9363e : 0x1d64d8,
        fields,
        footer: { text: when },
      },
    ],
  };
}

async function sendDiscordAlert(webhookUrl: string, a: AlertInput, when: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(renderDiscord(a, when)),
  });
  if (!res.ok) throw new Error(`Discord webhook returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function escapeHtmlForTelegram(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function renderTelegram(a: AlertInput, when: string): string {
  const who = [a.groupName, a.userName].filter(Boolean).join(" / ") || "system";
  const fix = suggestion(a.message);
  const lines = [
    `<b>[${a.level}] ${escapeHtmlForTelegram(who)}</b>`,
    escapeHtmlForTelegram(a.message),
    "",
    `<b>When:</b> ${escapeHtmlForTelegram(when)}`,
    `<b>Source:</b> ${escapeHtmlForTelegram(a.source)}`,
    `<b>Group:</b> ${escapeHtmlForTelegram(a.groupName ?? "—")}`,
    `<b>User:</b> ${escapeHtmlForTelegram(a.userName ?? "—")}`,
    `<b>Run ID:</b> ${escapeHtmlForTelegram(a.jobId ?? "—")}`,
    "",
    `<b>Suggested first step:</b> ${escapeHtmlForTelegram(fix)}`,
  ];
  if (a.errorTrace) {
    lines.push("", `<pre>${escapeHtmlForTelegram(a.errorTrace.slice(0, 800))}</pre>`);
  }
  // Telegram's hard cap on a single message.
  return lines.join("\n").slice(0, 4096);
}

async function sendTelegramAlert(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/**
 * Records the event and, if alerting is on and configured, emails it.
 *
 * Logging always happens; emailing is best-effort. A broken SMTP config must
 * never take down the thing that's reporting the problem, so a send failure
 * is recorded against the log row and swallowed.
 */
export async function raiseAlert(a: AlertInput): Promise<void> {
  const log = await writeLog(a);

  let settings: SettingsMap;
  try {
    settings = await getSettings();
  } catch {
    return;
  }

  if (settings.ALERTS_ENABLED !== "true") return;
  // Failures always qualify; a lifecycle event (group started/stopped) only
  // qualifies if that separate toggle is on — everything else is noise.
  const qualifies = a.level === "ERROR" || (a.lifecycle === true && settings.ALERT_ON_LIFECYCLE === "true");
  if (!qualifies) return;

  const when = new Date(log.createdAt).toLocaleString("en-US", { timeZone: process.env.TZ || "UTC" });

  // Every configured channel gets tried independently — one being down (a
  // bad webhook, an expired bot token) must never silence the others. The
  // log row's own status reflects whether ANY channel actually got it out.
  const attempts: { channel: string; ok: boolean; error?: string }[] = [];

  if (smtpConfigured(settings)) {
    try {
      const { subject, html, text } = renderEmail(a, when);
      await buildTransport(settings).sendMail({
        from: settings.SMTP_FROM,
        to: recipients(settings).join(", "),
        subject,
        html,
        text,
      });
      attempts.push({ channel: "email", ok: true });
    } catch (err) {
      attempts.push({ channel: "email", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (discordConfigured(settings)) {
    try {
      await sendDiscordAlert(settings.DISCORD_WEBHOOK_URL, a, when);
      attempts.push({ channel: "discord", ok: true });
    } catch (err) {
      attempts.push({ channel: "discord", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (telegramConfigured(settings)) {
    try {
      await sendTelegramAlert(settings.TELEGRAM_BOT_TOKEN, settings.TELEGRAM_CHAT_ID, renderTelegram(a, when));
      attempts.push({ channel: "telegram", ok: true });
    } catch (err) {
      attempts.push({ channel: "telegram", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (attempts.length === 0) {
    await markAlert(log.id, false, "No alert channel is configured (email, Discord or Telegram)");
    return;
  }
  const ok = attempts.some((r) => r.ok);
  const detail = attempts
    .filter((r) => !r.ok)
    .map((r) => `${r.channel}: ${r.error}`)
    .join(" | ");
  await markAlert(log.id, ok, detail || null);
}

/** Sends a "this works" email so the settings page can prove the config
 * before waiting for a real failure to test it. */
export async function sendTestEmail(): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  if (!smtpConfigured(settings)) {
    return { ok: false, error: "Fill in SMTP host, port, sender and at least one recipient first." };
  }
  try {
    const t = buildTransport(settings);
    await t.verify();
    await t.sendMail({
      from: settings.SMTP_FROM,
      to: recipients(settings).join(", "),
      subject: "Browser Automation — test alert",
      text: "This is a test from the Browser Automation settings page. Alerting is configured correctly.",
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif">
               <h2 style="font-size:17px;margin:0 0 6px">Test alert</h2>
               <p style="color:#5b6474;font-size:14px;margin:0">
                 Sent from the Browser Automation settings page. Alerting is configured correctly.
               </p>
             </div>`,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Posts a "this works" message to the configured Discord channel. */
export async function sendTestDiscord(): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  if (!discordConfigured(settings)) return { ok: false, error: "Paste a Discord webhook URL first." };
  try {
    const res = await fetch(settings.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Browser Automation — test alert",
            description: "Sent from the settings page. Discord alerting is configured correctly.",
            color: 0x1d64d8,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Discord returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Posts a "this works" message to the configured Telegram chat. */
export async function sendTestTelegram(): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  if (!telegramConfigured(settings)) return { ok: false, error: "Fill in the bot token and chat ID first." };
  try {
    await sendTelegramAlert(
      settings.TELEGRAM_BOT_TOKEN,
      settings.TELEGRAM_CHAT_ID,
      "<b>Browser Automation — test alert</b>\nSent from the settings page. Telegram alerting is configured correctly.",
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Finds chat ids the bot can currently see, so setting up a group doesn't
 * require manually reading raw Telegram API JSON. Only sees a chat AFTER
 * someone has sent a message there since the bot joined — Telegram doesn't
 * expose group membership any other way to a bot.
 */
export async function detectTelegramChats(): Promise<
  { ok: true; chats: { id: string; title: string }[] } | { ok: false; error: string }
> {
  const settings = await getSettings();
  if (!settings.TELEGRAM_BOT_TOKEN) return { ok: false, error: "Paste the bot token first, then save." };
  try {
    const res = await fetch(`https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`);
    if (!res.ok) throw new Error(`Telegram returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: { message?: { chat?: { id: number; title?: string; first_name?: string; type: string } } }[];
    };
    if (!body.ok) return { ok: false, error: body.description ?? "Telegram rejected the request." };
    const seen = new Map<string, string>();
    for (const u of body.result ?? []) {
      const chat = u.message?.chat;
      if (!chat) continue;
      const title = chat.title ?? chat.first_name ?? chat.type;
      seen.set(String(chat.id), title);
    }
    if (seen.size === 0) {
      return {
        ok: false,
        error:
          "No chats seen yet — add the bot to your group, send any message in it, then try again.",
      };
    }
    return { ok: true, chats: [...seen.entries()].map(([id, title]) => ({ id, title })) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
