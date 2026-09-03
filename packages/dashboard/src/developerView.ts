import { useEffect, useState } from "react";

const KEY = "ba.developerView";
const EVENT = "ba:developer-view";

/**
 * "Developer view" — off by default.
 *
 * On, the dashboard also shows the run log, the session tallies and the
 * live-run controls. Off, it shows only what somebody running the business
 * needs: how many organizations, groups and people there are, what failed,
 * and what is scheduled. The detail is diagnostics, and diagnostics on the
 * front page make a working system look like a monitoring console.
 *
 * Stored per browser rather than in the settings table on purpose. It is a
 * preference about what *you* want to look at, not configuration of the
 * system — and the settings table is shared across every workspace, so a
 * server-side flag would flip the dashboard for other people's accounts too.
 */
export function getDeveloperView(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    // Private mode, or storage blocked entirely. Off is the safe answer.
    return false;
  }
}

export function setDeveloperView(on: boolean): void {
  try {
    localStorage.setItem(KEY, String(on));
  } catch {
    // Nothing to do — the toggle just won't persist past this page.
  }
  // localStorage fires "storage" only in OTHER tabs, so a same-tab listener
  // would never hear this. The custom event is what keeps the Settings
  // toggle and the dashboard in step without a page reload.
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

/** Subscribes to the flag, including changes made in another tab. */
export function useDeveloperView(): boolean {
  const [on, setOn] = useState(getDeveloperView);

  useEffect(() => {
    const sync = () => setOn(getDeveloperView());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return on;
}
