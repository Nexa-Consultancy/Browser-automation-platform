import { Worker } from "bullmq";
import { migrate } from "@automation/db";
import {
  newRedisConnection,
  RUN_JOB_QUEUE_NAME,
  BAKE_MASTER_QUEUE_NAME,
  type RunJobData,
  type BakeMasterData,
} from "@automation/queue";
import { runJob } from "./runner.js";
import { bakeMaster } from "./bakeMaster.js";

async function main() {
  await migrate();

  // NOTE: this is dispatch concurrency, not a cap on how many test runs can
  // be live at once — see the processor below.
  const concurrency = Number(process.env.WORKER_JOB_CONCURRENCY ?? 10);

  const worker = new Worker<RunJobData>(
    RUN_JOB_QUEUE_NAME,
    async (job) => {
      // Deliberately NOT awaited: a run can legitimately stay alive for
      // hours (a multi-hour "wait for video", or a session parked
      // "interactive"/"failed" waiting on a human). If the processor
      // awaited runJob() to completion, BullMQ would hold this job
      // "active" — and one of only `concurrency` worker slots — for that
      // entire time. With enough long-lived runs parked at once, every
      // *new* job submission would silently wait forever for a slot that
      // never frees up (exactly the bug this fixes). BullMQ here is only a
      // durable "start this job" trigger; the real lifecycle (running/
      // completed/failed/stopped) lives in Postgres + the live event feed,
      // not in BullMQ's own job state.
      runJob(job.data.jobId).catch((err) => {
        console.error(`job ${job.data.jobId} crashed:`, err);
      });
    },
    {
      connection: newRedisConnection(),
      concurrency,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`job ${job?.id} failed to dispatch:`, err);
  });
  worker.on("error", (err) => {
    console.error("worker error:", err);
  });

  // Second queue: bake a captured Teams session (uploaded storageState) into
  // the shared master profile. Kept off the run-job queue so this quick
  // one-shot can't be starved by long-lived parked runs.
  const bakeWorker = new Worker<BakeMasterData>(
    BAKE_MASTER_QUEUE_NAME,
    async (job) => {
      await bakeMaster(job.data.statePath);
    },
    { connection: newRedisConnection(), concurrency: 1 },
  );
  bakeWorker.on("failed", (job, err) => {
    console.error(`bake-master ${job?.id} failed:`, err);
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      // Let BullMQ release in-flight locks cleanly instead of abandoning
      // them for stalled-job recovery to sort out later.
      Promise.all([worker.close(), bakeWorker.close()]).finally(() => process.exit(0));
    });
  }

  console.log(`worker started (dispatch concurrency=${concurrency})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
