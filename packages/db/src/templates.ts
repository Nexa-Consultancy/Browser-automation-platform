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

export async function listTemplates(accountId: string): Promise<StepTemplate[]> {
  const { rows } = await pool.query<TemplateDbRow>(
    `SELECT * FROM step_templates WHERE account_id = $1 ORDER BY name`,
    [accountId],
  );
  return rows.map(toTemplate);
}

export async function getTemplate(id: string, accountId: string): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(
    `SELECT * FROM step_templates WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  return rows[0] ? toTemplate(rows[0]) : null;
}

/** The template that should be used when nobody picks one — a new group's
 * Task, or the sign-in script for a new user. */
export async function getDefaultTemplate(accountId: string, scope: TemplateScope): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(
    `SELECT * FROM step_templates WHERE default_for = $1 AND account_id = $2`,
    [scope, accountId],
  );
  return rows[0] ? toTemplate(rows[0]) : null;
}

export async function createTemplate(input: {
  name: string;
  steps: string[];
  accountId: string;
}): Promise<StepTemplate> {
  const { rows } = await pool.query<TemplateDbRow>(
    `INSERT INTO step_templates (name, steps, account_id) VALUES ($1, $2::jsonb, $3) RETURNING *`,
    [input.name, JSON.stringify(input.steps), input.accountId],
  );
  return toTemplate(rows[0]);
}

export async function updateTemplate(
  id: string,
  accountId: string,
  input: { name: string; steps: string[] },
): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(
    `UPDATE step_templates SET name = $2, steps = $3::jsonb WHERE id = $1 AND account_id = $4 RETURNING *`,
    [id, input.name, JSON.stringify(input.steps), accountId],
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
export async function setDefaultTemplate(
  accountId: string,
  scope: TemplateScope,
  templateId: string | null,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE step_templates SET default_for = NULL WHERE default_for = $1 AND account_id = $2`, [
      scope,
      accountId,
    ]);
    let ok = true;
    if (templateId !== null) {
      const { rowCount } = await client.query(
        `UPDATE step_templates SET default_for = $2 WHERE id = $1 AND account_id = $3`,
        [templateId, scope, accountId],
      );
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

export async function deleteTemplate(id: string, accountId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM step_templates WHERE id = $1 AND account_id = $2`, [
    id,
    accountId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** The two scripts every workspace starts with. Kept here rather than in
 * schema.sql because they are now per-account: a new signup needs its own
 * copies, and a migration cannot know about an account that does not exist
 * yet. Mirrors the seeded rows the original single-workspace build had. */
const STARTER_TEMPLATES: { name: string; steps: string[]; defaultFor: TemplateScope }[] = [
  {
    name: "Join meeting",
    defaultFor: "group",
    steps: [
      "open {{url}}",
      'click if visible "Continue on this browser"',
      'click if visible "Continue without audio or video"',
      'fill if visible "Type your name" with {{name}}',
      'click "Join"',
    ],
  },
  {
    name: "Auto login",
    defaultFor: "user",
    steps: [
      "open https://teams.microsoft.com/",
      'fill "Email, phone, or Skype" with {{email}}',
      'click "Next"',
      "wait for 2 seconds",
      'click if visible "Use your password"',
      'click if visible "Sign in with a password"',
      'click if visible "Use password instead"',
      'click if visible "Other ways to sign in"',
      'click if visible "Use your password"',
      "wait for 1 seconds",
      'fill "Password" with {{password}}',
      'click "Sign in"',
      "wait for 2 seconds",
      'click if visible "No thanks"',
      'click if visible "Skip for now"',
      'click if visible "Maybe later"',
      'click if visible "Yes"',
    ],
  },
];

/**
 * Gives a brand-new account its starter scripts, already marked as its
 * defaults. Without this a new workspace would have no group template, and
 * its group form could not be saved without opening Advanced.
 *
 * Skips an account that already has templates, so it is safe to call again
 * on an existing workspace without duplicating anything.
 */
export async function seedTemplatesForAccount(accountId: string): Promise<void> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM step_templates WHERE account_id = $1`,
    [accountId],
  );
  if (Number(rows[0].n) > 0) return;

  for (const t of STARTER_TEMPLATES) {
    await pool.query(
      `INSERT INTO step_templates (name, steps, default_for, account_id) VALUES ($1, $2::jsonb, $3, $4)`,
      [t.name, JSON.stringify(t.steps), t.defaultFor, accountId],
    );
  }
}
