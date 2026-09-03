import type { Organization, OrganizationWithCounts } from "@automation/shared";
import { pool } from "./pool.js";

interface OrganizationDbRow {
  id: string;
  name: string;
  description: string;
  created_at: Date;
}

function toOrganization(r: OrganizationDbRow): Organization {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at.toISOString(),
  };
}

/** Thrown when a name collides with an existing organization, so the route
 * can answer 409 with a sentence rather than leaking a Postgres error. */
export class DuplicateOrganizationName extends Error {
  constructor(name: string) {
    super(`An organization called "${name}" already exists.`);
    this.name = "DuplicateOrganizationName";
  }
}

const UNIQUE_VIOLATION = "23505";

function rethrowDuplicate(err: unknown, name: string): never {
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION) {
    throw new DuplicateOrganizationName(name);
  }
  throw err;
}

export async function createOrganization(input: {
  name: string;
  description: string;
}): Promise<Organization> {
  try {
    const { rows } = await pool.query<OrganizationDbRow>(
      `INSERT INTO organizations (name, description) VALUES ($1, $2) RETURNING *`,
      [input.name, input.description],
    );
    return toOrganization(rows[0]);
  } catch (err) {
    rethrowDuplicate(err, input.name);
  }
}

/**
 * The rail's whole payload in one query: every organization with how many
 * groups and users sit under it. Counted with correlated subqueries rather
 * than two LEFT JOINs — joining both at once multiplies the rows and gives
 * each count the other's cardinality.
 */
export async function listOrganizations(): Promise<OrganizationWithCounts[]> {
  const { rows } = await pool.query<OrganizationDbRow & { group_count: string; user_count: string }>(
    `SELECT o.*,
            (SELECT count(*) FROM groups g WHERE g.organization_id = o.id) AS group_count,
            (SELECT count(*) FROM users u WHERE u.organization_id = o.id) AS user_count
       FROM organizations o
      ORDER BY lower(o.name)`,
  );
  return rows.map((r) => ({
    ...toOrganization(r),
    groupCount: Number(r.group_count),
    userCount: Number(r.user_count),
  }));
}

export async function getOrganization(id: string): Promise<Organization | null> {
  const { rows } = await pool.query<OrganizationDbRow>(`SELECT * FROM organizations WHERE id = $1`, [id]);
  return rows[0] ? toOrganization(rows[0]) : null;
}

export async function updateOrganization(
  id: string,
  input: { name: string; description: string },
): Promise<Organization | null> {
  try {
    const { rows } = await pool.query<OrganizationDbRow>(
      `UPDATE organizations SET name = $2, description = $3 WHERE id = $1 RETURNING *`,
      [id, input.name, input.description],
    );
    return rows[0] ? toOrganization(rows[0]) : null;
  } catch (err) {
    rethrowDuplicate(err, input.name);
  }
}

export async function deleteOrganization(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/** What an organization still holds, so deleting one can refuse with real
 * numbers ("3 groups and 8 users") instead of a bare "in use". */
export async function organizationContents(id: string): Promise<{ groups: number; users: number }> {
  const { rows } = await pool.query<{ groups: string; users: string }>(
    `SELECT (SELECT count(*) FROM groups WHERE organization_id = $1) AS groups,
            (SELECT count(*) FROM users WHERE organization_id = $1) AS users`,
    [id],
  );
  return { groups: Number(rows[0].groups), users: Number(rows[0].users) };
}
