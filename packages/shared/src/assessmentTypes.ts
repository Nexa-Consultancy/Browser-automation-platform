// Wire-format types for the Assignments module. Same convention as
// types.ts: the API and worker import these; the dashboard keeps its own
// mirrored copy so the frontend build never resolves a backend package.

import type { QuestionType } from "./portalConfig.js";

/**
 * What a group is for.
 *
 * A group is still one thing — one roster, one schedule, one window, one
 * scheduler. This only says which runner the job it launches uses, so that
 * assessment groups get the existing days/lead/timezone/Join-now behaviour
 * without a second scheduling system existing anywhere.
 */
export type GroupType = "standard" | "assessment";

export function isGroupType(v: unknown): v is GroupType {
  return v === "standard" || v === "assessment";
}

/** Which runner a queued job routes to inside the worker. Existing rows
 * have no value and read as "automation", which is what they are. */
export type JobKind = "automation" | "assessment";

export function isJobKind(v: unknown): v is JobKind {
  return v === "automation" || v === "assessment";
}

/**
 * Where one quiz stands, in OUR record.
 *
 * Deliberately separate from `portalStatus` on the same row: the portal is
 * the authority on whether a quiz is submitted, and our column is a durable
 * cache of what it last said plus what we did about it. Keeping them apart
 * is what lets the engine notice "the portal says submitted, we have no
 * record" and fix our side instead of retaking the quiz.
 */
export type QuizStatus =
  | "discovered"
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

export const QUIZ_STATUSES: QuizStatus[] = [
  "discovered",
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
];

/** What the portal itself last told us about a quiz. "unknown" is honest
 * and common: plenty of portals show no status until you open the quiz. */
export type PortalQuizStatus = "unknown" | "not_started" | "in_progress" | "completed";

export const PORTAL_QUIZ_STATUSES: PortalQuizStatus[] = ["unknown", "not_started", "in_progress", "completed"];

/**
 * One attempt at one quiz by one person.
 *
 * `already_completed` is not a variety of "completed" — it means the engine
 * arrived, found the portal had it submitted, and did NOT take it. That
 * distinction is the whole basis of the idempotency story, so it gets its
 * own status rather than a boolean nobody reads.
 */
export type QuizRunStatus =
  | "queued"
  | "running"
  /** The Submit click has been issued and we do not yet know whether it
   * landed. This is the one state a crash is genuinely dangerous in, so it
   * gets its own name: a run found here after a restart tells the next run
   * exactly where to look, instead of leaving it to infer from "running". */
  | "submitting"
  /** Submitted, waiting for the portal to show the result. */
  | "verifying"
  | "completed"
  | "failed"
  | "stopped"
  | "skipped"
  | "already_completed";

export const QUIZ_RUN_STATUSES: QuizRunStatus[] = [
  "queued",
  "running",
  "submitting",
  "verifying",
  "completed",
  "failed",
  "stopped",
  "skipped",
  "already_completed",
];

/** A run in one of these is finished and will not change again. */
export const TERMINAL_QUIZ_RUN_STATUSES: QuizRunStatus[] = [
  "completed",
  "failed",
  "stopped",
  "skipped",
  "already_completed",
];

export function isQuizRunStatus(v: unknown): v is QuizRunStatus {
  return typeof v === "string" && (QUIZ_RUN_STATUSES as string[]).includes(v);
}

/**
 * The rolled-up assessment state of one person, carried between runs.
 *
 * Distinct from their BROWSER profile, which is cookies and a login. This
 * is what they have and haven't done — the thing the next run reads to
 * answer "what is left?" without asking the portal about quizzes it already
 * knows are finished.
 */
export interface AssessmentProfile {
  personId: string;
  organizationId: string | null;
  lastAssessmentRun: string | null;
  lastSuccessfulRun: string | null;
  totalQuizzes: number;
  completedQuizzes: number;
  pendingQuizzes: number;
  failedQuizzes: number;
  lastUpdated: string;
}

export interface AssessmentQuiz {
  id: string;
  organizationId: string | null;
  personId: string;
  /** The portal's own id for this quiz where it exposes one, else its name.
   * This is the key a later run matches on, which is why the portal config
   * has a `quizIdAttribute` worth filling in. */
  externalQuizId: string;
  quizName: string;
  portalStatus: PortalQuizStatus;
  internalStatus: QuizStatus;
  score: number | null;
  scoreText: string | null;
  discoveredAt: string;
  completedAt: string | null;
  lastCheckedAt: string;
}

export interface QuizRun {
  id: string;
  organizationId: string | null;
  groupId: string | null;
  personId: string;
  personName: string;
  quizId: string | null;
  quizName: string;
  /** The platform run and session this belongs to, so a quiz result links
   * straight back to the live view, the events and the screencast. */
  jobId: string | null;
  sessionId: string | null;
  status: QuizRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  questionsTotal: number;
  questionsAnswered: number;
  score: number | null;
  scoreText: string | null;
  error: string | null;
  createdAt: string;
}

/** One question, as answered. The primary record — a screenshot is not a
 * log, it is an artefact, and this is what is actually searchable. */
export interface QuizQuestionResult {
  id: string;
  quizRunId: string;
  questionNumber: number;
  questionText: string;
  questionType: QuestionType;
  options: { id: string; text: string }[];
  selectedOption: string | null;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  latencyMs: number | null;
  /** True when the primary model's answer was not confident enough and the
   * fallback's answer is the one used. */
  fallbackUsed: boolean;
  reason: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type AssessmentArtifactKind = "completion" | "failure" | "result";

export interface AssessmentArtifact {
  id: string;
  quizRunId: string;
  kind: AssessmentArtifactKind;
  contentType: string;
  byteSize: number;
  caption: string;
  createdAt: string;
}

/** The Overview numbers. Computed in one query rather than by loading the
 * rows, same reasoning as listRunHistory's aggregates. */
export interface AssessmentOverview {
  organizations: number;
  groups: number;
  assessmentGroups: number;
  people: number;
  quizzesCompleted: number;
  quizzesPending: number;
  quizzesRunning: number;
  failedRuns: number;
  averageScore: number | null;
}

/** One person's row in the Users / Results lists. */
export interface AssessmentPerson {
  personId: string;
  personName: string;
  email: string;
  organizationId: string | null;
  totalQuizzes: number;
  completedQuizzes: number;
  pendingQuizzes: number;
  failedQuizzes: number;
  averageScore: number | null;
  lastAssessmentRun: string | null;
  lastSuccessfulRun: string | null;
}

// ---------- structured events ----------

/**
 * Assessment-specific event types, recorded through the SAME session_events
 * table and the same Redis relay as every other event — which is what makes
 * the existing live view show a quiz's progress without knowing anything
 * about quizzes.
 */
export type AssessmentEventType =
  | "assessment_started"
  | "quiz_discovered"
  | "quiz_skipped_completed"
  | "quiz_started"
  | "question_extracted"
  | "ai_request"
  | "ai_response"
  | "answer_selected"
  | "question_completed"
  | "quiz_submitted"
  | "quiz_result_received"
  | "quiz_completed"
  | "assessment_completed"
  | "assessment_failed";

export const ASSESSMENT_EVENT_TYPES: AssessmentEventType[] = [
  "assessment_started",
  "quiz_discovered",
  "quiz_skipped_completed",
  "quiz_started",
  "question_extracted",
  "ai_request",
  "ai_response",
  "answer_selected",
  "question_completed",
  "quiz_submitted",
  "quiz_result_received",
  "quiz_completed",
  "assessment_completed",
  "assessment_failed",
];

/**
 * What the dashboard shows as "what is this session doing right now".
 *
 * Derived from the event stream rather than polled or stored: the events
 * are already durable and already relayed live, so a phase is a projection
 * of them, not a second source of truth that can disagree.
 */
export type AssessmentPhase =
  | "queued"
  | "running"
  | "reading_question"
  | "waiting_for_ai"
  | "selecting_answer"
  | "next_question"
  | "submitting"
  | "checking_result"
  | "completed"
  | "failed"
  | "skipped";

export const ASSESSMENT_PHASE_LABELS: Record<AssessmentPhase, string> = {
  queued: "Queued",
  running: "Running",
  reading_question: "Reading question",
  waiting_for_ai: "Waiting for AI",
  selecting_answer: "Selecting answer",
  next_question: "Moving to next question",
  submitting: "Submitting",
  checking_result: "Checking result",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

/** The event that most recently defined the phase. One table, so the
 * dashboard and the worker agree without either importing the other. */
const PHASE_BY_EVENT: Partial<Record<AssessmentEventType, AssessmentPhase>> = {
  assessment_started: "running",
  quiz_discovered: "running",
  quiz_skipped_completed: "skipped",
  quiz_started: "running",
  question_extracted: "reading_question",
  ai_request: "waiting_for_ai",
  ai_response: "selecting_answer",
  answer_selected: "selecting_answer",
  question_completed: "next_question",
  quiz_submitted: "submitting",
  quiz_result_received: "checking_result",
  quiz_completed: "running",
  assessment_completed: "completed",
  assessment_failed: "failed",
};

export function phaseForEvent(type: string): AssessmentPhase | null {
  return PHASE_BY_EVENT[type as AssessmentEventType] ?? null;
}

/** The current phase from a session's events, newest last. Returns
 * "queued" for a session that has not produced an assessment event yet. */
export function phaseFromEvents(events: { type: string }[]): AssessmentPhase {
  for (let i = events.length - 1; i >= 0; i--) {
    const phase = phaseForEvent(events[i].type);
    if (phase) return phase;
  }
  return "queued";
}
