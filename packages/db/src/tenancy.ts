import { pool } from "./pool.js";

/** Every table whose rows belong to one workspace. Kept as one list so a
 * future tenant-owned table is added in exactly one place and cannot be
 * forgotten by the adoption path. */
const TENANT_TABLES = ["organizations", "groups", "users", "step_templates", "jobs", "system_logs"] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

/**
 * Hands every row that predates accounts to the workspace owner.
 *
 * The platform ran for a while with no notion of an account, so a live
 * database has organizations, groups, people and run history with a NULL
 * account_id. Those must not vanish behind the new login — they are the
 * data the owner is signing in to see. Claiming only NULLs means this can
 * run on every boot without ever touching another tenant's rows.
 */
export async function adoptOrphanData(accountId: string): Promise<Record<string, number>> {
  await resolveDefaultTemplateClashes(accountId);

  const adopted: Record<string, number> = {};
  for (const table of TENANT_TABLES) {
    // Table names come from the frozen list above, never from input.
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET account_id = $1 WHERE account_id IS NULL`,
      [accountId],
    );
    adopted[table] = rowCount ?? 0;
  }
  return adopted;
}

/**
 * Makes the template adoption above safe to run.
 *
 * Only one template per account may claim each default scope, so adopting a
 * pile of orphans can violate that in two ways: the account already holds
 * that scope, or two orphans both claim it. Either one would abort the
 * whole adoption with a unique violation — and since this runs at startup,
 * that means a server that will not boot.
 *
 * Losing a default is recoverable in one click in Settings; an unbootable
 * server is not. So the surplus claims are released and the newest orphan
 * per scope is kept, rather than letting the constraint stop everything.
 */
async function resolveDefaultTemplateClashes(accountId: string): Promise<void> {
  // 1. Scopes the account already owns: incoming orphans give theirs up.
  await pool.query(
    `UPDATE step_templates SET default_for = NULL
      WHERE account_id IS NULL
        AND default_for IS NOT NULL
        AND default_for IN (SELECT default_for FROM step_templates
                             WHERE account_id = $1 AND default_for IS NOT NULL)`,
    [accountId],
  );

  // 2. Orphans competing with each other: keep the newest of each scope.
  await pool.query(
    `UPDATE step_templates SET default_for = NULL
      WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY default_for ORDER BY created_at DESC) AS rn
            FROM step_templates
           WHERE account_id IS NULL AND default_for IS NOT NULL
        ) ranked WHERE rn > 1
      )`,
  );
}
