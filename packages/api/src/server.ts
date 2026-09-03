import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocketPlugin from "@fastify/websocket";
import { migrate } from "@automation/db";
import { groupRoutes } from "./routes/groups.js";
import { organizationRoutes } from "./routes/organizations.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/accounts.js";
import { seedAccounts } from "./auth/seed.js";
import { historyRoutes } from "./routes/history.js";
import { systemRoutes } from "./routes/system.js";
import { jobRoutes } from "./routes/jobs.js";
import { sessionRoutes } from "./routes/sessions.js";
import { userRoutes } from "./routes/users.js";
import { templateRoutes } from "./routes/templates.js";
import { registerWs } from "./ws.js";
import { startGroupScheduler } from "./scheduler.js";
import { startAlertListener } from "./alertListener.js";

async function main() {
  // Required to store/read a PlatformUser's Microsoft password
  // (pgp_sym_encrypt/pgp_sym_decrypt) — refuse to start rather than let
  // user creation fail confusingly later, or silently fall back to a
  // guessable default the way POSTGRES_PASSWORD does for local dev.
  if (!process.env.CREDENTIALS_ENC_KEY) {
    console.error(
      "CREDENTIALS_ENC_KEY is not set — required to store/read PlatformUser passwords. Generate one with `openssl rand -hex 32` and set it in the environment.",
    );
    process.exit(1);
  }

  await migrate();
  await seedAccounts({ info: (m) => console.log(m), error: (m) => console.error(m) });

  const app = Fastify({ logger: true });

  // The dashboard never actually makes a cross-origin request — in prod
  // nginx serves it from the same origin as the api, and in dev Vite's own
  // proxy (see packages/dashboard/vite.config.ts) forwards /api and /ws
  // server-side, so the browser only ever talks to its own origin. That
  // means `origin: true` (reflect whatever Origin the request sent) bought
  // nothing functionally, while combined with `credentials: true` it let
  // ANY website make cookie-bearing requests here on a signed-in visitor's
  // behalf — this app didn't have cookie sessions when that was written.
  // An explicit allowlist keeps same-origin traffic working (which needs
  // no CORS headers at all) and closes that off.
  const allowedOrigins = [
    process.env.PUBLIC_BASE_URL?.trim(),
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].filter((o): o is string => Boolean(o));
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart);
  await app.register(websocketPlugin);

  app.get("/health", async () => ({ ok: true }));

  await app.register(jobRoutes);
  await app.register(groupRoutes);
  await app.register(historyRoutes);
  await app.register(systemRoutes);
  await app.register(sessionRoutes);
  await app.register(userRoutes);
  await app.register(templateRoutes);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(organizationRoutes);
  await app.register(registerWs);

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });

  // Scheduled groups fire from here rather than from a worker: the API is
  // the single-replica service in this stack (workers are the ones scaled
  // out), so exactly one clock ticks — and the Postgres occurrence claim
  // keeps even that assumption from mattering if it ever stops holding.
  // See packages/api/src/scheduler.ts.
  startAlertListener({
    info: (msg) => app.log.info(msg),
    error: (msg) => app.log.error(msg),
  });

  startGroupScheduler({
    info: (msg) => app.log.info(msg),
    error: (msg) => app.log.error(msg),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
