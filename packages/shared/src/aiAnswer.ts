/**
 * Validating what a model sends back.
 *
 * The rule this file exists to enforce: nothing gets clicked because
 * parsing sort of worked. A model reply is untrusted input in the ordinary
 * sense — it is text from a remote service — and it decides which button a
 * real person's assessment gets. So it is parsed strictly, checked against
 * the option ids that were actually extracted, and rejected outright if it
 * doesn't fit. A rejected answer is a retry, a fallback, or a recorded
 * failure. It is never a guess.
 */

import { optionIndexForId, type QuestionOption } from "./questionPayload.js";

export interface AIAnswer {
  /** One of the option ids that were sent. Guaranteed by validation. */
  selectedOption: string;
  /** 0–1. Treated as a routing signal, NOT as a calibrated probability —
   * see aiRouter.ts. */
  confidence: number;
  reason: string;
}

export type AIAnswerResult = { ok: true; answer: AIAnswer } | { ok: false; error: string };

/**
 * Pulls the JSON object out of a reply.
 *
 * Models wrap JSON in code fences and preface it with a sentence often
 * enough that refusing those outright would fail runs over formatting
 * rather than over reasoning. What is NOT tolerated is ambiguity about
 * which object is the answer: the first balanced `{…}` is taken, and if
 * that doesn't parse, the reply is rejected rather than scanned for
 * something that might.
 */
export function extractJsonObject(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;

  const start = body.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

const MAX_REASON_CHARS = 400;

/**
 * Validates a model reply against the options that were actually offered.
 *
 * `options` is required, not optional: "is this a well-formed answer" and
 * "is this one of the choices" are the same question here, and separating
 * them is how an answer of "E" to a four-option question gets as far as a
 * click.
 */
export function parseAIAnswer(rawText: string, options: QuestionOption[]): AIAnswerResult {
  const json = extractJsonObject(rawText);
  if (!json) {
    return { ok: false, error: "the model did not return a JSON object" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `the model's JSON did not parse — ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "the model returned something other than a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  const rawSelected = obj.selectedOption ?? obj.selected_option ?? obj.answer ?? obj.option;
  if (rawSelected === undefined || rawSelected === null || rawSelected === "") {
    return { ok: false, error: '"selectedOption" is missing from the model\'s reply' };
  }
  const selectedRaw = String(rawSelected).trim();

  // The id has to name a real option. This is the check that stands between
  // a hallucinated "E" and a click on whatever happens to be fourth.
  const index = optionIndexForId(selectedRaw, options.length);
  if (index < 0) {
    return {
      ok: false,
      error: `the model chose "${selectedRaw}", which is not one of ${options.map((o) => o.id).join(", ")}`,
    };
  }
  const selectedOption = options[index].id;

  // A missing confidence is not a failure — several models simply don't
  // volunteer one, and refusing their answer over it would be refusing a
  // correct answer over a formatting habit. It routes as "no better than
  // the threshold", so an absent confidence sends the question to the
  // fallback rather than being trusted.
  let confidence = 0;
  const rawConfidence = obj.confidence ?? obj.certainty;
  if (rawConfidence !== undefined && rawConfidence !== null && rawConfidence !== "") {
    const n = Number(rawConfidence);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `"confidence" was "${String(rawConfidence)}", which is not a number` };
    }
    // Some models answer 0–100 despite being asked for 0–1.
    confidence = n > 1 && n <= 100 ? n / 100 : n;
    if (confidence < 0 || confidence > 1) {
      return { ok: false, error: `"confidence" was ${n}, which is outside 0–1` };
    }
  }

  const reason = String(obj.reason ?? obj.explanation ?? "").trim().slice(0, MAX_REASON_CHARS);

  return { ok: true, answer: { selectedOption, confidence, reason } };
}
