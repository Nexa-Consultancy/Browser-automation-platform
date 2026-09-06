// The AI seam, tested with no API key and no network: a fake provider is
// all the router and the answer validator ever see, which is the point of
// the interface existing.
//
//   npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConcurrencyLimiter, routeAnswer } from "./aiRouter.js";
import type { AIProvider, AIProviderResponse } from "./aiProviders.js";
import type { AIProviderId } from "./aiConfig.js";
import { aiConfigReadiness, readAssessmentAIConfig, readAssessmentBrowserConcurrency } from "./aiConfig.js";
import { extractJsonObject, parseAIAnswer } from "./aiAnswer.js";
import {
  buildQuestionPrompt,
  optionIdForIndex,
  optionIndexForId,
  validateExtractedQuestion,
  type ExtractedQuestion,
} from "./questionPayload.js";

const OPTIONS = [
  { id: "A", text: "Paris" },
  { id: "B", text: "Berlin" },
  { id: "C", text: "Madrid" },
  { id: "D", text: "Rome" },
];

const QUESTION: ExtractedQuestion = {
  questionText: "Capital of France?",
  questionType: "single_choice",
  options: OPTIONS,
  questionNumber: 1,
  totalQuestions: 10,
};

/** A provider that answers from a script. No key, no network, no vendor. */
function fakeProvider(
  id: AIProviderId,
  model: string,
  script: (AIProviderResponse | "throw")[],
): AIProvider & { calls: number } {
  let i = 0;
  return {
    id,
    model,
    calls: 0,
    async answerQuestion() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this as { calls: number };
      self.calls++;
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (next === "throw") throw new Error("boom");
      return next;
    },
  };
}

function answer(confidence: number, selected = "A"): AIProviderResponse {
  return {
    ok: true,
    answer: { selectedOption: selected, confidence, reason: "because" },
    attempt: { provider: "openai", model: "m", latencyMs: 5 },
  };
}

function failure(error: string, retryable: boolean): AIProviderResponse {
  return { ok: false, error, retryable, attempt: { provider: "openai", model: "m", latencyMs: 5 } };
}

describe("option identifiers", () => {
  it("labels by position, not by text", () => {
    assert.equal(optionIdForIndex(0), "A");
    assert.equal(optionIdForIndex(3), "D");
    assert.equal(optionIdForIndex(26), "A1");
  });

  it("maps an id back to a position", () => {
    assert.equal(optionIndexForId("C", 4), 2);
    assert.equal(optionIndexForId(" c ", 4), 2);
    assert.equal(optionIndexForId("A1", 30), 26);
  });

  it("refuses an id that isn't one of the options", () => {
    // The check that stands between a hallucinated "E" and a click on
    // whatever happens to be fourth.
    assert.equal(optionIndexForId("E", 4), -1);
    assert.equal(optionIndexForId("", 4), -1);
    assert.equal(optionIndexForId("Madrid", 4), -1);
    assert.equal(optionIndexForId("5", 4), -1);
  });

  it("accepts a 1-based number, since that is the right answer in the wrong format", () => {
    assert.equal(optionIndexForId("3", 4), 2);
    assert.equal(optionIndexForId("option 2", 4), 1);
    assert.equal(optionIndexForId("0", 4), -1);
  });
});

describe("validateExtractedQuestion", () => {
  it("accepts a well-formed question", () => {
    assert.equal(validateExtractedQuestion(QUESTION).ok, true);
  });

  it("catches a page that had not finished rendering", () => {
    assert.equal(validateExtractedQuestion({ ...QUESTION, questionText: "  " }).ok, false);
    assert.equal(validateExtractedQuestion({ ...QUESTION, options: [OPTIONS[0]] }).ok, false);
    assert.equal(
      validateExtractedQuestion({ ...QUESTION, options: [OPTIONS[0], { id: "B", text: "" }] }).ok,
      false,
    );
  });

  it("catches duplicate option ids", () => {
    const res = validateExtractedQuestion({
      ...QUESTION,
      options: [
        { id: "A", text: "one" },
        { id: "A", text: "two" },
      ],
    });
    assert.equal(res.ok, false);
  });
});

describe("the prompt", () => {
  it("carries the question and the options, and nothing else", () => {
    const prompt = buildQuestionPrompt(QUESTION);
    assert.match(prompt, /Capital of France\?/);
    assert.match(prompt, /A\. Paris/);
    assert.match(prompt, /selectedOption/);
    // Nothing about who is answering, where, or as whom.
    assert.doesNotMatch(prompt, /cookie|password|session|http/i);
  });
});

describe("parseAIAnswer", () => {
  it("accepts a clean JSON answer", () => {
    const res = parseAIAnswer('{"selectedOption":"C","confidence":0.91,"reason":"Madrid is Spain"}', OPTIONS);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.answer.selectedOption, "C");
      assert.equal(res.answer.confidence, 0.91);
    }
  });

  it("tolerates a code fence and a preamble", () => {
    const res = parseAIAnswer('Sure!\n```json\n{"selectedOption":"A","confidence":0.8}\n```', OPTIONS);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.answer.selectedOption, "A");
  });

  it("refuses free-form text outright", () => {
    // "I think C is probably correct." must never become a click.
    const res = parseAIAnswer("I think C is probably correct.", OPTIONS);
    assert.equal(res.ok, false);
  });

  it("refuses an option that was never offered", () => {
    const res = parseAIAnswer('{"selectedOption":"E","confidence":0.99}', OPTIONS);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /not one of A, B, C, D/);
  });

  it("treats a missing confidence as zero, not as certainty", () => {
    const res = parseAIAnswer('{"selectedOption":"B"}', OPTIONS);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.answer.confidence, 0);
  });

  it("normalizes a 0-100 confidence", () => {
    const res = parseAIAnswer('{"selectedOption":"B","confidence":91}', OPTIONS);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.answer.confidence, 0.91);
  });

  it("refuses a confidence that isn't a number, or is out of range", () => {
    assert.equal(parseAIAnswer('{"selectedOption":"B","confidence":"high"}', OPTIONS).ok, false);
    assert.equal(parseAIAnswer('{"selectedOption":"B","confidence":-1}', OPTIONS).ok, false);
  });

  it("accepts the aliases models actually emit", () => {
    const res = parseAIAnswer('{"answer":"D","certainty":0.75,"explanation":"Rome"}', OPTIONS);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.answer.selectedOption, "D");
  });

  it("finds the first balanced object and no further", () => {
    assert.equal(extractJsonObject('x {"a":{"b":1}} y {"c":2}'), '{"a":{"b":1}}');
    assert.equal(extractJsonObject('{"a":"}"}'), '{"a":"}"}');
    assert.equal(extractJsonObject("no object here"), null);
  });
});

describe("routeAnswer — confidence routing", () => {
  const base = { confidenceThreshold: 0.7, maxRetries: 0 };

  it("uses a confident primary and never calls the fallback", async () => {
    const primary = fakeProvider("openai", "p", [answer(0.9)]);
    const fallback = fakeProvider("anthropic", "f", [answer(0.99)]);
    const res = await routeAnswer(primary, fallback, QUESTION, base);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.fallbackUsed, false);
    assert.equal(fallback.calls, 0);
  });

  it("escalates an unsure primary to the fallback", async () => {
    const primary = fakeProvider("openai", "p", [answer(0.4, "A")]);
    const fallback = fakeProvider("anthropic", "f", [answer(0.95, "C")]);
    const res = await routeAnswer(primary, fallback, QUESTION, base);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.answer.selectedOption, "C");
    assert.equal(res.attempts.length, 2);
  });

  it("keeps the primary when the fallback is no more confident", async () => {
    const primary = fakeProvider("openai", "p", [answer(0.5, "A")]);
    const fallback = fakeProvider("anthropic", "f", [answer(0.5, "B")]);
    const res = await routeAnswer(primary, fallback, QUESTION, base);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.answer.selectedOption, "A");
  });

  it("submits an unsure answer when there is no fallback, and says so", async () => {
    const primary = fakeProvider("openai", "p", [answer(0.2)]);
    const res = await routeAnswer(primary, null, QUESTION, base);
    assert.equal(res.ok, true);
    if (res.ok) assert.match(res.decision, /no fallback model is configured/);
  });

  it("uses the fallback outright when the primary fails", async () => {
    const primary = fakeProvider("openai", "p", [failure("429 rate limited", true)]);
    const fallback = fakeProvider("anthropic", "f", [answer(0.3, "D")]);
    const res = await routeAnswer(primary, fallback, QUESTION, base);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // Not a tiebreak: a failed primary has no answer to weigh, so the
    // fallback's answer is used even below the threshold.
    assert.equal(res.answer.selectedOption, "D");
    assert.equal(res.fallbackUsed, true);
  });

  it("falls back to the primary's low-confidence answer when the fallback fails", async () => {
    const primary = fakeProvider("openai", "p", [answer(0.3, "B")]);
    const fallback = fakeProvider("anthropic", "f", [failure("500", true)]);
    const res = await routeAnswer(primary, fallback, QUESTION, base);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.answer.selectedOption, "B");
  });

  it("fails when both fail — no answer is better than an invented one", async () => {
    const primary = fakeProvider("openai", "p", [failure("nope", false)]);
    const fallback = fakeProvider("anthropic", "f", [failure("also nope", false)]);
    const res = await routeAnswer(primary, fallback, QUESTION, base);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /primary failed.*fallback failed/);
  });

  it("retries a retryable failure and stops on a permanent one", async () => {
    const retryable = fakeProvider("openai", "p", [failure("429", true), answer(0.9)]);
    const r1 = await routeAnswer(retryable, null, QUESTION, { ...base, maxRetries: 2 });
    assert.equal(r1.ok, true);
    assert.equal(retryable.calls, 2);

    const permanent = fakeProvider("openai", "p", [failure("401 bad key", false)]);
    const r2 = await routeAnswer(permanent, null, QUESTION, { ...base, maxRetries: 2 });
    assert.equal(r2.ok, false);
    assert.equal(permanent.calls, 1, "a bad key is not retried");
  });

  it("records every attempt, including the failures", async () => {
    const primary = fakeProvider("openai", "p", [failure("429", true), answer(0.2)]);
    const fallback = fakeProvider("anthropic", "f", [answer(0.9)]);
    const res = await routeAnswer(primary, fallback, QUESTION, { ...base, maxRetries: 1 });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.attempts.length, 3);
  });

  it("announces which model it is about to ask", async () => {
    const seen: string[] = [];
    const primary = fakeProvider("openai", "p", [answer(0.1)]);
    const fallback = fakeProvider("anthropic", "f", [answer(0.9)]);
    await routeAnswer(primary, fallback, QUESTION, {
      ...base,
      onAttemptStart: (_p, _m, which) => seen.push(which),
    });
    assert.deepEqual(seen, ["primary", "fallback"]);
  });
});

describe("ConcurrencyLimiter", () => {
  it("never runs more than the limit at once", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    assert.equal(peak, 2);
    assert.equal(active, 0);
  });

  it("releases its slot when the work throws", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await assert.rejects(limiter.run(async () => { throw new Error("x"); }));
    // Would hang forever if the slot leaked.
    assert.equal(await limiter.run(async () => "ok"), "ok");
  });
});

describe("assessment AI settings", () => {
  it("is off, with no fallback, out of the box", () => {
    const cfg = readAssessmentAIConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.fallback, null);
    assert.equal(cfg.confidenceThreshold, 0.7);
  });

  it("lets the fallback borrow the primary's key when it shares an account", () => {
    const cfg = readAssessmentAIConfig({
      ASSESSMENT_AI_API_KEY: "sk-primary",
      ASSESSMENT_AI_FALLBACK_ENABLED: "true",
      ASSESSMENT_AI_FALLBACK_API_KEY: "",
    });
    assert.equal(cfg.fallback?.apiKey, "sk-primary");
  });

  it("clamps values rather than trusting them", () => {
    const cfg = readAssessmentAIConfig({
      ASSESSMENT_AI_CONFIDENCE_THRESHOLD: "5",
      ASSESSMENT_AI_TIMEOUT_MS: "1",
      ASSESSMENT_AI_MAX_RETRIES: "99",
      ASSESSMENT_AI_TEMPERATURE: "-3",
    });
    assert.equal(cfg.confidenceThreshold, 1);
    assert.equal(cfg.timeoutMs, 1000);
    assert.equal(cfg.maxRetries, 5);
    assert.equal(cfg.primary.temperature, 0);
  });

  it("caps browser concurrency separately from AI concurrency", () => {
    assert.equal(readAssessmentBrowserConcurrency({ ASSESSMENT_BROWSER_CONCURRENCY: "999" }), 50);
    assert.equal(readAssessmentAIConfig({ ASSESSMENT_AI_CONCURRENCY: "10" }).concurrency, 10);
  });

  it("says what is missing before a run rather than at the first question", () => {
    const off = aiConfigReadiness(readAssessmentAIConfig({}));
    assert.equal(off.ready, false);
    assert.ok(off.missing.some((m) => /switched off/.test(m)));

    const noKey = aiConfigReadiness(readAssessmentAIConfig({ ASSESSMENT_AI_ENABLED: "true" }));
    assert.ok(noKey.missing.some((m) => /API key/.test(m)));

    const ready = aiConfigReadiness(
      readAssessmentAIConfig({ ASSESSMENT_AI_ENABLED: "true", ASSESSMENT_AI_API_KEY: "sk-x" }),
    );
    assert.equal(ready.ready, true);
  });

  it("asks a local/compatible endpoint for a base URL instead of a key", () => {
    const missing = aiConfigReadiness(
      readAssessmentAIConfig({ ASSESSMENT_AI_ENABLED: "true", ASSESSMENT_AI_PROVIDER: "openai_compatible" }),
    );
    assert.ok(missing.missing.some((m) => /base URL/.test(m)));

    const ok = aiConfigReadiness(
      readAssessmentAIConfig({
        ASSESSMENT_AI_ENABLED: "true",
        ASSESSMENT_AI_PROVIDER: "openai_compatible",
        ASSESSMENT_AI_BASE_URL: "http://localhost:11434/v1",
      }),
    );
    assert.equal(ok.ready, true);
  });
});
