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

/**
 * The periods that must be open so a server timestamp taken anywhere in
 * [now, now + windowMs] falls in one: the current UTC month, plus the next when
 * the window reaches it. The handover is stamped by the server's clock at the
 * moment it is registered, so a period opened for "today" is not enough when
 * that moment can land after midnight at a month end.
 */
export function utcMonthPeriodsCovering(now: Date, windowMs: number): UtcMonthPeriod[] {
  const current = utcMonthPeriod(now);
  const latest = utcMonthPeriod(new Date(now.getTime() + windowMs));
  return latest.startDate === current.startDate ? [current] : [current, latest];
}

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
