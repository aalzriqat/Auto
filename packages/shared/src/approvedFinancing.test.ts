import { describe, expect, it } from "vitest";
import { computeFundingComposition } from "./financingEconomics";
import {
  deriveApprovedFinancingFigures,
  validateApprovedFinancingAmount,
} from "./approvedFinancing";

// JOD x 1000 minor units. D-000006 (SCRUM-993): quotation 11,000, approved
// purchase value 10,500, finance company approved 9,450, customer pays 1,240.
const D6 = {
  approvedPurchaseAmountMinor: 10_500_000,
  appliedLtvPercent: 85,
  customerFirstPaymentMinor: 1_240_000,
  approvedFinancingMinor: 9_450_000,
};

describe("computeFundingComposition with an entered approved financing amount", () => {
  it("D-000006: funded is the entered 9,450, not 85% of 10,500", () => {
    const c = computeFundingComposition(D6);
    expect(c.financeCompanyFundedPortionMinor).toBe(9_450_000);
    expect(c.customerFirstPaymentAppliedMinor).toBe(1_240_000);
    expect(c.dealerContributionMinor).toBe(0);
    expect(c.excessMinor).toBe(190_000);
    expect(c.unfinancedPortionMinor).toBe(1_050_000);
  });

  it("12,000 case: A 12,000, F 10,800 (90%), first payment 2,000 gives excess 800", () => {
    const c = computeFundingComposition({
      approvedPurchaseAmountMinor: 12_000_000,
      appliedLtvPercent: 90,
      customerFirstPaymentMinor: 2_000_000,
      approvedFinancingMinor: 10_800_000,
    });
    expect(c.financeCompanyFundedPortionMinor).toBe(10_800_000);
    expect(c.unfinancedPortionMinor).toBe(1_200_000);
    expect(c.dealerContributionMinor).toBe(0);
    expect(c.excessMinor).toBe(800_000);
  });

  it("a real gap: contribution is what neither the finance company nor the customer covers, no excess", () => {
    const c = computeFundingComposition({
      ...D6,
      customerFirstPaymentMinor: 500_000,
    });
    expect(c.dealerContributionMinor).toBe(550_000);
    expect(c.excessMinor).toBe(0);
    expect(
      c.financeCompanyFundedPortionMinor +
        c.customerFirstPaymentAppliedMinor +
        c.dealerContributionMinor -
        c.excessMinor
    ).toBe(D6.approvedPurchaseAmountMinor);
  });

  it("without an entered amount the legacy percentage basis is unchanged and excess is 0", () => {
    const { approvedFinancingMinor: _omit, ...legacy } = D6;
    const c = computeFundingComposition(legacy);
    expect(c.financeCompanyFundedPortionMinor).toBe(8_925_000);
    expect(c.dealerContributionMinor).toBe(335_000);
    expect(c.excessMinor).toBe(0);
  });
});

describe("deriveApprovedFinancingFigures", () => {
  it("D-000006: percentages derived, contribution from the quotation 310, dealer receives 10,690", () => {
    const f = deriveApprovedFinancingFigures({
      approvedFinancingMinor: 9_450_000,
      approvedPurchaseAmountMinor: 10_500_000,
      quotationMinor: 11_000_000,
      customerPaysMinor: 1_240_000,
    });
    expect(f.percentOfApprovedValue).toBeCloseTo(90, 6);
    expect(f.percentOfQuotation).toBeCloseTo(85.909091, 5);
    expect(f.contributionFromQuotationMinor).toBe(310_000);
    expect(f.excessMinor).toBe(190_000);
    expect(f.dealerReceivesMinor).toBe(10_690_000);
  });

  it("contribution from the quotation never goes negative", () => {
    const f = deriveApprovedFinancingFigures({
      approvedFinancingMinor: 9_450_000,
      approvedPurchaseAmountMinor: 10_500_000,
      quotationMinor: 10_000_000,
      customerPaysMinor: 1_240_000,
    });
    expect(f.contributionFromQuotationMinor).toBe(0);
  });
});

describe("validateApprovedFinancingAmount", () => {
  const ok = (v: unknown) =>
    validateApprovedFinancingAmount(v, 10_500_000);
  it("accepts a positive integer up to the approved value", () => {
    expect(ok(9_450_000)).toEqual({ ok: true });
    expect(ok(10_500_000)).toEqual({ ok: true });
  });
  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -1],
    ["above the approved value", 10_500_001],
    ["fractional", 100.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses %s", (_label, value) => {
    expect(ok(value).ok).toBe(false);
  });
});
