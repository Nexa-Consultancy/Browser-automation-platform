import { Queue } from "bullmq";
import { newRedisConnection } from "./redis.js";

export const RUN_JOB_QUEUE_NAME = "run-job";

export interface RunJobData {
  jobId: string;
}

let _queue: Queue<RunJobData> | null = null;

/** Lazily-created singleton so both the API (enqueue-only) and any script
 * that imports this module share one connection per process. */
export function runJobQueue(): Queue<RunJobData> {
  if (!_queue) {
    _queue = new Queue<RunJobData>(RUN_JOB_QUEUE_NAME, { connection: newRedisConnection() });
  }
  return _queue;
}

export async function enqueueJob(jobId: string): Promise<void> {
  await runJobQueue().add(RUN_JOB_QUEUE_NAME, { jobId }, {
    jobId, // idempotent: re-enqueuing the same job id won't duplicate
    removeOnComplete: 500,
    removeOnFail: 500,
  });
}

// ---------- bake-master-login queue ----------
// A separate queue from run-job: baking a captured Teams session into the
// master profile is a short, one-shot task, and keeping it off the run-job
// queue means it can't be starved by long-lived parked runs.

export const BAKE_MASTER_QUEUE_NAME = "bake-master";

export interface BakeMasterData {
  /** Path (on the shared /data volume) to the uploaded storageState JSON. */
  statePath: string;
}

let _bakeQueue: Queue<BakeMasterData> | null = null;

export function bakeMasterQueue(): Queue<BakeMasterData> {
  if (!_bakeQueue) {
    _bakeQueue = new Queue<BakeMasterData>(BAKE_MASTER_QUEUE_NAME, { connection: newRedisConnection() });
  }
  return _bakeQueue;
}

export async function enqueueBakeMaster(statePath: string): Promise<void> {
  await bakeMasterQueue().add(BAKE_MASTER_QUEUE_NAME, { statePath }, {
    removeOnComplete: 20,
    removeOnFail: 20,
  });
}
