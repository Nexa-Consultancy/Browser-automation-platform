import { useEffect, useState } from "react";
import type { InputAction } from "../types";
import { ScreencastImage } from "./ScreencastImage";
import { ScreencastControls } from "./ScreencastControls";
import { ViewfinderCorners } from "./ViewfinderCorners";

interface Props {
  frame: string | null; // base64 JPEG, no data: prefix
  /** Parked and waiting on a human, so taking the mouse can't interrupt
   * anything — control is on from the start. */
  parked: boolean;
  /** The browser is still open, so input can reach it at all. False once the
   * session has completed or been stopped. */
  browserOpen: boolean;
  onInput: (action: InputAction) => void;
  onExpand: () => void;
}

/**
 * Live view of one isolated session's browser, as it appears in the grid
 * card. The expand button opens the same stream full-size in a modal.
 *
 * Control follows the same rule as that modal, which is the point of this
 * component owning it: on by default when the session is parked waiting for
 * you, and available on demand at any point the browser is open. The card
 * previously offered it *only* when parked, so a run stuck halfway through
 * its script — the exact moment you want to reach in and click something —
 * silently swallowed every click on the frame, and the only way through was
 * to notice that expanding to the modal behaved differently.
 */
export function Screencast({ frame, parked, browserOpen, onInput, onExpand }: Props) {
  const [control, setControl] = useState(false);
  const interactive = browserOpen && (parked || control);

  // Losing the browser mid-takeover drops control rather than leaving a
  // toggle that silently does nothing.
  useEffect(() => {
    if (!browserOpen) setControl(false);
  }, [browserOpen]);

  return (
    <div>
      <div className="screencast-wrap">
        <ScreencastImage frame={frame} interactive={interactive} onInput={onInput} />
        <ViewfinderCorners />
        {browserOpen && !parked && (
          <button
            className={`control-btn${control ? " control-on" : ""}`}
            onClick={() => setControl((c) => !c)}
            title={
              control
                ? "Stop sending mouse and keyboard input to this browser"
                : "Click, scroll and type straight into this browser while the script runs"
            }
          >
            {control ? "🖱 Control on" : "🖱 Take control"}
          </button>
        )}
        <button className="expand-btn" onClick={onExpand} title="Expand">⤢</button>
      </div>
      {interactive && (
        <div style={{ marginTop: 6 }}>
          <ScreencastControls onInput={onInput} />
        </div>
      )}
      {interactive && !parked && (
        <div className="hint" style={{ marginTop: 4 }}>
          This session is still running its script — your clicks may change where it ends up.
        </div>
      )}
    </div>
  );
}
