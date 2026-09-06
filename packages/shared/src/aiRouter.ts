/**
 * Which model's answer gets used.
 *
 * The routing rule is small — ask the primary, and if it isn't confident
 * enough ask the fallback and take the better answer — but it is the piece
 * with the most ways to be quietly wrong, so it lives here as a pure
 * function over two providers rather than inside the quiz loop.
 *
 * On confidence: a model's self-reported confidence is not a calibrated
 * probability and is not treated as one. It is used for exactly one thing —
 * deciding whether a second opinion is worth the money — and never as
 * evidence that an answer is right. That is also why a low-confidence
 * answer is still submitted when there is no fallback: the alternative is
 * leaving a question blank on the strength of a number that doesn't mean
 * what it looks like.
 */

import type { AIAnswer } from "./aiAnswer.js";
import type { AIAttempt, AIProvider } from "./aiProviders.js";
import type { ExtractedQuestion } from "./questionPayload.js";

export interface RoutedAnswer {
  answer: AIAnswer;
  /** The attempt whose answer is being used. */
  attempt: AIAttempt;
  fallbackUsed: boolean;
  /** Every attempt made, in order, including the failures — this is what
   * the question log records, so a run can be explained afterwards. */
  attempts: AIAttempt[];
  /** Why this answer rather than another, in one sentence, for the log. */
  decision: string;
}

export interface RoutingFailure {
  error: string;
  attempts: AIAttempt[];
}

export type RoutingResult = { ok: true } & RoutedAnswer | ({ ok: false } & RoutingFailure);

export interface RouterOptions {
  confidenceThreshold: number;
  /** Extra attempts per provider on a retryable failure. 0 means one try. */
  maxRetries: number;
  signal?: AbortSignal;
  /** Called before each provider attempt, so the engine can emit an
   * ai_request event without the router knowing what an event is. */
  onAttemptStart?: (provider: string, model: string, which: "primary" | "fallback") => void;
}

/**
 * Asks one provider, retrying only failures that a second identical call
 * could plausibly fix (a 429, a dropped connection, a reply that wasn't
 * JSON). A rejected option id counts: models reliably produce a valid one
 * on a re-ask, and the alternative is escalating over a formatting slip.
 */
async function ask(
  provider: AIProvider,
  question: ExtractedQuestion,
  maxRetries: number,
  signal: AbortSignal | undefined,
  attempts: AIAttempt[],
): Promise<{ ok: true; answer: AIAnswer; attempt: AIAttempt } | { ok: false; error: string }> {
  let lastError = "the provider returned no answer";
  for (let i = 0; i <= maxRetries; i++) {
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    const res = await provider.answerQuestion(question, signal);
    attempts.push(res.attempt);
    if (res.ok) return { ok: true, answer: res.answer, attempt: res.attempt };
    lastError = res.error;
    if (!res.retryable) break;
  }
  return { ok: false, error: lastError };
}

/**
 * Runs the primary/fallback decision for one question.
 *
 * The four outcomes, in the order they are checked:
 *   primary confident            -> use it, no second call
 *   primary unsure, no fallback  -> use it anyway, and say so
 *   primary unsure, fallback ok  -> use whichever is more confident
 *   primary failed               -> the fallback is the answer, not a tiebreak
 */
export async function routeAnswer(
  primary: AIProvider,
  fallback: AIProvider | null,
  question: ExtractedQuestion,
  opts: RouterOptions,
): Promise<RoutingResult> {
  const attempts: AIAttempt[] = [];
  const threshold = opts.confidenceThreshold;

  opts.onAttemptStart?.(primary.id, primary.model, "primary");
  const first = await ask(primary, question, opts.maxRetries, opts.signal, attempts);

  if (first.ok && first.answer.confidence >= threshold) {
    return {
      ok: true,
      answer: first.answer,
      attempt: first.attempt,
      fallbackUsed: false,
      attempts,
      decision: `primary answered with confidence ${first.answer.confidence.toFixed(2)} (threshold ${threshold})`,
    };
  }

  if (!fallback) {
    if (first.ok) {
      return {
        ok: true,
        answer: first.answer,
        attempt: first.attempt,
        fallbackUsed: false,
        attempts,
        decision:
          `primary answered with confidence ${first.answer.confidence.toFixed(2)}, below the ${threshold} threshold, ` +
          `but no fallback model is configured`,
      };
    }
    return { ok: false, error: `primary model failed: ${first.error}`, attempts };
  }

  opts.onAttemptStart?.(fallback.id, fallback.model, "fallback");
  const second = await ask(fallback, question, opts.maxRetries, opts.signal, attempts);

  if (!second.ok) {
    if (first.ok) {
      return {
        ok: true,
        answer: first.answer,
        attempt: first.attempt,
        fallbackUsed: false,
        attempts,
        decision: `fallback failed (${second.error}); using the primary's lower-confidence answer`,
      };
    }
    return { ok: false, error: `primary failed: ${first.error}; fallback failed: ${second.error}`, attempts };
  }

  if (!first.ok) {
    return {
      ok: true,
      answer: second.answer,
      attempt: second.attempt,
      fallbackUsed: true,
      attempts,
      decision: `primary failed (${first.error}); the fallback answered`,
    };
  }

  // Both answered. Take the more confident one — and on a tie keep the
  // primary, because a tie is not evidence and switching on one would just
  // make the choice depend on which model was configured second.
  if (second.answer.confidence > first.answer.confidence) {
    return {
      ok: true,
      answer: second.answer,
      attempt: second.attempt,
      fallbackUsed: true,
      attempts,
      decision:
        `primary was ${first.answer.confidence.toFixed(2)} (below ${threshold}); ` +
        `fallback was ${second.answer.confidence.toFixed(2)} and was used`,
    };
  }

  return {
    ok: true,
    answer: first.answer,
    attempt: first.attempt,
    fallbackUsed: false,
    attempts,
    decision:
      `primary was ${first.answer.confidence.toFixed(2)}, fallback was ${second.answer.confidence.toFixed(2)}; ` +
      `kept the primary's answer`,
  };
}

/**
 * A counting semaphore, used to cap how many questions are in flight with a
 * provider across every session on this worker.
 *
 * Separate from browser concurrency on purpose: ten browsers is a memory
 * question about this machine, ten AI calls is a rate-limit question about
 * someone else's. Tying them together means one of the two is always set to
 * the wrong number.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
