import type { Page } from "playwright";
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

export async function executeStep(page: Page, step: ParsedStep, ctx: StepContext): Promise<void> {
  switch (step.kind) {
    case "open": {
      const url = t(step.url, ctx.row);
      assertSafeNavigationTarget(url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    }

    case "click": {
      const loc = await resolveClickable(page, t(step.target, ctx.row), ctx.timeoutMs);
      await loc.click({ timeout: ctx.timeoutMs });
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
      const loc = await resolveField(page, t(step.field, ctx.row), ctx.timeoutMs);
      await loc.fill(t(step.value, ctx.row), { timeout: ctx.timeoutMs });
      return;
    }

    case "fill_if_visible": {
      const PROBE_MS = 3000;
      try {
        const loc = await resolveField(page, t(step.field, ctx.row), PROBE_MS);
        await loc.fill(t(step.value, ctx.row), { timeout: PROBE_MS });
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
      const loc = await resolveField(page, t(step.field, ctx.row), ctx.timeoutMs);
      await loc.check({ timeout: ctx.timeoutMs });
      return;
    }

    case "uncheck": {
      const loc = await resolveField(page, t(step.field, ctx.row), ctx.timeoutMs);
      await loc.uncheck({ timeout: ctx.timeoutMs });
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
