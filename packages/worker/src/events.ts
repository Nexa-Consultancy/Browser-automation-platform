import { newRedisConnection, eventsChannel } from "@automation/queue";
import { recordEvent } from "@automation/db";
import type { SessionEventType } from "@automation/shared";

const pub = newRedisConnection();

export async function emitEvent(
  sessionId: string,
  jobId: string,
  type: SessionEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const event = await recordEvent(sessionId, jobId, type, payload);
  await pub.publish(eventsChannel(jobId), JSON.stringify(event));
}
