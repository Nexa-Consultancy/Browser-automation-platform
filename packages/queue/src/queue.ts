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
