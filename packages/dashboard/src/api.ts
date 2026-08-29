import type { Job, SessionRow } from "./types";

const API_BASE = ""; // same-origin in prod (nginx proxies /api); Vite dev server proxies /api too

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface CreateJobInput {
  name: string;
  targetUrl: string;
  steps: string;
  userCount: number;
  names: string; // comma-separated; takes priority over userCount when non-empty
  csvFile: File | null;
}

export async function createJob(input: CreateJobInput): Promise<{ job: Job; sessions: SessionRow[] }> {
  const form = new FormData();
  form.set("name", input.name);
  form.set("targetUrl", input.targetUrl);
  form.set("steps", input.steps);
  form.set("userCount", String(input.userCount));
  form.set("names", input.names);
  if (input.csvFile) form.set("csv", input.csvFile);

  const res = await fetch(`${API_BASE}/api/jobs`, { method: "POST", body: form });
  return json(res);
}

export async function listJobs(): Promise<{ jobs: Job[] }> {
  return json(await fetch(`${API_BASE}/api/jobs`));
}

export async function getJob(id: string): Promise<{ job: Job; sessions: SessionRow[] }> {
  return json(await fetch(`${API_BASE}/api/jobs/${id}`));
}

export async function stopAll(jobId: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/jobs/${jobId}/stop-all`, { method: "POST" }));
}

export async function appendStepsToJob(jobId: string, steps: string): Promise<void> {
  await json(
    await fetch(`${API_BASE}/api/jobs/${jobId}/steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps }),
    }),
  );
}

export async function stopSession(sessionId: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/sessions/${sessionId}/stop`, { method: "POST" }));
}

export async function appendStepsToSession(sessionId: string, steps: string): Promise<void> {
  await json(
    await fetch(`${API_BASE}/api/sessions/${sessionId}/steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps }),
    }),
  );
}
