import { chromium, type Browser, type Page } from "playwright";
import {
  getJob,
  listSessionsByJob,
  setJobStatus,
  updateSessionStatus,
  updateSessionStep,
  setVideoWaitStarted,
  bumpTotalSteps,
} from "@automation/db";
import { newRedisConnection, screencastChannel, screencastLastFrameKey } from "@automation/queue";
import { parseSteps, type Job, type SessionRow, type ParsedStep, type InputAction } from "@automation/shared";
import { subscribeControl } from "./controlListener.js";
import { startScreencast } from "./screencast.js";
import { executeStep } from "./stepExecutor.js";
import { emitEvent } from "./events.js";
import { publishAlert } from "./alert.js";

const MAX_VIDEO_WAIT_MS = Number(process.env.MAX_VIDEO_WAIT_MS ?? 10_800_000);

export async function runJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const sessions = await listSessionsByJob(jobId);

  await setJobStatus(jobId, "running");

  const browser = await chromium.launch({ headless: true });
  try {
    await runWithConcurrency(sessions, job.concurrency, (session) =>
      runSession(browser, job, session).catch((err) =>
        console.error(`session ${session.id} crashed:`, err),
      ),
    );
  } finally {
    await browser.close().catch(() => {});
  }

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
export async function runSession(browser: Browser, job: Job, session: SessionRow): Promise<void> {
  const pub = newRedisConnection();
  // Fixed viewport so the dashboard's screencast click passthrough can map
  // displayed pixel coordinates back to real page coordinates deterministically
  // (see packages/dashboard/src/viewport.ts — keep these two in sync).
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  let stopped = false;
  let abort = new AbortController();
  let stepQueue: ParsedStep[] = parseSteps(job.steps);
  let cursor = 0;
  let resumeWaiter: (() => void) | null = null;
  // {{url}} defaults to the job's Target URL so "open {{url}}" works with
  // no CSV at all; a CSV column literally named "url" overrides it per user
  // (e.g. per-user meeting links).
  const row = { url: job.targetUrl, ...session.rowData };

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
      applyInput(page, msg.action).catch((e) => {
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

  try {
    await startScreencast(page, session.id, pub);
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
        await executeStep(page, step, {
          row,
          signal: abort.signal,
          maxVideoWaitMs: MAX_VIDEO_WAIT_MS,
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
    await context.close().catch(() => {});
    pub.disconnect();
  }
}
