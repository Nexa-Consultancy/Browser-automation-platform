// Shared by GroupList and DashboardView so a countdown/time reads
// identically wherever it appears.

/** "3d 4h" / "3h 12m" / "45m" — the countdown to the next boundary. Once a
 * group only runs on some weekdays the next start can be days out, so this
 * has to carry a day component. -1 means "no day is selected". */
export function relative(minutes: number): string {
  if (minutes < 0) return "never";
  if (minutes === 0) return "now";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "17:00" -> "5:00 PM". */
export function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Every day" / "Mon–Fri" / "Mon, Wed, Fri" — the shortest true phrasing. */
export function describeDays(days: number[]): string {
  const set = [...days].sort((a, b) => a - b);
  if (set.length === 7) return "Every day";
  if (set.length === 5 && set.join() === "1,2,3,4,5") return "Mon–Fri";
  if (set.length === 2 && set.join() === "0,6") return "Weekends";
  // Monday-first, matching the order the checkboxes are shown in.
  const ordered = [1, 2, 3, 4, 5, 6, 0].filter((d) => set.includes(d));
  return ordered.map((d) => DAY_LABELS[d]).join(", ") || "No days selected";
}

/** "17:00" -> 1020. Null when it isn't a time at all. */
export function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Reads a time out of whatever someone types into the master search:
 * "13:00", "1:00 PM", "1pm", "1 PM", "1:30pm". Returns minutes since
 * midnight, or null when the text isn't a time.
 *
 * A bare number is deliberately NOT a time — searching "3" should find the
 * group with 3 in its name, not every group whose window touches 3 AM.
 */
export function parseTimeQuery(raw: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  const suffix = m[3]?.toLowerCase();
  // No colon and no am/pm is just a number, not a time.
  if (m[2] === undefined && !suffix) return null;

  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (suffix) {
    if (h < 1 || h > 12) return null;
    if (suffix === "pm" && h !== 12) h += 12;
    if (suffix === "am" && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

/**
 * Whether a daily wall-clock window contains a given minute. An end at or
 * before the start means the window crosses midnight (21:00 → 02:00), which
 * is exactly how the scheduler reads it — see windowStateAt in shared/time.
 */
export function windowCovers(startHhMm: string, endHhMm: string, minute: number): boolean {
  const start = hhmmToMinutes(startHhMm);
  const end = hhmmToMinutes(endHhMm);
  if (start === null || end === null) return false;
  return end > start ? minute >= start && minute < end : minute >= start || minute < end;
}
