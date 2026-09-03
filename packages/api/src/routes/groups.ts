import type { FastifyInstance } from "fastify";
import {
  addUserToGroup,
  createGroup,
  deleteGroup,
  getGroup,
  getOrganization,
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
  type Group,
  type GroupWithSchedule,
} from "@automation/shared";
import { launchJob, normalizeSteps, stopJob } from "../services/launch.js";
import { clearGroupProfiles, seedGroupFromMaster, masterLoginExists } from "../services/profiles.js";
import { userLoginExists } from "../services/users.js";
import { raiseAlert } from "../alerts.js";

const MAX_USERS_PER_GROUP = 200;

interface CreateGroupBody {
  name?: string;
  organizationId?: string | null;
  targetUrl?: string;
  steps?: string;
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
async function withSchedule(group: Group): Promise<GroupWithSchedule> {
  const now = zonedNow(group.timezone);
  // Schedule against the lead-adjusted start, not the time the user typed —
  // that's the whole point of the lead.
  const start = effectiveStartMinutes(parseHhMm(group.startTime), group.leadMinutes);
  const state = windowStateAt(start, parseHhMm(group.endTime), now, group.days);
  const linked = await getUsersByIds(group.userIds);
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
  organizationId: string | null;
  targetUrl: string;
  steps: string[];
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

  const steps = normalizeSteps(body.steps ?? "");
  // normalizeSteps always injects "open {{url}}", so a script of nothing but
  // that means the task field was left empty.
  if (steps.length < 2) return { error: "task steps are required" };

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

  return {
    value: {
      name: body.name?.trim() ?? "",
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
async function organizationMissing(organizationId: string | null): Promise<boolean> {
  return organizationId !== null && !(await getOrganization(organizationId));
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/groups", async () => {
    const groups = await listGroups();
    return { groups: await Promise.all(groups.map(withSchedule)), serverTimezone: serverTimezone() };
  });

  app.get("/api/groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = await getGroup(id);
    if (!group) return reply.code(404).send({ error: "not found" });
    return { group: await withSchedule(group), serverTimezone: serverTimezone() };
  });

  app.post("/api/groups", async (req, reply) => {
    const parsed = parseGroupBody((req.body ?? {}) as CreateGroupBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    if (await organizationMissing(parsed.value.organizationId)) {
      return reply.code(400).send({ error: "that organization no longer exists" });
    }
    if ((await getUsersByIds(parsed.value.userIds)).length !== parsed.value.userIds.length) {
      return reply.code(400).send({ error: "one or more selected users no longer exist" });
    }

    const group = await createGroup({
      ...parsed.value,
      name: parsed.value.name || `Group ${new Date().toISOString()}`,
    });
    reply.code(201).send({ group: await withSchedule(group) });
  });

  /**
   * Full edit. A saved group is meant to stay exactly as configured until
   * someone deliberately changes it, so this replaces the whole definition
   * — prompt, roster, window, days — while keeping the group's identity and
   * its run history.
   */
  app.put("/api/groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await getGroup(id);
    if (!existing) return reply.code(404).send({ error: "not found" });

    const parsed = parseGroupBody((req.body ?? {}) as CreateGroupBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    if (await organizationMissing(parsed.value.organizationId)) {
      return reply.code(400).send({ error: "that organization no longer exists" });
    }
    if ((await getUsersByIds(parsed.value.userIds)).length !== parsed.value.userIds.length) {
      return reply.code(400).send({ error: "one or more selected users no longer exist" });
    }

    const group = await updateGroup(id, {
      ...parsed.value,
      name: parsed.value.name || existing.name,
    });
    if (!group) return reply.code(404).send({ error: "not found" });
    reply.send({ group: await withSchedule(group) });
  });

  app.patch("/api/groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled (boolean) is required" });
    }
    const group = await setGroupEnabled(id, body.enabled);
    if (!group) return reply.code(404).send({ error: "not found" });
    // Turning a group off while its window is live is handled by the
    // scheduler's next tick, which stops the run it's holding open.
    return { group: await withSchedule(group) };
  });

  /**
   * Link an existing user into this group's roster. The Organizations tab
   * needs both halves of "who is in this department": create a new person
   * (POST /api/users with a groupId), or move someone who already exists
   * into it — this is that second half.
   */
  app.post("/api/groups/:id/users", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = (req.body ?? {}) as { userId?: string };
    if (!userId?.trim()) return reply.code(400).send({ error: "userId is required" });

    const group = await getGroup(id);
    if (!group) return reply.code(404).send({ error: "not found" });
    if ((await getUsersByIds([userId])).length === 0) {
      return reply.code(400).send({ error: "that user no longer exists" });
    }
    if (group.userNames.length + group.userIds.length >= MAX_USERS_PER_GROUP) {
      return reply.code(400).send({ error: `too many users (max ${MAX_USERS_PER_GROUP} per group)` });
    }

    await addUserToGroup(id, userId);
    const updated = await getGroup(id);
    reply.send({ group: await withSchedule(updated!) });
  });

  /** Remove one user from this group only — they keep their login and stay
   * in every other group they belong to. */
  app.delete("/api/groups/:id/users/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const group = await getGroup(id);
    if (!group) return reply.code(404).send({ error: "not found" });

    await removeUserFromGroup(id, userId);
    const updated = await getGroup(id);
    reply.send({ group: await withSchedule(updated!) });
  });

  // Wipe a group's saved logins/cookies. The next run for each user starts
  // signed out and fresh — the fix for a stale or wrong Teams session.
  app.post("/api/groups/:id/clear-profiles", async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = await getGroup(id);
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

  // Seed every user in the group from the single shared master login, so
  // each one opens Teams already signed in — the fix for the guest/cookie
  // error when a meeting link is opened cold.
  app.post("/api/groups/:id/apply-master", async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = await getGroup(id);
    if (!group) return reply.code(404).send({ error: "not found" });
    if (group.activeJobId) {
      return reply.code(409).send({ error: "stop the group's current run before applying the master login" });
    }
    if (!masterLoginExists()) {
      return reply.code(409).send({ error: "no master login yet — sign in under Settings first" });
    }
    try {
      const seeded = seedGroupFromMaster(id, group.userNames.length);
      reply.send({ ok: true, seeded });
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : "could not apply master login" });
    }
  });

  app.delete("/api/groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = await getGroup(id);
    if (!group) return reply.code(404).send({ error: "not found" });
    // Don't strand a live run with no group left to stop it.
    if (group.activeJobId) await stopJob(group.activeJobId);
    await deleteGroup(id);
    reply.send({ ok: true });
  });

  /**
   * Start a group's run right now without waiting for its window — the way
   * you check a group actually works instead of finding out at 5 PM.
   * Deliberately does NOT consume the day's occurrence: the scheduled run
   * still happens on time. The window's end still stops it.
   */
  app.post("/api/groups/:id/run-now", async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = await getGroup(id);
    if (!group) return reply.code(404).send({ error: "not found" });
    if (group.activeJobId) {
      return reply.code(409).send({ error: "this group already has a run in progress" });
    }

    const linked = await getUsersByIds(group.userIds);
    const { job } = await launchJob({
      name: `${group.name} — manual run`,
      targetUrl: group.targetUrl,
      steps: group.steps,
      users: [...buildNamedUsers(group.userNames), ...buildLinkedUsers(linked)],
      groupId: group.id,
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
    const { id } = req.params as { id: string };
    const group = await getGroup(id);
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
