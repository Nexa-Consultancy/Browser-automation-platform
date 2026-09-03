import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import { TemplatesSettings } from "./TemplatesSettings";
import { AccountsSettings } from "./AccountsSettings";
import type { SessionAccount } from "../types";

type Settings = Record<string, string>;

/** Shown in place of a stored secret. The server never sends the real one
 * back, and sending this marker in means "leave it as it is". */
const SECRET_MARKER = "__SET__";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-row">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

type Tab = "templates" | "accounts" | "integrations" | "advanced";

export function SettingsView({ account }: { account: SessionAccount }) {
  const [tab, setTab] = useState<Tab>("templates");
  const [s, setS] = useState<Settings>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingDiscord, setTestingDiscord] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [detectingChats, setDetectingChats] = useState(false);
  const [foundChats, setFoundChats] = useState<{ id: string; title: string }[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getSettings();
      setS(res.settings);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set(key: string, value: string) {
    setS((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.saveSettings(s);
      setS(res.settings);
      setMsg({ kind: "ok", text: "Settings saved." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function testEmail() {
    setTesting(true);
    setMsg(null);
    try {
      // Save first, or the test uses whatever was stored before this edit.
      await api.saveSettings(s);
      const res = await api.testEmail();
      setMsg(
        res.ok
          ? { kind: "ok", text: "Test email sent — check the recipient inbox." }
          : { kind: "err", text: res.error ?? "Sending failed." },
      );
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function testDiscord() {
    setTestingDiscord(true);
    setMsg(null);
    try {
      await api.saveSettings(s);
      const res = await api.testDiscord();
      setMsg(res.ok ? { kind: "ok", text: "Test message sent to Discord." } : { kind: "err", text: res.error ?? "Failed." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTestingDiscord(false);
    }
  }

  async function testTelegram() {
    setTestingTelegram(true);
    setMsg(null);
    try {
      await api.saveSettings(s);
      const res = await api.testTelegram();
      setMsg(res.ok ? { kind: "ok", text: "Test message sent to Telegram." } : { kind: "err", text: res.error ?? "Failed." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTestingTelegram(false);
    }
  }

  async function detectChats() {
    setDetectingChats(true);
    setMsg(null);
    setFoundChats(null);
    try {
      await api.saveSettings(s);
      const res = await api.telegramChats();
      if (res.ok) setFoundChats(res.chats);
      else setMsg({ kind: "err", text: res.error });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDetectingChats(false);
    }
  }

  if (!loaded) return <div className="empty-state">Loading settings…</div>;

  const on = (k: string) => s[k] === "true";

  // Accounts is the platform-wide list of logins, so only an admin sees
  // the tab at all — the API refuses it either way, but offering a tab
  // that always 403s would just look broken.
  const TABS: { id: Tab; label: string }[] = [
    { id: "templates", label: "Templates" },
    ...(account.role === "admin" ? [{ id: "accounts" as Tab, label: "Accounts" }] : []),
    { id: "integrations", label: "Integrations" },
    { id: "advanced", label: "Advanced" },
  ];

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Settings</h2>
          {tab !== "templates" && tab !== "accounts" && (
            <span className="hint">Applies to every run — scheduled and one-off.</span>
          )}
        </div>
        {tab !== "templates" && tab !== "accounts" && (
          <div className="job-toolbar-actions">
            <button className="primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        )}
      </div>

      {msg && (
        <div className={msg.kind === "ok" ? "ok-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {msg.text}
        </div>
      )}

      <div className="settings-layout">
        <nav className="settings-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {tab === "templates" && <TemplatesSettings />}

          {tab === "accounts" && <AccountsSettings currentAccountId={account.id} />}

          {tab === "integrations" && (
            <div className="settings-grid">
              {/* ---------- email alerts ---------- */}
              <div className="card form-grid">
                <div className="form-section">
                  <div className="eyebrow">Email alerts</div>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={on("ALERTS_ENABLED")}
                      onChange={(e) => set("ALERTS_ENABLED", String(e.target.checked))}
                    />
                    <span className="switch-track" aria-hidden="true">
                      <span className="switch-knob" />
                    </span>
                    <span className="switch-text">
                      <strong>Alert me when something fails</strong>
                      <span className="hint">
                        Master switch for every channel on this tab — a failed step or a crashed session sends
                        one message naming the group, the user, the error and a suggested first move to email,
                        Discord and Telegram, whichever you've filled in below. No per-channel toggle needed —
                        leaving one blank just skips it.
                      </span>
                    </span>
                  </label>

                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={on("ALERT_ON_LIFECYCLE")}
                      onChange={(e) => set("ALERT_ON_LIFECYCLE", String(e.target.checked))}
                    />
                    <span className="switch-track" aria-hidden="true">
                      <span className="switch-knob" />
                    </span>
                    <span className="switch-text">
                      <strong>Also alert when a group starts or stops</strong>
                      <span className="hint">
                        Separate from the failure switch above — turn this off if start/stop messages get noisy
                        without touching failure alerts.
                      </span>
                    </span>
                  </label>

                  <div className="form-two-col" style={{ marginTop: 14 }}>
                    <Field label="SMTP host" hint="Gmail: smtp.gmail.com">
                      <input
                        type="text"
                        value={s.SMTP_HOST ?? ""}
                        onChange={(e) => set("SMTP_HOST", e.target.value)}
                        placeholder="smtp.gmail.com"
                      />
                    </Field>
                    <Field label="Port" hint="587 for STARTTLS, 465 for SSL">
                      <input
                        type="number"
                        value={s.SMTP_PORT ?? ""}
                        onChange={(e) => set("SMTP_PORT", e.target.value)}
                      />
                    </Field>
                  </div>

                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={on("SMTP_SECURE")}
                      onChange={(e) => set("SMTP_SECURE", String(e.target.checked))}
                    />
                    <span className="switch-track" aria-hidden="true">
                      <span className="switch-knob" />
                    </span>
                    <span className="switch-text">
                      <strong>Implicit TLS (port 465)</strong>
                      <span className="hint">
                        Leave off for port 587. Getting this backwards is the usual cause of a connection that
                        hangs or is refused.
                      </span>
                    </span>
                  </label>

                  <div className="form-two-col" style={{ marginTop: 14 }}>
                    <Field label="SMTP username" hint="Your full Gmail address">
                      <input
                        type="text"
                        value={s.SMTP_USER ?? ""}
                        onChange={(e) => set("SMTP_USER", e.target.value)}
                        placeholder="you@gmail.com"
                      />
                    </Field>
                    <Field
                      label="SMTP password"
                      hint={
                        s.SMTP_PASS === SECRET_MARKER
                          ? "A password is saved. Type to replace it."
                          : "Gmail requires a 16-character App Password, not your normal one."
                      }
                    >
                      <input
                        type="password"
                        value={s.SMTP_PASS === SECRET_MARKER ? "" : (s.SMTP_PASS ?? "")}
                        placeholder={s.SMTP_PASS === SECRET_MARKER ? "•••••••• (unchanged)" : "abcd efgh ijkl mnop"}
                        onChange={(e) => set("SMTP_PASS", e.target.value)}
                      />
                    </Field>
                  </div>

                  <div className="form-two-col">
                    <Field label="Send from" hint="Usually the same as the username">
                      <input
                        type="text"
                        value={s.SMTP_FROM ?? ""}
                        onChange={(e) => set("SMTP_FROM", e.target.value)}
                        placeholder="you@gmail.com"
                      />
                    </Field>
                    <Field label="Send alerts to" hint="Comma-separated for more than one">
                      <input
                        type="text"
                        value={s.ALERT_TO ?? ""}
                        onChange={(e) => set("ALERT_TO", e.target.value)}
                        placeholder="you@gmail.com, ops@company.com"
                      />
                    </Field>
                  </div>

                  <div className="form-section" style={{ display: "flex", gap: 8 }}>
                    <button onClick={testEmail} disabled={testing}>
                      {testing ? "Sending…" : "Send test email"}
                    </button>
                  </div>
                </div>
              </div>

              {/* ---------- Discord alerts ---------- */}
              <div className="card form-grid">
                <div className="form-section">
                  <div className="eyebrow">Discord alerts</div>
                  <div className="hint">
                    In Discord: the channel's <strong>Settings → Integrations → Webhooks → New Webhook</strong>,
                    then copy its URL and paste it below. No account linking — anyone in that channel sees every
                    alert.
                  </div>
                  <Field
                    label="Webhook URL"
                    hint={s.DISCORD_WEBHOOK_URL === SECRET_MARKER ? "A webhook is saved. Type to replace it." : undefined}
                  >
                    <input
                      type="password"
                      value={s.DISCORD_WEBHOOK_URL === SECRET_MARKER ? "" : (s.DISCORD_WEBHOOK_URL ?? "")}
                      placeholder={
                        s.DISCORD_WEBHOOK_URL === SECRET_MARKER
                          ? "•••••••• (unchanged)"
                          : "https://discord.com/api/webhooks/…"
                      }
                      onChange={(e) => set("DISCORD_WEBHOOK_URL", e.target.value)}
                    />
                  </Field>
                  <div className="form-section" style={{ display: "flex", gap: 8 }}>
                    <button onClick={testDiscord} disabled={testingDiscord}>
                      {testingDiscord ? "Sending…" : "Send test message"}
                    </button>
                  </div>
                </div>
              </div>

              {/* ---------- Telegram alerts ---------- */}
              <div className="card form-grid">
                <div className="form-section">
                  <div className="eyebrow">Telegram alerts</div>
                  <div className="hint">
                    Message <strong>@BotFather</strong> on Telegram → <code>/newbot</code> → copy the token it
                    gives you. Then create (or open) the group your team is in, add that bot to it, and send any
                    message in the group so Telegram knows the bot is there. Paste the token below, save, then
                    click <strong>Find my chat</strong> to pick the group from what the bot has seen.
                  </div>
                  <Field
                    label="Bot token"
                    hint={s.TELEGRAM_BOT_TOKEN === SECRET_MARKER ? "A token is saved. Type to replace it." : undefined}
                  >
                    <input
                      type="password"
                      value={s.TELEGRAM_BOT_TOKEN === SECRET_MARKER ? "" : (s.TELEGRAM_BOT_TOKEN ?? "")}
                      placeholder={s.TELEGRAM_BOT_TOKEN === SECRET_MARKER ? "•••••••• (unchanged)" : "123456:AAExample"}
                      onChange={(e) => set("TELEGRAM_BOT_TOKEN", e.target.value)}
                    />
                  </Field>
                  <Field label="Chat ID" hint="A group's id is negative, e.g. -1001234567890">
                    <input
                      type="text"
                      value={s.TELEGRAM_CHAT_ID ?? ""}
                      onChange={(e) => set("TELEGRAM_CHAT_ID", e.target.value)}
                      placeholder="-1001234567890"
                    />
                  </Field>
                  <div className="form-section" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={detectChats} disabled={detectingChats}>
                      {detectingChats ? "Looking…" : "Find my chat"}
                    </button>
                    <button onClick={testTelegram} disabled={testingTelegram}>
                      {testingTelegram ? "Sending…" : "Send test message"}
                    </button>
                  </div>
                  {foundChats && (
                    <div className="hint" style={{ marginTop: 6 }}>
                      {foundChats.length === 0
                        ? "Nothing found yet — send a message in the group first, then try again."
                        : "Found: " + foundChats.map((c) => c.title).join(", ") + " — click one to use it:"}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                        {foundChats.map((c) => (
                          <button type="button" key={c.id} onClick={() => set("TELEGRAM_CHAT_ID", c.id)}>
                            {c.title} ({c.id})
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "advanced" && (
            <div className="settings-grid">
              {/* ---------- network egress ---------- */}
        <div className="card form-grid">
          <div className="form-section">
            <div className="eyebrow">Network egress</div>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={on("PROXY_ENABLED")}
                onChange={(e) => set("PROXY_ENABLED", String(e.target.checked))}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-knob" />
              </span>
              <span className="switch-text">
                <strong>Route browser traffic through a proxy</strong>
                <span className="hint">
                  Off means traffic leaves from this server directly. On, every browser session exits through the
                  proxy below.
                </span>
              </span>
            </label>

            {on("PROXY_ENABLED") && (
              <>
                <div className="form-three-col" style={{ marginTop: 14 }}>
                  <Field label="Type">
                    <select value={s.PROXY_TYPE ?? "http"} onChange={(e) => set("PROXY_TYPE", e.target.value)}>
                      <option value="http">HTTP / HTTPS</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </Field>
                  <Field label="Host">
                    <input
                      type="text"
                      value={s.PROXY_HOST ?? ""}
                      onChange={(e) => set("PROXY_HOST", e.target.value)}
                      placeholder="proxy.example.com"
                    />
                  </Field>
                  <Field label="Port">
                    <input
                      type="number"
                      value={s.PROXY_PORT ?? ""}
                      onChange={(e) => set("PROXY_PORT", e.target.value)}
                      placeholder="1080"
                    />
                  </Field>
                </div>
                <div className="form-two-col">
                  <Field label="Username (optional)">
                    <input
                      type="text"
                      value={s.PROXY_USER ?? ""}
                      onChange={(e) => set("PROXY_USER", e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Password (optional)"
                    hint={s.PROXY_PASS === SECRET_MARKER ? "A password is saved. Type to replace it." : undefined}
                  >
                    <input
                      type="password"
                      value={s.PROXY_PASS === SECRET_MARKER ? "" : (s.PROXY_PASS ?? "")}
                      placeholder={s.PROXY_PASS === SECRET_MARKER ? "•••••••• (unchanged)" : ""}
                      onChange={(e) => set("PROXY_PASS", e.target.value)}
                    />
                  </Field>
                </div>
                <div className="hint">
                  Chromium cannot answer a SOCKS5 username/password challenge — for SOCKS, allow-list this
                  server's IP with your provider and leave the credentials blank.
                </div>
              </>
            )}
          </div>
        </div>

        {/* ---------- browser defaults ---------- */}
        <div className="card form-grid">
          <div className="form-section">
            <div className="eyebrow">Browser defaults</div>
            <div className="form-three-col">
              <Field label="Step timeout (ms)" hint="How long a step waits before failing">
                <input
                  type="number"
                  value={s.BROWSER_TIMEOUT_MS ?? ""}
                  onChange={(e) => set("BROWSER_TIMEOUT_MS", e.target.value)}
                />
              </Field>
              <Field label="Viewport width">
                <input
                  type="number"
                  value={s.VIEWPORT_WIDTH ?? ""}
                  onChange={(e) => set("VIEWPORT_WIDTH", e.target.value)}
                />
              </Field>
              <Field label="Viewport height">
                <input
                  type="number"
                  value={s.VIEWPORT_HEIGHT ?? ""}
                  onChange={(e) => set("VIEWPORT_HEIGHT", e.target.value)}
                />
              </Field>
            </div>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={on("PERSIST_PROFILES")}
                onChange={(e) => set("PERSIST_PROFILES", String(e.target.checked))}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-knob" />
              </span>
              <span className="switch-text">
                <strong>Keep browser profiles between runs</strong>
                <span className="hint">
                  Cookies, logins and history are kept per user on disk, so a session resumes where it left off
                  instead of starting signed out.
                </span>
              </span>
            </label>
          </div>
        </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
