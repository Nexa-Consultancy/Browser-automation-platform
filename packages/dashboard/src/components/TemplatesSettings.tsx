import { useCallback, useEffect, useRef, useState } from "react";
import type { StepTemplate, TemplateScope } from "../types";
import * as api from "../api";
import { StepReference } from "./StepReference";

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

function TemplateModal({
  template,
  onClose,
  onSaved,
}: {
  template?: StepTemplate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!template;
  const [name, setName] = useState(template?.name ?? "");
  const [steps, setSteps] = useState(template?.steps.join("\n") ?? "");
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Template name is required.");
    if (!steps.trim()) return setError("At least one step is required.");

    setBusy(true);
    try {
      if (editing) await api.updateTemplate(template!.id, { name, steps });
      else await api.createTemplate({ name, steps });
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
        <form className="form-grid" onSubmit={submit} onChange={() => setDirty(true)}>
          {error && <div className="error-banner">{error}</div>}
          <div className="form-section">
            <div className="form-row">
              <label>Template name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Join meeting" />
            </div>
            <div className="form-row">
              <label>Steps (one per line)</label>
              <textarea rows={8} value={steps} onChange={(e) => setSteps(e.target.value)} />
              <StepReference />
            </div>
          </div>
          <div className="form-section modal-actions">
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
  const [modal, setModal] = useState<"new" | StepTemplate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
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

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {loaded && templates.length === 0 && <div className="empty-state">No templates yet.</div>}

      <div className="group-list">
        {templates.map((t) => (
          <div className="card session-box" key={t.id}>
            <div className="session-head">
              <span className="name">{t.name}</span>
              {SCOPES.filter((s) => t.defaultFor === s.scope).map((s) => (
                <span className="template-default-badge" key={s.scope} title={s.explains}>
                  ★ {s.badge}
                </span>
              ))}
            </div>
            <div className="group-meta">
              <span>
                {t.steps.length} step{t.steps.length === 1 ? "" : "s"}
              </span>
              {t.id === AUTO_LOGIN_TEMPLATE_ID && <span className="hint">seeded sign-in script</span>}
            </div>
            <div className="session-controls">
              {SCOPES.map((s) => (
                <button
                  key={s.scope}
                  className={t.defaultFor === s.scope ? "control-on" : ""}
                  disabled={busy === t.id}
                  title={
                    t.defaultFor === s.scope
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
