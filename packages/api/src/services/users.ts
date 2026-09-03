import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { PROFILES_DIR } from "./profiles.js";

/** A reusable PlatformUser's own persistent profile dir — must match the
 * worker's userProfileDir (packages/worker/src/profile.ts) exactly. */
export function userDir(userId: string): string {
  return path.join(PROFILES_DIR, "_user", userId);
}

/**
 * Where Chromium keeps the cookie store inside a profile. Recent versions
 * put it under Default/Network; older ones wrote it straight into Default.
 * Both are checked so a Chromium upgrade can't silently mark every user
 * offline.
 */
const COOKIE_PATHS = [
  path.join("Default", "Network", "Cookies"),
  path.join("Default", "Cookies"),
];

/**
 * Whether this user's captured login is actually usable.
 *
 * The profile directory existing is not enough on its own: Chromium creates
 * Default the moment it launches, so a sign-in that was closed early, failed
 * at 2FA, or had its cookie store wiped leaves behind a directory that looks
 * captured but signs nobody in. Requiring a non-empty cookie store is what
 * makes the green/red badge tell the truth — offline means the file that
 * holds the session is missing or empty, which is exactly when the next run
 * would land on a login page.
 */
export function userLoginExists(userId: string): boolean {
  const dir = userDir(userId);
  if (!existsSync(path.join(dir, "Default"))) return false;
  return COOKIE_PATHS.some((rel) => {
    const file = path.join(dir, rel);
    try {
      return statSync(file).size > 0;
    } catch {
      // Missing, or unreadable — either way there is no session to use.
      return false;
    }
  });
}

/** Best-effort removal, same rmSync(recursive+force+retry) shape as
 * clearGroupProfiles/clearMaster in services/profiles.ts — maxRetries rides
 * out the ENOTEMPTY race from a still-live Chromium process. */
export function clearUserProfile(userId: string): void {
  rmSync(userDir(userId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
