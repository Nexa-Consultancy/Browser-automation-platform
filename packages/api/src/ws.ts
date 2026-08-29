import type { FastifyInstance } from "fastify";
import { newRedisConnection, eventsChannel, screencastChannel, controlChannel } from "@automation/queue";
import { listSessionsByJob } from "@automation/db";
import type { ControlMessage } from "@automation/shared";

/**
 * One WS connection per dashboard tab. The client sends {type:"subscribe",
 * jobId} once it opens a job view, then this relays that job's Redis event
 * stream + every session's screencast frames straight through. Interactive
 * input (click/type/key passthrough for the "takeover" feature) flows the
 * other direction over the same socket for minimum latency.
 */
export async function registerWs(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket) => {
    const sub = newRedisConnection();
    const pub = newRedisConnection();
    const subscribed = new Set<string>();

    sub.on("message", (channel: string, message: string) => {
      if (channel.startsWith("events:job:")) {
        socket.send(JSON.stringify({ type: "event", event: JSON.parse(message) }));
      } else if (channel.startsWith("screencast:session:")) {
        const sessionId = channel.split(":").pop();
        socket.send(JSON.stringify({ type: "screencast", sessionId, frame: message }));
      }
    });

    socket.on("message", async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "subscribe" && msg.jobId) {
        const evCh = eventsChannel(msg.jobId);
        if (!subscribed.has(evCh)) {
          await sub.subscribe(evCh);
          subscribed.add(evCh);
        }
        const sessions = await listSessionsByJob(msg.jobId);
        for (const s of sessions) {
          const ch = screencastChannel(s.id);
          if (!subscribed.has(ch)) {
            await sub.subscribe(ch);
            subscribed.add(ch);
          }
        }
        socket.send(JSON.stringify({ type: "subscribed", jobId: msg.jobId, sessions }));
      } else if (msg.type === "input" && msg.sessionId && msg.action) {
        const control: ControlMessage = { type: "input", action: msg.action };
        await pub.publish(controlChannel(msg.sessionId), JSON.stringify(control));
      }
    });

    socket.on("close", () => {
      sub.disconnect();
      pub.disconnect();
    });
  });
}
