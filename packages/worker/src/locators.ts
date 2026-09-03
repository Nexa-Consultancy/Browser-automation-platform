import type { Locator, Page } from "playwright";

/** Escapes a value for use inside a double-quoted CSS attribute selector. */
function quoteAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function looksLikeSelector(target: string): boolean {
  return /^[.#\[]/.test(target) || /^(css=|text=|xpath=)/.test(target) || target.includes(">>");
}

/**
 * Picks the first strategy that currently matches. This is an instantaneous
 * check — it is only ever called *after* something is known to be on the
 * page, so it decides *which* element to use, never *whether* to wait.
 */
async function firstMatching(candidates: Locator[]): Promise<Locator | null> {
  for (const loc of candidates) {
    try {
      // Prefer an actually-visible match: a strategy like getByPlaceholder
      // can match a hidden duplicate (e.g. a measurement clone some custom
      // inputs render) ahead of the real, visible field in DOM order — a
      // plain .first() would silently pick that hidden node, and fill()
      // would fail on it, which fill_if_visible then swallows as "not
      // present." Falls back to any match if none happen to be visible.
      const visible = loc.locator(":visible");
      if ((await visible.count()) > 0) return visible.first();
      if ((await loc.count()) > 0) return loc.first();
    } catch {
      // an invalid selector string throws on .count(); just try the next strategy
    }
  }
  return null;
}

/**
 * Waits until any of the candidate strategies matches something visible,
 * then returns the match from the highest-priority strategy.
 *
 * Both halves matter. Playwright's `.or()` chain auto-waits, so a step no
 * longer fails just because the page hasn't rendered yet — this is what
 * removes the need to pad scripts with "wait 15 seconds" before every
 * click. But `.or().first()` resolves in DOM order, which would happily
 * pick a stray paragraph containing "Join now" over the actual button. So
 * once the wait is satisfied we re-pick by preference order instead.
 *
 * The wait ends the instant the element appears, so a page that is ready in
 * 200ms costs 200ms, not the whole timeout.
 */
async function waitThenPrefer(
  candidates: Locator[],
  timeoutMs: number,
  describe: string,
): Promise<Locator> {
  const union = candidates.reduce((acc, loc) => acc.or(loc));
  try {
    await union.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    throw new Error(
      `Could not find ${describe} after waiting ${Math.round(timeoutMs / 1000)}s — ` +
        `the page may not have loaded, or the wording may have changed.`,
    );
  }
  const found = await firstMatching(candidates);
  if (found) return found;
  // It was visible a moment ago and isn't now — the page moved under us.
  return union.first();
}

/** Resolves a "click <thing>" target: explicit selectors pass through,
 * everything else is tried as a button, then a link, then a menu item, then
 * a label, then any visible text — waiting for whichever appears first. */
export async function resolveClickable(page: Page, target: string, timeoutMs: number): Promise<Locator> {
  if (looksLikeSelector(target)) {
    const loc = page.locator(target).first();
    await loc.waitFor({ state: "visible", timeout: timeoutMs });
    return loc;
  }

  return waitThenPrefer(
    [
      page.getByRole("button", { name: target, exact: false }),
      page.getByRole("link", { name: target, exact: false }),
      page.getByRole("menuitem", { name: target, exact: false }),
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
  if (looksLikeSelector(field)) {
    const loc = page.locator(field).first();
    await loc.waitFor({ state: "visible", timeout: timeoutMs });
    return loc;
  }

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
      page.getByRole("textbox", { name: field, exact: false }),
      page.getByRole("combobox", { name: field, exact: false }),
      page.getByRole("checkbox", { name: field, exact: false }),
    ],
    timeoutMs,
    `a field matching "${field}"`,
  );
}
