import type { RunHistoryRow } from "@automation/shared";
import { pool } from "./pool.js";

interface HistoryDbRow {
  id: string;
  name: string;
  target_url: string;
  status: RunHistoryRow["status"];
  group_id: string | null;
  group_name: string | null;
  user_names: string[] | null;
  session_count: string;
  completed: string;
  failed: string;
  stopped: string;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

/**
 * Every past run with its outcome rolled up in one query.
 *
 * The counts are aggregated in Postgres rather than by fetching sessions and
 * counting in Node: a busy day is hundreds of sessions, and the History view
 * only ever shows the totals.
 */
export async function listRunHistory(accountId: string, limit = 200): Promise<RunHistoryRow[]> {
  const { rows } = await pool.query<HistoryDbRow>(
    `SELECT j.id, j.name, j.target_url, j.status, j.group_id, j.created_at,
            g.name AS group_name,
            COALESCE(array_agg(s.user_name ORDER BY s.user_index)
                     FILTER (WHERE s.id IS NOT NULL), '{}') AS user_names,
            COUNT(s.id)                                        AS session_count,
            COUNT(*) FILTER (WHERE s.status = 'completed')      AS completed,
            COUNT(*) FILTER (WHERE s.status = 'failed')         AS failed,
            COUNT(*) FILTER (WHERE s.status = 'stopped')        AS stopped,
            MIN(s.started_at)                                   AS started_at,
            MAX(s.finished_at)                                  AS finished_at
       FROM jobs j
       LEFT JOIN sessions s ON s.job_id = j.id
       LEFT JOIN groups   g ON g.id     = j.group_id
      WHERE j.account_id = $2
      GROUP BY j.id, g.name
      ORDER BY j.created_at DESC
      LIMIT $1`,
    [limit, accountId],
  );

  return rows.map((r) => ({
    jobId: r.id,
    name: r.name,
    targetUrl: r.target_url,
    status: r.status,
    groupId: r.group_id,
    groupName: r.group_name,
    userNames: r.user_names ?? [],
    sessionCount: Number(r.session_count),
    completed: Number(r.completed),
    failed: Number(r.failed),
    stopped: Number(r.stopped),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  }));
}
