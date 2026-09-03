import { useCallback, useEffect, useRef, useState } from "react";
import type { OrganizationWithCounts, PlatformUser } from "../types";
import * as api from "../api";

/**
 * Add *and* edit a reusable user — one form, same as GroupModal. On create
 * (and on edit when a new password is typed) this launches a live sign-in
 * run: the server auto-fills email/password, then stops for "Stay signed
 * in?"/2FA to be finished by hand in the live view that opens next.
 *
 * Opened from inside a department (`groupId`), it also puts the new user
 * straight into that department, so "add someone to IT" is one action.
 */
export function AddUserModal({
  user,
  defaultOrganizationId = null,
  groupId = null,
  groupName = null,
  onClose,
  onSaved,
}: {
  user?: PlatformUser;
  /** Preselects the organization when adding from inside one. */
  defaultOrganizationId?: string | null;
  /** When set, the new user is linked into this group on save. */
  groupId?: string | null;
  groupName?: string | null;
  onClose: () => void;
  onSaved: (jobId: string | null) => void;
}) {
  const editing = !!user;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [organizationId, setOrganizationId] = useState<string>(user?.organizationId ?? defaultOrganizationId ?? "");
  const [organizations, setOrganizations] = useState<OrganizationWithCounts[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const backdropMouseDown = useRef(false);

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard this user? Anything you have typed will be lost.")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    void api.listOrganizations().then((r) => setOrganizations(r.organizations)).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      // Escape inside a field belongs to the field (it dismisses a native
      // <select> dropdown), not to the dialog — same reasoning as GroupModal.
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return;
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
        const res = await api.updateUser(user!.id, {
          name,
          email,
          password: password || undefined,
          organizationId: organizationId || null,
        });
        onSaved(res.jobId);
      } else {
        const res = await api.createUser({
          name,
          email,
          password,
          organizationId: organizationId || null,
          groupId,
        });
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
          <span>{editing ? `Edit ${user!.name}` : groupName ? `Add a user to ${groupName}` : "Add user"}</span>
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
            <div className="form-row" style={{ maxWidth: 320 }}>
              <label>Organization</label>
              <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
                <option value="">Unassigned</option>
                {organizations.map((o) => (
                  <option value={o.id} key={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <div className="hint">
                {groupName
                  ? `Saving also puts them straight into ${groupName}.`
                  : "Which company or client this user belongs to."}
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
              Saving opens a live browser: email and password are filled in automatically, including "Stay signed
              in? → Yes" when Microsoft asks. Finish any 2FA prompt by hand in the view that opens. Once you see
              Teams itself (calendar/chat), the login is already saved to disk — click <strong>Stop</strong> on
              that run right away, you don't need to leave it open.
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
