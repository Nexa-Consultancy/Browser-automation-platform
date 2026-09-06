import type { QuizRunStatus, QuizStatus } from "../types";

/**
 * A quiz status, in the platform's existing badge language.
 *
 * Reuses the same `.badge status-*` classes the session/job badge uses, so
 * a quiz status looks like every other status in the app rather than
 * introducing a second visual vocabulary for the same idea. The mapping is
 * by MEANING — "already_completed" is a completion, "queued" is a pending —
 * which is what keeps the colours honest without new CSS.
 */
const RUN_LABELS: Record<QuizRunStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  skipped: "skipped",
  // Said in full because the distinction is the whole idempotency story: we
  // arrived, the portal already had it submitted, and we did not retake it.
  already_completed: "already done",
};

const RUN_TONE: Record<QuizRunStatus, string> = {
  queued: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  skipped: "stopped",
  already_completed: "completed",
};

export function QuizRunBadge({ status }: { status: QuizRunStatus }) {
  return (
    <span className={`badge status-${RUN_TONE[status] ?? "pending"}`}>
      <span className="dot" />
      {RUN_LABELS[status] ?? status}
    </span>
  );
}

const QUIZ_LABELS: Record<QuizStatus, string> = {
  discovered: "found",
  pending: "pending",
  in_progress: "in progress",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
};

const QUIZ_TONE: Record<QuizStatus, string> = {
  discovered: "pending",
  pending: "pending",
  in_progress: "running",
  completed: "completed",
  failed: "failed",
  skipped: "stopped",
};

export function QuizStatusBadge({ status }: { status: QuizStatus }) {
  return (
    <span className={`badge status-${QUIZ_TONE[status] ?? "pending"}`}>
      <span className="dot" />
      {QUIZ_LABELS[status] ?? status}
    </span>
  );
}
