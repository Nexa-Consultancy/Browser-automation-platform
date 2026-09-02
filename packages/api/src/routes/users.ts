import type { FastifyInstance } from "fastify";
import {
  createUser,
  deleteUser,
  getJob,
  getUser,
  getUserPasswordPlain,
  listUsers,
  releaseUserActiveJob,
  removeUserFromAllGroups,
  setUserActiveJob,
  updateUser,
} from "@automation/db";
import { stashCredential } from "@automation/queue";
import { USER_LOGIN_CAPTURE_JOB_NAME } from "@automation/shared";
import { launchJob, stopJob } from "../services/launch.js";
import { clearUserProfile, userLoginExists } from "../services/users.js";

/**
 * Auto-fills the two fields Microsoft's login always asks for, then stops —
 * "Stay signed in?" and any 2FA prompt are finished by hand through the
 * live view, exactly the workflow already used for the shared master login.
 * If Microsoft ever changes these labels, only this constant needs editing.
 */
const LOGIN_CAPTURE_STEPS = [
  'open https://teams.microsoft.com/',
  'fill "Email, phone, or Skype" with {{email}}',
  'click "Next"',
  'wait for 2 seconds',
  'fill "Password" with {{password}}',
  'click "Sign in"',
];

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

async function launchLoginCapture(user: { id: string; name: string; email: string }, password: string) {
  const { job, sessions } = await launchJob({
    name: USER_LOGIN_CAPTURE_JOB_NAME,
    targetUrl: "https://teams.microsoft.com/",
    steps: LOGIN_CAPTURE_STEPS,
    users: [{ userName: user.name, data: { name: user.name, email: user.email, userId: user.id } }],
  });
  // One-shot Redis stash — never written to sessions.row_data / Postgres.
  await stashCredential(sessions[0].id, password);
  await setUserActiveJob(user.id, job.id);
  return job.id;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", async () => {
    const users = await listUsers();
    const out = await Promise.all(
      users.map(async (u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        signedIn: userLoginExists(u.id),
        activeJobId: await releaseIfFinished(u),
        createdAt: u.createdAt,
      })),
    );
    return { users: out };
  });

  app.post("/api/users", async (req, reply) => {
    const { name, email, password } = (req.body ?? {}) as { name?: string; email?: string; password?: string };
    if (!name?.trim() || !email?.trim() || !password) {
      return reply.code(400).send({ error: "name, email and password are required" });
    }

    const user = await createUser({ name: name.trim(), email: email.trim(), password });
    const jobId = await launchLoginCapture(user, password);
    reply.code(201).send({ user: { id: user.id, name: user.name, email: user.email, signedIn: false }, jobId });
  });

  /** Update name/email, and optionally rotate the stored password — same
   * id, same profile dir, same group links. Giving a new password
   * immediately re-runs the sign-in flow so the saved session matches it. */
  app.patch("/api/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await getUser(id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (await releaseIfFinished(existing)) {
      return reply.code(409).send({ error: "a sign-in run is already in progress for this user" });
    }

    const { name, email, password } = (req.body ?? {}) as { name?: string; email?: string; password?: string };
    if (!name?.trim() || !email?.trim()) return reply.code(400).send({ error: "name and email are required" });

    const user = await updateUser(id, { name: name.trim(), email: email.trim(), password: password || undefined });
    if (!user) return reply.code(404).send({ error: "not found" });

    let jobId: string | null = null;
    if (password) jobId = await launchLoginCapture(user, password);
    reply.send({ user: { id: user.id, name: user.name, email: user.email, signedIn: userLoginExists(user.id) }, jobId });
  });

  /** Re-run the sign-in flow with the already-stored password — for a
   * session that just expired, no password change needed. */
  app.post("/api/users/:id/relogin", async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await getUser(id);
    if (!user) return reply.code(404).send({ error: "not found" });
    if (await releaseIfFinished(user)) {
      return reply.code(409).send({ error: "a sign-in run is already in progress for this user" });
    }
    const password = await getUserPasswordPlain(id);
    if (password === null) return reply.code(500).send({ error: "could not decrypt stored password" });

    const jobId = await launchLoginCapture(user, password);
    reply.send({ jobId });
  });

  // Wipe this user's saved login. Their next sign-in run starts fresh — the
  // fix for a stale or wrong Teams session, same as a group's clear-profiles.
  app.post("/api/users/:id/clear-profile", async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await getUser(id);
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

  app.delete("/api/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await getUser(id);
    if (!user) return reply.code(404).send({ error: "not found" });
    if (user.activeJobId) await stopJob(user.activeJobId);
    await removeUserFromAllGroups(id);
    await deleteUser(id);
    reply.send({ ok: true });
  });
}
