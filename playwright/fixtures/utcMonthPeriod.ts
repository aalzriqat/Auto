/**
 * The accounting period for the UTC calendar month containing `now`, in the
 * shapes the Create Accounting Period dialog takes.
 *
 * UTC, not local: the period's bounds are stored as UTC day boundaries
 * (components/accounting/setup/types.ts) and the server decides "today" in UTC.
 * A month, not the dialog's full-year default: a shared test org can already
 * hold another month's period (accounting.spec.ts creates 2026-08), and a
 * full-year period would overlap it and be refused.
 */
export type UtcMonthPeriod = {
  fiscalYear: string;
  periodNumber: string;
  startDate: string;
  endDate: string;
};

export function utcMonthPeriod(now: Date): UtcMonthPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const mm = String(month + 1).padStart(2, "0");
  return {
    fiscalYear: String(year),
    periodNumber: String(month + 1),
    startDate: `${year}-${mm}-01`,
    endDate: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}
