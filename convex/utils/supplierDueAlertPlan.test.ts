/**
 * SCRUM-869 S8 - the alert schedule for a supplier obligation (pure).
 *
 * Owner ruling SCRUM-869#c23883 (the coordinator's Jira record of a chat ruling, not the owner's
 * own text): alert 3 days before the due date, on the due date, at 7 days overdue, then weekly.
 * Days are Amman calendar days (see supplierDueDates.ts); `daysOverdue` is negative before the due
 * date. Coordinator ruling 2026-10-29 (missed-day gap): catch-up semantics - each run returns the latest step whose day has been reached; the caller sends it only if its idempotency record does not exist, so a missed day is made up once and never as a burst.
 */
import { describe, expect, test } from "vitest";
import { alertStepFor } from "./supplierDueAlertPlan";

describe("SCRUM-869 S8 - alert schedule (catch-up)", () => {
  test("before the first step nothing is due", () => {
    for (const d of [-30, -4]) expect(alertStepFor(d), `day ${d}`).toBeNull();
  });

  test("from 3 days before the due date, the first step is the latest one reached", () => {
    for (const d of [-3, -2, -1]) expect(alertStepFor(d), `day ${d}`).toEqual({ step: "T_MINUS_3", occurrence: 0 });
  });

  test("from the due date, the due step is the latest one reached until day 7", () => {
    for (const d of [0, 1, 6]) expect(alertStepFor(d), `day ${d}`).toEqual({ step: "DUE_DAY", occurrence: 0 });
  });

  test("from 7 days overdue, OVERDUE_7 is the latest step until day 14", () => {
    for (const d of [7, 8, 13]) expect(alertStepFor(d), `day ${d}`).toEqual({ step: "OVERDUE_7", occurrence: 0 });
  });

  test("from day 14 the weekly occurrence counted is the latest one reached", () => {
    expect(alertStepFor(14)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 1 });
    expect(alertStepFor(20)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 1 });
    expect(alertStepFor(21)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 2 });
    expect(alertStepFor(98)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 13 });
    expect(alertStepFor(104)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 13 });
    expect(alertStepFor(105)).toEqual({ step: "OVERDUE_WEEKLY", occurrence: 14 });
  });

  test("a missing or malformed day count never alerts", () => {
    expect(alertStepFor(null)).toBeNull();
    expect(alertStepFor(Number.NaN)).toBeNull();
    expect(alertStepFor(Number.POSITIVE_INFINITY)).toBeNull();
    expect(alertStepFor(7.5)).toBeNull();
  });
});