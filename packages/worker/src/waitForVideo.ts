import type { Page } from "playwright";

interface VideoState {
  found: boolean;
  allEnded?: boolean;
  currentTime?: number;
  duration?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Polls the page for HTML5 <video> elements and blocks until every one
 * found has ended. Built as a Node-side poll loop (not page.waitForFunction)
 * so a Stop click can abort it instantly even mid-way through a 2-hour
 * video, and so we can surface a live "N minutes elapsed" timer.
 *
 * Cross-origin embeds (YouTube/Vimeo iframes) aren't reachable due to
 * browser same-origin restrictions — only native <video> tags on the page
 * itself are visible to this check.
 */
export async function waitForVideoToEnd(
  page: Page,
  opts: {
    maxWaitMs: number;
    signal: AbortSignal;
    onTick: (elapsedMs: number, currentTime: number, duration: number) => void;
  },
): Promise<void> {
  const start = Date.now();
  const pollMs = 2000;
  const tickEveryMs = 5000;
  let lastTick = -tickEveryMs;
  let everFound = false;

  while (Date.now() - start < opts.maxWaitMs) {
    if (opts.signal.aborted) return;

    const state: VideoState = await page
      .evaluate(() => {
        const vids = Array.from(document.querySelectorAll("video"));
        if (vids.length === 0) return { found: false };
        return {
          found: true,
          allEnded: vids.every((v) => v.ended),
          currentTime: Math.max(...vids.map((v) => v.currentTime || 0)),
          duration: Math.max(...vids.map((v) => (Number.isFinite(v.duration) ? v.duration : 0))),
        };
      })
      .catch(() => ({ found: false }) as VideoState);

    if (state.found) {
      everFound = true;
      if (state.allEnded) return;
      const elapsed = Date.now() - start;
      if (elapsed - lastTick >= tickEveryMs) {
        lastTick = elapsed;
        opts.onTick(elapsed, state.currentTime ?? 0, state.duration ?? 0);
      }
    } else if (everFound) {
      // Video element was present and is now gone (player unmounted) — treat as finished.
      return;
    } else if (Date.now() - start > 15000) {
      // No <video> ever appeared within the grace period — nothing to wait for.
      return;
    }

    await sleep(pollMs, opts.signal);
  }

  throw new Error(`wait for video: exceeded max wait time (${Math.round(opts.maxWaitMs / 60000)} min)`);
}
