import { useState } from "react";
import * as api from "../api";
import type { SessionAccount } from "../types";
import { PUBLIC_PATHS, navigate } from "../nav";
import { AuthShell } from "./AuthShell";
import { PasswordInput } from "../components/PasswordInput";

/**
 * Sign in, and — because people forget — request a reset without leaving
 * the page. The reset form replaces the login form in place rather than
 * routing away, so getting back is one click and nothing typed is lost.
 */
export function Login({ onSignedIn }: { onSignedIn: (account: SessionAccount) => void }) {
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { account } = await api.login({ login: loginId.trim(), password });
      onSignedIn(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.requestPasswordReset(resetEmail.trim());
      // Deliberately the same message whether or not the address exists —
      // the server won't say, and neither should this.
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (mode === "forgot") {
    return (
      <AuthShell
        title="Reset your password"
        subtitle="We'll email you a link to choose a new one. It works once and expires in an hour."
        footer={
          <button type="button" className="link-btn" onClick={() => { setMode("login"); setNotice(null); setError(null); }}>
            ← Back to log in
          </button>
        }
      >
        {error && <div className="error-banner">{error}</div>}
        {notice ? (
          <div className="auth-notice">{notice}</div>
        ) : (
          <form className="auth-form" onSubmit={submitForgot}>
            <div className="form-row">
              <label htmlFor="reset-email">Email address</label>
              <input
                id="reset-email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <button className="primary big" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Email me a reset link"}
            </button>
          </form>
        )}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Log in"
      subtitle="Welcome back."
      footer={
        <>
          Don't have an account?{" "}
          <button type="button" className="link-btn" onClick={() => navigate(PUBLIC_PATHS.signup)}>
            Sign up
          </button>
        </>
      }
    >
      {error && <div className="error-banner">{error}</div>}

      <form className="auth-form" onSubmit={submitLogin}>
        <div className="form-row">
          <label htmlFor="login-id">Email or username</label>
          <input
            id="login-id"
            type="text"
            required
            autoFocus
            autoComplete="username"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        <div className="form-row">
          <label htmlFor="login-password">Password</label>
          <PasswordInput
            id="login-password"
            required
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
          />
        </div>

        <button className="primary big" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Log in"}
        </button>

        <button type="button" className="link-btn subtle" onClick={() => { setMode("forgot"); setError(null); }}>
          Forgot your password?
        </button>
      </form>
    </AuthShell>
  );
}
