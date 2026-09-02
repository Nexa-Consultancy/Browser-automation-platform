import { useCallback, useEffect, useState } from "react";
import type { PlatformUser } from "../types";
import * as api from "../api";
import { AddUserModal } from "./AddUserModal";

/** A reusable user's own real Teams login, separate from a group's
 * free-text roster — see AddUserModal for how the sign-in run works. */
export function UsersPanel({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PlatformUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listUsers();
      setUsers(res.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  // A user's sign-in run finishes off-page (in the live view), so this has
  // to poll to notice "signed in" without anyone touching this panel again.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Users</h2>
          <span className="hint">reusable — link the same person into any group</span>
        </div>
        <div className="job-toolbar-actions">
          <button className="primary" onClick={() => setModalOpen(true)}>
            + Add user
          </button>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {loaded && users.length === 0 && (
        <div className="empty-state">
          No users yet — add one, sign into their Teams account once, and link them into any group.
        </div>
      )}

      <div className="group-list">
        {users.map((u) => (
          <div className="group-card" key={u.id}>
            <div className="group-card-head">
              <div className="group-title">
                <span className="group-dot" />
                <span className="name">{u.name}</span>
                <span className={`badge ${u.signedIn ? "status-completed" : "status-pending"}`}>
                  <span className="dot" />
                  {u.signedIn ? "signed in" : "not signed in"}
                </span>
              </div>
            </div>

            <div className="group-meta">
              <span className="target">{u.email}</span>
            </div>

            <div className="group-actions">
              {u.activeJobId && <button onClick={() => onOpenJob(u.activeJobId!)}>Watch sign-in</button>}
              <button disabled={busy === u.id || !!u.activeJobId} onClick={() => setEditing(u)}>
                Edit
              </button>
              <button
                disabled={busy === u.id || !!u.activeJobId}
                title={u.activeJobId ? "A sign-in run is already in progress" : "Re-run sign-in with the stored password"}
                onClick={() =>
                  act(u.id, async () => {
                    const { jobId } = await api.reloginUser(u.id);
                    onOpenJob(jobId);
                  })
                }
              >
                Re-sign in
              </button>
              <button
                disabled={busy === u.id || !!u.activeJobId}
                title="Delete this user's saved cookies/login so their next sign-in starts fresh"
                onClick={() => {
                  if (confirm(`Clear the saved login for "${u.name}"? They'll need to sign in again.`)) {
                    void act(u.id, () => api.clearUserProfile(u.id));
                  }
                }}
              >
                Clear saved login
              </button>
              <button
                className="danger"
                disabled={busy === u.id}
                onClick={() => {
                  if (confirm(`Delete user "${u.name}"? They'll be removed from every group they're linked into.`)) {
                    void act(u.id, () => api.deleteUser(u.id));
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {modalOpen && (
        <AddUserModal
          onClose={() => setModalOpen(false)}
          onSaved={(jobId) => {
            setModalOpen(false);
            void refresh();
            if (jobId) onOpenJob(jobId);
          }}
        />
      )}

      {editing && (
        <AddUserModal
          key={editing.id}
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(jobId) => {
            setEditing(null);
            void refresh();
            if (jobId) onOpenJob(jobId);
          }}
        />
      )}
    </div>
  );
}
