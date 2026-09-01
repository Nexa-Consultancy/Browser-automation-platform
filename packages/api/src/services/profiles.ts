import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

// Must match the worker's PROFILES_DIR (packages/worker/src/profile.ts): the
// api and worker share the /data/profiles volume — the worker writes it, the
// api reads/copies/clears it.
export const PROFILES_DIR = process.env.PROFILES_DIR || "/data/profiles";

export function masterDir(): string {
  return path.join(PROFILES_DIR, "_master");
}

/** A master login exists once Chromium has written its profile there. */
export function masterLoginExists(): boolean {
  return existsSync(path.join(masterDir(), "Default"));
}

// Chromium's own lock/socket files are process-specific and must never be
// copied into another profile, or the seeded browser refuses to open it.
const SKIP = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket", "RunningChromeVersion"]);

/**
 * Seeds one profile directory from the master — the mechanism behind "sign
 * in once, share to all". Copies the signed-in cookies and storage so the
 * target opens Teams already authenticated instead of hitting a login/guest
 * redirect (and the matching-cookie error that comes with it).
 */
export function seedProfileFromMaster(targetDir: string): void {
  const src = masterDir();
  if (!masterLoginExists()) throw new Error("no master login yet — sign in under Settings first");
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(src, targetDir, {
    recursive: true,
    filter: (from) => !SKIP.has(path.basename(from)),
  });
}

/** Seed every per-user profile dir under a group from the master. Returns how
 * many users were seeded. */
export function seedGroupFromMaster(groupId: string, userCount: number): number {
  let seeded = 0;
  for (let i = 0; i < userCount; i++) {
    seedProfileFromMaster(path.join(PROFILES_DIR, groupId, String(i)));
    seeded += 1;
  }
  return seeded;
}

export function clearGroupProfiles(groupId: string): void {
  rmSync(path.join(PROFILES_DIR, groupId), { recursive: true, force: true });
}

export function clearMaster(): void {
  rmSync(masterDir(), { recursive: true, force: true });
}

/** Debug aid: which user dirs currently exist under a group. */
export function listGroupProfiles(groupId: string): string[] {
  const dir = path.join(PROFILES_DIR, groupId);
  return existsSync(dir) ? readdirSync(dir) : [];
}
