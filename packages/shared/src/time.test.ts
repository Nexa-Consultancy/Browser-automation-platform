// The group scheduler's decisions come down entirely to this math, and its
// failure modes are the quiet kind — a window that fires an hour late after
// a DST shift, twice, or never. None of that shows up in a typecheck, and
// reproducing it live means waiting for a real clock, so it's pinned here.
//
//   npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatHhMm,
  isValidTimezone,
  parseHhMm,
  shiftDate,
  weekdayOf,
  windowStateAt,
  zonedNow,
} from "./time.js";

describe("parseHhMm / formatHhMm", () => {
  it("reads 24-hour times", () => {
    assert.equal(parseHhMm("16:45"), 16 * 60 + 45);
    assert.equal(parseHhMm("00:00"), 0);
    assert.equal(parseHhMm("23:59"), 1439);
  });

  it("round-trips", () => {
    assert.equal(formatHhMm(parseHhMm("17:00")), "17:00");
    assert.equal(formatHhMm(parseHhMm("04:05")), "04:05");
  });

  it("rejects anything that isn't HH:MM", () => {
    for (const bad of ["24:00", "5:00 PM", "17:60", "", "abc", "17"]) {
      assert.throws(() => parseHhMm(bad), new RegExp("invalid time"), `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("windowStateAt — same-day window (17:00 → 21:00)", () => {
  const start = parseHhMm("17:00");
  const end = parseHhMm("21:00");
  const at = (hhmm: string) => windowStateAt(start, end, { date: "2026-08-29", minutes: parseHhMm(hhmm) });

  it("is half-open: start included, end excluded", () => {
    assert.equal(at("16:59").inWindow, false);
    assert.equal(at("17:00").inWindow, true);
    assert.equal(at("20:59").inWindow, true);
    assert.equal(at("21:00").inWindow, false);
  });

  it("keys the occurrence by its start boundary, and only while inside", () => {
    assert.equal(at("19:30").occurrenceKey, "2026-08-29@17:00");
    assert.equal(at("21:00").occurrenceKey, null);
  });

  it("counts down to the next boundary, wrapping past midnight", () => {
    assert.equal(at("16:00").minutesUntilStart, 60);
    assert.equal(at("19:30").minutesUntilEnd, 90);
    assert.equal(at("22:00").minutesUntilStart, 19 * 60);
  });
});

describe("windowStateAt — overnight window (21:00 → 02:00)", () => {
  const start = parseHhMm("21:00");
  const end = parseHhMm("02:00");
  const at = (date: string, hhmm: string) => windowStateAt(start, end, { date, minutes: parseHhMm(hhmm) });

  it("stays open across midnight", () => {
    assert.equal(at("2026-08-29", "20:59").inWindow, false);
    assert.equal(at("2026-08-29", "21:30").inWindow, true);
    assert.equal(at("2026-08-30", "00:30").inWindow, true);
    assert.equal(at("2026-08-30", "02:00").inWindow, false);
    assert.equal(at("2026-08-30", "12:00").inWindow, false);
  });

  it("treats both halves as one occurrence, so it can't fire twice", () => {
    assert.equal(at("2026-08-29", "23:30").occurrenceKey, "2026-08-29@21:00");
    assert.equal(at("2026-08-30", "00:30").occurrenceKey, "2026-08-29@21:00");
  });

  it("never fires a zero-length window", () => {
    assert.equal(windowStateAt(600, 600, { date: "2026-08-29", minutes: 600 }).inWindow, false);
  });
});

describe("windowStateAt — weekday selection", () => {
  const start = parseHhMm("17:00");
  const end = parseHhMm("21:00");
  // 2026-08-31 is a Monday, so 2026-09-05 is the Saturday of that week.
  const MON = "2026-08-31", TUE = "2026-09-01", SAT = "2026-09-05", SUN = "2026-09-06";
  const WEEKDAYS = [1, 2, 3, 4, 5];

  it("only opens on the selected days", () => {
    assert.equal(windowStateAt(start, end, { date: MON, minutes: parseHhMm("18:00") }, WEEKDAYS).inWindow, true);
    assert.equal(windowStateAt(start, end, { date: SAT, minutes: parseHhMm("18:00") }, WEEKDAYS).inWindow, false);
    assert.equal(windowStateAt(start, end, { date: SUN, minutes: parseHhMm("18:00") }, WEEKDAYS).inWindow, false);
  });

  it("defaults to every day when no selection is given", () => {
    assert.equal(windowStateAt(start, end, { date: SAT, minutes: parseHhMm("18:00") }).inWindow, true);
  });

  it("counts down to the next selected day, not just later today", () => {
    // Friday evening after the window: the next start is Monday, 3 days out.
    const fri = { date: "2026-09-04", minutes: parseHhMm("22:00") };
    assert.equal(windowStateAt(start, end, fri, WEEKDAYS).minutesUntilStart, 3 * 1440 - 5 * 60);
    // Monday morning: later the same day.
    assert.equal(
      windowStateAt(start, end, { date: MON, minutes: parseHhMm("09:00") }, WEEKDAYS).minutesUntilStart,
      8 * 60,
    );
  });

  it("wraps around to the same weekday for a once-a-week group", () => {
    const tueAfter = { date: TUE, minutes: parseHhMm("22:00") };
    assert.equal(windowStateAt(start, end, tueAfter, [2]).minutesUntilStart, 7 * 1440 - 5 * 60);
  });

  it("reports -1 when no day is selected at all", () => {
    const state = windowStateAt(start, end, { date: MON, minutes: parseHhMm("18:00") }, []);
    assert.equal(state.inWindow, false);
    assert.equal(state.minutesUntilStart, -1);
  });

  it("judges an overnight window by the day it started on", () => {
    // Friday-only 21:00 -> 02:00 must keep running into Saturday morning,
    // and must NOT start on Saturday night.
    const s = parseHhMm("21:00"), e = parseHhMm("02:00");
    assert.equal(windowStateAt(s, e, { date: "2026-09-04", minutes: parseHhMm("23:00") }, [5]).inWindow, true);
    assert.equal(windowStateAt(s, e, { date: SAT, minutes: parseHhMm("01:00") }, [5]).inWindow, true);
    assert.equal(windowStateAt(s, e, { date: SAT, minutes: parseHhMm("23:00") }, [5]).inWindow, false);
  });
});

describe("weekdayOf", () => {
  it("numbers days Sunday-first, like Date#getDay", () => {
    assert.equal(weekdayOf("2026-08-30"), 0); // Sunday
    assert.equal(weekdayOf("2026-08-31"), 1); // Monday
    assert.equal(weekdayOf("2026-09-05"), 6); // Saturday
  });
});

describe("shiftDate", () => {
  it("walks calendar boundaries", () => {
    assert.equal(shiftDate("2026-09-01", -1), "2026-08-31");
    assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftDate("2028-03-01", -1), "2028-02-29");
    assert.equal(shiftDate("2027-03-01", -1), "2027-02-28");
  });
});

describe("zonedNow", () => {
  const instant = new Date("2026-08-29T12:00:00Z");

  it("reads the wall clock in the requested zone", () => {
    assert.deepEqual(zonedNow("UTC", instant), { date: "2026-08-29", minutes: 720 });
    assert.deepEqual(zonedNow("Asia/Kolkata", instant), { date: "2026-08-29", minutes: 1050 });
    assert.deepEqual(zonedNow("America/New_York", instant), { date: "2026-08-29", minutes: 480 });
  });

  it("rolls the local calendar date across the date line", () => {
    const late = new Date("2026-08-29T20:00:00Z");
    assert.deepEqual(zonedNow("Asia/Kolkata", late), { date: "2026-08-30", minutes: 90 });
    assert.deepEqual(zonedNow("Pacific/Honolulu", late), { date: "2026-08-29", minutes: 600 });
  });

  it("holds 17:00 local on both sides of a DST shift", () => {
    assert.equal(zonedNow("America/New_York", new Date("2026-01-15T22:00:00Z")).minutes, parseHhMm("17:00")); // EST
    assert.equal(zonedNow("America/New_York", new Date("2026-07-15T21:00:00Z")).minutes, parseHhMm("17:00")); // EDT
  });

  it("validates zone names", () => {
    assert.equal(isValidTimezone("Asia/Kolkata"), true);
    assert.equal(isValidTimezone("Mars/Olympus"), false);
  });
});
