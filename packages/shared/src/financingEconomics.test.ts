import { describe, expect, it } from "vitest";
import {
  FinancingEconomicsError,
  classifyGapResolution,
  computeAppraisalGap,
  computeDealerProceeds,
  computeExpectedRemittance,
  computeFundingComposition,
  computeSubmittedQuotation,
  computeGapOutcome,
  describeQuotationResidual,
  evaluateQuotationException,
  resolveLtvBaseMinor,
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
  ltvPercent: 85,
};

/**
 * The dealer-borne expense figure that makes the supplied example reproduce.
 *
 * INFERRED, not supplied. The dealership gave cost, target, first payment, LTV
 * and the 12,500 quotation, but never the link between the target and the
 * quotation. 625 is purely the residual that makes the solver's algebra land on
 * 12,500 — it could equally be negotiation headroom, a company commission, or
 * nothing at all if the quotation was simply negotiated.
 *
 * It is a fixture for reproducing THIS scenario and nothing else. It is not a
 * production default, not a domain rule, and appears in no production code
 * path: `computeSubmittedQuotation` takes expenses as a caller-supplied input
 * that defaults to nothing.
 */
const exampleEstimatedDealerBorneExpensesMinor = jod(625);

/** Narrows the solver's result, failing loudly if it declined to produce one. */
function solve(input: Parameters<typeof computeSubmittedQuotation>[0]) {
  const result = computeSubmittedQuotation(input);
  if (!result.available) {
    throw new Error(`solver unavailable: ${result.reason}`);
  }
  return result;
}

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

  it("rounds a fractional LTV exactly half-up, not through binary floating point", () => {
    // 250 × 64.6% is exactly 161.5, so half-up is 162. The float product is
    // 16149.999999999998, and the previous `Math.floor(x / 100 + 0.5)` returned
    // 161 — with the lost unit silently reappearing in the dealer's
    // contribution, so the sum invariant still held and nothing failed loudly.
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: 250,
      appliedLtvPercent: 64.6,
      customerFirstPaymentMinor: 0,
    });
    expect(composition.financeCompanyFundedPortionMinor).toBe(162);
    expect(composition.dealerContributionMinor).toBe(88);
  });

  it("does not round an exact product up", () => {
    // 12,500 at 85% is exactly 10,625 — half-up must leave it alone.
    expect(
      computeFundingComposition({
        approvedPurchaseAmountMinor: jod(12_500),
        appliedLtvPercent: 85,
        customerFirstPaymentMinor: 0,
      }).financeCompanyFundedPortionMinor
    ).toBe(jod(10_625));
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
    const result = solve({
      targetNetProceedsMinor: BASE.targetSellingAmount,
      estimatedDealerBorneExpensesMinor: exampleEstimatedDealerBorneExpensesMinor,
      customerFirstPaymentMinor: BASE.customerFirstPayment,
      appliedLtvPercent: BASE.ltvPercent,
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });

    expect(result.submittedQuotationMinor).toBe(jod(12_500));
    expect(result.composition.financeCompanyFundedPortionMinor).toBe(jod(10_625));
    expect(result.composition.dealerContributionMinor).toBe(jod(1_375));
    expect(result.customerCoversUnfinancedPortion).toBe(false);
  });

  it("lands the dealership on its target net proceeds, never below", () => {
    for (const target of [jod(10_500), jod(7_333), jod(21_007), jod(1)]) {
      for (const expenses of [0, jod(150), jod(625), jod(1_234)]) {
        for (const firstPayment of [0, jod(500), jod(2_000)]) {
          for (const ltv of [85, 80, 70, 90, 66.6]) {
            const result = solve({
              targetNetProceedsMinor: target,
              estimatedDealerBorneExpensesMinor: expenses,
              customerFirstPaymentMinor: firstPayment,
              appliedLtvPercent: ltv,
              customerFirstPaymentOffsetsUnfinancedShare: true,
            });
            // Rounding is upward on purpose, so the projection may exceed the
            // target by a minor unit or two but must never fall short of it.
            expect(result.projectedNetProceedsMinor).toBeGreaterThanOrEqual(target);
          }
        }
      }
    }
  });

  it("does not quote a minor unit more than the division exactly requires", () => {
    // 82 ÷ 65.6% is exactly 125. The float quotient is 125.00000000000001 and
    // the previous Math.ceil returned 126, quoting the finance company one
    // minor unit above what the dealership actually needed.
    const result = solve({
      targetNetProceedsMinor: 82,
      estimatedDealerBorneExpensesMinor: 0,
      customerFirstPaymentMinor: 0,
      appliedLtvPercent: 65.6,
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });
    expect(result.submittedQuotationMinor).toBe(125);
  });

  it("quotes target plus expenses when the customer already covers the unfinanced slice", () => {
    const result = solve({
      targetNetProceedsMinor: jod(10_000),
      estimatedDealerBorneExpensesMinor: jod(500),
      customerFirstPaymentMinor: jod(9_000),
      appliedLtvPercent: 85,
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });

    expect(result.customerCoversUnfinancedPortion).toBe(true);
    expect(result.submittedQuotationMinor).toBe(jod(10_500));
    expect(result.composition.dealerContributionMinor).toBe(0);
    expect(result.projectedNetProceedsMinor).toBe(jod(10_000));
  });
});

describe("the solver is optional, not the domain rule", () => {
  const baseInput = {
    targetNetProceedsMinor: BASE.targetSellingAmount,
    estimatedDealerBorneExpensesMinor: exampleEstimatedDealerBorneExpensesMinor,
    customerFirstPaymentMinor: BASE.customerFirstPayment,
    appliedLtvPercent: BASE.ltvPercent,
  };

  it("declines when the company's offset rule has not been recorded", () => {
    // The algebra only describes a company whose customer first payment offsets
    // the unfinanced share. Assuming that universally is what turned one
    // dealership's arrangement into everyone's rule.
    const result = computeSubmittedQuotation({
      ...baseInput,
      customerFirstPaymentOffsetsUnfinancedShare: undefined,
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("expected unavailable");
    expect(result.reason).toBe("OFFSET_RULE_UNKNOWN");
  });

  it("declines when the company's rule says the payment does not offset", () => {
    const result = computeSubmittedQuotation({
      ...baseInput,
      customerFirstPaymentOffsetsUnfinancedShare: false,
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("expected unavailable");
    expect(result.reason).toBe("OFFSET_RULE_DOES_NOT_APPLY");
  });

  it("treats a buffer as headroom the dealership keeps, not a cost it bears", () => {
    // Same total added to the quotation either way — and completely different
    // meanings, which is why they are separate inputs.
    const asExpense = solve({
      ...baseInput,
      estimatedDealerBorneExpensesMinor: jod(625),
      quotationBufferMinor: 0,
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });
    const asBuffer = solve({
      ...baseInput,
      estimatedDealerBorneExpensesMinor: 0,
      quotationBufferMinor: jod(625),
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });

    expect(asBuffer.submittedQuotationMinor).toBe(asExpense.submittedQuotationMinor);
    // The buffer is not spent, so it lands in proceeds instead of vanishing.
    expect(asExpense.projectedNetProceedsMinor).toBe(BASE.targetSellingAmount);
    expect(asBuffer.projectedNetProceedsMinor).toBe(BASE.targetSellingAmount + jod(625));
  });

  it("quotes lower when no expenses have been itemized, rather than inventing an allowance", () => {
    const noExpenses = solve({
      ...baseInput,
      estimatedDealerBorneExpensesMinor: 0,
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });
    // (10,500 + 0 − 500) ÷ 0.85 = 11,764.706 → 11,764.706 rounded up.
    expect(noExpenses.submittedQuotationMinor).toBeLessThan(jod(12_500));
    expect(noExpenses.projectedNetProceedsMinor).toBeGreaterThanOrEqual(
      BASE.targetSellingAmount
    );
  });
});

describe("describeQuotationResidual", () => {
  it("reports the example's 625 residual without saying what it is", () => {
    // Working backwards from the supplied scenario. The number is real; what it
    // represents — expenses, headroom, a commission, or nothing — is not
    // something the system can determine, so it names none of them.
    const residual = describeQuotationResidual({
      submittedQuotationMinor: BASE.submittedQuotation,
      targetNetProceedsMinor: BASE.targetSellingAmount,
      dealerContributionMinor: jod(1_375),
    });

    expect(residual.proceedsBeforeExpensesMinor).toBe(jod(11_125));
    expect(residual.unreconciledResidualMinor).toBe(jod(625));
    // No classification field exists to check — that is the point.
    expect(Object.keys(residual).sort()).toEqual([
      "proceedsBeforeExpensesMinor",
      "unreconciledResidualMinor",
    ]);
  });

  it("reports zero when the quotation nets exactly the target", () => {
    expect(
      describeQuotationResidual({
        submittedQuotationMinor: jod(11_875),
        targetNetProceedsMinor: jod(10_500),
        dealerContributionMinor: jod(1_375),
      }).unreconciledResidualMinor
    ).toBe(0);
  });
});

describe("computeGapOutcome", () => {
  const lowerApproval = {
    submittedQuotationMinor: jod(12_500),
    approvedDealerPurchaseAmountMinor: jod(11_500),
    appliedLtvPercent: 85,
    customerFirstPaymentMinor: jod(500),
    targetNetProceedsMinor: jod(10_500),
    dealerBorneExpensesMinor: exampleEstimatedDealerBorneExpensesMinor,
    vehicleCostMinor: BASE.vehiclePurchaseCost,
  };

  it("shows the confirmed 150 upside instead of neutralising it", () => {
    // Customer absorbs the whole raw 1,000 and pays it to the dealership. The
    // dealership ends 150 ahead of target because its own contribution fell
    // from 1,375 to 1,225 at the same time. That is a consequence of the
    // confirmed rule, and the allocation must NOT be adjusted to hide it.
    const outcome = computeGapOutcome({
      ...lowerApproval,
      customerGapShareMinor: jod(1_000),
      dealerGapShareMinor: 0,
      customerGapPaymentToDealerMinor: jod(1_000),
    });

    expect(outcome.rawAppraisalGapMinor).toBe(jod(1_000));
    expect(outcome.fundedPortionReductionMinor).toBe(jod(850));
    expect(outcome.originalDealerContributionMinor).toBe(jod(1_375));
    expect(outcome.recalculatedDealerContributionMinor).toBe(jod(1_225));
    expect(outcome.customerGapPaymentToDealerMinor).toBe(jod(1_000));
    expect(outcome.dealerGapShareMinor).toBe(0);
    expect(outcome.finalProjectedDealerNetProceedsMinor).toBe(jod(10_650));
    expect(outcome.varianceFromTargetNetProceedsMinor).toBe(jod(150));
    expect(outcome.finalProjectedProfitMinor).toBe(jod(1_150));
    expect(outcome.proceedsDifferFromTarget).toBe(true);
  });

  it("shows the shortfall when the dealership absorbs the whole gap", () => {
    const outcome = computeGapOutcome({
      ...lowerApproval,
      customerGapShareMinor: 0,
      dealerGapShareMinor: jod(1_000),
      customerGapPaymentToDealerMinor: 0,
    });

    expect(outcome.finalProjectedDealerNetProceedsMinor).toBe(jod(9_650));
    expect(outcome.varianceFromTargetNetProceedsMinor).toBe(jod(-850));
    expect(outcome.finalProjectedProfitMinor).toBe(jod(150));
    expect(outcome.proceedsDifferFromTarget).toBe(true);
  });

  it("shows the confirmed 700/300 split, with the shares still summing to 1,000", () => {
    const outcome = computeGapOutcome({
      ...lowerApproval,
      customerGapShareMinor: jod(700),
      dealerGapShareMinor: jod(300),
      // 300 cash + 400 installments, both payable to the dealership.
      customerGapPaymentToDealerMinor: jod(700),
    });

    expect(
      validateGapShares(outcome.rawAppraisalGapMinor, {
        customerGapShareMinor: jod(700),
        dealerGapShareMinor: jod(300),
        customerGapCashToDealerMinor: jod(300),
        customerGapInstallmentToDealerMinor: jod(400),
        customerGapToFinanceCompanyMinor: 0,
      })
    ).toEqual([]);
    expect(outcome.finalProjectedDealerNetProceedsMinor).toBe(jod(10_350));
    expect(outcome.varianceFromTargetNetProceedsMinor).toBe(jod(-150));
  });

  it("does not flag a variance when the outcome lands exactly on target", () => {
    const outcome = computeGapOutcome({
      ...lowerApproval,
      customerGapShareMinor: jod(850),
      dealerGapShareMinor: jod(150),
      customerGapPaymentToDealerMinor: jod(850),
    });
    expect(outcome.varianceFromTargetNetProceedsMinor).toBe(0);
    expect(outcome.proceedsDifferFromTarget).toBe(false);
  });
});

describe("resolveLtvBaseMinor", () => {
  const amounts = {
    approvedPurchaseAmountMinor: jod(12_500),
    submittedQuotationMinor: jod(12_500),
    independentAppraisalMinor: jod(11_500),
  };

  it("applies the LTV to what the company's rule actually names", () => {
    expect(resolveLtvBaseMinor("APPROVED_PURCHASE_AMOUNT", amounts)).toBe(jod(12_500));
    expect(resolveLtvBaseMinor("INDEPENDENT_APPRAISAL", amounts)).toBe(jod(11_500));
    expect(resolveLtvBaseMinor("SUBMITTED_QUOTATION", amounts)).toBe(jod(12_500));
    expect(resolveLtvBaseMinor("LOWER_OF_APPRAISAL_AND_QUOTATION", amounts)).toBe(jod(11_500));
  });

  it("changes the dealer contribution by the full 850 the basis is worth", () => {
    // The whole reason the basis cannot be stored and ignored: an appraisal
    // basis funds 9,775 where an approved-amount basis funds 10,625.
    const onApproved = computeFundingComposition({
      approvedPurchaseAmountMinor: jod(12_500),
      appliedLtvPercent: 85,
      customerFirstPaymentMinor: jod(500),
      ltvBaseMinor: resolveLtvBaseMinor("APPROVED_PURCHASE_AMOUNT", amounts),
    });
    const onAppraisal = computeFundingComposition({
      approvedPurchaseAmountMinor: jod(12_500),
      appliedLtvPercent: 85,
      customerFirstPaymentMinor: jod(500),
      ltvBaseMinor: resolveLtvBaseMinor("INDEPENDENT_APPRAISAL", amounts),
    });

    expect(onApproved.financeCompanyFundedPortionMinor).toBe(jod(10_625));
    expect(onAppraisal.financeCompanyFundedPortionMinor).toBe(jod(9_775));
    expect(onAppraisal.dealerContributionMinor - onApproved.dealerContributionMinor).toBe(
      jod(850)
    );
    expect(
      onAppraisal.financeCompanyFundedPortionMinor +
        onAppraisal.customerFirstPaymentAppliedMinor +
        onAppraisal.dealerContributionMinor
    ).toBe(jod(12_500));
  });

  it("reports the base as unknown rather than substituting the approved amount", () => {
    // Substituting reads as a safe fallback and is not one. A company that
    // lends against the appraisal, approving manually with none on file, would
    // have its funding computed against a larger basis — understating the
    // dealership's own contribution with nothing to show the swap.
    const partial = { approvedPurchaseAmountMinor: jod(12_500) };
    expect(resolveLtvBaseMinor("INDEPENDENT_APPRAISAL", partial)).toBeUndefined();
    expect(resolveLtvBaseMinor("SUBMITTED_QUOTATION", partial)).toBeUndefined();
    // "Lower of two" needs both; with one it is whichever was recorded first.
    expect(
      resolveLtvBaseMinor("LOWER_OF_APPRAISAL_AND_QUOTATION", {
        ...partial,
        submittedQuotationMinor: jod(12_500),
      })
    ).toBeUndefined();
    // The default basis needs nothing beyond the approved amount.
    expect(resolveLtvBaseMinor(undefined, partial)).toBe(jod(12_500));
    expect(resolveLtvBaseMinor("APPROVED_PURCHASE_AMOUNT", partial)).toBe(jod(12_500));
  });

  it("flags when the LTV base exceeds what the company is buying at", () => {
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: jod(11_500),
      appliedLtvPercent: 100,
      customerFirstPaymentMinor: 0,
      ltvBaseMinor: jod(20_000),
    });
    // Arithmetically right, and almost certainly a misconfiguration worth
    // showing someone rather than absorbing into a zero dealer contribution.
    expect(composition.ltvBaseCapApplied).toBe(true);
    expect(composition.dealerContributionMinor).toBe(0);
  });

  it("never funds more than the company is actually buying at", () => {
    // Quotation basis after a lower approval: 12,500 × 100% exceeds the 11,500
    // the company is paying, which would drive the unfinanced slice negative.
    const composition = computeFundingComposition({
      approvedPurchaseAmountMinor: jod(11_500),
      appliedLtvPercent: 100,
      customerFirstPaymentMinor: 0,
      ltvBaseMinor: jod(12_500),
    });
    expect(composition.financeCompanyFundedPortionMinor).toBe(jod(11_500));
    expect(composition.unfinancedPortionMinor).toBe(0);
    expect(composition.dealerContributionMinor).toBe(0);
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
      dealerBorneExpensesMinor: exampleEstimatedDealerBorneExpensesMinor,
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
      dealerBorneExpensesMinor: exampleEstimatedDealerBorneExpensesMinor,
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
      dealerBorneExpensesMinor: exampleEstimatedDealerBorneExpensesMinor,
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
      dealerBorneExpensesMinor: exampleEstimatedDealerBorneExpensesMinor,
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
