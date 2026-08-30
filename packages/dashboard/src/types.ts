// Mirrors packages/shared/src/types.ts on the wire (JSON over REST + WS).
// Kept as a local copy rather than importing the backend package so the
// Vite build never has to resolve a Node-oriented workspace package.

export type JobStatus = "pending" | "running" | "completed" | "stopped" | "failed";

export type SessionStatus =
  | "pending"
  | "running"
  | "waiting_video"
  | "interactive"
  | "completed"
  | "failed"
  | "stopped";

export interface Job {
  id: string;
  name: string;
  targetUrl: string;
  steps: string[];
  concurrency: number;
  status: JobStatus;
  groupId: string | null; // set when a scheduled group launched this run
  createdAt: string;
}

export interface SessionRow {
  id: string;
  jobId: string;
  userIndex: number;
  userName: string;
  rowData: Record<string, string>;
  status: SessionStatus;
  currentStepIndex: number;
  currentStepText: string | null;
  totalSteps: number;
  error: string | null;
  videoWaitStartedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export type SessionEventType =
  | "step_start"
  | "step_done"
  | "step_failed"
  | "video_wait_tick"
  | "log"
  | "status_change"
  | "screencast_frame";

export interface SessionEvent {
  id: string;
  sessionId: string;
  jobId: string;
  type: SessionEventType;
  payload: Record<string, unknown>;
  ts: string;
}

export type InputAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "dblclick"; x: number; y: number }
  | { kind: "rightclick"; x: number; y: number }
  /** Hover only — lets menus and tooltips that open on mouseover behave the
   * same way they would for someone actually sitting at the browser. */
  | { kind: "move"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; deltaY: number };

/** A saved link + task + user roster the server runs by itself on a daily
 * wall-clock window. Mirrors packages/shared/src/types.ts. */
export interface Group {
  id: string;
  name: string;
  targetUrl: string;
  steps: string[];
  userNames: string[];
  startTime: string; // "HH:MM", 24-hour, local to `timezone`
  endTime: string; // earlier than startTime means the window crosses midnight
  /** Weekdays the window opens on: 0 = Sunday … 6 = Saturday. */
  days: number[];
  timezone: string;
  /** "Follow this schedule automatically" — when false the group only runs
   * when someone presses Join now; the scheduler skips it entirely. */
  enabled: boolean;
  activeJobId: string | null;
  /** True when that run was started by hand ("Run now") rather than by the
   * clock — the scheduler leaves those alone instead of stopping them. */
  activeRunIsManual: boolean;
  lastOccurrenceKey: string | null;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  createdAt: string;
}

export interface GroupSchedule {
  inWindow: boolean;
  /** The occurrence in progress right now ("YYYY-MM-DD@HH:MM"), or null
   * when outside the window. Compare with the group's lastOccurrenceKey to
   * tell "about to start" apart from "already ran and was stopped". */
  occurrenceKey: string | null;

  minutesUntilStart: number;
  minutesUntilEnd: number;
  localTime: string; // "HH:MM" right now in the group's zone
}

export interface GroupWithSchedule extends Group {
  schedule: GroupSchedule;
}
