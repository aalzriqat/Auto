import { describe, expect, it } from "vitest";
import {
  buildFinancedSalePostingPlanV2,
  planVersionOf,
  type FinancedSalePlanV2Input,
} from "./financedSalePostingPlan";

// SCRUM-435 (owner ruling, Option A, 2026-09-28): the finance company transfers
// the FULL approved amount G; the dealership forwards the deposit H and its own
// contribution C to the company. Worked example: G=12,500 H=200 C=1,375.
const base: FinancedSalePlanV2Input = {
  currency: "JOD",
  legalInvoiceConsiderationMinor: 13_000,
  legalInvoiceIssuedTo: "FINANCE_COMPANY",
  financierIsConfiguredExternal: true,
  approvedAmountMinor: 12_500,
  hasSettlementComponents: false,
  customerReceivableMinor: 500,
  depositLiabilityAppliedMinor: 200,
  dealerContributionMinor: 1_375,
  customerFirstPaymentMinor: 500,
};

describe("v2 financed-sale plan (finance company forward)", () => {
  it("worked example: receivable is the full approved amount, forward is H + C", () => {
    const r = buildFinancedSalePostingPlanV2(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.version).toBe(2);
    expect(r.plan.financeCompanyReceivableMinor).toBe(12_500);
    expect(r.plan.forwardDepositMinor).toBe(200);
    expect(r.plan.forwardContributionMinor).toBe(1_375);
    expect(r.plan.forwardDueMinor).toBe(1_575);
    expect(r.plan.financeCompanyPayableMinor).toBe(0);
    expect(r.plan.fingerprint.startsWith("v2;")).toBe(true);
    // The journal balances: debits G + H + C + customer == credits L + (H + C).
    const debits = 12_500 + 200 + 1_375 + r.plan.customerReceivableMinor;
    const credits = r.plan.legalInvoiceConsiderationMinor + r.plan.forwardDueMinor;
    expect(debits).toBe(credits);
  });

  it("zero cases: no deposit gives forward = C; no contribution gives forward = H; neither gives none", () => {
    const noH = buildFinancedSalePostingPlanV2({ ...base, depositLiabilityAppliedMinor: 0 });
    expect(noH.ok && noH.plan.forwardDueMinor).toBe(1_375);
    const noC = buildFinancedSalePostingPlanV2({ ...base, dealerContributionMinor: 0, legalInvoiceConsiderationMinor: 13_000 - 0 });
    expect(noC.ok && noC.plan.forwardDueMinor).toBe(200);
    const none = buildFinancedSalePostingPlanV2({
      ...base,
      depositLiabilityAppliedMinor: 0,
      dealerContributionMinor: 0,
    });
    expect(none.ok && none.plan.forwardDueMinor).toBe(0);
  });

  it("refuses settlement deductions under v2 with a guided message", () => {
    const r = buildFinancedSalePostingPlanV2({ ...base, hasSettlementComponents: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("SETTLEMENT_DEDUCTIONS_NOT_ALLOWED");
  });

  it("refuses a deposit larger than the first payment and an invalid contribution", () => {
    const d = buildFinancedSalePostingPlanV2({ ...base, depositLiabilityAppliedMinor: 600 });
    expect(!d.ok && d.refusal.code).toBe("DEPOSIT_EXCEEDS_FIRST_PAYMENT");
    const c = buildFinancedSalePostingPlanV2({ ...base, dealerContributionMinor: -1 });
    expect(!c.ok && c.refusal.code).toBe("CONTRIBUTION_INVALID");
    const f = buildFinancedSalePostingPlanV2({ ...base, dealerContributionMinor: 1.5 });
    expect(!f.ok && f.refusal.code).toBe("CONTRIBUTION_INVALID");
  });

  it("refuses an unbalanced invoice and never echoes H or C in the message", () => {
    const r = buildFinancedSalePostingPlanV2({ ...base, legalInvoiceConsiderationMinor: 20_000 });
    expect(!r.ok && r.refusal.code).toBe("PLAN_UNBALANCED");
    if (!r.ok) {
      expect(r.refusal.message).not.toContain("1375");
      expect(r.refusal.message).not.toContain("1,375");
    }
  });

  it("planVersionOf: field, else fingerprint prefix, else pre-plan", () => {
    expect(planVersionOf({ financedSalePlanVersion: 2 })).toBe(2);
    expect(planVersionOf({ financedSaleRecognitionFingerprint: "v2;JOD" })).toBe(2);
    expect(planVersionOf({ financedSaleRecognitionFingerprint: "v1;JOD" })).toBe(1);
    expect(planVersionOf({})).toBe(0);
  });
});
