import { useEffect, useState } from "react";
import type { InputAction } from "../types";
import { ScreencastImage } from "./ScreencastImage";
import { ScreencastControls } from "./ScreencastControls";
import { ViewfinderCorners } from "./ViewfinderCorners";

interface Props {
  userName: string;
  frame: string | null;
  /** The session is parked and waiting on a human, so taking the mouse
   * can't interrupt anything. */
  parked: boolean;
  /** The browser is still open, so input can reach it at all. False once
   * the session has completed or been stopped. */
  live: boolean;
  onInput: (action: InputAction) => void;
  onClose: () => void;
}

/**
 * Full-size view of one user's live session, with the mouse.
 *
 * Control is a deliberate toggle rather than always-on. While a script is
 * mid-run an accidental click can knock it off course, so it defaults off
 * there and on when the session is parked waiting for you — but it can be
 * switched on at any point the browser is still open, which is exactly what
 * you want when a run is stuck on something the script can't get past.
 */
export function ScreencastModal({ userName, frame, parked, live, onInput, onClose }: Props) {
  const [control, setControl] = useState(parked);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Losing the browser mid-takeover should drop control rather than leave a
  // toggle that silently does nothing.
  useEffect(() => {
    if (!live) setControl(false);
  }, [live]);

  const active = control && live;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{userName}</span>
          <div className="modal-header-actions">
            {live && (
              <button
                className={active ? "control-on" : ""}
                onClick={() => setControl((c) => !c)}
                title={
                  active
                    ? "Stop sending mouse input to this browser"
                    : "Send clicks, scrolls and hovers straight into this browser"
                }
              >
                {active ? "🖱 Mouse control: ON" : "🖱 Take mouse control"}
              </button>
            )}
            <button onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div className={`modal-screencast${active ? " controllable" : ""}`}>
          <ScreencastImage frame={frame} interactive={active} onInput={onInput} />
          <ViewfinderCorners />
        </div>

        {active && (
          <div className="hint">
            Click · double-click · right-click · scroll · hover all go to this user's browser.
            {!parked && " This session is still running its script — your clicks may change where it ends up."}
          </div>
        )}

        {live && <ScreencastControls onInput={onInput} />}
      </div>
    </div>
  );
}
