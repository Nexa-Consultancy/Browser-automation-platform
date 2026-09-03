import {
  createJob,
  createSessions,
  listSessionsByJob,
  setJobStatus,
} from "@automation/db";
import { enqueueJob } from "@automation/queue";
import type { CsvUserRow, Job, SessionRow } from "@automation/shared";
import { publishControl } from "../pubsub.js";

const OPEN_STEP_RE = /^(open|go to|navigate to)\s+/i;

export function linesOf(text: string): string[] {
  return (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The Target URL is already given on the form — don't make anyone spell out
 * an "open" step for it too, unless they explicitly wrote their own.
 */
export function normalizeSteps(stepsText: string): string[] {
  const steps = linesOf(stepsText);
  if (steps.length === 0 || !OPEN_STEP_RE.test(steps[0])) {
    steps.unshift("open {{url}}");
  }
  return steps;
}

/**
 * The single path from "a URL + a step script + a roster of users" to a
 * live run. Both the manual dashboard form and the group scheduler go
 * through here, so a scheduled run is byte-for-byte the same kind of job as
 * one someone started by hand — same sessions, same events, same controls.
 */
export async function launchJob(input: {
  name: string;
  targetUrl: string;
  steps: string[];
  users: CsvUserRow[];
  groupId?: string | null;
  /** The workspace this run belongs to, so its history and live view stay
   * private to that account. */
  accountId?: string | null;
}): Promise<{ job: Job; sessions: SessionRow[] }> {
  const concurrency = Math.min(input.users.length, 50);
  const job = await createJob({
    name: input.name,
    targetUrl: input.targetUrl,
    steps: input.steps,
    concurrency,
    groupId: input.groupId ?? null,
    accountId: input.accountId ?? null,
  });
  const sessions = await createSessions(job.id, input.users, input.steps.length);
  await enqueueJob(job.id);
  return { job, sessions };
}

/**
 * Signals every still-live session in a job to close its browser.
 * "failed" is NOT terminal here: the worker deliberately keeps a failed
 * session's browser open (parked, fixable) until it's told to stop — see
 * packages/worker/src/runner.ts.
 */
export async function stopJob(jobId: string): Promise<number> {
  const sessions = await listSessionsByJob(jobId);
  let stopped = 0;
  for (const s of sessions) {
    if (!["completed", "stopped"].includes(s.status)) {
      await publishControl(s.id, { type: "stop" });
      stopped += 1;
    }
  }
  await setJobStatus(jobId, "stopped");
  return stopped;
}
