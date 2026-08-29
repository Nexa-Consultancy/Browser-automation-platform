import type { CDPSession, Page } from "playwright";
import type { Redis } from "ioredis";
import { screencastChannel, screencastLastFrameKey } from "@automation/queue";

const LAST_FRAME_TTL_SECONDS = 3600;

/** Streams a live JPEG screencast of the page over CDP so the dashboard can
 * render each isolated session's browser as it runs (and, combined with
 * input passthrough, be clicked/typed into interactively). */
export async function startScreencast(page: Page, sessionId: string, pub: Redis): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: 55,
    maxWidth: 960,
    maxHeight: 600,
    everyNthFrame: 1,
  });
  client.on("Page.screencastFrame", (payload: { data: string; sessionId: number }) => {
    pub.publish(screencastChannel(sessionId), payload.data).catch(() => {});
    pub.set(screencastLastFrameKey(sessionId), payload.data, "EX", LAST_FRAME_TTL_SECONDS).catch(() => {});
    client.send("Page.screencastFrameAck", { sessionId: payload.sessionId }).catch(() => {});
  });
  return client;
}
