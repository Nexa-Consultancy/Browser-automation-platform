import { useEffect, useMemo, useState } from "react";
import type { Job, SessionRow, InputAction } from "../types";
import { applySessionEvent, initSessionLive, type SessionLive } from "../sessionState";
import { useJobSocket } from "../useJobSocket";
import * as api from "../api";
import { StatusBadge } from "./StatusBadge";
import { UserSessionBox } from "./UserSessionBox";

export function JobView({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [live, setLive] = useState<Record<string, SessionLive>>({});
  const [error, setError] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getJob(jobId)
      .then(({ job, sessions }) => {
        if (cancelled) return;
        setJob(job);
        const map: Record<string, SessionLive> = {};
        for (const s of sessions) map[s.id] = initSessionLive(s, job.steps);
        setLive(map);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const { sendInput } = useJobSocket(
    jobId,
    (event) => {
      setLive((prev) => {
        const current = prev[event.sessionId];
        if (!current) return prev;
        return { ...prev, [event.sessionId]: applySessionEvent(current, event) };
      });
    },
    (sessionId, frame) => {
      setLive((prev) => {
        const current = prev[sessionId];
        if (!current) return prev;
        return { ...prev, [sessionId]: { ...current, frame } };
      });
    },
  );

  const sessions = useMemo(() => Object.values(live).sort((a, b) => a.session.userIndex - b.session.userIndex), [live]);

  async function stopAll() {
    if (!job) return;
    if (!confirm("Stop all sessions and close every browser for this job?")) return;
    setBusy(true);
    try {
      await api.stopAll(job.id);
    } finally {
      setBusy(false);
    }
  }

  async function sendBroadcast() {
    if (!job || !broadcast.trim()) return;
    setBusy(true);
    try {
      await api.appendStepsToJob(job.id, broadcast);
      setBroadcast("");
    } finally {
      setBusy(false);
    }
  }

  function handleInput(sessionId: string, action: InputAction) {
    sendInput(sessionId, action);
  }

  if (error) return <div className="container error-banner">{error}</div>;
  if (!job) return <div className="container empty-state">Loading…</div>;

  return (
    <div className="container">
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <button onClick={onBack}>← Jobs</button>
          <h2>{job.name}</h2>
          <StatusBadge status={job.status} />
          <span className="hint">{job.targetUrl}</span>
        </div>
        <div className="job-toolbar-actions">
          <button className="danger" disabled={busy} onClick={stopAll}>
            Stop all
          </button>
        </div>
      </div>

      <div className="broadcast-box">
        <textarea
          placeholder="Send follow-up steps to every user (English, one per line)…"
          value={broadcast}
          onChange={(e) => setBroadcast(e.target.value)}
        />
        <button className="primary" disabled={busy} onClick={sendBroadcast}>
          Send to all
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty-state">No sessions yet.</div>
      ) : (
        <div className="session-grid">
          {sessions.map((s) => (
            <UserSessionBox key={s.session.id} live={s} onInput={(action) => handleInput(s.session.id, action)} />
          ))}
        </div>
      )}
    </div>
  );
}
