import { useCallback, useEffect, useState } from "react";
import type { DailyReport, GroupWithSchedule, Job, RunHistoryRow } from "../types";
import * as api from "../api";
import { StatusBadge } from "./StatusBadge";
import { relative, to12Hour } from "../format";

function fmtTime(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDuration(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * The landing page: what's live right now, what's coming up on the
 * schedule, the emergency stop-all/resume, and — unchanged from the old
 * "View more" — every past run with the daily totals. A row here already
 * opens the run's session view (onOpenJob -> JobView), so drilling into a
 * run's individual user sessions needs no new UI, just this entry point.
 */
export function DashboardView({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [groups, setGroups] = useState<GroupWithSchedule[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [paused, setPaused] = useState(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const [runs, setRuns] = useState<(RunHistoryRow & { localDate: string })[]>([]);
  const [daily, setDaily] = useState<DailyReport[]>([]);
  const [timezone, setTimezone] = useState("");
  const [query, setQuery] = useState("");
  const [onDate, setOnDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [history, groupsRes, jobsRes, statusRes] = await Promise.all([
        api.getHistory(),
        api.listGroups(),
        api.listJobs(),
        api.getSystemStatus(),
      ]);
      setRuns(history.runs);
      setDaily(history.daily);
      setTimezone(history.serverTimezone);
      setGroups(groupsRes.groups);
      setJobs(jobsRes.jobs);
      setPaused(statusRes.paused);
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

  async function stopGroupRow(groupId: string) {
    setRowBusy(groupId);
    try {
      await api.stopGroupNow(groupId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy(null);
    }
  }

  async function stopJobRow(jobId: string) {
    setRowBusy(jobId);
    try {
      await api.stopAll(jobId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy(null);
    }
  }

  const liveGroups = groups.filter((g) => g.activeJobId);
  const groupJobIds = new Set(liveGroups.map((g) => g.activeJobId));
  const liveStandaloneJobs = jobs.filter(
    (j) => !j.groupId && (j.status === "pending" || j.status === "running") && !groupJobIds.has(j.id),
  );
  const liveCount = liveGroups.length + liveStandaloneJobs.length;

  const upNext = groups
    .filter((g) => g.enabled && !g.activeJobId && g.schedule.minutesUntilStart >= 0)
    .sort((a, b) => a.schedule.minutesUntilStart - b.schedule.minutesUntilStart)
    .slice(0, 6);

  const filtered = runs.filter((r) => {
    const q = query.trim().toLowerCase();
    const matchesText =
      !q ||
      r.name.toLowerCase().includes(q) ||
      (r.groupName ?? "").toLowerCase().includes(q) ||
      r.userNames.some((n) => n.toLowerCase().includes(q)) ||
      r.targetUrl.toLowerCase().includes(q);
    return matchesText && (!onDate || r.localDate === onDate);
  });

  const today = daily[0];

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

      <div className="eyebrow">Live now {liveCount > 0 && `(${liveCount})`}</div>
      {liveCount === 0 && <div className="empty-state" style={{ padding: "20px 0" }}>Nothing running right now.</div>}
      {liveCount > 0 && (
        <div className="group-list" style={{ marginBottom: 26 }}>
          {liveGroups.map((g) => (
            <div className="card session-box" key={g.id}>
              <div className="session-head">
                <span className="name">{g.name}</span>
                <StatusBadge status="running" />
              </div>
              <div className="group-meta">
                <span>
                  {g.activeRunIsManual ? "Started by hand" : `Stops ${to12Hour(g.endTime)} ${g.timezone}`}
                  {!g.activeRunIsManual && ` · in ${relative(g.schedule.minutesUntilEnd)}`}
                </span>
              </div>
              <div className="session-controls">
                <button onClick={() => onOpenJob(g.activeJobId!)}>Watch live</button>
                <button className="danger" disabled={rowBusy === g.id} onClick={() => void stopGroupRow(g.id)}>
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
                <button className="danger" disabled={rowBusy === j.id} onClick={() => void stopJobRow(j.id)}>
                  Stop
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {upNext.length > 0 && (
        <>
          <div className="eyebrow">Up next</div>
          <div className="table-scroll" style={{ marginBottom: 26 }}>
            <table className="history-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Starts</th>
                  <th>In</th>
                </tr>
              </thead>
              <tbody>
                {upNext.map((g) => (
                  <tr key={g.id} className="no-hover">
                    <td>{g.name}</td>
                    <td>
                      {to12Hour(g.schedule.effectiveStart)} <span className="dim">{g.timezone}</span>
                    </td>
                    <td>{paused ? "Paused" : relative(g.schedule.minutesUntilStart)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {today && (
        <div className="report-cards">
          <div className="report-card">
            <span className="report-value">{today.runs}</span>
            <span className="report-label">runs on {today.date}</span>
          </div>
          <div className="report-card">
            <span className="report-value">{today.sessions}</span>
            <span className="report-label">user sessions</span>
          </div>
          <div className="report-card ok">
            <span className="report-value">{today.completed}</span>
            <span className="report-label">completed</span>
          </div>
          <div className="report-card bad">
            <span className="report-value">{today.failed}</span>
            <span className="report-label">failed</span>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <div className="search-field">
          <span className="search-icon">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search past runs by name, group, user or link…"
          />
        </div>
        <div className="filter-field">
          <label htmlFor="hist-date">On date</label>
          <input id="hist-date" type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} />
        </div>
        {(query || onDate) && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setOnDate("");
            }}
          >
            Clear
          </button>
        )}
        <span className="filter-count">
          {filtered.length} of {runs.length}
        </span>
      </div>

      {loaded && runs.length === 0 && <div className="empty-state">Nothing has run yet.</div>}
      {loaded && runs.length > 0 && filtered.length === 0 && (
        <div className="empty-state">No run matches that search.</div>
      )}

      {filtered.length > 0 && (
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
              {filtered.map((r) => (
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

      {daily.length > 1 && (
        <>
          <div className="eyebrow" style={{ marginTop: 26 }}>Daily totals</div>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Runs</th>
                  <th>Sessions</th>
                  <th>Completed</th>
                  <th>Failed</th>
                  <th>Stopped</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => (
                  <tr key={d.date} className="no-hover">
                    <td>{d.date}</td>
                    <td>{d.runs}</td>
                    <td>{d.sessions}</td>
                    <td className="ok">{d.completed}</td>
                    <td className={d.failed > 0 ? "bad" : "dim"}>{d.failed}</td>
                    <td className="dim">{d.stopped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
