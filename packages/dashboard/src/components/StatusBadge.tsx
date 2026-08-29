import type { SessionStatus, JobStatus } from "../types";

const LABELS: Record<string, string> = {
  pending: "pending",
  running: "running",
  waiting_video: "video playing",
  interactive: "waiting for you",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
};

export function StatusBadge({ status }: { status: SessionStatus | JobStatus }) {
  return (
    <span className={`badge status-${status}`}>
      <span className="dot" />
      {LABELS[status] ?? status}
    </span>
  );
}
