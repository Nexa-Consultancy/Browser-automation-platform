import type { AssessmentPortalConfig, Job, JobKind, JobStatus, WorkflowStep } from "@automation/shared";
import { pool } from "./pool.js";

interface JobRow {
  id: string;
  name: string;
  target_url: string;
  steps: WorkflowStep[];
  concurrency: number;
  status: JobStatus;
  group_id: string | null;
  kind: JobKind | null;
  assessment: AssessmentPortalConfig | null;
  created_at: Date;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    name: r.name,
    targetUrl: r.target_url,
    steps: r.steps,
    concurrency: r.concurrency,
    status: r.status,
    groupId: r.group_id ?? null,
    // Every run that predates the column is ordinary automation, which is
    // what it was.
    kind: r.kind ?? "automation",
    assessment: r.assessment ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createJob(input: {
  name: string;
  targetUrl: string;
  steps: WorkflowStep[];
  concurrency: number;
  /** Which runner in the worker handles this. Defaults to the ordinary
   * step runner, so every existing caller is unchanged. */
  kind?: JobKind;
  /** For an assessment run: the portal config as it stands right now,
   * snapshotted so a template edit can't change a run already going. */
  assessment?: AssessmentPortalConfig | null;
  /** Set when a scheduled group launched this run, so the dashboard can
   * trace a job back to the group that spawned it. */
  groupId?: string | null;
  /** The workspace this run belongs to, so one tenant never sees
   * another's runs or history. */
  accountId?: string | null;
}): Promise<Job> {
  const { rows } = await pool.query<JobRow>(
    `INSERT INTO jobs (name, target_url, steps, concurrency, status, group_id, account_id, kind, assessment)
     VALUES ($1, $2, $3::jsonb, $4, 'pending', $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      input.name,
      input.targetUrl,
      JSON.stringify(input.steps),
      input.concurrency,
      input.groupId ?? null,
      input.accountId ?? null,
      input.kind ?? "automation",
      input.assessment ? JSON.stringify(input.assessment) : null,
    ],
  );
  return toJob(rows[0]);
}

export async function getJob(id: string): Promise<Job | null> {
  const { rows } = await pool.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listJobs(accountId: string): Promise<Job[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT * FROM jobs WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [accountId],
  );
  return rows.map(toJob);
}

export async function setJobStatus(id: string, status: JobStatus): Promise<void> {
  await pool.query(`UPDATE jobs SET status = $2 WHERE id = $1`, [id, status]);
}

/** Whether a run belongs to a workspace — the check behind the live view
 * and the WebSocket, so one tenant cannot watch another's browsers just by
 * knowing (or guessing) a job id. */
export async function jobBelongsToAccount(jobId: string, accountId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT true AS ok FROM jobs WHERE id = $1 AND account_id = $2`,
    [jobId, accountId],
  );
  return rows.length > 0;
}
