import type { AssessmentPortalConfig } from "../types";
import { PORTAL_CONFIG_FIELDS, REQUIRED_PORTAL_FIELDS } from "../types";

/**
 * Where the portal's selectors get filled in.
 *
 * ============================================================
 * The single screen that answers "how do I point this at our portal".
 * ============================================================
 *
 * Every field is empty by default and nothing here guesses: the target
 * portal has not been supplied, and a plausible-looking default selector
 * would be worse than a blank one — it would look configured and fail
 * against a page nobody had ever pointed it at.
 *
 * The four fields marked required are the ones without which the engine
 * cannot do anything at all. A half-filled config still SAVES (working one
 * out is a normal state); it just cannot start a run, and the run button
 * says which fields are missing rather than failing inside a browser.
 */
export function PortalConfigEditor({
  value,
  onChange,
}: {
  value: AssessmentPortalConfig;
  onChange: (next: AssessmentPortalConfig) => void;
}) {
  /** Reads a dotted path, rendering a word list as the comma-separated
   * string the single-line input produces. */
  function get(path: string): string {
    const parts = path.split(".");
    let cur: unknown = value;
    for (const p of parts) {
      if (typeof cur !== "object" || cur === null) return "";
      cur = (cur as Record<string, unknown>)[p];
    }
    if (cur === undefined || cur === null) return "";
    return Array.isArray(cur) ? cur.join(", ") : String(cur);
  }

  /** Writes a dotted path, clearing the key entirely when emptied so a
   * blanked field means "not configured" rather than "configured as an
   * empty selector", which would match everything. */
  function set(path: string, raw: string) {
    const parts = path.split(".");
    const next: AssessmentPortalConfig = JSON.parse(JSON.stringify(value ?? {}));
    let cur = next as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
      cur = cur[key] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    const text = raw.trim();

    if (!text) {
      delete cur[leaf];
    } else if (leaf === "completedText" || leaf === "pendingText") {
      cur[leaf] = text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      cur[leaf] = text;
    }
    onChange(next);
  }

  const missing = REQUIRED_PORTAL_FIELDS.filter((p) => get(p) === "");

  return (
    <div className="portal-config">
      <div className="hint" style={{ marginBottom: 12 }}>
        These point the quiz engine at a portal. Each accepts a CSS selector (<code>.quiz-card</code>,{" "}
        <code>#next</code>) or the same plain wording the step script uses, which is resolved by role, label,
        title then text. Nothing here is filled in for you — a guessed selector looks configured and fails at
        2 AM.
      </div>

      {missing.length > 0 && (
        <div className="editor-status warn" style={{ marginBottom: 12 }}>
          Not runnable yet — still needs:{" "}
          {missing.map((m) => PORTAL_CONFIG_FIELDS.find((f) => f.path === m)?.label ?? m).join(", ")}. You can
          still save and come back to it.
        </div>
      )}

      <div className="portal-config-grid">
        {PORTAL_CONFIG_FIELDS.map((field) => (
          <div className="form-row" key={field.path}>
            <label title={field.path}>
              {field.label}
              {REQUIRED_PORTAL_FIELDS.includes(field.path) && <span className="req"> · required</span>}
            </label>
            <input
              type="text"
              value={get(field.path)}
              placeholder=""
              onChange={(e) => set(field.path, e.target.value)}
            />
            <div className="hint">{field.hint}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
