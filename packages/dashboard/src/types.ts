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

/** A reusable, named identity with its own real, persistent Microsoft/Teams
 * login. Mirrors packages/shared/src/types.ts. */
export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  signedIn: boolean;
  activeJobId: string | null;
  createdAt: string;
}

/** A reusable step script, picked from a list when creating/editing a group
 * instead of retyping the same Task every time. */
export interface StepTemplate {
  id: string;
  name: string;
  steps: string[];
  createdAt: string;
}

/** A saved link + task + user roster the server runs by itself on a daily
 * wall-clock window. Mirrors packages/shared/src/types.ts. */
export interface Group {
  id: string;
  name: string;
  targetUrl: string;
  steps: string[];
  userNames: string[];
  /** Linked PlatformUsers — each already has their own real login, additive
   * to the free-text userNames roster above. */
  userIds: string[];
  /** The time the thing you're automating actually happens, as typed. */
  startTime: string; // "HH:MM", 24-hour, local to `timezone`
  /** Start this many minutes BEFORE startTime. 0 = exactly on time. */
  leadMinutes: number;
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
  /** startTime minus leadMinutes, "HH:MM" — when it will really begin. */
  effectiveStart: string;
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
  linkedUsers: { id: string; name: string; signedIn: boolean }[];
}

/** One past run, with its outcome rolled up — the row shape behind the
 * History tab and the daily report. */
export interface RunHistoryRow {
  jobId: string;
  name: string;
  targetUrl: string;
  status: JobStatus;
  groupId: string | null;
  groupName: string | null;
  userNames: string[];
  sessionCount: number;
  completed: number;
  failed: number;
  stopped: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Totals for one calendar day, in the server's own zone. */
export interface DailyReport {
  date: string; // "YYYY-MM-DD"
  runs: number;
  sessions: number;
  completed: number;
  failed: number;
  stopped: number;
}
