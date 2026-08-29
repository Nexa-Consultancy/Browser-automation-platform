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
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; deltaY: number };
