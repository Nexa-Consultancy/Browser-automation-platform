import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocketPlugin from "@fastify/websocket";
import { migrate } from "@automation/db";
import { groupRoutes } from "./routes/groups.js";
import { jobRoutes } from "./routes/jobs.js";
import { sessionRoutes } from "./routes/sessions.js";
import { registerWs } from "./ws.js";
import { startGroupScheduler } from "./scheduler.js";

async function main() {
  await migrate();

  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart);
  await app.register(websocketPlugin);

  app.get("/health", async () => ({ ok: true }));

  await app.register(jobRoutes);
  await app.register(groupRoutes);
  await app.register(sessionRoutes);
  await app.register(registerWs);

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });

  // Scheduled groups fire from here rather than from a worker: the API is
  // the single-replica service in this stack (workers are the ones scaled
  // out), so exactly one clock ticks — and the Postgres occurrence claim
  // keeps even that assumption from mattering if it ever stops holding.
  // See packages/api/src/scheduler.ts.
  startGroupScheduler({
    info: (msg) => app.log.info(msg),
    error: (msg) => app.log.error(msg),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
