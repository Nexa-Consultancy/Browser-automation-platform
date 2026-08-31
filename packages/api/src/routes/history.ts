import type { FastifyInstance } from "fastify";
import { listRunHistory } from "@automation/db";
import { serverTimezone, type DailyReport, type RunHistoryRow } from "@automation/shared";

/** Calendar date of an instant, as it reads in the given zone ("YYYY-MM-DD").
 * "en-CA" formats exactly that way, which is also what a date input expects. */
function localDate(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: timezone });
}

/**
 * Rolls the run list up into one row per day.
 *
 * Days are bucketed by the server's own zone, not UTC — an evening run would
 * otherwise be reported against the following day, which makes a "daily
 * report" quietly wrong for exactly the runs people care about.
 */
function dailyReports(rows: RunHistoryRow[], timezone: string): DailyReport[] {
  const byDate = new Map<string, DailyReport>();
  for (const r of rows) {
    const date = localDate(r.createdAt, timezone);
    const day = byDate.get(date) ?? { date, runs: 0, sessions: 0, completed: 0, failed: 0, stopped: 0 };
    day.runs += 1;
    day.sessions += r.sessionCount;
    day.completed += r.completed;
    day.failed += r.failed;
    day.stopped += r.stopped;
    byDate.set(date, day);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/history", async () => {
    const tz = serverTimezone();
    const runs = await listRunHistory(200);
    return {
      runs: runs.map((r) => ({ ...r, localDate: localDate(r.createdAt, tz) })),
      daily: dailyReports(runs, tz),
      serverTimezone: tz,
    };
  });
}
