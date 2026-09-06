/**
 * The quiz engine.
 *
 * Reads as the process it is: open the list, work out what is left, take
 * the next one, question by question, submit, record, come back. The
 * division of labour it enforces is the point of the whole module —
 *
 *   Playwright  owns the browser: navigating, clicking, extracting.
 *   The AI      owns exactly one decision: which option id, how sure.
 *   Postgres    owns what happened, durably, so a restart resumes.
 *
 * The model never touches the page. It is handed a question and a list of
 * options and hands back an id; this file turns that id into an index into
 * an array of elements Playwright already found. There is no path by which
 * a model's output selects an element.
 */

import type { Page } from "playwright";
import {
  createQuizRun,
  listQuizzesByPersonUnscoped,
  markAssessmentRunStarted,
  recordQuestionResult,
  recordQuizProgress,
  reapStaleQuizRuns,
  refreshAssessmentProfile,
  saveArtifact,
  setQuizStatus,
  updateQuizRunStatus,
  upsertQuiz,
} from "@automation/db";
import {
  ConcurrencyLimiter,
  canRetrySubmit,
  createProvider,
  decideQuizStart,
  isQuizFinished,
  parseScore,
  reconcileQuizStatus,
  routeAnswer,
  selectNextQuiz,
  validateExtractedQuestion,
  type AssessmentAIConfig,
  type AssessmentEventType,
  type AssessmentPortalConfig,
  type QuizStatus,
} from "@automation/shared";
import { ConfiguredPortalAdapter, PortalConfigError, type AssessmentPortalAdapter } from "./portalAdapter.js";

export interface AssessmentRunContext {
  page: () => Page;
  accountId: string;
  organizationId: string | null;
  groupId: string | null;
  personId: string;
  personName: string;
  jobId: string;
  sessionId: string;
  config: AssessmentPortalConfig;
  ai: AssessmentAIConfig;
  timeoutMs: number;
  /** Aborted when the dashboard's Stop reaches this session. Checked between
   * every step, so a stop lands in seconds rather than at the end of a quiz. */
  signal: AbortSignal;
  /** Goes through the SAME session_events table and Redis relay as every
   * other event, which is why the existing live view shows quiz progress
   * without knowing what a quiz is. */
  emit: (type: AssessmentEventType, payload: Record<string, unknown>) => Promise<void>;
  /** The platform's existing failure channel — the worker publishes, the
   * API sends the email. No second alerting system. */
  alert: (message: string, errorTrace?: string) => void;
  screenshot: () => Promise<Buffer | null>;
}

export interface AssessmentRunResult {
  quizzesDiscovered: number;
  quizzesCompleted: number;
  quizzesSkipped: number;
  quizzesFailed: number;
}

/** A run must not loop forever on a portal that keeps offering the same
 * quiz, or a quiz that never reaches its last question. Both bounds are
 * generous enough that no legitimate assessment reaches them. */
const MAX_QUIZZES_PER_RUN = 100;
const MAX_QUESTIONS_PER_QUIZ = 300;
const MAX_SUBMIT_ATTEMPTS = 2;

class Stopped extends Error {
  constructor() {
    super("stopped");
    this.name = "Stopped";
  }
}

/**
 * One shared AI limiter per worker process.
 *
 * Deliberately not per session: the limit exists because of somebody else's
 * rate limit, which ten concurrent sessions hit ten times as hard. Browser
 * concurrency is a separate number for a separate reason (this machine's
 * memory), and is applied by the job's own concurrency, not here.
 */
let aiLimiter: ConcurrencyLimiter | null = null;
let aiLimiterSize = 0;

function limiterFor(concurrency: number): ConcurrencyLimiter {
  if (!aiLimiter || aiLimiterSize !== concurrency) {
    aiLimiter = new ConcurrencyLimiter(concurrency);
    aiLimiterSize = concurrency;
  }
  return aiLimiter;
}

/**
 * Runs one person's whole assessment.
 *
 * Called after the job's navigation steps have already logged this session
 * in and left it somewhere the portal config can find the quizzes from — so
 * this function never sees a credential, and there is nothing here that
 * could send one anywhere.
 */
export async function runAssessment(ctx: AssessmentRunContext): Promise<AssessmentRunResult> {
  const result: AssessmentRunResult = {
    quizzesDiscovered: 0,
    quizzesCompleted: 0,
    quizzesSkipped: 0,
    quizzesFailed: 0,
  };

  const adapter: AssessmentPortalAdapter = new ConfiguredPortalAdapter(ctx.config, {
    page: ctx.page,
    timeoutMs: ctx.timeoutMs,
    listUrl: () => ctx.page().url(),
  });

  const primary = createProvider(ctx.ai.primary, ctx.ai.timeoutMs);
  const fallback = ctx.ai.fallback ? createProvider(ctx.ai.fallback, ctx.ai.timeoutMs) : null;
  const limiter = limiterFor(ctx.ai.concurrency);

  const stopCheck = () => {
    if (ctx.signal.aborted) throw new Stopped();
  };

  await markAssessmentRunStarted({
    accountId: ctx.accountId,
    organizationId: ctx.organizationId,
    personId: ctx.personId,
  });

  // Anything this person left "running" belongs to a worker that is gone —
  // its browser died with it, so it cannot be resumed. Closing those out
  // here is what stops "currently running" on the dashboard from filling up
  // with the ghosts of killed containers.
  const reaped = await reapStaleQuizRuns(ctx.personId, ctx.jobId);
  if (reaped > 0) {
    await ctx.emit("assessment_started", { note: `closed ${reaped} quiz run(s) left open by an earlier worker` });
  }

  await ctx.emit("assessment_started", { person: ctx.personName });

  try {
    await adapter.openAssessmentList();

    // ---------- discovery, and reconciling it with what we already know ----------
    const discovered = await adapter.discoverQuizzes();
    result.quizzesDiscovered = discovered.length;

    const stored = await listQuizzesByPersonUnscoped(ctx.personId);
    const storedByExternalId = new Map(stored.map((q) => [q.externalQuizId, q]));

    // The quiz rows, in the portal's own display order — which is the order
    // a person would take them in, and the order any prerequisites assume.
    const quizRows: {
      id: string;
      externalQuizId: string;
      quizName: string;
      internalStatus: QuizStatus;
      index: number;
    }[] = [];

    for (const found of discovered) {
      const existing = storedByExternalId.get(found.externalQuizId) ?? null;
      const reconciled = reconcileQuizStatus(found, existing);

      const row = await upsertQuiz({
        accountId: ctx.accountId,
        organizationId: ctx.organizationId,
        personId: ctx.personId,
        externalQuizId: found.externalQuizId,
        quizName: found.quizName,
        portalStatus: reconciled.portalStatus,
        internalStatus: reconciled.internalStatus,
      });

      quizRows.push({
        id: row.id,
        externalQuizId: found.externalQuizId,
        quizName: found.quizName,
        internalStatus: reconciled.internalStatus,
        index: found.index,
      });

      await ctx.emit("quiz_discovered", {
        quizName: found.quizName,
        externalQuizId: found.externalQuizId,
        portalStatus: found.portalStatus,
        // The raw text is here so an unmatched status is diagnosable: "the
        // card said 'Awaiting review', which no completion rule covers".
        statusText: found.statusText,
        internalStatus: reconciled.internalStatus,
        // Named plainly, because this is the "our database was wrong and the
        // portal corrected it" case the whole design is built around.
        updatedFromPortal: reconciled.changed,
      });

      // Most skips happen right here, not at open time: a quiz the portal
      // reports as done is settled by reconciliation and never selected
      // again. Saying so explicitly matters — otherwise the run log shows
      // eight quizzes discovered, two taken, and no account of the other
      // six, which reads like a bug rather than the intended behaviour.
      if (isQuizFinished(reconciled.internalStatus)) {
        result.quizzesSkipped++;
        await ctx.emit("quiz_skipped_completed", {
          quizName: found.quizName,
          externalQuizId: found.externalQuizId,
          reason:
            found.portalStatus === "completed"
              ? "the portal reports this quiz as already submitted"
              : "already completed in a previous run",
        });
      }
    }

    // ---------- take what is left, one at a time ----------
    const attempted = new Set<string>();

    for (let taken = 0; taken < MAX_QUIZZES_PER_RUN; taken++) {
      stopCheck();
      const next = selectNextQuiz(quizRows, attempted);
      if (!next) break;
      attempted.add(next.externalQuizId);

      const row = quizRows.find((q) => q.externalQuizId === next.externalQuizId)!;
      const outcome = await runOneQuiz(ctx, adapter, row, { primary, fallback, limiter });

      if (outcome === "completed") result.quizzesCompleted++;
      else if (outcome === "skipped") result.quizzesSkipped++;
      else result.quizzesFailed++;

      // Both "completed" and "skipped" are finished states, so neither is
      // offered again; a failure stays selectable for the NEXT run, but the
      // `attempted` set keeps it from looping within this one.
      row.internalStatus = outcome === "failed" ? "failed" : outcome;
    }

    await refreshAssessmentProfile({
      accountId: ctx.accountId,
      organizationId: ctx.organizationId,
      personId: ctx.personId,
      successful: result.quizzesFailed === 0,
    });

    await ctx.emit("assessment_completed", { ...result });
    return result;
  } catch (err) {
    if (err instanceof Stopped) {
      // A Stop is not a failure. Still refresh the profile so the work that
      // DID finish before the stop is counted.
      await refreshAssessmentProfile({
        accountId: ctx.accountId,
        organizationId: ctx.organizationId,
        personId: ctx.personId,
        successful: false,
      }).catch(() => {});
      await ctx.emit("assessment_completed", { ...result, stopped: true });
      return result;
    }

    const message = err instanceof Error ? err.message : String(err);
    await ctx.emit("assessment_failed", { error: message });
    ctx.alert(
      `Assessment failed for ${ctx.personName}: ${message}`,
      err instanceof Error ? (err.stack ?? message) : message,
    );
    await refreshAssessmentProfile({
      accountId: ctx.accountId,
      organizationId: ctx.organizationId,
      personId: ctx.personId,
      successful: false,
    }).catch(() => {});
    throw err;
  }
}

type QuizOutcome = "completed" | "skipped" | "failed";

/**
 * One quiz, end to end.
 *
 * The order of the first three things it does is the idempotency story: ask
 * the portal what it currently says, decide from THAT (not from our
 * record), and only then create a run row. A crash anywhere after this
 * point leaves the portal as the authority on what happened, which the next
 * run reads before it does anything.
 */
async function runOneQuiz(
  ctx: AssessmentRunContext,
  adapter: AssessmentPortalAdapter,
  quiz: { id: string; externalQuizId: string; quizName: string; internalStatus: QuizStatus; index: number },
  ai: {
    primary: ReturnType<typeof createProvider>;
    fallback: ReturnType<typeof createProvider> | null;
    limiter: ConcurrencyLimiter;
  },
): Promise<QuizOutcome> {
  // Re-read the card rather than trusting the discovery pass: minutes may
  // have passed, and the portal is the authority on completion.
  const current = await adapter.readQuizStatus(quiz.index);
  const portalStatus = current?.portalStatus ?? "unknown";

  const decision = decideQuizStart({ portalStatus, internalStatus: quiz.internalStatus });
  if (decision.action === "skip") {
    await setQuizStatus(quiz.id, decision.status === "already_completed" ? "completed" : "skipped");
    await createQuizRun({
      accountId: ctx.accountId,
      organizationId: ctx.organizationId,
      groupId: ctx.groupId,
      personId: ctx.personId,
      personName: ctx.personName,
      quizId: quiz.id,
      quizName: quiz.quizName,
      jobId: ctx.jobId,
      sessionId: ctx.sessionId,
      status: decision.status,
    });
    await ctx.emit("quiz_skipped_completed", { quizName: quiz.quizName, reason: decision.reason });
    return "skipped";
  }

  const run = await createQuizRun({
    accountId: ctx.accountId,
    organizationId: ctx.organizationId,
    groupId: ctx.groupId,
    personId: ctx.personId,
    personName: ctx.personName,
    quizId: quiz.id,
    quizName: quiz.quizName,
    jobId: ctx.jobId,
    sessionId: ctx.sessionId,
    status: "running",
  });
  await setQuizStatus(quiz.id, "in_progress");
  await ctx.emit("quiz_started", { quizName: quiz.quizName, quizRunId: run.id });

  let answered = 0;
  let total: number | null = null;

  try {
    await adapter.openQuiz(quiz.index);

    for (let n = 1; n <= MAX_QUESTIONS_PER_QUIZ; n++) {
      if (ctx.signal.aborted) throw new Stopped();

      // ---------- Playwright reads the page ----------
      const { question, optionElements } = await adapter.readQuestion(n);
      total = question.totalQuestions ?? total;

      const valid = validateExtractedQuestion(question);
      if (!valid.ok) {
        // An empty question or blank options is a page mid-render or a
        // wrong selector — either way, asking a model to choose between
        // four empty strings would get a confident answer to nothing.
        throw new Error(`could not read question ${n}: ${valid.problems.join("; ")}`);
      }

      await ctx.emit("question_extracted", {
        quizRunId: run.id,
        questionNumber: n,
        optionCount: question.options.length,
        totalQuestions: question.totalQuestions,
      });

      // ---------- the AI decides one thing ----------
      await ctx.emit("ai_request", { quizRunId: run.id, questionNumber: n, provider: ai.primary.id });

      const routed = await ai.limiter.run(() =>
        routeAnswer(ai.primary, ai.fallback, question, {
          confidenceThreshold: ctx.ai.confidenceThreshold,
          maxRetries: ctx.ai.maxRetries,
          signal: ctx.signal,
        }),
      );

      if (!routed.ok) {
        await recordQuestionResult({
          quizRunId: run.id,
          questionNumber: n,
          questionText: question.questionText,
          questionType: question.questionType,
          options: question.options,
          selectedOption: null,
          provider: routed.attempts.at(-1)?.provider ?? null,
          model: routed.attempts.at(-1)?.model ?? null,
          confidence: null,
          latencyMs: routed.attempts.reduce((sum, a) => sum + a.latencyMs, 0),
          fallbackUsed: routed.attempts.length > 1,
          reason: null,
          error: routed.error,
          metadata: { attempts: routed.attempts.length },
        });
        await ctx.emit("ai_response", { quizRunId: run.id, questionNumber: n, error: routed.error });
        // No answer means no click. Nothing is guessed, and the quiz is
        // failed with the question number recorded so it can be looked at.
        throw new Error(`question ${n}: ${routed.error}`);
      }

      await ctx.emit("ai_response", {
        quizRunId: run.id,
        questionNumber: n,
        provider: routed.attempt.provider,
        model: routed.attempt.model,
        confidence: routed.answer.confidence,
        latencyMs: routed.attempt.latencyMs,
        fallbackUsed: routed.fallbackUsed,
        decision: routed.decision,
      });

      // ---------- Playwright acts on it ----------
      // The id is an INDEX into the elements Playwright already found. It
      // was validated against these exact options before it got here, so
      // this lookup cannot miss.
      const index = question.options.findIndex((o) => o.id === routed.answer.selectedOption);
      await adapter.selectOption(optionElements, index);

      const landed = await adapter.verifySelection(optionElements, index);
      if (landed === false) {
        // Configured to be checkable, and it isn't checked. One retry: a
        // click that misses on a re-rendering option list is common, and a
        // second click on a radio is harmless.
        await adapter.selectOption(optionElements, index);
      }

      await ctx.emit("answer_selected", {
        quizRunId: run.id,
        questionNumber: n,
        selectedOption: routed.answer.selectedOption,
        verified: landed,
      });

      await recordQuestionResult({
        quizRunId: run.id,
        questionNumber: n,
        questionText: question.questionText,
        questionType: question.questionType,
        options: question.options,
        selectedOption: routed.answer.selectedOption,
        provider: routed.attempt.provider,
        model: routed.attempt.model,
        confidence: routed.answer.confidence,
        latencyMs: routed.attempt.latencyMs,
        fallbackUsed: routed.fallbackUsed,
        // The model's stated reason is generated text about the contents of
        // somebody's assessment, so keeping it is a setting, not a given.
        reason: ctx.ai.storeReasons ? routed.answer.reason : null,
        error: null,
        metadata: { decision: routed.decision, attempts: routed.attempts.length, verified: landed },
      });

      answered = n;
      await recordQuizProgress(run.id, answered, total);
      await ctx.emit("question_completed", { quizRunId: run.id, questionNumber: n });

      if (!(await adapter.hasNext())) break;
      await adapter.goNext();
    }

    // ---------- submit, once ----------
    const submission = await submitOnce(ctx, adapter, run.id);
    if (!submission.ok) throw new Error(submission.error);

    const { resultText, scoreText } = await adapter.waitForResult();
    const score = parseScore(scoreText ?? resultText);
    await ctx.emit("quiz_result_received", { quizRunId: run.id, resultText, scoreText, score });

    // The one screenshot worth taking: proof of completion, with the score
    // on it if the portal shows one. Not one per question — the question
    // rows above are the searchable record.
    const shot = await ctx.screenshot();
    if (shot) {
      await saveArtifact({
        quizRunId: run.id,
        kind: "completion",
        contentType: "image/jpeg",
        caption: scoreText ? `${quiz.quizName} — ${scoreText}` : quiz.quizName,
        data: shot,
      });
    }

    await updateQuizRunStatus(run.id, "completed", {
      score,
      scoreText,
      questionsAnswered: answered,
      questionsTotal: total ?? answered,
    });
    await setQuizStatus(quiz.id, "completed", { score, scoreText });
    await ctx.emit("quiz_completed", { quizRunId: run.id, quizName: quiz.quizName, score });

    await adapter.returnToList();
    return "completed";
  } catch (err) {
    if (err instanceof Stopped) {
      await updateQuizRunStatus(run.id, "stopped", { questionsAnswered: answered });
      await setQuizStatus(quiz.id, "pending");
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    // A configuration error is worth saying plainly: it names the field to
    // fill in, and it will happen to every quiz until someone does.
    const detail = err instanceof PortalConfigError ? message : `at question ${answered + 1}: ${message}`;

    const shot = await ctx.screenshot().catch(() => null);
    if (shot) {
      await saveArtifact({
        quizRunId: run.id,
        kind: "failure",
        contentType: "image/jpeg",
        caption: `${quiz.quizName} — failed ${detail}`.slice(0, 300),
        data: shot,
      }).catch(() => {});
    }

    await updateQuizRunStatus(run.id, "failed", { error: detail, questionsAnswered: answered });
    await setQuizStatus(quiz.id, "failed");
    await ctx.emit("assessment_failed", { quizRunId: run.id, quizName: quiz.quizName, error: detail });
    ctx.alert(`Quiz "${quiz.quizName}" failed for ${ctx.personName}: ${detail}`);

    // A failed quiz does not fail the whole assessment — the next one may
    // be perfectly fine, and a person half-finished is better than a person
    // not started. Getting back to the list is best-effort for the same
    // reason: if it fails, discovery on the next quiz will fail visibly.
    await adapter.returnToList().catch(() => {});
    return "failed";
  }
}

/**
 * Submits, and decides — carefully — whether a failure may be retried.
 *
 * This is the one action in the system that must never be retried blindly.
 * The rule (canRetrySubmit, in shared, where it is tested) is that a retry
 * happens only when the portal is unambiguous that nothing landed. An
 * ambiguous state counts as "it may have gone through", which fails the run
 * and leaves a person to look — a failed run someone can inspect beats a
 * duplicate submission nobody can undo.
 */
async function submitOnce(
  ctx: AssessmentRunContext,
  adapter: AssessmentPortalAdapter,
  quizRunId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    if (ctx.signal.aborted) throw new Stopped();

    // Before the very first click too: a previous worker may have submitted
    // this and died before writing anything down.
    let alreadyDone = false;
    let stateKnown = true;
    try {
      alreadyDone = await adapter.isSubmitted();
    } catch {
      stateKnown = false;
    }
    if (alreadyDone) {
      await ctx.emit("quiz_submitted", { quizRunId, note: "already submitted — not clicking Submit again" });
      return { ok: true };
    }

    let submitError: string | null = null;
    try {
      await adapter.submit();
      await ctx.emit("quiz_submitted", { quizRunId, attempt });
    } catch (err) {
      submitError = err instanceof Error ? err.message : String(err);
    }

    // Whether it threw or not, ask the portal what actually happened. A
    // click that throws after the request went out is exactly the case a
    // naive retry gets wrong.
    let landed = false;
    let postStateKnown = true;
    try {
      landed = await adapter.isSubmitted();
    } catch {
      postStateKnown = false;
    }
    if (landed) return { ok: true };
    if (!submitError && postStateKnown) {
      // The click worked and the result state simply has not appeared yet;
      // waitForResult is the thing that waits for it.
      return { ok: true };
    }

    const verdict = canRetrySubmit({
      resultDetected: landed,
      stateKnown: stateKnown && postStateKnown,
      attempts: attempt,
      maxAttempts: MAX_SUBMIT_ATTEMPTS,
    });
    if (!verdict.retry) {
      return { ok: false, error: `submission failed (${submitError ?? "no result state"}) — ${verdict.reason}` };
    }
  }
  return { ok: false, error: "submission did not complete" };
}
