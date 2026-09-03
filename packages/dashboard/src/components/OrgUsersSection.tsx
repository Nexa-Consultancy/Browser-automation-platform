import { useEffect, useMemo, useState } from "react";
import type { GroupWithSchedule, OrganizationWithCounts, PlatformUser } from "../types";
import * as api from "../api";
import { UserStatusChip } from "./UserStatusChip";

/** The rail's id for "no organization" — kept identical to the constant in
 * OrganizationsView, which owns it. Null is always the wire value. */
const UNASSIGNED = "__unassigned__";

/** Which bulk panel is open under the header, if any. Only one at a time:
 * the panels are large enough that two open at once would push the list off
 * screen just as you are trying to act on it. */
type Panel = "here" | "elsewhere" | null;

/**
 * Every user in one organization, with select-all, per-user selection, and
 * the bulk actions that need a selection.
 *
 * Moving people is deliberately two dropdowns rather than one long list:
 * organization first, then that organization's groups. A flat list of every
 * group across every company gets ambiguous the moment two of them have a
 * department called "IT".
 */
export function OrgUsersSection({
  organizationId,
  organizationName,
  users,
  allGroups,
  organizations,
  onChanged,
  onError,
  onEditUser,
  onOpenJob,
}: {
  /** null = the Unassigned pseudo-organization. */
  organizationId: string | null;
  organizationName: string;
  /** The users to show — already filtered by the master search. */
  users: PlatformUser[];
  /** Every group, so memberships can be named and the destination pickers
   * can be built for any organization. */
  allGroups: GroupWithSchedule[];
  organizations: OrganizationWithCounts[];
  onChanged: () => void | Promise<void>;
  onError: (message: string | null) => void;
  onEditUser: (user: PlatformUser) => void;
  onOpenJob: (jobId: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);

  // Destinations for the two move panels.
  const [hereGroupId, setHereGroupId] = useState("");
  const [targetOrgId, setTargetOrgId] = useState("");
  const [targetGroupId, setTargetGroupId] = useState("");

  const visibleIds = useMemo(() => users.map((u) => u.id), [users]);

  // Drop from the selection anyone who is no longer on screen — after a
  // move, a delete, or a search that filters them out. Acting on someone
  // invisible is exactly the kind of surprise a bulk action must not spring.
  useEffect(() => {
    setSelected((prev) => {
      const next = prev.filter((id) => visibleIds.includes(id));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleIds]);

  const groupsIn = (orgId: string | null) =>
    allGroups.filter((g) => (g.organizationId ?? null) === orgId);

  const selectedUsers = users.filter((u) => selected.includes(u.id));
  const allSelected = users.length > 0 && selected.length === users.length;

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  function toggleAll() {
    setSelected(allSelected ? [] : visibleIds);
  }

  function closePanels() {
    setPanel(null);
    setHereGroupId("");
    setTargetOrgId("");
    setTargetGroupId("");
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      setSelected([]);
      closePanels();
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const count = selected.length;
  const noun = count === 1 ? "user" : "users";

  return (
    <div className="org-people">
      <div className="org-users-head">
        <span className="eyebrow">Users in {organizationName}</span>

        {users.length > 0 && (
          <label className="org-select-all">
            <input
              type="checkbox"
              checked={allSelected}
              // Some-but-not-all reads as a third state, and the box should
              // look like it rather than like "none selected".
              ref={(el) => {
                if (el) el.indeterminate = count > 0 && !allSelected;
              }}
              onChange={toggleAll}
            />
            Select all
          </label>
        )}

        {count > 0 && (
          <>
            <span className="org-selected-count">
              {count} {noun} selected
            </span>
            <div className="org-more">
              <button
                type="button"
                className={panel === "here" ? "control-on" : ""}
                disabled={busy}
                onClick={() => setPanel(panel === "here" ? null : "here")}
              >
                Add to a group
              </button>
              <button
                type="button"
                className={panel === "elsewhere" ? "control-on" : ""}
                disabled={busy}
                onClick={() => setPanel(panel === "elsewhere" ? null : "elsewhere")}
              >
                Move to another organization
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  const names = selectedUsers.map((u) => u.name).join(", ");
                  if (
                    confirm(
                      `Delete ${count} ${noun} (${names})? Their saved logins go too, and they are removed from every group. This cannot be undone.`,
                    )
                  ) {
                    void act(() => api.bulkDeleteUsers(selected));
                  }
                }}
              >
                Delete
              </button>
              <button type="button" disabled={busy} onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
          </>
        )}
      </div>

      {panel === "here" && (
        <div className="org-bulk-panel">
          <div className="form-row">
            <label>
              Add {count} {noun} to a group in {organizationName}
            </label>
            {groupsIn(organizationId).length === 0 ? (
              <div className="org-empty-inline">{organizationName} has no groups yet — create one first.</div>
            ) : (
              <select value={hereGroupId} onChange={(e) => setHereGroupId(e.target.value)}>
                <option value="">Choose a group…</option>
                {groupsIn(organizationId).map((g) => (
                  <option value={g.id} key={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="org-inline-actions">
            <button type="button" onClick={closePanels} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !hereGroupId}
              onClick={() =>
                void act(() =>
                  api.moveUsers({ userIds: selected, organizationId, groupId: hereGroupId }),
                )
              }
            >
              {busy ? "Adding…" : "Add to group"}
            </button>
          </div>
        </div>
      )}

      {panel === "elsewhere" && (
        <div className="org-bulk-panel">
          <div className="form-two-col">
            <div className="form-row">
              <label>Organization</label>
              <select
                value={targetOrgId}
                onChange={(e) => {
                  setTargetOrgId(e.target.value);
                  // The old group belongs to the old organization; keeping
                  // it selected would submit a mismatched pair.
                  setTargetGroupId("");
                }}
              >
                <option value="">Choose an organization…</option>
                {organizationId !== null && <option value={UNASSIGNED}>Unassigned</option>}
                {organizations
                  .filter((o) => o.id !== organizationId)
                  .map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="form-row">
              <label>Group there (optional)</label>
              <select
                value={targetGroupId}
                disabled={!targetOrgId}
                onChange={(e) => setTargetGroupId(e.target.value)}
              >
                <option value="">
                  {!targetOrgId
                    ? "Pick an organization first"
                    : groupsIn(targetOrgId === UNASSIGNED ? null : targetOrgId).length === 0
                      ? "No groups there yet"
                      : "No group — just move them across"}
                </option>
                {groupsIn(targetOrgId === UNASSIGNED ? null : targetOrgId).map((g) => (
                  <option value={g.id} key={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="hint">
            They keep their login and their password. Any group they are in <strong>here</strong> lets them go —
            staying on {organizationName}'s rosters after moving would keep opening a browser for them under this
            organization.
          </div>
          <div className="org-inline-actions">
            <button type="button" onClick={closePanels} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !targetOrgId}
              onClick={() =>
                void act(() =>
                  api.moveUsers({
                    userIds: selected,
                    organizationId: targetOrgId === UNASSIGNED ? null : targetOrgId,
                    groupId: targetGroupId || null,
                  }),
                )
              }
            >
              {busy ? "Moving…" : `Move ${count} ${noun}`}
            </button>
          </div>
        </div>
      )}

      {users.length === 0 ? (
        <div className="org-empty-inline">
          No users in {organizationName} yet — add one from a group, or with “+ New user” above.
        </div>
      ) : (
        <div className="org-people-grid">
          {users.map((u) => {
            const memberships = allGroups.filter((g) => g.userIds.includes(u.id));
            const checked = selected.includes(u.id);
            return (
              <div className={`org-people-card${checked ? " selected" : ""}`} key={u.id}>
                <div className="org-people-name">
                  <label className="org-user-pick">
                    <input type="checkbox" checked={checked} onChange={() => toggle(u.id)} />
                    <UserStatusChip signedIn={u.signedIn} name={u.name} showLabel={false} />
                  </label>
                  <UserStatusChip signedIn={u.signedIn} subject={u.name} />
                </div>
                <div className="org-people-email" title={u.email}>
                  {u.email}
                </div>
                <div className="org-people-groups">
                  {memberships.length === 0 ? (
                    <span className="org-muted">in no group yet</span>
                  ) : (
                    memberships.map((g) => (
                      <span className="org-group-tag" key={g.id}>
                        {g.name}
                      </span>
                    ))
                  )}
                </div>
                <div className="org-user-actions">
                  {u.activeJobId && (
                    <button type="button" onClick={() => onOpenJob(u.activeJobId!)}>
                      Watch sign-in
                    </button>
                  )}
                  <button type="button" disabled={busy || !!u.activeJobId} onClick={() => onEditUser(u)}>
                    Settings
                  </button>
                  <button
                    type="button"
                    disabled={busy || !!u.activeJobId}
                    title={
                      u.activeJobId
                        ? "A sign-in run is already in progress"
                        : "Run the sign-in again with the stored password — the fix for an offline user"
                    }
                    onClick={() =>
                      void act(async () => {
                        const { jobId } = await api.reloginUser(u.id);
                        onOpenJob(jobId);
                      })
                    }
                  >
                    Re-sign in
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
