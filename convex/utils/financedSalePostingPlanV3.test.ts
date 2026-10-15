import { describe, expect, it } from "vitest";
import {
  buildFinancedSalePostingPlanV3,
  checkLegalInvoiceEvidence,
  isForwardPlanVersion,
  planVersionOf,
  type FinancedSalePlanV3Input,
  type LegalInvoiceEvidenceInput,
} from "./financedSalePostingPlan";

// SCRUM-411 / SCRUM-407 c21031 (owner): the finance company transfers the FULL
// approved amount A; the showroom contribution D is a separate outlay and
// contra-revenue; the customer's gap R is owed to the showroom and is revenue;
// the deposit H is forwarded to the company and is never extra consideration.
//
// The expected figures below are worked BY HAND from that ruling, not read back
// from the builder:
//   owned, no gap:    A 12,500, D 1,375          -> K 12,500, net revenue 11,125
//   owned, with gap:  A 11,500, D 1,225, R 400   -> K 11,900, net revenue 10,675
//   deposit:          H 500 changes the forward (H + D) but never K.
const base: FinancedSalePlanV3Input = {
  currency: "JOD",
  approvedAmountMinor: 12_500,
  hasSettlementComponents: false,
  customerReceivableMinor: 0,
  depositLiabilityAppliedMinor: 0,
  dealerContributionMinor: 1_375,
  customerFirstPaymentMinor: undefined,
};

describe("v3 financed-sale plan (server-derived consideration)", () => {
  it("owned deal, no gap: consideration is the approved amount and net revenue is 11,125", () => {
    const r = buildFinancedSalePostingPlanV3(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.version).toBe(3);
    expect(r.plan.considerationMinor).toBe(12_500);
    expect(r.plan.considerationMinor - r.plan.forwardContributionMinor).toBe(11_125);
    expect(r.plan.financeCompanyReceivableMinor).toBe(12_500);
    expect(r.plan.forwardDueMinor).toBe(1_375);
    // No customer payment to the company: the commission contribution is D, and the
    // fingerprint carries no credit part (byte-identical to plans stored before SCRUM-766).
    expect(r.plan.commissionContributionMinor).toBe(1_375);
    expect(r.plan.fingerprint).toBe("v3;JOD;K12500;G12500;F1375;D0;C1375;R0");
  });

  it("a customer payment to the finance company is already out of D: forward is the reduced D, the commission contribution is D before it (SCRUM-766 PR-B)", () => {
    // A 11,500, no gap; D 1,225 - 400 paid by the customer = 825 stored.
    const r = buildFinancedSalePostingPlanV3({
      ...base,
      approvedAmountMinor: 11_500,
      dealerContributionMinor: 825,
      customerPaymentToFinanceCompanyMinor: 400,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.forwardContributionMinor).toBe(825);
    expect(r.plan.forwardDueMinor).toBe(825);
    expect(r.plan.commissionContributionMinor).toBe(1_225);
    expect(r.plan.fingerprint).toBe("v3;JOD;K11500;G11500;F825;D0;C825;R0;P400");
  });

  it.each([-1, 0.5, Number.NaN])("refuses an unusable customer payment to the finance company (%s)", (bad) => {
    const r = buildFinancedSalePostingPlanV3({ ...base, customerPaymentToFinanceCompanyMinor: bad });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("CONTRIBUTION_INVALID");
  });

  it("owned deal with a customer gap: the gap is revenue, the contribution contra-revenue (10,675)", () => {
    const r = buildFinancedSalePostingPlanV3({
      ...base,
      approvedAmountMinor: 11_500,
      dealerContributionMinor: 1_225,
      customerReceivableMinor: 400,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.considerationMinor).toBe(11_900);
    expect(r.plan.considerationMinor - r.plan.forwardContributionMinor).toBe(10_675);
    // The company is still owed nothing by the showroom beyond the contribution.
    expect(r.plan.forwardDueMinor).toBe(1_225);
  });

  it("the deposit is forwarded to the company and never changes the consideration", () => {
    const withDeposit = buildFinancedSalePostingPlanV3({
      ...base,
      depositLiabilityAppliedMinor: 500,
      customerFirstPaymentMinor: 500,
    });
    const without = buildFinancedSalePostingPlanV3(base);
    expect(withDeposit.ok && without.ok).toBe(true);
    if (!withDeposit.ok || !without.ok) return;
    expect(withDeposit.plan.considerationMinor).toBe(without.plan.considerationMinor);
    expect(withDeposit.plan.forwardDepositMinor).toBe(500);
    expect(withDeposit.plan.forwardDueMinor).toBe(500 + 1_375);
  });

  it("the journal it implies balances for every combination of gap, deposit and contribution", () => {
    for (const r of [0, 400]) {
      for (const h of [0, 500]) {
        for (const d of [0, 1_375]) {
          const built = buildFinancedSalePostingPlanV3({
            ...base,
            customerReceivableMinor: r,
            depositLiabilityAppliedMinor: h,
            dealerContributionMinor: d,
            customerFirstPaymentMinor: 500,
          });
          expect(built.ok).toBe(true);
          if (!built.ok) continue;
          const p = built.plan;
          // Dr company receivable A + customer receivable R + deposit liability H + contra-revenue D
          const debits = p.financeCompanyReceivableMinor + p.customerReceivableMinor + h + d;
          // Cr revenue K + payable to the company (H + D)
          const credits = p.considerationMinor + p.forwardDueMinor;
          expect(debits).toBe(credits);
        }
      }
    }
  });

  it("refuses an unknown or unusable approval instead of inventing a figure", () => {
    for (const approvedAmountMinor of [undefined, -1, 12.5, Number.NaN]) {
      const r = buildFinancedSalePostingPlanV3({ ...base, approvedAmountMinor });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe("GROSS_SETTLEMENT_UNKNOWN");
    }
  });

  it("refuses settlement deductions, a bad contribution, deposit or gap, and a deposit above the first payment", () => {
    const code = (over: Partial<FinancedSalePlanV3Input>) => {
      const r = buildFinancedSalePostingPlanV3({ ...base, ...over });
      return r.ok ? "OK" : r.refusal.code;
    };
    expect(code({ hasSettlementComponents: true })).toBe("SETTLEMENT_DEDUCTIONS_NOT_ALLOWED");
    expect(code({ dealerContributionMinor: -1 })).toBe("CONTRIBUTION_INVALID");
    expect(code({ dealerContributionMinor: 1.5 })).toBe("CONTRIBUTION_INVALID");
    expect(code({ depositLiabilityAppliedMinor: -1 })).toBe("DEPOSIT_INVALID");
    expect(code({ customerReceivableMinor: -1 })).toBe("CONSIDERATION_UNUSABLE");
    expect(code({ depositLiabilityAppliedMinor: 600, customerFirstPaymentMinor: 500 })).toBe(
      "DEPOSIT_EXCEEDS_FIRST_PAYMENT"
    );
  });

  it("refuses a contribution larger than the consideration rather than booking negative revenue", () => {
    const r = buildFinancedSalePostingPlanV3({ ...base, dealerContributionMinor: 12_501 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("CONTRIBUTION_INVALID");
    // Exactly equal is a zero-revenue sale, which is allowed (it is not a negative one).
    const equal = buildFinancedSalePostingPlanV3({ ...base, dealerContributionMinor: 12_500 });
    expect(equal.ok).toBe(true);
  });

  it("freezes a forward due only when H + D is a safe integer (P2 boundary)", () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    // H + D lands exactly on the last safe integer: allowed, and frozen exactly.
    const onBoundary = buildFinancedSalePostingPlanV3({
      ...base,
      depositLiabilityAppliedMinor: MAX - 1_375,
      dealerContributionMinor: 1_375,
    });
    expect(onBoundary.ok).toBe(true);
    if (onBoundary.ok) expect(onBoundary.plan.forwardDueMinor).toBe(MAX);
    // One minor unit past it: each term is a whole number, the sum is not
    // representable, so the plan is refused instead of freezing a rounded due.
    for (const [h, d] of [
      [MAX - 1_374, 1_375],
      [MAX, 1],
      [2 ** 60, 0],
    ]) {
      const r = buildFinancedSalePostingPlanV3({
        ...base,
        depositLiabilityAppliedMinor: h,
        dealerContributionMinor: d,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe("DEPOSIT_INVALID");
    }
  });

  it("direct-to-supplier: the dealership holds no finance receivable, the plan says so, and a deposit is forwarded", () => {
    const r = buildFinancedSalePostingPlanV3({ ...base, settlesDirect: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The company paid the supplier, so nothing of A is receivable by the dealership.
    expect(r.plan.financeCompanyReceivableMinor).toBe(0);
    expect(r.plan.settlesDirect).toBe(true);
    // K and the amount owed onward (D) are unchanged by the route.
    expect(r.plan.considerationMinor).toBe(12_500);
    expect(r.plan.forwardDueMinor).toBe(1_375);
    expect(r.plan.fingerprint).toBe("v3;JOD;K12500;G12500;F1375;D0;C1375;R0;DIRECT");
    // Still a v3 fingerprint, so version routing needs no new branch.
    expect(planVersionOf({ financedSaleRecognitionFingerprint: r.plan.fingerprint })).toBe(3);

    // The through route is untouched by the new flag being absent or false.
    for (const settlesDirect of [undefined, false]) {
      const through = buildFinancedSalePostingPlanV3({ ...base, settlesDirect });
      expect(through.ok).toBe(true);
      if (through.ok) {
        expect(through.plan.financeCompanyReceivableMinor).toBe(12_500);
        expect(through.plan.settlesDirect).toBeUndefined();
      }
    }

    // SCRUM-407 c21033: a held reservation deposit is forwarded to the company with the
    // contribution on this route too (H + D = 500 + 1,375 owed onward), never consideration.
    const withDeposit = buildFinancedSalePostingPlanV3({
      ...base,
      settlesDirect: true,
      depositLiabilityAppliedMinor: 500,
      customerFirstPaymentMinor: 500,
    });
    expect(withDeposit.ok).toBe(true);
    if (!withDeposit.ok) return;
    expect(withDeposit.plan.financeCompanyReceivableMinor).toBe(0);
    expect(withDeposit.plan.considerationMinor).toBe(12_500);
    expect(withDeposit.plan.forwardDepositMinor).toBe(500);
    expect(withDeposit.plan.forwardContributionMinor).toBe(1_375);
    expect(withDeposit.plan.forwardDueMinor).toBe(1_875);
    expect(withDeposit.plan.fingerprint).toBe("v3;JOD;K12500;G12500;F1875;D500;C1375;R0;DIRECT");

    // A deposit above the agreed first payment is still refused, on this route as on the other.
    const tooMuch = buildFinancedSalePostingPlanV3({
      ...base,
      settlesDirect: true,
      depositLiabilityAppliedMinor: 600,
      customerFirstPaymentMinor: 500,
    });
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.refusal.code).toBe("DEPOSIT_EXCEEDS_FIRST_PAYMENT");
  });

  it("refuses a zero consideration", () => {
    const r = buildFinancedSalePostingPlanV3({ ...base, approvedAmountMinor: 0, dealerContributionMinor: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("CONSIDERATION_UNUSABLE");
  });
});

describe("plan version routing", () => {
  it("v3 is read from its own field and from its fingerprint; v1/v2 are untouched", () => {
    expect(planVersionOf({ financedSalePlanVersion: 3 })).toBe(3);
    expect(planVersionOf({ financedSaleRecognitionFingerprint: "v3;JOD;K12500" })).toBe(3);
    expect(planVersionOf({ financedSalePlanVersion: 2 })).toBe(2);
    expect(planVersionOf({ financedSaleRecognitionFingerprint: "v2;JOD" })).toBe(2);
    expect(planVersionOf({ financedSaleRecognitionFingerprint: "v1;JOD" })).toBe(1);
    expect(planVersionOf({})).toBe(0);
  });

  it("both forward plans hold the company's money; v1 and pre-plan deals do not", () => {
    expect(isForwardPlanVersion(3)).toBe(true);
    expect(isForwardPlanVersion(2)).toBe(true);
    expect(isForwardPlanVersion(1)).toBe(false);
    expect(isForwardPlanVersion(0)).toBe(false);
  });
});

describe("optional legal invoice evidence", () => {
  const owned: LegalInvoiceEvidenceInput = {
    legalInvoiceAmountMinor: 12_500,
    legalInvoiceIssuedTo: "FINANCE_COMPANY",
    legalInvoiceIssuedBy: "DEALERSHIP",
    legalInvoiceIssuerName: undefined,
    approvedAmountMinor: 12_500,
    vehicleIsConsigned: false,
  };
  const consigned: LegalInvoiceEvidenceInput = {
    ...owned,
    legalInvoiceIssuedBy: "THIRD_PARTY",
    legalInvoiceIssuerName: "Al-Salam Imports",
    vehicleIsConsigned: true,
  };
  const code = (input: LegalInvoiceEvidenceInput) => {
    const r = checkLegalInvoiceEvidence(input);
    return r.ok ? (r.recorded ? "RECORDED" : "ABSENT") : r.refusal.code;
  };

  it("no invoice is fine: the sale never needs one", () => {
    expect(code({ ...owned, legalInvoiceAmountMinor: undefined })).toBe("ABSENT");
  });

  it("a genuine invoice for the approved amount, to the company, by the right party, is accepted", () => {
    expect(code(owned)).toBe("RECORDED");
    expect(code({ ...owned, legalInvoiceIssuedBy: undefined })).toBe("RECORDED");
    expect(code(consigned)).toBe("RECORDED");
  });

  it("refuses an invoice that cannot be this deal's: wrong recipient, amount or unusable figure", () => {
    expect(code({ ...owned, legalInvoiceIssuedTo: "CUSTOMER" })).toBe("LEGAL_INVOICE_WRONG_RECIPIENT");
    expect(code({ ...owned, legalInvoiceIssuedTo: undefined })).toBe("LEGAL_INVOICE_WRONG_RECIPIENT");
    // The customer's gap is not on the company's invoice: A + R is the wrong amount.
    expect(code({ ...owned, legalInvoiceAmountMinor: 12_900 })).toBe("LEGAL_INVOICE_AMOUNT_MISMATCH");
    expect(code({ ...owned, approvedAmountMinor: undefined })).toBe("LEGAL_INVOICE_AMOUNT_MISMATCH");
    expect(code({ ...owned, legalInvoiceAmountMinor: 0 })).toBe("LEGAL_INVOICE_UNUSABLE");
    expect(code({ ...owned, legalInvoiceAmountMinor: 12_500.5 })).toBe("LEGAL_INVOICE_UNUSABLE");
  });

  it("an importer's invoice is never represented as the dealership's, and the reverse", () => {
    // Consigned car: the dealership issues none for its margin.
    expect(code({ ...consigned, legalInvoiceIssuedBy: "DEALERSHIP" })).toBe("LEGAL_INVOICE_WRONG_ISSUER");
    expect(code({ ...consigned, legalInvoiceIssuedBy: undefined })).toBe("LEGAL_INVOICE_WRONG_ISSUER");
    // A third party must be named.
    expect(code({ ...consigned, legalInvoiceIssuerName: "  " })).toBe("LEGAL_INVOICE_WRONG_ISSUER");
    expect(code({ ...consigned, legalInvoiceIssuerName: undefined })).toBe("LEGAL_INVOICE_WRONG_ISSUER");
    // Owned car: a third party's document cannot stand as the sale invoice.
    expect(code({ ...owned, legalInvoiceIssuedBy: "THIRD_PARTY", legalInvoiceIssuerName: "Someone" })).toBe(
      "LEGAL_INVOICE_WRONG_ISSUER"
    );
  });
});
