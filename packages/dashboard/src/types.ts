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
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; deltaY: number };
