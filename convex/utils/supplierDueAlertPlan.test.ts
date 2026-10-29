/**
 * SCRUM-869 S8 - the alert schedule for a supplier obligation (pure).
 *
 * Owner ruling SCRUM-869#c23883 (the coordinator's Jira record of a chat ruling, not the owner's
 * own text): alert 3 days before the due date, on the due date, at 7 days overdue, then weekly.
 * Days are Amman calendar days (see supplierDueDates.ts); `daysOverdue` is negative before the due
 * date. An alert fires on the exact day, so a day the sweep did not run is a day without that alert.
 */
import { describe, expect, test } from "vitest";
import { alertStepFor } from "./supplierDueAlertPlan";

describe("SCRUM-869 S8 - alert schedule", () => {
  test("3 days before the due date is the first step", () => {
    expect(alertStepFor(-3)).toEqual({ step: "T_MINUS_3", occurrence: 0 });
  });

  test("days between the steps never alert", () => {
    for (const d of [-30, -4, -2, -1, 1, 2, 3, 4, 5, 6, 8, 9, 13, 15, 20, 22]) {
      expect(alertStepFor(d), `day ${d}`).toBeNull();
    }
  });

  test("the due date itself alerts", () => {
    expect(alertStepFor(0)).toEqual({ step: "DUE_DAY", occurrence: 0 });
  });

  test("7 days overdue alerts once as OVERDUE_7", () => {
    expect(alertStepFor(7)).toEqual({ step: "OVERDUE_7", occurrence: 0 });
  });

  test("after that it repeats weekly with a counted occurrence", () => {
    expect(alertStepFor(14)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 1 });
    expect(alertStepFor(21)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 2 });
    expect(alertStepFor(98)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 13 });
    expect(alertStepFor(99)).toBeNull();
  });

  test("a missing or malformed day count never alerts", () => {
    expect(alertStepFor(null)).toBeNull();
    expect(alertStepFor(Number.NaN)).toBeNull();
    expect(alertStepFor(Number.POSITIVE_INFINITY)).toBeNull();
    expect(alertStepFor(7.5)).toBeNull();
  });
});
