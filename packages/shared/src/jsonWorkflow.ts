/**
 * The structured workflow format.
 *
 * Same automation, written as data instead of prose. It exists for the two
 * things a line of English cannot carry: an explicit ordered list of ways
 * to find an element (so a rename of one button doesn't fail the run), and
 * a schema a machine can check *before* the definition ever reaches a
 * worker.
 *
 * It deliberately does NOT get its own executor. Every action here compiles
 * to the same ParsedStep the English parser produces (see compileJsonAction
 * in stepParser.ts), so there is one element-resolution engine, one step
 * executor and one set of behaviours to reason about.
 *
 * This module holds the SCHEMA and its validation only — no ParsedStep, no
 * Playwright — so the compiler in stepParser.ts can import from here
 * without a cycle.
 */

/**
 * One way to find an element. These map onto the resolver's existing
 * strategies rather than introducing new ones: `role`/`label`/`title`/
 * `text` are what resolveClickable and resolveField already try for a bare
 * string, and `css`/`xpath` are the pass-through forms they already accept.
 */
export type JsonTargetStrategy =
  | { by: "role"; role: string; name: string }
  | { by: "label"; label: string }
  | { by: "placeholder"; placeholder: string }
  | { by: "text"; text: string }
  | { by: "title"; title: string }
  | { by: "css"; selector: string }
  | { by: "xpath"; xpath: string };

/**
 * What an action points at.
 *
 * The three shapes are the same thing at different levels of detail: a bare
 * string ("Login"), a single labelled hint, or an ordered list to try in
 * turn. A bare string is not a lesser form — the resolver's own waterfall
 * (button -> link -> menuitem -> aria-label -> label -> title -> text)
 * already covers most of what a strategy list would spell out, so spelling
 * it out is worth doing only when you know something the resolver can't
 * guess.
 */
export type JsonTarget =
  | string
  | { label: string }
  | { role: string; name: string }
  | { css: string }
  | { strategies: JsonTargetStrategy[] };

export type JsonAction =
  | { type: "navigate"; url: string }
  | { type: "click"; target: JsonTarget; optional?: boolean }
  | { type: "fill"; target: JsonTarget; value: string; optional?: boolean }
  | { type: "type"; text: string }
  | { type: "select"; target: JsonTarget; value: string }
  | { type: "check"; target: JsonTarget }
  | { type: "uncheck"; target: JsonTarget }
  | { type: "press"; key: string }
  | { type: "waitForText"; text: string }
  | { type: "waitForElement"; selector: string }
  | { type: "wait"; seconds: number }
  | { type: "waitForVideo" }
  | { type: "screenshot" };

export const JSON_ACTION_TYPES = [
  "navigate",
  "click",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "press",
  "waitForText",
  "waitForElement",
  "wait",
  "waitForVideo",
  "screenshot",
] as const;

export interface JsonWorkflow {
  name: string;
  /** Bumped when the schema itself changes in a way a stored workflow would
   * need migrating for. Stored with the definition so an old one can be
   * recognised rather than silently misread. */
  version: number;
  steps: JsonAction[];
}

export const JSON_WORKFLOW_VERSION = 1;

/** A validation failure, addressed to whoever is typing the JSON: which
 * step, which field, what was expected. */
export interface JsonWorkflowError {
  path: string;
  message: string;
}

export type JsonWorkflowResult =
  | { ok: true; workflow: JsonWorkflow }
  | { ok: false; errors: JsonWorkflowError[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Checks one target and normalizes it.
 *
 * Errors accumulate into `errors` rather than throwing, so saving a
 * workflow with three mistakes reports three mistakes instead of making
 * someone fix them one round trip at a time.
 */
function parseTarget(raw: unknown, path: string, errors: JsonWorkflowError[]): JsonTarget | null {
  const asString = str(raw);
  if (asString) return asString;

  if (!isRecord(raw)) {
    errors.push({ path, message: "target must be a string, or an object with label/role+name/css/strategies" });
    return null;
  }

  if (Array.isArray(raw.strategies)) {
    const strategies: JsonTargetStrategy[] = [];
    raw.strategies.forEach((s, i) => {
      const parsed = parseStrategy(s, `${path}.strategies[${i}]`, errors);
      if (parsed) strategies.push(parsed);
    });
    if (strategies.length === 0) {
      errors.push({ path: `${path}.strategies`, message: "at least one usable strategy is required" });
      return null;
    }
    return { strategies };
  }

  const label = str(raw.label);
  if (label) return { label };

  const css = str(raw.css) ?? str(raw.selector);
  if (css) return { css };

  const role = str(raw.role);
  const name = str(raw.name);
  if (role && name) return { role, name };
  if (role && !name) {
    errors.push({ path: `${path}.name`, message: 'a "role" target also needs a "name"' });
    return null;
  }

  errors.push({ path, message: "target needs one of: label, role + name, css, or strategies" });
  return null;
}

function parseStrategy(raw: unknown, path: string, errors: JsonWorkflowError[]): JsonTargetStrategy | null {
  if (!isRecord(raw)) {
    errors.push({ path, message: "a strategy must be an object" });
    return null;
  }
  const by = str(raw.by);
  switch (by) {
    case "role": {
      const role = str(raw.role);
      const name = str(raw.name);
      if (!role || !name) {
        errors.push({ path, message: 'a "role" strategy needs both role and name' });
        return null;
      }
      return { by: "role", role, name };
    }
    case "label": {
      const label = str(raw.label);
      if (!label) {
        errors.push({ path, message: 'a "label" strategy needs a label' });
        return null;
      }
      return { by: "label", label };
    }
    case "placeholder": {
      const placeholder = str(raw.placeholder);
      if (!placeholder) {
        errors.push({ path, message: 'a "placeholder" strategy needs a placeholder' });
        return null;
      }
      return { by: "placeholder", placeholder };
    }
    case "text": {
      const text = str(raw.text);
      if (!text) {
        errors.push({ path, message: 'a "text" strategy needs text' });
        return null;
      }
      return { by: "text", text };
    }
    case "title": {
      const title = str(raw.title);
      if (!title) {
        errors.push({ path, message: 'a "title" strategy needs a title' });
        return null;
      }
      return { by: "title", title };
    }
    case "css": {
      const selector = str(raw.selector) ?? str(raw.css);
      if (!selector) {
        errors.push({ path, message: 'a "css" strategy needs a selector' });
        return null;
      }
      return { by: "css", selector };
    }
    case "xpath": {
      const xpath = str(raw.xpath) ?? str(raw.selector);
      if (!xpath) {
        errors.push({ path, message: 'an "xpath" strategy needs an xpath' });
        return null;
      }
      return { by: "xpath", xpath };
    }
    default:
      errors.push({
        path: `${path}.by`,
        message: `unknown strategy "${by ?? ""}" — use role, label, placeholder, text, title, css or xpath`,
      });
      return null;
  }
}

function parseAction(raw: unknown, path: string, errors: JsonWorkflowError[]): JsonAction | null {
  if (!isRecord(raw)) {
    errors.push({ path, message: "each step must be an object" });
    return null;
  }
  const type = str(raw.type);
  const need = (field: string): string | null => {
    const v = str(raw[field]);
    if (!v) errors.push({ path: `${path}.${field}`, message: `"${field}" is required` });
    return v;
  };

  switch (type) {
    case "navigate": {
      const url = need("url");
      return url ? { type: "navigate", url } : null;
    }
    case "click": {
      const target = parseTarget(raw.target, `${path}.target`, errors);
      return target ? { type: "click", target, optional: raw.optional === true } : null;
    }
    case "fill": {
      const target = parseTarget(raw.target, `${path}.target`, errors);
      // An empty string is a legitimate value here ("clear this field"), so
      // this one checks the type rather than the truthiness.
      if (typeof raw.value !== "string") {
        errors.push({ path: `${path}.value`, message: '"value" is required and must be a string' });
        return null;
      }
      return target ? { type: "fill", target, value: raw.value, optional: raw.optional === true } : null;
    }
    case "type": {
      const text = need("text");
      return text ? { type: "type", text } : null;
    }
    case "select": {
      const target = parseTarget(raw.target, `${path}.target`, errors);
      const value = need("value");
      return target && value ? { type: "select", target, value } : null;
    }
    case "check": {
      const target = parseTarget(raw.target, `${path}.target`, errors);
      return target ? { type: "check", target } : null;
    }
    case "uncheck": {
      const target = parseTarget(raw.target, `${path}.target`, errors);
      return target ? { type: "uncheck", target } : null;
    }
    case "press": {
      const key = need("key");
      return key ? { type: "press", key } : null;
    }
    case "waitForText": {
      const text = need("text");
      return text ? { type: "waitForText", text } : null;
    }
    case "waitForElement": {
      const selector = need("selector");
      return selector ? { type: "waitForElement", selector } : null;
    }
    case "wait": {
      const seconds = Number(raw.seconds);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
        errors.push({ path: `${path}.seconds`, message: '"seconds" must be a number between 0 and 3600' });
        return null;
      }
      return { type: "wait", seconds };
    }
    case "waitForVideo":
      return { type: "waitForVideo" };
    case "screenshot":
      return { type: "screenshot" };
    default:
      errors.push({
        path: `${path}.type`,
        message: `unknown step type "${type ?? ""}" — one of: ${JSON_ACTION_TYPES.join(", ")}`,
      });
      return null;
  }
}

/**
 * Validates an already-parsed JSON value against the workflow schema.
 *
 * Returns every problem it finds rather than the first: a malformed
 * workflow must never reach a worker, and the only way that rule doesn't
 * become miserable to work with is if the rejection says everything that
 * is wrong at once.
 */
export function validateJsonWorkflow(raw: unknown): JsonWorkflowResult {
  const errors: JsonWorkflowError[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [{ path: "$", message: "the workflow must be a JSON object" }] };
  }

  const name = str(raw.name) ?? "";
  const version = raw.version === undefined ? JSON_WORKFLOW_VERSION : Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    errors.push({ path: "version", message: '"version" must be a whole number of 1 or more' });
  }
  if (version > JSON_WORKFLOW_VERSION) {
    errors.push({
      path: "version",
      message: `this server understands workflow version ${JSON_WORKFLOW_VERSION}; this one says ${version}`,
    });
  }

  if (!Array.isArray(raw.steps)) {
    errors.push({ path: "steps", message: '"steps" must be an array of step objects' });
    return { ok: false, errors };
  }
  if (raw.steps.length === 0) {
    errors.push({ path: "steps", message: "at least one step is required" });
  }

  const steps: JsonAction[] = [];
  raw.steps.forEach((s, i) => {
    const action = parseAction(s, `steps[${i}]`, errors);
    if (action) steps.push(action);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, workflow: { name, version, steps } };
}

/** Same check, starting from the text in the editor. A syntax error is
 * reported in the same shape as a schema error so the caller has one thing
 * to render. */
export function parseJsonWorkflow(text: string): JsonWorkflowResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: "$", message: `not valid JSON — ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
  return validateJsonWorkflow(raw);
}

/** One line per problem, for an error banner or an API 400. */
export function formatWorkflowErrors(errors: JsonWorkflowError[]): string {
  return errors.map((e) => (e.path === "$" ? e.message : `${e.path}: ${e.message}`)).join("; ");
}
