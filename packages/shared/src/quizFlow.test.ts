// The whole "don't retake a quiz" pipeline, against a fake portal.
//
// Every unit in it is tested individually in quizState.test.ts; this walks
// them in the order the engine walks them, across TWO runs, because the
// failure that matters is a sequence rather than a function: run one takes
// a quiz, run two must not take it again — and must take the one that is
// left, and must fix its own record when the portal disagrees.
//
// No browser and no database: a portal is a list of cards, which is all the
// decision logic ever actually sees.
//
//   npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideQuizStart,
  isQuizFinished,
  readPortalStatus,
  reconcileQuizStatus,
  selectNextQuiz,
  summarizeQuizzes,
  type StoredQuiz,
} from "./quizState.js";
import type { QuizStatus } from "./assessmentTypes.js";

/** What the adapter would read off one quiz card. */
interface FakeCard {
  id: string;
  name: string;
  statusText: string | null;
}

const RULES = {
  statusSelector: ".status",
  completedText: ["submitted", "completed"],
  pendingText: ["not started", "not completed"],
};

/** Our durable record, keyed the way the database keys it. */
type Db = Map<string, StoredQuiz>;

/**
 * One assessment run, as the engine performs it: read the portal, reconcile
 * every card against what we stored, then take whatever is left — asking
 * the portal once more immediately before each one.
 *
 * Note where the two skip paths are. Most skips happen during
 * reconciliation: a quiz the portal reports as done is settled there and
 * never selected. The check immediately before opening one is the second
 * line — for a status that changed since discovery, or a stale record of
 * ours. Both are reported here, because both are reported by the engine.
 */
function runAssessment(portal: FakeCard[], db: Db): {
  taken: string[];
  skipped: { id: string; reason: string }[];
  corrected: string[];
} {
  const taken: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const corrected: string[] = [];

  // ---------- discovery + reconciliation ----------
  const rows: { externalQuizId: string; internalStatus: QuizStatus }[] = [];
  for (const card of portal) {
    const portalStatus = readPortalStatus(card.statusText, RULES);
    const stored = db.get(card.id) ?? null;
    const reconciled = reconcileQuizStatus(
      { externalQuizId: card.id, quizName: card.name, portalStatus },
      stored,
    );
    if (reconciled.changed) corrected.push(card.id);
    db.set(card.id, {
      externalQuizId: card.id,
      internalStatus: reconciled.internalStatus,
      portalStatus: reconciled.portalStatus,
    });
    rows.push({ externalQuizId: card.id, internalStatus: reconciled.internalStatus });

    if (isQuizFinished(reconciled.internalStatus)) {
      skipped.push({
        id: card.id,
        reason:
          portalStatus === "completed"
            ? "the portal reports this quiz as already submitted"
            : "already completed in a previous run",
      });
    }
  }

  // ---------- take what is left ----------
  const attempted = new Set<string>();
  for (let guard = 0; guard < 50; guard++) {
    const next = selectNextQuiz(rows, attempted);
    if (!next) break;
    attempted.add(next.externalQuizId);

    // Asked again immediately before opening it — minutes may have passed,
    // and the portal is the authority.
    const card = portal.find((c) => c.id === next.externalQuizId)!;
    const decision = decideQuizStart({
      portalStatus: readPortalStatus(card.statusText, RULES),
      internalStatus: next.internalStatus,
    });

    const row = rows.find((r) => r.externalQuizId === next.externalQuizId)!;
    if (decision.action === "skip") {
      skipped.push({ id: card.id, reason: decision.reason });
      row.internalStatus = "completed";
      db.set(card.id, { ...db.get(card.id)!, internalStatus: "completed" });
      continue;
    }

    taken.push(card.id);
    row.internalStatus = "completed";
    db.set(card.id, { ...db.get(card.id)!, internalStatus: "completed" });
    // Taking it is what changes the portal — on a portal that publishes a
    // status at all. A card with no status text keeps having none, which is
    // exactly the case where our own record is the only evidence there is.
    if (card.statusText !== null) card.statusText = "Submitted";
  }

  return { taken, skipped, corrected };
}

describe("a full assessment, twice over", () => {
  it("takes everything the first time and nothing the second", () => {
    const portal: FakeCard[] = [
      { id: "q1", name: "Quality", statusText: "Not started" },
      { id: "q2", name: "Safety", statusText: "Not started" },
    ];
    const db: Db = new Map();

    const first = runAssessment(portal, db);
    assert.deepEqual(first.taken, ["q1", "q2"]);
    assert.deepEqual(first.skipped, []);

    // Second run, same portal — now showing both as Submitted.
    const second = runAssessment(portal, db);
    assert.deepEqual(second.taken, [], "nothing may be retaken");
    assert.deepEqual(
      second.skipped.map((s) => s.id),
      ["q1", "q2"],
    );
  });

  it("skips what the portal already had, and takes only the rest", () => {
    // The headline case: the portal says Quality is Submitted, our database
    // has never heard of it. We update our side and move on to Safety.
    const portal: FakeCard[] = [
      { id: "q1", name: "Quality", statusText: "Submitted" },
      { id: "q2", name: "Safety", statusText: "Not started" },
    ];
    const db: Db = new Map();

    const run = runAssessment(portal, db);
    assert.deepEqual(run.taken, ["q2"]);
    assert.deepEqual(run.skipped.map((s) => s.id), ["q1"]);
    assert.ok(run.corrected.includes("q1"), "our record should have been corrected from the portal");
    assert.equal(db.get("q1")?.internalStatus, "completed");
  });

  it("picks up a quiz that appears later without disturbing the finished ones", () => {
    const portal: FakeCard[] = [{ id: "q1", name: "Quality", statusText: "Not started" }];
    const db: Db = new Map();
    runAssessment(portal, db);

    portal.push({ id: "q3", name: "Ethics", statusText: "Not started" });
    const second = runAssessment(portal, db);
    assert.deepEqual(second.taken, ["q3"]);
    assert.deepEqual(second.skipped.map((s) => s.id), ["q1"]);
  });

  it("retakes one the portal has reset", () => {
    const portal: FakeCard[] = [{ id: "q1", name: "Quality", statusText: "Not started" }];
    const db: Db = new Map();
    runAssessment(portal, db);
    assert.equal(db.get("q1")?.internalStatus, "completed");

    // The portal reopened it. Our stale "completed" must not win.
    portal[0].statusText = "Not started";
    const second = runAssessment(portal, db);
    assert.deepEqual(second.taken, ["q1"]);
  });

  it("does not retake on a portal that publishes no status at all", () => {
    // With nothing to check against, our own record is the only evidence
    // there is — so it has to be trusted, or every run retakes everything.
    const portal: FakeCard[] = [{ id: "q1", name: "Quality", statusText: null }];
    const db: Db = new Map();

    assert.deepEqual(runAssessment(portal, db).taken, ["q1"]);
    const second = runAssessment(portal, db);
    assert.deepEqual(second.taken, []);
    assert.equal(second.skipped.length, 1);
    assert.match(second.skipped[0].reason, /already completed in a previous run/);
  });

  it('never treats "Not completed" as done', () => {
    // A single word away from silently skipping a quiz nobody has taken.
    const portal: FakeCard[] = [{ id: "q1", name: "Quality", statusText: "Not completed" }];
    const db: Db = new Map();
    assert.deepEqual(runAssessment(portal, db).taken, ["q1"]);
  });

  it("rolls the finished state up into the counters the profile shows", () => {
    const portal: FakeCard[] = [
      { id: "q1", name: "Quality", statusText: "Submitted" },
      { id: "q2", name: "Safety", statusText: "Not started" },
      { id: "q3", name: "Ethics", statusText: "Not started" },
    ];
    const db: Db = new Map();
    runAssessment(portal, db);

    const totals = summarizeQuizzes([...db.values()].map((q) => ({ internalStatus: q.internalStatus, score: 80 })));
    assert.equal(totals.totalQuizzes, 3);
    assert.equal(totals.completedQuizzes, 3);
    assert.equal(totals.pendingQuizzes, 0);
    assert.equal(totals.averageScore, 80);
  });
});
