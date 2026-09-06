// The JSON template format: what it accepts, what it refuses, and that it
// compiles to the SAME ParsedStep the English parser produces. That last
// one is the property that matters most — the moment the two formats can
// mean different things, "one executor" stops being true.
//
//   npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JSON_WORKFLOW_VERSION,
  formatWorkflowErrors,
  parseJsonWorkflow,
  validateJsonWorkflow,
} from "./jsonWorkflow.js";
import { compileJsonAction, parseStep, parseSteps, stepLines, targetHints } from "./stepParser.js";
import {
  TEMPLATE_TYPES,
  isTemplateType,
  templateMatchesFilter,
  templateTypeOf,
} from "./templateTypes.js";
import { TS_TEMPLATE_ENTRYPOINT, validateTsTemplate } from "./tsTemplate.js";

const LOGIN_WORKFLOW = {
  name: "Portal Login",
  version: 1,
  steps: [
    { type: "navigate", url: "{{url}}" },
    { type: "fill", target: { label: "Email" }, value: "{{email}}" },
    { type: "fill", target: { label: "Password" }, value: "{{password}}" },
    { type: "click", target: { role: "button", name: "Login" } },
  ],
};

describe("template types", () => {
  it("knows the three formats", () => {
    assert.deepEqual(TEMPLATE_TYPES, ["plain", "json", "typescript"]);
    for (const t of TEMPLATE_TYPES) assert.ok(isTemplateType(t));
    assert.equal(isTemplateType("yaml"), false);
  });

  it("treats a template with no type as plain-English", () => {
    // Every template that predates types is a plain script; reading an
    // absent value as an error would break every existing workspace.
    assert.equal(templateTypeOf(undefined), "plain");
    assert.equal(templateTypeOf(null), "plain");
    assert.equal(templateTypeOf("nonsense"), "plain");
    assert.equal(templateTypeOf("json"), "json");
  });

  it("filters a list by type, with All meaning all", () => {
    const list = [
      { templateType: "plain" as const, name: "Join meeting" },
      { templateType: "json" as const, name: "Portal login" },
      { templateType: "typescript" as const, name: "Custom" },
    ];
    assert.equal(list.filter((t) => templateMatchesFilter(t, "all")).length, 3);
    assert.deepEqual(
      list.filter((t) => templateMatchesFilter(t, "json")).map((t) => t.name),
      ["Portal login"],
    );
    assert.deepEqual(
      list.filter((t) => templateMatchesFilter(t, "plain")).map((t) => t.name),
      ["Join meeting"],
    );
    assert.deepEqual(
      list.filter((t) => templateMatchesFilter(t, "typescript")).map((t) => t.name),
      ["Custom"],
    );
  });
});

describe("validateJsonWorkflow", () => {
  it("accepts a well-formed workflow", () => {
    const res = validateJsonWorkflow(LOGIN_WORKFLOW);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.workflow.name, "Portal Login");
    assert.equal(res.workflow.steps.length, 4);
  });

  it("defaults the version when one isn't given", () => {
    const res = validateJsonWorkflow({ name: "x", steps: [{ type: "screenshot" }] });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.workflow.version, JSON_WORKFLOW_VERSION);
  });

  it("refuses a version this server doesn't understand", () => {
    const res = validateJsonWorkflow({ ...LOGIN_WORKFLOW, version: 99 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(formatWorkflowErrors(res.errors), /version/);
  });

  it("refuses anything that isn't an object, or has no steps", () => {
    assert.equal(validateJsonWorkflow("nope").ok, false);
    assert.equal(validateJsonWorkflow([]).ok, false);
    assert.equal(validateJsonWorkflow({ name: "x" }).ok, false);
    assert.equal(validateJsonWorkflow({ name: "x", steps: [] }).ok, false);
  });

  it("names an unknown step type instead of silently dropping it", () => {
    const res = validateJsonWorkflow({ name: "x", steps: [{ type: "teleport" }] });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(formatWorkflowErrors(res.errors), /teleport/);
      assert.match(formatWorkflowErrors(res.errors), /steps\[0\]\.type/);
    }
  });

  it("reports every problem at once, not just the first", () => {
    const res = validateJsonWorkflow({
      name: "x",
      steps: [{ type: "click" }, { type: "navigate" }, { type: "wait", seconds: -1 }],
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.errors.length >= 3, `expected 3+ errors, got ${res.errors.length}`);
  });

  it('a "role" target without a name is a mistake, not a target', () => {
    const res = validateJsonWorkflow({ name: "x", steps: [{ type: "click", target: { role: "button" } }] });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(formatWorkflowErrors(res.errors), /needs a "name"/);
  });

  it('keeps an empty fill value — "clear this field" is a real instruction', () => {
    const res = validateJsonWorkflow({
      name: "x",
      steps: [{ type: "fill", target: "Search", value: "" }],
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.workflow.steps[0], { type: "fill", target: "Search", value: "", optional: false });
  });

  it("refuses a fill with no value at all", () => {
    const res = validateJsonWorkflow({ name: "x", steps: [{ type: "fill", target: "Search" }] });
    assert.equal(res.ok, false);
  });
});

describe("parseJsonWorkflow", () => {
  it("reports a syntax error in the same shape as a schema error", () => {
    const res = parseJsonWorkflow("{ not json");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(formatWorkflowErrors(res.errors), /not valid JSON/);
  });

  it("round-trips a workflow through text", () => {
    const res = parseJsonWorkflow(JSON.stringify(LOGIN_WORKFLOW));
    assert.equal(res.ok, true);
  });
});

describe("target strategies", () => {
  it("flattens a strategy list into ordered resolver hints", () => {
    const hints = targetHints({
      strategies: [
        { by: "role", role: "button", name: "Login" },
        { by: "text", text: "Login" },
        { by: "css", selector: "button[type='submit']" },
      ],
    });
    assert.deepEqual(hints, ["Login", "Login", "css=button[type='submit']"]);
  });

  it("always yields at least one usable hint", () => {
    assert.deepEqual(targetHints("Login"), ["Login"]);
    assert.deepEqual(targetHints({ label: "Email" }), ["Email"]);
    assert.deepEqual(targetHints({ css: ".btn" }), ["css=.btn"]);
    assert.deepEqual(targetHints({ role: "link", name: "Next" }), ["Next"]);
  });
});

describe("compileJsonAction — JSON and English mean the same thing", () => {
  it("compiles to the same ParsedStep the English line parses to", () => {
    const pairs: [Parameters<typeof compileJsonAction>[0], string][] = [
      [{ type: "navigate", url: "https://x.test" }, "open https://x.test"],
      [{ type: "type", text: "hello" }, "type hello"],
      [{ type: "press", key: "Enter" }, "press Enter"],
      [{ type: "wait", seconds: 3 }, "wait 3 seconds"],
      [{ type: "waitForVideo" }, "wait for video"],
      [{ type: "screenshot" }, "screenshot"],
      [{ type: "waitForText", text: "Dashboard" }, 'wait for text "Dashboard"'],
      [{ type: "waitForElement", selector: ".ready" }, 'wait for element ".ready"'],
    ];
    for (const [action, line] of pairs) {
      assert.deepEqual(compileJsonAction(action), parseStep(line), `for ${JSON.stringify(action)}`);
    }
  });

  it("carries the strategy list through as ordered targets", () => {
    const step = compileJsonAction({
      type: "click",
      target: { strategies: [{ by: "role", role: "button", name: "Login" }, { by: "css", selector: "#login" }] },
    });
    assert.equal(step.kind, "click");
    if (step.kind !== "click") return;
    assert.equal(step.target, "Login");
    assert.deepEqual(step.targets, ["Login", "css=#login"]);
  });

  it('maps optional:true onto the existing "if visible" behaviour', () => {
    assert.equal(compileJsonAction({ type: "click", target: "Skip", optional: true }).kind, "click_if_visible");
    assert.equal(compileJsonAction({ type: "click", target: "Skip" }).kind, "click");
    assert.equal(
      compileJsonAction({ type: "fill", target: "Name", value: "x", optional: true }).kind,
      "fill_if_visible",
    );
  });
});

describe("parseSteps with both formats", () => {
  it("runs plain-English scripts exactly as before", () => {
    const steps = ["open {{url}}", "# a comment", "", 'click "Login"'];
    const parsed = parseSteps(steps);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].kind, "open");
    assert.equal(parsed[1].kind, "click");
  });

  it("accepts English lines and JSON actions in one array", () => {
    const parsed = parseSteps(["open {{url}}", { type: "click", target: { role: "button", name: "Login" } }]);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].kind, "open");
    assert.equal(parsed[1].kind, "click");
  });

  it("shows a JSON action as a readable line", () => {
    assert.deepEqual(
      stepLines(["open {{url}}", { type: "fill", target: { label: "Email" }, value: "{{email}}" }]),
      ["open {{url}}", "fill Email with {{email}}"],
    );
  });
});

describe("TypeScript templates", () => {
  const good = `export function ${TS_TEMPLATE_ENTRYPOINT}(row: Record<string, string>) {
  return [{ type: "navigate", url: row.url }];
}`;

  it("accepts a template that declares the entrypoint", () => {
    assert.equal(validateTsTemplate(good).ok, true);
  });

  it("refuses one with no entrypoint", () => {
    const res = validateTsTemplate("const x = 1;");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.issues[0].message, new RegExp(TS_TEMPLATE_ENTRYPOINT));
  });

  it("refuses a template written against a runtime it will never get", () => {
    for (const bad of ["require('fs')", "process.env.SECRET", "eval('1')", "fetch('https://x')"]) {
      const res = validateTsTemplate(`${good}\n${bad}`);
      assert.equal(res.ok, false, `should refuse: ${bad}`);
    }
  });

  it("does not trip over a comment that mentions one of them", () => {
    assert.equal(validateTsTemplate(`// no process.env here\n${good}`).ok, true);
  });

  it("catches a truncated paste", () => {
    const res = validateTsTemplate(`export function ${TS_TEMPLATE_ENTRYPOINT}() {\n  return [`);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.issues.some((i) => /unclosed/.test(i.message)));
  });

  it("ignores braces inside strings and template literals", () => {
    assert.equal(validateTsTemplate(`${good}\nconst s = "{{{";\nconst t = \`}\`;`).ok, true);
  });

  it("refuses an empty template", () => {
    assert.equal(validateTsTemplate("   ").ok, false);
  });
});
