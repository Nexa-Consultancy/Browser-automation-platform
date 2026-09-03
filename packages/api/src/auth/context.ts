import type { FastifyReply, FastifyRequest } from "fastify";
// Pulls in @fastify/cookie's module augmentation, which is what adds
// request.cookies and reply.setCookie to the Fastify types.
import "@fastify/cookie";
import { getAccount, touchAuthSession, type Account } from "@automation/db";
import { SESSION_COOKIE, hashToken, sessionExpiry } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireAuth. Absent on public routes. */
    account?: Account;
  }
}

/**
 * Resolves the session cookie to a live, permitted account.
 *
 * Anything short of "this cookie names an account that is allowed in right
 * now" returns null: expired, revoked, deleted, or an account an admin has
 * since set to pending/rejected/suspended. Checking status here rather than
 * only at login is what makes suspending an account take effect on the next
 * request instead of whenever their cookie happens to expire.
 */
export async function accountFromRequest(req: FastifyRequest): Promise<Account | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;

  const session = await touchAuthSession(hashToken(token), sessionExpiry());
  if (!session) return null;

  const account = await getAccount(session.accountId);
  if (!account || account.status !== "active") return null;
  return account;
}

/**
 * Fastify preHandler for everything behind the login.
 *
 * 401 rather than a redirect: these are API routes, and the dashboard turns
 * a 401 into "show the login page" itself. A redirect here would hand a
 * fetch() an HTML page where it expected JSON.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const account = await accountFromRequest(req);
  if (!account) {
    reply.code(401).send({ error: "not signed in" });
    return reply;
  }
  req.account = account;
}

/** Admin-only routes (the Accounts list, approving signups). Runs after
 * requireAuth, so `account` is already resolved. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.account?.role !== "admin") {
    reply.code(403).send({ error: "admin only" });
    return reply;
  }
}

/**
 * The account id every tenant-scoped query filters on.
 *
 * Throws rather than returning null or a fallback: reaching a scoped query
 * with no account is a routing bug (a route registered outside the
 * authenticated scope), and the safe failure for that is a 500, never a
 * query that quietly reads across every tenant.
 */
export function accountId(req: FastifyRequest): string {
  const id = req.account?.id;
  if (!id) throw new Error("route is missing requireAuth — refusing to run an unscoped query");
  return id;
}
