import { useState } from "react";
import * as api from "../api";
import { PUBLIC_PATHS, navigate } from "../nav";
import { AuthShell } from "./AuthShell";
import { PasswordInput } from "../components/PasswordInput";

/** Where the emailed link lands. The token rides in the query string
 * because the link has to work in a mail client with no JavaScript. */
export function ResetPassword() {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }

    setBusy(true);
    try {
      await api.resetPassword({ token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="That link isn't valid" subtitle="It looks like part of the link is missing.">
        <div className="auth-notice">Open the link from your email again, or request a new one.</div>
        <button className="primary big" onClick={() => navigate(PUBLIC_PATHS.login)}>
          Back to log in
        </button>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Password changed" subtitle="You can sign in with your new password now.">
        {/* Every other session was signed out server-side as part of the
            reset, which is the point — so there is nowhere to go but login. */}
        <div className="auth-notice">
          For safety, this signed you out everywhere else. Log in again to continue.
        </div>
        <button className="primary big" onClick={() => navigate(PUBLIC_PATHS.login)}>
          Log in
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      footer={
        <button type="button" className="link-btn" onClick={() => navigate(PUBLIC_PATHS.login)}>
          ← Back to log in
        </button>
      }
    >
      {error && <div className="error-banner">{error}</div>}

      <form className="auth-form" onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="rp-password">New password</label>
          <PasswordInput
            id="rp-password"
            required
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
          />
          <div className="hint">At least 8 characters, with a letter and a number.</div>
        </div>
        <div className="form-row">
          <label htmlFor="rp-confirm">Confirm new password</label>
          <PasswordInput
            id="rp-confirm"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
          />
        </div>
        <button className="primary big" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
    </AuthShell>
  );
}
