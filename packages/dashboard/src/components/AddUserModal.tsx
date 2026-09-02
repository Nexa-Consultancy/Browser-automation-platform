import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformUser } from "../types";
import * as api from "../api";

/**
 * Add *and* edit a reusable user — one form, same as GroupModal. On create
 * (and on edit when a new password is typed) this launches a live sign-in
 * run: the server auto-fills email/password, then stops for "Stay signed
 * in?"/2FA to be finished by hand in the live view that opens next.
 */
export function AddUserModal({
  user,
  onClose,
  onSaved,
}: {
  user?: PlatformUser;
  onClose: () => void;
  onSaved: (jobId: string | null) => void;
}) {
  const editing = !!user;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const backdropMouseDown = useRef(false);

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard this user? Anything you have typed will be lost.")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement) return;
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!editing && !password) {
      setError("A password is required to sign in and capture this user's Teams login.");
      return;
    }

    setSubmitting(true);
    try {
      if (editing) {
        const res = await api.updateUser(user!.id, { name, email, password: password || undefined });
        onSaved(res.jobId);
      } else {
        const res = await api.createUser({ name, email, password });
        onSaved(res.jobId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        backdropMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div className="modal-panel modal-form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{editing ? `Edit ${user!.name}` : "Add user"}</span>
          <button type="button" onClick={requestClose}>
            ✕
          </button>
        </div>

        <form className="form-grid" onSubmit={submit} onChange={() => setDirty(true)}>
          {error && <div className="error-banner">{error}</div>}

          <div className="form-section">
            <div className="eyebrow">Identity</div>
            <div className="form-two-col">
              <div className="form-row">
                <label>Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ray"
                />
              </div>
              <div className="form-row">
                <label>Microsoft / Teams email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ray@company.com"
                />
              </div>
            </div>
            <div className="form-row">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={editing ? "•••••••• (leave blank to keep unchanged)" : ""}
              />
              <div className="hint">
                {editing
                  ? "Only needed if the password changed — entering one re-runs the sign-in below."
                  : "Used once to auto-fill the sign-in form that opens next. Stored encrypted; only the server can read it, and only to sign in again."}
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="hint">
              Saving opens a live browser: email and password are filled in automatically, then it stops at
              "Stay signed in?" — finish that (and any 2FA prompt) by hand in the view that opens, then close it.
              This user's login is then saved for good and reusable in any group.
            </div>
          </div>

          <div className="form-section modal-actions">
            <button type="button" onClick={requestClose} disabled={submitting}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? "Saving…" : editing ? "Save" : "Add & sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
