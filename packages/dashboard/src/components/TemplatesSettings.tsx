import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssessmentPortalConfig,
  StepTemplate,
  TemplateScope,
  TemplateType,
  TemplateTypeFilter,
} from "../types";
import { TEMPLATE_TYPE_LABELS } from "../types";
import * as api from "../api";
import { StepReference } from "./StepReference";
import { PortalConfigEditor } from "./PortalConfigEditor";

const AUTO_LOGIN_TEMPLATE_ID = "00000000-0000-0000-0000-000000000002";

/** What each default actually controls, in the words of the thing it
 * affects — the label has to say where the script will show up. */
const SCOPES: { scope: TemplateScope; label: string; badge: string; explains: string }[] = [
  {
    scope: "group",
    label: "Default for new groups",
    badge: "group default",
    explains: "Fills in the Task of every new group, so a group can be created without touching Advanced.",
  },
  {
    scope: "user",
    label: "Default for new users",
    badge: "user default",
    explains: "The sign-in script run when a user is added or re-signed in.",
  },
];

/** The filter buttons, in the order a format is likely to be reached for. */
const FILTERS: { id: TemplateTypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "plain", label: TEMPLATE_TYPE_LABELS.plain },
  { id: "json", label: TEMPLATE_TYPE_LABELS.json },
  { id: "typescript", label: TEMPLATE_TYPE_LABELS.typescript },
];

const FILTER_STORAGE_KEY = "templates.typeFilter";

const JSON_STARTER = `{
  "name": "Portal Login",
  "version": 1,
  "steps": [
    { "type": "navigate", "url": "{{url}}" },
    { "type": "fill", "target": { "label": "Email" }, "value": "{{email}}" },
    { "type": "fill", "target": { "label": "Password" }, "value": "{{password}}" },
    {
      "type": "click",
      "target": {
        "strategies": [
          { "by": "role", "role": "button", "name": "Login" },
          { "by": "text", "text": "Login" },
          { "by": "css", "selector": "button[type='submit']" }
        ]
      }
    },
    { "type": "waitForText", "text": "Dashboard" }
  ]
}`;

const TS_STARTER = `// A TypeScript template returns a workflow; the host runs it.
// Nothing here touches the browser directly — that stays with Playwright.
//
// row carries this user's values: name, email, url, and any CSV column.

export function buildWorkflow(row: Record<string, string>) {
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

/** Local, immediate JSON feedback so a typo shows up while typing rather
 * than only when the server refuses the save. The server validates again —
 * this is a convenience, never the authority. */
function jsonProblem(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "the workflow must be a JSON object";
    }
    if (!Array.isArray((parsed as { steps?: unknown }).steps)) {
      return '"steps" must be an array of step objects';
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "not valid JSON";
  }
}

function TemplateModal({
  template,
  initialType,
  onClose,
  onSaved,
}: {
  template?: StepTemplate;
  /** What a NEW template starts as — the type filter that was showing, so
   * "JSON" then "+ Add template" opens a JSON editor. */
  initialType: TemplateType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!template;
  // An existing template's type is fixed: the three formats are not
  // interchangeable source, and silently converting one would either lose
  // the original or produce something nobody wrote.
  const [templateType, setTemplateType] = useState<TemplateType>(template?.templateType ?? initialType);
  const [name, setName] = useState(template?.name ?? "");
  const [steps, setSteps] = useState(
    template?.templateType === "plain" || !template
      ? (template?.steps ?? []).map((s) => (typeof s === "string" ? s : JSON.stringify(s))).join("\n")
      : "",
  );
  const [body, setBody] = useState(template?.body ?? "");
  const [assessment, setAssessment] = useState<AssessmentPortalConfig>(template?.assessment ?? {});
  const [showPortal, setShowPortal] = useState(Boolean(template?.assessment));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const backdropMouseDown = useRef(false);

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard this template? Anything you have typed will be lost.")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  /** Switching type on a NEW template drops in that format's starting
   * point, but never over something already typed. */
  function chooseType(next: TemplateType) {
    setTemplateType(next);
    setDirty(true);
    if (next === "json" && !body.trim()) setBody(JSON_STARTER);
    if (next === "typescript" && !body.trim()) setBody(TS_STARTER);
  }

  const liveJsonError = templateType === "json" ? jsonProblem(body) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Template name is required.");
    if (templateType === "plain" && !steps.trim()) return setError("At least one step is required.");
    if (templateType !== "plain" && !body.trim()) {
      return setError(`The ${TEMPLATE_TYPE_LABELS[templateType]} source is required.`);
    }
    if (liveJsonError) return setError(liveJsonError);

    const payload = {
      name,
      templateType,
      steps: templateType === "plain" ? steps : undefined,
      body: templateType === "plain" ? undefined : body,
      assessment: Object.keys(assessment).length > 0 ? assessment : null,
    };

    setBusy(true);
    try {
      if (editing) await api.updateTemplate(template!.id, payload);
      else await api.createTemplate(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        backdropMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div className="modal-panel modal-form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{editing ? `Edit ${template!.name}` : "Add template"}</span>
          <button type="button" onClick={requestClose}>
            ✕
          </button>
        </div>
        <form className="modal-form-wrap" onSubmit={submit} onChange={() => setDirty(true)}>
          <div className="modal-body form-grid">
            {error && <div className="error-banner">{error}</div>}

            <div className="form-section">
              {/* Type first: it decides which editor the rest of the form
                  shows, so asking for it after the source would mean
                  retyping into a different box. */}
              <div className="form-row">
                <label>Template type</label>
                {editing ? (
                  <div className="type-locked">
                    <span className="template-type-badge">{TEMPLATE_TYPE_LABELS[templateType]}</span>
                    <span className="hint">
                      A template keeps the format it was written in — converting one would either lose the
                      original or produce something nobody wrote. Make a new template to use another format.
                    </span>
                  </div>
                ) : (
                  <div className="type-picker">
                    {(["plain", "json", "typescript"] as TemplateType[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={templateType === t ? "active" : ""}
                        onClick={() => chooseType(t)}
                        title={
                          t === "typescript"
                            ? "Advanced template definition. Saved and validated, but not executed by this build."
                            : "Executable — a group can run this."
                        }
                      >
                        {TEMPLATE_TYPE_LABELS[t]}
                      </button>
                    ))}
                  </div>
                )}
                <div className="hint">
                  Plain-English and JSON are <strong>executable</strong>. TypeScript is an advanced template
                  definition: it is saved, validated and inspectable, but this build does not execute it.
                </div>
              </div>

              <div className="form-row">
                <label>Template name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={templateType === "json" ? "Portal login" : "Join meeting"}
                />
              </div>

              {templateType === "plain" && (
                <div className="form-row">
                  <label>Steps (one per line)</label>
                  <textarea rows={9} value={steps} onChange={(e) => setSteps(e.target.value)} />
                  <StepReference />
                </div>
              )}

              {templateType === "json" && (
                <div className="form-row">
                  <label>JSON workflow</label>
                  <textarea
                    className="code-editor"
                    rows={16}
                    spellCheck={false}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                  {liveJsonError ? (
                    <div className="editor-status bad">{liveJsonError}</div>
                  ) : (
                    body.trim() && <div className="editor-status ok">Valid JSON</div>
                  )}
                  <div className="hint">
                    Steps are objects with a <code>type</code> and, where they act on something, a{" "}
                    <code>target</code>. A target can be a plain string, <code>{`{ "label": "Email" }`}</code>,{" "}
                    <code>{`{ "role": "button", "name": "Login" }`}</code>, or a <code>strategies</code> list
                    tried in order. Invalid JSON cannot be saved.
                  </div>
                </div>
              )}

              {templateType === "typescript" && (
                <div className="form-row">
                  <label>TypeScript</label>
                  <textarea
                    className="code-editor"
                    rows={16}
                    spellCheck={false}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                  <div className="editor-status warn">
                    Saved and checked, but not executed by this build. Running untrusted TypeScript needs an
                    isolated runtime, which is not part of this phase — use Plain-English or JSON for anything
                    that has to run.
                  </div>
                </div>
              )}
            </div>

            {/* The portal config is optional on every template: a portal's
                login workflow and its quiz selectors are usually one
                template, so it belongs here rather than in a separate
                "quiz template" concept. */}
            <details className="group-task" open={showPortal} onToggle={(e) => setShowPortal(e.currentTarget.open)}>
              <summary>Assessment / quiz selectors (optional)</summary>
              <PortalConfigEditor value={assessment} onChange={setAssessment} />
            </details>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={requestClose} disabled={busy}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save template"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Reusable step scripts — for a group's Task (e.g. "Join meeting"), and
 * one special one ("Auto login") that IS the script "Add user" runs to
 * capture a Microsoft/Teams login (see packages/api/src/routes/users.ts,
 * which reads this template by a fixed id on every launch). */
export function TemplatesSettings() {
  const [templates, setTemplates] = useState<StepTemplate[]>([]);
  // The last chosen filter is remembered, because "I work in JSON" is a
  // standing fact about a person, not a per-visit decision.
  const [filter, setFilter] = useState<TemplateTypeFilter>(() => {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY);
    return saved === "plain" || saved === "json" || saved === "typescript" ? saved : "all";
  });
  const [modal, setModal] = useState<"new" | StepTemplate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Fetched unfiltered and filtered below: the counts on the filter
      // buttons have to be right, and a second request per button would be
      // four requests to render one row of buttons.
      const res = await api.listTemplates();
      setTemplates(res.templates);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(FILTER_STORAGE_KEY, filter);
  }, [filter]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: templates.length, plain: 0, json: 0, typescript: 0 };
    for (const t of templates) map[t.templateType] = (map[t.templateType] ?? 0) + 1;
    return map;
  }, [templates]);

  const visible = useMemo(
    () => (filter === "all" ? templates : templates.filter((t) => t.templateType === filter)),
    [templates, filter],
  );

  /** Clicking the badge of a template that already holds the scope clears
   * it — the same control both sets and unsets, so there is never a
   * separate "remove default" button to hunt for. */
  async function toggleDefault(t: StepTemplate, scope: TemplateScope) {
    setBusy(t.id);
    setError(null);
    try {
      await api.setDefaultTemplate(scope, t.defaultFor === scope ? null : t.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(t: StepTemplate) {
    const warning =
      t.defaultFor
        ? `Delete "${t.name}"? It is currently the ${t.defaultFor === "group" ? "group" : "user"} default — deleting it falls back to the built-in behaviour until you pick another.`
        : t.id === AUTO_LOGIN_TEMPLATE_ID
          ? `Delete "${t.name}"? This is the script "Add user" runs to sign someone in — deleting it falls back to a built-in default.`
          : `Delete template "${t.name}"? Groups already using it keep their own copy of the steps.`;
    if (!confirm(warning)) return;
    setBusy(t.id);
    try {
      await api.deleteTemplate(t.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Templates</h2>
          <span className="hint">
            Reusable step scripts. Mark one as the default for groups and one for users — those are used
            automatically everywhere, and can still be changed on the spot.
          </span>
        </div>
        <div className="job-toolbar-actions">
          <button className="primary" onClick={() => setModal("new")}>
            + Add template
          </button>
        </div>
      </div>

      {/* Template type, at the top, as a filter over the list below. */}
      <div className="type-filter">
        <span className="type-filter-label">Template type</span>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? "active" : ""}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <span className="count">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {filter === "typescript" && (
        <div className="editor-status warn" style={{ marginBottom: 14 }}>
          TypeScript templates are advanced definitions — saved, validated and inspectable, but not executed by
          this build. A group cannot be pointed at one. Use Plain-English or JSON for anything that has to run.
        </div>
      )}

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {loaded && templates.length === 0 && <div className="empty-state">No templates yet.</div>}
      {loaded && templates.length > 0 && visible.length === 0 && (
        <div className="empty-state">
          No {TEMPLATE_TYPE_LABELS[filter as TemplateType]} templates yet.
          <br />
          <button style={{ marginTop: 12 }} onClick={() => setModal("new")}>
            + Add one
          </button>
        </div>
      )}

      <div className="group-list">
        {visible.map((t) => (
          <div className="card session-box" key={t.id}>
            <div className="session-head">
              <span className="name">{t.name}</span>
              <div className="template-badges">
                <span className={`template-type-badge type-${t.templateType}`}>
                  {TEMPLATE_TYPE_LABELS[t.templateType]}
                </span>
                {SCOPES.filter((s) => t.defaultFor === s.scope).map((s) => (
                  <span className="template-default-badge" key={s.scope} title={s.explains}>
                    ★ {s.badge}
                  </span>
                ))}
              </div>
            </div>
            <div className="group-meta">
              <span>
                {t.templateType === "typescript"
                  ? "TypeScript source"
                  : `${t.steps.length} step${t.steps.length === 1 ? "" : "s"}`}
              </span>
              {/* Said on the card, not only inside the editor: the list is
                  where somebody decides which template to point a group at,
                  and a definition that cannot run must not look like one
                  that can. */}
              {t.templateType === "typescript" ? (
                <span
                  className="mini-chip"
                  title="Definitions are saved and validated. This build cannot execute TypeScript — use Plain-English or JSON for anything that has to run."
                >
                  definition only · not executable
                </span>
              ) : (
                <span className="mini-chip on" title="This template can be run by a group.">
                  executable
                </span>
              )}
              {t.assessment && <span className="mini-chip on">quiz selectors</span>}
              {t.id === AUTO_LOGIN_TEMPLATE_ID && <span className="hint">seeded sign-in script</span>}
            </div>
            <div className="session-controls">
              {SCOPES.map((s) => (
                <button
                  key={s.scope}
                  className={t.defaultFor === s.scope ? "control-on" : ""}
                  // A TypeScript template cannot run in this build, so it
                  // cannot be a default — that would break both the group
                  // Task and the sign-in flow the moment it was picked.
                  disabled={busy === t.id || t.templateType === "typescript"}
                  title={
                    t.templateType === "typescript"
                      ? "A TypeScript template cannot be a default while this build cannot execute one."
                      : t.defaultFor === s.scope
                        ? `Stop using "${t.name}" as the ${s.scope} default.`
                        : `${s.label}. ${s.explains}`
                  }
                  onClick={() => void toggleDefault(t, s.scope)}
                >
                  {t.defaultFor === s.scope ? `★ ${s.label}` : `☆ ${s.label}`}
                </button>
              ))}
              <button disabled={busy === t.id} onClick={() => setModal(t)}>
                Edit
              </button>
              <button className="danger" disabled={busy === t.id} onClick={() => void remove(t)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {modal && (
        <TemplateModal
          template={modal === "new" ? undefined : modal}
          initialType={filter === "all" ? "plain" : filter}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
