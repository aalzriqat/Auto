/**
 * SCRUM-869 S8 - which alert, if any, an obligation earns today.
 *
 * Owner ruling SCRUM-869#c23883 (the coordinator's Jira record of a chat ruling): alert 3 days
 * before the due date, on the due date, at 7 days overdue, then weekly. Pure: callers pass the
 * Amman calendar day count from `daysOverdue` (negative before the due date).
 *
 * The match is EXACT-DAY. A day on which the sweep did not run is a day without that alert; the
 * next scheduled step is not pulled forward and the missed one is not replayed.
 */

export type AlertStep = "T_MINUS_3" | "DUE_DAY" | "OVERDUE_7" | "OVERDUE_WEEKLY";

export interface AlertPlan {
  step: AlertStep;
  /** 0 for the one-off steps; for OVERDUE_WEEKLY the number of weeks past the 7-day alert. */
  occurrence: number;
}

const LEAD_DAYS = 3;
const FIRST_OVERDUE_DAY = 7;
const REPEAT_EVERY_DAYS = 7;

export function alertStepFor(daysOverdue: number | null): AlertPlan | null {
  if (daysOverdue === null || !Number.isInteger(daysOverdue)) return null;
  if (daysOverdue === -LEAD_DAYS) return { step: "T_MINUS_3", occurrence: 0 };
  if (daysOverdue === 0) return { step: "DUE_DAY", occurrence: 0 };
  if (daysOverdue === FIRST_OVERDUE_DAY) return { step: "OVERDUE_7", occurrence: 0 };
  const sinceFirst = daysOverdue - FIRST_OVERDUE_DAY;
  if (sinceFirst > 0 && sinceFirst % REPEAT_EVERY_DAYS === 0) {
    return { step: "OVERDUE_WEEKLY", occurrence: sinceFirst / REPEAT_EVERY_DAYS };
  }
  return null;
}

/** Steps on or before the due date use the "due" wording; later steps use the "overdue" wording. */
export function alertTypeFor(step: AlertStep): "accounting.supplierObligationDue" | "accounting.supplierObligationOverdue" {
  return step === "T_MINUS_3" || step === "DUE_DAY" ? "accounting.supplierObligationDue" : "accounting.supplierObligationOverdue";
}
