import { ConvexError } from "convex/values";

/**
 * The widest instant a JavaScript `Date` can represent, ±8.64e15 ms.
 * `new Date(n)` beyond this is an Invalid Date, and `.toISOString()` on one
 * throws `RangeError: Invalid time value`.
 */
const MAX_ACCOUNTING_DATE_MS = 8_640_000_000_000_000;

/**
 * Refuse an accounting date that cannot be posted or even reported on
 * (SCRUM-218-C, Codex R01).
 *
 * ⚠️ THIS GUARDS A COMMITTED-MONEY-WITHOUT-GL PATH, NOT A COSMETIC ONE. A
 * Convex `v.number()` accepts NaN, ±Infinity and any finite double, including
 * values outside the `Date` domain. Such a date matches no accounting period,
 * so `shouldPost` is false and the command is ENQUEUED — which means the
 * caller's monetary writes COMMIT. The outbox then drains it into
 * `checkPostingAllowed`, whose "no period found" message formats the date with
 * `new Date(d).toISOString()` and throws `RangeError` every time. The row
 * retries until it dead-letters, and no replay can repair it: the money moved
 * and the journal never exists.
 *
 * So this must run BEFORE the first write, which is the only refusal point that
 * helps — once the transaction has written, a throw is the only thing that
 * unwinds it, and by then the enqueue has already been decided.
 *
 * Deliberately NOT solved by making the message above defensive. That would
 * stop the crash while still queueing a command dated to nothing, which is a
 * quieter version of the same defect.
 */
export function assertValidAccountingDate(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConvexError(`${label} must be a finite timestamp in milliseconds.`);
  }
  if (!Number.isInteger(value)) {
    throw new ConvexError(`${label} must be a whole number of milliseconds.`);
  }
  if (Math.abs(value) > MAX_ACCOUNTING_DATE_MS) {
    throw new ConvexError(`${label} is outside the range of a representable date.`);
  }
}
