import { useState } from "react";
import type { InputAction } from "../types";

/**
 * Live keyboard passthrough.
 *
 * Every keystroke is forwarded to the user's browser as you make it, so what
 * you type appears in the real page immediately and Enter sends it — the way
 * typing into a chat box actually works. The old behaviour buffered the text
 * locally and only pushed it on a button press, which meant nothing showed up
 * remotely until you submitted, and then still needed a mouse click on the
 * page's own Send button.
 *
 * The local box keeps its own copy purely so you can see what you've typed;
 * it's cleared on Enter to match the page's input clearing.
 */
export function ScreencastControls({ onInput }: { onInput: (action: InputAction) => void }) {
  const [text, setText] = useState("");

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Let the browser's own shortcuts through untouched.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "Enter") {
      e.preventDefault();
      onInput({ kind: "key", key: "Enter" });
      setText("");
      return;
    }
    if (e.key === "Tab") {
      // Otherwise focus leaves the box and the remote page never sees the Tab.
      e.preventDefault();
      onInput({ kind: "key", key: "Tab" });
      return;
    }
    if (e.key === "Backspace") {
      onInput({ kind: "key", key: "Backspace" });
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Delete", "Home", "End"].includes(e.key)) {
      onInput({ kind: "key", key: e.key });
      return;
    }
    // A single-character key is real text; anything longer is a modifier or
    // function key we don't forward.
    if (e.key.length === 1) {
      onInput({ kind: "type", text: e.key });
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!pasted) return;
    e.preventDefault();
    onInput({ kind: "type", text: pasted });
    setText((t) => t + pasted);
  }

  return (
    <div className="live-keys">
      <input
        type="text"
        className="live-keys-input"
        placeholder="Type here — it goes straight to the page. Enter sends."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
      <div className="live-keys-buttons">
        <button type="button" onClick={() => { onInput({ kind: "key", key: "Enter" }); setText(""); }} title="Enter">
          ⏎
        </button>
        <button type="button" onClick={() => onInput({ kind: "key", key: "Tab" })} title="Tab">
          Tab
        </button>
        <button type="button" onClick={() => onInput({ kind: "key", key: "Backspace" })} title="Backspace">
          ⌫
        </button>
      </div>
    </div>
  );
}
