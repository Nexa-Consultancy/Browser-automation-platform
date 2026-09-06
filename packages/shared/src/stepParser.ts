// Deterministic parser: turns an English instruction line into a typed
// ParsedStep the worker's stepExecutor can run with zero ambiguity. Every
// pattern below is a fixed grammar (regex), not an LLM guess — the same
// line always parses to the same action.
//
// ParsedStep is also the normalized representation the JSON template format
// compiles down to (see compileJsonAction at the bottom of this file), which
// is what keeps "three template formats" from meaning three executors.

import type { JsonAction, JsonTarget, JsonTargetStrategy } from "./jsonWorkflow.js";

/**
 * An ordered list of ways to find this step's element, most trustworthy
 * first, in the same notation a bare target already uses (plain text, or a
 * `css=`/`text=`/`xpath=`/`#id`/`.class` selector).
 *
 * Only the JSON format ever sets this — an English line has exactly one
 * target and relies on the resolver's own built-in waterfall. When it is
 * absent, nothing about resolution changes.
 */
type WithTargets = { targets?: string[] };

export type ParsedStep =
  | { kind: "open"; url: string; raw: string }
  | ({ kind: "click"; target: string; raw: string } & WithTargets)
  /** Like click, but a miss is not a failure — for a prompt that only
   * sometimes appears (e.g. "Continue in this browser?", a tile chooser on
   * a login screen). Probes briefly and moves on if nothing matches. */
  | ({ kind: "click_if_visible"; target: string; raw: string } & WithTargets)
  | ({ kind: "fill"; field: string; value: string; raw: string } & WithTargets)
  /** Like fill, but a miss is not a failure — for a guest-name field that
   * only appears when the session isn't already authenticated. */
  | ({ kind: "fill_if_visible"; field: string; value: string; raw: string } & WithTargets)
  | { kind: "type"; text: string; raw: string }
  | ({ kind: "select"; field: string; option: string; raw: string } & WithTargets)
  | ({ kind: "check"; field: string; raw: string } & WithTargets)
  | ({ kind: "uncheck"; field: string; raw: string } & WithTargets)
  | { kind: "press"; key: string; raw: string }
  | { kind: "wait_text"; text: string; raw: string }
  | { kind: "wait_seconds"; seconds: number; raw: string }
  | { kind: "wait_video"; raw: string }
  | { kind: "wait_element"; selector: string; raw: string }
  | { kind: "screenshot"; raw: string }
  | { kind: "unknown"; raw: string };

/**
 * One entry in a stored step script.
 *
 * A string is the original plain-English line and is what every existing
 * group, template and run holds. An object is one JSON-format action. Both
 * live in the same `steps` jsonb column and both come out of parseSteps as
 * ParsedStep, so nothing downstream of the parser knows which format a run
 * was authored in.
 */
export type WorkflowStep = string | JsonAction;

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray, raw: string) => ParsedStep }> = [
  {
    re: /^(?:open|go to|navigate to)\s+(.+)$/i,
    build: (m, raw) => ({ kind: "open", url: stripQuotes(m[1]), raw }),
  },
  {
    re: /^wait for video(?:\s+to\s+(?:end|finish))?$/i,
    build: (_m, raw) => ({ kind: "wait_video", raw }),
  },
  {
    re: /^wait (?:for )?(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)$/i,
    build: (m, raw) => ({ kind: "wait_seconds", seconds: Number(m[1]), raw }),
  },
  {
    re: /^wait for text\s+(.+)$/i,
    build: (m, raw) => ({ kind: "wait_text", text: stripQuotes(m[1]), raw }),
  },
  {
    re: /^wait for element\s+(.+)$/i,
    build: (m, raw) => ({ kind: "wait_element", selector: stripQuotes(m[1]), raw }),
  },
  {
    // Must come before the plain "fill" pattern below, same reason as
    // "click if visible" above.
    re: /^fill if visible\s+(.+?)\s+with\s+(.+)$/i,
    build: (m, raw) => ({ kind: "fill_if_visible", field: stripQuotes(m[1]), value: stripQuotes(m[2]), raw }),
  },
  {
    re: /^fill\s+(.+?)\s+with\s+(.+)$/i,
    build: (m, raw) => ({ kind: "fill", field: stripQuotes(m[1]), value: stripQuotes(m[2]), raw }),
  },
  {
    re: /^(?:select)\s+(.+?)\s+(?:in|from)\s+(.+)$/i,
    build: (m, raw) => ({ kind: "select", option: stripQuotes(m[1]), field: stripQuotes(m[2]), raw }),
  },
  {
    re: /^check\s+(.+)$/i,
    build: (m, raw) => ({ kind: "check", field: stripQuotes(m[1]), raw }),
  },
  {
    re: /^uncheck\s+(.+)$/i,
    build: (m, raw) => ({ kind: "uncheck", field: stripQuotes(m[1]), raw }),
  },
  {
    re: /^press\s+(.+)$/i,
    build: (m, raw) => ({ kind: "press", key: stripQuotes(m[1]), raw }),
  },
  {
    re: /^screenshot$/i,
    build: (_m, raw) => ({ kind: "screenshot", raw }),
  },
  {
    re: /^type\s+(.+)$/i,
    build: (m, raw) => ({ kind: "type", text: stripQuotes(m[1]), raw }),
  },
  {
    // Must come before the plain "click" pattern below, or "if visible ..."
    // would just be swallowed as part of a literal click target.
    re: /^click if visible\s+(.+)$/i,
    build: (m, raw) => ({ kind: "click_if_visible", target: stripQuotes(m[1]), raw }),
  },
  {
    re: /^click\s+(.+)$/i,
    build: (m, raw) => ({ kind: "click", target: stripQuotes(m[1]), raw }),
  },
];

export function parseStep(line: string): ParsedStep {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return { kind: "unknown", raw };
  for (const { re, build } of PATTERNS) {
    const m = raw.match(re);
    if (m) return build(m, raw);
  }
  return { kind: "unknown", raw };
}

/**
 * Compiles a stored step script into what the executor runs.
 *
 * Accepts both formats in the same array — a plain-English line and a JSON
 * action are equally valid entries — because that is what makes a JSON
 * template a *format*, not a parallel system: it lands in the same column,
 * the same job, the same worker loop.
 */
export function parseSteps(steps: WorkflowStep[]): ParsedStep[] {
  const out: ParsedStep[] = [];
  for (const step of steps ?? []) {
    if (typeof step === "string") {
      const line = step.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      out.push(parseStep(line));
    } else if (step && typeof step === "object") {
      out.push(compileJsonAction(step));
    }
  }
  return out;
}

/**
 * Substitutes {{column}} (or {column}) placeholders with values from a
 * user's CSV row. Both brace styles are accepted since people naturally
 * type either — matching is case-insensitive against row keys so
 * "{{Email}}", "{{email}}" and "{email}" all resolve against a column
 * literally named either way.
 */
export function applyTemplate(text: string, row: Record<string, string>): string {
  const lowerRow = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}|\{\s*([^{}]+?)\s*\}/g, (all, doubleKey?: string, singleKey?: string) => {
    const key = doubleKey ?? singleKey ?? "";
    const val = lowerRow.get(key.toLowerCase());
    return val !== undefined ? val : all;
  });
}

// ============================================================
// JSON format -> the same ParsedStep the English parser makes.
//
// This is the whole of the "second template format": a translation, not an
// engine. Everything below produces values the existing stepExecutor and
// locators already understand — a target string in the notation they
// already accept, plus (only where the author spelled one out) an ordered
// list of alternatives for the resolver to try in turn.
// ============================================================

/** One strategy, in the notation resolveClickable/resolveField already
 * accept for a bare target. `role`/`label`/`title`/`text` become plain text
 * because that is exactly what those resolvers already try first; only the
 * selector forms need a prefix to bypass the text waterfall. */
function strategyToTarget(s: JsonTargetStrategy): string {
  switch (s.by) {
    case "role":
      return s.name;
    case "label":
      return s.label;
    case "placeholder":
      return s.placeholder;
    case "text":
      return s.text;
    case "title":
      return s.title;
    case "css":
      return `css=${s.selector}`;
    case "xpath":
      return `xpath=${s.xpath}`;
  }
}

/**
 * Flattens a target into the ordered hints the resolver should try.
 *
 * Always at least one entry, so `targets[0]` is a usable target on its own
 * and a caller that ignores the rest still behaves correctly.
 */
export function targetHints(target: JsonTarget): string[] {
  if (typeof target === "string") return [target];
  if ("strategies" in target) {
    const hints = target.strategies.map(strategyToTarget).filter(Boolean);
    return hints.length > 0 ? hints : [""];
  }
  if ("label" in target) return [target.label];
  if ("css" in target) return [`css=${target.css}`];
  return [target.name];
}

/** How a JSON step is shown wherever a script is displayed as text (a
 * group's Task preview, the step timeline, the run log). Reads like the
 * English line it is equivalent to, so one timeline can show both. */
export function describeJsonAction(action: JsonAction): string {
  switch (action.type) {
    case "navigate":
      return `open ${action.url}`;
    case "click":
      return `${action.optional ? "click if visible" : "click"} ${targetHints(action.target)[0]}`;
    case "fill":
      return `${action.optional ? "fill if visible" : "fill"} ${targetHints(action.target)[0]} with ${action.value}`;
    case "type":
      return `type ${action.text}`;
    case "select":
      return `select ${action.value} in ${targetHints(action.target)[0]}`;
    case "check":
      return `check ${targetHints(action.target)[0]}`;
    case "uncheck":
      return `uncheck ${targetHints(action.target)[0]}`;
    case "press":
      return `press ${action.key}`;
    case "waitForText":
      return `wait for text "${action.text}"`;
    case "waitForElement":
      return `wait for element "${action.selector}"`;
    case "wait":
      return `wait ${action.seconds} seconds`;
    case "waitForVideo":
      return "wait for video";
    case "screenshot":
      return "screenshot";
  }
}

export function compileJsonAction(action: JsonAction): ParsedStep {
  const raw = describeJsonAction(action);
  switch (action.type) {
    case "navigate":
      return { kind: "open", url: action.url, raw };
    case "click": {
      const targets = targetHints(action.target);
      return action.optional
        ? { kind: "click_if_visible", target: targets[0], targets, raw }
        : { kind: "click", target: targets[0], targets, raw };
    }
    case "fill": {
      const targets = targetHints(action.target);
      return action.optional
        ? { kind: "fill_if_visible", field: targets[0], targets, value: action.value, raw }
        : { kind: "fill", field: targets[0], targets, value: action.value, raw };
    }
    case "type":
      return { kind: "type", text: action.text, raw };
    case "select": {
      const targets = targetHints(action.target);
      return { kind: "select", field: targets[0], targets, option: action.value, raw };
    }
    case "check": {
      const targets = targetHints(action.target);
      return { kind: "check", field: targets[0], targets, raw };
    }
    case "uncheck": {
      const targets = targetHints(action.target);
      return { kind: "uncheck", field: targets[0], targets, raw };
    }
    case "press":
      return { kind: "press", key: action.key, raw };
    case "waitForText":
      return { kind: "wait_text", text: action.text, raw };
    case "waitForElement":
      return { kind: "wait_element", selector: action.selector, raw };
    case "wait":
      return { kind: "wait_seconds", seconds: action.seconds, raw };
    case "waitForVideo":
      return { kind: "wait_video", raw };
    case "screenshot":
      return { kind: "screenshot", raw };
  }
}

/** A stored script as displayable lines — the one place that knows a step
 * may be an object, so every caller that just wants text stays simple. */
export function stepLines(steps: WorkflowStep[]): string[] {
  return (steps ?? []).map((s) => (typeof s === "string" ? s : describeJsonAction(s)));
}
