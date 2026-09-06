import { useCallback, useEffect, useState } from "react";
import * as api from "../api";

/** Shown in place of a stored secret. The server never sends the real one
 * back, and sending this marker in means "leave it as it is" — the same
 * convention the proxy and SMTP passwords already use. */
const SECRET_MARKER = "__SET__";

const PROVIDERS: { id: string; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  // The same wire format every serious local runner speaks (Ollama, vLLM,
  // LM Studio, llama.cpp), which is why "a local model later" is a base URL
  // rather than a provider still to be written.
  { id: "openai_compatible", label: "OpenAI-compatible endpoint (incl. local models)" },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/**
 * Assessment AI — which models answer questions, and when to ask a second.
 *
 * Lives inside the existing Settings page, alongside Integrations and
 * Advanced, because it is the same kind of thing: server-side configuration
 * that applies to every run. The API key is handled exactly like the proxy
 * and SMTP passwords — never sent to the browser, and a blank field means
 * "leave it alone" rather than "wipe it".
 */
export function AssessmentAISettings() {
  const [s, setS] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getAssessmentSettings();
      setS(res.settings);
      setReady(res.ready);
      setMissing(res.missing);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set(key: string, value: string) {
    setS((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.saveAssessmentSettings(s);
      setS(res.settings);
      setReady(res.ready);
      setMissing(res.missing);
      setMsg({ kind: "ok", text: "Assessment AI settings saved." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <div className="empty-state">Loading…</div>;

  const on = (k: string) => s[k] === "true";
  const fallbackOn = on("ASSESSMENT_AI_FALLBACK_ENABLED");

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Assessment AI</h2>
          <span className="hint">Which model answers quiz questions, and when a second opinion is worth it.</span>
        </div>
        <div className="job-toolbar-actions">
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>

      {msg && (
        <div className={msg.kind === "ok" ? "ok-banner" : "error-banner"} style={{ marginBottom: 16 }}>
          {msg.text}
        </div>
      )}

      {/* Said here rather than discovered at 2 PM. */}
      {!ready && missing.length > 0 && (
        <div className="editor-status warn" style={{ marginBottom: 16 }}>
          Quizzes cannot run yet — {missing.join("; ")}.
        </div>
      )}

      <div className="settings-grid">
        <div className="card form-grid">
          <div className="form-section">
            <div className="eyebrow">Primary model</div>

            <label className="switch-row">
              <input
                type="checkbox"
                checked={on("ASSESSMENT_AI_ENABLED")}
                onChange={(e) => set("ASSESSMENT_AI_ENABLED", String(e.target.checked))}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-knob" />
              </span>
              <span className="switch-text">
                <strong>Answer quiz questions with AI</strong>
                <span className="hint">
                  Off means an assessment group refuses to start rather than opening browsers it cannot use.
                </span>
              </span>
            </label>

            <div className="form-two-col">
              <Field label="Provider">
                <select
                  value={s.ASSESSMENT_AI_PROVIDER ?? "openai"}
                  onChange={(e) => set("ASSESSMENT_AI_PROVIDER", e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
                <input
                  type="text"
                  value={s.ASSESSMENT_AI_MODEL ?? ""}
                  onChange={(e) => set("ASSESSMENT_AI_MODEL", e.target.value)}
                  placeholder="gpt-4o-mini"
                />
              </Field>
            </div>

            <Field
              label="API key"
              hint="Stored server-side and never sent back to this page. Leave blank to keep the key you already saved."
            >
              <input
                type="password"
                autoComplete="new-password"
                value={s.ASSESSMENT_AI_API_KEY === SECRET_MARKER ? "" : (s.ASSESSMENT_AI_API_KEY ?? "")}
                placeholder={s.ASSESSMENT_AI_API_KEY === SECRET_MARKER ? "•••••••• (saved)" : ""}
                onChange={(e) => set("ASSESSMENT_AI_API_KEY", e.target.value)}
              />
            </Field>

            <div className="form-two-col">
              <Field
                label="Base URL"
                hint="Only for an OpenAI-compatible endpoint — a local model server, or another vendor speaking the same API."
              >
                <input
                  type="text"
                  value={s.ASSESSMENT_AI_BASE_URL ?? ""}
                  onChange={(e) => set("ASSESSMENT_AI_BASE_URL", e.target.value)}
                  placeholder="http://localhost:11434/v1"
                />
              </Field>
              <Field label="Temperature" hint="0 is right for multiple choice — the same question should get the same answer.">
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={s.ASSESSMENT_AI_TEMPERATURE ?? "0"}
                  onChange={(e) => set("ASSESSMENT_AI_TEMPERATURE", e.target.value)}
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="card form-grid">
          <div className="form-section">
            <div className="eyebrow">Fallback model</div>

            <label className="switch-row">
              <input
                type="checkbox"
                checked={fallbackOn}
                onChange={(e) => set("ASSESSMENT_AI_FALLBACK_ENABLED", String(e.target.checked))}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-knob" />
              </span>
              <span className="switch-text">
                <strong>Ask a second model when the first is unsure</strong>
                <span className="hint">
                  With no fallback, a low-confidence answer is still used — leaving a question blank on the
                  strength of a self-reported number would be worse.
                </span>
              </span>
            </label>

            {fallbackOn && (
              <>
                <div className="form-two-col">
                  <Field label="Provider">
                    <select
                      value={s.ASSESSMENT_AI_FALLBACK_PROVIDER ?? "anthropic"}
                      onChange={(e) => set("ASSESSMENT_AI_FALLBACK_PROVIDER", e.target.value)}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Model">
                    <input
                      type="text"
                      value={s.ASSESSMENT_AI_FALLBACK_MODEL ?? ""}
                      onChange={(e) => set("ASSESSMENT_AI_FALLBACK_MODEL", e.target.value)}
                      placeholder="claude-sonnet-5"
                    />
                  </Field>
                </div>

                <Field label="API key" hint="Leave blank to reuse the primary key — normal when both models are the same vendor.">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={
                      s.ASSESSMENT_AI_FALLBACK_API_KEY === SECRET_MARKER
                        ? ""
                        : (s.ASSESSMENT_AI_FALLBACK_API_KEY ?? "")
                    }
                    placeholder={s.ASSESSMENT_AI_FALLBACK_API_KEY === SECRET_MARKER ? "•••••••• (saved)" : ""}
                    onChange={(e) => set("ASSESSMENT_AI_FALLBACK_API_KEY", e.target.value)}
                  />
                </Field>

                <Field label="Base URL" hint="Only for an OpenAI-compatible endpoint.">
                  <input
                    type="text"
                    value={s.ASSESSMENT_AI_FALLBACK_BASE_URL ?? ""}
                    onChange={(e) => set("ASSESSMENT_AI_FALLBACK_BASE_URL", e.target.value)}
                  />
                </Field>
              </>
            )}
          </div>
        </div>

        <div className="card form-grid">
          <div className="form-section">
            <div className="eyebrow">Routing and limits</div>

            <Field
              label="Confidence threshold"
              hint="Below this, the question goes to the fallback. Treat it as a routing signal — a model's self-reported confidence is not a calibrated probability."
            >
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={s.ASSESSMENT_AI_CONFIDENCE_THRESHOLD ?? "0.7"}
                onChange={(e) => set("ASSESSMENT_AI_CONFIDENCE_THRESHOLD", e.target.value)}
              />
            </Field>

            <div className="form-two-col">
              <Field label="Retries per model" hint="For a rate limit, a dropped connection, or a reply that wasn't valid JSON.">
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={s.ASSESSMENT_AI_MAX_RETRIES ?? "2"}
                  onChange={(e) => set("ASSESSMENT_AI_MAX_RETRIES", e.target.value)}
                />
              </Field>
              <Field label="Timeout (ms)">
                <input
                  type="number"
                  min={1000}
                  max={300000}
                  step={1000}
                  value={s.ASSESSMENT_AI_TIMEOUT_MS ?? "30000"}
                  onChange={(e) => set("ASSESSMENT_AI_TIMEOUT_MS", e.target.value)}
                />
              </Field>
            </div>

            <div className="form-two-col">
              <Field
                label="AI concurrency"
                hint="Questions in flight with a provider at once, across every session on a worker. This is a rate-limit number."
              >
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={s.ASSESSMENT_AI_CONCURRENCY ?? "4"}
                  onChange={(e) => set("ASSESSMENT_AI_CONCURRENCY", e.target.value)}
                />
              </Field>
              <Field
                label="Browser concurrency"
                hint="Assessment browsers open at once per worker. A separate number because this one is about this machine's memory, not somebody else's rate limit."
              >
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={s.ASSESSMENT_BROWSER_CONCURRENCY ?? "4"}
                  onChange={(e) => set("ASSESSMENT_BROWSER_CONCURRENCY", e.target.value)}
                />
              </Field>
            </div>

            <label className="switch-row">
              <input
                type="checkbox"
                checked={s.ASSESSMENT_AI_STORE_REASONS !== "false"}
                onChange={(e) => set("ASSESSMENT_AI_STORE_REASONS", String(e.target.checked))}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-knob" />
              </span>
              <span className="switch-text">
                <strong>Keep the model's stated reason with each question</strong>
                <span className="hint">
                  Useful for working out why an answer was wrong. Turn it off if storing generated text about
                  assessment content is a concern — the answer, confidence and timings are kept either way.
                </span>
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
