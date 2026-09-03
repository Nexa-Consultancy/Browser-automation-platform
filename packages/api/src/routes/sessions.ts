import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession, jobBelongsToAccount } from "@automation/db";
import type { InputAction } from "@automation/shared";
import { publishControl } from "../pubsub.js";
import { accountId, requireAuth } from "../auth/context.js";

function linesOf(text: string): string[] {
  return (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolves a session id to a session this account is actually allowed to
 * touch.
 *
 * These endpoints drive somebody's live browser — stop it, append steps to
 * it, or forward raw clicks and keystrokes into it. A session id alone must
 * therefore never be enough; ownership is checked through the session's job
 * on every one of them.
 *
 * 404 rather than 403 for a session belonging to another workspace: a
 * distinct "forbidden" would confirm the id exists.
 */
async function ownedSession(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const session = await getSession(id);
  if (!session || !(await jobBelongsToAccount(session.jobId, accountId(req)))) {
    reply.code(404).send({ error: "not found" });
    return null;
  }
  return session;
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // Every route here controls a running browser. They were previously open
  // to anyone who could reach the API — see ownedSession above.
  app.addHook("preHandler", requireAuth);

  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    await publishControl(session.id, { type: "stop" });
    reply.send({ ok: true });
  });

  // Second-prompt follow-up steps for a single user's still-open session.
  app.post("/api/sessions/:id/steps", async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const body = req.body as { steps: string };
    const steps = linesOf(body?.steps);
    if (steps.length === 0) return reply.code(400).send({ error: "no steps provided" });
    await publishControl(session.id, { type: "append_steps", steps });
    reply.send({ ok: true, appended: steps.length });
  });

  // Interactive takeover: forward a raw click/type/key into the live page.
  app.post("/api/sessions/:id/input", async (req, reply) => {
    const session = await ownedSession(req, reply);
    if (!session) return reply;
    const action = req.body as InputAction;
    await publishControl(session.id, { type: "input", action });
    reply.send({ ok: true });
  });
}
