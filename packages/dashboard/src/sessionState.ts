import type { SessionEvent, SessionRow } from "./types";

export interface LogEntry {
  ts: string;
  text: string;
  err?: boolean;
}

export interface VideoState {
  elapsedMs: number;
  currentTime: number;
  duration: number;
}

export interface SessionLive {
  session: SessionRow;
  steps: string[]; // job.steps plus any follow-up steps observed live
  frame: string | null;
  log: LogEntry[];
  video: VideoState | null;
  failedIndices: number[]; // step indices that failed, so the timeline keeps marking them even after the run moves past them
}

export function initSessionLive(session: SessionRow, baseSteps: string[]): SessionLive {
  return { session, steps: [...baseSteps], frame: null, log: [], video: null, failedIndices: [] };
}

/**
 * Folds a freshly-fetched session row back into live state.
 *
 * The live view is driven entirely by the WebSocket event stream, which is
 * the right thing while the socket is up and useless the moment it isn't: a
 * dropped connection (a laptop lid, a proxy hiccup, a redeploy) silently
 * loses every event sent while it was down, and the grid then shows the
 * statuses and step positions from whenever it broke — indefinitely, and
 * with no sign anything is wrong. Periodically re-reading the row and
 * merging it here is what makes the view self-correct.
 *
 * Only the server-owned fields are taken. The frame, the log and the video
 * timer exist nowhere but this browser tab, and overwriting them with a
 * fetch would blank the picture every time the poll came round.
 */
export function reconcileSession(state: SessionLive, session: SessionRow): SessionLive {
  const unchanged =
    state.session.status === session.status &&
    state.session.currentStepIndex === session.currentStepIndex &&
    state.session.totalSteps === session.totalSteps &&
    state.session.error === session.error;
  if (unchanged) return state;
  return {
    ...state,
    session: { ...state.session, ...session },
    // A status the events never delivered is worth saying out loud — it is
    // the one visible trace that the stream had a gap.
    log:
      state.session.status === session.status
        ? state.log
        : withLog(state, `● ${session.status.replace("_", " ")} (resynced)`),
  };
}

function withLog(state: SessionLive, text: string, err = false): LogEntry[] {
  const entry: LogEntry = { ts: new Date().toLocaleTimeString(), text, err };
  return [...state.log, entry].slice(-200);
}

function fmtMinSec(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function applySessionEvent(state: SessionLive, event: SessionEvent): SessionLive {
  const p = event.payload as any;
  switch (event.type) {
    case "status_change": {
      const status = p.status as SessionRow["status"];
      return {
        ...state,
        session: { ...state.session, status, error: status === "running" ? null : state.session.error },
        log: withLog(state, `● ${status.replace("_", " ")}`),
        video: status === "waiting_video" ? state.video : status === "running" ? null : state.video,
      };
    }
    case "step_start": {
      const idx = p.index as number;
      const text = p.text as string;
      const steps = [...state.steps];
      while (steps.length <= idx) steps.push("…");
      steps[idx] = text;
      return {
        ...state,
        steps,
        session: { ...state.session, currentStepIndex: idx, currentStepText: text },
        log: withLog(state, `→ Step ${idx + 1}: ${text}`),
      };
    }
    case "step_done":
      return { ...state, log: withLog(state, `✓ Step ${(p.index as number) + 1} done`) };
    case "step_failed": {
      const idx = p.index as number;
      return {
        ...state,
        session: { ...state.session, error: String(p.error) },
        failedIndices: state.failedIndices.includes(idx) ? state.failedIndices : [...state.failedIndices, idx],
        log: withLog(state, `✗ Step ${idx + 1} failed: ${p.error}`, true),
      };
    }
    case "video_wait_tick": {
      const video: VideoState = {
        elapsedMs: p.elapsedMs,
        currentTime: p.currentTime,
        duration: p.duration,
      };
      // Log sparingly (once a minute) so the feed doesn't spam every 5s tick.
      const shouldLog = Math.floor(video.elapsedMs / 60000) !== Math.floor((state.video?.elapsedMs ?? 0) / 60000);
      return {
        ...state,
        video,
        log: shouldLog ? withLog(state, `⏱ video playing… ${fmtMinSec(video.elapsedMs)} elapsed`) : state.log,
      };
    }
    case "log":
      return { ...state, log: withLog(state, String(p.message)) };
    default:
      return state;
  }
}

export { fmtMinSec };
