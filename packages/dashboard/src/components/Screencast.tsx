import { useRef, useState } from "react";
import type { InputAction } from "../types";
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from "../viewport";

interface Props {
  frame: string | null; // base64 JPEG, no data: prefix
  interactive: boolean;
  onInput: (action: InputAction) => void;
}

/** Live view of one isolated session's browser. When the session is
 * "waiting for you" (interactive), clicks on the frame and text typed
 * below are forwarded into the real page for a true takeover. */
export function Screencast({ frame, interactive, onInput }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [typeText, setTypeText] = useState("");

  function handleClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!interactive || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    onInput({ kind: "click", x: Math.round(relX * VIEWPORT_WIDTH), y: Math.round(relY * VIEWPORT_HEIGHT) });
  }

  function sendText() {
    if (!typeText) return;
    onInput({ kind: "type", text: typeText });
    setTypeText("");
  }

  return (
    <div>
      <div className="screencast-wrap">
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            onClick={handleClick}
            title={interactive ? "Click to interact with this user's browser" : undefined}
          />
        ) : (
          <div className="placeholder">waiting for stream…</div>
        )}
      </div>
      {interactive && (
        <div className="session-followup" style={{ marginTop: 6 }}>
          <input
            type="text"
            placeholder="Type into the focused field, then Enter"
            value={typeText}
            onChange={(e) => setTypeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendText();
            }}
          />
          <button onClick={sendText}>Type</button>
          <button onClick={() => onInput({ kind: "key", key: "Enter" })} title="Enter">⏎</button>
          <button onClick={() => onInput({ kind: "key", key: "Tab" })} title="Tab">Tab</button>
          <button onClick={() => onInput({ kind: "key", key: "Backspace" })} title="Backspace">⌫</button>
        </div>
      )}
    </div>
  );
}
