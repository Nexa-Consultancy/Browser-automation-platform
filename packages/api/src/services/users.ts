import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { PROFILES_DIR } from "./profiles.js";

/** A reusable PlatformUser's own persistent profile dir — must match the
 * worker's userProfileDir (packages/worker/src/profile.ts) exactly. */
export function userDir(userId: string): string {
  return path.join(PROFILES_DIR, "_user", userId);
}

/** A user's login exists once Chromium has written its profile there. */
export function userLoginExists(userId: string): boolean {
  return existsSync(path.join(userDir(userId), "Default"));
}

/** Best-effort removal, same rmSync(recursive+force+retry) shape as
 * clearGroupProfiles/clearMaster in services/profiles.ts — maxRetries rides
 * out the ENOTEMPTY race from a still-live Chromium process. */
export function clearUserProfile(userId: string): void {
  rmSync(userDir(userId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
