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

  test("non-negative figures keep the lower-bound wording", () => {
    expect(en.CollectionMetricIncomplete).toMatch(/at least/i);
    expect(en.CollectionReportIncomplete).toMatch(/lower than/i);
  });
});
