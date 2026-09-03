import { useCallback, useEffect, useState } from "react";
import type { Account, AccountStatus } from "../types";
import * as api from "../api";

const STATUS_LABEL: Record<AccountStatus, string> = {
  pending: "waiting for approval",
  active: "active",
  rejected: "rejected",
  suspended: "suspended",
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * Settings → Accounts. Admin-only: who may sign into the platform, and the
 * queue of signups waiting on a decision.
 *
 * This is deliberately the one screen that reads across workspaces —
 * approving a signup means looking at somebody else's request. It shows
 * what they told us (organization, phone, and what they want it for),
 * because that is the entire basis for saying yes or no.
 */
export function AccountsSettings({ currentAccountId }: { currentAccountId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listAccounts();
      setAccounts(res.accounts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const pending = accounts.filter((a) => a.status === "pending");

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Accounts</h2>
          <span className="hint">
            Who can sign into this platform. Each account has its own separate workspace.
          </span>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {pending.length > 0 && (
        <div className="accounts-pending-note">
          {pending.length} signup{pending.length === 1 ? "" : "s"} waiting for a decision.
        </div>
      )}

      {loaded && accounts.length === 0 && <div className="empty-state">No accounts yet.</div>}

      <div className="group-list">
        {accounts.map((a) => {
          const isSelf = a.id === currentAccountId;
          return (
            <div className={`card account-card status-${a.status}`} key={a.id}>
              <div className="account-head">
                <div className="account-identity">
                  <span className="account-name">{a.name}</span>
                  {a.role === "admin" && <span className="account-role">admin</span>}
                  {isSelf && <span className="account-role you">you</span>}
                  <span className={`account-status ${a.status}`}>
                    <span className="dot" />
                    {STATUS_LABEL[a.status]}
                  </span>
                </div>
                <span className="account-workspace">{a.workspaceName}</span>
              </div>

              <div className="account-facts">
                <div>
                  <span className="account-label">Email</span>
                  <span>{a.email}</span>
                </div>
                <div>
                  <span className="account-label">Phone</span>
                  <span>{a.phone || "—"}</span>
                </div>
                <div>
                  <span className="account-label">Signed up</span>
                  <span>{when(a.createdAt)}</span>
                </div>
                <div>
                  <span className="account-label">Last login</span>
                  <span>{when(a.lastLoginAt)}</span>
                </div>
              </div>

              {a.purpose && (
                <div className="account-purpose">
                  <span className="account-label">What they'll use it for</span>
                  <p>{a.purpose}</p>
                </div>
              )}

              <div className="session-controls">
                {a.status !== "active" && (
                  <button
                    className="primary"
                    disabled={busy === a.id}
                    onClick={() => void act(a.id, () => api.setAccountStatus(a.id, "active"))}
                  >
                    {a.status === "pending" ? "Approve" : "Reactivate"}
                  </button>
                )}
                {a.status === "pending" && (
                  <button
                    disabled={busy === a.id}
                    onClick={() => void act(a.id, () => api.setAccountStatus(a.id, "rejected"))}
                  >
                    Reject
                  </button>
                )}
                {a.status === "active" && !isSelf && a.role !== "admin" && (
                  <button
                    disabled={busy === a.id}
                    title="Blocks sign-in immediately, on their very next request. Their data is untouched."
                    onClick={() => void act(a.id, () => api.setAccountStatus(a.id, "suspended"))}
                  >
                    Suspend
                  </button>
                )}
                {!isSelf && a.role !== "admin" && (
                  <button
                    className="danger"
                    disabled={busy === a.id}
                    onClick={() => {
                      // Typing the address is the confirmation: this deletes
                      // an entire workspace and there is no undo, so a plain
                      // OK/Cancel is not enough friction.
                      const typed = prompt(
                        `Delete ${a.name}'s account AND their whole workspace — every organization, group, person and run they have. This cannot be undone.\n\nType their email to confirm:\n${a.email}`,
                      );
                      if (typed === null) return;
                      if (typed.trim().toLowerCase() !== a.email.toLowerCase()) {
                        setError("That didn't match the email — nothing was deleted.");
                        return;
                      }
                      void act(a.id, () => api.deleteAccount(a.id));
                    }}
                  >
                    Delete account
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
