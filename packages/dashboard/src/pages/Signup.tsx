import { useState } from "react";
import * as api from "../api";
import { PUBLIC_PATHS, navigate } from "../nav";
import { AuthShell } from "./AuthShell";
import { PasswordInput } from "../components/PasswordInput";

/**
 * Public signup. Every field here is asked for a reason: the answers are
 * what an admin reads when deciding whether to switch the account on, so
 * "what will you use it for" is required rather than decorative.
 *
 * Submitting does NOT sign anyone in — the account is created pending, and
 * the page says so plainly instead of dropping them at a login that would
 * reject them.
 */
export function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Checked here as well as on the server so the mismatch is caught
    // before a round trip; the server owns the real password rules.
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }

    setBusy(true);
    try {
      await api.signup({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        workspaceName: workspaceName.trim(),
        purpose: purpose.trim(),
        password,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="Request received" subtitle={`Thanks, ${name.split(" ")[0] || "there"}.`}>
        <div className="auth-notice">
          Your account has been created and is <strong>waiting to be approved</strong>. We'll email{" "}
          <strong>{email}</strong> as soon as it's switched on — you won't be able to log in until then.
        </div>
        <button className="primary big" onClick={() => navigate(PUBLIC_PATHS.landing)}>
          Back to the home page
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create an account"
      subtitle="Tell us a little about you. We review each request before switching it on."
      footer={
        <>
          Already have an account?{" "}
          <button type="button" className="link-btn" onClick={() => navigate(PUBLIC_PATHS.login)}>
            Log in
          </button>
        </>
      }
    >
      {error && <div className="error-banner">{error}</div>}

      <form className="auth-form" onSubmit={submit}>
        <div className="form-two-col">
          <div className="form-row">
            <label htmlFor="su-name">Your name</label>
            <input id="su-name" type="text" required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="su-email">Email address</label>
            <input
              id="su-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
        </div>

        <div className="form-two-col">
          <div className="form-row">
            <label htmlFor="su-phone">Phone number</label>
            <input
              id="su-phone"
              type="tel"
              required
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 010 0000"
            />
          </div>
          <div className="form-row">
            <label htmlFor="su-org">Organization name</label>
            <input
              id="su-org"
              type="text"
              required
              autoComplete="organization"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder="Acme Corp"
            />
          </div>
        </div>

        <div className="form-row">
          <label htmlFor="su-purpose">What will you use it for?</label>
          <textarea
            id="su-purpose"
            required
            rows={3}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. joining our daily 9am standup and two evening classes for a team of 20."
          />
          <div className="hint">This is what we read when approving your account, so a sentence or two helps.</div>
        </div>

        <div className="form-two-col">
          <div className="form-row">
            <label htmlFor="su-password">Password</label>
            <PasswordInput
              id="su-password"
              required
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
            />
            <div className="hint">At least 8 characters, with a letter and a number.</div>
          </div>
          <div className="form-row">
            <label htmlFor="su-confirm">Confirm password</label>
            <PasswordInput
              id="su-confirm"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={setConfirm}
            />
          </div>
        </div>

        <button className="primary big" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
