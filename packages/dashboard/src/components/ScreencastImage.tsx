import { useRef } from "react";
import type { InputAction } from "../types";
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from "../viewport";

interface Props {
  frame: string | null; // base64 JPEG, no data: prefix
  interactive: boolean;
  onInput: (action: InputAction) => void;
}

/** Just the clickable live-frame `<img>` (or a placeholder) — shared by the
 * grid card and the expanded modal so click-to-input coordinate mapping
 * only lives in one place. */
export function ScreencastImage({ frame, interactive, onInput }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);

  function handleClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!interactive || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    onInput({ kind: "click", x: Math.round(relX * VIEWPORT_WIDTH), y: Math.round(relY * VIEWPORT_HEIGHT) });
  }

  if (!frame) return <div className="placeholder">waiting for stream…</div>;
  return (
    <img
      ref={imgRef}
      src={`data:image/jpeg;base64,${frame}`}
      onClick={handleClick}
      title={interactive ? "Click to interact with this user's browser" : undefined}
    />
  );
}
