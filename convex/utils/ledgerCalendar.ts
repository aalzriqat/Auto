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
