import type { FastifyInstance } from "fastify";
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from "@automation/db";
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

  app.delete("/api/templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteTemplate(id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    reply.send({ ok: true });
  });
}
