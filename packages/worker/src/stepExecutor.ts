import type { Page } from "playwright";
import { applyTemplate, type ParsedStep } from "@automation/shared";
import { resolveClickable, resolveField } from "./locators.js";
import { waitForVideoToEnd } from "./waitForVideo.js";

export interface StepContext {
  row: Record<string, string>;
  signal: AbortSignal;
  maxVideoWaitMs: number;
  onVideoTick: (elapsedMs: number, currentTime: number, duration: number) => void;
  onScreenshot: (jpegBase64: string) => void;
}

const t = (s: string, row: Record<string, string>) => applyTemplate(s, row);

export async function executeStep(page: Page, step: ParsedStep, ctx: StepContext): Promise<void> {
  switch (step.kind) {
    case "open":
      await page.goto(t(step.url, ctx.row), { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;

    case "click": {
      const loc = await resolveClickable(page, t(step.target, ctx.row));
      await loc.click({ timeout: 15_000 });
      return;
    }

    case "fill": {
      const loc = await resolveField(page, t(step.field, ctx.row));
      await loc.fill(t(step.value, ctx.row), { timeout: 15_000 });
      return;
    }

    case "type":
      await page.keyboard.type(t(step.text, ctx.row), { delay: 20 });
      return;

    case "select": {
      const loc = await resolveField(page, t(step.field, ctx.row));
      const option = t(step.option, ctx.row);
      try {
        await loc.selectOption({ label: option }, { timeout: 15_000 });
      } catch {
        await loc.selectOption(option, { timeout: 15_000 });
      }
      return;
    }

    case "check": {
      const loc = await resolveField(page, t(step.field, ctx.row));
      await loc.check({ timeout: 15_000 });
      return;
    }

    case "uncheck": {
      const loc = await resolveField(page, t(step.field, ctx.row));
      await loc.uncheck({ timeout: 15_000 });
      return;
    }

    case "press":
      await page.keyboard.press(step.key);
      return;

    case "wait_text":
      await page.getByText(t(step.text, ctx.row), { exact: false }).first().waitFor({
        state: "visible",
        timeout: 120_000,
      });
      return;

    case "wait_seconds":
      await page.waitForTimeout(step.seconds * 1000);
      return;

    case "wait_element":
      await page.waitForSelector(t(step.selector, ctx.row), { timeout: 120_000 });
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
