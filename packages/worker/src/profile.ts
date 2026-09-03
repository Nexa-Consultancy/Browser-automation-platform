import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Job, SessionRow } from "@automation/shared";

/**
 * Where a user's browser profile lives on disk.
 *
 * The whole point of a persistent profile is that a login done once survives
 * restarts — so the directory has to be keyed to something stable across
 * runs, not to the job (which is new every time). A group is that stable
 * thing: the same group + the same user index is the same person day after
 * day, so `/data/profiles/<groupId>/<userIndex>` is reused and their Teams
 * (or any) session stays signed in.
 *
 * A one-off "custom run" has no group and no lasting identity, so it gets a
 * throwaway directory under the job id that we delete when the run ends —
 * persistence there would just leak disk with dirs nothing can ever reuse.
 */
const ROOT = process.env.PROFILES_DIR || "/data/profiles";

export interface ProfilePlan {
  dir: string;
  /** true when this dir is reused across runs (a group); false for the
   * per-job scratch dir of a custom run, which is removed on cleanup. */
  persistent: boolean;
}

/** A reusable, named PlatformUser's own persistent profile — independent of
 * any group dir, so their identity travels with them regardless of which
 * group runs them. See packages/shared/src/csv.ts's buildLinkedUsers, which
 * is what puts session.data.userId here in the first place. */
export function userProfileDir(userId: string): string {
  return path.join(ROOT, "_user", userId);
}

export function profilePlanFor(job: Job, session: SessionRow, persistEnabled: boolean): ProfilePlan {
  // A linked PlatformUser's identity travels with them regardless of which
  // job or group is running them — checked before the group-scoped branch
  // below, so a linked user inside a group run still resolves to THEIR OWN
  // dir, never <groupId>/<index>. Also handles the login-capture job itself
  // (which has no groupId), since it carries the same userId field.
  const userId = session.rowData.userId;
  if (userId) {
    return { dir: userProfileDir(userId), persistent: true };
  }
  if (persistEnabled && job.groupId) {
    return { dir: path.join(ROOT, job.groupId, String(session.userIndex)), persistent: true };
  }
  return { dir: path.join(ROOT, "_adhoc", job.id, String(session.userIndex)), persistent: false };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Removes Chromium's singleton lock files from a profile dir.
 *
 * A crash (or a kill) leaves a SingletonLock pointing at a now-dead process,
 * and Chromium then refuses to open the profile at all — "the profile appears
 * to be in use by another process" — which permanently wedges that profile
 * until the file is cleared. We enforce one run per profile ourselves, so
 * clearing these before launch is safe and turns a wedged profile back into a
 * usable one.
 */
export function clearProfileLocks(dir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      rmSync(path.join(dir, name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Best-effort removal — used for scratch dirs and the Clear-profile action.
 * A failure here must never break a run, so it's swallowed. */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** The on-disk directory for a whole group's saved logins, for clearing. */
export function groupProfilesDir(groupId: string): string {
  return path.join(ROOT, groupId);
}

export { ROOT as PROFILES_ROOT };
