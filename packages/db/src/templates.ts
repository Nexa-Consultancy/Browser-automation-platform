import { pool } from "./pool.js";

/** The two creation flows a template can be the default for. Organizations
 * deliberately have none — an organization has no script of its own. */
export type TemplateScope = "group" | "user";

export const TEMPLATE_SCOPES: TemplateScope[] = ["group", "user"];

export function isTemplateScope(value: unknown): value is TemplateScope {
  return value === "group" || value === "user";
}

export interface StepTemplate {
  id: string;
  name: string;
  steps: string[];
  /** "group" = prefills a new group's Task, "user" = the script "Add user"
   * runs to capture a sign-in. At most one template holds each. */
  defaultFor: TemplateScope | null;
  createdAt: string;
}

interface TemplateDbRow {
  id: string;
  name: string;
  steps: string[];
  default_for: TemplateScope | null;
  created_at: Date;
}

function toTemplate(r: TemplateDbRow): StepTemplate {
  return {
    id: r.id,
    name: r.name,
    steps: r.steps,
    defaultFor: r.default_for,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listTemplates(): Promise<StepTemplate[]> {
  const { rows } = await pool.query<TemplateDbRow>(`SELECT * FROM step_templates ORDER BY name`);
  return rows.map(toTemplate);
}

export async function getTemplate(id: string): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(`SELECT * FROM step_templates WHERE id = $1`, [id]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

/** The template that should be used when nobody picks one — a new group's
 * Task, or the sign-in script for a new user. */
export async function getDefaultTemplate(scope: TemplateScope): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(`SELECT * FROM step_templates WHERE default_for = $1`, [scope]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

export async function createTemplate(input: { name: string; steps: string[] }): Promise<StepTemplate> {
  const { rows } = await pool.query<TemplateDbRow>(
    `INSERT INTO step_templates (name, steps) VALUES ($1, $2::jsonb) RETURNING *`,
    [input.name, JSON.stringify(input.steps)],
  );
  return toTemplate(rows[0]);
}

export async function updateTemplate(
  id: string,
  input: { name: string; steps: string[] },
): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(
    `UPDATE step_templates SET name = $2, steps = $3::jsonb WHERE id = $1 RETURNING *`,
    [id, input.name, JSON.stringify(input.steps)],
  );
  return rows[0] ? toTemplate(rows[0]) : null;
}

/**
 * Moves a scope's default onto one template, or clears it entirely when
 * `templateId` is null.
 *
 * Released first, claimed second, both inside one transaction: the partial
 * unique index means the two statements in the other order would collide
 * with the outgoing default, and doing them as separate transactions would
 * leave a window where the scope has no default at all.
 */
export async function setDefaultTemplate(scope: TemplateScope, templateId: string | null): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE step_templates SET default_for = NULL WHERE default_for = $1`, [scope]);
    let ok = true;
    if (templateId !== null) {
      const { rowCount } = await client.query(`UPDATE step_templates SET default_for = $2 WHERE id = $1`, [
        templateId,
        scope,
      ]);
      ok = (rowCount ?? 0) > 0;
    }
    // A templateId that matches nothing must not also silently clear the
    // existing default — roll the whole thing back and report the miss.
    if (!ok) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM step_templates WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
