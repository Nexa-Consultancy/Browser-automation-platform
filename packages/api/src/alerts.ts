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
  if (a.level !== "ERROR") return; // only failures are worth an inbox
  if (!smtpConfigured(settings)) {
    await markAlert(log.id, false, "SMTP is not fully configured");
    return;
  }

  const when = new Date(log.createdAt).toLocaleString("en-US", { timeZone: process.env.TZ || "UTC" });
  const { subject, html, text } = renderEmail(a, when);

  try {
    await buildTransport(settings).sendMail({
      from: settings.SMTP_FROM,
      to: recipients(settings).join(", "),
      subject,
      html,
      text,
    });
    await markAlert(log.id, true, null);
  } catch (err) {
    await markAlert(log.id, false, err instanceof Error ? err.message : String(err));
  }
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
