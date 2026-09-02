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
