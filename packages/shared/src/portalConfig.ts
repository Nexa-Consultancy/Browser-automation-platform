/**
 * What the quiz engine needs to know about one assessment portal.
 *
 * ============================================================
 * THIS IS THE FILE THAT ANSWERS "where do the selectors go".
 * ============================================================
 *
 * The target portal has not been supplied yet, so nothing here contains a
 * selector — inventing one would be worse than useless: it would look
 * configured, and fail at 2 AM against a page nobody had ever pointed it
 * at. Instead this is the *shape* of that answer. When the portal's real
 * markup arrives, filling in one of these (through the Quiz template editor
 * in the dashboard, or as JSON on the template row) is the whole
 * integration — no engine change, no worker change, no deploy.
 *
 * Every field is one of:
 *   - a Playwright-compatible selector string (`.quiz-card`, `#next`), or
 *   - the same plain-text form the rest of the platform accepts, which the
 *     existing resolver turns into its usual role/label/text waterfall.
 *
 * That is deliberate: the engine resolves these through exactly the same
 * locators.ts the step executor uses, so a portal config gains every
 * robustness fix that path ever gets, for free.
 */

/** Every question type the schema can describe. Phase 1 implements
 * single_choice only — the rest are here so adding one later is a new
 * branch in the extractor rather than a change to the stored shape. */
export type QuestionType =
  | "single_choice"
  | "multiple_choice"
  | "true_false"
  | "dropdown"
  | "text"
  | "matching"
  | "ordering";

export const QUESTION_TYPES: QuestionType[] = [
  "single_choice",
  "multiple_choice",
  "true_false",
  "dropdown",
  "text",
  "matching",
  "ordering",
];

/** What Phase 1 can actually answer. Anything else is recorded and skipped
 * rather than guessed at. */
export const SUPPORTED_QUESTION_TYPES: QuestionType[] = ["single_choice"];

export function isQuestionType(v: unknown): v is QuestionType {
  return typeof v === "string" && (QUESTION_TYPES as string[]).includes(v);
}

/**
 * How the portal says a quiz is already done.
 *
 * Two independent signals, either of which is enough, because portals split
 * roughly into these two camps: some render a status word on the card
 * ("Submitted", "Completed", "100%"), others render a different control
 * (no "Start", a "View result" link, a disabled card). Both are optional;
 * a portal that offers neither simply falls back to our own database, and
 * the engine says so in the run log rather than pretending it checked.
 */
export interface QuizCompletionRules {
  /** Selector for the status text on a quiz card, relative to the card. */
  statusSelector?: string;
  /** Status texts that mean "already submitted", compared case-insensitively
   * as substrings, e.g. ["submitted", "completed", "passed"]. */
  completedText?: string[];
  /** Status texts that explicitly mean "not done yet". Checked first, so a
   * portal whose card reads "Not completed" isn't matched by "completed". */
  pendingText?: string[];
  /** A selector that, when present inside the card, means done — e.g. a
   * "View result" link that only completed quizzes have. */
  completedMarkerSelector?: string;
}

/**
 * Where the questions live once a quiz is open.
 *
 * `optionsSelector` must match the option *rows* — one element per choice,
 * in the order shown. The engine numbers them A, B, C… itself and clicks by
 * position, which is the whole reason the AI is asked for a letter rather
 * than for text: no text matching, no near-miss, no clicking the wrong row
 * because two options share a prefix.
 */
export interface QuizQuestionRules {
  /** The question text for the current question. */
  questionSelector?: string;
  /** Optional: the "Question 3 of 10" counter, used only for logging and
   * for knowing when to expect Submit instead of Next. */
  progressSelector?: string;
  /** One element per answer choice, in display order. */
  optionsSelector?: string;
  /** Optional: the label inside an option row, when the row itself carries
   * extra chrome whose text would pollute the option. */
  optionTextSelector?: string;
  /** Optional: how to tell an option is already selected — a class, an
   * attribute, or a nested input. Used to VERIFY a click landed rather than
   * to find the option. */
  selectedOptionSelector?: string;
  /** Optional: what the engine clicks inside an option row (a radio input,
   * say) when clicking the row itself does nothing. */
  optionClickSelector?: string;
  /** Defaults to single_choice. */
  questionType?: QuestionType;
}

export interface AssessmentPortalConfig {
  /** Optional: navigated to before the quiz list is looked for, when the
   * navigation workflow doesn't already end there. */
  assessmentUrl?: string;

  // ---------- the quiz list ----------
  /** The container holding the quiz cards. */
  quizListSelector?: string;
  /** One element per quiz, inside the list. */
  quizCardSelector?: string;
  /** The quiz's title, relative to the card. */
  quizNameSelector?: string;
  /** A stable per-quiz id on the card — a data attribute or an href — used
   * to match a portal quiz to our stored record across runs. Falls back to
   * the name when absent, which is why it is worth filling in. */
  quizIdAttribute?: string;
  /** What is clicked to open a quiz, relative to the card. Defaults to the
   * card itself. */
  quizOpenSelector?: string;

  completion?: QuizCompletionRules;
  question?: QuizQuestionRules;

  // ---------- moving through a quiz ----------
  nextSelector?: string;
  submitSelector?: string;
  /** Optional confirmation dialog's confirm control, for portals that ask
   * "are you sure?" after Submit. */
  confirmSubmitSelector?: string;

  // ---------- the result ----------
  /** Something that only exists once a quiz is finished — this is what the
   * engine waits for, and what it re-checks before ever considering a
   * retry, so a crash after submitting cannot cause a second submission. */
  resultSelector?: string;
  scoreSelector?: string;
  /** How to get back to the list for the next quiz. Defaults to going back
   * to assessmentUrl. */
  backToListSelector?: string;

  /** How long to wait for the result state after submitting, ms. */
  resultTimeoutMs?: number;
}

/** Every configurable point, in the order the run uses them — the dashboard
 * renders the editor from this, so a new field shows up there by adding it
 * here and nowhere else. */
export const PORTAL_CONFIG_FIELDS: {
  path: string;
  label: string;
  hint: string;
}[] = [
  { path: "assessmentUrl", label: "Assessment URL", hint: "Opened before looking for the quiz list. Leave blank if the login workflow already lands there." },
  { path: "quizListSelector", label: "Quiz list", hint: "The container that holds the quiz cards." },
  { path: "quizCardSelector", label: "Quiz card", hint: "One element per quiz, inside the list." },
  { path: "quizNameSelector", label: "Quiz name", hint: "The quiz's title, relative to the card." },
  { path: "quizIdAttribute", label: "Quiz id attribute", hint: "A stable per-quiz attribute (e.g. data-quiz-id) used to match the portal's quiz to our record." },
  { path: "quizOpenSelector", label: "Open quiz", hint: "Clicked to open a quiz. Defaults to the card itself." },
  { path: "completion.statusSelector", label: "Quiz status", hint: "Where the card shows Submitted / Pending." },
  { path: "completion.completedText", label: "Status means completed", hint: "Comma-separated words that mean already submitted." },
  { path: "completion.pendingText", label: "Status means pending", hint: "Comma-separated words that mean not done yet. Checked first." },
  { path: "completion.completedMarkerSelector", label: "Completed marker", hint: "A selector only completed cards have (e.g. a View result link)." },
  { path: "question.questionSelector", label: "Question", hint: "The current question's text." },
  { path: "question.progressSelector", label: "Progress", hint: "Optional 'Question 3 of 10' counter." },
  { path: "question.optionsSelector", label: "Options", hint: "One element per answer choice, in display order." },
  { path: "question.optionTextSelector", label: "Option text", hint: "Optional label inside an option row." },
  { path: "question.optionClickSelector", label: "Option click target", hint: "Optional control inside the row to click (e.g. the radio input)." },
  { path: "question.selectedOptionSelector", label: "Selected option", hint: "How a chosen option looks, used to verify the click landed." },
  { path: "nextSelector", label: "Next", hint: "Moves to the next question." },
  { path: "submitSelector", label: "Submit", hint: "Submits the quiz." },
  { path: "confirmSubmitSelector", label: "Confirm submit", hint: "Optional confirmation control shown after Submit." },
  { path: "resultSelector", label: "Result", hint: "Only present once a quiz is finished — also what makes a retry safe." },
  { path: "scoreSelector", label: "Score", hint: "Where the score is shown, if the portal shows one." },
  { path: "backToListSelector", label: "Back to list", hint: "Returns to the quiz list. Defaults to re-opening the assessment URL." },
];

export interface PortalConfigProblem {
  path: string;
  message: string;
}

/**
 * The fields without which the engine cannot run at all.
 *
 * Kept separate from validation so a partially-filled config can still be
 * SAVED — half a config is a normal state while someone is working one out
 * — and is refused only at the point a run would need it.
 *
 * `resultSelector` is on this list for a reason that is easy to miss: it is
 * not just where the score is read, it is the ONLY way to ask the portal
 * "is this already submitted?". Without it a submission can never be
 * confirmed, so every quiz would either fail after submitting or, worse, be
 * a candidate for a blind retry. The whole idempotency story rests on it.
 */
export const REQUIRED_PORTAL_FIELDS = [
  "quizCardSelector",
  "question.questionSelector",
  "question.optionsSelector",
  "submitSelector",
  "resultSelector",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  problems: PortalConfigProblem[],
): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") {
    problems.push({ path, message: "must be a string" });
    return undefined;
  }
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function optionalStringList(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  problems: PortalConfigProblem[],
): string[] | undefined {
  const v = raw[key];
  if (v === undefined || v === null || v === "") return undefined;
  // A comma-separated string is accepted because that is what a single-line
  // text input in the editor produces, and making the UI do the splitting
  // would just put the same rule in two places.
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!list) {
    problems.push({ path, message: "must be a list of words, or a comma-separated string" });
    return undefined;
  }
  const cleaned = list.map((s) => String(s ?? "").trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Normalizes a stored/posted portal config.
 *
 * Never rejects for incompleteness — see REQUIRED_PORTAL_FIELDS above. It
 * rejects only things that are the wrong *kind* of value, which is a typo
 * worth catching at save time.
 */
export function parsePortalConfig(
  raw: unknown,
): { ok: true; config: AssessmentPortalConfig } | { ok: false; problems: PortalConfigProblem[] } {
  if (raw === null || raw === undefined) return { ok: true, config: {} };
  if (!isRecord(raw)) {
    return { ok: false, problems: [{ path: "$", message: "the assessment config must be an object" }] };
  }

  const problems: PortalConfigProblem[] = [];
  const config: AssessmentPortalConfig = {};

  const top: [keyof AssessmentPortalConfig, string][] = [
    ["assessmentUrl", "assessmentUrl"],
    ["quizListSelector", "quizListSelector"],
    ["quizCardSelector", "quizCardSelector"],
    ["quizNameSelector", "quizNameSelector"],
    ["quizIdAttribute", "quizIdAttribute"],
    ["quizOpenSelector", "quizOpenSelector"],
    ["nextSelector", "nextSelector"],
    ["submitSelector", "submitSelector"],
    ["confirmSubmitSelector", "confirmSubmitSelector"],
    ["resultSelector", "resultSelector"],
    ["scoreSelector", "scoreSelector"],
    ["backToListSelector", "backToListSelector"],
  ];
  for (const [key, path] of top) {
    const v = optionalString(raw, path, path, problems);
    if (v !== undefined) (config as Record<string, unknown>)[key] = v;
  }

  if (raw.resultTimeoutMs !== undefined && raw.resultTimeoutMs !== null && raw.resultTimeoutMs !== "") {
    const n = Number(raw.resultTimeoutMs);
    if (!Number.isFinite(n) || n < 1000 || n > 600_000) {
      problems.push({ path: "resultTimeoutMs", message: "must be between 1000 and 600000 milliseconds" });
    } else {
      config.resultTimeoutMs = Math.trunc(n);
    }
  }

  if (raw.completion !== undefined && raw.completion !== null) {
    if (!isRecord(raw.completion)) {
      problems.push({ path: "completion", message: "must be an object" });
    } else {
      const c: QuizCompletionRules = {};
      const statusSelector = optionalString(raw.completion, "statusSelector", "completion.statusSelector", problems);
      if (statusSelector) c.statusSelector = statusSelector;
      const marker = optionalString(
        raw.completion,
        "completedMarkerSelector",
        "completion.completedMarkerSelector",
        problems,
      );
      if (marker) c.completedMarkerSelector = marker;
      const done = optionalStringList(raw.completion, "completedText", "completion.completedText", problems);
      if (done) c.completedText = done;
      const pending = optionalStringList(raw.completion, "pendingText", "completion.pendingText", problems);
      if (pending) c.pendingText = pending;
      if (Object.keys(c).length > 0) config.completion = c;
    }
  }

  if (raw.question !== undefined && raw.question !== null) {
    if (!isRecord(raw.question)) {
      problems.push({ path: "question", message: "must be an object" });
    } else {
      const q: QuizQuestionRules = {};
      for (const key of [
        "questionSelector",
        "progressSelector",
        "optionsSelector",
        "optionTextSelector",
        "selectedOptionSelector",
        "optionClickSelector",
      ] as const) {
        const v = optionalString(raw.question, key, `question.${key}`, problems);
        if (v) q[key] = v;
      }
      const qt = raw.question.questionType;
      if (qt !== undefined && qt !== null && qt !== "") {
        if (!isQuestionType(qt)) {
          problems.push({ path: "question.questionType", message: `unknown question type "${String(qt)}"` });
        } else if (!SUPPORTED_QUESTION_TYPES.includes(qt)) {
          problems.push({
            path: "question.questionType",
            message: `"${qt}" is described by the schema but not answered yet — this phase supports ${SUPPORTED_QUESTION_TYPES.join(", ")}`,
          });
        } else {
          q.questionType = qt;
        }
      }
      if (Object.keys(q).length > 0) config.question = q;
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config };
}

/** Reads a dotted path out of a config, for the editor and for the
 * readiness check. */
export function portalConfigValue(config: AssessmentPortalConfig, path: string): string {
  const parts = path.split(".");
  let cur: unknown = config;
  for (const p of parts) {
    if (!isRecord(cur)) return "";
    cur = cur[p];
  }
  if (cur === undefined || cur === null) return "";
  return Array.isArray(cur) ? cur.join(", ") : String(cur);
}

/**
 * Whether this config can drive a run yet, and what is missing if not.
 *
 * Checked by the API before an assessment run is allowed to start, so an
 * unconfigured portal fails at the button with a list of field names rather
 * than as a timeout inside a browser twenty minutes later.
 */
export function portalConfigReadiness(config: AssessmentPortalConfig): { ready: boolean; missing: string[] } {
  const missing = REQUIRED_PORTAL_FIELDS.filter((p) => portalConfigValue(config, p) === "");
  return { ready: missing.length === 0, missing: [...missing] };
}

export function formatPortalProblems(problems: PortalConfigProblem[]): string {
  return problems.map((p) => (p.path === "$" ? p.message : `${p.path}: ${p.message}`)).join("; ");
}
