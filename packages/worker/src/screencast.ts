import type { CDPSession, Page } from "playwright";
import type { Redis } from "ioredis";
import { screencastChannel, screencastLastFrameKey } from "@automation/queue";
import type { ActivePage } from "./activePage.js";

const LAST_FRAME_TTL_SECONDS = 3600;

/** How long the live view may go without a frame before one is taken by
 * hand. CDP only pushes on repaint, so a page that is simply sitting there
 * — a meeting waiting room, a finished script parked for a follow-up —
 * emits nothing at all, and a dashboard that connected after the last
 * repaint has nothing to show. */
const KEEPALIVE_MS = 10_000;

export interface SessionStream {
  stop(): Promise<void>;
}

/**
 * Streams a live JPEG screencast of whatever page this session is currently
 * driving, so the dashboard can render each isolated session's browser as it
 * runs (and, combined with input passthrough, be clicked/typed into).
 *
 * Three things beyond "start CDP screencast", each fixing a way the live
 * view could sit on "waiting for stream…" or show the wrong thing:
 *
 *  - It follows the active page. Bound to one page, the stream froze on the
 *    first tab the moment a site opened a second one.
 *  - It publishes a frame straight away rather than waiting for the page to
 *    repaint, so a session that opens onto a static page is visible within
 *    a second instead of whenever something happens to move.
 *  - It takes a keepalive frame when the page has been quiet, which also
 *    refreshes the cached last frame that a reconnecting dashboard replays.
 */
export async function startSessionStream(active: ActivePage, sessionId: string, pub: Redis): Promise<SessionStream> {
  const channel = screencastChannel(sessionId);
  const lastFrameKey = screencastLastFrameKey(sessionId);
  let stopped = false;
  let client: CDPSession | null = null;
  let attachedTo: Page | null = null;
  let lastSentAt = 0;

  function publish(frame: string): void {
    if (stopped) return;
    lastSentAt = Date.now();
    pub.publish(channel, frame).catch(() => {});
    pub.set(lastFrameKey, frame, "EX", LAST_FRAME_TTL_SECONDS).catch(() => {});
  }

  async function captureNow(page: Page): Promise<void> {
    if (stopped || page.isClosed()) return;
    // A short timeout: a screenshot of a page mid-navigation can hang, and
    // a missed keepalive matters far less than a stuck stream.
    const buf = await page.screenshot({ type: "jpeg", quality: 55, timeout: 5000 }).catch(() => null);
    if (buf) publish(buf.toString("base64"));
  }

  async function attach(page: Page): Promise<void> {
    if (stopped || page.isClosed()) return;
    const previous = client;
    attachedTo = page;
    try {
      const next = await page.context().newCDPSession(page);
      await next.send("Page.startScreencast", {
        format: "jpeg",
        quality: 55,
        maxWidth: 960,
        maxHeight: 600,
        everyNthFrame: 1,
      });
      next.on("Page.screencastFrame", (payload: { data: string; sessionId: number }) => {
        // Frames from a session we have already moved on from would fight
        // with the current page for the live view.
        if (attachedTo !== page) return;
        publish(payload.data);
        next.send("Page.screencastFrameAck", { sessionId: payload.sessionId }).catch(() => {});
      });
      client = next;
    } finally {
      await previous?.detach().catch(() => {});
    }
    await captureNow(page);
  }

  await attach(active.current);
  active.onChange((page) => {
    void attach(page);
  });

  const keepalive = setInterval(() => {
    if (Date.now() - lastSentAt < KEEPALIVE_MS) return;
    void captureNow(active.current);
  }, KEEPALIVE_MS);
  keepalive.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(keepalive);
      await client?.detach().catch(() => {});
      client = null;
    },
  };
}
