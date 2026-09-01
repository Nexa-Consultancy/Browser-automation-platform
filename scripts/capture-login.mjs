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

// A regular (non-persistent) browser, so the session can be read back with
// storageState — a persistent context can't be exported once it closes,
// which is what broke the first version.
const browser = await chromium.launch({
  headless: false,
  args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto("https://teams.microsoft.com/");

console.log("\n  A browser window opened.");
console.log("  1) Sign in to Teams with the account all sessions should share.");
console.log('  2) Click "Yes" on "Stay signed in?".');
console.log("  3) When you reach the Teams home screen, CLOSE the window.\n");

// Save the session repeatedly while the window is open, so whatever state
// exists at the moment you close is already on disk — no read-after-close.
let saved = 0;
const timer = setInterval(async () => {
  try {
    const state = await context.storageState({ path: OUT });
    saved = state.cookies.length;
  } catch {
    /* mid-navigation; the next tick will catch it */
  }
}, 2000);

// Closing the window disconnects the browser; that's our "done".
browser.on("disconnected", () => {
  clearInterval(timer);
  if (saved > 0) {
    console.log(`\n  Saved ${saved} cookies to:\n  ${OUT}`);
    console.log("  It will be imported automatically.\n");
    process.exit(0);
  }
  console.error("\n  No session captured — sign in fully before closing, then re-run.\n");
  process.exit(1);
});
