/**
 * Postgres access for the Assignments module.
 *
 * The durable half of the design. A worker can die mid-quiz, a container
 * can be rebuilt, a whole machine can be replaced — and the next run still
 * knows what this person has already been asked, what they answered, and
 * what is left. That is the entire reason these rows exist rather than
 * living in the engine's memory.
 *
 * Everything here is scoped by account_id like the rest of the schema, and
 * everything hangs off the existing organizations/users/groups/jobs rows
 * rather than re-inventing them.
 */

import type {
  AssessmentArtifact,
  AssessmentArtifactKind,
  AssessmentOverview,
  AssessmentPerson,
  AssessmentProfile,
  AssessmentQuiz,
  PortalQuizStatus,
  QuizQuestionResult,
  QuizRun,
  QuizRunStatus,
  QuizStatus,
} from "@automation/shared";
import { TERMINAL_QUIZ_RUN_STATUSES, canTransitionQuizRun, summarizeQuizzes } from "@automation/shared";
import { pool } from "./pool.js";

// ---------- row mappers ----------

interface QuizDbRow {
  id: string;
  organization_id: string | null;
  person_id: string;
  external_quiz_id: string;
  quiz_name: string;
  portal_status: PortalQuizStatus;
  internal_status: QuizStatus;
  score: string | null;
  score_text: string | null;
  discovered_at: Date;
  completed_at: Date | null;
  last_checked_at: Date;
}

/** NUMERIC comes back from pg as a string — deliberately, since a numeric
 * can exceed a JS number. Scores here are 0–100 with one decimal, so the
 * conversion is safe and is done once, here. */
function numOrNull(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toQuiz(r: QuizDbRow): AssessmentQuiz {
  return {
    id: r.id,
    organizationId: r.organization_id,
    personId: r.person_id,
    externalQuizId: r.external_quiz_id,
    quizName: r.quiz_name,
    portalStatus: r.portal_status,
    internalStatus: r.internal_status,
    score: numOrNull(r.score),
    scoreText: r.score_text,
    discoveredAt: r.discovered_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
    lastCheckedAt: r.last_checked_at.toISOString(),
  };
}

interface QuizRunDbRow {
  id: string;
  organization_id: string | null;
  group_id: string | null;
  person_id: string;
  person_name: string;
  quiz_id: string | null;
  quiz_name: string;
  job_id: string | null;
  session_id: string | null;
  status: QuizRunStatus;
  started_at: Date | null;
  completed_at: Date | null;
  questions_total: number;
  questions_answered: number;
  score: string | null;
  score_text: string | null;
  error: string | null;
  created_at: Date;
}

function toQuizRun(r: QuizRunDbRow): QuizRun {
  return {
    id: r.id,
    organizationId: r.organization_id,
    groupId: r.group_id,
    personId: r.person_id,
    personName: r.person_name,
    quizId: r.quiz_id,
    quizName: r.quiz_name,
    jobId: r.job_id,
    sessionId: r.session_id,
    status: r.status,
    startedAt: r.started_at?.toISOString() ?? null,
    completedAt: r.completed_at?.toISOString() ?? null,
    questionsTotal: r.questions_total,
    questionsAnswered: r.questions_answered,
    score: numOrNull(r.score),
    scoreText: r.score_text,
    error: r.error,
    createdAt: r.created_at.toISOString(),
  };
}

interface QuestionResultDbRow {
  id: string;
  quiz_run_id: string;
  question_number: number;
  question_text: string;
  question_type: QuizQuestionResult["questionType"];
  options: { id: string; text: string }[];
  selected_option: string | null;
  provider: string | null;
  model: string | null;
  confidence: string | null;
  latency_ms: number | null;
  fallback_used: boolean;
  reason: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function toQuestionResult(r: QuestionResultDbRow): QuizQuestionResult {
  return {
    id: r.id,
    quizRunId: r.quiz_run_id,
    questionNumber: r.question_number,
    questionText: r.question_text,
    questionType: r.question_type,
    options: r.options ?? [],
    selectedOption: r.selected_option,
    provider: r.provider,
    model: r.model,
    confidence: numOrNull(r.confidence),
    latencyMs: r.latency_ms,
    fallbackUsed: r.fallback_used,
    reason: r.reason,
    error: r.error,
    metadata: r.metadata ?? {},
    createdAt: r.created_at.toISOString(),
  };
}

// ---------- quizzes ----------

/**
 * Records what the portal is showing for one person's quiz.
 *
 * An upsert on (person_id, external_quiz_id): discovery runs on every
 * assessment, and the second run has to update the row the first one made
 * rather than adding another. `completed_at` is only ever set, never
 * cleared by a discovery — the moment a quiz was finished is a fact, and a
 * portal that later stops publishing a status must not erase it.
 */
export async function upsertQuiz(input: {
  accountId: string;
  organizationId: string | null;
  personId: string;
  externalQuizId: string;
  quizName: string;
  portalStatus: PortalQuizStatus;
  internalStatus: QuizStatus;
}): Promise<AssessmentQuiz> {
  const { rows } = await pool.query<QuizDbRow>(
    `INSERT INTO assessment_quizzes
       (account_id, organization_id, person_id, external_quiz_id, quiz_name,
        portal_status, internal_status, last_checked_at,
        completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(),
             CASE WHEN $7 = 'completed' THEN now() ELSE NULL END)
     ON CONFLICT (person_id, external_quiz_id) DO UPDATE
        SET quiz_name       = EXCLUDED.quiz_name,
            organization_id = EXCLUDED.organization_id,
            portal_status   = EXCLUDED.portal_status,
            internal_status = EXCLUDED.internal_status,
            last_checked_at = now(),
            completed_at    = CASE
                                WHEN EXCLUDED.internal_status = 'completed'
                                THEN COALESCE(assessment_quizzes.completed_at, now())
                                ELSE assessment_quizzes.completed_at
                              END
     RETURNING *`,
    [
      input.accountId,
      input.organizationId,
      input.personId,
      input.externalQuizId,
      input.quizName,
      input.portalStatus,
      input.internalStatus,
    ],
  );
  return toQuiz(rows[0]);
}

export async function setQuizStatus(
  id: string,
  status: QuizStatus,
  extra: { score?: number | null; scoreText?: string | null } = {},
): Promise<void> {
  await pool.query(
    `UPDATE assessment_quizzes
        SET internal_status = $2,
            score      = COALESCE($3, score),
            score_text = COALESCE($4, score_text),
            last_checked_at = now(),
            completed_at = CASE WHEN $2 = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END
      WHERE id = $1`,
    [id, status, extra.score ?? null, extra.scoreText ?? null],
  );
}

export async function listQuizzesByPerson(personId: string, accountId: string): Promise<AssessmentQuiz[]> {
  const { rows } = await pool.query<QuizDbRow>(
    `SELECT * FROM assessment_quizzes
      WHERE person_id = $1 AND account_id = $2
      ORDER BY discovered_at ASC`,
    [personId, accountId],
  );
  return rows.map(toQuiz);
}

/** The worker's own read: it holds the person id from the session it is
 * running and has no account context of its own, exactly like the group
 * scheduler. Named so that reaching for it from a request handler looks as
 * wrong as it would be. */
export async function listQuizzesByPersonUnscoped(personId: string): Promise<AssessmentQuiz[]> {
  const { rows } = await pool.query<QuizDbRow>(
    `SELECT * FROM assessment_quizzes WHERE person_id = $1 ORDER BY discovered_at ASC`,
    [personId],
  );
  return rows.map(toQuiz);
}

export async function listQuizzes(
  accountId: string,
  filter: { organizationId?: string | null; personId?: string; status?: QuizStatus; limit?: number } = {},
): Promise<AssessmentQuiz[]> {
  const where: string[] = ["account_id = $1"];
  const params: unknown[] = [accountId];
  if (filter.organizationId) {
    where.push(`organization_id = $${params.length + 1}`);
    params.push(filter.organizationId);
  }
  if (filter.personId) {
    where.push(`person_id = $${params.length + 1}`);
    params.push(filter.personId);
  }
  if (filter.status) {
    where.push(`internal_status = $${params.length + 1}`);
    params.push(filter.status);
  }
  params.push(Math.min(filter.limit ?? 500, 2000));
  const { rows } = await pool.query<QuizDbRow>(
    `SELECT * FROM assessment_quizzes WHERE ${where.join(" AND ")}
      ORDER BY last_checked_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toQuiz);
}

export async function getQuiz(id: string, accountId: string): Promise<AssessmentQuiz | null> {
  const { rows } = await pool.query<QuizDbRow>(
    `SELECT * FROM assessment_quizzes WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  return rows[0] ? toQuiz(rows[0]) : null;
}

// ---------- quiz runs ----------

export async function createQuizRun(input: {
  accountId: string;
  organizationId: string | null;
  groupId: string | null;
  personId: string;
  personName: string;
  quizId: string | null;
  quizName: string;
  jobId: string | null;
  sessionId: string | null;
  status: QuizRunStatus;
}): Promise<QuizRun> {
  const { rows } = await pool.query<QuizRunDbRow>(
    `INSERT INTO quiz_runs
       (account_id, organization_id, group_id, person_id, person_name, quiz_id, quiz_name,
        job_id, session_id, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $10 = 'running' THEN now() ELSE NULL END)
     RETURNING *`,
    [
      input.accountId,
      input.organizationId,
      input.groupId,
      input.personId,
      input.personName,
      input.quizId,
      input.quizName,
      input.jobId,
      input.sessionId,
      input.status,
    ],
  );
  return toQuizRun(rows[0]);
}

/**
 * Moves a quiz run along, refusing an illegal transition in SQL.
 *
 * The guard is a WHERE clause, not an if-statement, because the write that
 * matters is the one that arrives late: a worker that was killed after
 * submitting, restarted, and is now trying to mark a run "running" that a
 * recovery pass has already closed. Doing this check in Node would leave a
 * window between the read and the write; doing it in the UPDATE does not.
 *
 * Returns false when nothing moved, so the caller can log the refusal
 * rather than believe a write that never happened.
 */
export async function updateQuizRunStatus(
  id: string,
  status: QuizRunStatus,
  extra: {
    error?: string | null;
    score?: number | null;
    scoreText?: string | null;
    questionsTotal?: number;
    questionsAnswered?: number;
  } = {},
): Promise<boolean> {
  const allowedFrom = (
    ["queued", "running", "completed", "failed", "stopped", "skipped", "already_completed"] as QuizRunStatus[]
  ).filter((from) => canTransitionQuizRun(from, status));
  if (allowedFrom.length === 0) return false;

  const finished = TERMINAL_QUIZ_RUN_STATUSES.includes(status);
  const { rowCount } = await pool.query(
    `UPDATE quiz_runs
        SET status = $2,
            error = COALESCE($3, error),
            score = COALESCE($4, score),
            score_text = COALESCE($5, score_text),
            questions_total = COALESCE($6, questions_total),
            questions_answered = COALESCE($7, questions_answered),
            started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
            completed_at = CASE WHEN $8 THEN COALESCE(completed_at, now()) ELSE completed_at END
      WHERE id = $1 AND status = ANY($9::text[])`,
    [
      id,
      status,
      extra.error ?? null,
      extra.score ?? null,
      extra.scoreText ?? null,
      extra.questionsTotal ?? null,
      extra.questionsAnswered ?? null,
      finished,
      allowedFrom,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Bumps the answered counter as the engine goes, so a run that is
 * interrupted still shows how far it got. */
export async function recordQuizProgress(
  id: string,
  questionsAnswered: number,
  questionsTotal: number | null,
): Promise<void> {
  await pool.query(
    `UPDATE quiz_runs
        SET questions_answered = $2,
            questions_total = GREATEST(questions_total, COALESCE($3, questions_total))
      WHERE id = $1`,
    [id, questionsAnswered, questionsTotal],
  );
}

export async function getQuizRun(id: string, accountId: string): Promise<QuizRun | null> {
  const { rows } = await pool.query<QuizRunDbRow>(
    `SELECT * FROM quiz_runs WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  return rows[0] ? toQuizRun(rows[0]) : null;
}

export async function listQuizRuns(
  accountId: string,
  filter: {
    personId?: string;
    groupId?: string;
    organizationId?: string;
    jobId?: string;
    status?: QuizRunStatus;
    limit?: number;
  } = {},
): Promise<QuizRun[]> {
  const where: string[] = ["account_id = $1"];
  const params: unknown[] = [accountId];
  const add = (clause: string, value: unknown) => {
    where.push(`${clause} = $${params.length + 1}`);
    params.push(value);
  };
  if (filter.personId) add("person_id", filter.personId);
  if (filter.groupId) add("group_id", filter.groupId);
  if (filter.organizationId) add("organization_id", filter.organizationId);
  if (filter.jobId) add("job_id", filter.jobId);
  if (filter.status) add("status", filter.status);
  params.push(Math.min(filter.limit ?? 200, 1000));

  const { rows } = await pool.query<QuizRunDbRow>(
    `SELECT * FROM quiz_runs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toQuizRun);
}

/**
 * Closes out quiz runs that a dead worker left open.
 *
 * Called when an assessment session starts, for that same person: anything
 * still "queued" or "running" from a previous attempt cannot be resumed —
 * the browser it belonged to is gone. Marking them failed rather than
 * leaving them is what stops "currently running" on the dashboard from
 * being a graveyard, and it never touches a terminal row.
 */
export async function reapStaleQuizRuns(personId: string, exceptJobId: string | null): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE quiz_runs
        SET status = 'failed',
            error = COALESCE(
              error,
              CASE status
                WHEN 'submitting' THEN 'the worker stopped just after clicking Submit — the portal was re-checked on the next run rather than resubmitting'
                WHEN 'verifying'  THEN 'the worker stopped while confirming the result — the portal was re-checked on the next run'
                ELSE 'the worker running this quiz stopped before it finished'
              END),
            completed_at = COALESCE(completed_at, now())
      WHERE person_id = $1
        AND status IN ('queued', 'running', 'submitting', 'verifying')
        AND ($2::uuid IS NULL OR job_id IS DISTINCT FROM $2::uuid)`,
    [personId, exceptJobId],
  );
  return rowCount ?? 0;
}

// ---------- question results ----------

export async function recordQuestionResult(input: {
  quizRunId: string;
  questionNumber: number;
  questionText: string;
  questionType: string;
  options: { id: string; text: string }[];
  selectedOption: string | null;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  latencyMs: number | null;
  fallbackUsed: boolean;
  reason: string | null;
  error: string | null;
  metadata?: Record<string, unknown>;
}): Promise<QuizQuestionResult> {
  const { rows } = await pool.query<QuestionResultDbRow>(
    `INSERT INTO quiz_question_results
       (quiz_run_id, question_number, question_text, question_type, options, selected_option,
        provider, model, confidence, latency_ms, fallback_used, reason, error, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     RETURNING *`,
    [
      input.quizRunId,
      input.questionNumber,
      input.questionText,
      input.questionType,
      JSON.stringify(input.options),
      input.selectedOption,
      input.provider,
      input.model,
      input.confidence,
      input.latencyMs,
      input.fallbackUsed,
      input.reason,
      input.error,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return toQuestionResult(rows[0]);
}

export async function listQuestionResults(quizRunId: string): Promise<QuizQuestionResult[]> {
  const { rows } = await pool.query<QuestionResultDbRow>(
    `SELECT * FROM quiz_question_results WHERE quiz_run_id = $1 ORDER BY question_number ASC, created_at ASC`,
    [quizRunId],
  );
  return rows.map(toQuestionResult);
}

// ---------- artefacts ----------

/** Screenshots live in Postgres rather than on the worker's disk: they have
 * to outlive the container that took them, and this stack has no object
 * store. The cap is the guard against a run turning the database into a
 * photo album. */
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

export async function saveArtifact(input: {
  quizRunId: string;
  kind: AssessmentArtifactKind;
  contentType: string;
  caption: string;
  data: Buffer;
}): Promise<AssessmentArtifact | null> {
  if (input.data.byteLength === 0 || input.data.byteLength > MAX_ARTIFACT_BYTES) return null;
  const { rows } = await pool.query<{
    id: string;
    quiz_run_id: string;
    kind: AssessmentArtifactKind;
    content_type: string;
    caption: string;
    byte_size: number;
    created_at: Date;
  }>(
    `INSERT INTO assessment_artifacts (quiz_run_id, kind, content_type, caption, byte_size, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, quiz_run_id, kind, content_type, caption, byte_size, created_at`,
    [input.quizRunId, input.kind, input.contentType, input.caption, input.data.byteLength, input.data],
  );
  const r = rows[0];
  return {
    id: r.id,
    quizRunId: r.quiz_run_id,
    kind: r.kind,
    contentType: r.content_type,
    byteSize: r.byte_size,
    caption: r.caption,
    createdAt: r.created_at.toISOString(),
  };
}

/** Metadata only — never the bytes. Loading a run's detail view must not
 * pull megabytes of JPEG through it; the image comes from its own endpoint. */
export async function listArtifacts(quizRunId: string): Promise<AssessmentArtifact[]> {
  const { rows } = await pool.query<{
    id: string;
    quiz_run_id: string;
    kind: AssessmentArtifactKind;
    content_type: string;
    caption: string;
    byte_size: number;
    created_at: Date;
  }>(
    `SELECT id, quiz_run_id, kind, content_type, caption, byte_size, created_at
       FROM assessment_artifacts WHERE quiz_run_id = $1 ORDER BY created_at ASC`,
    [quizRunId],
  );
  return rows.map((r) => ({
    id: r.id,
    quizRunId: r.quiz_run_id,
    kind: r.kind,
    contentType: r.content_type,
    byteSize: r.byte_size,
    caption: r.caption,
    createdAt: r.created_at.toISOString(),
  }));
}

/** The bytes, scoped through the run that owns them so knowing an id is
 * not enough to read another workspace's screenshot. */
export async function getArtifactData(
  id: string,
  accountId: string,
): Promise<{ contentType: string; data: Buffer } | null> {
  const { rows } = await pool.query<{ content_type: string; data: Buffer }>(
    `SELECT a.content_type, a.data
       FROM assessment_artifacts a
       JOIN quiz_runs r ON r.id = a.quiz_run_id
      WHERE a.id = $1 AND r.account_id = $2`,
    [id, accountId],
  );
  return rows[0] ? { contentType: rows[0].content_type, data: rows[0].data } : null;
}

// ---------- profiles ----------

interface ProfileDbRow {
  person_id: string;
  organization_id: string | null;
  last_assessment_run: Date | null;
  last_successful_run: Date | null;
  total_quizzes: number;
  completed_quizzes: number;
  pending_quizzes: number;
  failed_quizzes: number;
  last_updated: Date;
}

function toProfile(r: ProfileDbRow): AssessmentProfile {
  return {
    personId: r.person_id,
    organizationId: r.organization_id,
    lastAssessmentRun: r.last_assessment_run?.toISOString() ?? null,
    lastSuccessfulRun: r.last_successful_run?.toISOString() ?? null,
    totalQuizzes: r.total_quizzes,
    completedQuizzes: r.completed_quizzes,
    pendingQuizzes: r.pending_quizzes,
    failedQuizzes: r.failed_quizzes,
    lastUpdated: r.last_updated.toISOString(),
  };
}

export async function getAssessmentProfile(personId: string, accountId: string): Promise<AssessmentProfile | null> {
  const { rows } = await pool.query<ProfileDbRow>(
    `SELECT * FROM assessment_profiles WHERE person_id = $1 AND account_id = $2`,
    [personId, accountId],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

/** Stamps the start of an attempt. Separate from the counters below so
 * "we tried" is recorded even when the attempt goes on to fail. */
export async function markAssessmentRunStarted(input: {
  accountId: string;
  organizationId: string | null;
  personId: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO assessment_profiles (person_id, account_id, organization_id, last_assessment_run, last_updated)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (person_id) DO UPDATE
        SET last_assessment_run = now(),
            organization_id = EXCLUDED.organization_id,
            account_id = EXCLUDED.account_id,
            last_updated = now()`,
    [input.personId, input.accountId, input.organizationId],
  );
}

/**
 * Recomputes a person's counters from their quiz rows.
 *
 * Recomputed rather than incremented: counters that are added to drift the
 * first time anything is written twice or not at all, and drift in this
 * particular number is what would make a run skip a quiz. The rows are the
 * truth; the profile is a cached view of them.
 */
export async function refreshAssessmentProfile(input: {
  accountId: string;
  organizationId: string | null;
  personId: string;
  successful: boolean;
}): Promise<AssessmentProfile> {
  const quizzes = await listQuizzesByPersonUnscoped(input.personId);
  const totals = summarizeQuizzes(quizzes.map((q) => ({ internalStatus: q.internalStatus, score: q.score })));

  const { rows } = await pool.query<ProfileDbRow>(
    `INSERT INTO assessment_profiles
       (person_id, account_id, organization_id, total_quizzes, completed_quizzes, pending_quizzes,
        failed_quizzes, last_successful_run, last_updated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() ELSE NULL END, now())
     ON CONFLICT (person_id) DO UPDATE
        SET account_id = EXCLUDED.account_id,
            organization_id = EXCLUDED.organization_id,
            total_quizzes = EXCLUDED.total_quizzes,
            completed_quizzes = EXCLUDED.completed_quizzes,
            pending_quizzes = EXCLUDED.pending_quizzes,
            failed_quizzes = EXCLUDED.failed_quizzes,
            last_successful_run = CASE
                                    WHEN $8 THEN now()
                                    ELSE assessment_profiles.last_successful_run
                                  END,
            last_updated = now()
     RETURNING *`,
    [
      input.personId,
      input.accountId,
      input.organizationId,
      totals.totalQuizzes,
      totals.completedQuizzes,
      totals.pendingQuizzes,
      totals.failedQuizzes,
      input.successful,
    ],
  );
  return toProfile(rows[0]);
}

// ---------- read models for the dashboard ----------

/**
 * The Overview numbers in one round trip.
 *
 * Aggregated in Postgres for the same reason listRunHistory is: the page
 * shows totals, and shipping every quiz row to Node to count them would
 * make the landing view of the module its slowest.
 */
export async function assessmentOverview(accountId: string): Promise<AssessmentOverview> {
  const { rows } = await pool.query<Record<string, string | null>>(
    `SELECT
       (SELECT count(*) FROM organizations WHERE account_id = $1)                              AS organizations,
       (SELECT count(*) FROM groups WHERE account_id = $1)                                     AS groups,
       (SELECT count(*) FROM groups WHERE account_id = $1 AND group_type = 'assessment')       AS assessment_groups,
       (SELECT count(*) FROM users WHERE account_id = $1)                                      AS people,
       (SELECT count(*) FROM assessment_quizzes
         WHERE account_id = $1 AND internal_status = 'completed')                              AS quizzes_completed,
       (SELECT count(*) FROM assessment_quizzes
         WHERE account_id = $1 AND internal_status IN ('discovered','pending','in_progress'))  AS quizzes_pending,
       (SELECT count(*) FROM quiz_runs
         WHERE account_id = $1 AND status IN ('queued','running'))                             AS quizzes_running,
       (SELECT count(*) FROM quiz_runs
         WHERE account_id = $1 AND status = 'failed'
           AND created_at >= now() - interval '7 days')                                        AS failed_runs,
       (SELECT avg(score) FROM assessment_quizzes
         WHERE account_id = $1 AND internal_status = 'completed' AND score IS NOT NULL)        AS average_score`,
    [accountId],
  );
  const r = rows[0];
  const n = (k: string) => Number(r[k] ?? 0);
  const avg = r.average_score === null ? null : Math.round(Number(r.average_score) * 10) / 10;
  return {
    organizations: n("organizations"),
    groups: n("groups"),
    assessmentGroups: n("assessment_groups"),
    people: n("people"),
    quizzesCompleted: n("quizzes_completed"),
    quizzesPending: n("quizzes_pending"),
    quizzesRunning: n("quizzes_running"),
    failedRuns: n("failed_runs"),
    averageScore: Number.isFinite(avg as number) ? avg : null,
  };
}

/**
 * Every person with their assessment roll-up.
 *
 * A LEFT JOIN from `users`, so somebody who has never sat an assessment
 * still appears with zeros rather than vanishing — "who has not started" is
 * one of the questions this page exists to answer.
 */
export async function listAssessmentPeople(
  accountId: string,
  organizationId?: string | null,
  limit = 500,
): Promise<AssessmentPerson[]> {
  const params: unknown[] = [accountId];
  let orgClause = "";
  if (organizationId) {
    params.push(organizationId);
    orgClause = ` AND u.organization_id = $${params.length}`;
  }
  // Bounded like every other list in this codebase (listUsers is LIMIT 500).
  // An unbounded roll-up over every person in a workspace is the one query
  // here that grows without anyone noticing.
  params.push(Math.min(limit, 2000));

  const { rows } = await pool.query<{
    person_id: string;
    person_name: string;
    email: string;
    organization_id: string | null;
    total_quizzes: string;
    completed_quizzes: string;
    pending_quizzes: string;
    failed_quizzes: string;
    average_score: string | null;
    last_assessment_run: Date | null;
    last_successful_run: Date | null;
  }>(
    `SELECT u.id AS person_id, u.name AS person_name, u.email, u.organization_id,
            count(q.id)                                                          AS total_quizzes,
            count(*) FILTER (WHERE q.internal_status = 'completed')              AS completed_quizzes,
            count(*) FILTER (WHERE q.internal_status IN
                             ('discovered','pending','in_progress'))             AS pending_quizzes,
            count(*) FILTER (WHERE q.internal_status = 'failed')                 AS failed_quizzes,
            avg(q.score) FILTER (WHERE q.internal_status = 'completed')          AS average_score,
            p.last_assessment_run, p.last_successful_run
       FROM users u
       LEFT JOIN assessment_quizzes q ON q.person_id = u.id
       LEFT JOIN assessment_profiles p ON p.person_id = u.id
      WHERE u.account_id = $1${orgClause}
      GROUP BY u.id, u.name, u.email, u.organization_id, p.last_assessment_run, p.last_successful_run
      ORDER BY lower(u.name)
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => {
    const avg = r.average_score === null ? null : Math.round(Number(r.average_score) * 10) / 10;
    return {
      personId: r.person_id,
      personName: r.person_name,
      email: r.email,
      organizationId: r.organization_id,
      totalQuizzes: Number(r.total_quizzes),
      completedQuizzes: Number(r.completed_quizzes),
      pendingQuizzes: Number(r.pending_quizzes),
      failedQuizzes: Number(r.failed_quizzes),
      averageScore: Number.isFinite(avg as number) ? avg : null,
      lastAssessmentRun: r.last_assessment_run?.toISOString() ?? null,
      lastSuccessfulRun: r.last_successful_run?.toISOString() ?? null,
    };
  });
}
