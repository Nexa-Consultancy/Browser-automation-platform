import type { FastifyInstance } from "fastify";
import {
  DuplicateUserEmail,
  addUserToGroup,
  createUser,
  deleteUser,
  deleteUsers,
  getDefaultTemplate,
  getGroup,
  getJob,
  getOrganization,
  getTemplate,
  getUser,
  getUserPasswordPlain,
  getUsersByIds,
  listUsers,
  releaseUserActiveJob,
  removeUserFromAllGroups,
  removeUsersFromAllGroups,
  removeUsersFromForeignGroups,
  setUserActiveJob,
  setUsersOrganization,
  updateUser,
} from "@automation/db";
import { stashCredential } from "@automation/queue";
import { AUTO_LOGIN_TEMPLATE_ID, USER_LOGIN_CAPTURE_JOB_NAME } from "@automation/shared";
import { launchJob, stopJob } from "../services/launch.js";
import { clearUserProfile, userLoginExists } from "../services/users.js";
import { accountId, requireAuth } from "../auth/context.js";

/**
 * Fallback only — the real, editable script lives in the seeded "Auto
 * login" step_templates row (see packages/db/src/schema.sql) and is read
 * fresh on every launch by loginCaptureSteps() below, so a Settings edit
 * takes effect immediately with no deploy. This copy only matters if that
 * row is ever deleted.
 */
const FALLBACK_LOGIN_CAPTURE_STEPS = [
  "open https://teams.microsoft.com/",
  'fill "Email, phone, or Skype" with {{email}}',
  'click "Next"',
  "wait for 2 seconds",
  // Microsoft increasingly offers a passkey / "Face, fingerprint, PIN"
  // route BEFORE the password box, and a brand-new account is often taken
  // straight there. Each of these is the "no, use the password" escape on
  // one of the variants of that screen; "if visible" means the ones that
  // don't apply are skipped rather than failing the run. Order matters —
  // "Other ways to sign in" opens the list that the password option is in,
  // so the password labels are tried again after it.
  'click if visible "Use your password"',
  'click if visible "Sign in with a password"',
  'click if visible "Use password instead"',
  'click if visible "Other ways to sign in"',
  'click if visible "Sign in another way"',
  'click if visible "Use your password"',
  "wait for 1 seconds",
  'fill "Password" with {{password}}',
  'click "Sign in"',
  "wait for 2 seconds",
  // Post-password prompts: "set up a passkey now?" on new accounts, then
  // "Stay signed in?" — which we DO want, since staying signed in is the
  // entire point of capturing the profile.
  'click if visible "Skip for now"',
  'click if visible "Maybe later"',
  'click if visible "No thanks"',
  'click if visible "Yes"',
];

/**
 * Resolved fresh on every launch, in priority order:
 *   1. whichever template is marked default for users in Settings,
 *   2. the seeded "Auto login" row (what this always used),
 *   3. the hardcoded copy above.
 *
 * Reading it per launch rather than caching is deliberate — changing the
 * default in Settings takes effect on the very next sign-in, with no deploy
 * and no restart.
 */
async function loginCaptureSteps(account: string): Promise<string[]> {
  const chosen = await getDefaultTemplate(account, "user");
  if (chosen && chosen.steps.length > 0) return chosen.steps;
  const seeded = await getTemplate(AUTO_LOGIN_TEMPLATE_ID, account);
  return seeded && seeded.steps.length > 0 ? seeded.steps : FALLBACK_LOGIN_CAPTURE_STEPS;
}

/** A job in one of these states is no longer holding any browser open —
 * same terminal set the group scheduler uses. */
const FINISHED = new Set(["completed", "stopped", "failed"]);

/** Lazily clears a stale active_job_id once its job has actually finished —
 * there's no per-user ticking scheduler, so this self-heals on next read. */
async function releaseIfFinished(user: { id: string; activeJobId: string | null }): Promise<string | null> {
  if (!user.activeJobId) return null;
  const job = await getJob(user.activeJobId);
  if (!job || FINISHED.has(job.status)) {
    await releaseUserActiveJob(user.id);
    return null;
  }
  return user.activeJobId;
}

async function launchLoginCapture(
  user: { id: string; name: string; email: string },
  password: string,
  account: string,
) {
  const { job, sessions } = await launchJob({
    name: USER_LOGIN_CAPTURE_JOB_NAME,
    targetUrl: "https://teams.microsoft.com/",
    steps: await loginCaptureSteps(account),
    users: [{ userName: user.name, data: { name: user.name, email: user.email, userId: user.id } }],
    accountId: account,
  });
  // One-shot Redis stash — never written to sessions.row_data / Postgres.
  await stashCredential(sessions[0].id, password);
  await setUserActiveJob(user.id, job.id);
  return job.id;
}

/** null (Unassigned) is always fine; a named organization has to exist. */
async function organizationMissing(organizationId: string | null, account: string): Promise<boolean> {
  return organizationId !== null && !(await getOrganization(organizationId, account));
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/users", async (req) => {
    const account = accountId(req);
    const users = await listUsers(account);
    const out = await Promise.all(
      users.map(async (u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        organizationId: u.organizationId,
        signedIn: userLoginExists(u.id),
        activeJobId: await releaseIfFinished(u),
        createdAt: u.createdAt,
      })),
    );
    return { users: out };
  });

  /**
   * `groupId` is what makes "add someone to the IT department" one action
   * rather than two: the new user is created, filed under the organization,
   * and linked straight into that group's roster.
   */
  app.post("/api/users", async (req, reply) => {
    const account = accountId(req);
    const { name, email, password, organizationId, groupId } = (req.body ?? {}) as {
      name?: string;
      email?: string;
      password?: string;
      organizationId?: string | null;
      groupId?: string | null;
    };
    if (!name?.trim() || !email?.trim() || !password) {
      return reply.code(400).send({ error: "name, email and password are required" });
    }

    const orgId = organizationId?.trim() || null;
    if (await organizationMissing(orgId, account)) {
      return reply.code(400).send({ error: "that organization no longer exists" });
    }
    const linkGroupId = groupId?.trim() || null;
    if (linkGroupId && !(await getGroup(linkGroupId, account))) {
      return reply.code(400).send({ error: "that group no longer exists" });
    }

    let user;
    try {
      user = await createUser({
        name: name.trim(),
        email: email.trim(),
        password,
        organizationId: orgId,
        accountId: account,
      });
    } catch (err) {
      if (err instanceof DuplicateUserEmail) return reply.code(409).send({ error: err.message });
      throw err;
    }
    if (linkGroupId) await addUserToGroup(linkGroupId, user.id);

    const jobId = await launchLoginCapture(user, password, account);
    reply.code(201).send({
      user: { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId, signedIn: false },
      jobId,
    });
  });

  /** Update name/email, and optionally rotate the stored password — same
   * id, same profile dir, same group links. Giving a new password
   * immediately re-runs the sign-in flow so the saved session matches it. */
  app.patch("/api/users/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const existing = await getUser(id, account);
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (await releaseIfFinished(existing)) {
      return reply.code(409).send({ error: "a sign-in run is already in progress for this user" });
    }

    const { name, email, password, organizationId } = (req.body ?? {}) as {
      name?: string;
      email?: string;
      password?: string;
      organizationId?: string | null;
    };
    if (!name?.trim() || !email?.trim()) return reply.code(400).send({ error: "name and email are required" });

    // Absent means "leave where they are"; an explicit "" means Unassigned.
    const orgId = organizationId === undefined ? existing.organizationId : organizationId?.trim() || null;
    if (await organizationMissing(orgId, account)) {
      return reply.code(400).send({ error: "that organization no longer exists" });
    }

    let user;
    try {
      user = await updateUser(id, account, {
        name: name.trim(),
        email: email.trim(),
        password: password || undefined,
        organizationId: orgId,
      });
    } catch (err) {
      if (err instanceof DuplicateUserEmail) return reply.code(409).send({ error: err.message });
      throw err;
    }
    if (!user) return reply.code(404).send({ error: "not found" });

    let jobId: string | null = null;
    if (password) jobId = await launchLoginCapture(user, password, account);
    reply.send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        organizationId: user.organizationId,
        signedIn: userLoginExists(user.id),
      },
      jobId,
    });
  });

  /** Re-run the sign-in flow with the already-stored password — for a
   * session that just expired, no password change needed. */
  app.post("/api/users/:id/relogin", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const user = await getUser(id, account);
    if (!user) return reply.code(404).send({ error: "not found" });
    if (await releaseIfFinished(user)) {
      return reply.code(409).send({ error: "a sign-in run is already in progress for this user" });
    }
    const password = await getUserPasswordPlain(id);
    if (password === null) return reply.code(500).send({ error: "could not decrypt stored password" });

    const jobId = await launchLoginCapture(user, password, account);
    reply.send({ jobId });
  });

  // Wipe this user's saved login. Their next sign-in run starts fresh — the
  // fix for a stale or wrong Teams session, same as a group's clear-profiles.
  app.post("/api/users/:id/clear-profile", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const user = await getUser(id, account);
    if (!user) return reply.code(404).send({ error: "not found" });
    if (await releaseIfFinished(user)) {
      return reply.code(409).send({ error: "stop this user's current sign-in run before clearing their profile" });
    }
    try {
      clearUserProfile(id);
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : "could not clear profile" });
    }
    reply.send({ ok: true });
  });

  /**
   * The bulk "Move" action behind the Users list.
   *
   * Files everyone selected under `organizationId` (null = Unassigned) and,
   * when `groupId` is given, adds them to that group's roster. Memberships
   * in groups belonging to any OTHER organization are dropped: leaving
   * someone on their old company's department after moving them would keep
   * opening a browser for them there.
   */
  app.post("/api/users/move", async (req, reply) => {
    const account = accountId(req);
    const { userIds, organizationId, groupId } = (req.body ?? {}) as {
      userIds?: string[];
      organizationId?: string | null;
      groupId?: string | null;
    };
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map((v) => String(v ?? "").trim()).filter(Boolean))];
    if (ids.length === 0) return reply.code(400).send({ error: "select at least one user to move" });

    const orgId = organizationId?.trim() || null;
    if (await organizationMissing(orgId, account)) {
      return reply.code(400).send({ error: "that organization no longer exists" });
    }

    const targetGroupId = groupId?.trim() || null;
    if (targetGroupId) {
      const group = await getGroup(targetGroupId, account);
      if (!group) return reply.code(400).send({ error: "that group no longer exists" });
      // A group in a different organization than the one they're being filed
      // under would be undone immediately by the foreign-group cleanup below.
      if ((group.organizationId ?? null) !== orgId) {
        return reply.code(400).send({ error: "that group belongs to a different organization" });
      }
    }

    const existing = await getUsersByIds(ids, account);
    if (existing.length === 0) return reply.code(400).send({ error: "none of those users still exist" });
    const liveIds = existing.map((u) => u.id);

    const moved = await setUsersOrganization(liveIds, orgId, account);
    await removeUsersFromForeignGroups(liveIds, orgId);
    if (targetGroupId) {
      for (const id of liveIds) await addUserToGroup(targetGroupId, id);
    }
    reply.send({ ok: true, moved });
  });

  /** Bulk delete from the Users list. Stops any sign-in run each person is
   * holding open, then clears them out of every roster before removing the
   * rows, so no group is left pointing at somebody gone. */
  app.post("/api/users/bulk-delete", async (req, reply) => {
    const account = accountId(req);
    const { userIds } = (req.body ?? {}) as { userIds?: string[] };
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map((v) => String(v ?? "").trim()).filter(Boolean))];
    if (ids.length === 0) return reply.code(400).send({ error: "select at least one user to delete" });

    const existing = await getUsersByIds(ids, account);
    if (existing.length === 0) return reply.code(400).send({ error: "none of those users still exist" });

    for (const user of existing) {
      if (user.activeJobId) await stopJob(user.activeJobId);
    }
    const liveIds = existing.map((u) => u.id);
    await removeUsersFromAllGroups(liveIds);
    const deleted = await deleteUsers(liveIds, account);
    reply.send({ ok: true, deleted });
  });

  app.delete("/api/users/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const user = await getUser(id, account);
    if (!user) return reply.code(404).send({ error: "not found" });
    if (user.activeJobId) await stopJob(user.activeJobId);
    await removeUserFromAllGroups(id);
    await deleteUser(id, account);
    reply.send({ ok: true });
  });
}
