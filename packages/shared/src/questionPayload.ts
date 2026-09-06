/**
 * The contract between the browser and the model.
 *
 * Playwright reads the page and produces one of these. The model is given
 * this and nothing else — not the DOM, not a screenshot, not the session,
 * and never the user's credentials. It answers with an option id, and
 * Playwright clicks the element that id was assigned to.
 *
 * The identifiers are the point. Options are labelled A, B, C… by POSITION
 * at extraction time and the engine keeps the position→element mapping, so
 * "select C" is an array index, not a text search. Nothing the model
 * returns is ever matched against the page.
 */

import type { QuestionType } from "./portalConfig.js";

export interface QuestionOption {
  /** "A", "B", "C"… assigned by position when the page was read. */
  id: string;
  text: string;
}

export interface ExtractedQuestion {
  questionText: string;
  questionType: QuestionType;
  options: QuestionOption[];
  /** 1-based, for the log and for knowing when Submit is due. */
  questionNumber: number;
  /** When the portal publishes one ("Question 3 of 10"). */
  totalQuestions: number | null;
}

/** Position -> id. Twenty-six options is far beyond any real MCQ; past that
 * the ids become A1, A2… rather than colliding. */
export function optionIdForIndex(index: number): string {
  if (index < 26) return String.fromCharCode(65 + index);
  return `A${index - 25}`;
}

/** id -> position, or -1. The inverse of optionIdForIndex, and the only
 * sanctioned way to turn a model's answer into something clickable. */
export function optionIndexForId(id: string, optionCount: number): number {
  const key = (id ?? "").trim().toUpperCase();
  if (!key) return -1;

  const single = /^[A-Z]$/.exec(key);
  if (single) {
    const idx = key.charCodeAt(0) - 65;
    return idx < optionCount ? idx : -1;
  }
  const extended = /^A(\d+)$/.exec(key);
  if (extended) {
    const idx = Number(extended[1]) + 25;
    return idx < optionCount ? idx : -1;
  }
  // A model that answers "1" or "option 2" instead of a letter is answering
  // the right question in the wrong format; accepting a 1-based number is a
  // cheap, unambiguous kindness. Anything else is rejected — never guessed.
  const numeric = /^(?:OPTION\s*)?(\d+)$/.exec(key);
  if (numeric) {
    const idx = Number(numeric[1]) - 1;
    return idx >= 0 && idx < optionCount ? idx : -1;
  }
  return -1;
}

export interface QuestionProblem {
  message: string;
}

/**
 * Whether an extracted question is worth sending to a model.
 *
 * A page mid-render produces a question with no text, or four blank
 * options, and asking a model to choose between four empty strings gets a
 * confident answer to nothing. Catching it here turns that into a retry of
 * the extraction instead of a wrong answer submitted for a real person.
 */
export function validateExtractedQuestion(q: ExtractedQuestion): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];

  if (!q.questionText || q.questionText.trim().length === 0) {
    problems.push("the question text came back empty — the page may not have finished rendering");
  }
  if (!Array.isArray(q.options) || q.options.length < 2) {
    problems.push(`expected at least 2 answer options, found ${q.options?.length ?? 0}`);
  } else {
    const blank = q.options.filter((o) => !o.text || o.text.trim().length === 0).length;
    if (blank > 0) {
      problems.push(`${blank} of ${q.options.length} options have no text — check the option text selector`);
    }
    const ids = new Set(q.options.map((o) => o.id));
    if (ids.size !== q.options.length) problems.push("two options were given the same id");
  }
  if (!Number.isInteger(q.questionNumber) || q.questionNumber < 1) {
    problems.push("question number must be 1 or more");
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * The prompt the model sees.
 *
 * Kept in one place, and kept deliberately bare: the question, the options,
 * and the instruction to answer with one id. No page URL, no user name, no
 * cookies, no surrounding markup. Whatever else is on the page is not the
 * model's business, and sending it would be sending it somewhere else's
 * server.
 */
export function buildQuestionPrompt(q: ExtractedQuestion): string {
  const options = q.options.map((o) => `${o.id}. ${o.text}`).join("\n");
  return [
    "Answer the following multiple-choice question.",
    "",
    `Question: ${q.questionText}`,
    "",
    "Options:",
    options,
    "",
    'Reply with JSON only, in exactly this shape: {"selectedOption":"<id>","confidence":<0-1>,"reason":"<one short sentence>"}',
    `The id must be one of: ${q.options.map((o) => o.id).join(", ")}.`,
    "Confidence is how likely you think your answer is correct, from 0 to 1.",
  ].join("\n");
}

export const QUESTION_SYSTEM_PROMPT =
  "You answer multiple-choice questions. You reply with a single JSON object and nothing else — " +
  "no prose before it, no code fence around it.";
