// Must match the Playwright context viewport set in
// packages/worker/src/runner.ts — click coordinates from the dashboard
// are computed against this fixed size and forwarded verbatim to
// page.mouse.click(), so the two need to agree.
export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 720;
