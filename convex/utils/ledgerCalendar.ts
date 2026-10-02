// The ledger's calendar: whole UTC days, never time of day.

export const DAY_MS = 86_400_000;

/** UTC calendar day number of an instant — compared by day, never by time of day. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** True when `ms` falls on a UTC day later than the day of `nowMs`. */
export function isFutureUtcDay(ms: number, nowMs: number): boolean {
  return utcDay(ms) > utcDay(nowMs);
}
