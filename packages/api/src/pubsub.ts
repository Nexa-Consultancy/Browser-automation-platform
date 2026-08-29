import { newRedisConnection, controlChannel } from "@automation/queue";
import type { ControlMessage } from "@automation/shared";

const pub = newRedisConnection();

export async function publishControl(sessionId: string, msg: ControlMessage): Promise<void> {
  await pub.publish(controlChannel(sessionId), JSON.stringify(msg));
}
