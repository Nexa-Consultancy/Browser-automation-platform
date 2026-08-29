import { useState } from "react";
import type { InputAction } from "../types";

/** Type/Enter/Tab/Backspace row for interactive takeover — shared by the
 * grid card and the expanded modal. */
export function ScreencastControls({ onInput }: { onInput: (action: InputAction) => void }) {
  const [typeText, setTypeText] = useState("");

  function sendText() {
    if (!typeText) return;
    onInput({ kind: "type", text: typeText });
    setTypeText("");
  }

  return (
    <div className="session-followup">
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
  );
}
