import type { FastifyInstance } from "fastify";
import {
  addUserToGroup,
  createGroup,
  deleteGroup,
  getGroup,
  getOrganization,
  getTemplate,
  getUsersByIds,
  listGroups,
  setGroupActiveJob,
  setGroupEnabled,
  releaseGroupRun,
  removeUserFromGroup,
  updateGroup,
} from "@automation/db";
import {
  ALL_DAYS,
  buildLinkedUsers,
  buildNamedUsers,
  effectiveStartMinutes,
  formatHhMm,
  isValidTimezone,
  parseHhMm,
  serverTimezone,
  windowStateAt,
  zonedNow,
  JSON_WORKFLOW_VERSION,
  formatWorkflowErrors,
  isGroupType,
  validateJsonWorkflow,
  type Group,
  type GroupType,
  type GroupWithSchedule,
  type WorkflowStep,
} from "@automation/shared";
import { launchJob, normalizeSteps, normalizeWorkflowSteps, stopJob } from "../services/launch.js";
import { planAssessmentRun } from "../services/assessments.js";
import { clearGroupProfiles } from "../services/profiles.js";
import { userLoginExists } from "../services/users.js";
import { raiseAlert } from "../alerts.js";
import { accountId, requireAuth } from "../auth/context.js";

const MAX_USERS_PER_GROUP = 200;

interface CreateGroupBody {
  name?: string;
  /** "standard" (the default, and what every existing group is) or
   * "assessment". Same schedule, same roster, different runner. */
  groupType?: string;
  /** For an assessment group: the template carrying the portal config. */
  assessmentTemplateId?: string | null;
  organizationId?: string | null;
  targetUrl?: string;
  steps?: string;
  /**
   * A task authored as JSON, as the structured actions themselves.
   *
   * Sent instead of `steps` when a group is created from a JSON template.
   * Flattening those to English lines would work but would silently throw
   * away the one thing the format is for — an ordered list of ways to find
   * an element — so the objects travel through intact and land in the same
   * jsonb column the English lines do.
   */
  stepsJson?: unknown;
  userNames?: string[];
  userIds?: string[];
  startTime?: string;
  endTime?: string;
  leadMinutes?: number;
  days?: number[];
  timezone?: string;
  enabled?: boolean;
}

/** Attaches the live "where are we in the window right now" read-out the
 * dashboard shows, computed server-side so the countdown reflects the
 * server's clock — the only clock that actually fires these — plus display
 * info for this group's linked PlatformUsers. */
async function withSchedule(group: Group, account: string): Promise<GroupWithSchedule> {
  const now = zonedNow(group.timezone);
  // Schedule against the lead-adjusted start, not the time the user typed —
  // that's the whole point of the lead.
  const start = effectiveStartMinutes(parseHhMm(group.startTime), group.leadMinutes);
  const state = windowStateAt(start, parseHhMm(group.endTime), now, group.days);
  const linked = await getUsersByIds(group.userIds, account);
  return {
    ...group,
    schedule: {
      inWindow: state.inWindow,
      effectiveStart: formatHhMm(start),
      occurrenceKey: state.occurrenceKey,
      minutesUntilStart: state.minutesUntilStart,
      minutesUntilEnd: state.minutesUntilEnd,
      localTime: formatHhMm(now.minutes),
    },
    linkedUsers: linked.map((u) => ({ id: u.id, name: u.name, signedIn: userLoginExists(u.id) })),
  };
}

interface ParsedGroup {
  name: string;
  groupType: GroupType;
  assessmentTemplateId: string | null;
  organizationId: string | null;
  targetUrl: string;
  steps: WorkflowStep[];
  userNames: string[];
  userIds: string[];
  startTime: string;
  endTime: string;
  leadMinutes: number;
  days: number[];
  timezone: string;
  enabled: boolean;
}

/**
 * One definition of "a valid group", shared by create and edit so the two
 * can't drift into accepting different things.
 */
function parseGroupBody(body: CreateGroupBody): { value: ParsedGroup } | { error: string } {
  const targetUrl = body.targetUrl?.trim() ?? "";
  if (!targetUrl) return { error: "link (targetUrl) is required" };

  let steps: WorkflowStep[];
  if (Array.isArray(body.stepsJson) && body.stepsJson.length > 0) {
    // Validated here, at the same gate as everything else: a malformed
    // workflow must never reach a worker, whichever door it came in by.
    const parsed = validateJsonWorkflow({
      name: body.name ?? "",
      version: JSON_WORKFLOW_VERSION,
      steps: body.stepsJson,
    });
    if (!parsed.ok) return { error: `task steps: ${formatWorkflowErrors(parsed.errors)}` };
    steps = normalizeWorkflowSteps(parsed.workflow.steps);
  } else {
    steps = normalizeSteps(body.steps ?? "");
    // normalizeSteps always injects "open {{url}}", so a script of nothing
    // but that means the task field was left empty.
    if (steps.length < 2) return { error: "task steps are required" };
  }

  const userNames = (Array.isArray(body.userNames) ? body.userNames : [])
    .map((n) => String(n ?? "").trim())
    .filter(Boolean);
  const userIds = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (userNames.length + userIds.length === 0) {
    return { error: "at least one user name or linked user is required" };
  }
  if (userNames.length + userIds.length > MAX_USERS_PER_GROUP) {
    return { error: `too many users (max ${MAX_USERS_PER_GROUP} per group)` };
  }

  let startTime: string;
  let endTime: string;
  try {
    startTime = formatHhMm(parseHhMm(body.startTime ?? ""));
    endTime = formatHhMm(parseHhMm(body.endTime ?? ""));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid time" };
  }
  if (startTime === endTime) return { error: "start time and end time must differ" };

  const leadMinutes = Math.trunc(Number(body.leadMinutes ?? 0));
  if (!Number.isFinite(leadMinutes) || leadMinutes < 0 || leadMinutes > 120) {
    return { error: "start-early lead must be between 0 and 120 minutes" };
  }

  // Weekdays, 0 = Sunday … 6 = Saturday. Deduped and sorted so the stored
  // value is canonical however the checkboxes were clicked.
  const days = [...new Set(Array.isArray(body.days) ? body.days : ALL_DAYS)]
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
  if (days.length === 0) return { error: "pick at least one day for the group to run on" };

  const timezone = body.timezone?.trim() || serverTimezone();
  if (!isValidTimezone(timezone)) return { error: `unknown timezone "${timezone}"` };

  const groupType: GroupType = isGroupType(body.groupType) ? body.groupType : "standard";
  const assessmentTemplateId = body.assessmentTemplateId?.trim() || null;
  // A standard group has no quiz to describe, so silently keep the link off
  // it rather than storing a template it will never consult.
  if (groupType === "standard" && assessmentTemplateId) {
    return { error: "only an assessment group can have an assessment template" };
  }

  return {
    value: {
      name: body.name?.trim() ?? "",
      groupType,
      assessmentTemplateId: groupType === "assessment" ? assessmentTemplateId : null,
      // "" and undefined both mean Unassigned — a <select> with no choice
      // made posts the empty string, not null.
      organizationId: body.organizationId?.trim() || null,
      targetUrl,
      steps,
      userNames,
      userIds,
      startTime,
      endTime,
      leadMinutes,
      days,
      timezone,
      enabled: body.enabled !== false,
    },
  };
}

/** null (Unassigned) is always fine; a named organization has to exist. */
async function organizationMissing(organizationId: string | null, account: string): Promise<boolean> {
  return organizationId !== null && !(await getOrganization(organizationId, account));
}

/**
 * A quiz template has to exist IN THIS WORKSPACE.
 *
 * Without this a group could name any template id it liked, including one
 * belonging to another account — which would then be read, and run, as this
 * group's portal configuration. Same shape as the organization and linked-
 * user checks either side of it: the scoped read IS the check.
 */
async function assessmentTemplateMissing(templateId: string | null, account: string): Promise<boolean> {
  return templateId !== null && !(await getTemplate(templateId, account));
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  // Every group route is tenant data: no exceptions, so the hook is set
  // once on the whole plugin rather than per route, where a new route
  // could be added without one.
  app.addHook("preHandler", requireAuth);

  app.get("/api/groups", async (req) => {
    const account = accountId(req);
    const groups = await listGroups(account);
    return {
      groups: await Promise.all(groups.map((g) => withSchedule(g, account))),
      serverTimezone: serverTimezone(),
    };
  });

  app.get("/api/groups/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });
    return { group: await withSchedule(group, account), serverTimezone: serverTimezone() };
  });

  app.post("/api/groups", async (req, reply) => {
    const account = accountId(req);
    const parsed = parseGroupBody((req.body ?? {}) as CreateGroupBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    if (await organizationMissing(parsed.value.organizationId, account)) {
      return reply.code(400).send({ error: "that organization no longer exists" });
    }
    if ((await getUsersByIds(parsed.value.userIds, account)).length !== parsed.value.userIds.length) {
      return reply.code(400).send({ error: "one or more selected users no longer exist" });
    }
    if (await assessmentTemplateMissing(parsed.value.assessmentTemplateId, account)) {
      return reply.code(400).send({ error: "that quiz template no longer exists" });
    }

    const group = await createGroup({
      ...parsed.value,
      accountId: account,
      name: parsed.value.name || `Group ${new Date().toISOString()}`,
    });
    reply.code(201).send({ group: await withSchedule(group, account) });
  });

  /**
   * Full edit. A saved group is meant to stay exactly as configured until
   * someone deliberately changes it, so this replaces the whole definition
   * — prompt, roster, window, days — while keeping the group's identity and
   * its run history.
   */
  app.put("/api/groups/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const existing = await getGroup(id, account);
    if (!existing) return reply.code(404).send({ error: "not found" });

    const parsed = parseGroupBody((req.body ?? {}) as CreateGroupBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    if (await organizationMissing(parsed.value.organizationId, account)) {
      return reply.code(400).send({ error: "that organization no longer exists" });
    }
    if ((await getUsersByIds(parsed.value.userIds, account)).length !== parsed.value.userIds.length) {
      return reply.code(400).send({ error: "one or more selected users no longer exist" });
    }
    if (await assessmentTemplateMissing(parsed.value.assessmentTemplateId, account)) {
      return reply.code(400).send({ error: "that quiz template no longer exists" });
    }

    const group = await updateGroup(id, account, {
      ...parsed.value,
      name: parsed.value.name || existing.name,
    });
    if (!group) return reply.code(404).send({ error: "not found" });
    reply.send({ group: await withSchedule(group, account) });
  });

  app.patch("/api/groups/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled (boolean) is required" });
    }
    const group = await setGroupEnabled(id, account, body.enabled);
    if (!group) return reply.code(404).send({ error: "not found" });
    // Turning a group off while its window is live is handled by the
    // scheduler's next tick, which stops the run it's holding open.
    return { group: await withSchedule(group, account) };
  });

  /**
   * Link an existing user into this group's roster. The Organizations tab
   * needs both halves of "who is in this department": create a new person
   * (POST /api/users with a groupId), or move someone who already exists
   * into it — this is that second half.
   */
  app.post("/api/groups/:id/users", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const { userId } = (req.body ?? {}) as { userId?: string };
    if (!userId?.trim()) return reply.code(400).send({ error: "userId is required" });

    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });
    if ((await getUsersByIds([userId], account)).length === 0) {
      return reply.code(400).send({ error: "that user no longer exists" });
    }
    if (group.userNames.length + group.userIds.length >= MAX_USERS_PER_GROUP) {
      return reply.code(400).send({ error: `too many users (max ${MAX_USERS_PER_GROUP} per group)` });
    }

    await addUserToGroup(id, userId);
    const updated = await getGroup(id, account);
    reply.send({ group: await withSchedule(updated!, account) });
  });

  /** Remove one user from this group only — they keep their login and stay
   * in every other group they belong to. */
  app.delete("/api/groups/:id/users/:userId", async (req, reply) => {
    const account = accountId(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });

    await removeUserFromGroup(id, userId);
    const updated = await getGroup(id, account);
    reply.send({ group: await withSchedule(updated!, account) });
  });

  // Wipe a group's saved logins/cookies. The next run for each user starts
  // signed out and fresh — the fix for a stale or wrong Teams session.
  app.post("/api/groups/:id/clear-profiles", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });
    if (group.activeJobId) {
      return reply.code(409).send({ error: "stop the group's current run before clearing its profiles" });
    }
    try {
      clearGroupProfiles(id);
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : "could not clear profiles" });
    }
    reply.send({ ok: true });
  });

  app.delete("/api/groups/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });
    // Don't strand a live run with no group left to stop it.
    if (group.activeJobId) await stopJob(group.activeJobId);
    await deleteGroup(id, account);
    reply.send({ ok: true });
  });

  /**
   * Start a group's run right now without waiting for its window — the way
   * you check a group actually works instead of finding out at 5 PM.
   * Deliberately does NOT consume the day's occurrence: the scheduled run
   * still happens on time. The window's end still stops it.
   */
  app.post("/api/groups/:id/run-now", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });
    if (group.activeJobId) {
      return reply.code(409).send({ error: "this group already has a run in progress" });
    }

    const linked = await getUsersByIds(group.userIds, account);
    const users = [...buildNamedUsers(group.userNames), ...buildLinkedUsers(linked)];
    // A roster that resolves to nobody produces a job with no sessions: it
    // completes the instant it starts and reads, everywhere afterwards, as a
    // run that went fine. Refuse it here so pressing Join now says why.
    if (users.length === 0) {
      return reply.code(400).send({
        error: "this group has no users to run — add a name or link a person to it first",
      });
    }

    // An assessment group has to be configured before it can run: a
    // template, its selectors, and a working AI provider. Checked here so
    // the answer arrives at the button, naming what to fill in, rather
    // than as a browser flailing at a page it cannot read.
    let assessment = null;
    let concurrencyLimit: number | undefined;
    if (group.groupType === "assessment") {
      const plan = await planAssessmentRun(group);
      if (!plan.ok) return reply.code(400).send({ error: plan.error });
      assessment = plan.plan.assessment;
      concurrencyLimit = plan.plan.browserConcurrency;
    }

    const { job } = await launchJob({
      name: `${group.name} — manual run`,
      targetUrl: group.targetUrl,
      steps: group.steps,
      users,
      groupId: group.id,
      // Without this the run is created owned by nobody, and every
      // account-scoped read of it then fails — including the WebSocket's
      // ownership check, which is what makes the live view sit there
      // loading forever while the run itself is happily going.
      accountId: account,
      kind: group.groupType === "assessment" ? "assessment" : "automation",
      assessment,
      concurrencyLimit,
    });
    const claimed = await setGroupActiveJob(group.id, job.id);
    if (!claimed) {
      // The scheduler opened the window in the gap between the check above
      // and this claim — back the duplicate out rather than leaving two
      // runs live for one group.
      await stopJob(job.id);
      return reply.code(409).send({ error: "this group already has a run in progress" });
    }
    reply.code(201).send({ jobId: job.id });
  });

  /** Stop the run this group is currently holding open, before its end time. */
  app.post("/api/groups/:id/stop-now", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });
    if (!group.activeJobId) return reply.code(409).send({ error: "this group has no run in progress" });

    const jobId = group.activeJobId;
    const stopped = await stopJob(jobId);
    // Consume the current occurrence so the scheduler doesn't immediately
    // relaunch what was just stopped — but only for a scheduled run. A
    // manual "Join now" never claimed the occurrence, so stopping it must
    // leave the day's scheduled run still to come.
    const now = zonedNow(group.timezone);
    const start = effectiveStartMinutes(parseHhMm(group.startTime), group.leadMinutes);
    const state = windowStateAt(start, parseHhMm(group.endTime), now, group.days);
    await releaseGroupRun(group.id, group.activeRunIsManual ? null : state.occurrenceKey, true);
    void raiseAlert({
      level: "INFO",
      lifecycle: true,
      source: "groups",
      message: "Stopped by hand",
      groupName: group.name,
      jobId,
    });
    reply.send({ ok: true, stopped });
  });
}
