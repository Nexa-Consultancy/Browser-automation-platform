/**
 * Assessment AI configuration, read out of the existing settings table.
 *
 * No new table: proxy credentials and SMTP credentials already live in
 * `settings` with a whitelist of known keys and a secret-redaction rule, and
 * an API key is the same kind of thing handled the same way. That also means
 * the worker reads its AI config exactly the way it already reads the proxy
 * — one mechanism, one place to look.
 */

export type AIProviderId = "openai" | "anthropic" | "openai_compatible";

export const AI_PROVIDER_IDS: AIProviderId[] = ["openai", "anthropic", "openai_compatible"];

export const AI_PROVIDER_LABELS: Record<AIProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  // The same wire format is spoken by every local runner worth using
  // (Ollama, vLLM, LM Studio, llama.cpp's server) as well as by most hosted
  // alternatives, so "future local LLM" is a base URL here, not a provider
  // that still has to be written.
  openai_compatible: "OpenAI-compatible endpoint (incl. local models)",
};

export function isAIProviderId(v: unknown): v is AIProviderId {
  return typeof v === "string" && (AI_PROVIDER_IDS as string[]).includes(v);
}

/** One end of the primary/fallback pair. */
export interface AIModelConfig {
  provider: AIProviderId;
  model: string;
  apiKey: string;
  /** Overrides the provider's default endpoint. Required for
   * openai_compatible, which is the whole point of it. */
  baseUrl: string;
  temperature: number;
}

export interface AssessmentAIConfig {
  enabled: boolean;
  primary: AIModelConfig;
  /** Null when no fallback model is configured — routing then accepts the
   * primary's answer whatever its confidence, and says so in the log. */
  fallback: AIModelConfig | null;
  /** Below this, the primary's answer goes to the fallback. */
  confidenceThreshold: number;
  /** Attempts per model for a transient failure (network, 429, malformed
   * reply). Not attempts at the quiz. */
  maxRetries: number;
  timeoutMs: number;
  /** How many questions may be in flight with a provider at once, across
   * all sessions on this worker. Separate from browser concurrency because
   * the two limits have nothing to do with each other: ten browsers is a
   * memory question, ten AI calls is a rate-limit question. */
  concurrency: number;
  /** Whether the model's stated reason is stored with the question log.
   * Off is a legitimate choice — it is generated text about the contents of
   * an assessment. */
  storeReasons: boolean;
}

/** The setting keys, with their defaults, merged into SETTING_DEFAULTS by
 * packages/db/src/settings.ts. Kept here so the shape and its reader live
 * together. */
export const ASSESSMENT_AI_SETTING_DEFAULTS: Record<string, string> = {
  ASSESSMENT_AI_ENABLED: "false",
  ASSESSMENT_AI_PROVIDER: "openai",
  ASSESSMENT_AI_MODEL: "gpt-4o-mini",
  ASSESSMENT_AI_API_KEY: "",
  ASSESSMENT_AI_BASE_URL: "",
  ASSESSMENT_AI_TEMPERATURE: "0",
  ASSESSMENT_AI_FALLBACK_ENABLED: "false",
  ASSESSMENT_AI_FALLBACK_PROVIDER: "anthropic",
  ASSESSMENT_AI_FALLBACK_MODEL: "claude-sonnet-5",
  ASSESSMENT_AI_FALLBACK_API_KEY: "",
  ASSESSMENT_AI_FALLBACK_BASE_URL: "",
  ASSESSMENT_AI_FALLBACK_TEMPERATURE: "0",
  ASSESSMENT_AI_CONFIDENCE_THRESHOLD: "0.7",
  ASSESSMENT_AI_MAX_RETRIES: "2",
  ASSESSMENT_AI_TIMEOUT_MS: "30000",
  ASSESSMENT_AI_CONCURRENCY: "4",
  ASSESSMENT_AI_STORE_REASONS: "true",
  /** How many assessment browsers one worker may drive at once. Deliberately
   * lower than the automation default: an assessment session is long-lived
   * and Chromium is the expensive part. */
  ASSESSMENT_BROWSER_CONCURRENCY: "4",
};

/** Keys that must never be sent to the browser — merged into SECRET_KEYS. */
export const ASSESSMENT_AI_SECRET_KEYS = ["ASSESSMENT_AI_API_KEY", "ASSESSMENT_AI_FALLBACK_API_KEY"];

function num(map: Record<string, string>, key: string, fallback: number): number {
  const n = Number(map[key]);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function readAssessmentAIConfig(settings: Record<string, string>): AssessmentAIConfig {
  const s = { ...ASSESSMENT_AI_SETTING_DEFAULTS, ...settings };

  const primary: AIModelConfig = {
    provider: isAIProviderId(s.ASSESSMENT_AI_PROVIDER) ? s.ASSESSMENT_AI_PROVIDER : "openai",
    model: (s.ASSESSMENT_AI_MODEL ?? "").trim(),
    apiKey: s.ASSESSMENT_AI_API_KEY ?? "",
    baseUrl: (s.ASSESSMENT_AI_BASE_URL ?? "").trim(),
    temperature: clamp(num(s, "ASSESSMENT_AI_TEMPERATURE", 0), 0, 2),
  };

  const fallback: AIModelConfig | null =
    s.ASSESSMENT_AI_FALLBACK_ENABLED === "true"
      ? {
          provider: isAIProviderId(s.ASSESSMENT_AI_FALLBACK_PROVIDER)
            ? s.ASSESSMENT_AI_FALLBACK_PROVIDER
            : "anthropic",
          model: (s.ASSESSMENT_AI_FALLBACK_MODEL ?? "").trim(),
          // A blank fallback key means "the same account as the primary",
          // which is the normal case when both models are the same vendor.
          apiKey: (s.ASSESSMENT_AI_FALLBACK_API_KEY ?? "") || primary.apiKey,
          baseUrl: (s.ASSESSMENT_AI_FALLBACK_BASE_URL ?? "").trim(),
          temperature: clamp(num(s, "ASSESSMENT_AI_FALLBACK_TEMPERATURE", 0), 0, 2),
        }
      : null;

  return {
    enabled: s.ASSESSMENT_AI_ENABLED === "true",
    primary,
    fallback,
    confidenceThreshold: clamp(num(s, "ASSESSMENT_AI_CONFIDENCE_THRESHOLD", 0.7), 0, 1),
    maxRetries: clamp(Math.trunc(num(s, "ASSESSMENT_AI_MAX_RETRIES", 2)), 0, 5),
    timeoutMs: clamp(Math.trunc(num(s, "ASSESSMENT_AI_TIMEOUT_MS", 30_000)), 1000, 300_000),
    concurrency: clamp(Math.trunc(num(s, "ASSESSMENT_AI_CONCURRENCY", 4)), 1, 64),
    storeReasons: s.ASSESSMENT_AI_STORE_REASONS !== "false",
  };
}

/** How many assessment browsers one worker drives at once — read straight
 * from settings so it can be changed without a redeploy, same as the step
 * timeout. */
export function readAssessmentBrowserConcurrency(settings: Record<string, string>): number {
  const s = { ...ASSESSMENT_AI_SETTING_DEFAULTS, ...settings };
  return clamp(Math.trunc(num(s, "ASSESSMENT_BROWSER_CONCURRENCY", 4)), 1, 50);
}

/**
 * Whether this config can actually answer a question, and what is missing.
 *
 * Checked before a run starts rather than at the first question: finding
 * out that no API key is set after twenty browsers have logged in is a
 * waste of everyone's afternoon.
 */
export function aiConfigReadiness(config: AssessmentAIConfig): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!config.enabled) missing.push("Assessment AI is switched off in Settings");
  if (!config.primary.model) missing.push("no primary model is set");
  if (config.primary.provider !== "openai_compatible" && !config.primary.apiKey) {
    missing.push("no API key is set for the primary provider");
  }
  if (config.primary.provider === "openai_compatible" && !config.primary.baseUrl) {
    missing.push("an OpenAI-compatible provider needs a base URL");
  }
  if (config.fallback) {
    if (!config.fallback.model) missing.push("the fallback is enabled but has no model");
    if (config.fallback.provider === "openai_compatible" && !config.fallback.baseUrl) {
      missing.push("the fallback's OpenAI-compatible provider needs a base URL");
    }
  }
  return { ready: missing.length === 0, missing };
}
