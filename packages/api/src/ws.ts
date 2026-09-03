import type { FastifyInstance } from "fastify";
import {
  newRedisConnection,
  eventsChannel,
  screencastChannel,
  screencastLastFrameKey,
  controlChannel,
} from "@automation/queue";
import { jobBelongsToAccount, listSessionsByJob } from "@automation/db";
import { accountFromRequest } from "./auth/context.js";
import type { ControlMessage } from "@automation/shared";

// Unlike fetch/XHR, a browser will happily open a WebSocket to any origin —
// same-origin policy doesn't apply to the connection itself. Without this
// check, any third-party page a viewer merely has open in another tab could
// connect here and, given a job id, ride along on its event/screencast
// stream and send input actions. Real authentication now runs alongside it
// (the session cookie is checked on connect, and job ownership on
// subscribe); this stays as the cheap first gate that rejects a drive-by
// before any of that work happens.
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

    // Real authentication, not just an origin check: the socket carries the
    // same session cookie the REST API uses, and a connection that cannot
    // name a signed-in account is closed before it can subscribe to
    // anything.
    //
    // Started here but NOT awaited here, and this matters: the dashboard
    // sends its "subscribe" the instant the socket opens. Awaiting before
    // the message listener is attached means that first frame arrives with
    // nobody listening and is silently dropped — the live view then waits
    // forever for a stream it never asked for. Attaching the listener
    // synchronously and awaiting this promise inside it keeps the check
    // without the race.
    const accountReady = accountFromRequest(request).then((account) => {
      if (!account) socket.close(1008, "not signed in");
      return account;
    });

    const sub = newRedisConnection();
    const pub = newRedisConnection();
    const subscribed = new Set<string>();

    /** A frame can be published in the moment between the browser closing the
     * socket and this handler being torn down, and sending on a closed socket
     * throws out of the Redis message callback — where nothing catches it. */
    function send(payload: unknown): void {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // The socket went away mid-send; the close handler does the cleanup.
      }
    }

    /** Idempotent, and marked *before* awaiting: two subscribe messages
     * arriving together would otherwise both see an empty set and each
     * subscribe, which duplicates every frame on the wire. */
    async function subscribeOnce(channel: string): Promise<void> {
      if (subscribed.has(channel)) return;
      subscribed.add(channel);
      try {
        await sub.subscribe(channel);
      } catch (err) {
        subscribed.delete(channel);
        throw err;
      }
    }

    sub.on("message", (channel: string, message: string) => {
      if (channel.startsWith("events:job:")) {
        send({ type: "event", event: JSON.parse(message) });
      } else if (channel.startsWith("screencast:session:")) {
        const sessionId = channel.split(":").pop();
        send({ type: "screencast", sessionId, frame: message });
      }
    });

    // nginx is configured to hold this open for hours (a "wait for video"
    // step legitimately needs that), but a parked session sends nothing at
    // all — and any proxy or load balancer in front of this with its own
    // shorter idle timeout would quietly cut a healthy connection. A ping
    // costs nothing and keeps the path warm.
    const heartbeat = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.ping();
      } catch {
        // Same as above — the close handler cleans up.
      }
    }, 30_000);

    socket.on("message", async (raw: Buffer) => {
      // Every message waits on the same one-shot auth promise, so a frame
      // that beat the lookup is handled rather than lost.
      const account = await accountReady;
      if (!account) return;

      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "subscribe" && msg.jobId) {
        // A job id is guessable, and the stream carries live screenshots of
        // somebody's browser — so ownership is checked here, not assumed
        // from the fact that the socket authenticated at all.
        if (!(await jobBelongsToAccount(msg.jobId, account.id))) {
          send({ type: "error", error: "not found" });
          return;
        }
        await subscribeOnce(eventsChannel(msg.jobId));
        const sessions = await listSessionsByJob(msg.jobId);
        for (const s of sessions) {
          await subscribeOnce(screencastChannel(s.id));
          // CDP only pushes frames on repaint, so a static/idle page may
          // never send another one — without this, a (re)connecting client
          // sees "waiting for stream…" forever even on a healthy session.
          const lastFrame = await pub.get(screencastLastFrameKey(s.id));
          if (lastFrame) send({ type: "screencast", sessionId: s.id, frame: lastFrame });
        }
        send({ type: "subscribed", jobId: msg.jobId, sessions });
      } else if (msg.type === "input" && msg.sessionId && msg.action) {
        const control: ControlMessage = { type: "input", action: msg.action };
        await pub.publish(controlChannel(msg.sessionId), JSON.stringify(control));
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      sub.disconnect();
      pub.disconnect();
    });
  });
}
