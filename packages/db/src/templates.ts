import { pool } from "./pool.js";

export interface StepTemplate {
  id: string;
  name: string;
  steps: string[];
  createdAt: string;
}

interface TemplateDbRow {
  id: string;
  name: string;
  steps: string[];
  created_at: Date;
}

function toTemplate(r: TemplateDbRow): StepTemplate {
  return { id: r.id, name: r.name, steps: r.steps, createdAt: r.created_at.toISOString() };
}

export async function listTemplates(): Promise<StepTemplate[]> {
  const { rows } = await pool.query<TemplateDbRow>(`SELECT * FROM step_templates ORDER BY name`);
  return rows.map(toTemplate);
}

export async function getTemplate(id: string): Promise<StepTemplate | null> {
  const { rows } = await pool.query<TemplateDbRow>(`SELECT * FROM step_templates WHERE id = $1`, [id]);
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

export async function deleteTemplate(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM step_templates WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
