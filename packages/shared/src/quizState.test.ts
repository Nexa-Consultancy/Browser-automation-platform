// The rules that decide whether a real person's quiz gets taken a second
// time. These are the ones worth pinning: every failure mode here is
// invisible in a typecheck and expensive in the world — a quiz skipped
// that nobody took, or a quiz submitted twice.
//
//   npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canRetrySubmit,
  canTransitionQuizRun,
  decideQuizStart,
  isQuizFinished,
  isTerminalQuizRun,
  parseScore,
  readPortalStatus,
  reconcileQuizStatus,
  selectNextQuiz,
  summarizeQuizzes,
} from "./quizState.js";
import { QUIZ_RUN_STATUSES } from "./assessmentTypes.js";
import { portalConfigReadiness, parsePortalConfig } from "./portalConfig.js";

const RULES = { completedText: ["submitted", "completed"], pendingText: ["not completed", "not started"] };

describe("readPortalStatus", () => {
  it("reads a completed status", () => {
    assert.equal(readPortalStatus("Submitted", RULES), "completed");
    assert.equal(readPortalStatus("  COMPLETED  ", RULES), "completed");
  });

  it('does NOT read "Not completed" as completed', () => {
    // The whole reason pendingText is checked first. Getting this wrong
    // skips a quiz nobody has taken, which is the worst outcome available.
    assert.equal(readPortalStatus("Not completed", RULES), "not_started");
    assert.equal(readPortalStatus("Not started", RULES), "not_started");
  });

  it("says unknown rather than guessing when no rule matches", () => {
    assert.equal(readPortalStatus("Available", RULES), "unknown");
    assert.equal(readPortalStatus("", RULES), "unknown");
    assert.equal(readPortalStatus(null, RULES), "unknown");
    assert.equal(readPortalStatus("Submitted", undefined), "unknown");
  });

  it("takes a completed marker element as proof on its own", () => {
    assert.equal(readPortalStatus(null, RULES, true), "completed");
  });
});

describe("reconcileQuizStatus — the portal is the authority", () => {
  it("adopts the portal's completion when our record has none", () => {
    const res = reconcileQuizStatus(
      { externalQuizId: "q1", quizName: "Quality", portalStatus: "completed" },
      null,
    );
    assert.equal(res.internalStatus, "completed");
    assert.equal(res.changed, true);
  });

  it("keeps completed without a rewrite when we already agreed", () => {
    const res = reconcileQuizStatus(
      { externalQuizId: "q1", quizName: "Quality", portalStatus: "completed" },
      { externalQuizId: "q1", internalStatus: "completed", portalStatus: "completed" },
    );
    assert.equal(res.changed, false);
  });

  it("corrects a stale completed when the portal says not started", () => {
    // A reset or reassigned quiz. Trusting our cache over the portal's
    // explicit answer would leave it never taken again.
    const res = reconcileQuizStatus(
      { externalQuizId: "q1", quizName: "Quality", portalStatus: "not_started" },
      { externalQuizId: "q1", internalStatus: "completed", portalStatus: "completed" },
    );
    assert.equal(res.internalStatus, "pending");
    assert.equal(res.changed, true);
  });

  it("keeps our own record when the portal publishes nothing", () => {
    const res = reconcileQuizStatus(
      { externalQuizId: "q1", quizName: "Quality", portalStatus: "unknown" },
      { externalQuizId: "q1", internalStatus: "completed", portalStatus: "unknown" },
    );
    assert.equal(res.internalStatus, "completed");
    assert.equal(res.changed, false);
  });

  it("never leaves a quiz parked on discovered", () => {
    const res = reconcileQuizStatus(
      { externalQuizId: "q1", quizName: "Quality", portalStatus: "unknown" },
      { externalQuizId: "q1", internalStatus: "discovered", portalStatus: "unknown" },
    );
    assert.equal(res.internalStatus, "pending");
    assert.equal(res.changed, true);
  });
});

describe("selectNextQuiz", () => {
  const quizzes = [
    { externalQuizId: "a", internalStatus: "completed" as const },
    { externalQuizId: "b", internalStatus: "skipped" as const },
    { externalQuizId: "c", internalStatus: "pending" as const },
    { externalQuizId: "d", internalStatus: "pending" as const },
  ];

  it("skips completed and skipped, in portal order", () => {
    assert.equal(selectNextQuiz(quizzes)?.externalQuizId, "c");
  });

  it("does not re-open one this run already attempted", () => {
    assert.equal(selectNextQuiz(quizzes, new Set(["c"]))?.externalQuizId, "d");
  });

  it("returns null when nothing is left", () => {
    assert.equal(selectNextQuiz(quizzes, new Set(["c", "d"])), null);
    assert.equal(selectNextQuiz([]), null);
  });

  it("agrees with isQuizFinished", () => {
    assert.equal(isQuizFinished("completed"), true);
    assert.equal(isQuizFinished("skipped"), true);
    assert.equal(isQuizFinished("failed"), false); // a failure is retryable next run
    assert.equal(isQuizFinished("pending"), false);
  });
});

describe("decideQuizStart — idempotency", () => {
  it("does not retake a quiz the portal reports as submitted", () => {
    const d = decideQuizStart({ portalStatus: "completed", internalStatus: "pending" });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.status, "already_completed");
  });

  it("survives a crash after submission — the portal is asked again", () => {
    // The dangerous sequence: submit lands, the worker dies before the
    // write, the job is retried. Our record still says in_progress. The
    // portal now says completed, and that has to win.
    const d = decideQuizStart({
      portalStatus: "completed",
      internalStatus: "in_progress",
      unfinishedRun: { status: "running", questionsAnswered: 7 },
    });
    assert.equal(d.action, "skip");
  });

  it("trusts our own completed record only when the portal publishes nothing", () => {
    assert.equal(decideQuizStart({ portalStatus: "unknown", internalStatus: "completed" }).action, "skip");
    // The portal actively disagrees — take it.
    assert.equal(decideQuizStart({ portalStatus: "not_started", internalStatus: "completed" }).action, "take");
  });

  it("takes a pending quiz", () => {
    assert.equal(decideQuizStart({ portalStatus: "not_started", internalStatus: "pending" }).action, "take");
    assert.equal(decideQuizStart({ portalStatus: "unknown", internalStatus: "pending" }).action, "take");
  });

  it("honours an explicit skip", () => {
    const d = decideQuizStart({ portalStatus: "unknown", internalStatus: "skipped" });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.status, "skipped");
  });
});

describe("canRetrySubmit — never submit twice", () => {
  it("refuses when the result state is already showing", () => {
    const r = canRetrySubmit({ resultDetected: true, stateKnown: true, attempts: 1, maxAttempts: 3 });
    assert.equal(r.retry, false);
  });

  it("refuses when we could not read the portal's state at all", () => {
    // Ambiguity is treated as "it may have gone through". A failed run a
    // person can look at beats a duplicate submission they cannot undo.
    const r = canRetrySubmit({ resultDetected: false, stateKnown: false, attempts: 1, maxAttempts: 3 });
    assert.equal(r.retry, false);
    assert.match(r.reason, /duplicate submission/);
  });

  it("allows a retry only when the portal confirms nothing landed", () => {
    assert.equal(canRetrySubmit({ resultDetected: false, stateKnown: true, attempts: 1, maxAttempts: 3 }).retry, true);
  });

  it("stops at the attempt limit", () => {
    assert.equal(canRetrySubmit({ resultDetected: false, stateKnown: true, attempts: 3, maxAttempts: 3 }).retry, false);
  });
});

describe("quiz run state transitions", () => {
  it("moves forward through the normal path", () => {
    assert.equal(canTransitionQuizRun("queued", "running"), true);
    assert.equal(canTransitionQuizRun("running", "completed"), true);
    assert.equal(canTransitionQuizRun("queued", "already_completed"), true);
  });

  it("never drags a finished run back to running", () => {
    // The write that would otherwise re-open a submitted quiz.
    for (const terminal of ["completed", "failed", "stopped", "skipped", "already_completed"] as const) {
      assert.equal(isTerminalQuizRun(terminal), true);
      for (const to of QUIZ_RUN_STATUSES) {
        assert.equal(canTransitionQuizRun(terminal, to), false, `${terminal} -> ${to}`);
      }
    }
  });

  it("cannot skip straight from queued to completed", () => {
    assert.equal(canTransitionQuizRun("queued", "completed"), false);
  });
});

describe("summarizeQuizzes", () => {
  it("counts and averages only completed, scored quizzes", () => {
    const s = summarizeQuizzes([
      { internalStatus: "completed", score: 90 },
      { internalStatus: "completed", score: 80 },
      { internalStatus: "completed", score: null },
      { internalStatus: "pending", score: null },
      { internalStatus: "failed", score: null },
      { internalStatus: "skipped", score: null },
    ]);
    assert.equal(s.totalQuizzes, 6);
    assert.equal(s.completedQuizzes, 3);
    assert.equal(s.pendingQuizzes, 1);
    assert.equal(s.failedQuizzes, 1);
    assert.equal(s.averageScore, 85);
  });

  it("has no average when nothing is scored", () => {
    assert.equal(summarizeQuizzes([{ internalStatus: "pending", score: null }]).averageScore, null);
    assert.equal(summarizeQuizzes([]).averageScore, null);
  });
});

describe("parseScore", () => {
  it("reads the shapes portals actually use", () => {
    assert.equal(parseScore("85%"), 85);
    assert.equal(parseScore("Score: 85"), 85);
    assert.equal(parseScore("17 / 20"), 85);
    assert.equal(parseScore("17 out of 20"), 85);
  });

  it("returns nothing rather than a wrong number", () => {
    // A made-up score in a results table is worse than a blank.
    assert.equal(parseScore("Passed"), null);
    assert.equal(parseScore(""), null);
    assert.equal(parseScore(null), null);
    assert.equal(parseScore("120%"), null);
    assert.equal(parseScore("5 / 0"), null);
  });
});

describe("portal config", () => {
  it("saves a half-finished config — but will not run one", () => {
    const parsed = parsePortalConfig({ quizCardSelector: ".quiz" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const readiness = portalConfigReadiness(parsed.config);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.missing.includes("question.questionSelector"));
  });

  it("is ready once the load-bearing fields are set", () => {
    const parsed = parsePortalConfig({
      quizCardSelector: ".quiz-card",
      question: { questionSelector: ".q", optionsSelector: ".opt" },
      submitSelector: "#submit",
      resultSelector: ".result",
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(portalConfigReadiness(parsed.config).ready, true);
  });

  it("insists on a result selector — it is how a submission is confirmed", () => {
    // Without it the engine can never ask "is this already submitted?",
    // which is the check the whole no-duplicate-submission rule rests on.
    const parsed = parsePortalConfig({
      quizCardSelector: ".quiz-card",
      question: { questionSelector: ".q", optionsSelector: ".opt" },
      submitSelector: "#submit",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const readiness = portalConfigReadiness(parsed.config);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.missing, ["resultSelector"]);
  });

  it("accepts a comma-separated list where the editor produces one", () => {
    const parsed = parsePortalConfig({ completion: { completedText: "submitted, completed " } });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.config.completion?.completedText, ["submitted", "completed"]);
  });

  it("refuses a question type the engine cannot actually answer yet", () => {
    const parsed = parsePortalConfig({ question: { questionType: "matching" } });
    assert.equal(parsed.ok, false);
  });

  it("refuses a value of the wrong kind", () => {
    assert.equal(parsePortalConfig({ quizCardSelector: 42 }).ok, false);
    assert.equal(parsePortalConfig("nope").ok, false);
  });

  it("treats an absent config as an empty one", () => {
    const parsed = parsePortalConfig(null);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.config, {});
  });
});
