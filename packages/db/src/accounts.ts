import { pool } from "./pool.js";

/** 'admin' sees every account and approves signups; 'owner' sees only their
 * own workspace. There is deliberately no finer-grained role yet — nothing
 * in the product needs one, and an unused permission model is worse than
 * none. */
export type AccountRole = "admin" | "owner";

/** 'pending' cannot sign in: a signup waits here until an admin approves. */
export type AccountStatus = "pending" | "active" | "rejected" | "suspended";

export interface Account {
  id: string;
  email: string;
  username: string | null;
  name: string;
  workspaceName: string;
  phone: string;
  purpose: string;
  role: AccountRole;
  status: AccountStatus;
  approvedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface AccountDbRow {
  id: string;
  email: string;
  username: string | null;
  name: string;
  workspace_name: string;
  phone: string;
  purpose: string;
  role: AccountRole;
  status: AccountStatus;
  approved_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

function toAccount(r: AccountDbRow): Account {
  return {
    id: r.id,
    email: r.email,
    username: r.username,
    name: r.name,
    workspaceName: r.workspace_name,
    phone: r.phone,
    purpose: r.purpose,
    role: r.role,
    status: r.status,
    approvedAt: r.approved_at?.toISOString() ?? null,
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

// password_hash is never selected by anything except verifyLogin below, so
// there is simply no path by which it reaches an HTTP response.
const COLUMNS =
  "id, email, username, name, workspace_name, phone, purpose, role, status, approved_at, last_login_at, created_at";

export class DuplicateAccount extends Error {
  constructor(what: string) {
    super(`An account with that ${what} already exists.`);
    this.name = "DuplicateAccount";
  }
}

const UNIQUE_VIOLATION = "23505";

function rethrowDuplicate(err: unknown): never {
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION) {
    const detail = String((err as { constraint?: string }).constraint ?? "");
    throw new DuplicateAccount(detail.includes("username") ? "username" : "email address");
  }
  throw err;
}

export async function createAccount(input: {
  email: string;
  username: string | null;
  name: string;
  workspaceName: string;
  phone: string;
  purpose: string;
  passwordHash: string;
  role: AccountRole;
  status: AccountStatus;
}): Promise<Account> {
  try {
    const { rows } = await pool.query<AccountDbRow>(
      `INSERT INTO accounts (email, username, name, workspace_name, phone, purpose, password_hash, role, status, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9 = 'active' THEN now() ELSE NULL END)
       RETURNING ${COLUMNS}`,
      [
        input.email,
        input.username,
        input.name,
        input.workspaceName,
        input.phone,
        input.purpose,
        input.passwordHash,
        input.role,
        input.status,
      ],
    );
    return toAccount(rows[0]);
  } catch (err) {
    rethrowDuplicate(err);
  }
}

export async function getAccount(id: string): Promise<Account | null> {
  const { rows } = await pool.query<AccountDbRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

/** Sign-in accepts either identity, so one lookup has to cover both. */
export async function findAccountByLogin(login: string): Promise<Account | null> {
  const { rows } = await pool.query<AccountDbRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE lower(email) = lower($1) OR lower(username) = lower($1)`,
    [login.trim()],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

export async function findAccountByEmail(email: string): Promise<Account | null> {
  const { rows } = await pool.query<AccountDbRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

/** The ONLY function that reads a password hash. Callers verify it and must
 * never put the return value anywhere else. */
export async function getPasswordHash(accountId: string): Promise<string | null> {
  const { rows } = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0]?.password_hash ?? null;
}

export async function setPasswordHash(accountId: string, passwordHash: string): Promise<void> {
  await pool.query(`UPDATE accounts SET password_hash = $2 WHERE id = $1`, [accountId, passwordHash]);
}

export async function listAccounts(): Promise<Account[]> {
  // Pending first: the list exists mainly to act on signups waiting for a
  // decision, and they should not be hunted for underneath the active ones.
  const { rows } = await pool.query<AccountDbRow>(
    `SELECT ${COLUMNS} FROM accounts
      ORDER BY (status = 'pending') DESC, created_at DESC`,
  );
  return rows.map(toAccount);
}

export async function setAccountStatus(id: string, status: AccountStatus): Promise<Account | null> {
  const { rows } = await pool.query<AccountDbRow>(
    `UPDATE accounts
        SET status = $2,
            approved_at = CASE WHEN $2 = 'active' AND approved_at IS NULL THEN now() ELSE approved_at END
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, status],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

export async function markAccountLogin(id: string): Promise<void> {
  await pool.query(`UPDATE accounts SET last_login_at = now() WHERE id = $1`, [id]);
}

export async function deleteAccount(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function countAccounts(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM accounts`);
  return Number(rows[0].n);
}
