import type { FastifyInstance } from "fastify";
import {
  createTemplate,
  deleteTemplate,
  isTemplateScope,
  listTemplates,
  setDefaultTemplate,
  updateTemplate,
  type TemplateInput,
} from "@automation/db";
import {
  TS_TEMPLATE_NOT_EXECUTABLE,
  compileJsonAction,
  formatPortalProblems,
  formatTsIssues,
  formatWorkflowErrors,
  isTemplateType,
  parseJsonWorkflow,
  parsePortalConfig,
  templateTypeOf,
  validateTsTemplate,
  type TemplateType,
  type WorkflowStep,
} from "@automation/shared";
import { linesOf } from "../services/launch.js";
import { accountId, requireAuth } from "../auth/context.js";

interface TemplateBody {
  name?: string;
  /** Plain-English: one step per line, same shape as a group's Task field.
   * Ignored for the other two formats, which carry their source in `body`. */
  steps?: string;
  templateType?: string;
  /** The raw JSON or TypeScript source, as typed in the editor. */
  body?: string;
  /** The portal configuration, for an assessment template. */
  assessment?: unknown;
}

/**
 * One definition of "a valid template", for all three formats.
 *
 * The important part is what every branch produces: a normalized
 * `steps` workflow. A JSON template is compiled here, at save time, so a
 * definition that cannot compile never reaches the database, let alone a
 * worker — which is the rule the brief asks for, enforced in the one place
 * that can enforce it.
 */
function parseTemplateBody(body: TemplateBody): { value: TemplateInput } | { error: string } {
  const name = body.name?.trim() ?? "";
  if (!name) return { error: "template name is required" };

  if (body.templateType !== undefined && body.templateType !== "" && !isTemplateType(body.templateType)) {
    return { error: `unknown template type "${body.templateType}"` };
  }
  const templateType: TemplateType = templateTypeOf(body.templateType);

  // An assessment config is optional on any template — a portal's login
  // workflow and its quiz selectors are usually the same template.
  const portal = parsePortalConfig(body.assessment ?? null);
  if (!portal.ok) return { error: `assessment config: ${formatPortalProblems(portal.problems)}` };
  const assessment = Object.keys(portal.config).length > 0 ? portal.config : null;

  if (templateType === "plain") {
    const steps = linesOf(body.steps ?? "");
    if (steps.length === 0) return { error: "at least one step is required" };
    // No separate source: for a plain template the steps ARE the source.
    return { value: { name, steps, templateType, body: null, assessment } };
  }

  if (templateType === "json") {
    const source = (body.body ?? body.steps ?? "").trim();
    if (!source) return { error: "the JSON workflow is required" };
    const parsed = parseJsonWorkflow(source);
    if (!parsed.ok) return { error: formatWorkflowErrors(parsed.errors) };
    // Stored compiled AND as source: the compiled form is what a group
    // copies and a worker runs, the source is what comes back into the
    // editor with its formatting and comments intact.
    const steps: WorkflowStep[] = parsed.workflow.steps;
    // Compiling here as well as validating is the check that the schema and
    // the executor agree — a shape that validates but cannot compile would
    // otherwise only fail at run time.
    steps.forEach((s) => typeof s === "string" || compileJsonAction(s));
    return { value: { name, steps, templateType, body: source, assessment } };
  }

  const source = (body.body ?? "").trim();
  const checked = validateTsTemplate(source);
  if (!checked.ok) return { error: formatTsIssues(checked.issues) };
  // Saved with an empty workflow: this build validates and stores TypeScript
  // templates but does not execute them, so there is nothing to compile yet.
  // Anything that tries to run one is told exactly that — see
  // TS_TEMPLATE_NOT_EXECUTABLE, which the group route quotes verbatim.
  return { value: { name, steps: [], templateType, body: source, assessment } };
}

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  // Templates are per-workspace: each account has its own scripts and picks
  // its own defaults. Set once on the plugin so a route added later cannot
  // be left unauthenticated by accident.
  app.addHook("preHandler", requireAuth);

  app.get("/api/templates", async (req, reply) => {
    // ?type= narrows the list to one format. Absent (or "all") is every
    // template, which is what every existing caller sends.
    const { type } = (req.query ?? {}) as { type?: string };
    if (type && type !== "all" && !isTemplateType(type)) {
      return reply.code(400).send({ error: `unknown template type "${type}"` });
    }
    const templates = await listTemplates(accountId(req), isTemplateType(type) ? type : undefined);
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

    // A default is a script something will RUN — a new group's Task, or the
    // sign-in a new user gets. A TypeScript template cannot run in this
    // build, so making one the default would quietly break both flows.
    if (id) {
      const chosen = (await listTemplates(account)).find((t) => t.id === id);
      if (chosen?.templateType === "typescript") {
        return reply.code(400).send({ error: TS_TEMPLATE_NOT_EXECUTABLE });
      }
    }

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
