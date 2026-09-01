import { readFileSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { masterProfileDir } from "./profile.js";

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

interface StorageState {
  cookies?: StorageStateCookie[];
  origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
}

/**
 * Bakes a captured browser session (a Playwright storageState JSON, exported
 * from a real login on a trusted machine) into the shared master profile.
 *
 * This is the answer to "the login works on my own browser but not in the
 * container": the sign-in happens where Microsoft is happy — the operator's
 * own machine and IP — and only the resulting cookies/tokens are carried
 * here. Nothing logs in from the server, so headless- and location-based
 * blocks never apply.
 *
 * Cookies are written by adding them to a persistent context and closing it
 * (Chromium flushes its cookie store to the profile dir on close).
 * localStorage is restored by visiting each origin and setting it, since
 * Teams' MSAL tokens live there as well as in cookies.
 */
export async function bakeMaster(statePath: string): Promise<void> {
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as StorageState;
  const dir = masterProfileDir();

  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    if (state.cookies?.length) {
      await context.addCookies(state.cookies);
    }

    for (const origin of state.origins ?? []) {
      if (!origin.localStorage?.length) continue;
      const page = await context.newPage();
      try {
        // Loading the origin is what makes its localStorage writable. A blank
        // 'domcontentloaded' is enough; we don't need the page to fully render.
        await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.evaluate((items) => {
          for (const { name, value } of items) {
            try {
              window.localStorage.setItem(name, value);
            } catch {
              /* some keys are read-only; skip */
            }
          }
        }, origin.localStorage);
      } catch (e) {
        console.error(`[bakeMaster] could not restore localStorage for ${origin.origin}: ${String(e)}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    console.log(
      `[bakeMaster] master profile seeded: ${state.cookies?.length ?? 0} cookies, ${state.origins?.length ?? 0} origins`,
    );
  } finally {
    // Closing flushes cookies to disk — the whole point.
    await context.close().catch(() => {});
    // The uploaded state file holds live session tokens; don't leave it lying
    // around on the volume once it's baked in.
    rmSync(statePath, { force: true });
  }
}
