import { pool } from "./pool.js";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  organizationId: string | null;
  activeJobId: string | null;
  createdAt: string;
}

interface UserDbRow {
  id: string;
  name: string;
  email: string;
  organization_id: string | null;
  active_job_id: string | null;
  created_at: Date;
}

function toUser(r: UserDbRow): UserRecord {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    organizationId: r.organization_id,
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
const COLUMNS = "id, name, email, organization_id, active_job_id, created_at";

export class DuplicateUserEmail extends Error {
  constructor(email: string) {
    super(`A user with the email ${email} already exists.`);
    this.name = "DuplicateUserEmail";
  }
}

const UNIQUE_VIOLATION = "23505";

function rethrowDuplicate(err: unknown, email: string): never {
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION) {
    throw new DuplicateUserEmail(email);
  }
  throw err;
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  organizationId: string | null;
}): Promise<UserRecord> {
  try {
    const { rows } = await pool.query<UserDbRow>(
      `INSERT INTO users (name, email, password_enc, organization_id)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)
       RETURNING ${COLUMNS}`,
      [input.name, input.email, input.password, encKey(), input.organizationId],
    );
    return toUser(rows[0]);
  } catch (err) {
    rethrowDuplicate(err, input.email);
  }
}

/** Every user filed under one organization — the roster the Organizations
 * tab offers when linking people into that organization's groups. */
export async function listUsersByOrganization(organizationId: string): Promise<UserRecord[]> {
  const { rows } = await pool.query<UserDbRow>(
    `SELECT ${COLUMNS} FROM users WHERE organization_id = $1 ORDER BY lower(name)`,
    [organizationId],
  );
  return rows.map(toUser);
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
  input: { name: string; email: string; password?: string; organizationId: string | null },
): Promise<UserRecord | null> {
  try {
    const { rows } = input.password
      ? await pool.query<UserDbRow>(
          `UPDATE users SET name = $2, email = $3, organization_id = $6, password_enc = pgp_sym_encrypt($4, $5)
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [id, input.name, input.email, input.password, encKey(), input.organizationId],
        )
      : await pool.query<UserDbRow>(
          `UPDATE users SET name = $2, email = $3, organization_id = $4 WHERE id = $1 RETURNING ${COLUMNS}`,
          [id, input.name, input.email, input.organizationId],
        );
    return rows[0] ? toUser(rows[0]) : null;
  } catch (err) {
    rethrowDuplicate(err, input.email);
  }
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
