/**
 * The AI provider seam.
 *
 * One interface, three implementations, and — importantly — nothing above
 * this line knows which one is in use. The quiz engine asks a provider to
 * answer a question and gets a validated answer or an error; it never
 * builds a request body, never reads an API key, and never has a vendor
 * name in it. Changing provider is a Settings change.
 *
 * A provider's whole job is: take a question payload, ask a model, hand
 * back a structurally valid answer. It does not see the page, the browser,
 * the user, or their credentials.
 */

import type { AIModelConfig, AIProviderId } from "./aiConfig.js";
import { parseAIAnswer, type AIAnswer } from "./aiAnswer.js";
import {
  QUESTION_SYSTEM_PROMPT,
  buildQuestionPrompt,
  type ExtractedQuestion,
} from "./questionPayload.js";

export interface AIAttempt {
  provider: AIProviderId;
  model: string;
  latencyMs: number;
}

export type AIProviderResponse =
  | { ok: true; answer: AIAnswer; attempt: AIAttempt }
  | { ok: false; error: string; attempt: AIAttempt; retryable: boolean };

export interface AIProvider {
  readonly id: AIProviderId;
  readonly model: string;
  answerQuestion(question: ExtractedQuestion, signal?: AbortSignal): Promise<AIProviderResponse>;
}

/** HTTP statuses worth trying again: rate limits, and the server saying it
 * had a bad moment. A 400 or a 401 is a configuration mistake and retrying
 * it just makes the same mistake three times. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

interface ChatResult {
  text: string;
  retryable: boolean;
  error?: string;
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A Stop from the dashboard has to cut an in-flight AI call too, or a
  // stopped session sits there for the rest of the provider's timeout.
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/**
 * OpenAI's chat completions, and everything that speaks the same shape.
 *
 * `openai_compatible` is the same code with a different base URL — which is
 * the entire reason a local model is a configuration change later rather
 * than a provider that still has to be written.
 */
class OpenAIStyleProvider implements AIProvider {
  constructor(
    readonly id: AIProviderId,
    private readonly config: AIModelConfig,
    private readonly timeoutMs: number,
  ) {}

  get model(): string {
    return this.config.model;
  }

  private endpoint(): string {
    const base = (this.config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }

  private async chat(prompt: string, signal?: AbortSignal): Promise<ChatResult> {
    const res = await withTimeout(
      (s) =>
        fetch(this.endpoint(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            temperature: this.config.temperature,
            messages: [
              { role: "system", content: QUESTION_SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
            response_format: { type: "json_object" },
          }),
          signal: s,
        }),
      this.timeoutMs,
      signal,
    );

    if (!res.ok) {
      // The body often names the real problem ("model not found"), and that
      // sentence is worth far more in the log than the status alone. It is
      // provider output about our own request, never question content.
      const body = await res.text().catch(() => "");
      return {
        text: "",
        retryable: isRetryableStatus(res.status),
        error: `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`,
      };
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "";
    return { text, retryable: false };
  }

  async answerQuestion(question: ExtractedQuestion, signal?: AbortSignal): Promise<AIProviderResponse> {
    return runAttempt(this.id, this.config.model, question, (p, s) => this.chat(p, s), signal);
  }
}

/** Anthropic's messages API. Same contract, different envelope. */
class AnthropicProvider implements AIProvider {
  readonly id: AIProviderId = "anthropic";

  constructor(
    private readonly config: AIModelConfig,
    private readonly timeoutMs: number,
  ) {}

  get model(): string {
    return this.config.model;
  }

  private endpoint(): string {
    const base = (this.config.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
    return `${base}/messages`;
  }

  private async chat(prompt: string, signal?: AbortSignal): Promise<ChatResult> {
    const res = await withTimeout(
      (s) =>
        fetch(this.endpoint(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: 512,
            temperature: this.config.temperature,
            system: QUESTION_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: s,
        }),
      this.timeoutMs,
      signal,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        text: "",
        retryable: isRetryableStatus(res.status),
        error: `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`,
      };
    }

    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return { text, retryable: false };
  }

  async answerQuestion(question: ExtractedQuestion, signal?: AbortSignal): Promise<AIProviderResponse> {
    return runAttempt(this.id, this.config.model, question, (p, s) => this.chat(p, s), signal);
  }
}

/**
 * The part every provider shares: build the prompt, time the call, and
 * validate what comes back against the options that were actually offered.
 *
 * A reply that fails validation is marked retryable — a model that returned
 * prose once will often return JSON on a second ask, and that is cheaper
 * than escalating to the fallback.
 */
async function runAttempt(
  id: AIProviderId,
  model: string,
  question: ExtractedQuestion,
  chat: (prompt: string, signal?: AbortSignal) => Promise<ChatResult>,
  signal?: AbortSignal,
): Promise<AIProviderResponse> {
  const started = Date.now();
  const attempt = (): AIAttempt => ({ provider: id, model, latencyMs: Date.now() - started });

  let result: ChatResult;
  try {
    result = await chat(buildQuestionPrompt(question), signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = /abort/i.test(message);
    return {
      ok: false,
      error: aborted ? "the AI request timed out or was cancelled" : message,
      attempt: attempt(),
      retryable: !aborted,
    };
  }

  if (result.error) {
    return { ok: false, error: result.error, attempt: attempt(), retryable: result.retryable };
  }

  const parsed = parseAIAnswer(result.text, question.options);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, attempt: attempt(), retryable: true };
  }
  return { ok: true, answer: parsed.answer, attempt: attempt() };
}

/** Builds a provider from one half of the Settings config. The engine calls
 * this and then only ever talks through AIProvider. */
export function createProvider(config: AIModelConfig, timeoutMs: number): AIProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config, timeoutMs);
    case "openai":
    case "openai_compatible":
      return new OpenAIStyleProvider(config.provider, config, timeoutMs);
  }
}
