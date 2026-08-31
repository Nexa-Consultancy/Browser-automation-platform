import { useCallback, useEffect, useState } from "react";
import type { DailyReport, RunHistoryRow } from "../types";
import * as api from "../api";
import { StatusBadge } from "./StatusBadge";

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
 * History and daily reports — every run the platform has done, scheduled or
 * manual, with what became of each user in it. Also the place to answer
 * "did last night's group actually run?" without hunting through live views.
 */
export function HistoryView({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [runs, setRuns] = useState<(RunHistoryRow & { localDate: string })[]>([]);
  const [daily, setDaily] = useState<DailyReport[]>([]);
  const [timezone, setTimezone] = useState("");
  const [query, setQuery] = useState("");
  const [onDate, setOnDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getHistory();
      setRuns(res.runs);
      setDaily(res.daily);
      setTimezone(res.serverTimezone);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

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
          <h2>History &amp; reports</h2>
          {timezone && <span className="hint">all times {timezone}</span>}
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

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
