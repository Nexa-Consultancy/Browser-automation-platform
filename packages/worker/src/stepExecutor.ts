import type { Locator, Page } from "playwright";
import { applyTemplate, type ParsedStep } from "@automation/shared";
import { resolveClickable, resolveField } from "./locators.js";
import { waitForVideoToEnd } from "./waitForVideo.js";
import { assertSafeNavigationTarget } from "./urlSafety.js";

export interface StepContext {
  row: Record<string, string>;
  signal: AbortSignal;
  maxVideoWaitMs: number;
  /** How long an action waits for its target to appear. The wait ends the
   * moment the element shows up, so this is a ceiling, not a delay. */
  timeoutMs: number;
  onVideoTick: (elapsedMs: number, currentTime: number, duration: number) => void;
  onScreenshot: (jpegBase64: string) => void;
}

const t = (s: string, row: Record<string, string>) => applyTemplate(s, row);

/**
 * Errors that mean "the page moved under us", as opposed to "this element
 * isn't here". Deliberately does NOT include a plain timeout: re-running a
 * step that already waited out its full timeout would just double the wait
 * for no new information.
 */
function isRaceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not attached|detached|is not stable|intercepts pointer events|outside of the viewport|Execution context was destroyed|navigation/i.test(
    message,
  );
}

/**
 * Resolve the element, then act on it — retrying the pair once if the page
 * re-rendered in between.
 *
 * A locator points at the node that existed when it was resolved. Meeting
 * and chat apps (Teams, Meet, Zoom web) re-render whole subtrees on their
 * own timers, so the node found a few hundred milliseconds ago can be
 * detached by the time the click lands — reported as "element is not
 * attached to the DOM", which then parks the session as a failure even
 * though the button is right there and a second attempt would have worked.
 * Resolving again rather than reusing the dead locator is the part that
 * matters; a bare `.click()` retry would fail identically.
 */
async function resolveAndAct(resolve: () => Promise<Locator>, act: (loc: Locator) => Promise<void>): Promise<void> {
  try {
    await act(await resolve());
  } catch (err) {
    if (!isRaceError(err)) throw err;
    await act(await resolve());
  }
}

/**
 * Puts text into a field and makes sure it actually landed.
 *
 * `fill()` sets the value in one shot and fires a single `input` event.
 * That is enough for an ordinary form, but a pre-join screen's guest-name
 * box is usually a controlled component that gates its "Join" button on a
 * real typing sequence — it ignores the one-shot write, so the value shows
 * up in the DOM (or doesn't) while the button stays disabled and the next
 * step then times out clicking a Join that will never enable. Checking what
 * the field holds afterwards and typing it key by key when the fast path
 * didn't take turns that dead end into a step that works, at the cost of a
 * few hundred milliseconds only on the fields that need it.
 */
async function fillField(loc: Locator, value: string, timeoutMs: number): Promise<void> {
  await loc.fill(value, { timeout: timeoutMs });
  if (value === "") return;

  const landed = await loc.inputValue({ timeout: timeoutMs }).catch(() => null);
  // A non-input (contenteditable, a custom widget) has no inputValue at all;
  // there is nothing to verify, so take the fill at its word.
  if (landed === null || landed === value) return;

  await loc.click({ timeout: timeoutMs });
  await loc.fill("", { timeout: timeoutMs }).catch(() => {});
  await loc.pressSequentially(value, { delay: 30, timeout: timeoutMs });
}

export async function executeStep(page: Page, step: ParsedStep, ctx: StepContext): Promise<void> {
  switch (step.kind) {
    case "open": {
      const url = t(step.url, ctx.row);
      assertSafeNavigationTarget(url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    }

    case "click": {
      const target = t(step.target, ctx.row);
      await resolveAndAct(
        () => resolveClickable(page, target, ctx.timeoutMs),
        (loc) => loc.click({ timeout: ctx.timeoutMs }),
      );
      return;
    }

    case "click_if_visible": {
      // A short, fixed probe rather than ctx.timeoutMs: this step's whole
      // point is "don't block the run waiting for something that may never
      // show up," so it must fail fast, not eat the full action timeout.
      const PROBE_MS = 3000;
      try {
        const loc = await resolveClickable(page, t(step.target, ctx.row), PROBE_MS);
        await loc.click({ timeout: PROBE_MS });
      } catch {
        // Not present — that's fine, this step is optional.
      }
      return;
    }

    case "fill": {
      const field = t(step.field, ctx.row);
      const value = t(step.value, ctx.row);
      await resolveAndAct(
        () => resolveField(page, field, ctx.timeoutMs),
        (loc) => fillField(loc, value, ctx.timeoutMs),
      );
      return;
    }

    case "fill_if_visible": {
      const PROBE_MS = 3000;
      try {
        const loc = await resolveField(page, t(step.field, ctx.row), PROBE_MS);
        await fillField(loc, t(step.value, ctx.row), PROBE_MS);
      } catch {
        // Not present — that's fine, this step is optional.
      }
      return;
    }

    case "type":
      await page.keyboard.type(t(step.text, ctx.row), { delay: 20 });
      return;

    case "select": {
      const loc = await resolveField(page, t(step.field, ctx.row), ctx.timeoutMs);
      const option = t(step.option, ctx.row);
      try {
        await loc.selectOption({ label: option }, { timeout: ctx.timeoutMs });
      } catch {
        await loc.selectOption(option, { timeout: ctx.timeoutMs });
      }
      return;
    }

    case "check": {
      const field = t(step.field, ctx.row);
      await resolveAndAct(
        () => resolveField(page, field, ctx.timeoutMs),
        (loc) => loc.check({ timeout: ctx.timeoutMs }),
      );
      return;
    }

    case "uncheck": {
      const field = t(step.field, ctx.row);
      await resolveAndAct(
        () => resolveField(page, field, ctx.timeoutMs),
        (loc) => loc.uncheck({ timeout: ctx.timeoutMs }),
      );
      return;
    }

    case "press":
      await page.keyboard.press(step.key);
      return;

    case "wait_text":
      await page.getByText(t(step.text, ctx.row), { exact: false }).first().waitFor({
        state: "visible",
        timeout: Math.max(ctx.timeoutMs, 120_000),
      });
      return;

    case "wait_seconds":
      await page.waitForTimeout(step.seconds * 1000);
      return;

    case "wait_element":
      await page.waitForSelector(t(step.selector, ctx.row), { timeout: Math.max(ctx.timeoutMs, 120_000) });
      return;

    case "wait_video":
      await waitForVideoToEnd(page, {
        maxWaitMs: ctx.maxVideoWaitMs,
        signal: ctx.signal,
        onTick: ctx.onVideoTick,
      });
      return;

    case "screenshot": {
      const buf = await page.screenshot({ type: "jpeg", quality: 60 });
      ctx.onScreenshot(buf.toString("base64"));
      return;
    }

    case "unknown":
      throw new Error(`Could not understand step: "${step.raw}"`);
  }
}
