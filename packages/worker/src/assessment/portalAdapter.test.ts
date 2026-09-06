// The portal adapter, driven against a real browser and a real page.
//
// Everything else in this feature is tested as pure logic, which is the
// right way round — but the adapter's whole job is to talk to a DOM, and a
// pure test of it would only prove that the mocks agree with each other.
// So this one boots Chromium, serves test-fixtures/mock-portal.html, and
// drives ConfiguredPortalAdapter through the exact sequence a run performs:
//
//   discover -> read statuses -> skip the submitted one -> open an
//   incomplete one -> extract question + options -> select by POSITION ->
//   verify -> Next -> Submit -> result + score -> back to the list
//
// It talks to nothing external: the fixture is served from localhost on an
// ephemeral port, and no AI provider is involved at all.
//
//   npm test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { optionIndexForId, readPortalStatus, type AssessmentPortalConfig } from "@automation/shared";
import { ConfiguredPortalAdapter, PortalConfigError } from "./portalAdapter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "..", "test-fixtures", "mock-portal.html");

/**
 * The config a portal like the fixture would be given.
 *
 * Worth reading as the worked example it is: this is exactly the shape
 * somebody will fill in for the real portal, and nothing here is special
 * to the test harness.
 */
function config(baseUrl: string): AssessmentPortalConfig {
  return {
    assessmentUrl: baseUrl,
    quizListSelector: "#quiz-list",
    quizCardSelector: ".quiz-card",
    quizNameSelector: ".quiz-title",
    quizIdAttribute: "data-quiz-id",
    completion: {
      statusSelector: ".quiz-state",
      completedText: ["submitted", "completed"],
      // Checked first, so the card reading "Not completed" is not mistaken
      // for a finished one.
      pendingText: ["not completed", "not started"],
    },
    question: {
      questionSelector: "#question-text",
      progressSelector: "#progress",
      optionsSelector: "#options .option",
      optionTextSelector: ".option-text",
      selectedOptionSelector: ".is-chosen",
    },
    nextSelector: "#next-btn",
    submitSelector: "#submit-btn",
    resultSelector: "#result-banner",
    scoreSelector: "#score",
    backToListSelector: "#back-btn",
  };
}

let server: Server;
let browser: Browser | null = null;
let page: Page;
let baseUrl = "";
let available = false;

before(async () => {
  const html = readFileSync(FIXTURE, "utf-8");
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}/` : "";

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    available = true;
  } catch {
    // No browser binary on this machine. Skipping beats failing: the pure
    // logic these paths feed is covered in packages/shared regardless, and
    // a red suite for a missing optional binary teaches people to ignore it.
    available = false;
  }
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const adapterFor = (cfg = config(baseUrl)) =>
  new ConfiguredPortalAdapter(cfg, { page: () => page, timeoutMs: 5000, listUrl: () => baseUrl });

describe("ConfiguredPortalAdapter against a real page", () => {
  it("discovers every quiz, with its id, name and status", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const a = adapterFor();
    await a.openAssessmentList();
    const found = await a.discoverQuizzes();

    assert.equal(found.length, 3);
    const byId = new Map(found.map((q) => [q.externalQuizId, q]));
    assert.equal(byId.get("quiz-alpha")?.quizName, "Fire Safety");
    assert.equal(byId.get("quiz-alpha")?.portalStatus, "completed");
    // The card says "Not completed" — which contains "completed".
    assert.equal(byId.get("quiz-bravo")?.portalStatus, "not_started");
    assert.equal(byId.get("quiz-chrly")?.portalStatus, "not_started");
  });

  it("reads the id from the attribute, not from the visible name", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const a = adapterFor();
    await a.openAssessmentList();
    const found = await a.discoverQuizzes();
    // A renamed quiz must still match our stored record, which is the whole
    // reason quizIdAttribute is worth configuring.
    assert.ok(found.every((q) => q.externalQuizId.startsWith("quiz-")));
    assert.ok(found.every((q) => q.quizName !== q.externalQuizId));
  });

  it("locates a quiz by id regardless of where it sits in the list", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const a = adapterFor();
    await a.openAssessmentList();
    const located = await a.locateQuiz("quiz-chrly");
    assert.ok(located);
    assert.equal(located.quizName, "Manual Handling");
    // The fixture sorts submitted quizzes last, so the positions are not the
    // order they are declared in — which is exactly the hazard.
    const all = await a.discoverQuizzes();
    assert.equal(all[located.index].externalQuizId, "quiz-chrly");
    assert.equal(await a.locateQuiz("does-not-exist"), null);
  });

  it("extracts a question and labels its options by position", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const a = adapterFor();
    await a.openAssessmentList();
    const bravo = await a.locateQuiz("quiz-bravo");
    await a.openQuiz(bravo!.index);

    const { question, optionElements } = await a.readQuestion(1);
    assert.equal(question.questionText, "Which of these is personal data?");
    assert.equal(question.questionType, "single_choice");
    assert.equal(question.totalQuestions, 3);
    assert.deepEqual(
      question.options.map((o) => o.id),
      ["A", "B", "C", "D"],
    );
    assert.equal(question.options[0].text, "A customer's home address");
    assert.equal(optionElements.length, 4);
  });

  it("clicks the option the id refers to, by index — never by text", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const a = adapterFor();
    await a.openAssessmentList();
    const bravo = await a.locateQuiz("quiz-bravo");
    await a.openQuiz(bravo!.index);
    const { question, optionElements } = await a.readQuestion(1);

    // Two options share the prefix "A customer's" — a text match would be
    // ambiguous. The id is an index, so it cannot be.
    const idx = optionIndexForId("B", question.options.length);
    assert.equal(idx, 1);
    await a.selectOption(optionElements, idx);

    assert.equal(await a.verifySelection(optionElements, 1), true);
    assert.equal(await a.verifySelection(optionElements, 0), false);
  });

  it("walks Next to the last question, where Next is disabled", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const a = adapterFor();
    await a.openAssessmentList();
    const bravo = await a.locateQuiz("quiz-bravo");
    await a.openQuiz(bravo!.index);

    assert.equal(a.hasNextConfigured(), true);
    assert.equal(await a.hasNext(), true, "question 1 of 3 has a Next");
    await a.goNext();

    const q2 = await a.readQuestion(2);
    assert.equal(q2.question.questionText, "How long may we keep it?");
    assert.equal(await a.hasNext(), true);
    await a.goNext();

    const q3 = await a.readQuestion(3);
    assert.equal(q3.question.questionText, "Who may access it?");
    // Present but disabled on the last question.
    assert.equal(await a.hasNext(), false, "the last question must not report a Next");
  });

  it("submits, detects the result, reads the score, and returns to the list", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const a = adapterFor();
    await a.openAssessmentList();
    const chrly = await a.locateQuiz("quiz-chrly");
    await a.openQuiz(chrly!.index);

    const { question, optionElements } = await a.readQuestion(1);
    await a.selectOption(optionElements, optionIndexForId("B", question.options.length));

    assert.equal(await a.isSubmitted(), false, "not submitted before Submit is clicked");
    await a.submit();

    const { resultText, scoreText } = await a.waitForResult();
    assert.equal(resultText, "Completed");
    assert.equal(scoreText, "Score: 100%");
    assert.equal(await a.isSubmitted(), true, "the result state is what proves submission");

    await a.returnToList();
    // The portal now reports it as submitted — which is what the next run
    // reads, and why it will not be retaken.
    const after = await a.locateQuiz("quiz-chrly");
    assert.equal(after?.portalStatus, "completed");
  });

  it("names the missing field when the config is incomplete", async (t) => {
    if (!available) return t.skip("no Chromium available");
    const cfg = config(baseUrl);
    delete cfg.question!.optionsSelector;
    const a = adapterFor(cfg);
    await a.openAssessmentList();
    const bravo = await a.locateQuiz("quiz-bravo");
    await a.openQuiz(bravo!.index);
    await assert.rejects(() => a.readQuestion(1), (e: unknown) => {
      assert.ok(e instanceof PortalConfigError);
      assert.match((e as Error).message, /question\.optionsSelector/);
      return true;
    });
  });

  it("agrees with the pure status reader on what the page says", async (t) => {
    if (!available) return t.skip("no Chromium available");
    // The adapter reads the DOM; readPortalStatus interprets the text. This
    // pins that the two halves see the same thing, which is the seam where a
    // selector change would silently stop matching.
    const a = adapterFor();
    await a.openAssessmentList();
    const found = await a.discoverQuizzes();
    for (const q of found) {
      assert.equal(q.portalStatus, readPortalStatus(q.statusText, config(baseUrl).completion));
    }
  });
});
