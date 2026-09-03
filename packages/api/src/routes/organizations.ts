import type { FastifyInstance } from "fastify";
import {
  DuplicateOrganizationName,
  createOrganization,
  deleteOrganization,
  getOrganization,
  listOrganizations,
  organizationContents,
  updateOrganization,
} from "@automation/db";

const MAX_NAME = 80;
const MAX_DESCRIPTION = 240;

function parseBody(body: { name?: string; description?: string }): { value: { name: string; description: string } } | { error: string } {
  const name = (body.name ?? "").trim();
  if (!name) return { error: "an organization name is required" };
  if (name.length > MAX_NAME) return { error: `organization name is too long (max ${MAX_NAME} characters)` };
  const description = (body.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) {
    return { error: `description is too long (max ${MAX_DESCRIPTION} characters)` };
  }
  return { value: { name, description } };
}

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/organizations", async () => {
    return { organizations: await listOrganizations() };
  });

  app.post("/api/organizations", async (req, reply) => {
    const parsed = parseBody((req.body ?? {}) as { name?: string; description?: string });
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      const organization = await createOrganization(parsed.value);
      reply.code(201).send({ organization });
    } catch (err) {
      if (err instanceof DuplicateOrganizationName) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.put("/api/organizations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = parseBody((req.body ?? {}) as { name?: string; description?: string });
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      const organization = await updateOrganization(id, parsed.value);
      if (!organization) return reply.code(404).send({ error: "not found" });
      reply.send({ organization });
    } catch (err) {
      if (err instanceof DuplicateOrganizationName) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Refuses while anything is still filed under the organization, and says
   * what. Cascading would quietly take live scheduled groups and captured
   * logins with it — far too much to lose behind one "Delete" click — so
   * emptying it stays a deliberate act.
   */
  app.delete("/api/organizations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const organization = await getOrganization(id);
    if (!organization) return reply.code(404).send({ error: "not found" });

    const { groups, users } = await organizationContents(id);
    if (groups > 0 || users > 0) {
      const parts = [
        groups > 0 ? `${groups} group${groups === 1 ? "" : "s"}` : "",
        users > 0 ? `${users} user${users === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      return reply.code(409).send({
        error: `"${organization.name}" still has ${parts.join(" and ")}. Delete or move them first, then delete the organization.`,
      });
    }

    await deleteOrganization(id);
    reply.send({ ok: true });
  });
}
