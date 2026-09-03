import { useState } from "react";
import * as api from "../api";
import { StepReference } from "./StepReference";

const STEP_PLACEHOLDER = `fill Email with {{email}}
fill Password with {{password}}
click Log in
wait for text "Welcome"
wait for video
click Continue`;

export function JobForm({ onCreated }: { onCreated: (jobId: string) => void }) {
  const [name, setName] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [steps, setSteps] = useState("");
  const [userCount, setUserCount] = useState(2);
  const [names, setNames] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameList = names
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!csvFile && nameList.length > 0 && nameList.length !== userCount) {
      setError(
        `You entered ${nameList.length} name(s) but "Number of users" is ${userCount} — enter exactly ${userCount} names (comma-separated), or clear the names field to use User 1, User 2, ...`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const { job } = await api.createJob({ name, targetUrl, steps, userCount, names, csvFile });
      onCreated(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      {error && <div className="error-banner">{error}</div>}

      <div className="form-section">
        <div className="eyebrow">Target</div>
        <div className="form-two-col">
          <div className="form-row">
            <label>Job name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Login smoke test"
            />
          </div>
          <div className="form-row">
            <label>Target URL</label>
            <input
              type="url"
              required
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://app.example.com/login"
            />
            <div className="hint">Opened automatically as the first step — no need to write "open" yourself.</div>
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="eyebrow">Users</div>
        <div className={csvFile ? "form-two-col" : "form-three-col"}>
          <div className="form-row">
            <label>Per-user CSV (optional)</label>
            <input type="file" accept=".csv" onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)} />
            <div className="hint">A "name"/"email"/etc. column per user.</div>
          </div>
          <div className="form-row">
            <label>{csvFile ? "User count (from CSV rows)" : "Number of users"}</label>
            <input
              type="number"
              min={1}
              max={200}
              value={userCount}
              disabled={!!csvFile}
              onChange={(e) => setUserCount(Number(e.target.value))}
            />
          </div>
          {!csvFile && (
            <div className="form-row">
              <label>Names (optional)</label>
              <input
                type="text"
                value={names}
                onChange={(e) => setNames(e.target.value)}
                placeholder={
                  userCount > 1
                    ? `e.g. Asha, Ravi${userCount > 2 ? ", Meera" : ""}${userCount > 3 ? ", ..." : ""} (${userCount} names)`
                    : "e.g. Asha"
                }
              />
              <div className="hint">
                Comma-separated, one per user — used for {"{{name}}"} in your steps. Leave blank for User 1, User 2,
                ...
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="form-section">
        <div className="eyebrow">Script</div>
        <div className="form-row">
          <label>Steps (plain English, one per line)</label>
          <textarea
            required
            rows={7}
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            placeholder={STEP_PLACEHOLDER}
          />
          <StepReference />
        </div>
      </div>

      <div className="form-section">
        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Starting…" : "▶ Start run"}
        </button>
      </div>
    </form>
  );
}
