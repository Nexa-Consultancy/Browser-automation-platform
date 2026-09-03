import type { Locator, Page } from "playwright";

/** Escapes a value for use inside a double-quoted CSS attribute selector. */
function quoteAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function looksLikeSelector(target: string): boolean {
  return /^[.#\[]/.test(target) || /^(css=|text=|xpath=)/.test(target) || target.includes(">>");
}

/** How often the resolve loop re-checks the page while waiting. Short
 * enough that a page ready in 300ms isn't held back by the poll, long
 * enough that a 30s wait is ~120 checks rather than thousands. */
const POLL_MS = 250;

/** Cap on how many matches of one strategy are examined. A bad strategy can
 * match hundreds of nodes (getByText on a common word); checking every one
 * would cost more than the wait it's part of. */
const MAX_CANDIDATE_MATCHES = 12;

/**
 * First *visible* match of one strategy, or null.
 *
 * This used to be written as `loc.locator(":visible")`, which was wrong in a
 * way that quietly disabled the whole "prefer the visible one" idea:
 * chaining a selector onto a locator searches that element's DESCENDANTS.
 * For an `<input>` — no children — it therefore always matched nothing and
 * fell through to `.first()`; for a `<button>` it matched the span *inside*
 * the button rather than the button. Checking the matches themselves is
 * both correct and version-independent (`filter({ visible })` only exists
 * in Playwright ≥1.51, and this repo is pinned to 1.49).
 */
async function firstVisibleOf(loc: Locator): Promise<Locator | null> {
  let count: number;
  try {
    count = await loc.count();
  } catch {
    // An invalid selector string throws here; the caller just tries the next strategy.
    return null;
  }
  const limit = Math.min(count, MAX_CANDIDATE_MATCHES);
  for (let i = 0; i < limit; i++) {
    const nth = loc.nth(i);
    try {
      if (await nth.isVisible()) return nth;
    } catch {
      // Element went away between count() and the check — keep looking.
    }
  }
  return null;
}

/** Any match at all, visible or not — the last-resort fallback so a failure
 * comes back as Playwright's precise actionability error ("element is not
 * visible") rather than our generic "could not find it". */
async function firstAnyOf(loc: Locator): Promise<Locator | null> {
  try {
    return (await loc.count()) > 0 ? loc.first() : null;
  } catch {
    return null;
  }
}

/**
 * Waits until one of the candidate strategies has a visible match, and
 * returns the match belonging to the highest-priority strategy that does.
 *
 * The previous implementation leaned on Playwright's `.or()` auto-wait:
 * `union.first().waitFor({ state: "visible" })`. `.or()` resolves in DOM
 * order, so `first()` is whichever candidate happens to sit earliest in the
 * document — and if that node is permanently hidden (a measurement clone, a
 * collapsed mobile copy of the same button, an `aria-hidden` duplicate) the
 * wait sat there until the full timeout and reported "could not find it"
 * while the real, visible control was on screen the whole time. That is the
 * shape of most "click Join timed out after 30s" reports.
 *
 * Polling every strategy instead costs one round of `count()`/`isVisible()`
 * per 250ms and cannot be fooled by DOM order. The wait still ends the
 * instant something shows up, so a fast page stays fast.
 */
async function waitThenPrefer(candidates: Locator[], timeoutMs: number, describe: string): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const loc of candidates) {
      const visible = await firstVisibleOf(loc);
      if (visible) return visible;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Nothing visible in time. If the element exists but is hidden/covered,
  // hand that one back: acting on it produces Playwright's own precise
  // reason, which is far more useful than "we couldn't find it."
  for (const loc of candidates) {
    const any = await firstAnyOf(loc);
    if (any) return any;
  }

  throw new Error(
    `Could not find ${describe} after waiting ${Math.round(timeoutMs / 1000)}s — ` +
      `the page may not have loaded, or the wording may have changed.`,
  );
}

/** Waits for an explicitly-written selector, preferring a visible match over
 * whichever copy happens to come first in the DOM — same reasoning as
 * waitThenPrefer, which a single-strategy selector needs just as much. */
async function waitForSelector(page: Page, selector: string, timeoutMs: number): Promise<Locator> {
  return waitThenPrefer([page.locator(selector)], timeoutMs, `an element matching "${selector}"`);
}

/** Resolves a "click <thing>" target: explicit selectors pass through,
 * everything else is tried as a button, then a link, then a menu item, then
 * a label, then any visible text — waiting for whichever appears first. */
export async function resolveClickable(page: Page, target: string, timeoutMs: number): Promise<Locator> {
  if (looksLikeSelector(target)) return waitForSelector(page, target, timeoutMs);

  return waitThenPrefer(
    [
      page.getByRole("button", { name: target, exact: false }),
      page.getByRole("link", { name: target, exact: false }),
      page.getByRole("menuitem", { name: target, exact: false }),
      // A meeting's "Join now" is frequently a plain <div role="none"> with
      // an aria-label rather than a real button, so the accessible-name
      // strategies above never see it.
      page.locator(`[aria-label*="${quoteAttr(target)}" i]`),
      page.getByLabel(target, { exact: false }),
      page.getByText(target, { exact: false }),
    ],
    timeoutMs,
    `a clickable element matching "${target}"`,
  );
}

/** Resolves a form field for "fill/select/check <field>" by label,
 * placeholder, name, id, or role — in that order of how a human would
 * describe a field — waiting for it to appear rather than giving up on a
 * page that is still rendering. */
export async function resolveField(page: Page, field: string, timeoutMs: number): Promise<Locator> {
  if (looksLikeSelector(field)) return waitForSelector(page, field, timeoutMs);

  return waitThenPrefer(
    [
      page.getByLabel(field, { exact: false }),
      page.getByPlaceholder(field, { exact: false }),
      page.locator(`[name="${quoteAttr(field)}"]`),
      // Matched as an attribute rather than `#id` on purpose: CSS.escape is
      // a browser API and is undefined in Node, so the `#${CSS.escape(...)}`
      // form threw ReferenceError before it ever reached Playwright — which
      // made every `fill`/`select`/`check` on a plain field name fail with a
      // message that had nothing to do with the page.
      page.locator(`[id="${quoteAttr(field)}"]`),
      page.locator(`[aria-label*="${quoteAttr(field)}" i]`),
      page.getByRole("textbox", { name: field, exact: false }),
      page.getByRole("combobox", { name: field, exact: false }),
      page.getByRole("checkbox", { name: field, exact: false }),
    ],
    timeoutMs,
    `a field matching "${field}"`,
  );
}
