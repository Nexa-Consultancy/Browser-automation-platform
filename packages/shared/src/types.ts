// Wire-format domain types shared between the API and the worker.
// The dashboard keeps its own copy of the subset it needs (see
// packages/dashboard/src/types.ts) so the frontend build never has to
// resolve backend-only TypeScript through the workspace graph.

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
  steps: string[]; // raw English step lines, template placeholders like {{email}}
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
  rowData: Record<string, string>; // the CSV row (or synthetic defaults) for this user
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

/** Control-plane messages published on `control:{sessionId}` (Redis pub/sub). */
export type ControlMessage =
  | { type: "stop" }
  | { type: "append_steps"; steps: string[] }
  | { type: "input"; action: InputAction };

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

/**
 * A reusable, named identity with its own real, persistent Microsoft/Teams
 * login — as opposed to a Group's free-text userNames, which are just
 * display-name strings with no login of their own. Any number of groups can
 * link the same PlatformUser in; their session always resolves to the same
 * profile directory (see the worker's profilePlanFor), so they always join
 * already signed in as themselves.
 */
export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  /** Whether a Chromium profile has been captured for this user yet. */
  signedIn: boolean;
  /** The login-capture job currently running for this user, if any. */
  activeJobId: string | null;
  createdAt: string;
}

/**
 * A scheduled group: a saved link + task + roster of users that the server
 * launches on its own, every day, between a start and an end wall-clock
 * time in its own timezone. No human needs to be at the dashboard — the
 * API's scheduler starts a real job at `startTime` and stops every session
 * in it at `endTime`.
 */
export interface Group {
  id: string;
  name: string;
  targetUrl: string;
  steps: string[]; // same plain-English step language as a manual job
  userNames: string[]; // one entry per user; length IS the user count
  /** Reusable Users linked into this group's roster (see PlatformUser) —
   * each already has their own real, persistent Teams login, additive to
   * the free-text userNames roster above. */
  userIds: string[];
  /** The time the thing you're automating actually happens, as typed. */
  startTime: string; // "HH:MM", 24-hour, local to `timezone`
  /** Start this many minutes BEFORE startTime, so the browsers are up and
   * logged in before the event begins. 0 = start exactly on time. */
  leadMinutes: number;
  endTime: string; // "HH:MM"; earlier than startTime means it crosses midnight
  /** Weekdays the window opens on: 0 = Sunday … 6 = Saturday. */
  days: number[];
  timezone: string; // IANA zone, defaults to the server's own region
  /** "Follow this schedule automatically" — when false the group only runs
   * when someone presses Join now; the scheduler skips it entirely. */
  enabled: boolean;
  /** The job this group launched and is currently holding open, if any. */
  activeJobId: string | null;
  /** True when that run was started by hand ("Run now") rather than by the
   * clock — the scheduler leaves those alone instead of stopping them. */
  activeRunIsManual: boolean;
  /** Occurrence key ("YYYY-MM-DD@HH:MM") the scheduler last started, so a
   * given day's window fires exactly once however often the tick runs. */
  lastOccurrenceKey: string | null;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  createdAt: string;
}

/** Live scheduling read-out the API computes for the dashboard. */
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
  /** Display info for this group's linked PlatformUsers (resolved from
   * userIds), so the dashboard can show names/status without a second
   * round trip. */
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
