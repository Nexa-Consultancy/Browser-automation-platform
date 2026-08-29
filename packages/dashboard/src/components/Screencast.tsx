import type { InputAction } from "../types";
import { ScreencastImage } from "./ScreencastImage";
import { ScreencastControls } from "./ScreencastControls";
import { ViewfinderCorners } from "./ViewfinderCorners";

interface Props {
  frame: string | null; // base64 JPEG, no data: prefix
  interactive: boolean;
  onInput: (action: InputAction) => void;
  onExpand: () => void;
}

/** Live view of one isolated session's browser, as it appears in the grid
 * card. When the session is "waiting for you" (interactive), clicks on the
 * frame and text typed below are forwarded into the real page for a true
 * takeover. The expand button opens the same stream full-size in a modal. */
export function Screencast({ frame, interactive, onInput, onExpand }: Props) {
  return (
    <div>
      <div className="screencast-wrap">
        <ScreencastImage frame={frame} interactive={interactive} onInput={onInput} />
        <ViewfinderCorners />
        <button className="expand-btn" onClick={onExpand} title="Expand">⤢</button>
      </div>
      {interactive && <div style={{ marginTop: 6 }}><ScreencastControls onInput={onInput} /></div>}
    </div>
  );
}
