/**
 * Straight-line recognition for PREPAID expenses (e.g. 6 months of rent paid
 * in one lump sum). Mirrors the whole-month bucketing convex/fixedAssets.ts
 * uses for depreciation: each expense is spread evenly across
 * amortizationMonths calendar months starting with the month of `date`,
 * rather than prorating by exact days.
 */

export const PREPAID_LOOKBACK_MS = 36 * 31 * 24 * 60 * 60 * 1000; // 36-month cap on how far back a still-amortizing expense can be found

function yearMonthIndex(timestamp: number): number {
  const d = new Date(timestamp);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
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

/** Returns the amortization schedule as of `asOfDate`, or null if the expense isn't prepaid. */
export function computeAmortizationInfo(
  expense: ExpenseLike,
  asOfDate: number
): AmortizationInfo | null {
  const months = expense.amortizationMonths;
  if (!expense.isPrepaid || !months || months <= 0) return null;

  const monthlyAmount = expense.amount / months;
  const monthsElapsed = Math.min(
    Math.max(yearMonthIndex(asOfDate) - yearMonthIndex(expense.date) + 1, 0),
    months
  );
  const recognizedToDateAmount = monthsElapsed >= months ? expense.amount : monthsElapsed * monthlyAmount;

  return {
    monthlyAmount,
    recognizedToDateAmount,
    remainingAmount: expense.amount - recognizedToDateAmount,
    monthsElapsed,
    amortizationMonths: months,
  };
}

/**
 * Portion of an expense recognized within [startDate, endDate]. A normal
 * (non-prepaid) expense is recognized in full on its `date`. A PREPAID
 * expense is spread evenly over its amortizationMonths, so only the months
 * that overlap the window count — this is what lets a 6-month rent payment
 * show up as 1/6th per monthly report instead of a single lump sum.
 */
export function recognizedAmountInRange(
  expense: ExpenseLike,
  startDate: number,
  endDate: number
): number {
  const months = expense.amortizationMonths;
  if (!expense.isPrepaid || !months || months <= 0) {
    return expense.date >= startDate && expense.date <= endDate ? expense.amount : 0;
  }

  const monthlyAmount = expense.amount / months;
  const monthsElapsedAtEnd = Math.min(
    Math.max(yearMonthIndex(endDate) - yearMonthIndex(expense.date) + 1, 0),
    months
  );
  const monthsElapsedBeforeStart = Math.min(
    Math.max(yearMonthIndex(startDate) - yearMonthIndex(expense.date), 0),
    months
  );
  const recognizedMonths = Math.max(monthsElapsedAtEnd - monthsElapsedBeforeStart, 0);
  if (recognizedMonths <= 0) return 0;

  // The final amortized month absorbs any rounding remainder so the total
  // recognized across all months always equals the original amount exactly.
  if (monthsElapsedAtEnd >= months && monthsElapsedBeforeStart < months) {
    const priorRecognized = monthsElapsedBeforeStart * monthlyAmount;
    return expense.amount - priorRecognized;
  }
  return recognizedMonths * monthlyAmount;
}
