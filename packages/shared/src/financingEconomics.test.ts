import { describe, expect, it } from "vitest";
import {
  FinancingEconomicsError,
  classifyGapResolution,
  computeAppraisalGap,
  computeDealerProceeds,
  computeExpectedRemittance,
  computeFundingComposition,
  computeSubmittedQuotation,
  evaluateQuotationException,
  reconcileEmployeeCustody,
  reconcileSettlement,
  validateGapShares,
} from "./financingEconomics";

/**
 * Every amount here is in JOD minor units (scale 3), so 12,500 JOD is
 * 12_500_000. `jod()` keeps the confirmed dealer figures readable while making
 * it impossible to accidentally pass decimals into the engine.
 */
const jod = (major: number): number => Math.round(major * 1000);

/** The confirmed baseline deal, in one place so every case can vary one thing. */
const BASE = {
  vehiclePurchaseCost: jod(9_500),
  targetSellingAmount: jod(10_500),
  customerFirstPayment: jod(500),
  submittedQuotation: jod(12_500),
  estimatedExpenses: jod(625),
  ltvPercent: 85,
};

describe("computeFundingComposition", () => {
  it("splits the dealer's confirmed 12,500 approval into 10,625 / 500 / 1,375", () => {
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: BASE.submittedQuotation,
      appliedLtvPercent: BASE.ltvPercent,
      customerFirstPaymentMinor: BASE.customerFirstPayment,
    });

    expect(composition.financeCompanyFundedPortionMinor).toBe(jod(10_625));
    expect(composition.unfinancedPortionMinor).toBe(jod(1_875));
    expect(composition.customerFirstPaymentAppliedMinor).toBe(jod(500));
    // The number the dealer confirmed explicitly: 1,875 − 500. Not 1,350, and
    // not a percentage of anything.
    expect(composition.dealerContributionMinor).toBe(jod(1_375));
    expect(composition.customerFirstPaymentSurplusMinor).toBe(0);
  });

  it("always splits the approved amount exactly, leaving no rounding residue", () => {
    // 85% of an amount whose minor units are not divisible by 20 forces the
    // half-up rounding to bite; the three sources must still reconcile.
    for (const approved of [jod(11_500), jod(12_500), 9_999_999, 1, 7, 1_000_001]) {
      for (const ltv of [85, 80, 70.5, 100, 33.333]) {
        const composition = computeFundingComposition({
          approvedPurchaseAmountMinor: approved,
          appliedLtvPercent: ltv,
          customerFirstPaymentMinor: jod(500),
        });
        expect(
          composition.financeCompanyFundedPortionMinor +
            composition.customerFirstPaymentAppliedMinor +
            composition.dealerContributionMinor
        ).toBe(approved);
        expect(composition.dealerContributionMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("lets a large customer payment reduce the company's advance instead of paying the dealer twice", () => {
    // Customer puts down 3,000 against a 1,875 unfinanced slice.
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: BASE.submittedQuotation,
      appliedLtvPercent: BASE.ltvPercent,
      customerFirstPaymentMinor: jod(3_000),
    });

    expect(composition.dealerContributionMinor).toBe(0);
    expect(composition.financeCompanyFundedPortionMinor).toBe(jod(9_500));
    expect(composition.maximumFundableMinor).toBe(jod(10_625));
    expect(composition.customerFirstPaymentAppliedMinor).toBe(jod(3_000));
  });

  it("reports customer money beyond the purchase amount as surplus rather than absorbing it", () => {
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: jod(10_000),
      appliedLtvPercent: 85,
      customerFirstPaymentMinor: jod(12_000),
    });

    expect(composition.customerFirstPaymentAppliedMinor).toBe(jod(10_000));
    expect(composition.customerFirstPaymentSurplusMinor).toBe(jod(2_000));
    expect(composition.financeCompanyFundedPortionMinor).toBe(0);
    expect(composition.dealerContributionMinor).toBe(0);
  });

  it("rejects decimal major-unit amounts rather than silently rounding them", () => {
    expect(() =>
      computeFundingComposition({
        approvedPurchaseAmountMinor: 12_500.5,
        appliedLtvPercent: 85,
        customerFirstPaymentMinor: jod(500),
      })
    ).toThrow(FinancingEconomicsError);
  });

  it("rejects an LTV outside (0, 100]", () => {
    for (const ltv of [0, -5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeFundingComposition({
          approvedPurchaseAmountMinor: BASE.submittedQuotation,
          appliedLtvPercent: ltv,
          customerFirstPaymentMinor: jod(500),
        })
      ).toThrow(FinancingEconomicsError);
    }
  });
});

describe("computeSubmittedQuotation", () => {
  it("reproduces the dealer's 12,500 from target 10,500, expenses 625, first payment 500 at 85%", () => {
    const suggestion = computeSubmittedQuotation({
      targetNetProceedsMinor: BASE.targetSellingAmount,
      estimatedExpensesMinor: BASE.estimatedExpenses,
      customerFirstPaymentMinor: BASE.customerFirstPayment,
      appliedLtvPercent: BASE.ltvPercent,
    });

    expect(suggestion.submittedQuotationMinor).toBe(jod(12_500));
    expect(suggestion.composition.financeCompanyFundedPortionMinor).toBe(jod(10_625));
    expect(suggestion.composition.dealerContributionMinor).toBe(jod(1_375));
    expect(suggestion.customerCoversUnfinancedPortion).toBe(false);
  });

  it("lands the dealership on its target net proceeds, never below", () => {
    for (const target of [jod(10_500), jod(7_333), jod(21_007), jod(1)]) {
      for (const expenses of [0, jod(150), jod(625), jod(1_234)]) {
        for (const firstPayment of [0, jod(500), jod(2_000)]) {
          for (const ltv of [85, 80, 70, 90, 66.6]) {
            const suggestion = computeSubmittedQuotation({
              targetNetProceedsMinor: target,
              estimatedExpensesMinor: expenses,
              customerFirstPaymentMinor: firstPayment,
              appliedLtvPercent: ltv,
            });
            // Rounding is upward on purpose, so the projection may exceed the
            // target by a minor unit or two but must never fall short of it.
            expect(suggestion.projectedNetProceedsMinor).toBeGreaterThanOrEqual(target);
          }
        }
      }
    }
  });

  it("quotes target plus expenses when the customer already covers the unfinanced slice", () => {
    const suggestion = computeSubmittedQuotation({
      targetNetProceedsMinor: jod(10_000),
      estimatedExpensesMinor: jod(500),
      customerFirstPaymentMinor: jod(9_000),
      appliedLtvPercent: 85,
    });

    expect(suggestion.customerCoversUnfinancedPortion).toBe(true);
    expect(suggestion.submittedQuotationMinor).toBe(jod(10_500));
    expect(suggestion.composition.dealerContributionMinor).toBe(0);
    expect(suggestion.projectedNetProceedsMinor).toBe(jod(10_000));
  });
});

describe("computeAppraisalGap", () => {
  it("negotiates the raw 1,000 gap, not the 850 change in funded portion", () => {
    const gap = computeAppraisalGap({
      submittedQuotationMinor: jod(12_500),
      approvedDealerPurchaseAmountMinor: jod(11_500),
      appliedLtvPercent: 85,
    });

    expect(gap.rawAppraisalGapMinor).toBe(jod(1_000));
    // Shown for context. Confirmed by the dealer as explicitly NOT the
    // negotiated amount: 12,500 × 85% − 11,500 × 85% = 10,625 − 9,775.
    expect(gap.fundingReductionMinor).toBe(jod(850));
    expect(gap.requiresResolution).toBe(true);
  });

  it("reports the lower approval's funded portion as 9,775", () => {
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: jod(11_500),
      appliedLtvPercent: 85,
      customerFirstPaymentMinor: BASE.customerFirstPayment,
    });
    expect(composition.financeCompanyFundedPortionMinor).toBe(jod(9_775));
  });

  it("has no gap when the company approves at the submitted quotation under an exception", () => {
    const gap = computeAppraisalGap({
      submittedQuotationMinor: jod(12_500),
      approvedDealerPurchaseAmountMinor: jod(12_500),
      appliedLtvPercent: 85,
    });
    expect(gap.rawAppraisalGapMinor).toBe(0);
    expect(gap.requiresResolution).toBe(false);
  });

  it("floors at zero when the approval exceeds the quotation", () => {
    const gap = computeAppraisalGap({
      submittedQuotationMinor: jod(12_500),
      approvedDealerPurchaseAmountMinor: jod(13_000),
      appliedLtvPercent: 85,
    });
    expect(gap.rawAppraisalGapMinor).toBe(0);
    expect(gap.fundingReductionMinor).toBe(0);
  });
});

describe("validateGapShares", () => {
  const noGapToFinanceCompany = {
    customerGapToFinanceCompanyMinor: 0,
  };

  it("accepts the customer absorbing the full gap in cash", () => {
    expect(
      validateGapShares(jod(1_000), {
        customerGapShareMinor: jod(1_000),
        dealerGapShareMinor: 0,
        customerGapCashToDealerMinor: jod(1_000),
        customerGapInstallmentToDealerMinor: 0,
        ...noGapToFinanceCompany,
      })
    ).toEqual([]);
  });

  it("accepts the customer absorbing the full gap in installments", () => {
    expect(
      validateGapShares(jod(1_000), {
        customerGapShareMinor: jod(1_000),
        dealerGapShareMinor: 0,
        customerGapCashToDealerMinor: 0,
        customerGapInstallmentToDealerMinor: jod(1_000),
        ...noGapToFinanceCompany,
      })
    ).toEqual([]);
  });

  it("accepts the dealer absorbing the full gap", () => {
    expect(
      validateGapShares(jod(1_000), {
        customerGapShareMinor: 0,
        dealerGapShareMinor: jod(1_000),
        customerGapCashToDealerMinor: 0,
        customerGapInstallmentToDealerMinor: 0,
        ...noGapToFinanceCompany,
      })
    ).toEqual([]);
  });

  it("accepts the confirmed 700/300 split settled 300 cash plus 400 installments", () => {
    expect(
      validateGapShares(jod(1_000), {
        customerGapShareMinor: jod(700),
        dealerGapShareMinor: jod(300),
        customerGapCashToDealerMinor: jod(300),
        customerGapInstallmentToDealerMinor: jod(400),
        ...noGapToFinanceCompany,
      })
    ).toEqual([]);
  });

  it("rejects shares that do not sum to the raw gap", () => {
    const violations = validateGapShares(jod(1_000), {
      customerGapShareMinor: jod(700),
      dealerGapShareMinor: jod(200),
      customerGapCashToDealerMinor: jod(700),
      customerGapInstallmentToDealerMinor: 0,
      ...noGapToFinanceCompany,
    });
    expect(violations.map((violation) => violation.code)).toContain("SHARES_DO_NOT_SUM_TO_GAP");
  });

  it("rejects a customer share whose destinations do not add up", () => {
    const violations = validateGapShares(jod(1_000), {
      customerGapShareMinor: jod(700),
      dealerGapShareMinor: jod(300),
      customerGapCashToDealerMinor: jod(300),
      customerGapInstallmentToDealerMinor: jod(300),
      ...noGapToFinanceCompany,
    });
    expect(violations.map((violation) => violation.code)).toContain(
      "CUSTOMER_DESTINATIONS_DO_NOT_SUM_TO_SHARE"
    );
  });

  it("counts a customer payment routed to the financing company toward the share", () => {
    // The whole point of tracking the destination: this reconciles, and none of
    // it may become a dealer-side receivable.
    expect(
      validateGapShares(jod(1_000), {
        customerGapShareMinor: jod(1_000),
        dealerGapShareMinor: 0,
        customerGapCashToDealerMinor: jod(400),
        customerGapInstallmentToDealerMinor: 0,
        customerGapToFinanceCompanyMinor: jod(600),
      })
    ).toEqual([]);
  });

  it("rejects negative amounts before checking the identities", () => {
    const violations = validateGapShares(jod(1_000), {
      customerGapShareMinor: jod(1_200),
      dealerGapShareMinor: jod(-200),
      customerGapCashToDealerMinor: jod(1_200),
      customerGapInstallmentToDealerMinor: 0,
      ...noGapToFinanceCompany,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.code).toBe("NEGATIVE_AMOUNT");
  });
});

describe("classifyGapResolution", () => {
  it("names each confirmed outcome", () => {
    expect(classifyGapResolution(0, 0, 0)).toBe("NOT_REQUIRED");
    expect(classifyGapResolution(jod(1_000), jod(1_000), 0)).toBe("CUSTOMER_ABSORBS");
    expect(classifyGapResolution(jod(1_000), 0, jod(1_000))).toBe("DEALER_ABSORBS");
    expect(classifyGapResolution(jod(1_000), jod(700), jod(300))).toBe("SPLIT");
  });
});

describe("computeExpectedRemittance", () => {
  it("expects the full approved amount when the dealer wires its contribution separately", () => {
    const remittance = computeExpectedRemittance({
      approvedDealerPurchaseAmountMinor: jod(12_500),
      dealerContributionMinor: jod(1_375),
      dealerContributionSettlement: "PAID_SEPARATELY",
      customerContributionToFinanceCompanyMinor: jod(500),
      customerContributionSettlement: "PASSED_THROUGH",
      feeDeductionsMinor: 0,
    });

    expect(remittance.grossRemittanceMinor).toBe(jod(12_500));
    expect(remittance.expectedDealerRemittanceMinor).toBe(jod(12_500));
  });

  it("nets the dealer contribution out when the company settles that way", () => {
    const remittance = computeExpectedRemittance({
      approvedDealerPurchaseAmountMinor: jod(12_500),
      dealerContributionMinor: jod(1_375),
      dealerContributionSettlement: "NETTED_FROM_REMITTANCE",
      customerContributionToFinanceCompanyMinor: jod(500),
      customerContributionSettlement: "PASSED_THROUGH",
      feeDeductionsMinor: 0,
    });

    expect(remittance.expectedDealerRemittanceMinor).toBe(jod(11_125));
    expect(remittance.totalDeductionsMinor).toBe(jod(1_375));
  });

  it("withholds fees the company deducts from the settlement", () => {
    const remittance = computeExpectedRemittance({
      approvedDealerPurchaseAmountMinor: jod(12_500),
      dealerContributionMinor: jod(1_375),
      dealerContributionSettlement: "PAID_SEPARATELY",
      customerContributionToFinanceCompanyMinor: jod(500),
      customerContributionSettlement: "PASSED_THROUGH",
      feeDeductionsMinor: jod(150),
    });

    expect(remittance.expectedDealerRemittanceMinor).toBe(jod(12_350));
  });

  it("excludes customer money the company keeps rather than passing on", () => {
    const remittance = computeExpectedRemittance({
      approvedDealerPurchaseAmountMinor: jod(12_500),
      dealerContributionMinor: jod(1_375),
      dealerContributionSettlement: "PAID_SEPARATELY",
      customerContributionToFinanceCompanyMinor: jod(500),
      customerContributionSettlement: "RETAINED_BY_COMPANY",
      feeDeductionsMinor: 0,
    });

    expect(remittance.grossRemittanceMinor).toBe(jod(12_000));
    expect(remittance.expectedDealerRemittanceMinor).toBe(jod(12_000));
  });

  it("floors at zero rather than reporting a negative receivable", () => {
    const remittance = computeExpectedRemittance({
      approvedDealerPurchaseAmountMinor: jod(1_000),
      dealerContributionMinor: 0,
      dealerContributionSettlement: "PAID_SEPARATELY",
      customerContributionToFinanceCompanyMinor: 0,
      customerContributionSettlement: "PASSED_THROUGH",
      feeDeductionsMinor: jod(1_500),
    });

    expect(remittance.expectedDealerRemittanceMinor).toBe(0);
    expect(remittance.totalDeductionsMinor).toBe(jod(1_500));
  });
});

describe("computeDealerProceeds", () => {
  it("hits the 10,500 target and 1,000 profit on the confirmed base deal", () => {
    const proceeds = computeDealerProceeds({
      approvedDealerPurchaseAmountMinor: jod(12_500),
      dealerContributionMinor: jod(1_375),
      customerDirectToDealerMinor: 0,
      dealerBorneExpensesMinor: BASE.estimatedExpenses,
      vehicleCostMinor: BASE.vehiclePurchaseCost,
    });

    expect(proceeds.netProceedsMinor).toBe(jod(10_500));
    expect(proceeds.profitMinor).toBe(jod(1_000));
  });

  it("costs the dealer the funding reduction, not the raw gap, when it absorbs the gap", () => {
    // Approved 11,500, dealer absorbs all 1,000. Its own contribution falls
    // from 1,375 to 1,225 at the same time, so profit drops by 850 — exactly
    // the funding reduction. Correct, and worth showing rather than hiding.
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: jod(11_500),
      appliedLtvPercent: 85,
      customerFirstPaymentMinor: BASE.customerFirstPayment,
    });
    expect(composition.dealerContributionMinor).toBe(jod(1_225));

    const proceeds = computeDealerProceeds({
      approvedDealerPurchaseAmountMinor: jod(11_500),
      dealerContributionMinor: composition.dealerContributionMinor,
      customerDirectToDealerMinor: 0,
      dealerBorneExpensesMinor: BASE.estimatedExpenses,
      vehicleCostMinor: BASE.vehiclePurchaseCost,
    });

    expect(proceeds.netProceedsMinor).toBe(jod(9_650));
    expect(proceeds.profitMinor).toBe(jod(150));
  });

  it("counts a customer's direct payments to the dealership as proceeds", () => {
    const proceeds = computeDealerProceeds({
      approvedDealerPurchaseAmountMinor: jod(11_500),
      dealerContributionMinor: jod(1_225),
      customerDirectToDealerMinor: jod(1_000),
      dealerBorneExpensesMinor: BASE.estimatedExpenses,
      vehicleCostMinor: BASE.vehiclePurchaseCost,
    });

    expect(proceeds.grossProceedsMinor).toBe(jod(12_500));
    expect(proceeds.netProceedsMinor).toBe(jod(10_650));
  });

  it("ignores customer money paid to the financing company", () => {
    // Same 1,000 gap, but the customer settles it with the financing company.
    // None of it reaches the dealership, so proceeds must not move.
    const proceeds = computeDealerProceeds({
      approvedDealerPurchaseAmountMinor: jod(11_500),
      dealerContributionMinor: jod(1_225),
      customerDirectToDealerMinor: 0,
      dealerBorneExpensesMinor: BASE.estimatedExpenses,
      vehicleCostMinor: BASE.vehiclePurchaseCost,
    });
    expect(proceeds.netProceedsMinor).toBe(jod(9_650));
  });
});

describe("evaluateQuotationException", () => {
  const company = { allowsQuotationAboveAppraisal: true, lowerAppraisalTolerancePercent: 10 };

  it("allows approving at 12,500 when the 11,500 appraisal is inside a 10% tolerance", () => {
    const evaluation = evaluateQuotationException({
      submittedQuotationMinor: jod(12_500),
      independentAppraisalMinor: jod(11_500),
      ...company,
    });

    expect(evaluation.eligible).toBe(true);
    expect(evaluation.shortfallPercent).toBeCloseTo(8, 10);
  });

  it("refuses outside the tolerance", () => {
    const evaluation = evaluateQuotationException({
      submittedQuotationMinor: jod(12_500),
      independentAppraisalMinor: jod(10_000),
      ...company,
    });

    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reason).toBe("OUTSIDE_TOLERANCE");
  });

  it("refuses when the company does not permit the exception at all", () => {
    const evaluation = evaluateQuotationException({
      submittedQuotationMinor: jod(12_500),
      independentAppraisalMinor: jod(12_400),
      allowsQuotationAboveAppraisal: false,
      lowerAppraisalTolerancePercent: 10,
    });

    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reason).toBe("NOT_ALLOWED");
  });

  it("reports no shortfall when the appraisal meets or beats the quotation", () => {
    expect(
      evaluateQuotationException({
        submittedQuotationMinor: jod(12_500),
        independentAppraisalMinor: jod(12_500),
        ...company,
      }).reason
    ).toBe("NO_SHORTFALL");
  });

  it("treats the tolerance boundary as inside it", () => {
    // Exactly 10% below: 12,500 → 11,250.
    expect(
      evaluateQuotationException({
        submittedQuotationMinor: jod(12_500),
        independentAppraisalMinor: jod(11_250),
        ...company,
      }).eligible
    ).toBe(true);
  });
});

describe("reconcileEmployeeCustody", () => {
  it("closes a 700 advance against 650 of expenses with 50 returned", () => {
    const reconciliation = reconcileEmployeeCustody({
      advanceIssuedMinor: jod(700),
      employeePersonalPaymentMinor: 0,
      actualExpensesMinor: jod(650),
      employeeReturnedMinor: jod(50),
    });

    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.remainingEmployeeBalanceMinor).toBe(0);
    expect(reconciliation.dealerReimbursementDueMinor).toBe(0);
  });

  it("owes the employee 50 when they spent 750 against a 700 advance", () => {
    const reconciliation = reconcileEmployeeCustody({
      advanceIssuedMinor: jod(700),
      employeePersonalPaymentMinor: jod(50),
      actualExpensesMinor: jod(750),
      employeeReturnedMinor: 0,
    });

    // The identity closes only once the reimbursement is actually paid, so the
    // advance is not reconciled yet — it is a payable, not a balanced advance.
    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.remainingEmployeeBalanceMinor).toBe(0);
  });

  it("shows a reimbursement owed while the employee's own money is still out", () => {
    const reconciliation = reconcileEmployeeCustody({
      advanceIssuedMinor: jod(700),
      employeePersonalPaymentMinor: 0,
      actualExpensesMinor: jod(750),
      employeeReturnedMinor: 0,
    });

    expect(reconciliation.remainingEmployeeBalanceMinor).toBe(jod(-50));
    expect(reconciliation.dealerReimbursementDueMinor).toBe(jod(50));
    expect(reconciliation.employeeOwesDealerMinor).toBe(0);
    expect(reconciliation.reconciled).toBe(false);
  });

  it("shows money still held by the employee as owed back to the dealership", () => {
    const reconciliation = reconcileEmployeeCustody({
      advanceIssuedMinor: jod(700),
      employeePersonalPaymentMinor: 0,
      actualExpensesMinor: jod(650),
      employeeReturnedMinor: 0,
    });

    expect(reconciliation.employeeOwesDealerMinor).toBe(jod(50));
    expect(reconciliation.dealerReimbursementDueMinor).toBe(0);
    expect(reconciliation.reconciled).toBe(false);
  });

  it("keeps the direction of the imbalance rather than collapsing it to a variance", () => {
    const owed = reconcileEmployeeCustody({
      advanceIssuedMinor: jod(700),
      employeePersonalPaymentMinor: 0,
      actualExpensesMinor: jod(750),
      employeeReturnedMinor: 0,
    });
    const held = reconcileEmployeeCustody({
      advanceIssuedMinor: jod(700),
      employeePersonalPaymentMinor: 0,
      actualExpensesMinor: jod(650),
      employeeReturnedMinor: 0,
    });

    expect(owed.remainingEmployeeBalanceMinor).toBe(-held.remainingEmployeeBalanceMinor);
    expect(owed.dealerReimbursementDueMinor).toBe(held.employeeOwesDealerMinor);
  });
});

describe("reconcileSettlement", () => {
  const expected = jod(12_500);

  it("reconciles an exact receipt", () => {
    const reconciliation = reconcileSettlement({
      expectedDealerRemittanceMinor: expected,
      expectedSettlementLinesTotalMinor: expected,
      actualDealerReceiptTotalMinor: expected,
      actualReceiptLinesTotalMinor: expected,
      approvedAdjustmentMinor: 0,
    });

    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.unexplainedVarianceMinor).toBe(0);
  });

  it("reports a partial receipt as an unsettled shortfall", () => {
    const reconciliation = reconcileSettlement({
      expectedDealerRemittanceMinor: expected,
      expectedSettlementLinesTotalMinor: expected,
      actualDealerReceiptTotalMinor: jod(10_000),
      actualReceiptLinesTotalMinor: jod(10_000),
      approvedAdjustmentMinor: 0,
    });

    expect(reconciliation.fullySettled).toBe(false);
    expect(reconciliation.unexplainedVarianceMinor).toBe(jod(-2_500));
  });

  it("reconciles multiple receipts that add up", () => {
    const receipts = [jod(6_000), jod(4_000), jod(2_500)];
    const total = receipts.reduce((sum, amount) => sum + amount, 0);
    const reconciliation = reconcileSettlement({
      expectedDealerRemittanceMinor: expected,
      expectedSettlementLinesTotalMinor: expected,
      actualDealerReceiptTotalMinor: total,
      actualReceiptLinesTotalMinor: total,
      approvedAdjustmentMinor: 0,
    });

    expect(reconciliation.reconciled).toBe(true);
  });

  it("explains a shortfall once an adjustment is approved", () => {
    const reconciliation = reconcileSettlement({
      expectedDealerRemittanceMinor: expected,
      expectedSettlementLinesTotalMinor: expected,
      actualDealerReceiptTotalMinor: jod(12_350),
      actualReceiptLinesTotalMinor: jod(12_350),
      approvedAdjustmentMinor: jod(-150),
    });

    expect(reconciliation.unexplainedVarianceMinor).toBe(0);
    expect(reconciliation.reconciled).toBe(true);
  });

  it("still flags an overpayment nobody has explained", () => {
    const reconciliation = reconcileSettlement({
      expectedDealerRemittanceMinor: expected,
      expectedSettlementLinesTotalMinor: expected,
      actualDealerReceiptTotalMinor: jod(12_700),
      actualReceiptLinesTotalMinor: jod(12_700),
      approvedAdjustmentMinor: 0,
    });

    expect(reconciliation.unexplainedVarianceMinor).toBe(jod(200));
    expect(reconciliation.reconciled).toBe(false);
  });

  it("fails reconciliation when the lines do not add up to the totals", () => {
    const reconciliation = reconcileSettlement({
      expectedDealerRemittanceMinor: expected,
      expectedSettlementLinesTotalMinor: jod(12_000),
      actualDealerReceiptTotalMinor: expected,
      actualReceiptLinesTotalMinor: jod(11_000),
      approvedAdjustmentMinor: 0,
    });

    expect(reconciliation.expectedLinesBalanced).toBe(false);
    expect(reconciliation.actualLinesBalanced).toBe(false);
    expect(reconciliation.reconciled).toBe(false);
  });
});
