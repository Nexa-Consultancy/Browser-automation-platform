// Capture a Teams login on THIS machine and save it for the platform.
//
// Microsoft's login works fine in your own browser on your own network, but
// often refuses the automated browser on the server. So log in here, and
// upload the file this writes (teams-auth.json) under Settings -> Teams
// master login -> import.
//
//   npm run capture:login
//
// A real Chrome window opens on teams.microsoft.com. Sign in, click "Yes" on
// "Stay signed in?", wait until you see the Teams home, then CLOSE the window.
import { chromium } from "playwright";
import path from "node:path";

const OUT = path.resolve(process.cwd(), "teams-auth.json");

const browser = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: null,
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});

const page = browser.pages()[0] ?? (await browser.newPage());
await page.goto("https://teams.microsoft.com/");

console.log("\n  A browser window opened.");
console.log("  1) Sign in to Teams with the account all sessions should share.");
console.log('  2) Click "Yes" on "Stay signed in?".');
console.log("  3) When you reach the Teams home screen, CLOSE the window.\n");

// Save when the window is closed.
await new Promise((resolve) => browser.on("close", resolve));

try {
  const state = await browser.storageState({ path: OUT });
  console.log(`\n  Saved ${state.cookies.length} cookies to:\n  ${OUT}`);
  console.log("  Upload this file in the app: Settings -> Teams master login -> import.\n");
} catch (e) {
  // storageState after close can race; fall back to a clear message.
  console.error("\n  Could not save automatically. Re-run and wait for the Teams home before closing.\n", e);
  process.exit(1);
}
process.exit(0);
