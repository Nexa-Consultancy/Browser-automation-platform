/**
 * The decisions that make a quiz run safe to repeat.
 *
 * Everything here is a pure function over plain data, deliberately: these
 * are the rules that decide whether a real person's quiz gets taken a
 * second time, and the only way to be sure about them is to be able to test
 * them without a browser, a portal or a database. The worker calls them; it
 * does not re-implement them.
 */

import type { PortalQuizStatus, QuizRunStatus, QuizStatus } from "./assessmentTypes.js";
import { TERMINAL_QUIZ_RUN_STATUSES } from "./assessmentTypes.js";
import type { QuizCompletionRules } from "./portalConfig.js";

/** What we know about one quiz as it appears on the portal right now. */
export interface DiscoveredQuiz {
  externalQuizId: string;
  quizName: string;
  portalStatus: PortalQuizStatus;
}

/** What our database already holds for that quiz. */
export interface StoredQuiz {
  externalQuizId: string;
  internalStatus: QuizStatus;
  portalStatus: PortalQuizStatus;
}

/**
 * Reads a quiz card's status text into a portal status.
 *
 * `pendingText` is checked BEFORE `completedText` on purpose: a portal that
 * writes "Not completed" contains the word "completed", and matching that
 * as done would skip a quiz nobody has taken — the single worst thing this
 * module could get wrong.
 */
export function readPortalStatus(
  statusText: string | null,
  rules: QuizCompletionRules | undefined,
  hasCompletedMarker = false,
): PortalQuizStatus {
  if (hasCompletedMarker) return "completed";
  const text = (statusText ?? "").trim().toLowerCase();
  if (!text) return "unknown";

  const pending = (rules?.pendingText ?? []).map((s) => s.toLowerCase());
  for (const p of pending) {
    if (p && text.includes(p)) return "not_started";
  }

  const done = (rules?.completedText ?? []).map((s) => s.toLowerCase());
  for (const d of done) {
    if (d && text.includes(d)) return "completed";
  }

  // No rule matched. Do NOT guess from the words themselves — an unmatched
  // status is exactly the case where the config is incomplete, and guessing
  // is how a quiz gets silently skipped.
  return "unknown";
}

/**
 * Reconciles what the portal says with what we stored.
 *
 * The rule, in one line: the portal wins on completion, our database wins
 * on nothing. If the portal says submitted and we have no record, we update
 * our record — we do not take the quiz again to "confirm". If the portal
 * says nothing at all, our own record is the only evidence there is, so it
 * stands.
 */
export function reconcileQuizStatus(discovered: DiscoveredQuiz, stored: StoredQuiz | null): {
  internalStatus: QuizStatus;
  portalStatus: PortalQuizStatus;
  /** True when the portal told us something our record didn't have, so the
   * caller knows a write is worth doing and can log why. */
  changed: boolean;
} {
  const portalStatus = discovered.portalStatus;

  if (portalStatus === "completed") {
    const changed = stored?.internalStatus !== "completed";
    return { internalStatus: "completed", portalStatus, changed };
  }

  if (!stored) {
    return { internalStatus: portalStatus === "in_progress" ? "in_progress" : "pending", portalStatus, changed: true };
  }

  // The portal actively says this is not done. That outranks a stale
  // "completed" of ours — a reset or a reassigned quiz is a real thing, and
  // trusting our own cache over the portal's explicit answer would leave it
  // never taken again.
  if (portalStatus === "not_started" || portalStatus === "in_progress") {
    const next: QuizStatus = portalStatus === "in_progress" ? "in_progress" : "pending";
    return { internalStatus: next, portalStatus, changed: stored.internalStatus !== next };
  }

  // portalStatus === "unknown": keep what we had, but never leave a quiz
  // parked on "discovered" — it is pending until something says otherwise.
  const internalStatus = stored.internalStatus === "discovered" ? "pending" : stored.internalStatus;
  return { internalStatus, portalStatus, changed: internalStatus !== stored.internalStatus };
}

/** A quiz in one of these needs no further work this run. */
const DONE_WITH: QuizStatus[] = ["completed", "skipped"];

export function isQuizFinished(status: QuizStatus): boolean {
  return DONE_WITH.includes(status);
}

/**
 * The next quiz to take, or null when there is nothing left.
 *
 * Order is the portal's own — the list as displayed — because that is the
 * order a person would take them in and the order the portal's own
 * prerequisites (if any) assume. `attempted` carries the ids this run has
 * already opened, so a quiz that failed does not get picked again in an
 * endless loop within one run.
 */
export function selectNextQuiz(
  quizzes: { externalQuizId: string; internalStatus: QuizStatus }[],
  attempted: ReadonlySet<string> = new Set(),
): { externalQuizId: string; internalStatus: QuizStatus } | null {
  for (const q of quizzes) {
    if (isQuizFinished(q.internalStatus)) continue;
    if (attempted.has(q.externalQuizId)) continue;
    return q;
  }
  return null;
}

// ---------- run status transitions ----------

/**
 * Which status a quiz run may move to from which.
 *
 * Written out rather than left implicit because a run is written to from
 * two places over its life (the engine as it goes, and the recovery path
 * after a crash), and the failure that matters — a finished run being
 * dragged back to "running" by a late write, then re-submitted — is exactly
 * the one an explicit table prevents.
 */
const ALLOWED_TRANSITIONS: Record<QuizRunStatus, QuizRunStatus[]> = {
  queued: ["running", "skipped", "already_completed", "failed", "stopped"],
  running: ["submitting", "completed", "failed", "stopped", "already_completed"],
  // Submit has been clicked. It may or may not have landed, so both the
  // "it did" and "it did not" exits are legal from here — but "back to
  // running" is not, because re-entering the question loop after a possible
  // submission is how a quiz gets answered twice.
  submitting: ["verifying", "completed", "failed", "stopped", "already_completed"],
  verifying: ["completed", "failed", "stopped", "already_completed"],
  completed: [],
  failed: [],
  stopped: [],
  skipped: [],
  already_completed: [],
};

export function isTerminalQuizRun(status: QuizRunStatus): boolean {
  return TERMINAL_QUIZ_RUN_STATUSES.includes(status);
}

export function canTransitionQuizRun(from: QuizRunStatus, to: QuizRunStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------- idempotency ----------

/** Everything the engine knows before it decides whether to open a quiz. */
export interface StartDecisionInput {
  /** What the portal says about this quiz right now. */
  portalStatus: PortalQuizStatus;
  /** Our stored status for it. */
  internalStatus: QuizStatus;
}

export type StartDecision =
  | { action: "take" }
  | { action: "skip"; reason: string; status: Extract<QuizRunStatus, "already_completed" | "skipped"> };

/**
 * Whether to actually take this quiz.
 *
 * This is the guard that makes a crashed worker safe. The dangerous
 * sequence is: submit succeeds -> the process dies before the write -> the
 * job is retried -> the quiz is taken and submitted a second time. The
 * defence is not to remember harder, it is to ask the portal again: if it
 * now says submitted, the answer is "already done", regardless of what our
 * record was left saying.
 */
export function decideQuizStart(input: StartDecisionInput): StartDecision {
  if (input.portalStatus === "completed") {
    return {
      action: "skip",
      reason: "the portal reports this quiz as already submitted",
      status: "already_completed",
    };
  }

  // Our own record says completed and the portal is not contradicting it.
  // Only trust that when the portal genuinely had nothing to say — if the
  // portal said not_started, reconcileQuizStatus has already corrected us.
  if (input.internalStatus === "completed" && input.portalStatus === "unknown") {
    return {
      action: "skip",
      reason: "already completed in a previous run, and the portal does not publish a status to check against",
      status: "already_completed",
    };
  }

  if (input.internalStatus === "skipped") {
    return { action: "skip", reason: "marked skipped", status: "skipped" };
  }

  return { action: "take" };
}

/**
 * Whether a submission may be retried.
 *
 * Submission is the one action in the whole system that must not be retried
 * blindly: retrying a click that already worked is how one attempt becomes
 * two. So a retry is allowed only when the portal is unambiguous that
 * nothing landed — an ambiguous state is treated as "it may have gone
 * through", which fails the run and leaves a person to look, rather than
 * risking a duplicate submission.
 */
export function canRetrySubmit(input: {
  /** Did the result/completion state appear after the attempt? */
  resultDetected: boolean;
  /** Could we read the portal's state at all, or did the check itself fail? */
  stateKnown: boolean;
  attempts: number;
  maxAttempts: number;
}): { retry: boolean; reason: string } {
  if (input.resultDetected) {
    return { retry: false, reason: "the quiz is already submitted — the result state is showing" };
  }
  if (!input.stateKnown) {
    return {
      retry: false,
      reason: "could not confirm whether the submission landed; not retrying, because a duplicate submission is worse than a failed run",
    };
  }
  if (input.attempts >= input.maxAttempts) {
    return { retry: false, reason: `submission failed ${input.attempts} time(s)` };
  }
  return { retry: true, reason: "the quiz is confirmed not submitted" };
}

/**
 * Rolls a person's quiz records up into their profile counters.
 *
 * Recomputed from the quiz rows rather than incremented as things happen:
 * counters that are added to drift the first time anything is written twice
 * or not at all, and this is cheap.
 */
export function summarizeQuizzes(quizzes: { internalStatus: QuizStatus; score: number | null }[]): {
  totalQuizzes: number;
  completedQuizzes: number;
  pendingQuizzes: number;
  failedQuizzes: number;
  averageScore: number | null;
} {
  let completed = 0;
  let pending = 0;
  let failed = 0;
  let scoreSum = 0;
  let scored = 0;

  for (const q of quizzes) {
    if (q.internalStatus === "completed") completed++;
    else if (q.internalStatus === "failed") failed++;
    else if (q.internalStatus !== "skipped") pending++;
    if (q.internalStatus === "completed" && typeof q.score === "number") {
      scoreSum += q.score;
      scored++;
    }
  }

  return {
    totalQuizzes: quizzes.length,
    completedQuizzes: completed,
    pendingQuizzes: pending,
    failedQuizzes: failed,
    averageScore: scored > 0 ? Math.round((scoreSum / scored) * 10) / 10 : null,
  };
}

/**
 * Pulls a percentage out of whatever the portal calls a score.
 *
 * Handles the three shapes portals actually use — "85%", "17/20",
 * "Score: 85" — and returns null rather than a wrong number for anything
 * else, because a made-up score in a results table is worse than a blank.
 */
export function parseScore(raw: string | null | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) {
    const n = Number(percent[1]);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }

  const fraction = text.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)/i);
  if (fraction) {
    const got = Number(fraction[1]);
    const total = Number(fraction[2]);
    if (Number.isFinite(got) && Number.isFinite(total) && total > 0) {
      return Math.round((got / total) * 1000) / 10;
    }
    return null;
  }

  const bare = text.match(/(?:score|marks|result)\D{0,4}(\d+(?:\.\d+)?)/i);
  if (bare) {
    const n = Number(bare[1]);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }

  return null;
}
