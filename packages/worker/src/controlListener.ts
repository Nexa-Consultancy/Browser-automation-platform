import { newRedisConnection, controlChannel } from "@automation/queue";
import type { ControlMessage } from "@automation/shared";

export function subscribeControl(
  sessionId: string,
  onMessage: (msg: ControlMessage) => void,
): { close: () => void } {
  const sub = newRedisConnection();
  void sub.subscribe(controlChannel(sessionId));
  sub.on("message", (_channel: string, message: string) => {
    try {
      onMessage(JSON.parse(message) as ControlMessage);
    } catch {
      // ignore malformed control payloads
    }
  });
  return { close: () => sub.disconnect() };
}
