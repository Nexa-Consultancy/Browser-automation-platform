import { useEffect, useRef } from "react";
import type { InputAction, SessionEvent } from "./types";

type WsMessage =
  | { type: "subscribed"; jobId: string }
  | { type: "event"; event: SessionEvent }
  | { type: "screencast"; sessionId: string; frame: string };

export interface JobSocketHandle {
  sendInput: (sessionId: string, action: InputAction) => void;
}

/** Opens one WebSocket per job view, subscribes to that job's live event +
 * screencast stream, and hands raw messages to the callbacks below.
 * Reconnects with backoff if the connection drops. */
export function useJobSocket(
  jobId: string | null,
  onEvent: (event: SessionEvent) => void,
  onScreencast: (sessionId: string, frame: string) => void,
): JobSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  const onScreencastRef = useRef(onScreencast);
  onEventRef.current = onEvent;
  onScreencastRef.current = onScreencast;

  useEffect(() => {
    if (!jobId) return;
    let closedByEffect = false;
    let retryDelay = 1000;
    let socket: WebSocket;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = socket;

      socket.addEventListener("open", () => {
        retryDelay = 1000;
        socket.send(JSON.stringify({ type: "subscribe", jobId }));
      });

      socket.addEventListener("message", (ev) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "event") onEventRef.current(msg.event);
        else if (msg.type === "screencast") onScreencastRef.current(msg.sessionId, msg.frame);
      });

      socket.addEventListener("close", () => {
        if (closedByEffect) return;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10_000);
      });
    }

    connect();
    return () => {
      closedByEffect = true;
      wsRef.current?.close();
    };
  }, [jobId]);

  return {
    sendInput: (sessionId, action) => {
      wsRef.current?.send(JSON.stringify({ type: "input", sessionId, action }));
    },
  };
}
