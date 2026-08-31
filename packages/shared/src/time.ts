// Wall-clock scheduling helpers for groups.
//
// A group fires on a *local wall-clock* window ("5:00 PM to 9:00 PM in
// Asia/Kolkata"), not on an absolute instant — so every comparison has to
// be made in that group's own IANA timezone. Doing the math on UTC offsets
// instead would silently shift the window by an hour every time the region
// crosses a DST boundary. `Intl` is the only DST-correct clock available
// without pulling in a date library, so that's what the conversion uses.

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MINUTES_PER_DAY = 1440;

/** "HH:MM" (24-hour) -> minutes since local midnight. */
export function parseHhMm(value: string): number {
  const m = HHMM_RE.exec((value ?? "").trim());
  if (!m) throw new Error(`invalid time "${value}" — expected 24-hour HH:MM (e.g. 16:45)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** minutes since local midnight -> "HH:MM". */
export function formatHhMm(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The server's own IANA zone. This is the default region for new groups —
 * "just go with the region the server is in" — and can be pinned
 * explicitly with the standard `TZ` env var on the container.
 */
export function serverTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface ZonedNow {
  /** Calendar date in that zone, "YYYY-MM-DD". */
  date: string;
  /** Minutes since midnight in that zone, 0–1439. */
  minutes: number;
}

// Building an Intl.DateTimeFormat is comparatively expensive and the
// scheduler re-reads the clock for every group on every tick, so keep one
// formatter per zone.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, fmt);
  }
  return fmt;
}

/** Current local date + minute-of-day in the given IANA zone. */
export function zonedNow(timezone: string, at: Date = new Date()): ZonedNow {
  const parts = formatterFor(timezone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = Number(get("hour")) % 24; // some engines render midnight as "24"
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/** Shift a "YYYY-MM-DD" calendar date by whole days. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Weekday of a "YYYY-MM-DD" calendar date, 0 = Sunday … 6 = Saturday —
 * the same numbering as Date#getDay, and what a group's `days` holds. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Minutes until the next selected day's start boundary — which can be days
 * out, not just "later today", once a group only runs on some weekdays.
 * Returns -1 when no day is selected (the group can never start).
 */
function minutesUntilNextStart(startMinutes: number, now: ZonedNow, days: number[]): number {
  if (days.length === 0) return -1;
  // 0..7 so a once-a-week group wraps around to the same weekday next week.
  for (let offset = 0; offset <= 7; offset++) {
    const date = offset === 0 ? now.date : shiftDate(now.date, offset);
    if (!days.includes(weekdayOf(date))) continue;
    const delta = offset * MINUTES_PER_DAY + startMinutes - now.minutes;
    if (delta >= 0) return delta;
  }
  return -1;
}

/**
 * The minute the automation should actually begin.
 *
 * People schedule against the time the *event* happens ("the class is at
 * 2:00"), but the browsers need to be up and settled before it — logging in
 * and joining takes time. So a group stores the event time the user typed
 * and a lead, and everything downstream schedules against this instead.
 * Wraps backwards over midnight: 00:05 with a 10-minute lead is 23:55.
 */
export function effectiveStartMinutes(startMinutes: number, leadMinutes: number): number {
  return ((startMinutes - leadMinutes) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export interface WindowState {
  inWindow: boolean;
  /**
   * Stable identity of the occurrence currently in progress, e.g.
   * "2026-08-29@17:00" — null when outside the window. The scheduler
   * records the last key it started so a group fires exactly once per
   * occurrence even though the tick runs every few seconds.
   */
  occurrenceKey: string | null;
  /** Minutes from now until the next start boundary on a selected day.
   * Can exceed a day when the group doesn't run every day; -1 if no day is
   * selected at all. */
  minutesUntilStart: number;
  /** Minutes from now until the next end boundary (0–1439). */
  minutesUntilEnd: number;
}

/**
 * Where "now" sits relative to a [start, end) wall-clock window on the
 * selected weekdays.
 *
 * An end before the start means the window crosses midnight (21:00→02:00),
 * in which case the post-midnight half still belongs to the *previous*
 * day's occurrence — and the day filter is applied to the date the window
 * *started* on, so a Friday-only 21:00→02:00 group keeps running into
 * Saturday morning rather than being cut off at midnight.
 */
export function windowStateAt(
  startMinutes: number,
  endMinutes: number,
  now: ZonedNow,
  days: number[] = ALL_DAYS,
): WindowState {
  let inWindow: boolean;
  let occurrenceDate = now.date;

  if (startMinutes === endMinutes) {
    inWindow = false; // zero-length window never fires
  } else if (endMinutes < startMinutes) {
    inWindow = now.minutes >= startMinutes || now.minutes < endMinutes;
    if (inWindow && now.minutes < endMinutes) occurrenceDate = shiftDate(now.date, -1);
  } else {
    inWindow = now.minutes >= startMinutes && now.minutes < endMinutes;
  }

  if (inWindow && !days.includes(weekdayOf(occurrenceDate))) inWindow = false;

  return {
    inWindow,
    occurrenceKey: inWindow ? `${occurrenceDate}@${formatHhMm(startMinutes)}` : null,
    minutesUntilStart: minutesUntilNextStart(startMinutes, now, days),
    minutesUntilEnd: (endMinutes - now.minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
