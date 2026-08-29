import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocketPlugin from "@fastify/websocket";
import { migrate } from "@automation/db";
import { jobRoutes } from "./routes/jobs.js";
import { sessionRoutes } from "./routes/sessions.js";
import { registerWs } from "./ws.js";

async function main() {
  await migrate();

  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart);
  await app.register(websocketPlugin);

  app.get("/health", async () => ({ ok: true }));

  await app.register(jobRoutes);
  await app.register(sessionRoutes);
  await app.register(registerWs);

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
