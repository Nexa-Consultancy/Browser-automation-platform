import type { SessionEvent, SessionEventType } from "@automation/shared";
import { pool } from "./pool.js";

interface EventDbRow {
  id: string;
  session_id: string;
  job_id: string;
  type: SessionEventType;
  payload: Record<string, unknown>;
  ts: Date;
}

function toEvent(r: EventDbRow): SessionEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    jobId: r.job_id,
    type: r.type,
    payload: r.payload,
    ts: r.ts.toISOString(),
  };
}

export async function recordEvent(
  sessionId: string,
  jobId: string,
  type: SessionEventType,
  payload: Record<string, unknown> = {},
): Promise<SessionEvent> {
  // Screencast frames are high-frequency and only useful live; persisting
  // every JPEG would bloat the DB for no benefit, so they're relayed
  // through Redis pub/sub only (see api/src/ws.ts) and never written here.
  const { rows } = await pool.query<EventDbRow>(
    `INSERT INTO session_events (session_id, job_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
    [sessionId, jobId, type, JSON.stringify(payload)],
  );
  return toEvent(rows[0]);
}

export async function listEventsByJob(jobId: string, limit = 500): Promise<SessionEvent[]> {
  const { rows } = await pool.query<EventDbRow>(
    `SELECT * FROM session_events WHERE job_id = $1 ORDER BY ts ASC LIMIT $2`,
    [jobId, limit],
  );
  return rows.map(toEvent);
}
