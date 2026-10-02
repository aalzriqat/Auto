// The ledger's calendar: whole UTC days, never time of day.

export const DAY_MS = 86_400_000;

/** The ECMAScript Date range: the widest instant `new Date(ms)` can represent, +/-8.64e15 ms. */
export const MAX_REPRESENTABLE_DATE_MS = 8_640_000_000_000_000;

/** True for a whole-millisecond timestamp `new Date(ms).toISOString()` can render (no NaN, fraction or out-of-range value). */
export function isRepresentableTimestamp(ms: number): boolean {
  return typeof ms === "number" && Number.isFinite(ms) && Number.isInteger(ms) && Math.abs(ms) <= MAX_REPRESENTABLE_DATE_MS;
}

/** UTC calendar day number of an instant — compared by day, never by time of day. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** True when `ms` falls on a UTC day later than the day of `nowMs`. */
export function isFutureUtcDay(ms: number, nowMs: number): boolean {
  return utcDay(ms) > utcDay(nowMs);
}

/**
 * The UTC calendar date of an instant as "YYYY-MM-DD", for refusals that name a boundary day.
 * Built from the UTC parts, not `toISOString().slice(0, 10)`, which is wrong for years outside 0000-9999.
 * The date comes from `utcDay(ms)`, the day the guards compare, so a fractional instant before 1970
 * (where the Date constructor truncates toward zero) is labelled with the day `utcDay` floors to.
 */
export function utcDateLabel(ms: number): string {
  const date = new Date(utcDay(ms) * DAY_MS);
  const year = date.getUTCFullYear();
  const yyyy = `${year < 0 ? "-" : ""}${String(Math.abs(year)).padStart(4, "0")}`;
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
