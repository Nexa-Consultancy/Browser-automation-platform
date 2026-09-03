import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

// Must match the worker's PROFILES_DIR (packages/worker/src/profile.ts): the
// api and worker share the /data/profiles volume — the worker writes it, the
// api reads/copies/clears it.
export const PROFILES_DIR = process.env.PROFILES_DIR || "/data/profiles";

export function clearGroupProfiles(groupId: string): void {
  rmSync(path.join(PROFILES_DIR, groupId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Debug aid: which user dirs currently exist under a group. */
export function listGroupProfiles(groupId: string): string[] {
  const dir = path.join(PROFILES_DIR, groupId);
  return existsSync(dir) ? readdirSync(dir) : [];
}
