import { pool } from "./pool.js";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface SystemLog {
  id: string;
  level: LogLevel;
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

interface LogDbRow {
  id: string;
  level: LogLevel;
  source: string;
  message: string;
  error_trace: string | null;
  job_id: string | null;
  session_id: string | null;
  user_name: string | null;
  group_name: string | null;
  alert_sent: boolean;
  alert_error: string | null;
  created_at: Date;
}

function toLog(r: LogDbRow): SystemLog {
  return {
    id: r.id,
    level: r.level,
    source: r.source,
    message: r.message,
    errorTrace: r.error_trace,
    jobId: r.job_id,
    sessionId: r.session_id,
    userName: r.user_name,
    groupName: r.group_name,
    alertSent: r.alert_sent,
    alertError: r.alert_error,
    createdAt: r.created_at.toISOString(),
  };
}

export async function writeLog(input: {
  level: LogLevel;
  source: string;
  message: string;
  errorTrace?: string | null;
  jobId?: string | null;
  sessionId?: string | null;
  userName?: string | null;
  groupName?: string | null;
}): Promise<SystemLog> {
  const { rows } = await pool.query<LogDbRow>(
    `INSERT INTO system_logs (level, source, message, error_trace, job_id, session_id, user_name, group_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.level,
      input.source,
      input.message,
      input.errorTrace ?? null,
      input.jobId ?? null,
      input.sessionId ?? null,
      input.userName ?? null,
      input.groupName ?? null,
    ],
  );
  return toLog(rows[0]);
}

export async function listLogs(opts: { level?: LogLevel; limit?: number } = {}): Promise<SystemLog[]> {
  const limit = Math.min(opts.limit ?? 300, 1000);
  const { rows } = opts.level
    ? await pool.query<LogDbRow>(
        `SELECT * FROM system_logs WHERE level = $1 ORDER BY created_at DESC LIMIT $2`,
        [opts.level, limit],
      )
    : await pool.query<LogDbRow>(`SELECT * FROM system_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows.map(toLog);
}

/** Records what happened to the alert email for a log line, so the Logs view
 * can show delivery status rather than leaving you guessing whether anyone
 * was actually told. */
export async function markAlert(id: string, sent: boolean, error?: string | null): Promise<void> {
  await pool.query(`UPDATE system_logs SET alert_sent = $2, alert_error = $3 WHERE id = $1`, [
    id,
    sent,
    error ?? null,
  ]);
}
