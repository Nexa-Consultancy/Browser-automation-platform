import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

export const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB ?? "qa_automation",
  user: process.env.POSTGRES_USER ?? "qa_automation",
  password: process.env.POSTGRES_PASSWORD ?? "qa_automation",
  max: 10,
});

export async function migrate(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(path.join(here, "schema.sql"), "utf-8");
  await pool.query(sql);
}

export type { Pool } from "pg";
