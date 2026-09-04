import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GroupWithSchedule,
  Job,
  OrganizationWithCounts,
  PlatformUser,
  RunHistoryRow,
} from "../types";
import * as api from "../api";
import { StatusBadge } from "./StatusBadge";
import { UserStatusChip } from "./UserStatusChip";
import { relative, to12Hour } from "../format";
import { groupMatches, userMatches } from "../orgSearch";
import { useDeveloperView } from "../developerView";

const UNASSIGNED = "__unassigned__";
const UNASSIGNED_NAME = "Unassigned";

function fmtTime(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
}

function fmtDuration(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) return "—";
  const mins = Math.round(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** What a group is doing, in the one word the Tasks list shows. */
function taskState(g: GroupWithSchedule, paused: boolean): { label: string; tone: string } {
  if (g.activeJobId) return { label: "running", tone: "live" };
  if (!g.enabled) return { label: "paused", tone: "held" };
  if (paused) return { label: "held", tone: "held" };
  const spent = g.schedule.occurrenceKey !== null && g.lastOccurrenceKey === g.schedule.occurrenceKey;
  if (g.schedule.inWindow && !spent) return { label: "starting", tone: "live" };
  return { label: "upcoming", tone: "idle" };
}

/**
 * The half-sentence under a task's window that answers the question people
 * actually have — "so when does this happen?".
 *
 * The window on its own ("5:00 PM → 9:00 PM") does not answer it: whether
 * that is in ten minutes or next Tuesday depends on the group's weekdays
 * and its timezone, neither of which is on the row. The countdown is
 * computed server-side against the clock that actually fires these, so it
 * stays honest even when the viewer's own clock is somewhere else.
 */
function taskWhen(g: GroupWithSchedule, paused: boolean): string {
  if (g.activeJobId) {
    if (g.activeRunIsManual) return "started by hand";
    return `stops in ${relative(g.schedule.minutesUntilEnd)}`;
  }
  if (paused) return "everything is paused";
  if (!g.enabled) return "only runs on Join now";
  const spent = g.schedule.occurrenceKey !== null && g.lastOccurrenceKey === g.schedule.occurrenceKey;
  if (g.schedule.inWindow && !spent) return "starting now";
  return `starts in ${relative(g.schedule.minutesUntilStart)}`;
}

/**
 * The landing page.
 *
 * Two audiences, one screen. By default this answers "is the business set
 * up and is anything broken" — counts, a search, the organizations, and
 * what is scheduled. The run log, session tallies and live-run controls are
 * diagnostics; they only appear under Developer view (Settings → Advanced),
 * because putting them first makes a working system look like a monitoring
 * console and buries the thing most people came for.
 */
export function DashboardView({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const developer = useDeveloperView();

  const [organizations, setOrganizations] = useState<OrganizationWithCounts[]>([]);
  const [groups, setGroups] = useState<GroupWithSchedule[]>([]);
  const [people, setPeople] = useState<PlatformUser[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<(RunHistoryRow & { localDate: string })[]>([]);
  const [paused, setPaused] = useState(false);
  const [timezone, setTimezone] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [orgRes, groupsRes, peopleRes, jobsRes, statusRes, history] = await Promise.all([
        api.listOrganizations(),
        api.listGroups(),
        api.listUsers(),
        api.listJobs(),
        api.getSystemStatus(),
        api.getHistory(),
      ]);
      setOrganizations(orgRes.organizations);
      setGroups(groupsRes.groups);
      setPeople(peopleRes.users);
      setJobs(jobsRes.jobs);
      setPaused(statusRes.paused);
      setRuns(history.runs);
      setTimezone(history.serverTimezone);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function doStopAll() {
    if (!confirm("Stop every running task and pause the schedule? Nothing new will start until you hit Resume.")) {
      return;
    }
    setStopAllBusy(true);
    try {
      await api.stopAllNow();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopAllBusy(false);
    }
  }

  async function doResume() {
    setStopAllBusy(true);
    try {
      await api.resumeAll();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopAllBusy(false);
    }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setRowBusy(id);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy(null);
    }
  }

  // ---------- names, for search and for the small text on a task ----------

  const orgNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of organizations) map.set(o.id, o.name);
    return map;
  }, [organizations]);

  const orgNameOf = useCallback(
    (id: string | null) => (id ? (orgNameById.get(id) ?? "") : UNASSIGNED_NAME),
    [orgNameById],
  );

  // ---------- the four numbers ----------

  // Failures worth reacting to are recent ones. A count of every failure
  // ever would only ever grow, and a number that never improves stops being
  // read at all.
  const failures = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return runs
      .filter((r) => new Date(r.createdAt).getTime() >= cutoff)
      .reduce((sum, r) => sum + r.failed, 0);
  }, [runs]);

  // ---------- search ----------

  const searching = query.trim().length > 0;

  const matchedGroups = useMemo(
    () => (searching ? groups.filter((g) => groupMatches(g, orgNameOf(g.organizationId), query)) : groups),
    [groups, query, searching, orgNameOf],
  );

  const matchedPeople = useMemo(
    () => (searching ? people.filter((u) => userMatches(u, orgNameOf(u.organizationId), query)) : people),
    [people, query, searching, orgNameOf],
  );

  /** Organization rows for the list, including an "Unassigned" row when
   * anything still sits outside an organization. */
  const orgRows = useMemo(() => {
    const rows = organizations.map((o) => ({ id: o.id, name: o.name, description: o.description }));
    if (groups.some((g) => !g.organizationId) || people.some((p) => !p.organizationId)) {
      rows.push({ id: UNASSIGNED, name: UNASSIGNED_NAME, description: "" });
    }
    return rows;
  }, [organizations, groups, people]);

  const railId = (organizationId: string | null) => organizationId ?? UNASSIGNED;

  const visibleOrgRows = useMemo(() => {
    if (!searching) return orgRows;
    const q = query.trim().toLowerCase();
    const hits = new Set<string>();
    for (const g of matchedGroups) hits.add(railId(g.organizationId));
    for (const p of matchedPeople) hits.add(railId(p.organizationId));
    for (const o of orgRows) if (o.name.toLowerCase().includes(q)) hits.add(o.id);
    return orgRows.filter((o) => hits.has(o.id));
  }, [orgRows, matchedGroups, matchedPeople, query, searching]);

  // A search should show what it found, not make you open each card again.
  const isOpen = (id: string) => searching || expanded === id;

  const tasks = useMemo(
    () =>
      [...matchedGroups].sort((a, b) => {
        const aLive = a.activeJobId ? 0 : 1;
        const bLive = b.activeJobId ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        return a.schedule.minutesUntilStart - b.schedule.minutesUntilStart;
      }),
    [matchedGroups],
  );

  // ---------- developer-only bits ----------

  const liveGroups = groups.filter((g) => g.activeJobId);
  const groupJobIds = new Set(liveGroups.map((g) => g.activeJobId));
  const liveStandaloneJobs = jobs.filter(
    (j) => !j.groupId && (j.status === "pending" || j.status === "running") && !groupJobIds.has(j.id),
  );
  const devRuns = searching
    ? runs.filter((r) => {
        const q = query.trim().toLowerCase();
        return (
          r.name.toLowerCase().includes(q) ||
          (r.groupName ?? "").toLowerCase().includes(q) ||
          r.userNames.some((n) => n.toLowerCase().includes(q)) ||
          r.targetUrl.toLowerCase().includes(q)
        );
      })
    : runs;

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Dashboard</h2>
          {timezone && <span className="hint">all times {timezone}</span>}
        </div>
        <div className="job-toolbar-actions">
          {paused ? (
            <button className="primary" onClick={doResume} disabled={stopAllBusy}>
              {stopAllBusy ? "Resuming…" : "▶ Resume"}
            </button>
          ) : (
            <button className="danger" onClick={doStopAll} disabled={stopAllBusy}>
              {stopAllBusy ? "Stopping…" : "■ Stop all"}
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {paused && (
        <div className="error-banner" style={{ marginBottom: 14 }}>
          Paused — the schedule is stopped and nothing new will start. Click <strong>Resume</strong> above when
          you're ready.
        </div>
      )}

      {/* The four numbers, first thing on the page. */}
      <div className="stat-row">
        <div className="stat-card">
          <span className="stat-value">{organizations.length}</span>
          <span className="stat-label">organizations</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{groups.length}</span>
          <span className="stat-label">groups</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{people.length}</span>
          <span className="stat-label">people</span>
        </div>
        <div className={`stat-card${failures > 0 ? " bad" : ""}`}>
          <span className="stat-value">{failures}</span>
          <span className="stat-label">failures · 24h</span>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-field">
          <span className="search-icon">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search organizations, groups, people, links, or a time like 1:00 PM…"
          />
        </div>
        {searching && (
          <>
            <span className="filter-count">
              {matchedGroups.length} group{matchedGroups.length === 1 ? "" : "s"}, {matchedPeople.length}{" "}
              {matchedPeople.length === 1 ? "person" : "people"}
            </span>
            <button type="button" onClick={() => setQuery("")}>
              Clear
            </button>
          </>
        )}
      </div>

      {/* Organizations — closed by default; a click reveals what is inside. */}
      {loaded && orgRows.length === 0 && (
        <div className="empty-state">
          <p>Nothing set up yet. Three steps, in this order:</p>
          <ol className="empty-steps">
            <li>
              Make an <a href="#/organizations">organization</a> — the company or team the work belongs to.
            </li>
            <li>Add the people who will run in it, so each one keeps their own saved login.</li>
            <li>
              Create a <a href="#/groups">group</a>: a link, a task written in plain English, and the times it
              should run. From then on the server does it on its own.
            </li>
          </ol>
        </div>
      )}

      {searching && visibleOrgRows.length === 0 && orgRows.length > 0 && (
        <div className="empty-state">Nothing matches “{query.trim()}”.</div>
      )}

      <div className="org-summary-list">
        {visibleOrgRows.map((org) => {
          const orgGroups = matchedGroups.filter((g) => railId(g.organizationId) === org.id);
          const orgPeople = matchedPeople.filter((p) => railId(p.organizationId) === org.id);
          const open = isOpen(org.id);
          return (
            <div className={`org-summary${open ? " open" : ""}`} key={org.id}>
              <button
                type="button"
                className="org-summary-head"
                aria-expanded={open}
                onClick={() => setExpanded(expanded === org.id ? null : org.id)}
              >
                <span className="org-summary-chevron" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                <span className="org-summary-name">{org.name}</span>
                <span className="org-summary-counts">
                  {orgGroups.length} group{orgGroups.length === 1 ? "" : "s"} · {orgPeople.length}{" "}
                  {orgPeople.length === 1 ? "person" : "people"}
                </span>
              </button>

              {open && (
                <div className="org-summary-body">
                  <div className="org-summary-block">
                    <span className="org-summary-label">Groups</span>
                    {orgGroups.length === 0 ? (
                      <span className="dim">none</span>
                    ) : (
                      <div className="org-summary-chips">
                        {orgGroups.map((g) => (
                          <span className="org-group-tag" key={g.id}>
                            {g.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="org-summary-block">
                    <span className="org-summary-label">People</span>
                    {orgPeople.length === 0 ? (
                      <span className="dim">none</span>
                    ) : (
                      <div className="org-summary-chips">
                        {orgPeople.map((p) => (
                          <UserStatusChip key={p.id} signedIn={p.signedIn} name={p.name} showLabel={false} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Tasks: one line per group — name, organization, window, state. */}
      {loaded && orgRows.length > 0 && tasks.length === 0 && !searching && (
        <div className="empty-state" style={{ marginTop: 20 }}>
          No scheduled tasks yet — <a href="#/groups">create a group</a> and the server will run it on its own.
        </div>
      )}

      {tasks.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 26 }}>
            Tasks
          </div>
          <div className="task-list">
            {tasks.map((g) => {
              const state = taskState(g, paused);
              return (
                <div className={`task-row tone-${state.tone}`} key={g.id}>
                  <span className="task-name">
                    {g.name}
                    <span className="task-org">{orgNameOf(g.organizationId)}</span>
                  </span>
                  <span className="task-window">
                    {to12Hour(g.schedule.effectiveStart)} → {to12Hour(g.endTime)}
                    <span className="task-when">{taskWhen(g, paused)}</span>
                  </span>
                  <span className={`task-state ${state.tone}`}>{state.label}</span>
                  {/* Every one of these used to be a dead end: the row told
                      you a task was running and gave you no way to look at
                      it or stop it unless you first found the Developer
                      view toggle buried in Settings. */}
                  <span className="task-actions">
                    {g.activeJobId ? (
                      <>
                        <button onClick={() => onOpenJob(g.activeJobId!)}>Watch</button>
                        <button
                          className="danger"
                          disabled={rowBusy === g.id}
                          onClick={() => void act(g.id, () => api.stopGroupNow(g.id))}
                        >
                          Stop
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={rowBusy === g.id || paused}
                        title={paused ? "Everything is paused — hit Resume first" : "Start this task right now"}
                        onClick={() =>
                          void act(g.id, async () => {
                            const { jobId } = await api.runGroupNow(g.id);
                            onOpenJob(jobId);
                          })
                        }
                      >
                        {rowBusy === g.id ? "Starting…" : "Join now"}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ---------- everything below is Developer view only ---------- */}

      {developer && (
        <div className="dev-section">
          <div className="eyebrow">Developer view · live now</div>
          {liveGroups.length + liveStandaloneJobs.length === 0 ? (
            <div className="empty-state" style={{ padding: "18px 0" }}>
              Nothing running right now.
            </div>
          ) : (
            <div className="group-list" style={{ marginBottom: 24 }}>
              {liveGroups.map((g) => (
                <div className="card session-box" key={g.id}>
                  <div className="session-head">
                    <span className="name">{g.name}</span>
                    <StatusBadge status="running" />
                  </div>
                  <div className="group-meta">
                    <span>
                      {g.activeRunIsManual ? "Started by hand" : `Stops ${to12Hour(g.endTime)}`}
                      {!g.activeRunIsManual && ` · in ${relative(g.schedule.minutesUntilEnd)}`}
                    </span>
                  </div>
                  <div className="session-controls">
                    <button onClick={() => onOpenJob(g.activeJobId!)}>Watch live</button>
                    <button
                      className="danger"
                      disabled={rowBusy === g.id}
                      onClick={() => void act(g.id, () => api.stopGroupNow(g.id))}
                    >
                      Stop
                    </button>
                  </div>
                </div>
              ))}
              {liveStandaloneJobs.map((j) => (
                <div className="card session-box" key={j.id}>
                  <div className="session-head">
                    <span className="name">{j.name}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  <div className="group-meta">
                    <span className="dim">custom run</span>
                  </div>
                  <div className="session-controls">
                    <button onClick={() => onOpenJob(j.id)}>Watch live</button>
                    <button
                      className="danger"
                      disabled={rowBusy === j.id}
                      onClick={() => void act(j.id, () => api.stopAll(j.id))}
                    >
                      Stop
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="eyebrow">Developer view · run log</div>
          {devRuns.length === 0 ? (
            <div className="empty-state">Nothing has run yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Group</th>
                    <th>Users</th>
                    <th>Outcome</th>
                    <th>Started</th>
                    <th>Took</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {devRuns.map((r) => (
                    <tr key={r.jobId} onClick={() => onOpenJob(r.jobId)} title="Open this run">
                      <td>
                        <span className="run-name">{r.name}</span>
                        <span className="run-url">{r.targetUrl}</span>
                      </td>
                      <td>{r.groupName ?? <span className="dim">one-off</span>}</td>
                      <td>
                        {r.sessionCount}
                        {r.userNames.length > 0 && <span className="run-users">{r.userNames.join(", ")}</span>}
                      </td>
                      <td>
                        <span className="tally ok">{r.completed}✓</span>
                        {r.failed > 0 && <span className="tally bad">{r.failed}✕</span>}
                        {r.stopped > 0 && <span className="tally dim">{r.stopped}■</span>}
                      </td>
                      <td>
                        {r.localDate}
                        <span className="dim"> {fmtTime(r.startedAt, timezone)}</span>
                      </td>
                      <td>{fmtDuration(r.startedAt, r.finishedAt)}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
