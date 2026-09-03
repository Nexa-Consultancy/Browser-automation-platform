import { useCallback, useEffect, useState } from "react";
import type { PlatformUser } from "../types";
import * as api from "../api";
import { AddUserModal } from "./AddUserModal";
import { UserStatusChip } from "./UserStatusChip";
import { SignInCountdown } from "./SignInCountdown";

/**
 * The people an automation signs in AS — each with their own real,
 * persistent Teams login, reusable across groups.
 *
 * Deliberately NOT called users: a "user" in this product is a login to
 * this platform (Settings → Accounts). These are the identities the
 * browsers become. See AddUserModal for how the sign-in run works.
 */
export function PeoplePanel({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PlatformUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // First moment each sign-in run was seen, so the countdown does not
  // restart every time the list polls.
  const [signInStartedAt, setSignInStartedAt] = useState<Record<string, number>>({});

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

  useEffect(() => {
    setSignInStartedAt((prev) => {
      const next: Record<string, number> = {};
      for (const u of users) {
        if (u.activeJobId) next[u.id] = prev[u.id] ?? Date.now();
      }
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((id) => prev[id] === next[id]);
      return same ? prev : next;
    });
  }, [users]);

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
          <h2>People</h2>
          <span className="hint">reusable — link the same person into any group</span>
        </div>
        <div className="job-toolbar-actions">
          <button className="primary" onClick={() => setModalOpen(true)}>
            + Add person
          </button>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {loaded && users.length === 0 && (
        <div className="empty-state">
          No people yet — add one, sign into their Teams account once, and link them into any group.
        </div>
      )}

      <div className="group-list">
        {users.map((u) => (
          <div className="group-card" key={u.id}>
            <div className="group-card-head">
              <div className="group-title">
                <span className="group-dot" />
                <span className="name">{u.name}</span>
                {u.activeJobId ? (
                  <SignInCountdown startedAt={signInStartedAt[u.id] ?? Date.now()} />
                ) : (
                  <UserStatusChip signedIn={u.signedIn} subject={u.name} />
                )}
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
                  if (confirm(`Delete "${u.name}"? They will be removed from every group they are linked into.`)) {
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
