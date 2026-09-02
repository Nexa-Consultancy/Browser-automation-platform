import { useCallback, useEffect, useState } from "react";
import type { StepTemplate } from "../types";
import * as api from "../api";

/** Reusable step scripts for a group's Task — pick one instead of retyping
 * the same prompt (e.g. "Join meeting") every time a group is created. */
export function TemplatesSettings() {
  const [templates, setTemplates] = useState<StepTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listTemplates();
      setTemplates(res.templates);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function startNew() {
    setEditingId("new");
    setName("");
    setSteps("");
    setError(null);
  }

  function startEdit(t: StepTemplate) {
    setEditingId(t.id);
    setName(t.name);
    setSteps(t.steps.join("\n"));
    setError(null);
  }

  function cancel() {
    setEditingId(null);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (editingId === "new") await api.createTemplate({ name, steps });
      else if (editingId) await api.updateTemplate(editingId, { name, steps });
      setEditingId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: StepTemplate) {
    if (!confirm(`Delete template "${t.name}"? Groups already using it keep their own copy of the steps.`)) return;
    setBusy(true);
    try {
      await api.deleteTemplate(t.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form-grid">
      <div className="form-section">
        <div className="eyebrow">Step templates</div>
        <div className="hint">
          Saved scripts you can drop straight into a group's Task instead of retyping the same prompt every time —
          pick one from the dropdown when creating or editing a group.
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="name-grid" style={{ marginTop: 10 }}>
          {templates.map((t) => (
            <div className="form-row" key={t.id}>
              <label>{t.name}</label>
              <div className="hint" style={{ marginTop: 0 }}>
                {t.steps.length} step{t.steps.length === 1 ? "" : "s"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={busy} onClick={() => startEdit(t)}>
                  Edit
                </button>
                <button type="button" className="danger" disabled={busy} onClick={() => void remove(t)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>

        {editingId ? (
          <div className="form-section" style={{ marginTop: 14 }}>
            <div className="form-row">
              <label>Template name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Join meeting"
              />
            </div>
            <div className="form-row">
              <label>Steps (one per line)</label>
              <textarea rows={6} value={steps} onChange={(e) => setSteps(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button type="button" onClick={cancel} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Save template"}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" style={{ marginTop: 10 }} onClick={startNew}>
            + Add template
          </button>
        )}
      </div>
    </div>
  );
}
