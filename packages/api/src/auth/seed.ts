import {
  adoptOrphanData,
  createAccount,
  findAccountByEmail,
  findAccountByLogin,
  seedTemplatesForAccount,
  type Account,
} from "@automation/db";
import { hashPassword } from "./password.js";

interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Creates the two bootstrap accounts from the environment, if they are not
 * there already.
 *
 * Credentials come from env vars rather than from a migration so that no
 * real password is ever committed to the repository — the values live in
 * .env on the server, which is gitignored. Seeding is skipped entirely when
 * the vars are unset, so a checkout with no configuration simply starts
 * with no accounts rather than with a known-password back door.
 *
 * Both are idempotent: an existing account is left exactly as it is,
 * including its password. Changing ADMIN_PASSWORD in .env does NOT rewrite
 * a password that already exists — rotating a live password is a
 * deliberate act through the app, not a side effect of a restart.
 */
export async function seedAccounts(log: Logger): Promise<void> {
  await seedAdmin(log);
  const owner = await seedOwner(log);
  if (!owner) return;

  // Order matters here, and it is not obvious.
  //
  // Everything that existed before accounts did belongs to somebody, so the
  // owner adopts it — INCLUDING the templates the old single-workspace
  // schema seeded. That has to happen BEFORE seedTemplatesForAccount, or
  // the account ends up with two templates claiming the same default scope
  // and the unique index rejects the adoption outright.
  //
  // Run on every boot, not just the first: it is idempotent (there is
  // nothing left to adopt once done) and it self-heals a row written by an
  // older build.
  const adopted = await adoptOrphanData(owner.id);
  const total = Object.values(adopted).reduce((a, b) => a + b, 0);
  if (total > 0) {
    log.info(
      `adopted pre-existing data into "${owner.workspaceName}": ` +
        Object.entries(adopted)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${n} ${k}`)
          .join(", "),
    );
  }

  // No-ops when adoption already supplied templates; only a genuinely fresh
  // database gets the starter pair.
  await seedTemplatesForAccount(owner.id);
}

async function seedAdmin(log: Logger): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const email = process.env.ADMIN_EMAIL?.trim();
  if (!username || !password) return;

  if (await findAccountByLogin(username)) return;
  // The reset flow needs somewhere to send a link, so an admin without a
  // real mailbox still gets a placeholder rather than an empty column.
  const address = email || `${username}@local`;
  if (await findAccountByEmail(address)) return;

  const account = await createAccount({
    email: address,
    username,
    name: username,
    workspaceName: "Platform admin",
    phone: "",
    purpose: "Platform administrator",
    passwordHash: await hashPassword(password),
    role: "admin",
    status: "active",
  });
  await seedTemplatesForAccount(account.id);
  log.info(`seeded admin account "${username}"`);
}

async function seedOwner(log: Logger): Promise<Account | null> {
  const email = process.env.OWNER_EMAIL?.trim();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) return null;

  const existing = await findAccountByEmail(email);
  if (existing) return existing;

  const account = await createAccount({
    email,
    username: process.env.OWNER_USERNAME?.trim() || null,
    name: process.env.OWNER_NAME?.trim() || "Owner",
    workspaceName: process.env.OWNER_WORKSPACE?.trim() || "Nexa",
    phone: process.env.OWNER_PHONE?.trim() || "",
    purpose: "Workspace owner",
    passwordHash: await hashPassword(password),
    role: "owner",
    status: "active",
  });
  // Templates are NOT seeded here — see the ordering note in seedAccounts:
  // adoption runs first so the legacy templates land here instead.
  log.info(`seeded owner account "${account.email}" (workspace "${account.workspaceName}")`);
  return account;
}
