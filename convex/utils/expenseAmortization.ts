/**
 * Straight-line recognition for PREPAID expenses (e.g. 6 months of rent paid
 * in one lump sum). Mirrors the whole-month bucketing convex/fixedAssets.ts
 * uses for depreciation: each expense is spread evenly across
 * amortizationMonths calendar months starting with the month of `date`,
 * rather than prorating by exact days.
 *
 * There is ONE authoritative schedule — `recognizedThroughMonthsMinor` below,
 * computed entirely in integer minor units — and BOTH consumers derive from
 * it: the monthly GL amortization cron (prepaidExpenses.amortizePrepaidExpenseForMonth)
 * and the operational P&L report (reports.ts, via recognizedAmountInRange /
 * computeAmortizationInfo). Because the report converts the expense's major-unit
 * amount to minor units the same way the GL does (toMinorUnits) and then applies
 * the identical integer schedule, the ledger-backed P&L and the operational P&L
 * can never round differently on the same prepaid expense.
 */

import { toMinorUnits, fromMinorUnits } from "./money";

export const PREPAID_LOOKBACK_MS = 36 * 31 * 24 * 60 * 60 * 1000; // 36-month cap on how far back a still-amortizing expense can be found

function yearMonthIndex(timestamp: number): number {
  const d = new Date(timestamp);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function clampMonths(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

/**
 * THE authoritative straight-line schedule, in integer minor units.
 * `monthsElapsed` is how many whole recognition months have completed
 * (0..termMonths). Each of the first (termMonths − 1) months recognizes a
 * ceil'd flat share; the final (termMonths-th) month absorbs whatever remains,
 * so the cumulative total after all termMonths is exactly `totalMinor` with no
 * rounding drift. Using min(..) also guards the degenerate case where the ceil'd
 * flat share would overshoot before the final month (tiny amount / long term).
 */
export function recognizedThroughMonthsMinor(
  totalMinor: number,
  termMonths: number,
  monthsElapsed: number
): number {
  if (termMonths <= 0 || monthsElapsed <= 0) return 0;
  if (monthsElapsed >= termMonths) return totalMinor;
  const flatMonthly = Math.ceil(totalMinor / termMonths);
  return Math.min(monthsElapsed * flatMonthly, totalMinor);
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
}

export interface AmortizationInfo {
  monthlyAmount: number;
  recognizedToDateAmount: number;
  remainingAmount: number;
  monthsElapsed: number;
  amortizationMonths: number;
}

/**
 * Returns the amortization schedule as of `asOfDate`, or null if the expense
 * isn't prepaid. `currency` is required so the schedule is computed on the exact
 * same integer minor-unit basis as the GL.
 */
export function computeAmortizationInfo(
  expense: ExpenseLike,
  asOfDate: number,
  currency: string
): AmortizationInfo | null {
  const months = expense.amortizationMonths;
  if (!expense.isPrepaid || !months || months <= 0) return null;

  const totalMinor = toMinorUnits(expense.amount, currency);
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
 * Portion of an expense recognized within [startDate, endDate]. A normal
 * (non-prepaid) expense is recognized in full on its `date`. A PREPAID
 * expense is spread evenly over its amortizationMonths, so only the months
 * that overlap the window count — this is what lets a 6-month rent payment
 * show up as 1/6th per monthly report instead of a single lump sum. Computed
 * from the same integer schedule the GL posts (see file header).
 */
export function recognizedAmountInRange(
  expense: ExpenseLike,
  startDate: number,
  endDate: number,
  currency: string
): number {
  const months = expense.amortizationMonths;
  if (!expense.isPrepaid || !months || months <= 0) {
    return expense.date >= startDate && expense.date <= endDate ? expense.amount : 0;
  }

  const totalMinor = toMinorUnits(expense.amount, currency);
  const monthsElapsedAtEnd = clampMonths(yearMonthIndex(endDate) - yearMonthIndex(expense.date) + 1, months);
  const monthsElapsedBeforeStart = clampMonths(yearMonthIndex(startDate) - yearMonthIndex(expense.date), months);
  const recognizedMinor =
    recognizedThroughMonthsMinor(totalMinor, months, monthsElapsedAtEnd) -
    recognizedThroughMonthsMinor(totalMinor, months, monthsElapsedBeforeStart);
  if (recognizedMinor <= 0) return 0;
  return fromMinorUnits(recognizedMinor, currency);
}
