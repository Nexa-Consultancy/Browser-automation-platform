import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { MASTER_LOGIN_JOB_NAME, type Job, type SessionRow } from "@automation/shared";

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

/** The single shared master profile that Teams is signed into once. */
export function masterProfileDir(): string {
  return path.join(ROOT, "_master");
}

export function profilePlanFor(job: Job, session: SessionRow, persistEnabled: boolean): ProfilePlan {
  // The master-login run signs the one shared account in; its profile must
  // persist (it is the source every group is seeded from) and never be the
  // per-group path.
  if (job.name === MASTER_LOGIN_JOB_NAME && !job.groupId) {
    return { dir: masterProfileDir(), persistent: true };
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
