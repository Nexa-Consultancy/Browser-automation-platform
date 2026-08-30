import { useRef } from "react";
import type { InputAction } from "../types";
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from "../viewport";

interface Props {
  frame: string | null; // base64 JPEG, no data: prefix
  interactive: boolean;
  onInput: (action: InputAction) => void;
}

// Hover is sent as a stream of positions, so it needs a rate limit or a
// single sweep across the frame floods the control channel. ~20/sec is
// smooth enough for menus that open on mouseover without the flood.
const MOVE_INTERVAL_MS = 50;

/** The live-frame `<img>` you can actually drive: left click, double click,
 * right click, scroll and hover are all mapped back to real page
 * coordinates and forwarded into that user's browser. Shared by the grid
 * card and the expanded modal so the coordinate mapping only lives once. */
export function ScreencastImage({ frame, interactive, onInput }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const lastMoveAt = useRef(0);

  /** Displayed pixel -> real page pixel. The frame is letterboxed by
   * `object-fit: contain`, so the element's box can be wider or taller than
   * the image actually drawn inside it; mapping off the element rect alone
   * would put every click out by the size of the bars. */
  function toPageCoords(e: React.MouseEvent): { x: number; y: number } | null {
    const el = imgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const scale = Math.min(rect.width / VIEWPORT_WIDTH, rect.height / VIEWPORT_HEIGHT);
    const drawnW = VIEWPORT_WIDTH * scale;
    const drawnH = VIEWPORT_HEIGHT * scale;
    const offsetX = (rect.width - drawnW) / 2;
    const offsetY = (rect.height - drawnH) / 2;

    const x = (e.clientX - rect.left - offsetX) / scale;
    const y = (e.clientY - rect.top - offsetY) / scale;

    // A click on the letterbox bars isn't anywhere on the page.
    if (x < 0 || y < 0 || x > VIEWPORT_WIDTH || y > VIEWPORT_HEIGHT) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function send(e: React.MouseEvent, kind: "click" | "dblclick" | "rightclick" | "move") {
    if (!interactive) return;
    const p = toPageCoords(e);
    if (!p) return;
    onInput({ kind, x: p.x, y: p.y });
  }

  if (!frame) return <div className="placeholder">waiting for stream…</div>;

  return (
    <img
      ref={imgRef}
      className={interactive ? "screencast-live" : undefined}
      src={`data:image/jpeg;base64,${frame}`}
      draggable={false}
      onClick={(e) => send(e, "click")}
      onDoubleClick={(e) => send(e, "dblclick")}
      onContextMenu={(e) => {
        // Suppress the browser's own menu so the right click lands on the
        // remote page instead of opening a menu over the screencast.
        if (!interactive) return;
        e.preventDefault();
        send(e, "rightclick");
      }}
      onMouseMove={(e) => {
        if (!interactive) return;
        const now = Date.now();
        if (now - lastMoveAt.current < MOVE_INTERVAL_MS) return;
        lastMoveAt.current = now;
        send(e, "move");
      }}
      onWheel={(e) => {
        if (!interactive) return;
        onInput({ kind: "scroll", deltaY: Math.round(e.deltaY) });
      }}
      title={
        interactive
          ? "Click, double-click, right-click, scroll or hover — it all goes to this user's browser"
          : undefined
      }
    />
  );
}
