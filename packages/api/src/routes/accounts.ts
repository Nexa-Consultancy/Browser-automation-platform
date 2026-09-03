import type { FastifyInstance } from "fastify";
import { deleteAccount, getAccount, listAccounts, setAccountStatus, type AccountStatus } from "@automation/db";
import { requireAdmin, requireAuth } from "../auth/context.js";

const STATUSES: AccountStatus[] = ["pending", "active", "rejected", "suspended"];

/**
 * Settings → Accounts: the admin's view of who may use the platform.
 *
 * Admin-only, and scoped to nothing — this is the one place that
 * deliberately reads across every workspace, because approving a signup
 * means looking at somebody else's. Every route here is behind both
 * requireAuth and requireAdmin.
 */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/accounts", { preHandler: [requireAuth, requireAdmin] }, async () => {
    return { accounts: await listAccounts() };
  });

  /** Approve, reject, or suspend. Approving is what turns a signup into a
   * login that works. */
  app.patch("/api/accounts/:id", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (!STATUSES.includes(status as AccountStatus)) {
      return reply.code(400).send({ error: `status must be one of ${STATUSES.join(", ")}` });
    }

    const existing = await getAccount(id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    // An admin locking themselves out is unrecoverable without database
    // access, so it is simply not allowed.
    if (existing.role === "admin" && status !== "active") {
      return reply.code(400).send({ error: "An admin account cannot be suspended or rejected." });
    }

    const account = await setAccountStatus(id, status as AccountStatus);
    return { account };
  });

  /**
   * Deletes an account AND its entire workspace — organizations, groups,
   * people, run history, all of it goes with the account_id cascade. There
   * is no undo, which is why the dashboard asks for the account's email to
   * be typed before calling this.
   */
  app.delete("/api/accounts/:id", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await getAccount(id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (existing.role === "admin") {
      return reply.code(400).send({ error: "An admin account cannot be deleted here." });
    }
    if (existing.id === req.account!.id) {
      return reply.code(400).send({ error: "You cannot delete the account you are signed in as." });
    }

    await deleteAccount(id);
    reply.send({ ok: true });
  });
}
