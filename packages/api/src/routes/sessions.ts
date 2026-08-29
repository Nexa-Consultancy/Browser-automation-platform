import type { FastifyInstance } from "fastify";
import { getSession } from "@automation/db";
import type { InputAction } from "@automation/shared";
import { publishControl } from "../pubsub.js";

function linesOf(text: string): string[] {
  return (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    await publishControl(id, { type: "stop" });
    reply.send({ ok: true });
  });

  // Second-prompt follow-up steps for a single user's still-open session.
  app.post("/api/sessions/:id/steps", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    const body = req.body as { steps: string };
    const steps = linesOf(body?.steps);
    if (steps.length === 0) return reply.code(400).send({ error: "no steps provided" });
    await publishControl(id, { type: "append_steps", steps });
    reply.send({ ok: true, appended: steps.length });
  });

  // Interactive takeover: forward a raw click/type/key into the live page.
  app.post("/api/sessions/:id/input", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    const action = req.body as InputAction;
    await publishControl(id, { type: "input", action });
    reply.send({ ok: true });
  });
}
