import type { BrowserContext, Page } from "playwright";

/**
 * Which page in this session's browser we are actually driving.
 *
 * A persistent context opens with one page and the old code held onto it
 * forever: `const page = context.pages()[0]`. That is wrong the moment the
 * site opens a second tab, which is the normal path for the things this
 * platform automates — a meeting link hands off to a new window, an SSO
 * flow pops one up, a "join on the web instead" link targets _blank. From
 * that point the screencast kept streaming the abandoned first tab (so the
 * live view looked frozen on a page nobody was on) and every remaining step
 * ran against it (so "click Join" searched a document that no longer had
 * one).
 *
 * Following the newest page and falling back when it closes keeps both the
 * picture and the script pointed at whatever the user would be looking at.
 */
export interface ActivePage {
  /** The page to drive and to stream right now. */
  readonly current: Page;
  /** Called whenever `current` changes. */
  onChange(fn: (page: Page) => void): void;
  dispose(): void;
}

export function trackActivePage(context: BrowserContext, initial: Page): ActivePage {
  let current = initial;
  const listeners: ((page: Page) => void)[] = [];

  function switchTo(next: Page): void {
    if (next === current || next.isClosed()) return;
    current = next;
    for (const fn of listeners) fn(next);
  }

  function watchClose(page: Page): void {
    page.on("close", () => {
      if (page !== current) return;
      // Fall back to the most recently opened page that is still open —
      // usually the tab that spawned this one.
      const open = context.pages().filter((p) => !p.isClosed());
      const next = open[open.length - 1];
      if (next) switchTo(next);
    });
  }

  function onNewPage(page: Page): void {
    watchClose(page);
    // A brand-new page has no document yet; streaming it immediately would
    // just publish a blank frame. Waiting for first paint is best-effort —
    // a page that never loads still becomes current, because a stuck new
    // tab is exactly what someone needs to see.
    page
      .waitForLoadState("domcontentloaded", { timeout: 15_000 })
      .catch(() => {})
      .finally(() => switchTo(page));
  }

  watchClose(initial);
  context.on("page", onNewPage);

  return {
    get current() {
      return current;
    },
    onChange(fn) {
      listeners.push(fn);
    },
    dispose() {
      context.off("page", onNewPage);
      listeners.length = 0;
    },
  };
}
