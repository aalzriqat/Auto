import { describe, expect, test } from "vitest";
import { commonAr, commonEn } from "./domains/common";

/**
 * SCRUM-265 review round 1 (PR #741): a capped read stops at the EARLIEST rows, and the collections
 * totals net refunds (OUT / REFUND rows are negative). The hidden rows can therefore be refunds, so
 * the shown net is not a lower bound. Only figures that cannot be negative (receivables, cheques,
 * aging) may say "at least" / "lower than the true total".
 */
const en = commonEn as Record<string, string>;
const ar = commonAr as Record<string, string>;

describe("Collections incomplete wording", () => {
  test("net figures have their own EN and AR strings", () => {
    for (const key of ["CollectionReportIncompleteNet", "CollectionMetricIncompleteNet"]) {
      expect(en[key], `${key} EN`).toBeTruthy();
      expect(ar[key], `${key} AR`).toBeTruthy();
    }
  });

  test("net wording does not claim a lower bound in English", () => {
    for (const key of ["CollectionReportIncompleteNet", "CollectionMetricIncompleteNet"]) {
      expect(en[key]).not.toMatch(/at least|lower than|no less than|minimum/i);
    }
    expect(en.CollectionReportIncompleteNet).toMatch(/higher or lower/i);
  });

  test("net wording does not claim a lower bound in Arabic", () => {
    for (const key of ["CollectionReportIncompleteNet", "CollectionMetricIncompleteNet"]) {
      expect(ar[key]).not.toContain("لا يقل");
      expect(ar[key]).not.toContain("أقل من");
    }
  });

  test("SCRUM-264: a payment left out because its day cannot be placed has EN and AR strings and claims no bound", () => {
    const keys = ["CollectionReportDateUncertain", "CollectionMetricDateUncertain", "CashierReconciliationDateUncertain"];
    for (const key of keys) {
      expect(en[key], `${key} EN`).toBeTruthy();
      expect(ar[key], `${key} AR`).toBeTruthy();
      expect(en[key]).not.toMatch(/at least|lower than|no less than|minimum/i);
      expect(ar[key]).not.toContain("لا يقل");
      expect(ar[key]).not.toContain("أقل من");
    }
    expect(en.CollectionReportDateUncertain).toMatch(/higher or lower/i);
    expect(en.CollectionMetricDateUncertain).toMatch(/higher or lower/i);
  });

  test("non-negative figures keep the lower-bound wording", () => {
    expect(en.CollectionMetricIncomplete).toMatch(/at least/i);
    expect(en.CollectionReportIncomplete).toMatch(/lower than/i);
  });

  test("the cheque read caps every status and filters afterwards, so its hidden rows may not count: the wording says may be lower", () => {
    expect(en.CollectionReportIncomplete).toMatch(/may be lower than/i);
    expect(ar.CollectionReportIncomplete).toMatch(/قد تكون هذه الأرقام أقل من/);
  });
});
