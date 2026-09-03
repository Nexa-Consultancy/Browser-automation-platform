import type { FastifyRequest } from "fastify";
import { getSettings, type Account } from "@automation/db";
import { buildTransport, smtpConfigured } from "../alerts.js";
import { RESET_TTL_MINUTES } from "./tokens.js";

/**
 * Where the reset link should point.
 *
 * PUBLIC_BASE_URL is the reliable answer and should be set in production.
 * Falling back to the request's own headers keeps development working with
 * no configuration; behind a proxy that means trusting x-forwarded-*, which
 * is fine for building a link but is why the env var exists.
 */
function baseUrl(req: FastifyRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Sends the reset link, reusing the SMTP settings already configured for
 * alerting — one mail server to set up, not two.
 *
 * Throws when SMTP isn't configured. The caller swallows it so the response
 * stays identical either way; the point of throwing is that it lands in the
 * server log, where someone can see that resets are silently not being
 * delivered.
 */
export async function sendPasswordReset(account: Account, token: string, req: FastifyRequest): Promise<void> {
  const settings = await getSettings();
  if (!settings.SMTP_HOST || !settings.SMTP_FROM) {
    throw new Error("SMTP is not configured — cannot send a password reset. Set it under Settings → Integrations.");
  }

  const link = `${baseUrl(req)}/reset?token=${encodeURIComponent(token)}`;
  const transport = buildTransport(settings);

  await transport.sendMail({
    from: settings.SMTP_FROM,
    to: account.email,
    subject: "Reset your Browser Automation password",
    text: [
      `Hi ${account.name},`,
      "",
      "Someone asked to reset the password for your Browser Automation account.",
      `Open this link to choose a new one (it expires in ${RESET_TTL_MINUTES} minutes and works once):`,
      "",
      link,
      "",
      "If this wasn't you, ignore this email — your password stays as it is.",
    ].join("\n"),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#101828">
        <p>Hi ${escapeHtml(account.name)},</p>
        <p>Someone asked to reset the password for your Browser Automation account.</p>
        <p>
          <a href="${escapeHtml(link)}"
             style="display:inline-block;background:#1d64d8;color:#fff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:600">
            Choose a new password
          </a>
        </p>
        <p style="color:#5b6474;font-size:13px">
          The link expires in ${RESET_TTL_MINUTES} minutes and can be used once.
          If this wasn't you, ignore this email — your password stays as it is.
        </p>
      </div>`,
  });
}

/** Re-exported so the caller doesn't need to import alerts.ts as well. */
export { smtpConfigured };
