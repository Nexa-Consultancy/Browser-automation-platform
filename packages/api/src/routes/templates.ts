import type { FastifyInstance } from "fastify";
import {
  createTemplate,
  deleteTemplate,
  isTemplateScope,
  listTemplates,
  setDefaultTemplate,
  updateTemplate,
} from "@automation/db";
import { linesOf } from "../services/launch.js";
import { accountId, requireAuth } from "../auth/context.js";

interface TemplateBody {
  name?: string;
  steps?: string; // one step per line, same shape as a group's Task field
}

function parseTemplateBody(body: TemplateBody): { value: { name: string; steps: string[] } } | { error: string } {
  const name = body.name?.trim() ?? "";
  if (!name) return { error: "template name is required" };
  const steps = linesOf(body.steps ?? "");
  if (steps.length === 0) return { error: "at least one step is required" };
  return { value: { name, steps } };
}

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  // Templates are per-workspace: each account has its own scripts and picks
  // its own defaults. Set once on the plugin so a route added later cannot
  // be left unauthenticated by accident.
  app.addHook("preHandler", requireAuth);

  app.get("/api/templates", async (req) => {
    const templates = await listTemplates(accountId(req));
    return { templates };
  });

  app.post("/api/templates", async (req, reply) => {
    const account = accountId(req);
    const parsed = parseTemplateBody((req.body ?? {}) as TemplateBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const template = await createTemplate({ ...parsed.value, accountId: account });
    reply.code(201).send({ template });
  });

  /**
   * Points a scope's default at one template, or clears it with a null
   * templateId. Addressed by scope rather than by template id because that
   * is the thing being set — there is exactly one default per scope, and
   * naming it that way makes "move the default" a single call instead of a
   * clear-then-set the client could half-finish.
   *
   * Registered before PUT /api/templates/:id so the literal path wins:
   * Fastify would otherwise be free to read "default" as an :id.
   */
  app.put("/api/templates/default", async (req, reply) => {
    const account = accountId(req);
    const { scope, templateId } = (req.body ?? {}) as { scope?: string; templateId?: string | null };
    if (!isTemplateScope(scope)) {
      return reply.code(400).send({ error: 'scope must be "group" or "user"' });
    }
    const id = templateId?.trim() || null;
    const ok = await setDefaultTemplate(account, scope, id);
    if (!ok) return reply.code(404).send({ error: "that template no longer exists" });
    return { templates: await listTemplates(account) };
  });

  app.put("/api/templates/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const parsed = parseTemplateBody((req.body ?? {}) as TemplateBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const template = await updateTemplate(id, account, parsed.value);
    if (!template) return reply.code(404).send({ error: "not found" });
    reply.send({ template });
  });

  app.delete("/api/templates/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    // Deleting the row clears its default with it (the column goes too), so
    // the scope simply falls back to the built-in behaviour until someone
    // picks a new default.
    const ok = await deleteTemplate(id, account);
    if (!ok) return reply.code(404).send({ error: "not found" });
    reply.send({ ok: true });
  });
}
