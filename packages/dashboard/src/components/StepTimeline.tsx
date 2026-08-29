interface Props {
  steps: string[];
  currentIndex: number;
  failedIndices: number[];
  done: boolean;
}

/** Vertical step list with a done checkmark for finished steps, a
 * permanent cross for any step that ever failed (even after the run has
 * since moved past it — e.g. a corrected follow-up step took over), and an
 * arrow pointing at whichever step is running right now. */
export function StepTimeline({ steps, currentIndex, failedIndices, done }: Props) {
  if (steps.length === 0) return null;
  return (
    <div className="steps-timeline">
      {steps.map((text, i) => {
        const isFailed = failedIndices.includes(i);
        const isCurrent = i === currentIndex && !done && !isFailed;
        const isDone = (i < currentIndex || done) && !isFailed;
        const cls = isFailed ? "failed" : isCurrent ? "current" : isDone ? "done" : "";
        const marker = isFailed ? "✗" : isCurrent ? "→" : isDone ? "✓" : "·";
        return (
          <div className={`step-item ${cls}`} key={i}>
            <span className="idx">{marker}</span>
            <span>{text}</span>
          </div>
        );
      })}
    </div>
  );
}
