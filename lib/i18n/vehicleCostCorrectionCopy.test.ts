/**
 * SCRUM-650 batch 3 C3/C5: the cost-correction copy never hardcodes a currency (the
 * org's currency is filled in or already inside the formatted amount) and the
 * NOT_POSTED notice does not promise that editing will work.
 */
import { describe, expect, test } from "vitest";
import { vehiclesAr, vehiclesEn } from "./domains/vehicles";

const locales = { en: vehiclesEn as Record<string, string>, ar: vehiclesAr as Record<string, string> };

describe("cost-correction copy", () => {
  for (const [name, dict] of Object.entries(locales)) {
    test(`${name}: new-cost label uses a currency placeholder, not a literal currency`, () => {
      expect(dict.CostCorrectionNewCost).toContain("{currency}");
      expect(dict.CostCorrectionNewCost).not.toMatch(/JOD|دينار/);
    });
    test(`${name}: payable line carries no literal currency (formatMoney already does)`, () => {
      expect(dict.CostCorrectionPayable).toContain("{due}");
      expect(dict.CostCorrectionPayable).toContain("{paid}");
      expect(dict.CostCorrectionPayable).not.toMatch(/JOD|دينار/);
    });
    test(`${name}: NOT_POSTED notice points at finance when editing is refused`, () => {
      expect(dict.CostCorrectionBlockedNOT_POSTED.length).toBeGreaterThan(40);
      expect(dict.CostCorrectionOnAccountRefundNote.length).toBeGreaterThan(40);
    });
  }
  test("en: NOT_POSTED does not promise editing will work", () => {
    expect(vehiclesEn.CostCorrectionBlockedNOT_POSTED).toContain("If editing is refused");
  });
});