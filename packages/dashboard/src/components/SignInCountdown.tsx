import { useEffect, useState } from "react";

/** How long an unattended Microsoft sign-in usually takes end to end. */
const SECONDS = 10;

/**
 * The little clock on a person's card while their sign-in runs.
 *
 * It exists because the sign-in is meant to need nobody: without some sign
 * of progress, "Add person" looks like it did nothing for ten seconds. The
 * countdown is an expectation, not a measurement — the run is finished when
 * the server says so (the card stops rendering this), not when the number
 * reaches zero. That is why it stops at "almost there" instead of claiming
 * success it cannot see.
 */
export function SignInCountdown({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.floor((now - startedAt) / 1000);
  const left = Math.max(0, SECONDS - elapsed);
  // Drives the ring; clamped so a slow run doesn't wind it backwards.
  const progress = Math.min(1, elapsed / SECONDS);

  return (
    <span className="signin-countdown" title="Signing this person into Microsoft — nothing for you to do.">
      <span
        className="signin-ring"
        style={{ ["--p" as string]: `${Math.round(progress * 100)}%` }}
        aria-hidden="true"
      >
        {/* The digit is its own element so it can sit above the ring's
            inner disc — a bare text node cannot be given a z-index. */}
        <span className="signin-ring-n">{left > 0 ? left : "·"}</span>
      </span>
      {left > 0 ? `signing in… ${left}s` : "almost there…"}
    </span>
  );
}
