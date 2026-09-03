import { useEffect, useMemo, useState } from "react";
import type { Job, SessionRow, InputAction } from "../types";
import { applySessionEvent, initSessionLive, reconcileSession, type SessionLive } from "../sessionState";
import { useJobSocket } from "../useJobSocket";
import * as api from "../api";
import { StatusBadge } from "./StatusBadge";
import { UserSessionBox, LIVE_INTERACTIVE, BROWSER_OPEN } from "./UserSessionBox";
import { ScreencastModal } from "./ScreencastModal";

export function JobView({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [live, setLive] = useState<Record<string, SessionLive>>({});
  const [error, setError] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /**
   * Loads the run, then keeps re-reading it on a slow timer.
   *
   * The picture and the step-by-step come over the WebSocket, and that is
   * the only thing that can be live. But events sent while the socket was
   * down are gone for good — so without this, a connection that blipped
   * left the grid showing whatever was true at the moment it dropped, with
   * nothing to say so. The poll is what makes a stale view heal itself; it
   * is deliberately slow, because it is a safety net and not the mechanism.
   */
  useEffect(() => {
    let cancelled = false;

    async function load(first: boolean) {
      try {
        const { job, sessions } = await api.getJob(jobId);
        if (cancelled) return;
        setJob(job);
        setLive((prev) => {
          const next: Record<string, SessionLive> = {};
          for (const s of sessions) {
            const current = prev[s.id];
            next[s.id] = current ? reconcileSession(current, s) : initSessionLive(s, job.steps);
          }
          return next;
        });
        setError(null);
      } catch (e) {
        // Only surface a load failure on the first attempt: a poll that
        // fails while the grid is already on screen should not replace a
        // working live view with an error page.
        if (!cancelled && first) setError(e instanceof Error ? e.message : String(e));
      }
    }

    void load(true);
    const timer = setInterval(() => void load(false), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
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
    if (!confirm(`Stop all ${sessions.length} user(s) and close every browser in this run?`)) return;
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

  const expanded = expandedId ? live[expandedId] : null;

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
          <button
            className="danger"
            disabled={busy}
            onClick={stopAll}
            title="Close every user's browser in this run"
          >
            Stop all users ({sessions.length})
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
            <UserSessionBox
              key={s.session.id}
              live={s}
              onInput={(action) => handleInput(s.session.id, action)}
              onExpand={() => setExpandedId(s.session.id)}
            />
          ))}
        </div>
      )}

      {expanded && (
        <ScreencastModal
          userName={expanded.session.userName}
          frame={expanded.frame}
          parked={LIVE_INTERACTIVE.has(expanded.session.status)}
          live={BROWSER_OPEN.has(expanded.session.status)}
          onInput={(action) => handleInput(expanded.session.id, action)}
          onClose={() => setExpandedId(null)}
        />
      )}
    </div>
  );
}
