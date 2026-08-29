import type { GroupWithSchedule, Job, SessionRow } from "./types";

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

// ---------- scheduled groups ----------

export interface CreateGroupInput {
  name: string;
  targetUrl: string;
  steps: string;
  userNames: string[];
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  days: number[]; // 0 = Sunday ... 6 = Saturday
  timezone: string;
  enabled: boolean; // "follow this schedule automatically"
}

export async function listGroups(): Promise<{ groups: GroupWithSchedule[]; serverTimezone: string }> {
  return json(await fetch(`${API_BASE}/api/groups`));
}

export async function createGroup(input: CreateGroupInput): Promise<{ group: GroupWithSchedule }> {
  return json(
    await fetch(`${API_BASE}/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function setGroupEnabled(id: string, enabled: boolean): Promise<void> {
  await json(
    await fetch(`${API_BASE}/api/groups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  );
}

export async function deleteGroup(id: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/groups/${id}`, { method: "DELETE" }));
}

/** "Join now" — start a group's run immediately without waiting for its
 * window. The scheduled run still happens on time, and the scheduler won't
 * stop a run started this way. Resolves to the new job's id. */
export async function runGroupNow(id: string): Promise<{ jobId: string }> {
  return json(await fetch(`${API_BASE}/api/groups/${id}/run-now`, { method: "POST" }));
}

export async function stopGroupNow(id: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/groups/${id}/stop-now`, { method: "POST" }));
}
