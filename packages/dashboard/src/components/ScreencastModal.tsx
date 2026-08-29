import { useEffect } from "react";
import type { InputAction } from "../types";
import { ScreencastImage } from "./ScreencastImage";
import { ScreencastControls } from "./ScreencastControls";

interface Props {
  userName: string;
  frame: string | null;
  interactive: boolean;
  onInput: (action: InputAction) => void;
  onClose: () => void;
}

/** Full-size popup view of one user's live session — click the expand icon
 * on a grid card to open it, click the backdrop or ✕ (or press Escape) to
 * go back to the grid. */
export function ScreencastModal({ userName, frame, interactive, onInput, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{userName}</span>
          <button onClick={onClose} title="Close">✕</button>
        </div>
        <div className="modal-screencast">
          <ScreencastImage frame={frame} interactive={interactive} onInput={onInput} />
        </div>
        {interactive && <ScreencastControls onInput={onInput} />}
      </div>
    </div>
  );
}
