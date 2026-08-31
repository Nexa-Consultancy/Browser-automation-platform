import { useState } from "react";
import type { InputAction } from "../types";
import type { SessionLive } from "../sessionState";
import { fmtMinSec } from "../sessionState";
import { StatusBadge } from "./StatusBadge";
import { StepTimeline } from "./StepTimeline";
import { Screencast } from "./Screencast";
import * as api from "../api";

// A "failed" session's browser is deliberately kept open (see
// packages/worker/src/runner.ts) so you can fix it — click through the
// screencast or send corrected follow-up steps — until you explicitly Stop.
const TERMINAL = new Set(["completed", "stopped"]);
export const LIVE_INTERACTIVE = new Set(["interactive", "failed"]);

// Every status where the browser is still open and can therefore be driven
// by hand. Wider than LIVE_INTERACTIVE on purpose: the moment you most need
// the mouse is a run that is still "running" but stuck on something the
// script can't get past, and that used to be exactly when input was refused.
export const BROWSER_OPEN = new Set(["running", "waiting_video", "interactive", "failed"]);

export function UserSessionBox({
  live,
  onInput,
  onExpand,
}: {
  live: SessionLive;
  onInput: (action: InputAction) => void;
  onExpand: () => void;
}) {
  const { session, steps, frame, log, video, failedIndices } = live;
  const [followup, setFollowup] = useState("");
  // Collapsed by default: the point of this box is the live picture. The
  // step list and event log are for when something looks wrong, not for
  // every glance at a wall of running sessions.
  const [showDetail, setShowDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = session.status === "completed";
  const stopped = TERMINAL.has(session.status);

  async function sendFollowup() {
    if (!followup.trim()) return;
    setBusy(true);
    try {
      await api.appendStepsToSession(session.id, followup);
      setFollowup("");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await api.stopSession(session.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card session-box">
      <div className="session-head">
        <span className="name">{session.userName}</span>
        <StatusBadge status={session.status} />
      </div>

      <Screencast
        frame={frame}
        interactive={LIVE_INTERACTIVE.has(session.status)}
        onInput={onInput}
        onExpand={onExpand}
      />

      {session.currentStepText && (
        <div className="session-step-line">
          <span className="arrow">→</span>
          <span>{session.currentStepText}</span>
        </div>
      )}

      {video && session.status === "waiting_video" && (
        <div className="video-timer">
          <span>▶ video playing — {fmtMinSec(video.elapsedMs)} elapsed</span>
          {video.duration > 0 && <span>/ {fmtMinSec(video.duration * 1000)} total</span>}
        </div>
      )}

      <button
        type="button"
        className="detail-toggle"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
      >
        <span className="chev">{showDetail ? "▲" : "▼"}</span>
        {showDetail ? "Hide steps & log" : `Steps & log · ${session.currentStepIndex + 1}/${session.totalSteps}`}
      </button>

      {showDetail && (
        <>
          <StepTimeline
            steps={steps}
            currentIndex={session.currentStepIndex}
            failedIndices={failedIndices}
            done={done}
          />

          <div className="event-log">
            {log.length === 0 && <div className="entry">waiting to start…</div>}
            {log.map((entry, i) => (
              <div className={`entry ${entry.err ? "err" : ""}`} key={i}>
                [{entry.ts}] {entry.text}
              </div>
            ))}
          </div>
        </>
      )}

      {session.error && <div className="error-banner">{session.error}</div>}

      <div className="session-controls">
        <button
          className="danger"
          disabled={busy || stopped}
          onClick={stop}
          title={`Close only ${session.userName}'s browser — the other users keep running`}
        >
          Stop {session.userName}
        </button>
      </div>

      {!stopped && (
        <div className="session-followup">
          <input
            type="text"
            placeholder={
              session.status === "failed"
                ? "Fix it — send a corrected step, it'll run next…"
                : "Send this user more steps (English, one per line)…"
            }
            value={followup}
            onChange={(e) => setFollowup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendFollowup();
            }}
          />
          <button disabled={busy} onClick={sendFollowup}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}
