import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "@fastify/cookie";
import {
  DuplicateAccount,
  clearPasswordResets,
  consumePasswordReset,
  createAccount,
  createAuthSession,
  createPasswordReset,
  deleteAuthSession,
  deleteAuthSessionsForAccount,
  findAccountByEmail,
  findAccountByLogin,
  getPasswordHash,
  markAccountLogin,
  seedTemplatesForAccount,
  setPasswordHash,
  type Account,
} from "@automation/db";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  hashToken,
  newToken,
  resetExpiry,
  sessionExpiry,
} from "../auth/tokens.js";
import { accountFromRequest, requireAuth } from "../auth/context.js";
import { sendPasswordReset } from "../auth/resetEmail.js";

/** What the dashboard is allowed to know about whoever is signed in. */
function publicAccount(a: Account) {
  return {
    id: a.id,
    email: a.email,
    username: a.username,
    name: a.name,
    workspaceName: a.workspaceName,
    role: a.role,
    createdAt: a.createdAt,
  };
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true, // a page script can never read it, so XSS can't steal the login
    sameSite: "lax", // survives following a link into the app; blocks cross-site POSTs
    // Set only when actually served over TLS. Forcing it on would silently
    // break a plain-HTTP deployment — the browser would drop the cookie and
    // login would appear to do nothing at all.
    secure: process.env.COOKIE_SECURE !== "false",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

async function startSession(req: FastifyRequest, reply: FastifyReply, account: Account): Promise<void> {
  const token = newToken();
  await createAuthSession({
    tokenHash: hashToken(token),
    accountId: account.id,
    userAgent: String(req.headers["user-agent"] ?? ""),
    expiresAt: sessionExpiry(),
  });
  await markAccountLogin(account.id);
  setSessionCookie(reply, token);
}

/** Why an account can't sign in, phrased for the person trying. */
function blockedReason(account: Account): string | null {
  switch (account.status) {
    case "active":
      return null;
    case "pending":
      return "Your account is waiting to be approved. You'll get an email once it's active.";
    case "rejected":
      return "This account was not approved. Contact the administrator if you think that's wrong.";
    case "suspended":
      return "This account has been suspended. Contact the administrator.";
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Who am I? The dashboard calls this on load to decide between the app
   * and the login page. 200 with null rather than 401 — "not signed in" is
   * the expected answer here, not an error. */
  app.get("/api/auth/me", async (req) => {
    const account = await accountFromRequest(req);
    return { account: account ? publicAccount(account) : null };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { login, password } = (req.body ?? {}) as { login?: string; password?: string };
    if (!login?.trim() || !password) {
      return reply.code(400).send({ error: "Enter your email or username and your password." });
    }

    const account = await findAccountByLogin(login);
    const hash = account ? await getPasswordHash(account.id) : null;

    // Verify even when the account is missing, against a dummy hash, so a
    // wrong username and a wrong password take the same time to answer —
    // otherwise the response time tells an attacker which accounts exist.
    const ok = await verifyPassword(password, hash ?? "scrypt$32768$8$1$AAAA$AAAA");
    if (!account || !hash || !ok) {
      return reply.code(401).send({ error: "That email/username and password don't match." });
    }

    const blocked = blockedReason(account);
    if (blocked) return reply.code(403).send({ error: blocked });

    await startSession(req, reply, account);
    return { account: publicAccount(account) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await deleteAuthSession(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  /**
   * Public signup. Creates a PENDING account — it cannot sign in until an
   * admin approves it, which is the whole point of asking what they intend
   * to use it for.
   */
  app.post("/api/auth/signup", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const name = body.name?.trim() ?? "";
    const email = body.email?.trim() ?? "";
    const phone = body.phone?.trim() ?? "";
    const workspaceName = body.workspaceName?.trim() ?? "";
    const purpose = body.purpose?.trim() ?? "";
    const password = body.password ?? "";

    if (!name) return reply.code(400).send({ error: "Your name is required." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: "Enter a valid email address." });
    }
    if (!phone) return reply.code(400).send({ error: "A phone number is required." });
    if (!workspaceName) return reply.code(400).send({ error: "Your organization name is required." });
    if (purpose.length < 10) {
      return reply.code(400).send({ error: "Tell us a little more about what you'll use it for." });
    }
    const pwProblem = passwordProblem(password);
    if (pwProblem) return reply.code(400).send({ error: pwProblem });

    try {
      const account = await createAccount({
        email,
        username: null,
        name,
        workspaceName,
        phone,
        purpose,
        passwordHash: await hashPassword(password),
        role: "owner",
        status: "pending",
      });
      // Seeded now rather than at approval so the workspace is ready the
      // moment it is switched on.
      await seedTemplatesForAccount(account.id);
      reply.code(201).send({ ok: true, status: "pending" });
    } catch (err) {
      if (err instanceof DuplicateAccount) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Always answers the same way, whether or not the address is known.
   * Telling a stranger "no such account" turns this endpoint into a way to
   * discover who has one.
   */
  app.post("/api/auth/forgot", async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: string };
    const answer = { ok: true, message: "If that email has an account, a reset link is on its way." };
    if (!email?.trim()) return reply.send(answer);

    const account = await findAccountByEmail(email);
    if (!account) return reply.send(answer);

    const token = newToken();
    // Only the newest link should work, so any earlier one is dropped.
    await clearPasswordResets(account.id);
    await createPasswordReset({
      tokenHash: hashToken(token),
      accountId: account.id,
      expiresAt: resetExpiry(),
    });

    try {
      await sendPasswordReset(account, token, req);
    } catch (err) {
      // A mail failure must not become a signal about the address either,
      // so it is logged server-side and the caller still sees the same
      // answer.
      req.log.error(`password reset email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reply.send(answer);
  });

  app.post("/api/auth/reset", async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
    if (!token?.trim()) return reply.code(400).send({ error: "This reset link is not valid." });

    const problem = passwordProblem(password ?? "");
    if (problem) return reply.code(400).send({ error: problem });

    const accountId = await consumePasswordReset(hashToken(token));
    if (!accountId) {
      return reply.code(400).send({ error: "This reset link has expired or has already been used." });
    }

    await setPasswordHash(accountId, await hashPassword(password!));
    // Every existing session dies with the old password — otherwise a reset
    // done because someone else had access would leave that access intact.
    await deleteAuthSessionsForAccount(accountId);
    return { ok: true };
  });

  /** Change your own password while signed in. Requires the current one, so
   * an unattended open tab can't be used to lock the owner out. */
  app.post("/api/auth/change-password", { preHandler: requireAuth }, async (req, reply) => {
    const { currentPassword, password } = (req.body ?? {}) as {
      currentPassword?: string;
      password?: string;
    };
    const account = req.account!;

    const hash = await getPasswordHash(account.id);
    if (!hash || !(await verifyPassword(currentPassword ?? "", hash))) {
      return reply.code(403).send({ error: "Your current password is not right." });
    }
    const problem = passwordProblem(password ?? "");
    if (problem) return reply.code(400).send({ error: problem });

    await setPasswordHash(account.id, await hashPassword(password!));
    await deleteAuthSessionsForAccount(account.id);
    // Signed out everywhere, then straight back in here, so changing your
    // password doesn't eject you from the page you're standing on.
    await startSession(req, reply, account);
    return { ok: true };
  });
}
