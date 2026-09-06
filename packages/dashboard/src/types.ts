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

/** One entry in a stored step script: a plain-English line, or one action
 * of a JSON template. Both live in the same array. */
export type WorkflowStep = string | Record<string, unknown>;

/** Which runner in the worker handles a run. */
export type JobKind = "automation" | "assessment";

export interface Job {
  id: string;
  name: string;
  targetUrl: string;
  steps: WorkflowStep[];
  concurrency: number;
  status: JobStatus;
  groupId: string | null; // set when a scheduled group launched this run
  kind: JobKind;
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
  | "screencast_frame"
  // The Assignments module rides the same event channel, which is why the
  // existing run view shows quiz progress without knowing what a quiz is.
  | AssessmentEventType;

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
  /** The organization this person belongs to; null = Unassigned. */
  organizationId: string | null;
  signedIn: boolean;
  activeJobId: string | null;
  createdAt: string;
}

/** The two creation flows a template can be the default for. */
export type TemplateScope = "group" | "user";

/** How a template is written. Mirrors packages/shared/src/templateTypes.ts;
 * a template with no type is plain-English, which is what every template
 * that predates the field is. */
export type TemplateType = "plain" | "json" | "typescript";
export type TemplateTypeFilter = TemplateType | "all";

export const TEMPLATE_TYPE_LABELS: Record<TemplateType, string> = {
  plain: "Plain-English",
  json: "JSON",
  typescript: "TypeScript",
};

/** A reusable step script, picked from a list when creating/editing a group
 * instead of retyping the same Task every time. */
export interface StepTemplate {
  id: string;
  name: string;
  steps: WorkflowStep[];
  templateType: TemplateType;
  /** The source as typed, for JSON and TypeScript. Null for plain, whose
   * source IS its steps. */
  body: string | null;
  /** The portal configuration, when this is an assessment template. */
  assessment: AssessmentPortalConfig | null;
  /** "group" = prefills a new group's Task, "user" = the script that runs to
   * capture a new user's sign-in. At most one template holds each. */
  defaultFor: TemplateScope | null;
  createdAt: string;
}

/** A saved link + task + user roster the server runs by itself on a daily
 * wall-clock window. Mirrors packages/shared/src/types.ts. */
/** Standard automation, or an assessment. The same group either way: same
 * roster, days, window, timezone and scheduler. */
export type GroupType = "standard" | "assessment";

export interface Group {
  id: string;
  name: string;
  /** The organization this group is a department of; null = Unassigned. */
  organizationId: string | null;
  targetUrl: string;
  steps: WorkflowStep[];
  groupType: GroupType;
  /** For an assessment group: the template carrying the portal config. */
  assessmentTemplateId: string | null;
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

/** The top of the company → department → people hierarchy: an organization
 * owns groups (its departments) and users (its people). Mirrors
 * packages/shared/src/types.ts. */
export interface Organization {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

/** An organization plus the roll-up shown on the Organizations rail. */
export interface OrganizationWithCounts extends Organization {
  groupCount: number;
  userCount: number;
}

/** A login to this platform — as opposed to a `PlatformUser`, which is a
 * person an automation signs in AS. Two different things that were briefly
 * given the same name. */
export type AccountRole = "admin" | "owner";
export type AccountStatus = "pending" | "active" | "rejected" | "suspended";

/** What the dashboard is told about whoever is signed in. */
export interface SessionAccount {
  id: string;
  email: string;
  username: string | null;
  name: string;
  workspaceName: string;
  role: AccountRole;
  createdAt: string;
}

/** The fuller row the admin's Accounts list shows. */
export interface Account extends SessionAccount {
  phone: string;
  purpose: string;
  status: AccountStatus;
  approvedAt: string | null;
  lastLoginAt: string | null;
}

// ============================================================
// Assignments — the Assessment / Quiz module.
// Mirrors packages/shared/src/assessmentTypes.ts and portalConfig.ts on
// the wire, same convention as everything above.
// ============================================================

export type QuestionType =
  | "single_choice"
  | "multiple_choice"
  | "true_false"
  | "dropdown"
  | "text"
  | "matching"
  | "ordering";

/** How the portal describes a quiz. "unknown" is honest and common — plenty
 * of portals publish no status until you open the quiz. */
export type PortalQuizStatus = "unknown" | "not_started" | "in_progress" | "completed";

/** Where a quiz stands in OUR record. */
export type QuizStatus = "discovered" | "pending" | "in_progress" | "completed" | "failed" | "skipped";

/** One attempt at one quiz. "already_completed" is not a variety of
 * "completed": it means we arrived, found the portal had it submitted, and
 * did NOT take it. */
export type QuizRunStatus =
  | "queued"
  | "running"
  /** Submit has been clicked and we do not yet know whether it landed — the
   * one state a crash is genuinely dangerous in, so it is named. */
  | "submitting"
  /** Submitted, waiting for the portal to show the result. */
  | "verifying"
  | "completed"
  | "failed"
  | "stopped"
  | "skipped"
  | "already_completed";

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

/** What a live assessment session is doing right now, projected from its
 * events rather than stored — the events are already durable and already
 * relayed, so a phase is a view of them, not a second source of truth. */
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

/** The current phase from a session's events, newest last. */
export function phaseFromEvents(events: { type: string }[]): AssessmentPhase {
  for (let i = events.length - 1; i >= 0; i--) {
    const phase = PHASE_BY_EVENT[events[i].type as AssessmentEventType];
    if (phase) return phase;
  }
  return "queued";
}

/**
 * The portal configuration a quiz template carries.
 *
 * Empty until the real portal is supplied — every field here is a place a
 * selector will go, and none of them is guessed at. See
 * packages/shared/src/portalConfig.ts, which is the definition.
 */
export interface AssessmentPortalConfig {
  assessmentUrl?: string;
  quizListSelector?: string;
  quizCardSelector?: string;
  quizNameSelector?: string;
  quizIdAttribute?: string;
  quizOpenSelector?: string;
  completion?: {
    statusSelector?: string;
    completedText?: string[];
    pendingText?: string[];
    completedMarkerSelector?: string;
  };
  question?: {
    questionSelector?: string;
    progressSelector?: string;
    optionsSelector?: string;
    optionTextSelector?: string;
    selectedOptionSelector?: string;
    optionClickSelector?: string;
    questionType?: QuestionType;
  };
  nextSelector?: string;
  submitSelector?: string;
  confirmSubmitSelector?: string;
  resultSelector?: string;
  scoreSelector?: string;
  backToListSelector?: string;
  resultTimeoutMs?: number;
}

/** The editor's field list, in the order a run uses them. Mirrors
 * PORTAL_CONFIG_FIELDS in shared so the two never drift. */
export const PORTAL_CONFIG_FIELDS: { path: string; label: string; hint: string }[] = [
  { path: "assessmentUrl", label: "Assessment URL", hint: "Opened before looking for the quiz list. Leave blank if the login workflow already lands there." },
  { path: "quizListSelector", label: "Quiz list", hint: "The container that holds the quiz cards." },
  { path: "quizCardSelector", label: "Quiz card", hint: "One element per quiz, inside the list." },
  { path: "quizNameSelector", label: "Quiz name", hint: "The title of the quiz, relative to the card." },
  { path: "quizIdAttribute", label: "Quiz id attribute", hint: "A stable per-quiz attribute (e.g. data-quiz-id) used to match the portal quiz to our record." },
  { path: "quizOpenSelector", label: "Open quiz", hint: "Clicked to open a quiz. Defaults to the card itself." },
  { path: "completion.statusSelector", label: "Quiz status", hint: "Where the card shows Submitted / Pending." },
  { path: "completion.completedText", label: "Status means completed", hint: "Comma-separated words that mean already submitted." },
  { path: "completion.pendingText", label: "Status means pending", hint: "Comma-separated words that mean not done yet. Checked first." },
  { path: "completion.completedMarkerSelector", label: "Completed marker", hint: "A selector only completed cards have (e.g. a View result link)." },
  { path: "question.questionSelector", label: "Question", hint: "The text of the current question." },
  { path: "question.progressSelector", label: "Progress", hint: "Optional counter, e.g. Question 3 of 10." },
  { path: "question.optionsSelector", label: "Options", hint: "One element per answer choice, in display order." },
  { path: "question.optionTextSelector", label: "Option text", hint: "Optional label inside an option row." },
  { path: "question.optionClickSelector", label: "Option click target", hint: "Optional control inside the row to click (e.g. the radio input)." },
  { path: "question.selectedOptionSelector", label: "Selected option", hint: "How a chosen option looks, used to verify the click landed." },
  { path: "nextSelector", label: "Next", hint: "Moves to the next question." },
  { path: "submitSelector", label: "Submit", hint: "Submits the quiz." },
  { path: "confirmSubmitSelector", label: "Confirm submit", hint: "Optional confirmation control shown after Submit." },
  { path: "resultSelector", label: "Result", hint: "Only present once a quiz is finished — also what makes a retry safe." },
  { path: "scoreSelector", label: "Score", hint: "Where the score is shown, if the portal shows one." },
  { path: "backToListSelector", label: "Back to list", hint: "Returns to the quiz list. Defaults to re-opening the assessment URL." },
];

/** Without these the engine cannot run, so a run is refused with them named
 * rather than failing inside a browser. resultSelector is here because it is
 * how the engine asks "is this already submitted?" — without it a submission
 * can never be confirmed. */
export const REQUIRED_PORTAL_FIELDS = [
  "quizCardSelector",
  "question.questionSelector",
  "question.optionsSelector",
  "submitSelector",
  "resultSelector",
];

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

/** One question as answered — the primary, searchable record. A screenshot
 * is an artefact, not a log. */
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
  fallbackUsed: boolean;
  reason: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AssessmentArtifact {
  id: string;
  quizRunId: string;
  kind: "completion" | "failure" | "result";
  contentType: string;
  byteSize: number;
  caption: string;
  createdAt: string;
}

/** An assessment group with the roster and the readiness the Quizzes tab
 * shows — "this cannot run yet, and here is why" belongs on the card, not
 * in a log nobody reads until 2 PM. */
export interface AssessmentGroupRow {
  group: GroupWithSchedule;
  people: { id: string; name: string; email: string }[];
  ready: boolean;
  blockedBecause: string | null;
}
