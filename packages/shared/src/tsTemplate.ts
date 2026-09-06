/**
 * TypeScript templates — stored and checked now, executed later.
 *
 * The ask is a template format that can express loops, conditions and
 * custom portal logic. The honest answer for this phase is that a platform
 * which accepts arbitrary TypeScript from a web form and runs it inside the
 * worker is a remote code execution feature, not a template feature: the
 * worker holds the browser profiles, the proxy credentials and a Postgres
 * connection, so `eval` there hands all three to whoever can reach the
 * dashboard.
 *
 * So this module does the half that is safe and useful today — accept the
 * source, check its shape, keep it versioned alongside the other formats —
 * and names exactly what has to exist before the other half can be turned
 * on. Attempting to run one produces the message below rather than a
 * mystery, and `TS_TEMPLATE_RUNTIME_REQUIREMENTS` is the checklist.
 *
 * The seam is deliberate: a TypeScript template already compiles to the
 * same normalized workflow the other two formats do (it is expected to
 * export a function returning WorkflowStep[]), so switching execution on
 * later adds a sandbox — it does not add a second executor.
 */

export const TS_TEMPLATE_ENTRYPOINT = "buildWorkflow";

/** Said in one sentence wherever an unrunnable template is reached. */
export const TS_TEMPLATE_NOT_EXECUTABLE =
  "TypeScript templates can be written and saved, but this build cannot execute one yet — " +
  "running untrusted TypeScript needs an isolated runtime, which is not part of this phase. " +
  "Use a Plain-English or JSON template for anything that has to run.";

/** What has to be true before execution can be enabled, kept next to the
 * refusal so the two never drift apart. */
export const TS_TEMPLATE_RUNTIME_REQUIREMENTS = [
  "an out-of-process isolate with no filesystem, network or env access of its own",
  "a wall-clock and memory budget enforced by the host, not by the script",
  "an explicit, narrow API surface handed in (no raw Page, no db pool, no process)",
  "the script returns a workflow to run; the host drives Playwright, never the script",
] as const;

export interface TsTemplateIssue {
  line: number;
  message: string;
}

export type TsTemplateResult = { ok: true } | { ok: false; issues: TsTemplateIssue[] };

/**
 * Constructs that must not appear in a stored template.
 *
 * This is NOT a security boundary — a determined author gets around any
 * source scan, which is exactly why execution stays off until there is a
 * real isolate. It is a correctness check with a second benefit: a template
 * written against `require`, `process.env` or the filesystem is written
 * against a runtime it will never get, and saying so at save time is far
 * kinder than discovering it the day the sandbox ships.
 */
const FORBIDDEN: { re: RegExp; message: string }[] = [
  { re: /\brequire\s*\(/, message: "require() is not available — a template returns a workflow, it does not load modules" },
  { re: /\bimport\s*\(/, message: "dynamic import() is not available in a template" },
  { re: /^\s*import\s+/m, message: "imports are not available — everything a template needs is passed in" },
  { re: /\bprocess\s*\./, message: "process is not available to a template (no env, no exit, no cwd)" },
  { re: /\beval\s*\(/, message: "eval() is not allowed in a template" },
  { re: /\bnew\s+Function\s*\(/, message: "new Function() is not allowed in a template" },
  { re: /\bglobalThis\b/, message: "globalThis is not available to a template" },
  { re: /\bfetch\s*\(/, message: "a template cannot make network calls of its own" },
  { re: /\bchildProcess\b|\bchild_process\b/, message: "spawning processes is not available to a template" },
];

const MAX_SOURCE_CHARS = 64 * 1024;

/**
 * Checks a TypeScript template's source well enough to store it.
 *
 * Deliberately not a compile: pulling the TypeScript compiler into the API
 * to typecheck a template that this build will not run would be a large
 * dependency bought for nothing. What is checked is what actually matters
 * now — that it is not empty, that it declares the entrypoint the future
 * runtime will call, that its braces balance (the cheap way to catch a
 * truncated paste), and that it is not written against a runtime it will
 * never be given.
 */
export function validateTsTemplate(source: string): TsTemplateResult {
  const issues: TsTemplateIssue[] = [];
  const text = source ?? "";

  if (text.trim().length === 0) {
    return { ok: false, issues: [{ line: 1, message: "the template is empty" }] };
  }
  if (text.length > MAX_SOURCE_CHARS) {
    issues.push({ line: 1, message: `template is longer than ${MAX_SOURCE_CHARS / 1024}K characters` });
  }

  if (!new RegExp(`\\b${TS_TEMPLATE_ENTRYPOINT}\\b`).test(text)) {
    issues.push({
      line: 1,
      message: `a TypeScript template must define \`${TS_TEMPLATE_ENTRYPOINT}\` — the function the runtime calls to get the workflow`,
    });
  }

  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // Skip whole-line comments so a note *about* one of these doesn't fail
    // the save; anything cleverer here belongs to the real sandbox.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) issues.push({ line: i + 1, message: rule.message });
    }
  });

  const balance = countUnbalanced(text);
  if (balance !== 0) {
    issues.push({
      line: lines.length,
      message: balance > 0 ? `${balance} unclosed "{"` : `${-balance} unmatched "}"`,
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** Braces outside strings, template literals and comments. Enough to catch
 * a half-pasted file, which is the mistake this is here for. */
function countUnbalanced(text: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle || inDouble || inBacktick) {
      if (c === "\\") i++;
      else if (inSingle && c === "'") inSingle = false;
      else if (inDouble && c === '"') inDouble = false;
      else if (inBacktick && c === "`") inBacktick = false;
      continue;
    }

    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "`") inBacktick = true;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

export function formatTsIssues(issues: TsTemplateIssue[]): string {
  return issues.map((i) => `line ${i.line}: ${i.message}`).join("; ");
}

/** The starting point a new TypeScript template is created with, so the
 * required shape is shown rather than described. */
export const TS_TEMPLATE_STARTER = `// A TypeScript template returns a workflow; the host runs it.
// Nothing here touches the browser directly — that stays with Playwright.
//
// row carries this user's values: name, email, url, and any CSV column.

export function ${TS_TEMPLATE_ENTRYPOINT}(row: Record<string, string>) {
  const steps = [
    { type: "navigate", url: row.url },
  ];

  // Loops and conditions are the reason to reach for this format:
  for (const section of ["Overview", "Details"]) {
    steps.push({ type: "click", target: section, optional: true });
  }

  return steps;
}
`;
