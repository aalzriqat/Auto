/**
 * Straight-line recognition for PREPAID expenses (e.g. 6 months of rent paid
 * in one lump sum). Mirrors the whole-month bucketing convex/fixedAssets.ts
 * uses for depreciation: each expense is spread evenly across
 * amortizationMonths calendar months starting with the month of `date`,
 * rather than prorating by exact days.
 *
 * There is ONE authoritative schedule — `recognizedThroughMonthsMinor` below,
 * computed entirely in integer minor units — and it lives in the
 * `prepaidExpenseSchedules` row (net-of-VAT `totalMinor`, `currency`,
 * `startYearMonth`, `termMonths`). BOTH consumers read that same row: the
 * monthly GL amortization cron (prepaidExpenses.amortizePrepaidExpenseForMonth)
 * and the operational P&L report (reports.ts, via the *FromSchedule helpers).
 * Because they share the row and the integer schedule, the ledger-backed P&L
 * and the operational P&L can never diverge — VAT or a currency change on the
 * source expense doc can't skew the report, because the report no longer reads
 * the gross expense amount for a scheduled prepaid.
 *
 * The expense-doc helpers (computeAmortizationInfo / recognizedAmountInRange)
 * remain only as a net-of-VAT fallback for a prepaid expense that has no
 * schedule row yet (legacy rows created before this feature / not yet
 * backfilled).
 */

import { toMinorUnits, fromMinorUnits } from "./money";

/**
 * How far before a report window to look for a still-amortizing prepaid expense
 * that has NO schedule row (legacy / not-yet-backfilled). Sized to the schema's
 * max amortization term (expense.schema.ts: amortizationMonths ≤ 600) so a
 * long-term prepaid can't fall outside the window — the 36-month value this
 * replaced silently dropped anything older. Scheduled prepaid doesn't use this
 * at all: the report finds it via the prepaidExpenseSchedules table, uncapped.
 */
export const PREPAID_LOOKBACK_MS = 600 * 31 * 24 * 60 * 60 * 1000;

/** Absolute month index (year*12 + month) for a timestamp — comparable across years. */
export function yearMonthIndex(timestamp: number): number {
  const d = new Date(timestamp);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Absolute month index for a "YYYY-MM" string, comparable to yearMonthIndex. */
export function yearMonthStringIndex(ym: string): number {
  const [year, month] = ym.split("-").map(Number);
  return year * 12 + (month - 1);
}

function clampMonths(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

/**
 * THE authoritative straight-line schedule, in integer minor units.
 * `monthsElapsed` is how many whole recognition months have completed
 * (0..termMonths). Uses the standard largest-remainder integer split:
 * recognizedThrough(m) = floor(m * totalMinor / termMonths). Each month then
 * recognizes floor(total/term) or ceil(total/term) (the deltas differ by at
 * most one minor unit), the cumulative after all termMonths is exactly
 * `totalMinor`, and — unlike a ceil'd flat share — a tiny amount over a long
 * term is spread across the WHOLE term instead of finishing early.
 */
export function recognizedThroughMonthsMinor(
  totalMinor: number,
  termMonths: number,
  monthsElapsed: number
): number {
  if (termMonths <= 0 || monthsElapsed <= 0) return 0;
  if (monthsElapsed >= termMonths) return totalMinor;
  return Math.floor((monthsElapsed * totalMinor) / termMonths);
}

/**
 * The amount recognized by the single month that takes a schedule from
 * `monthsAlreadyRecognized` completed months to one more. This is what the
 * monthly GL cron posts, so the cron and any as-of-date report reading the same
 * schedule agree exactly.
 */
export function monthAmountMinor(
  totalMinor: number,
  termMonths: number,
  monthsAlreadyRecognized: number
): number {
  return (
    recognizedThroughMonthsMinor(totalMinor, termMonths, monthsAlreadyRecognized + 1) -
    recognizedThroughMonthsMinor(totalMinor, termMonths, monthsAlreadyRecognized)
  );
}

export interface ExpenseLike {
  amount: number;
  date: number;
  isPrepaid?: boolean;
  amortizationMonths?: number;
  // Input VAT included in `amount` (tax-inclusive). Only the net (amount − tax)
  // is capitalized to the Prepaid Expenses asset and recognized as expense, so
  // the report must amortize net, not gross — see file header.
  taxAmount?: number;
}

export interface AmortizationInfo {
  monthlyAmount: number;
  recognizedToDateAmount: number;
  remainingAmount: number;
  monthsElapsed: number;
  amortizationMonths: number;
}

/** Net-of-VAT amount of an expense, in integer minor units. */
function netExpenseMinor(expense: ExpenseLike, currency: string): number {
  return toMinorUnits(expense.amount, currency) - toMinorUnits(expense.taxAmount ?? 0, currency);
}

/**
 * The authoritative amortization row for a scheduled prepaid expense. The
 * report reads these fields (never the gross expense doc) so it recognizes
 * exactly what the GL did.
 */
export interface ScheduleLike {
  totalMinor: number; // NET (ex-VAT) amount capitalized to the Prepaid asset
  termMonths: number;
  startYearMonth: string; // "YYYY-MM"
  currency: string;
}

/**
 * Portion of a scheduled prepaid recognized within [startDate, endDate], read
 * straight from the authoritative schedule row (net minor units, schedule's own
 * currency). This is the report's primary path; it agrees to the minor unit
 * with what amortizePrepaidExpenseForMonth posts to the GL.
 */
export function recognizedAmountInRangeFromSchedule(
  schedule: ScheduleLike,
  startDate: number,
  endDate: number
): number {
  const startIdx = yearMonthStringIndex(schedule.startYearMonth);
  const monthsElapsedAtEnd = clampMonths(yearMonthIndex(endDate) - startIdx + 1, schedule.termMonths);
  const monthsElapsedBeforeStart = clampMonths(yearMonthIndex(startDate) - startIdx, schedule.termMonths);
  const recognizedMinor =
    recognizedThroughMonthsMinor(schedule.totalMinor, schedule.termMonths, monthsElapsedAtEnd) -
    recognizedThroughMonthsMinor(schedule.totalMinor, schedule.termMonths, monthsElapsedBeforeStart);
  if (recognizedMinor <= 0) return 0;
  return fromMinorUnits(recognizedMinor, schedule.currency);
}

/** Amortization schedule (as of `asOfDate`) read from the authoritative schedule row. */
export function computeAmortizationInfoFromSchedule(
  schedule: ScheduleLike,
  asOfDate: number
): AmortizationInfo {
  const startIdx = yearMonthStringIndex(schedule.startYearMonth);
  const monthsElapsed = clampMonths(yearMonthIndex(asOfDate) - startIdx + 1, schedule.termMonths);
  const recognizedMinor = recognizedThroughMonthsMinor(schedule.totalMinor, schedule.termMonths, monthsElapsed);
  return {
    monthlyAmount: fromMinorUnits(monthAmountMinor(schedule.totalMinor, schedule.termMonths, 0), schedule.currency),
    recognizedToDateAmount: fromMinorUnits(recognizedMinor, schedule.currency),
    remainingAmount: fromMinorUnits(schedule.totalMinor - recognizedMinor, schedule.currency),
    monthsElapsed,
    amortizationMonths: schedule.termMonths,
  };
}

/**
 * Cumulative recognition a schedule is DUE to have posted through the calendar
 * month containing `asOfDate` — the "should have recognized by now" figure the
 * period-close blocker compares against `recognizedMinor` to catch a schedule
 * that has silently fallen behind (a missed cron month within the period).
 */
export function recognizedDueThroughDateMinor(schedule: ScheduleLike, asOfDate: number): number {
  const monthsElapsed = clampMonths(
    yearMonthIndex(asOfDate) - yearMonthStringIndex(schedule.startYearMonth) + 1,
    schedule.termMonths
  );
  return recognizedThroughMonthsMinor(schedule.totalMinor, schedule.termMonths, monthsElapsed);
}

/**
 * Fallback for a prepaid expense with no schedule row: derive the schedule from
 * the expense doc itself, net of VAT. Returns null if the expense isn't prepaid.
 */
export function computeAmortizationInfo(
  expense: ExpenseLike,
  asOfDate: number,
  currency: string
): AmortizationInfo | null {
  const months = expense.amortizationMonths;
  if (!expense.isPrepaid || !months || months <= 0) return null;

  const totalMinor = netExpenseMinor(expense, currency);
  const monthsElapsed = clampMonths(yearMonthIndex(asOfDate) - yearMonthIndex(expense.date) + 1, months);
  const recognizedMinor = recognizedThroughMonthsMinor(totalMinor, months, monthsElapsed);

  return {
    monthlyAmount: fromMinorUnits(monthAmountMinor(totalMinor, months, 0), currency),
    recognizedToDateAmount: fromMinorUnits(recognizedMinor, currency),
    remainingAmount: fromMinorUnits(totalMinor - recognizedMinor, currency),
    monthsElapsed,
    amortizationMonths: months,
  };
}

/**
 * Portion of an expense recognized within [startDate, endDate], net of VAT. A
 * normal (non-prepaid) expense is recognized in full on its `date`. A PREPAID
 * expense is spread evenly over its amortizationMonths, so only the months that
 * overlap the window count. This is the fallback used when a prepaid expense has
 * no schedule row — a scheduled prepaid uses recognizedAmountInRangeFromSchedule
 * instead. Net-of-VAT so the report matches the GL, which only ever books the
 * net amount to an expense (the VAT is input-tax receivable, not an expense).
 */
export function recognizedAmountInRange(
  expense: ExpenseLike,
  startDate: number,
  endDate: number,
  currency: string
): number {
  const netMinor = netExpenseMinor(expense, currency);
  const months = expense.amortizationMonths;
  if (!expense.isPrepaid || !months || months <= 0) {
    return expense.date >= startDate && expense.date <= endDate ? fromMinorUnits(netMinor, currency) : 0;
  }

  const monthsElapsedAtEnd = clampMonths(yearMonthIndex(endDate) - yearMonthIndex(expense.date) + 1, months);
  const monthsElapsedBeforeStart = clampMonths(yearMonthIndex(startDate) - yearMonthIndex(expense.date), months);
  const recognizedMinor =
    recognizedThroughMonthsMinor(netMinor, months, monthsElapsedAtEnd) -
    recognizedThroughMonthsMinor(netMinor, months, monthsElapsedBeforeStart);
  if (recognizedMinor <= 0) return 0;
  return fromMinorUnits(recognizedMinor, currency);
}
