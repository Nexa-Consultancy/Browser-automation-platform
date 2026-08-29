import type { SessionRow, SessionStatus } from "@automation/shared";
import { pool } from "./pool.js";

interface SessionDbRow {
  id: string;
  job_id: string;
  user_index: number;
  user_name: string;
  row_data: Record<string, string>;
  status: SessionStatus;
  current_step_index: number;
  current_step_text: string | null;
  total_steps: number;
  error: string | null;
  video_wait_started_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

function toSession(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    jobId: r.job_id,
    userIndex: r.user_index,
    userName: r.user_name,
    rowData: r.row_data,
    status: r.status,
    currentStepIndex: r.current_step_index,
    currentStepText: r.current_step_text,
    totalSteps: r.total_steps,
    error: r.error,
    videoWaitStartedAt: r.video_wait_started_at?.toISOString() ?? null,
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createSessions(
  jobId: string,
  users: { userName: string; data: Record<string, string> }[],
  totalSteps: number,
): Promise<SessionRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created: SessionDbRow[] = [];
    for (let i = 0; i < users.length; i++) {
      const { rows } = await client.query<SessionDbRow>(
        `INSERT INTO sessions (job_id, user_index, user_name, row_data, status, total_steps)
         VALUES ($1, $2, $3, $4::jsonb, 'pending', $5)
         RETURNING *`,
        [jobId, i, users[i].userName, JSON.stringify(users[i].data), totalSteps],
      );
      created.push(rows[0]);
    }
    await client.query("COMMIT");
    return created.map(toSession);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const { rows } = await pool.query<SessionDbRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
  return rows[0] ? toSession(rows[0]) : null;
}

export async function listSessionsByJob(jobId: string): Promise<SessionRow[]> {
  const { rows } = await pool.query<SessionDbRow>(
    `SELECT * FROM sessions WHERE job_id = $1 ORDER BY user_index ASC`,
    [jobId],
  );
  return rows.map(toSession);
}

export async function updateSessionStatus(
  id: string,
  status: SessionStatus,
  extra: { error?: string | null; startedAt?: boolean; finishedAt?: boolean } = {},
): Promise<void> {
  const sets = ["status = $2"];
  const params: unknown[] = [id, status];
  let idx = 3;
  if (extra.error !== undefined) {
    sets.push(`error = $${idx++}`);
    params.push(extra.error);
  }
  if (extra.startedAt) sets.push(`started_at = now()`);
  if (extra.finishedAt) sets.push(`finished_at = now()`);
  await pool.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function updateSessionStep(
  id: string,
  stepIndex: number,
  stepText: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET current_step_index = $2, current_step_text = $3 WHERE id = $1`,
    [id, stepIndex, stepText],
  );
}

export async function setVideoWaitStarted(id: string, started: boolean): Promise<void> {
  await pool.query(
    `UPDATE sessions SET video_wait_started_at = ${started ? "now()" : "NULL"} WHERE id = $1`,
    [id],
  );
}

export async function bumpTotalSteps(id: string, addedCount: number): Promise<void> {
  await pool.query(`UPDATE sessions SET total_steps = total_steps + $2 WHERE id = $1`, [id, addedCount]);
}
