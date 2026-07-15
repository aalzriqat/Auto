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
 * `startYearMonth`, `termMonths`). The monthly GL amortization cron
 * (prepaidExpenses.amortizePrepaidExpenseForMonth) advances it and posts a
 * dated PREPAID_EXPENSE_AMORTIZED / PREPAID_EXPENSE_WRITTEN_OFF event per
 * recognition. The operational P&L report (reports.ts) does NOT recompute
 * this curve — a correction (prepaidExpenses.correctSchedule) can change the
 * schedule's totalMinor/termMonths after some months already posted, and a
 * from-month-0 recompute using the CURRENT total/term would silently restate
 * those already-posted months. Instead the report sums the posted (and
 * still-queued) recognition EVENTS themselves, bucketed by month — see
 * ./prepaidRecognitionEvents.ts — which can never diverge from the GL because
 * it reads the GL's own record of what happened, not a re-derivation of it.
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

/** "YYYY-MM" for an absolute month index (year*12 + 0-based month) — inverse of yearMonthStringIndex. */
export function yearMonthFromIndex(idx: number): string {
  const year = Math.floor(idx / 12);
  const month = idx % 12;
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * A timestamp that falls inside calendar month `idx` (its last millisecond),
 * clamped to `now` so the in-progress current month posts as-of-now rather
 * than a future date. Shared by the cron and the accountant-triggered manual
 * run so a caught-up schedule dates each recognition to its own month either way.
 */
export function occurredAtForMonthIndex(idx: number, now: number): number {
  const year = Math.floor(idx / 12);
  const month = idx % 12;
  const endOfMonth = Date.UTC(year, month + 1, 0, 23, 59, 59, 999);
  return Math.min(endOfMonth, now);
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
 * A schedule's amortization info derived from its ACTUAL progress
 * (recognizedMinor/monthsRecognized), not a date-driven curve recompute — see
 * the file header for why a from-month-0 recompute is unsafe once a
 * correction has changed totalMinor/termMonths. `monthlyAmount` is the
 * remaining-balance/remaining-months share the *next* recognition would post
 * (same math amortizeScheduleForMonth uses), so it always reflects the
 * schedule's current state even after a correction.
 */
export interface ScheduleProgressLike extends ScheduleLike {
  recognizedMinor: number;
  monthsRecognized?: number;
}

export function amortizationInfoFromScheduleProgress(schedule: ScheduleProgressLike): AmortizationInfo {
  const monthsRecognized = clampMonths(schedule.monthsRecognized ?? 0, schedule.termMonths);
  const remainingMonths = schedule.termMonths - monthsRecognized;
  const remainingMinor = Math.max(schedule.totalMinor - schedule.recognizedMinor, 0);
  let monthlyMinor: number;
  if (remainingMonths <= 0) {
    monthlyMinor = 0;
  } else if (remainingMonths <= 1) {
    monthlyMinor = remainingMinor;
  } else {
    monthlyMinor = Math.floor(remainingMinor / remainingMonths);
  }
  return {
    monthlyAmount: fromMinorUnits(monthlyMinor, schedule.currency),
    recognizedToDateAmount: fromMinorUnits(schedule.recognizedMinor, schedule.currency),
    remainingAmount: fromMinorUnits(remainingMinor, schedule.currency),
    monthsElapsed: monthsRecognized,
    amortizationMonths: schedule.termMonths,
  };
}

/** A schedule's current recognition anchor — how far it's actually gotten, as of right now. */
export interface ScheduleProgress {
  recognizedMinor: number;
  monthsRecognized: number;
}

/**
 * Cumulative recognition a schedule is DUE to have posted through the calendar
 * month containing `asOfDate` — the "should have recognized by now" figure the
 * period-close blocker compares against `recognizedMinor` to catch a schedule
 * that has silently fallen behind (a missed cron month within the period).
 *
 * Anchored at the schedule's CURRENT progress (recognizedMinor/monthsRecognized)
 * and projected forward month by month using the same remaining-balance /
 * remaining-months share amortizeScheduleForMonth actually posts — not a
 * whole-curve recompute from month 0. A pure recompute would silently
 * misstate this the moment correctSchedule changes totalMinor/termMonths: it
 * would compare against what the schedule "should" have recognized under the
 * NEW total from the very start, which the schedule's already-posted months
 * never followed (they posted at the OLD rate) — producing a false shortfall
 * that blocks a period close even though the schedule is fully caught up.
 */
export function recognizedDueThroughDateMinor(
  schedule: ScheduleLike,
  progress: ScheduleProgress,
  asOfDate: number
): number {
  const monthsElapsedTarget = clampMonths(
    yearMonthIndex(asOfDate) - yearMonthStringIndex(schedule.startYearMonth) + 1,
    schedule.termMonths
  );
  const alreadyRecognizedMonths = clampMonths(progress.monthsRecognized, schedule.termMonths);
  if (monthsElapsedTarget <= alreadyRecognizedMonths) return progress.recognizedMinor;

  let dueMinor = progress.recognizedMinor;
  let remainingMinor = schedule.totalMinor - progress.recognizedMinor;
  let remainingMonths = schedule.termMonths - alreadyRecognizedMonths;
  for (let m = alreadyRecognizedMonths + 1; m <= monthsElapsedTarget; m++) {
    const monthShare = remainingMonths <= 1 ? remainingMinor : Math.floor(remainingMinor / remainingMonths);
    dueMinor += monthShare;
    remainingMinor -= monthShare;
    remainingMonths -= 1;
  }
  return dueMinor;
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
