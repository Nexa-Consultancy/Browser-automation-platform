import type { Group } from "@automation/shared";
import { pool } from "./pool.js";

interface GroupDbRow {
  id: string;
  name: string;
  target_url: string;
  steps: string[];
  user_names: string[];
  start_time: string;
  end_time: string;
  lead_minutes: number;
  days: number[];
  timezone: string;
  enabled: boolean;
  active_job_id: string | null;
  active_job_manual: boolean;
  last_occurrence_key: string | null;
  last_started_at: Date | null;
  last_stopped_at: Date | null;
  created_at: Date;
}

function toGroup(r: GroupDbRow): Group {
  return {
    id: r.id,
    name: r.name,
    targetUrl: r.target_url,
    steps: r.steps,
    userNames: r.user_names,
    startTime: r.start_time,
    endTime: r.end_time,
    leadMinutes: r.lead_minutes,
    days: r.days,
    timezone: r.timezone,
    enabled: r.enabled,
    activeJobId: r.active_job_id,
    activeRunIsManual: r.active_job_manual,
    lastOccurrenceKey: r.last_occurrence_key,
    lastStartedAt: r.last_started_at?.toISOString() ?? null,
    lastStoppedAt: r.last_stopped_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createGroup(input: {
  name: string;
  targetUrl: string;
  steps: string[];
  userNames: string[];
  startTime: string;
  endTime: string;
  leadMinutes: number;
  days: number[];
  timezone: string;
  enabled: boolean;
}): Promise<Group> {
  const { rows } = await pool.query<GroupDbRow>(
    `INSERT INTO groups (name, target_url, steps, user_names, start_time, end_time, lead_minutes, days, timezone, enabled)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10)
     RETURNING *`,
    [
      input.name,
      input.targetUrl,
      JSON.stringify(input.steps),
      JSON.stringify(input.userNames),
      input.startTime,
      input.endTime,
      input.leadMinutes,
      JSON.stringify(input.days),
      input.timezone,
      input.enabled,
    ],
  );
  return toGroup(rows[0]);
}

/**
 * Edits a group in place. Everything except the run-tracking columns is
 * replaceable, so a saved group keeps its identity (and its place in the
 * list) while its prompt, roster or window change — the point being that a
 * group stays exactly as configured until someone deliberately changes it.
 *
 * Note it does NOT touch last_occurrence_key: editing a group mid-window
 * shouldn't silently re-fire a window that already ran today.
 */
export async function updateGroup(
  id: string,
  input: {
    name: string;
    targetUrl: string;
    steps: string[];
    userNames: string[];
    startTime: string;
    endTime: string;
    leadMinutes: number;
    days: number[];
    timezone: string;
    enabled: boolean;
  },
): Promise<Group | null> {
  const { rows } = await pool.query<GroupDbRow>(
    `UPDATE groups
        SET name = $2, target_url = $3, steps = $4::jsonb, user_names = $5::jsonb,
            start_time = $6, end_time = $7, days = $8::jsonb, timezone = $9, enabled = $10,
            lead_minutes = $11
      WHERE id = $1
      RETURNING *`,
    [
      id,
      input.name,
      input.targetUrl,
      JSON.stringify(input.steps),
      JSON.stringify(input.userNames),
      input.startTime,
      input.endTime,
      JSON.stringify(input.days),
      input.timezone,
      input.enabled,
      input.leadMinutes,
    ],
  );
  return rows[0] ? toGroup(rows[0]) : null;
}

export async function listGroups(): Promise<Group[]> {
  const { rows } = await pool.query<GroupDbRow>(`SELECT * FROM groups ORDER BY created_at DESC LIMIT 200`);
  return rows.map(toGroup);
}

export async function getGroup(id: string): Promise<Group | null> {
  const { rows } = await pool.query<GroupDbRow>(`SELECT * FROM groups WHERE id = $1`, [id]);
  return rows[0] ? toGroup(rows[0]) : null;
}

export async function deleteGroup(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM groups WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function setGroupEnabled(id: string, enabled: boolean): Promise<Group | null> {
  const { rows } = await pool.query<GroupDbRow>(
    `UPDATE groups SET enabled = $2 WHERE id = $1 RETURNING *`,
    [id, enabled],
  );
  return rows[0] ? toGroup(rows[0]) : null;
}

/**
 * Claims this occurrence for the group and records the job it launched.
 *
 * The `last_occurrence_key IS DISTINCT FROM $3` guard is what makes the
 * scheduler safe to run in more than one API process: two ticks racing on
 * the same window both try this UPDATE, exactly one matches a row, and only
 * that one goes on to enqueue the job.
 */
export async function claimGroupOccurrence(
  id: string,
  jobId: string,
  occurrenceKey: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE groups
        SET active_job_id = $2, active_job_manual = false, last_occurrence_key = $3, last_started_at = now()
      WHERE id = $1
        AND active_job_id IS NULL
        AND last_occurrence_key IS DISTINCT FROM $3`,
    [id, jobId, occurrenceKey],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Marks a manual ("Run now") launch. Deliberately does not consume the day's
 * scheduled occurrence — the scheduled run still happens on time — and flags
 * the run as manual so the scheduler won't stop it on its next tick.
 */
export async function setGroupActiveJob(id: string, jobId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE groups SET active_job_id = $2, active_job_manual = true, last_started_at = now()
      WHERE id = $1 AND active_job_id IS NULL`,
    [id, jobId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Releases the run a group was holding open.
 *
 * `consumeOccurrenceKey` is the guard against a stopped run coming straight
 * back: a window fires once, so when a run ends early — someone hit Stop,
 * or it failed outright — the occurrence has to be marked used or the very
 * next scheduler tick would notice the window is still open and launch it
 * all over again. Pass null when the window has closed on its own (nothing
 * left to suppress).
 */
export async function releaseGroupRun(
  id: string,
  consumeOccurrenceKey: string | null,
  recordStop: boolean,
): Promise<void> {
  const sets = ["active_job_id = NULL", "active_job_manual = false"];
  const params: unknown[] = [id];
  if (consumeOccurrenceKey !== null) {
    sets.push(`last_occurrence_key = $${params.length + 1}`);
    params.push(consumeOccurrenceKey);
  }
  if (recordStop) sets.push("last_stopped_at = now()");
  await pool.query(`UPDATE groups SET ${sets.join(", ")} WHERE id = $1`, params);
}
