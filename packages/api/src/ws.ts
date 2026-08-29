import type { FastifyInstance } from "fastify";
import {
  newRedisConnection,
  eventsChannel,
  screencastChannel,
  screencastLastFrameKey,
  controlChannel,
} from "@automation/queue";
import { listSessionsByJob } from "@automation/db";
import type { ControlMessage } from "@automation/shared";

// Unlike fetch/XHR, a browser will happily open a WebSocket to any origin —
// same-origin policy doesn't apply to the connection itself. Without this
// check, any third-party page a viewer merely has open in another tab could
// connect here and, given a job id, ride along on its event/screencast
// stream and send input actions. This isn't a substitute for real
// authentication (there isn't any yet — see the README) but it closes the
// no-visit-required drive-by version of that gap.
function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, server-to-server) send no Origin header
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * One WS connection per dashboard tab. The client sends {type:"subscribe",
 * jobId} once it opens a job view, then this relays that job's Redis event
 * stream + every session's screencast frames straight through. Interactive
 * input (click/type/key passthrough for the "takeover" feature) flows the
 * other direction over the same socket for minimum latency.
 */
export async function registerWs(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket, request) => {
    if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
      socket.close(1008, "origin not allowed");
      return;
    }

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
          // CDP only pushes frames on repaint, so a static/idle page may
          // never send another one — without this, a (re)connecting client
          // sees "waiting for stream…" forever even on a healthy session.
          const lastFrame = await pub.get(screencastLastFrameKey(s.id));
          if (lastFrame) {
            socket.send(JSON.stringify({ type: "screencast", sessionId: s.id, frame: lastFrame }));
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
