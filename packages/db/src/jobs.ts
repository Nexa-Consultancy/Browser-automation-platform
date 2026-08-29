import type { Job, JobStatus } from "@automation/shared";
import { pool } from "./pool.js";

interface JobRow {
  id: string;
  name: string;
  target_url: string;
  steps: string[];
  concurrency: number;
  status: JobStatus;
  group_id: string | null;
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
    createdAt: r.created_at.toISOString(),
  };
}

export async function createJob(input: {
  name: string;
  targetUrl: string;
  steps: string[];
  concurrency: number;
  /** Set when a scheduled group launched this run, so the dashboard can
   * trace a job back to the group that spawned it. */
  groupId?: string | null;
}): Promise<Job> {
  const { rows } = await pool.query<JobRow>(
    `INSERT INTO jobs (name, target_url, steps, concurrency, status, group_id)
     VALUES ($1, $2, $3::jsonb, $4, 'pending', $5)
     RETURNING *`,
    [input.name, input.targetUrl, JSON.stringify(input.steps), input.concurrency, input.groupId ?? null],
  );
  return toJob(rows[0]);
}

export async function getJob(id: string): Promise<Job | null> {
  const { rows } = await pool.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listJobs(): Promise<Job[]> {
  const { rows } = await pool.query<JobRow>(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100`);
  return rows.map(toJob);
}

export async function setJobStatus(id: string, status: JobStatus): Promise<void> {
  await pool.query(`UPDATE jobs SET status = $2 WHERE id = $1`, [id, status]);
}
