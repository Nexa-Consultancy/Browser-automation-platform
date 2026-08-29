import type { Locator, Page } from "playwright";

function looksLikeSelector(target: string): boolean {
  return /^[.#\[]/.test(target) || /^(css=|text=|xpath=)/.test(target) || target.includes(">>");
}

async function firstMatching(candidates: Locator[]): Promise<Locator | null> {
  for (const loc of candidates) {
    try {
      if ((await loc.count()) > 0) return loc.first();
    } catch {
      // an invalid selector string throws on .count(); just try the next strategy
    }
  }
  return null;
}

/** Resolves a "click <thing>" target: explicit selectors pass through,
 * everything else is tried as a button, then a link, then visible text. */
export async function resolveClickable(page: Page, target: string): Promise<Locator> {
  if (looksLikeSelector(target)) return page.locator(target).first();

  const found = await firstMatching([
    page.getByRole("button", { name: target, exact: false }),
    page.getByRole("link", { name: target, exact: false }),
    page.getByRole("menuitem", { name: target, exact: false }),
    page.getByText(target, { exact: false }),
    page.getByLabel(target, { exact: false }),
  ]);
  if (found) return found;
  throw new Error(`Could not find a clickable element matching "${target}"`);
}

/** Resolves a form field for "fill/select/check <field>" by label,
 * placeholder, name, id, or role — in that order of how a human would
 * describe a field. */
export async function resolveField(page: Page, field: string): Promise<Locator> {
  if (looksLikeSelector(field)) return page.locator(field).first();

  const found = await firstMatching([
    page.getByLabel(field, { exact: false }),
    page.getByPlaceholder(field, { exact: false }),
    page.locator(`[name="${field}"]`),
    page.locator(`#${CSS.escape(field)}`),
    page.getByRole("textbox", { name: field, exact: false }),
  ]);
  if (found) return found;
  throw new Error(`Could not find a field matching "${field}"`);
}

// Minimal CSS.escape polyfill: Node has no `CSS` global.
const CSS = {
  escape(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  },
};
