import type { FastifyInstance } from "fastify";
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  setGroupActiveJob,
  setGroupEnabled,
  releaseGroupRun,
  updateGroup,
} from "@automation/db";
import {
  ALL_DAYS,
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

const MAX_USERS_PER_GROUP = 200;

interface CreateGroupBody {
  name?: string;
  targetUrl?: string;
  steps?: string;
  userNames?: string[];
  startTime?: string;
  endTime?: string;
  leadMinutes?: number;
  days?: number[];
  timezone?: string;
  enabled?: boolean;
}

/** Attaches the live "where are we in the window right now" read-out the
 * dashboard shows, computed server-side so the countdown reflects the
 * server's clock — the only clock that actually fires these. */
function withSchedule(group: Group): GroupWithSchedule {
  const now = zonedNow(group.timezone);
  // Schedule against the lead-adjusted start, not the time the user typed —
  // that's the whole point of the lead.
  const start = effectiveStartMinutes(parseHhMm(group.startTime), group.leadMinutes);
  const state = windowStateAt(start, parseHhMm(group.endTime), now, group.days);
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
  };
}

interface ParsedGroup {
  name: string;
  targetUrl: string;
  steps: string[];
  userNames: string[];
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
  if (userNames.length === 0) return { error: "at least one user name is required" };
  if (userNames.length > MAX_USERS_PER_GROUP) {
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
      targetUrl,
      steps,
      userNames,
      startTime,
      endTime,
      leadMinutes,
      days,
      timezone,
      enabled: body.enabled !== false,
    },
  };
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/groups", async () => {
    const groups = await listGroups();
    return { groups: groups.map(withSchedule), serverTimezone: serverTimezone() };
  });

  app.get("/api/groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = await getGroup(id);
    if (!group) return reply.code(404).send({ error: "not found" });
    return { group: withSchedule(group), serverTimezone: serverTimezone() };
  });

  app.post("/api/groups", async (req, reply) => {
    const parsed = parseGroupBody((req.body ?? {}) as CreateGroupBody);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });

    const group = await createGroup({
      ...parsed.value,
      name: parsed.value.name || `Group ${new Date().toISOString()}`,
    });
    reply.code(201).send({ group: withSchedule(group) });
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

    const group = await updateGroup(id, {
      ...parsed.value,
      name: parsed.value.name || existing.name,
    });
    if (!group) return reply.code(404).send({ error: "not found" });
    reply.send({ group: withSchedule(group) });
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
    return { group: withSchedule(group) };
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

    const { job } = await launchJob({
      name: `${group.name} — manual run`,
      targetUrl: group.targetUrl,
      steps: group.steps,
      users: buildNamedUsers(group.userNames),
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

    const stopped = await stopJob(group.activeJobId);
    // Consume the current occurrence so the scheduler doesn't immediately
    // relaunch what was just stopped — but only for a scheduled run. A
    // manual "Join now" never claimed the occurrence, so stopping it must
    // leave the day's scheduled run still to come.
    const now = zonedNow(group.timezone);
    const start = effectiveStartMinutes(parseHhMm(group.startTime), group.leadMinutes);
    const state = windowStateAt(start, parseHhMm(group.endTime), now, group.days);
    await releaseGroupRun(group.id, group.activeRunIsManual ? null : state.occurrenceKey, true);
    reply.send({ ok: true, stopped });
  });
}
