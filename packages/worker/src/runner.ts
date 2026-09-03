import { chromium, type Page } from "playwright";
import {
  getSettings,
  getJob,
  listSessionsByJob,
  setJobStatus,
  updateSessionStatus,
  updateSessionStep,
  setVideoWaitStarted,
  bumpTotalSteps,
} from "@automation/db";
import { newRedisConnection, screencastChannel, screencastLastFrameKey, takeCredential } from "@automation/queue";
import {
  USER_LOGIN_CAPTURE_JOB_NAME,
  parseSteps,
  type Job,
  type SessionRow,
  type ParsedStep,
  type InputAction,
} from "@automation/shared";
import { subscribeControl } from "./controlListener.js";
import { startSessionStream } from "./screencast.js";
import { trackActivePage } from "./activePage.js";
import { executeStep } from "./stepExecutor.js";
import { emitEvent } from "./events.js";
import { publishAlert } from "./alert.js";
import { clearProfileLocks, ensureDir, profilePlanFor, removeDir } from "./profile.js";
import { proxyFromSettings } from "./proxyFromSettings.js";

const MAX_VIDEO_WAIT_MS = Number(process.env.MAX_VIDEO_WAIT_MS ?? 10_800_000);
const DEFAULT_TIMEOUT_MS = 30_000;

/** How long an action may wait for its target, from the Settings page.
 * Read per run so a change takes effect on the next job without a restart. */
async function actionTimeoutMs(): Promise<number> {
  try {
    const n = Number((await getSettings()).BROWSER_TIMEOUT_MS);
    return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TIMEOUT_MS;
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

export async function runJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const sessions = await listSessionsByJob(jobId);

  await setJobStatus(jobId, "running");

  // Each session now launches its OWN persistent browser (see runSession):
  // a persistent profile is inseparable from its browser process, so the
  // old "one shared browser, many contexts" model can't carry per-user
  // saved logins. There's no shared browser to launch or close here anymore.
  await runWithConcurrency(sessions, job.concurrency, (session) =>
    runSession(job, session).catch((err) => console.error(`session ${session.id} crashed:`, err)),
  );

  const finalSessions = await listSessionsByJob(jobId);
  const anyFailed = finalSessions.some((s) => s.status === "failed");
  const allStopped = finalSessions.length > 0 && finalSessions.every((s) => s.status === "stopped");
  await setJobStatus(jobId, allStopped ? "stopped" : anyFailed ? "failed" : "completed");
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const poolSize = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: poolSize }, async () => {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function applyInput(page: Page, action: InputAction): Promise<void> {
  switch (action.kind) {
    case "click":
      await page.mouse.click(action.x, action.y);
      return;
    case "dblclick":
      await page.mouse.dblclick(action.x, action.y);
      return;
    case "rightclick":
      await page.mouse.click(action.x, action.y, { button: "right" });
      return;
    case "move":
      await page.mouse.move(action.x, action.y);
      return;
    case "type":
      await page.keyboard.type(action.text, { delay: 20 });
      return;
    case "key":
      await page.keyboard.press(action.key);
      return;
    case "scroll":
      await page.mouse.wheel(0, action.deltaY);
      return;
  }
}

/**
 * Runs one user's isolated session end to end: executes the job's step
 * script against a dedicated browser context (separate cookies/storage —
 * no state shared with any other user), then — instead of closing —
 * parks the session in "interactive" status so a follow-up prompt
 * (per-user or job-wide) or a manual Stop can still reach the live page.
 */
export async function runSession(job: Job, session: SessionRow): Promise<void> {
  const pub = newRedisConnection();
  const settings = await getSettings().catch(() => ({}) as Record<string, string>);
  const timeoutMs = await actionTimeoutMs();

  // A user's cookies, storage and logins live in their own on-disk profile
  // dir so a Teams (or any) sign-in done once carries into every later run.
  // That requires launchPersistentContext, which IS its own browser — so
  // this session owns a browser, not a context borrowed from a shared one.
  const plan = profilePlanFor(job, session, settings.PERSIST_PROFILES !== "false");
  ensureDir(plan.dir);
  // A previous crash can leave a stale lock that blocks Chromium from ever
  // opening this profile again; clear it before launching.
  clearProfileLocks(plan.dir);

  // Fixed viewport so the dashboard's screencast click passthrough can map
  // displayed pixel coordinates back to real page coordinates deterministically
  // (see packages/dashboard/src/viewport.ts — keep these two in sync).
  // A login-capture run for a reusable PlatformUser runs as a REAL, visible
  // browser (on the worker's virtual display) because Microsoft rejects
  // headless logins — a human needs to see the screen to finish "Stay
  // signed in?"/2FA by hand. Every other run stays headless: reusing
  // already-saved cookies doesn't trip the same check, and headless is far
  // lighter.
  const isLoginCapture = job.name === USER_LOGIN_CAPTURE_JOB_NAME && !job.groupId;
  // Route the browser through the proxy configured in Settings, if any, so
  // its traffic exits from there rather than this server's own IP. This is
  // what makes "appear to be somewhere else" actually work — and the way to
  // test whether a login failure is really the server's location: point it
  // at a proxy elsewhere and see if the same login succeeds.
  const proxy = proxyFromSettings(settings);
  const context = await chromium.launchPersistentContext(plan.dir, {
    headless: !isLoginCapture,
    viewport: { width: 1280, height: 720 },
    ...(proxy ? { proxy } : {}),
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    // A meeting's pre-join "Join" button stays disabled until the page's own
    // getUserMedia() check for a camera/mic resolves — with neither granted
    // nor a real device present, that call just hangs forever and Join never
    // enables, which is what a 30s timeout on "click Join" actually means.
    // Granting the permission AND feeding Chromium a fake device (there's no
    // real camera on this server either way) makes it resolve immediately
    // instead of hanging, regardless of whether the step script also clicks
    // a "continue without audio/video" toggle.
    permissions: ["camera", "microphone"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // Chromium as root (the container's user) can't sandbox a headful
      // browser; the virtual-display login needs this.
      ...(isLoginCapture ? ["--no-sandbox"] : []),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  // A persistent context opens with one page already; reuse it. Everything
  // downstream drives `active.current` rather than this one page, because a
  // site that opens a second tab moves the whole session there — see
  // activePage.ts.
  const firstPage = context.pages()[0] ?? (await context.newPage());
  const active = trackActivePage(context, firstPage);

  let stopped = false;
  let abort = new AbortController();
  let stepQueue: ParsedStep[] = parseSteps(job.steps);
  let cursor = 0;
  let resumeWaiter: (() => void) | null = null;
  // {{url}} defaults to the job's Target URL so "open {{url}}" works with
  // no CSV at all; a CSV column literally named "url" overrides it per user
  // (e.g. per-user meeting links).
  const row: Record<string, string> = { url: job.targetUrl, ...session.rowData };
  // A login-capture user's password never touches Postgres — it rides a
  // one-shot Redis stash (GETDEL: read exactly once, self-expiring) keyed
  // by this session's id, and only ever lives in this local variable for
  // the lifetime of the run. See packages/queue/src/credentials.ts.
  if (isLoginCapture) {
    const password = await takeCredential(session.id);
    if (password) row.password = password;
  }

  const control = subscribeControl(session.id, (msg) => {
    if (msg.type === "stop") {
      stopped = true;
      abort.abort();
      resumeWaiter?.();
    } else if (msg.type === "append_steps") {
      const parsed = parseSteps(msg.steps);
      // Insert at the current position rather than the end: when the
      // session is parked after a failure this makes a follow-up fix run
      // *next* (then the rest of the original script resumes); when parked
      // after finishing everything, cursor === stepQueue.length so this is
      // equivalent to appending at the end.
      stepQueue.splice(cursor, 0, ...parsed);
      void bumpTotalSteps(session.id, parsed.length);
      void emitEvent(session.id, job.id, "log", { message: `${parsed.length} more step(s) queued` });
      resumeWaiter?.();
    } else if (msg.type === "input") {
      applyInput(active.current, msg.action).catch((e) => {
        void emitEvent(session.id, job.id, "log", { message: `input failed: ${String(e)}` });
      });
    }
  });

  function waitForMoreStepsOrStop(): Promise<void> {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      resumeWaiter = () => {
        resumeWaiter = null;
        resolve();
      };
    });
  }

  let stream: Awaited<ReturnType<typeof startSessionStream>> | null = null;
  try {
    stream = await startSessionStream(active, session.id, pub);
  } catch (e) {
    await emitEvent(session.id, job.id, "log", { message: `screencast unavailable: ${String(e)}` });
  }

  await updateSessionStatus(session.id, "running", { startedAt: true });
  await emitEvent(session.id, job.id, "status_change", { status: "running" });

  try {
    while (cursor < stepQueue.length) {
      if (stopped) break;
      const step = stepQueue[cursor];
      await updateSessionStep(session.id, cursor, step.raw);
      await emitEvent(session.id, job.id, "step_start", { index: cursor, text: step.raw });

      abort = new AbortController();
      const isVideo = step.kind === "wait_video";
      if (isVideo) {
        await updateSessionStatus(session.id, "waiting_video");
        await setVideoWaitStarted(session.id, true);
      }

      let stepError: string | null = null;
      try {
        await executeStep(active.current, step, {
          row,
          signal: abort.signal,
          maxVideoWaitMs: MAX_VIDEO_WAIT_MS,
          timeoutMs,
          onVideoTick: (elapsedMs, currentTime, duration) => {
            void emitEvent(session.id, job.id, "video_wait_tick", { elapsedMs, currentTime, duration });
          },
          onScreenshot: (jpegBase64) => {
            pub.publish(screencastChannel(session.id), jpegBase64).catch(() => {});
            pub.set(screencastLastFrameKey(session.id), jpegBase64, "EX", 3600).catch(() => {});
          },
        });
      } catch (err) {
        stepError = err instanceof Error ? err.message : String(err);
      } finally {
        if (isVideo) {
          await setVideoWaitStarted(session.id, false);
          if (!stopped && stepError === null) {
            await updateSessionStatus(session.id, "running");
            await emitEvent(session.id, job.id, "status_change", { status: "running" });
          }
        }
      }

      if (stopped) break;

      if (stepError !== null) {
        // Don't tear the session down: something on the page wasn't where
        // the script expected (an element not visible yet, a step that
        // doesn't apply this time, ...). Park it open — exactly like a
        // normal finish — so the screencast stays clickable/typeable and a
        // follow-up ("second prompt") can steer it back on track. Only an
        // explicit Stop actually closes the browser from here.
        await updateSessionStatus(session.id, "failed", { error: stepError });
        await emitEvent(session.id, job.id, "step_failed", { index: cursor, error: stepError });
        await emitEvent(session.id, job.id, "status_change", { status: "failed" });
        publishAlert({
          level: "ERROR",
          source: "worker/step",
          message: `Step ${cursor + 1} failed for ${session.userName}: ${stepError}`,
          errorTrace: `Step: ${step.raw}

${stepError}`,
          jobId: job.id,
          sessionId: session.id,
          userName: session.userName,
          groupName: job.name,
        });
        cursor += 1;
        await waitForMoreStepsOrStop();
        if (!stopped) {
          await updateSessionStatus(session.id, "running", { error: null });
          await emitEvent(session.id, job.id, "status_change", { status: "running" });
        }
        continue;
      }

      await emitEvent(session.id, job.id, "step_done", { index: cursor, text: step.raw });
      cursor += 1;

      if (cursor === stepQueue.length) {
        await updateSessionStatus(session.id, "interactive");
        await emitEvent(session.id, job.id, "status_change", { status: "interactive" });
        await waitForMoreStepsOrStop();
        if (!stopped) {
          await updateSessionStatus(session.id, "running");
          await emitEvent(session.id, job.id, "status_change", { status: "running" });
        }
      }
    }

    if (stopped) {
      await updateSessionStatus(session.id, "stopped", { finishedAt: true });
      await emitEvent(session.id, job.id, "status_change", { status: "stopped" });
    } else {
      await updateSessionStatus(session.id, "completed", { finishedAt: true });
      await emitEvent(session.id, job.id, "status_change", { status: "completed" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    publishAlert({
      level: "ERROR",
      source: "worker/session",
      message: `Session crashed for ${session.userName}: ${message}`,
      errorTrace: err instanceof Error ? (err.stack ?? message) : message,
      jobId: job.id,
      sessionId: session.id,
      userName: session.userName,
      groupName: job.name,
    });
    await updateSessionStatus(session.id, "failed", { error: message, finishedAt: true });
    await emitEvent(session.id, job.id, "step_failed", { index: cursor, error: message });
    await emitEvent(session.id, job.id, "status_change", { status: "failed" });
  } finally {
    control.close();
    active.dispose();
    await stream?.stop();
    // Closing a persistent context closes its browser too. The profile dir
    // stays on disk (that's the point); a scratch dir for a one-off run is
    // reclaimed so ad-hoc runs don't leak directories nothing can reuse.
    await context.close().catch(() => {});
    if (!plan.persistent) removeDir(plan.dir);
    pub.disconnect();
  }
}
