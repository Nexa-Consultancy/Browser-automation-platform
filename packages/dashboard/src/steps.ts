import type { WorkflowStep } from "./types";

/**
 * A stored step script as displayable lines.
 *
 * A script is plain-English lines, or — for one authored as a JSON
 * template — action objects, in the same array. This is the one place on
 * the front end that knows the difference, so every timeline, preview and
 * editor stays simple and neither format has to be special-cased twice.
 *
 * Mirrors stepLines()/describeJsonAction() in packages/shared: a JSON
 * action is rendered as the English line it is equivalent to, so a run
 * started from either format reads the same in the step timeline.
 */
export function stepLines(steps: WorkflowStep[] | undefined): string[] {
  return (steps ?? []).map((s) => (typeof s === "string" ? s : describeAction(s)));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The first, most-trusted hint of a JSON action's target. */
function targetText(target: unknown): string {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return "";
  const t = target as Record<string, unknown>;
  if (Array.isArray(t.strategies) && t.strategies.length > 0) {
    const first = t.strategies[0] as Record<string, unknown>;
    return (
      str(first.name) || str(first.label) || str(first.text) || str(first.title) ||
      str(first.placeholder) || str(first.selector) || str(first.xpath)
    );
  }
  return str(t.label) || str(t.name) || str(t.css) || str(t.selector);
}

function describeAction(action: Record<string, unknown>): string {
  const type = str(action.type);
  const target = targetText(action.target);
  const optional = action.optional === true;
  switch (type) {
    case "navigate":
      return `open ${str(action.url)}`;
    case "click":
      return `${optional ? "click if visible" : "click"} ${target}`;
    case "fill":
      return `${optional ? "fill if visible" : "fill"} ${target} with ${str(action.value)}`;
    case "type":
      return `type ${str(action.text)}`;
    case "select":
      return `select ${str(action.value)} in ${target}`;
    case "check":
      return `check ${target}`;
    case "uncheck":
      return `uncheck ${target}`;
    case "press":
      return `press ${str(action.key)}`;
    case "waitForText":
      return `wait for text "${str(action.text)}"`;
    case "waitForElement":
      return `wait for element "${str(action.selector)}"`;
    case "wait":
      return `wait ${String(action.seconds ?? 0)} seconds`;
    case "waitForVideo":
      return "wait for video";
    case "screenshot":
      return "screenshot";
    default:
      // An action from a newer server than this build. Showing the raw JSON
      // beats showing nothing, and it is obviously a step rather than a
      // silent gap in the timeline.
      return JSON.stringify(action);
  }
}
