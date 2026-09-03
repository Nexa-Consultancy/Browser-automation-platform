import { pool } from "./pool.js";

/**
 * Long-lived dashboard logins.
 *
 * Only the SHA-256 of the cookie token is stored, never the token itself:
 * whoever reads this table cannot replay what they find as a live session.
 * Hashing is the caller's job (packages/api/src/auth/tokens.ts) so this
 * module never touches a raw secret at all.
 */
export interface AuthSessionRow {
  accountId: string;
  expiresAt: string;
}

export async function createAuthSession(input: {
  tokenHash: string;
  accountId: string;
  userAgent: string;
  expiresAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO auth_sessions (token_hash, account_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
    [input.tokenHash, input.accountId, input.userAgent.slice(0, 400), input.expiresAt],
  );
}

/**
 * Resolves a cookie to its account, and slides the expiry forward in the
 * same statement.
 *
 * The slide is what makes "log in once and stay logged in" true in
 * practice: someone using the dashboard every few days never reaches the
 * expiry, while an abandoned session still ages out on its own. Expired
 * rows are excluded by the WHERE rather than deleted here — cleanup is
 * deleteExpiredAuthSessions's job, and a read path should not be doing
 * writes it can avoid.
 */
export async function touchAuthSession(tokenHash: string, extendTo: Date): Promise<AuthSessionRow | null> {
  const { rows } = await pool.query<{ account_id: string; expires_at: Date }>(
    `UPDATE auth_sessions
        SET last_seen_at = now(), expires_at = $2
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING account_id, expires_at`,
    [tokenHash, extendTo],
  );
  return rows[0] ? { accountId: rows[0].account_id, expiresAt: rows[0].expires_at.toISOString() } : null;
}

export async function deleteAuthSession(tokenHash: string): Promise<void> {
  await pool.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [tokenHash]);
}

/** Signs an account out everywhere — used when its password changes, so a
 * stolen session cannot outlive the reset that was meant to stop it. */
export async function deleteAuthSessionsForAccount(accountId: string): Promise<void> {
  await pool.query(`DELETE FROM auth_sessions WHERE account_id = $1`, [accountId]);
}

export async function deleteExpiredAuthSessions(): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM auth_sessions WHERE expires_at <= now()`);
  return rowCount ?? 0;
}

// ---------- password resets ----------

export async function createPasswordReset(input: {
  tokenHash: string;
  accountId: string;
  expiresAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO password_resets (token_hash, account_id, expires_at) VALUES ($1, $2, $3)`,
    [input.tokenHash, input.accountId, input.expiresAt],
  );
}

/**
 * Claims a reset token, atomically and exactly once.
 *
 * `used_at IS NULL` inside the UPDATE is what makes it single-use: two
 * requests racing on the same emailed link both try this statement, and
 * only the one that matches a row gets an account back. Checking first and
 * updating after would let both through.
 */
export async function consumePasswordReset(tokenHash: string): Promise<string | null> {
  const { rows } = await pool.query<{ account_id: string }>(
    `UPDATE password_resets
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING account_id`,
    [tokenHash],
  );
  return rows[0]?.account_id ?? null;
}

/** Invalidates any outstanding link for an account — called when a new one
 * is issued, so only the newest email works. */
export async function clearPasswordResets(accountId: string): Promise<void> {
  await pool.query(`DELETE FROM password_resets WHERE account_id = $1`, [accountId]);
}
