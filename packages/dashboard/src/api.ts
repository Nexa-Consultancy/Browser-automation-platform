import type { DailyReport, GroupWithSchedule, Job, PlatformUser, RunHistoryRow, SessionRow, StepTemplate } from "./types";

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
  userIds: string[]; // linked PlatformUsers, additive to userNames
  startTime: string; // "HH:MM" — when the thing you're automating happens
  endTime: string; // "HH:MM"
  leadMinutes: number; // start this many minutes before startTime
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

/** Full edit of a saved group — replaces prompt, roster, window and days
 * while keeping the group's identity and run history. */
export async function updateGroup(id: string, input: CreateGroupInput): Promise<{ group: GroupWithSchedule }> {
  return json(
    await fetch(`${API_BASE}/api/groups/${id}`, {
      method: "PUT",
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

// ---------- history / daily reports ----------

export async function getHistory(): Promise<{
  runs: (RunHistoryRow & { localDate: string })[];
  daily: DailyReport[];
  serverTimezone: string;
}> {
  return json(await fetch(`${API_BASE}/api/history`));
}

// ---------- settings / logs / egress ----------

export interface SystemLog {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  source: string;
  message: string;
  errorTrace: string | null;
  jobId: string | null;
  sessionId: string | null;
  userName: string | null;
  groupName: string | null;
  alertSent: boolean;
  alertError: string | null;
  createdAt: string;
}

export interface EgressInfo {
  ip: string | null;
  city: string;
  region: string;
  country: string;
  proxied: boolean;
  error?: string;
}

export async function getSettings(): Promise<{ settings: Record<string, string>; serverTimezone: string }> {
  return json(await fetch(`${API_BASE}/api/settings`));
}

export async function saveSettings(patch: Record<string, string>): Promise<{ settings: Record<string, string> }> {
  return json(
    await fetch(`${API_BASE}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function testEmail(): Promise<{ ok: boolean; error?: string }> {
  return json(await fetch(`${API_BASE}/api/settings/test-email`, { method: "POST" }));
}

export async function testDiscord(): Promise<{ ok: boolean; error?: string }> {
  return json(await fetch(`${API_BASE}/api/settings/test-discord`, { method: "POST" }));
}

export async function testTelegram(): Promise<{ ok: boolean; error?: string }> {
  return json(await fetch(`${API_BASE}/api/settings/test-telegram`, { method: "POST" }));
}

/** Chats the Telegram bot can currently see (only chats it's already
 * received a message in) — lets the settings page offer a pick list
 * instead of making someone copy a raw chat id out of JSON. */
export async function telegramChats(): Promise<
  { ok: true; chats: { id: string; title: string }[] } | { ok: false; error: string }
> {
  return json(await fetch(`${API_BASE}/api/settings/telegram-chats`));
}

export async function getLogs(level?: string): Promise<{ logs: SystemLog[] }> {
  const q = level ? `?level=${encodeURIComponent(level)}` : "";
  return json(await fetch(`${API_BASE}/api/logs${q}`));
}

export async function getEgressInfo(): Promise<EgressInfo> {
  return json(await fetch(`${API_BASE}/api/system/egress-info`));
}

// ---------- global stop-all / resume ----------

export async function getSystemStatus(): Promise<{ paused: boolean }> {
  return json(await fetch(`${API_BASE}/api/system/status`));
}

/** Stops every browser session running anywhere and pauses the scheduler
 * until resumeAll() is called. */
export async function stopAllNow(): Promise<{ ok: boolean; stoppedGroups: number; stoppedJobs: number }> {
  return json(await fetch(`${API_BASE}/api/system/stop-all`, { method: "POST" }));
}

export async function resumeAll(): Promise<void> {
  await json(await fetch(`${API_BASE}/api/system/resume`, { method: "POST" }));
}

/** Wipe a group's saved browser profiles (cookies/logins). Next run starts
 * signed out. Refused while the group has a run in progress. */
export async function clearGroupProfiles(id: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/groups/${id}/clear-profiles`, { method: "POST" }));
}

// ---------- shared Teams master login ----------

export async function teamsLoginStatus(): Promise<{ signedIn: boolean }> {
  return json(await fetch(`${API_BASE}/api/teams-login/status`));
}

/** Start the one-time master sign-in run; returns the job to open and drive. */
export async function startTeamsLogin(): Promise<{ jobId: string }> {
  return json(await fetch(`${API_BASE}/api/teams-login/start`, { method: "POST" }));
}

export async function clearTeamsLogin(): Promise<void> {
  await json(await fetch(`${API_BASE}/api/teams-login/clear`, { method: "POST" }));
}

/** Seed every user in a group from the master login. */
export async function applyMasterToGroup(id: string): Promise<{ seeded: number }> {
  return json(await fetch(`${API_BASE}/api/groups/${id}/apply-master`, { method: "POST" }));
}

/** Upload a captured Teams session (Playwright storageState JSON) so the
 * server bakes it into the master profile. */
export async function importTeamsLogin(file: File): Promise<{ ok: boolean; message?: string }> {
  const form = new FormData();
  form.set("file", file);
  return json(await fetch(`${API_BASE}/api/teams-login/import`, { method: "POST", body: form }));
}

// ---------- reusable users, each with their own real Teams login ----------

export async function listUsers(): Promise<{ users: PlatformUser[] }> {
  return json(await fetch(`${API_BASE}/api/users`));
}

/** Creates the user and launches their sign-in run; returns the job to open
 * and drive (auto-fills email/password, then waits for 2FA by hand). */
export async function createUser(input: { name: string; email: string; password: string }): Promise<{
  user: PlatformUser;
  jobId: string;
}> {
  return json(
    await fetch(`${API_BASE}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** Update name/email, and optionally rotate the password (re-runs sign-in
 * when a new password is given — jobId is null when it wasn't). */
export async function updateUser(
  id: string,
  input: { name: string; email: string; password?: string },
): Promise<{ user: PlatformUser; jobId: string | null }> {
  return json(
    await fetch(`${API_BASE}/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** Re-run sign-in with the already-stored password (session expired). */
export async function reloginUser(id: string): Promise<{ jobId: string }> {
  return json(await fetch(`${API_BASE}/api/users/${id}/relogin`, { method: "POST" }));
}

export async function clearUserProfile(id: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/users/${id}/clear-profile`, { method: "POST" }));
}

export async function deleteUser(id: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/users/${id}`, { method: "DELETE" }));
}

// ---------- reusable step templates ----------

export async function listTemplates(): Promise<{ templates: StepTemplate[] }> {
  return json(await fetch(`${API_BASE}/api/templates`));
}

export async function createTemplate(input: { name: string; steps: string }): Promise<{ template: StepTemplate }> {
  return json(
    await fetch(`${API_BASE}/api/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateTemplate(
  id: string,
  input: { name: string; steps: string },
): Promise<{ template: StepTemplate }> {
  return json(
    await fetch(`${API_BASE}/api/templates/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteTemplate(id: string): Promise<void> {
  await json(await fetch(`${API_BASE}/api/templates/${id}`, { method: "DELETE" }));
}
