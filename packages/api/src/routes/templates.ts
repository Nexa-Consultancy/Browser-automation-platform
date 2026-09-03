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
  app.get("/api/templates", async () => {
    const templates = await listTemplates();
    return { templates };
  });

  app.post("/api/templates", async (req, reply) => {
    const parsed = parseTemplateBody((req.body ?? {}) as TemplateBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const template = await createTemplate(parsed.value);
    reply.code(201).send({ template });
  });

  app.put("/api/templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = parseTemplateBody((req.body ?? {}) as TemplateBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const template = await updateTemplate(id, parsed.value);
    if (!template) return reply.code(404).send({ error: "not found" });
    reply.send({ template });
  });

  /**
   * Points a scope's default at one template, or clears it with a null
   * templateId. Addressed by scope rather than by template id because that
   * is the thing being set — there is exactly one default per scope, and
   * naming it that way makes "move the default" a single call instead of a
   * clear-then-set the client could half-finish.
   *
   * Registered before DELETE /api/templates/:id purely for readability;
   * Fastify routes on the full path, so the two never overlap.
   */
  app.put("/api/templates/default", async (req, reply) => {
    const { scope, templateId } = (req.body ?? {}) as { scope?: string; templateId?: string | null };
    if (!isTemplateScope(scope)) {
      return reply.code(400).send({ error: 'scope must be "group" or "user"' });
    }
    const id = templateId?.trim() || null;
    const ok = await setDefaultTemplate(scope, id);
    if (!ok) return reply.code(404).send({ error: "that template no longer exists" });
    return { templates: await listTemplates() };
  });

  app.delete("/api/templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Deleting the row clears its default with it (the column goes too), so
    // the scope simply falls back to the built-in behaviour until someone
    // picks a new default.
    const ok = await deleteTemplate(id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    reply.send({ ok: true });
  });
}
