import { pool } from "./pool.js";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  activeJobId: string | null;
  createdAt: string;
}

interface UserDbRow {
  id: string;
  name: string;
  email: string;
  active_job_id: string | null;
  created_at: Date;
}

function toUser(r: UserDbRow): UserRecord {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    activeJobId: r.active_job_id,
    createdAt: r.created_at.toISOString(),
  };
}

function encKey(): string {
  const key = process.env.CREDENTIALS_ENC_KEY;
  if (!key) throw new Error("CREDENTIALS_ENC_KEY is not set — cannot store or read a user's password");
  return key;
}

// Deliberately never SELECT * here — password_enc must only ever be read by
// getUserPasswordPlain below, so every other query lists columns explicitly
// and simply has no way to leak ciphertext into a response.
const COLUMNS = "id, name, email, active_job_id, created_at";

export async function createUser(input: { name: string; email: string; password: string }): Promise<UserRecord> {
  const { rows } = await pool.query<UserDbRow>(
    `INSERT INTO users (name, email, password_enc)
     VALUES ($1, $2, pgp_sym_encrypt($3, $4))
     RETURNING ${COLUMNS}`,
    [input.name, input.email, input.password, encKey()],
  );
  return toUser(rows[0]);
}

export async function listUsers(): Promise<UserRecord[]> {
  const { rows } = await pool.query<UserDbRow>(`SELECT ${COLUMNS} FROM users ORDER BY created_at DESC LIMIT 500`);
  return rows.map(toUser);
}

export async function getUser(id: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<UserDbRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

/** For resolving a group's linked roster — only the users that still exist. */
export async function getUsersByIds(ids: string[]): Promise<UserRecord[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<UserDbRow>(`SELECT ${COLUMNS} FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  return rows.map(toUser);
}

export async function updateUser(
  id: string,
  input: { name: string; email: string; password?: string },
): Promise<UserRecord | null> {
  const { rows } = input.password
    ? await pool.query<UserDbRow>(
        `UPDATE users SET name = $2, email = $3, password_enc = pgp_sym_encrypt($4, $5) WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, input.name, input.email, input.password, encKey()],
      )
    : await pool.query<UserDbRow>(
        `UPDATE users SET name = $2, email = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, input.name, input.email],
      );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function deleteUser(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/** Guards against Add-user/Re-sign-in firing twice concurrently for the
 * same user — same pattern as setGroupActiveJob. */
export async function setUserActiveJob(id: string, jobId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE users SET active_job_id = $2 WHERE id = $1 AND active_job_id IS NULL`,
    [id, jobId],
  );
  return (rowCount ?? 0) > 0;
}

export async function releaseUserActiveJob(id: string): Promise<void> {
  await pool.query(`UPDATE users SET active_job_id = NULL WHERE id = $1`, [id]);
}

/**
 * The ONLY function in the codebase allowed to read a plaintext password.
 * Used exclusively right before launching/relaunching a login-capture job.
 * Callers must never log the return value or put it in any HTTP response.
 */
export async function getUserPasswordPlain(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ password: string | null }>(
    `SELECT pgp_sym_decrypt(password_enc, $2) AS password FROM users WHERE id = $1`,
    [id, encKey()],
  );
  return rows[0]?.password ?? null;
}

/** Best-effort: drop a deleted user's id out of every group's roster so a
 * stale id is never resolved on the next run. jsonb's `-` operator removes
 * a matching top-level string element from an array — exactly this shape. */
export async function removeUserFromAllGroups(id: string): Promise<void> {
  await pool.query(`UPDATE groups SET user_ids = user_ids - $1::text WHERE user_ids @> to_jsonb($1::text)`, [id]);
}
