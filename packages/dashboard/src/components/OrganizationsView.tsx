import { useCallback, useEffect, useMemo, useState } from "react";
import type { GroupWithSchedule, OrganizationWithCounts, PlatformUser } from "../types";
import * as api from "../api";
import { groupMatches, userMatches } from "../orgSearch";
import { GroupModal } from "./GroupModal";
import { AddUserModal } from "./AddUserModal";
import { OrgGroupCard } from "./OrgGroupCard";
import { OrgUsersSection } from "./OrgUsersSection";

/**
 * The company view: organizations on the left, the selected organization's
 * departments (groups) and users on the right.
 *
 * Groups and users existed before organizations did, so "no organization"
 * has to remain a real, visible place — UNASSIGNED is a pseudo-organization
 * that stands in for it on the rail. It is never sent to the server; the
 * wire value for "unassigned" is null throughout.
 */
const UNASSIGNED = "__unassigned__";

interface OrgLike {
  id: string;
  name: string;
  description: string;
}

const UNASSIGNED_ORG: OrgLike = {
  id: UNASSIGNED,
  name: "Unassigned",
  description: "Groups and users that have not been filed under an organization yet.",
};

/** null (the wire value) ↔ UNASSIGNED (the rail's id for the same thing). */
function railId(organizationId: string | null): string {
  return organizationId ?? UNASSIGNED;
}

export function OrganizationsView({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [organizations, setOrganizations] = useState<OrganizationWithCounts[]>([]);
  const [groups, setGroups] = useState<GroupWithSchedule[]>([]);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [serverTimezone, setServerTimezone] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Creation / edit surfaces. Each holds the context it was opened from, so
  // "add a person" from inside the IT department already knows both the
  // organization and the group.
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgDraftName, setOrgDraftName] = useState("");
  const [orgDraftDescription, setOrgDraftDescription] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);
  const [editingOrgId, setEditingOrgId] = useState<string | null>(null);

  const [groupModal, setGroupModal] = useState<
    { mode: "create"; organizationId: string | null } | { mode: "edit"; group: GroupWithSchedule } | null
  >(null);
  const [userModal, setUserModal] = useState<
    { organizationId: string | null; groupId: string | null; groupName: string | null } | null
  >(null);
  // "Settings" on a user card — the same form as Add, in edit mode, so a
  // name, email, organization or password change is one surface, not two.
  const [editingUser, setEditingUser] = useState<PlatformUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [orgRes, groupRes, userRes] = await Promise.all([
        api.listOrganizations(),
        api.listGroups(),
        api.listUsers(),
      ]);
      setOrganizations(orgRes.organizations);
      setGroups(groupRes.groups);
      setServerTimezone(groupRes.serverTimezone);
      setUsers(userRes.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  // Groups go live and stop on the server's own clock, so the state pills
  // and countdowns here have to poll to stay honest — same reason the
  // Groups tab does.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const hasUnassigned = useMemo(
    () => groups.some((g) => !g.organizationId) || users.some((u) => !u.organizationId),
    [groups, users],
  );

  const rail: OrgLike[] = useMemo(
    () => (hasUnassigned ? [...organizations, UNASSIGNED_ORG] : organizations),
    [organizations, hasUnassigned],
  );

  const searching = query.trim().length > 0;

  /** Name lookup for the search haystack — a group is findable by the
   * organization it sits in, so the matcher needs that name. */
  const orgNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of organizations) map.set(o.id, o.name);
    return map;
  }, [organizations]);

  function organizationNameFor(organizationId: string | null): string {
    return organizationId ? (orgNameById.get(organizationId) ?? "") : UNASSIGNED_ORG.name;
  }

  const matchedGroups = useMemo(
    () => (searching ? groups.filter((g) => groupMatches(g, organizationNameFor(g.organizationId), query)) : groups),
    // organizationNameFor is derived from orgNameById, which is in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, query, searching, orgNameById],
  );

  const matchedUsers = useMemo(
    () => (searching ? users.filter((u) => userMatches(u, organizationNameFor(u.organizationId), query)) : users),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users, query, searching, orgNameById],
  );

  // Which rail entries a search actually turned anything up in — used both
  // to badge the rail and to decide what the right-hand pane shows.
  const railIdsWithHits = useMemo(() => {
    const ids = new Set<string>();
    for (const g of matchedGroups) ids.add(railId(g.organizationId));
    for (const u of matchedUsers) ids.add(railId(u.organizationId));
    // An organization whose own name matches is a hit even when it's empty.
    if (searching) {
      const q = query.trim().toLowerCase();
      for (const o of organizations) if (o.name.toLowerCase().includes(q)) ids.add(o.id);
    }
    return ids;
  }, [matchedGroups, matchedUsers, organizations, query, searching]);

  // Keep a valid selection as organizations come and go. Picking the first
  // one on load means the pane is never blank when there's something to show.
  useEffect(() => {
    if (!loaded || rail.length === 0) return;
    if (selectedId === null || !rail.some((o) => o.id === selectedId)) {
      setSelectedId(rail[0].id);
    }
  }, [rail, selectedId, loaded]);

  const selected = rail.find((o) => o.id === selectedId) ?? null;

  /** The organizations a search found something in, in rail order — the
   * right-hand pane walks these while searching, and just the selected one
   * otherwise. */
  const shownOrgs = searching ? rail.filter((o) => railIdsWithHits.has(o.id)) : selected ? [selected] : [];

  function groupsIn(org: OrgLike): GroupWithSchedule[] {
    const source = searching ? matchedGroups : groups;
    return source.filter((g) => railId(g.organizationId) === org.id);
  }

  function usersIn(org: OrgLike): PlatformUser[] {
    const source = searching ? matchedUsers : users;
    return source.filter((u) => railId(u.organizationId) === org.id);
  }

  /** The wire value for an org-shaped id: UNASSIGNED means null. */
  function wireOrgId(org: OrgLike): string | null {
    return org.id === UNASSIGNED ? null : org.id;
  }

  function startCreatingOrg() {
    setEditingOrgId(null);
    setOrgDraftName("");
    setOrgDraftDescription("");
    setCreatingOrg(true);
  }

  function startEditingOrg(org: OrganizationWithCounts) {
    setCreatingOrg(false);
    setOrgDraftName(org.name);
    setOrgDraftDescription(org.description);
    setEditingOrgId(org.id);
  }

  function cancelOrgForm() {
    setCreatingOrg(false);
    setEditingOrgId(null);
    setOrgDraftName("");
    setOrgDraftDescription("");
  }

  async function submitOrgForm(e: React.FormEvent) {
    e.preventDefault();
    const name = orgDraftName.trim();
    if (!name) return;
    setSavingOrg(true);
    setError(null);
    try {
      if (editingOrgId) {
        await api.updateOrganization(editingOrgId, { name, description: orgDraftDescription.trim() });
        cancelOrgForm();
        await refresh();
      } else {
        const { organization } = await api.createOrganization({ name, description: orgDraftDescription.trim() });
        cancelOrgForm();
        // Refresh BEFORE selecting: the "keep a valid selection" effect
        // resets any id the rail doesn't hold yet, so selecting first would
        // be undone the moment it ran, dropping you back on the old
        // organization instead of the one you just made.
        await refresh();
        setSelectedId(organization.id);
        setQuery("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingOrg(false);
    }
  }

  async function deleteOrg(org: OrganizationWithCounts) {
    if (!confirm(`Delete the organization "${org.name}"?`)) return;
    setError(null);
    try {
      await api.deleteOrganization(org.id);
      setSelectedId(null);
      await refresh();
    } catch (err) {
      // The server refuses while the organization still holds anything, and
      // its message names what's left — show it as it is.
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const totalHits = searching ? matchedGroups.length + matchedUsers.length : 0;
  const orgFormOpen = creatingOrg || editingOrgId !== null;

  return (
    <div className="org-page">
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Organizations</h2>
          <span className="hint">
            an organization holds departments, a department holds users {serverTimezone && `· all times ${serverTimezone}`}
          </span>
        </div>
      </div>

      {/* One field for the whole page: organization, department, person,
          link, or a time of day. */}
      <div className="filter-bar org-master-search">
        <div className="search-field">
          <span className="search-icon">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything — organization, group, user, link, or a time like 1:00 PM…"
          />
        </div>
        {searching && (
          <>
            <span className="filter-count">
              {totalHits === 0
                ? "no matches"
                : `${matchedGroups.length} group${matchedGroups.length === 1 ? "" : "s"}, ${matchedUsers.length} ${
                    matchedUsers.length === 1 ? "user" : "users"
                  }`}
            </span>
            <button type="button" onClick={() => setQuery("")}>
              Clear
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="error-banner" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div className="org-layout">
        <aside className="org-rail">
          <div className="org-rail-head">
            <span className="eyebrow">Organizations</span>
            <button type="button" className="primary" onClick={startCreatingOrg}>
              + New
            </button>
          </div>

          {creatingOrg && (
            <form className="org-inline-form" onSubmit={submitOrgForm}>
              <input
                type="text"
                autoFocus
                value={orgDraftName}
                onChange={(e) => setOrgDraftName(e.target.value)}
                placeholder="Organization name"
                maxLength={80}
              />
              <input
                type="text"
                value={orgDraftDescription}
                onChange={(e) => setOrgDraftDescription(e.target.value)}
                placeholder="What it is (optional)"
                maxLength={240}
              />
              <div className="org-inline-actions">
                <button type="button" onClick={cancelOrgForm} disabled={savingOrg}>
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={savingOrg || !orgDraftName.trim()}>
                  {savingOrg ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          )}

          {loaded && rail.length === 0 && !creatingOrg && (
            <div className="org-empty-inline">No organizations yet.</div>
          )}

          <ul className="org-rail-list">
            {rail.map((org) => {
              const counts =
                org.id === UNASSIGNED
                  ? {
                      groupCount: groups.filter((g) => !g.organizationId).length,
                      userCount: users.filter((u) => !u.organizationId).length,
                    }
                  : organizations.find((o) => o.id === org.id)!;
              const hit = searching && railIdsWithHits.has(org.id);
              return (
                <li key={org.id}>
                  <button
                    type="button"
                    className={`org-rail-item${org.id === selectedId && !searching ? " active" : ""}${hit ? " hit" : ""}`}
                    onClick={() => {
                      setSelectedId(org.id);
                      setQuery("");
                      setExpandedGroupId(null);
                    }}
                  >
                    <span className="org-rail-name">{org.name}</span>
                    <span className="org-rail-counts">
                      {counts.groupCount} group{counts.groupCount === 1 ? "" : "s"} · {counts.userCount}{" "}
                      {counts.userCount === 1 ? "user" : "users"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <main className="org-detail">
          {loaded && rail.length === 0 ? (
            <div className="empty-state">
              Nothing here yet. Create an organization — your company, a client, a campus — then add departments to
              it, and users to those.
            </div>
          ) : searching && shownOrgs.length === 0 ? (
            <div className="empty-state">Nothing matches “{query.trim()}”.</div>
          ) : (
            shownOrgs.map((org) => {
              const orgGroups = groupsIn(org);
              const orgUsers = usersIn(org);
              const record = organizations.find((o) => o.id === org.id) ?? null;
              const editingThis = editingOrgId === org.id;
              // Everyone in the organization who could still be brought into
              // a group — computed off the unfiltered list so a search never
              // shrinks the pick list inside a card.
              const allOrgUsers = users.filter((u) => railId(u.organizationId) === org.id);

              return (
                <section className="org-section" key={org.id}>
                  <div className="org-section-head">
                    <div className="org-section-identity">
                      {editingThis ? (
                        <form className="org-inline-form wide" onSubmit={submitOrgForm}>
                          <input
                            type="text"
                            autoFocus
                            value={orgDraftName}
                            onChange={(e) => setOrgDraftName(e.target.value)}
                            maxLength={80}
                          />
                          <input
                            type="text"
                            value={orgDraftDescription}
                            onChange={(e) => setOrgDraftDescription(e.target.value)}
                            placeholder="What it is (optional)"
                            maxLength={240}
                          />
                          <div className="org-inline-actions">
                            <button type="button" onClick={cancelOrgForm} disabled={savingOrg}>
                              Cancel
                            </button>
                            <button type="submit" className="primary" disabled={savingOrg || !orgDraftName.trim()}>
                              {savingOrg ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <h3>{org.name}</h3>
                          {/* UNASSIGNED_ORG carries its own explanatory
                              description; a real organization simply shows
                              nothing when it was left blank. */}
                          {org.description && <span className="hint">{org.description}</span>}
                        </>
                      )}
                    </div>

                    {!editingThis && (
                      <div className="org-section-actions">
                        <button type="button" className="primary" onClick={() => setGroupModal({ mode: "create", organizationId: wireOrgId(org) })}>
                          + New group
                        </button>
                        <button
                          type="button"
                          onClick={() => setUserModal({ organizationId: wireOrgId(org), groupId: null, groupName: null })}
                        >
                          + New user
                        </button>
                        {record && (
                          <>
                            <button type="button" onClick={() => startEditingOrg(record)} disabled={orgFormOpen}>
                              Rename
                            </button>
                            <button type="button" className="danger" onClick={() => void deleteOrg(record)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {orgGroups.length === 0 ? (
                    <div className="org-empty-inline">
                      {searching
                        ? `No group in ${org.name} matches that search.`
                        : `No groups in ${org.name} yet — create one (an "IT department", an evening class, a shift) and put users in it.`}
                    </div>
                  ) : (
                    <div className="org-group-list">
                      {orgGroups.map((g) => (
                        <OrgGroupCard
                          key={g.id}
                          group={g}
                          organizationName={org.name}
                          candidates={allOrgUsers.filter((u) => !g.userIds.includes(u.id))}
                          expanded={expandedGroupId === g.id}
                          onToggle={() => setExpandedGroupId((cur) => (cur === g.id ? null : g.id))}
                          onEdit={() => setGroupModal({ mode: "edit", group: g })}
                          onAddPerson={() =>
                            setUserModal({ organizationId: wireOrgId(org), groupId: g.id, groupName: g.name })
                          }
                          onChanged={refresh}
                          onOpenJob={onOpenJob}
                          onError={setError}
                        />
                      ))}
                    </div>
                  )}

                  {/* Groups first, then everyone in the organization — a
                      user can exist (and have a login) before they belong to
                      any department, so the roster is always shown, even
                      empty. Hiding it would look like data loss. */}
                  <OrgUsersSection
                    key={org.id}
                    organizationId={wireOrgId(org)}
                    organizationName={org.name}
                    users={orgUsers}
                    allGroups={groups}
                    organizations={organizations}
                    onChanged={refresh}
                    onError={setError}
                    onEditUser={(u) => setEditingUser(u)}
                    onOpenJob={onOpenJob}
                  />
                </section>
              );
            })
          )}
        </main>
      </div>

      {groupModal && (
        <GroupModal
          key={groupModal.mode === "edit" ? groupModal.group.id : "new"}
          group={groupModal.mode === "edit" ? groupModal.group : undefined}
          defaultOrganizationId={groupModal.mode === "create" ? groupModal.organizationId : null}
          serverTimezone={serverTimezone}
          onClose={() => setGroupModal(null)}
          onSaved={() => {
            setGroupModal(null);
            void refresh();
          }}
        />
      )}

      {userModal && (
        <AddUserModal
          defaultOrganizationId={userModal.organizationId}
          groupId={userModal.groupId}
          groupName={userModal.groupName}
          onClose={() => setUserModal(null)}
          onSaved={(jobId) => {
            setUserModal(null);
            void refresh();
            if (jobId) onOpenJob(jobId);
          }}
        />
      )}

      {editingUser && (
        // Keyed by id so switching straight from one user's Settings to
        // another's remounts the form with the new values.
        <AddUserModal
          key={editingUser.id}
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={(jobId) => {
            setEditingUser(null);
            void refresh();
            if (jobId) onOpenJob(jobId);
          }}
        />
      )}
    </div>
  );
}
