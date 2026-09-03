import {
  claimGroupOccurrence,
  getJob,
  getSettings,
  getUsersByIds,
  listAllGroups,
  releaseGroupRun,
} from "@automation/db";
import {
  buildLinkedUsers,
  buildNamedUsers,
  effectiveStartMinutes,
  parseHhMm,
  windowStateAt,
  zonedNow,
  formatHhMm,
  type Group,
  type JobStatus,
} from "@automation/shared";
import { raiseAlert } from "./alerts.js";
import { launchJob, stopJob } from "./services/launch.js";

const TICK_MS = Number(process.env.GROUP_SCHEDULER_TICK_MS ?? 20_000);

/** A job in one of these states is no longer holding any browser open. */
const FINISHED: JobStatus[] = ["completed", "stopped", "failed"];

interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * The group scheduler — the piece that makes a group run "with no person
 * involved". Every tick it asks, for each group: is the wall clock inside
 * this group's window right now, in this group's own timezone?
 *
 *   inside, and this occurrence hasn't fired -> launch a job
 *   outside, and a job is still held open    -> stop every session in it
 *
 * It is deliberately a *level* check ("are we inside the window?") rather
 * than an edge trigger ("did the clock just tick past 17:00?"). An edge
 * trigger silently misses its window whenever the API is restarted,
 * redeployed, or paused across the start minute — for a service meant to
 * run unattended on a server, that's the failure that matters most. The
 * level check just notices it's inside the window and catches up.
 *
 * Firing exactly once per occurrence is enforced in Postgres, not here:
 * `claimGroupOccurrence` only matches a row whose `last_occurrence_key`
 * isn't already this occurrence, so even if the API is run as more than one
 * replica, two racing ticks still produce exactly one job.
 */
export function startGroupScheduler(log: Logger): () => void {
  let running = false;

  async function tick(): Promise<void> {
    // Ticks must never overlap: a slow launch would otherwise let the next
    // tick evaluate the same group against stale "no active job" state.
    if (running) return;
    running = true;
    try {
      // The global kill switch: POST /api/system/stop-all sets this, and
      // while it's on the scheduler must not evaluate ANY group — not just
      // skip launching, but also skip the window-closed/held-off stop
      // branches below, or it would immediately "helpfully" clean up state
      // a human paused on purpose.
      const settings = await getSettings().catch(() => ({}) as Record<string, string>);
      if (settings.SCHEDULER_PAUSED === "true") return;

      for (const group of await listAllGroups()) {
        try {
          await evaluateGroup(group, log);
        } catch (err) {
          log.error(`group ${group.name} (${group.id}) scheduling failed: ${errText(err)}`);
        }
      }
    } catch (err) {
      log.error(`group scheduler tick failed: ${errText(err)}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.(); // never hold the process open for the scheduler alone
  void tick(); // catch up on boot rather than waiting out a full tick

  log.info(`group scheduler started (tick every ${Math.round(TICK_MS / 1000)}s)`);
  return () => clearInterval(timer);
}

async function evaluateGroup(group: Group, log: Logger): Promise<void> {
  const now = zonedNow(group.timezone);
  // The lead is applied here: a group set for 14:00 with a 5-minute lead
  // has its window open at 13:55, so the browsers are up before the event.
  const start = effectiveStartMinutes(parseHhMm(group.startTime), group.leadMinutes);
  const state = windowStateAt(start, parseHhMm(group.endTime), now, group.days);

  // Reap a run that already ended on its own — someone hit Stop from the
  // run view, or every session failed. For a *scheduled* run, consuming the
  // occurrence as we release it is what stops a deliberately-stopped run
  // from being relaunched by the very next tick while the window is still
  // open. A manual run never claimed the occurrence in the first place, so
  // stopping it must leave the day's scheduled run still to come.
  if (group.activeJobId) {
    const job = await getJob(group.activeJobId);
    if (!job || FINISHED.includes(job.status)) {
      const consumed = group.activeRunIsManual ? null : state.occurrenceKey;
      await releaseGroupRun(group.id, consumed, false);
      group = {
        ...group,
        activeJobId: null,
        activeRunIsManual: false,
        lastOccurrenceKey: consumed ?? group.lastOccurrenceKey,
      };
    }
  }

  // "Follow this schedule automatically" is off: this group only starts when
  // someone presses Join now. The scheduler still cleans up after itself —
  // a run *it* started loses its mandate the moment the clock is taken out
  // of the loop — but a manual run is the user driving and is left alone.
  if (!group.enabled) {
    if (group.activeJobId && !group.activeRunIsManual) {
      const jobId = group.activeJobId;
      await stopJob(jobId);
      await releaseGroupRun(group.id, state.occurrenceKey, true);
      log.info(`group ${group.name}: schedule held off mid-run — stopped job ${jobId}`);
      void raiseAlert({
        level: "INFO",
        lifecycle: true,
        source: "scheduler",
        message: `Stopped — schedule was held off mid-run`,
        groupName: group.name,
        jobId,
      });
    }
    return;
  }

  if (state.inWindow) {
    if (group.activeJobId || group.lastOccurrenceKey === state.occurrenceKey) return;

    // The scheduler has no account of its own; a group already names the
    // workspace it belongs to, so scope the roster lookup to that. A group
    // predating workspaces has no account at all, and passing "" for it made
    // Postgres reject the whole query (uuid = '') — which threw out of
    // evaluateGroup on every single tick, so the group never ran and the log
    // filled with the same failure every 20 seconds.
    const linked = group.accountId ? await getUsersByIds(group.userIds, group.accountId) : [];
    const users = [...buildNamedUsers(group.userNames), ...buildLinkedUsers(linked)];

    // Launching with an empty roster produces a job with no sessions, which
    // completes instantly and looks — in the run log, in the group card — as
    // though the group ran fine. Say what actually happened instead.
    if (users.length === 0) {
      await abandonOccurrence(group, state.occurrenceKey!, log, "no users are configured for it");
      return;
    }

    let job: { id: string };
    try {
      ({ job } = await launchJob({
        name: `${group.name} — ${state.occurrenceKey}`,
        targetUrl: group.targetUrl,
        steps: group.steps,
        users,
        accountId: group.accountId,
        groupId: group.id,
      }));
    } catch (err) {
      // Without consuming the occurrence a failing launch is retried every
      // tick for the rest of the window — the same error, the same alert,
      // for hours.
      await abandonOccurrence(group, state.occurrenceKey!, log, errText(err));
      return;
    }

    // Claim *after* creating the job: a crash mid-launch then leaves the
    // occurrence unclaimed and the next tick retries, rather than marking
    // the window done with nothing actually running.
    const claimed = await claimGroupOccurrence(group.id, job.id, state.occurrenceKey!);
    if (!claimed) {
      await stopJob(job.id); // another replica won the race — don't leave a duplicate live
      return;
    }
    log.info(
      `group ${group.name}: window opened ${formatHhMm(start)}–${group.endTime} ${group.timezone}` +
        `${group.leadMinutes ? ` (${group.leadMinutes}m before ${group.startTime})` : ""}` +
        ` — started job ${job.id} for ${users.length} user(s)`,
    );
    void raiseAlert({
      level: "INFO",
      lifecycle: true,
      source: "scheduler",
      message: `Started — running until ${group.endTime} ${group.timezone}, ${users.length} user(s)`,
      groupName: group.name,
      jobId: job.id,
    });
    return;
  }

  // Outside the window with a run still open. Only stop what the scheduler
  // itself started: a manual "Join now" is the user driving, and killing it
  // 20 seconds later because the clock says so would make the button
  // useless outside the window.
  if (group.activeJobId && !group.activeRunIsManual) {
    const jobId = group.activeJobId;
    await stopJob(jobId);
    await releaseGroupRun(group.id, null, true);
    log.info(`group ${group.name}: window closed at ${group.endTime} ${group.timezone} — stopped job ${jobId}`);
    void raiseAlert({
      level: "INFO",
      lifecycle: true,
      source: "scheduler",
      message: `Stopped — window closed at ${group.endTime} ${group.timezone}`,
      groupName: group.name,
      jobId,
    });
  }
}

/**
 * Marks an occurrence as dealt with when it could not be started, and says
 * why exactly once.
 *
 * The occurrence has to be consumed even though nothing ran: the window
 * stays open for hours after this, and an unconsumed occurrence is retried
 * on every tick — turning one misconfigured group into the same alert every
 * 20 seconds until its end time.
 */
async function abandonOccurrence(group: Group, occurrenceKey: string, log: Logger, reason: string): Promise<void> {
  await releaseGroupRun(group.id, occurrenceKey, false);
  log.error(`group ${group.name}: window opened but nothing started — ${reason}`);
  void raiseAlert({
    level: "ERROR",
    lifecycle: true,
    source: "scheduler",
    message: `Did not start — ${reason}. This window is skipped; the next one will be tried as normal.`,
    groupName: group.name,
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
