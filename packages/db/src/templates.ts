import {
  templateTypeOf,
  type AssessmentPortalConfig,
  type TemplateType,
  type WorkflowStep,
} from "@automation/shared";
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
  /** The normalized workflow — English lines for a plain template, compiled
   * actions for a JSON one. This is what a group copies and a job runs, so
   * it is populated for every runnable format. */
  steps: WorkflowStep[];
  /** Which format this was authored in. A row that predates the column
   * reads as "plain", which is what every existing template is. */
  templateType: TemplateType;
  /** The source as typed, for the formats that have one: the raw JSON, or
   * the TypeScript. Null for a plain template, whose source IS its steps. */
  body: string | null;
  /** The portal configuration, when this is an assessment template. Null
   * otherwise — an ordinary template has no quiz to describe. */
  assessment: AssessmentPortalConfig | null;
  /** "group" = prefills a new group's Task, "user" = the script "Add user"
   * runs to capture a sign-in. At most one template holds each. */
  defaultFor: TemplateScope | null;
  createdAt: string;
}

interface TemplateDbRow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  template_type: string | null;
  body: string | null;
  assessment: AssessmentPortalConfig | null;
  default_for: TemplateScope | null;
  created_at: Date;
}

function toTemplate(r: TemplateDbRow): StepTemplate {
  return {
    id: r.id,
    name: r.name,
    steps: r.steps,
    templateType: templateTypeOf(r.template_type),
    body: r.body,
    assessment: r.assessment ?? null,
    defaultFor: r.default_for,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * A workspace's templates, optionally narrowed to one format.
 *
 * The filter is done in SQL rather than in the client so that "JSON" means
 * the same thing to the dashboard's filter buttons and to anything else
 * that asks — and so a workspace with hundreds of scripts doesn't ship all
 * of them to render three. `undefined` (and the "all" filter) means every
 * type, which is what every existing caller gets.
 */
export async function listTemplates(accountId: string, type?: TemplateType): Promise<StepTemplate[]> {
  const { rows } = type
    ? await pool.query<TemplateDbRow>(
        // COALESCE, not `= $2`: rows written before template_type existed
        // hold NULL and are plain-English, so filtering for "plain" has to
        // find them.
        `SELECT * FROM step_templates
          WHERE account_id = $1 AND COALESCE(template_type, 'plain') = $2
          ORDER BY name`,
        [accountId, type],
      )
    : await pool.query<TemplateDbRow>(`SELECT * FROM step_templates WHERE account_id = $1 ORDER BY name`, [
        accountId,
      ]);
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

export interface TemplateInput {
  name: string;
  /** Already normalized by the route — see parseTemplateBody, which is the
   * one place that knows how each format becomes a workflow. */
  steps: WorkflowStep[];
  templateType: TemplateType;
  body: string | null;
  assessment: AssessmentPortalConfig | null;
}

export async function createTemplate(input: TemplateInput & { accountId: string }): Promise<StepTemplate> {
  const { rows } = await pool.query<TemplateDbRow>(
    `INSERT INTO step_templates (name, steps, template_type, body, assessment, account_id)
     VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6) RETURNING *`,
    [
      input.name,
      JSON.stringify(input.steps),
      input.templateType,
      input.body,
      input.assessment ? JSON.stringify(input.assessment) : null,
      input.accountId,
    ],
  );
  return toTemplate(rows[0]);
}

export async function updateTemplate(
  id: string,
  accountId: string,
  input: TemplateInput,
): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(
    `UPDATE step_templates
        SET name = $2, steps = $3::jsonb, template_type = $4, body = $5, assessment = $6::jsonb
      WHERE id = $1 AND account_id = $7 RETURNING *`,
    [
      id,
      input.name,
      JSON.stringify(input.steps),
      input.templateType,
      input.body,
      input.assessment ? JSON.stringify(input.assessment) : null,
      accountId,
    ],
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
  // All plain-English: the starter scripts are what a new workspace reads
  // first, and prose is the format that explains itself.
  {
    name: "Join meeting",
    defaultFor: "group",
    steps: [
      "open {{url}}",
      'click if visible "Continue on this browser"',
      'click if visible "Continue without audio or video"',
      'click if visible "Don\'t use audio"',
      'click if visible "Turn camera off"',
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
      `INSERT INTO step_templates (name, steps, default_for, template_type, account_id)
       VALUES ($1, $2::jsonb, $3, 'plain', $4)`,
      [t.name, JSON.stringify(t.steps), t.defaultFor, accountId],
    );
  }
}
