import type { FastifyInstance } from "fastify";
import { getJob, listJobs, listSessionsByJob } from "@automation/db";
import { parseUserCsv, buildDefaultUsers, buildNamedUsers } from "@automation/shared";
import { publishControl } from "../pubsub.js";
import { launchJob, linesOf, normalizeSteps, stopJob } from "../services/launch.js";

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  // multipart: CSV file field "csv" (optional) + form fields name/targetUrl/
  // steps/userCount/names. No CSV + no names means N synthetic users
  // (userCount); names (comma-separated) takes priority over userCount and
  // sets the actual user count. Parallel sessions always equals the user
  // count — there's no separate "concurrency" knob to configure or confuse.
  app.post("/api/jobs", async (req, reply) => {
    let name = "";
    let targetUrl = "";
    let stepsText = "";
    let userCountStr = "";
    let namesStr = "";
    let csvText: string | null = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname === "csv") csvText = (await part.toBuffer()).toString("utf-8");
      } else {
        const v = part.value as string;
        if (part.fieldname === "name") name = v;
        else if (part.fieldname === "targetUrl") targetUrl = v;
        else if (part.fieldname === "steps") stepsText = v;
        else if (part.fieldname === "userCount") userCountStr = v;
        else if (part.fieldname === "names") namesStr = v;
      }
    }

    if (!targetUrl?.trim()) return reply.code(400).send({ error: "targetUrl is required" });
    const steps = normalizeSteps(stepsText);

    const names = namesStr
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);

    let users;
    try {
      if (csvText) {
        users = parseUserCsv(csvText);
      } else if (names.length > 0) {
        users = buildNamedUsers(names);
      } else {
        users = buildDefaultUsers(Math.max(1, Number(userCountStr) || 1));
      }
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "invalid CSV" });
    }
    if (users.length === 0) return reply.code(400).send({ error: "no users resolved from CSV/names/userCount" });
    if (users.length > 200) return reply.code(400).send({ error: "too many users (max 200 per job)" });

    const { job, sessions } = await launchJob({
      name: name?.trim() || `Job ${new Date().toISOString()}`,
      targetUrl: targetUrl.trim(),
      steps,
      users,
    });

    reply.code(201).send({ job, sessions });
  });

  app.get("/api/jobs", async () => ({ jobs: await listJobs() }));

  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job) return reply.code(404).send({ error: "not found" });
    const sessions = await listSessionsByJob(id);
    return { job, sessions };
  });

  // Top-level "Stop all" — signals every non-terminal session's browser to
  // close. If this job was launched by a group, the scheduler notices it
  // has ended and releases the group's slot on its next tick (without
  // relaunching it inside the same window).
  app.post("/api/jobs/:id/stop-all", async (req, reply) => {
    const { id } = req.params as { id: string };
    const stopped = await stopJob(id);
    reply.send({ ok: true, stopped });
  });

  // Second-prompt follow-up steps applied to every session in the job.
  app.post("/api/jobs/:id/steps", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { steps: string };
    const steps = linesOf(body?.steps);
    if (steps.length === 0) return reply.code(400).send({ error: "no steps provided" });
    const sessions = await listSessionsByJob(id);
    for (const s of sessions) {
      await publishControl(s.id, { type: "append_steps", steps });
    }
    reply.send({ ok: true, appended: steps.length, sessions: sessions.length });
  });
}
