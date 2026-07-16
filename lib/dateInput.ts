/**
 * Date-only input parsing for accounting values, in UTC.
 *
 * An `<input type="date">` yields a bare calendar date, "YYYY-MM-DD", with no
 * time or zone. The whole ledger buckets dates by their UTC month
 * (expenseAmortization.ts's `yearMonthIndex` uses `getUTCMonth`) and every
 * accounting period is bounded with `Date.UTC`, so a calendar date the user
 * picks has to become the SAME calendar date at UTC midnight —
 * `Date.UTC(y, m - 1, d)`.
 *
 * The trap this replaces: `new Date(\`${value}T00:00:00\`)`. A bare ISO *date*
 * ("2026-08-01") parses as UTC, but appending a time with no zone
 * ("2026-08-01T00:00:00") flips it to LOCAL time. For a user ahead of UTC —
 * Jordan, +3, the primary market — local midnight on the 1st is 21:00 UTC on
 * the PREVIOUS day, dropping the operation into the previous UTC month (and, at
 * an annual period boundary, the previous fiscal year). These helpers use
 * `Date.UTC`, so the result is the picked calendar date whatever the browser's
 * timezone.
 */

function utcPartsOf(value: string): [number, number, number] | null {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Start of the picked calendar day, in UTC. NaN for an empty/invalid value (matching the old parser). */
export function dateInputToUtcMs(value: string): number {
  const parts = utcPartsOf(value);
  if (!parts) return NaN;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

/**
 * End of the picked calendar day, in UTC (23:59:59.999) — the inclusive upper
 * bound of a report/query range, so the last hours of the selected end date
 * aren't clipped for a user ahead of UTC.
 */
export function dateInputEndToUtcMs(value: string): number {
  const parts = utcPartsOf(value);
  if (!parts) return NaN;
  return Date.UTC(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
}

function toLocalDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The user's LOCAL calendar today as "YYYY-MM-DD", for a date input's default.
 * Deliberately not `toISOString().slice(0, 10)`, which is the UTC date and reads
 * as YESTERDAY for a user ahead of UTC in the first hours of their day (before
 * 03:00 in Jordan) — so the picker would default to the wrong day.
 */
export function todayDateInput(): string {
  return toLocalDateInput(new Date());
}

/** The LOCAL calendar date `days` from today as "YYYY-MM-DD". */
export function daysFromTodayDateInput(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toLocalDateInput(d);
}

/**
 * UTC "YYYY-MM-DD" for a stored accounting-date ms — the round-trip inverse of
 * `dateInputToUtcMs`, for populating a date input from an existing record.
 * Reads the UTC parts (not local) so the field shows the same calendar date the
 * ledger stored, not one shifted by the viewer's offset.
 */
export function msToDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
