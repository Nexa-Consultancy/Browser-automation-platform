import { useCallback, useEffect, useState } from "react";
import type { GroupWithSchedule } from "../types";
import * as api from "../api";
import { GroupModal } from "./GroupModal";

/** "3d 4h" / "3h 12m" / "45m" — the countdown to the next boundary. Once a
 * group only runs on some weekdays the next start can be days out, so this
 * has to carry a day component. -1 means "no day is selected". */
function relative(minutes: number): string {
  if (minutes < 0) return "never";
  if (minutes === 0) return "now";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Every day" / "Mon–Fri" / "Mon, Wed, Fri" — the shortest true phrasing. */
function describeDays(days: number[]): string {
  const set = [...days].sort((a, b) => a - b);
  if (set.length === 7) return "Every day";
  if (set.length === 5 && set.join() === "1,2,3,4,5") return "Mon–Fri";
  if (set.length === 2 && set.join() === "0,6") return "Weekends";
  // Monday-first, matching the order the checkboxes are shown in.
  const ordered = [1, 2, 3, 4, 5, 6, 0].filter((d) => set.includes(d));
  return ordered.map((d) => DAY_LABELS[d]).join(", ") || "No days selected";
}

function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function GroupList({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [groups, setGroups] = useState<GroupWithSchedule[]>([]);
  const [serverTimezone, setServerTimezone] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<GroupWithSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [createdOn, setCreatedOn] = useState(""); // "YYYY-MM-DD", empty = any

  const filtered = groups.filter((g) => {
    const q = query.trim().toLowerCase();
    const matchesText =
      !q ||
      g.name.toLowerCase().includes(q) ||
      g.userNames.some((n) => n.toLowerCase().includes(q));
    // Compare the creation date as it reads in the group's own zone, so a
    // group made late in the evening doesn't file itself under tomorrow the
    // way a raw UTC timestamp would. "en-CA" formats as YYYY-MM-DD, which is
    // exactly what a date input gives back.
    const matchesDate =
      !createdOn ||
      new Date(g.createdAt).toLocaleDateString("en-CA", { timeZone: g.timezone }) === createdOn;
    return matchesText && matchesDate;
  });

  const refresh = useCallback(async () => {
    try {
      const res = await api.listGroups();
      setGroups(res.groups);
      setServerTimezone(res.serverTimezone);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  // The scheduler acts on its own clock, so this view has to poll to stay
  // honest — a group can go live (or be stopped at its end time) with
  // nobody touching the page.
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
          <h2>Automations</h2>
          {serverTimezone && (
            <span className="hint">
              all times {serverTimezone}
              {groups[0] ? ` · now ${to12Hour(groups[0].schedule.localTime)}` : ""}
            </span>
          )}
        </div>
        <div className="job-toolbar-actions">
          <button className="primary" onClick={() => setModalOpen(true)}>
            + Create new group
          </button>
        </div>
      </div>

      {groups.length > 0 && (
        <div className="filter-bar">
          <div className="search-field">
            <span className="search-icon">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by group name or user name…"
            />
          </div>
          <div className="filter-field">
            <label htmlFor="created-filter">Created on</label>
            <input
              id="created-filter"
              type="date"
              value={createdOn}
              onChange={(e) => setCreatedOn(e.target.value)}
            />
          </div>
          {(query || createdOn) && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setCreatedOn("");
              }}
            >
              Clear
            </button>
          )}
          <span className="filter-count">
            {filtered.length} of {groups.length}
          </span>
        </div>
      )}

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {loaded && groups.length === 0 && (
        <div className="empty-state">
          No automations yet — create a group and the server runs it on schedule, on its own.
        </div>
      )}

      {loaded && groups.length > 0 && filtered.length === 0 && (
        <div className="empty-state">No group matches that search.</div>
      )}

      <div className="group-list">
        {filtered.map((g) => {
          const live = !!g.activeJobId;
          // A window fires once. If this occurrence has already run and was
          // stopped, we're inside the window but nothing is going to start —
          // saying "starting" there would be a lie the user waits on.
          const spent =
            g.schedule.occurrenceKey !== null && g.lastOccurrenceKey === g.schedule.occurrenceKey;
          const pending = g.enabled && g.schedule.inWindow && !spent;
          const state = live
            ? g.activeRunIsManual
              ? "manual"
              : "live"
            : !g.enabled
              ? "held"
              : pending
                ? "starting"
                : "idle";
          return (
            <div className={`group-card state-${state}`} key={g.id}>
              <div className="group-card-head">
                <div className="group-title">
                  <span className="group-dot" />
                  <span className="name">{g.name}</span>
                  <span className="group-state">{state}</span>
                </div>
                <div className="group-window">
                  <span className="group-days">{describeDays(g.days)}</span>
                  {to12Hour(g.schedule.effectiveStart)} → {to12Hour(g.endTime)}
                  {g.leadMinutes > 0 && (
                    <span
                      className="group-lead"
                      title={`Starts ${g.leadMinutes} min before the ${to12Hour(g.startTime)} event`}
                    >
                      {g.leadMinutes}m early
                    </span>
                  )}
                  <span className="tz">{g.timezone}</span>
                </div>
              </div>

              <div className="group-meta">
                <span className="target">{g.targetUrl}</span>
                <span>·</span>
                <span>
                  {g.userNames.length} user{g.userNames.length === 1 ? "" : "s"}: {g.userNames.join(", ")}
                </span>
              </div>

              <div className="group-countdown">
                {live && g.activeRunIsManual
                  ? "Running now, started by hand — it keeps going until you stop it."
                  : live
                    ? `Running now · stops in ${relative(g.schedule.minutesUntilEnd)}`
                    : !g.enabled
                      ? "Held off by hand — runs only when you press Join now."
                      : pending
                        ? "Inside its window — starting within a few seconds"
                        : spent
                          ? `Already ran in this window · next start in ${relative(g.schedule.minutesUntilStart)}`
                          : `Next start in ${relative(g.schedule.minutesUntilStart)}`}
              </div>

              <div className="group-actions">
                {g.activeJobId && (
                  <button onClick={() => onOpenJob(g.activeJobId!)}>Watch live</button>
                )}
                {live ? (
                  <button
                    className="danger"
                    disabled={busy === g.id}
                    onClick={() => act(g.id, () => api.stopGroupNow(g.id))}
                  >
                    ■ Stop now
                  </button>
                ) : (
                  <button
                    disabled={busy === g.id}
                    onClick={() =>
                      act(g.id, async () => {
                        const { jobId } = await api.runGroupNow(g.id);
                        onOpenJob(jobId);
                      })
                    }
                  >
                    ▶ Join now
                  </button>
                )}
                <button
                  disabled={busy === g.id}
                  title="Follow this schedule automatically"
                  onClick={() => act(g.id, () => api.setGroupEnabled(g.id, !g.enabled))}
                >
                  {g.enabled ? "Hold off schedule" : "Follow schedule"}
                </button>
                <button disabled={busy === g.id} onClick={() => setEditing(g)}>
                  Edit
                </button>
                <button
                  disabled={busy === g.id || live}
                  title={
                    live
                      ? "Stop the run before clearing saved logins"
                      : "Delete this group's saved cookies/logins so the next run starts signed out"
                  }
                  onClick={() => {
                    if (confirm(`Clear saved logins for "${g.name}"? Every user in it will start the next run signed out.`)) {
                      void act(g.id, () => api.clearGroupProfiles(g.id));
                    }
                  }}
                >
                  Clear saved logins
                </button>
                <button
                  className="danger"
                  disabled={busy === g.id}
                  onClick={() => {
                    if (confirm(`Delete group "${g.name}"? Any run it has open will be stopped.`)) {
                      void act(g.id, () => api.deleteGroup(g.id));
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {modalOpen && (
        <GroupModal
          serverTimezone={serverTimezone}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            void refresh();
          }}
        />
      )}

      {editing && (
        // Keyed by id so switching straight from one group's Edit to
        // another's remounts the form with the new group's values instead
        // of keeping the first one's state.
        <GroupModal
          key={editing.id}
          group={editing}
          serverTimezone={serverTimezone}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
