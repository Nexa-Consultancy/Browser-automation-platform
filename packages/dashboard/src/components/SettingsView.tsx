import { useCallback, useEffect, useState } from "react";
import * as api from "../api";

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

export function SettingsView() {
  const [s, setS] = useState<Settings>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [teamsSignedIn, setTeamsSignedIn] = useState(false);
  const [teamsBusy, setTeamsBusy] = useState(false);

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
    void api.teamsLoginStatus().then((r) => setTeamsSignedIn(r.signedIn)).catch(() => {});
  }, [load]);

  async function signInTeams() {
    setTeamsBusy(true);
    setMsg(null);
    try {
      const { jobId } = await api.startTeamsLogin();
      // Open the live run so the user can drive the sign-in by hand.
      location.hash = `#/job/${jobId}`;
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTeamsBusy(false);
    }
  }

  async function importTeams(file: File) {
    setTeamsBusy(true);
    setMsg(null);
    try {
      const r = await api.importTeamsLogin(file);
      setMsg({ kind: "ok", text: r.message ?? "Imported." });
      // The bake runs in the worker; give it a moment, then refresh status.
      setTimeout(() => {
        void api.teamsLoginStatus().then((s) => setTeamsSignedIn(s.signedIn)).catch(() => {});
      }, 4000);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTeamsBusy(false);
    }
  }

  async function forgetTeams() {
    if (!confirm("Forget the shared Teams login? You'll need to sign in again before applying it to groups.")) return;
    setTeamsBusy(true);
    try {
      await api.clearTeamsLogin();
      setTeamsSignedIn(false);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTeamsBusy(false);
    }
  }

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

  if (!loaded) return <div className="empty-state">Loading settings…</div>;

  const on = (k: string) => s[k] === "true";

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Settings</h2>
          <span className="hint">Applies to every run — scheduled and one-off.</span>
        </div>
        <div className="job-toolbar-actions">
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>

      {msg && (
        <div className={msg.kind === "ok" ? "ok-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {msg.text}
        </div>
      )}

      <div className="settings-grid">
        {/* ---------- shared Teams master login ---------- */}
        <div className="card form-grid">
          <div className="form-section">
            <div className="eyebrow">Teams master login</div>
            <div className="master-login-row">
              <div className={`master-status ${teamsSignedIn ? "ok" : ""}`}>
                <span className="dot" />
                {teamsSignedIn ? "A Teams account is signed in" : "No account signed in yet"}
              </div>
              <div className="master-actions">
                <button className="primary" onClick={signInTeams} disabled={teamsBusy}>
                  {teamsBusy ? "Opening…" : teamsSignedIn ? "Re-sign in" : "Sign in to Teams"}
                </button>
                {teamsSignedIn && (
                  <button className="danger" onClick={forgetTeams} disabled={teamsBusy}>
                    Forget login
                  </button>
                )}
              </div>
            </div>
            <div className="hint">
              Sign in <strong>once</strong> with the single account all sessions should share. A live browser
              opens — log in with the mouse/keyboard takeover, click <strong>Yes</strong> on "Stay signed in", then
              stop the run. After that, open any group and hit <strong>Apply master login</strong> so every user
              joins already authenticated — no guest, no "matching cookie" error.
            </div>

            <div className="import-login">
              <div className="import-login-head">Or import a login from your own computer</div>
              <div className="hint" style={{ marginTop: 0 }}>
                If the sign-in above keeps failing, log in where it works — your own browser — and bring the session
                here. On your computer, in the project folder, run:
                <pre className="import-cmd">npm run capture:login</pre>
                A real browser opens; sign in to Teams, then close it. It writes <code>teams-auth.json</code> — upload
                that file below.
              </div>
              <input
                type="file"
                accept="application/json,.json"
                disabled={teamsBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importTeams(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </div>

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
                <strong>Email me when something fails</strong>
                <span className="hint">
                  A failed step or a crashed session sends one email naming the group, the user, the error and a
                  suggested first move.
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
                <input type="number" value={s.SMTP_PORT ?? ""} onChange={(e) => set("SMTP_PORT", e.target.value)} />
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
                <span className="hint">Leave off for port 587. Getting this backwards is the usual cause of a
                  connection that hangs or is refused.</span>
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
    </div>
  );
}
