/**
 * Dealer-side economics of a financed vehicle sale.
 *
 * `financing.ts` next door answers the *customer's* question — what will the
 * monthly installment be. This module answers the *dealership's*: what does the
 * financing company actually pay us, what do we have to put in, and what is
 * left after the closing expenses.
 *
 * They are different sums over different parties and must never be conflated.
 * `quotes.totalFinancedAmount` (the customer's Murabaha principal) was being
 * read as the amount the financing company owes the dealer, which it is not.
 *
 * ## The transaction being modelled
 *
 * The financing company **buys the vehicle from the dealership** and resells it
 * to the customer on installments. It funds its own LTV share of the purchase
 * amount; the rest is completed by the customer's first payment and, if that
 * falls short, by the dealership itself.
 *
 * ```
 * Submitted quotation                      12,500
 * Applied LTV                                 85%
 *
 * Financing-company funded portion         10,625      12,500 × 85%
 * Unfinanced portion                        1,875      12,500 × 15%
 *   ├─ Customer first payment                 500
 *   └─ Dealer contribution                  1,375      1,875 − 500
 *                                         ───────
 * Approved purchase amount                 12,500
 * ```
 *
 * The dealer contribution is the *residue* of the unfinanced slice after the
 * customer's first payment — 1,375, not 1,350 and not a percentage of anything.
 *
 * ## Units
 *
 * Every amount is an integer in the currency's minor units. Never pass decimal
 * JOD in here: 0.1 + 0.2 !== 0.3 and a dealership's books are not the place to
 * find that out. Percentages stay as human percentages (85 means 85%), matching
 * how `financeCompanies.maxFinancingLTV` is already stored.
 */

/** Thrown for inputs that cannot produce a meaningful result. */
export class FinancingEconomicsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancingEconomicsError";
  }
}

function assertMinor(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new FinancingEconomicsError(
      `${label} must be an integer in minor units (got ${value}).`
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new FinancingEconomicsError(`${label} overflows safe integer range.`);
  }
}

function assertNonNegativeMinor(value: number, label: string): void {
  assertMinor(value, label);
  if (value < 0) {
    throw new FinancingEconomicsError(`${label} must not be negative (got ${value}).`);
  }
}

function assertLtvPercent(ltvPercent: number): void {
  if (!Number.isFinite(ltvPercent)) {
    throw new FinancingEconomicsError(`LTV must be a finite percentage (got ${ltvPercent}).`);
  }
  if (ltvPercent <= 0 || ltvPercent > 100) {
    throw new FinancingEconomicsError(
      `LTV must be greater than 0 and at most 100 (got ${ltvPercent}).`
    );
  }
}

/**
 * Half-up rounding on a non-negative rational, in minor units.
 *
 * Deliberately not `Math.round`, which is half-away-from-zero on positives but
 * half-*up* on negatives (`Math.round(-0.5) === -0`), and not banker's rounding.
 * Every amount here is non-negative, and half-up is what a dealership expects
 * when it checks the arithmetic by hand.
 */
function roundHalfUp(numerator: number, denominator: number): number {
  const result = Math.floor(numerator / denominator + 0.5);
  if (!Number.isSafeInteger(result)) {
    throw new FinancingEconomicsError("Rounded amount overflows safe integer range.");
  }
  return result;
}

/** Ceiling division on non-negative integers, in minor units. */
function divideCeil(numerator: number, denominator: number): number {
  const result = Math.ceil(numerator / denominator);
  if (!Number.isSafeInteger(result)) {
    throw new FinancingEconomicsError("Computed amount overflows safe integer range.");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Funding composition
// ---------------------------------------------------------------------------

export interface FundingCompositionInput {
  /** What the financing company will actually buy the vehicle at. */
  approvedPurchaseAmountMinor: number;
  /** The LTV rule actually applied, as a percentage (85 means 85%). */
  appliedLtvPercent: number;
  /** What the customer pays toward the purchase amount, whoever receives it. */
  customerFirstPaymentMinor: number;
}

export interface FundingComposition {
  /** The financing company's own money: min(approved × LTV, approved − customer). */
  financeCompanyFundedPortionMinor: number;
  /** The slice the LTV rule does not cover: approved − (approved × LTV). */
  unfinancedPortionMinor: number;
  /** Customer money actually absorbed by this purchase amount. */
  customerFirstPaymentAppliedMinor: number;
  /** Customer money beyond what the purchase amount can absorb. */
  customerFirstPaymentSurplusMinor: number;
  /** What the dealership must put in to complete the purchase amount. */
  dealerContributionMinor: number;
  /** The theoretical cap before the customer's payment is considered. */
  maximumFundableMinor: number;
}

/**
 * Splits an approved purchase amount into who funds each part of it.
 *
 * The three sources always sum back to the approved amount exactly — there is
 * an invariant test on that — so no rounding residue can leak into the ledger.
 *
 * A customer whose first payment exceeds the unfinanced slice reduces what the
 * financing company has to advance rather than creating a dealer windfall, and
 * anything beyond the whole purchase amount is reported as surplus instead of
 * being silently absorbed.
 */
export function computeFundingComposition(
  input: FundingCompositionInput
): FundingComposition {
  assertNonNegativeMinor(input.approvedPurchaseAmountMinor, "Approved purchase amount");
  assertNonNegativeMinor(input.customerFirstPaymentMinor, "Customer first payment");
  assertLtvPercent(input.appliedLtvPercent);

  const approved = input.approvedPurchaseAmountMinor;
  const maximumFundableMinor = roundHalfUp(approved * input.appliedLtvPercent, 100);
  const unfinancedPortionMinor = approved - maximumFundableMinor;

  const customerFirstPaymentAppliedMinor = Math.min(input.customerFirstPaymentMinor, approved);
  const customerFirstPaymentSurplusMinor =
    input.customerFirstPaymentMinor - customerFirstPaymentAppliedMinor;

  const financeCompanyFundedPortionMinor = Math.min(
    maximumFundableMinor,
    approved - customerFirstPaymentAppliedMinor
  );
  const dealerContributionMinor =
    approved - financeCompanyFundedPortionMinor - customerFirstPaymentAppliedMinor;

  return {
    financeCompanyFundedPortionMinor,
    unfinancedPortionMinor,
    customerFirstPaymentAppliedMinor,
    customerFirstPaymentSurplusMinor,
    dealerContributionMinor,
    maximumFundableMinor,
  };
}

// ---------------------------------------------------------------------------
// Submitted quotation
// ---------------------------------------------------------------------------

export interface SubmittedQuotationInput {
  /** The dealership's desired net proceeds — its normal target selling amount. */
  targetNetProceedsMinor: number;
  /** Estimated closing expenses the dealership expects to bear. Dynamic, itemized elsewhere. */
  estimatedExpensesMinor: number;
  /** What the customer can put down. */
  customerFirstPaymentMinor: number;
  /** The LTV the financing company is expected to apply. */
  appliedLtvPercent: number;
}

export interface SubmittedQuotationSuggestion {
  submittedQuotationMinor: number;
  /** The composition that quotation implies, if approved in full. */
  composition: FundingComposition;
  /** Net proceeds the quotation actually yields — may exceed target by a rounding minor unit. */
  projectedNetProceedsMinor: number;
  /**
   * True when the customer's payment already covers the whole unfinanced slice,
   * so the quotation is simply target + expenses and no dealer contribution arises.
   */
  customerCoversUnfinancedPortion: boolean;
}

/**
 * Suggests the quotation to send the financing company so the dealership lands
 * on its target net proceeds after its own contribution and closing expenses.
 *
 * ## Where the formula comes from
 *
 * The dealership receives the approved purchase amount `Q` and pays back its own
 * contribution, then bears the closing expenses:
 *
 * ```
 * net = Q − dealerContribution(Q) − expenses
 *     = Q − (Q × (1 − LTV) − firstPayment) − expenses
 *     = Q × LTV + firstPayment − expenses
 * ```
 *
 * Setting that equal to the target and solving:
 *
 * ```
 * Q = (target + expenses − firstPayment) ÷ LTV
 * ```
 *
 * Which is the dealer's confirmed example exactly: (10,500 + 625 − 500) ÷ 0.85
 * = 12,500, whose funded portion 10,625 is precisely the target plus expenses
 * less the customer's payment. The identity worth remembering is that **the
 * financing company's funded portion carries the dealership's target proceeds
 * and its closing expenses, less whatever the customer puts in.**
 *
 * Rounded *up*, so rounding never lands the dealership below its target.
 *
 * This is a suggestion. The caller is expected to let a user override it and to
 * record why — the number the dealership actually sends is a commercial
 * decision, and pretending otherwise would make the stored quotation a
 * calculated artefact rather than a real submitted document.
 */
export function computeSubmittedQuotation(
  input: SubmittedQuotationInput
): SubmittedQuotationSuggestion {
  assertNonNegativeMinor(input.targetNetProceedsMinor, "Target net proceeds");
  assertNonNegativeMinor(input.estimatedExpensesMinor, "Estimated expenses");
  assertNonNegativeMinor(input.customerFirstPaymentMinor, "Customer first payment");
  assertLtvPercent(input.appliedLtvPercent);

  const required =
    input.targetNetProceedsMinor + input.estimatedExpensesMinor - input.customerFirstPaymentMinor;

  // The customer's payment alone already meets the target and expenses: no
  // financing-company funding is needed to reach it, so quote the plain sum.
  // (Still routed through the composition below, which will show the customer
  // covering the unfinanced slice outright.)
  const financedCase =
    required > 0 ? divideCeil(required * 100, input.appliedLtvPercent) : 0;
  const cashCase = input.targetNetProceedsMinor + input.estimatedExpensesMinor;

  // Pick the branch whose own precondition holds. In the financed branch the
  // dealership must actually have something to contribute — otherwise the
  // algebra above divided by an LTV that never binds.
  let submittedQuotationMinor = financedCase;
  let customerCoversUnfinancedPortion = false;
  const financedComposition =
    financedCase > 0
      ? computeFundingComposition({
          approvedPurchaseAmountMinor: financedCase,
          appliedLtvPercent: input.appliedLtvPercent,
          customerFirstPaymentMinor: input.customerFirstPaymentMinor,
        })
      : undefined;

  if (!financedComposition || financedComposition.dealerContributionMinor <= 0) {
    submittedQuotationMinor = cashCase;
    customerCoversUnfinancedPortion = true;
  }

  const composition = computeFundingComposition({
    approvedPurchaseAmountMinor: submittedQuotationMinor,
    appliedLtvPercent: input.appliedLtvPercent,
    customerFirstPaymentMinor: input.customerFirstPaymentMinor,
  });

  const projectedNetProceedsMinor =
    submittedQuotationMinor -
    composition.dealerContributionMinor -
    input.estimatedExpensesMinor;

  return {
    submittedQuotationMinor,
    composition,
    projectedNetProceedsMinor,
    customerCoversUnfinancedPortion,
  };
}

// ---------------------------------------------------------------------------
// Appraisal gap
// ---------------------------------------------------------------------------

export interface AppraisalGapInput {
  submittedQuotationMinor: number;
  approvedDealerPurchaseAmountMinor: number;
  appliedLtvPercent: number;
}

export interface AppraisalGap {
  /** What the dealership and customer negotiate over. */
  rawAppraisalGapMinor: number;
  /**
   * How much less the financing company now funds — `gap × LTV`.
   *
   * Shown for context only. It is NOT the negotiated amount, and treating it as
   * such would understate the customer's obligation by the unfinanced share of
   * the gap.
   */
  fundingReductionMinor: number;
  /** Whether a gap resolution is required at all. */
  requiresResolution: boolean;
}

/**
 * The gap the dealership and customer must resolve.
 *
 * Measured against the **approved dealer purchase amount**, not the raw
 * appraisal: a company that accepts the submitted quotation under a tolerance
 * rule has approved at the quotation, and there is then nothing to negotiate
 * even though the appraisal came in lower. Floored at zero — an approval *above*
 * the quotation is not a negative gap the dealership owes anyone.
 */
export function computeAppraisalGap(input: AppraisalGapInput): AppraisalGap {
  assertNonNegativeMinor(input.submittedQuotationMinor, "Submitted quotation");
  assertNonNegativeMinor(
    input.approvedDealerPurchaseAmountMinor,
    "Approved dealer purchase amount"
  );
  assertLtvPercent(input.appliedLtvPercent);

  const rawAppraisalGapMinor = Math.max(
    0,
    input.submittedQuotationMinor - input.approvedDealerPurchaseAmountMinor
  );

  const fundingReductionMinor =
    roundHalfUp(input.submittedQuotationMinor * input.appliedLtvPercent, 100) -
    roundHalfUp(input.approvedDealerPurchaseAmountMinor * input.appliedLtvPercent, 100);

  return {
    rawAppraisalGapMinor,
    fundingReductionMinor: Math.max(0, fundingReductionMinor),
    requiresResolution: rawAppraisalGapMinor > 0,
  };
}

/** Where a customer's share of the gap is actually paid. */
export interface GapShareSettlement {
  customerGapShareMinor: number;
  dealerGapShareMinor: number;
  /** Customer's share settled in cash to the dealership. */
  customerGapCashToDealerMinor: number;
  /** Customer's share settled as installments payable to the dealership. */
  customerGapInstallmentToDealerMinor: number;
  /** Customer's share paid directly to the financing company — creates no dealer AR. */
  customerGapToFinanceCompanyMinor: number;
}

export interface GapShareViolation {
  code:
    | "SHARES_DO_NOT_SUM_TO_GAP"
    | "CUSTOMER_DESTINATIONS_DO_NOT_SUM_TO_SHARE"
    | "NEGATIVE_AMOUNT";
  message: string;
}

/**
 * Checks the two gap invariants the dealer confirmed.
 *
 * ```
 * customerGapShare + dealerGapShare = rawAppraisalGap
 * customerCash + customerInstallments + customerToFinanceCompany = customerGapShare
 * ```
 *
 * Returns violations rather than throwing so a UI can show every problem at
 * once while a mutation can reject on the first. Never reduce the second
 * identity to "cash + installments" — a customer paying the financing company
 * directly must not create dealer-side receivables, and dropping the
 * destination is exactly how that error gets made.
 */
export function validateGapShares(
  rawAppraisalGapMinor: number,
  settlement: GapShareSettlement
): GapShareViolation[] {
  const violations: GapShareViolation[] = [];

  const amounts: Array<[number, string]> = [
    [rawAppraisalGapMinor, "Raw appraisal gap"],
    [settlement.customerGapShareMinor, "Customer gap share"],
    [settlement.dealerGapShareMinor, "Dealer gap share"],
    [settlement.customerGapCashToDealerMinor, "Customer gap cash to dealer"],
    [settlement.customerGapInstallmentToDealerMinor, "Customer gap installments to dealer"],
    [settlement.customerGapToFinanceCompanyMinor, "Customer gap paid to financing company"],
  ];
  for (const [value, label] of amounts) {
    if (!Number.isInteger(value) || value < 0) {
      violations.push({
        code: "NEGATIVE_AMOUNT",
        message: `${label} must be a non-negative integer in minor units (got ${value}).`,
      });
    }
  }
  if (violations.length > 0) return violations;

  const sharesTotal = settlement.customerGapShareMinor + settlement.dealerGapShareMinor;
  if (sharesTotal !== rawAppraisalGapMinor) {
    violations.push({
      code: "SHARES_DO_NOT_SUM_TO_GAP",
      message: `Customer share (${settlement.customerGapShareMinor}) plus dealer share (${settlement.dealerGapShareMinor}) is ${sharesTotal}, which must equal the raw appraisal gap of ${rawAppraisalGapMinor}.`,
    });
  }

  const destinationsTotal =
    settlement.customerGapCashToDealerMinor +
    settlement.customerGapInstallmentToDealerMinor +
    settlement.customerGapToFinanceCompanyMinor;
  if (destinationsTotal !== settlement.customerGapShareMinor) {
    violations.push({
      code: "CUSTOMER_DESTINATIONS_DO_NOT_SUM_TO_SHARE",
      message: `Customer cash (${settlement.customerGapCashToDealerMinor}), installments (${settlement.customerGapInstallmentToDealerMinor}) and payments to the financing company (${settlement.customerGapToFinanceCompanyMinor}) total ${destinationsTotal}, which must equal the customer's gap share of ${settlement.customerGapShareMinor}.`,
    });
  }

  return violations;
}

/** The gap outcome implied by a share split. Derived, never stored as the source of truth. */
export type GapResolutionOutcome =
  | "NOT_REQUIRED"
  | "CUSTOMER_ABSORBS"
  | "DEALER_ABSORBS"
  | "SPLIT";

export function classifyGapResolution(
  rawAppraisalGapMinor: number,
  customerGapShareMinor: number,
  dealerGapShareMinor: number
): GapResolutionOutcome {
  if (rawAppraisalGapMinor <= 0) return "NOT_REQUIRED";
  if (dealerGapShareMinor === 0) return "CUSTOMER_ABSORBS";
  if (customerGapShareMinor === 0) return "DEALER_ABSORBS";
  return "SPLIT";
}

// ---------------------------------------------------------------------------
// Expected remittance and dealer proceeds
// ---------------------------------------------------------------------------

/** How the financing company settles the dealer's contribution. */
export type DealerContributionSettlement = "PAID_SEPARATELY" | "NETTED_FROM_REMITTANCE";
/** Whether customer money collected by the financing company is passed on to the dealer. */
export type CustomerContributionSettlement = "PASSED_THROUGH" | "RETAINED_BY_COMPANY";

export interface ExpectedRemittanceInput {
  approvedDealerPurchaseAmountMinor: number;
  dealerContributionMinor: number;
  dealerContributionSettlement: DealerContributionSettlement;
  /** Customer money paid to the financing company rather than the dealership. */
  customerContributionToFinanceCompanyMinor: number;
  customerContributionSettlement: CustomerContributionSettlement;
  /** Fees the financing company withholds from the remittance. */
  feeDeductionsMinor: number;
}

export interface ExpectedRemittance {
  /** Before deductions — the headline the settlement lines must sum to. */
  grossRemittanceMinor: number;
  /** What should actually land in the dealership's account. */
  expectedDealerRemittanceMinor: number;
  totalDeductionsMinor: number;
}

/**
 * What the financing company should actually pay the dealership.
 *
 * Companies differ on two axes and both are real, so both are configured rather
 * than assumed: whether the dealer's contribution is wired separately or simply
 * netted out of the remittance, and whether customer money the company collects
 * is passed through to the dealer inside the purchase price or retained.
 *
 * Floored at zero. Deductions larger than the gross mean the dealership owes the
 * financing company, which is a payable, not a negative receivable — the caller
 * is told via `totalDeductionsMinor` and must handle it explicitly.
 */
export function computeExpectedRemittance(
  input: ExpectedRemittanceInput
): ExpectedRemittance {
  assertNonNegativeMinor(
    input.approvedDealerPurchaseAmountMinor,
    "Approved dealer purchase amount"
  );
  assertNonNegativeMinor(input.dealerContributionMinor, "Dealer contribution");
  assertNonNegativeMinor(
    input.customerContributionToFinanceCompanyMinor,
    "Customer contribution to financing company"
  );
  assertNonNegativeMinor(input.feeDeductionsMinor, "Fee deductions");

  const grossRemittanceMinor =
    input.customerContributionSettlement === "RETAINED_BY_COMPANY"
      ? Math.max(
          0,
          input.approvedDealerPurchaseAmountMinor -
            input.customerContributionToFinanceCompanyMinor
        )
      : input.approvedDealerPurchaseAmountMinor;

  const totalDeductionsMinor =
    input.feeDeductionsMinor +
    (input.dealerContributionSettlement === "NETTED_FROM_REMITTANCE"
      ? input.dealerContributionMinor
      : 0);

  return {
    grossRemittanceMinor,
    expectedDealerRemittanceMinor: Math.max(0, grossRemittanceMinor - totalDeductionsMinor),
    totalDeductionsMinor,
  };
}

export interface DealerProceedsInput {
  approvedDealerPurchaseAmountMinor: number;
  dealerContributionMinor: number;
  /** Gap amounts the customer owes the dealership directly (cash + installments). */
  customerDirectToDealerMinor: number;
  /** Every closing expense the dealership ends up bearing, however it was paid. */
  dealerBorneExpensesMinor: number;
  /** The vehicle's capitalized cost. */
  vehicleCostMinor: number;
}

export interface DealerProceeds {
  grossProceedsMinor: number;
  netProceedsMinor: number;
  profitMinor: number;
}

/**
 * The dealership's real economics on the deal.
 *
 * Note what is deliberately absent: the dealer's share of an appraisal gap is
 * not subtracted here. It is already expressed by the lower approved purchase
 * amount, and subtracting it again would double-count it. The visible
 * consequence is that a dealer absorbing a gap of G loses `G × LTV` of profit,
 * not G — because its own required contribution falls by `G × (1 − LTV)` at the
 * same time. That is arithmetically correct and worth surfacing to the user
 * rather than hiding, but it is emphatically not the amount being negotiated:
 * the customer's obligation is always the raw gap.
 */
export function computeDealerProceeds(input: DealerProceedsInput): DealerProceeds {
  assertNonNegativeMinor(
    input.approvedDealerPurchaseAmountMinor,
    "Approved dealer purchase amount"
  );
  assertNonNegativeMinor(input.dealerContributionMinor, "Dealer contribution");
  assertNonNegativeMinor(input.customerDirectToDealerMinor, "Customer direct payments to dealer");
  assertNonNegativeMinor(input.dealerBorneExpensesMinor, "Dealer-borne expenses");
  assertNonNegativeMinor(input.vehicleCostMinor, "Vehicle cost");

  const grossProceedsMinor =
    input.approvedDealerPurchaseAmountMinor + input.customerDirectToDealerMinor;
  const netProceedsMinor =
    grossProceedsMinor - input.dealerContributionMinor - input.dealerBorneExpensesMinor;

  return {
    grossProceedsMinor,
    netProceedsMinor,
    profitMinor: netProceedsMinor - input.vehicleCostMinor,
  };
}

// ---------------------------------------------------------------------------
// Financing-company exception rules
// ---------------------------------------------------------------------------

export interface QuotationExceptionInput {
  submittedQuotationMinor: number;
  independentAppraisalMinor: number;
  /** Whether the company may approve at the quotation when the appraisal is lower. */
  allowsQuotationAboveAppraisal: boolean;
  /** How far below the quotation the appraisal may fall and still qualify, in percent. */
  lowerAppraisalTolerancePercent: number;
}

export interface QuotationExceptionEvaluation {
  /** How far below the quotation the appraisal actually came in, in percent. */
  shortfallPercent: number;
  /** Whether the company's configured rule permits approving at the quotation. */
  eligible: boolean;
  /** Why not, when ineligible. */
  reason?: "NOT_ALLOWED" | "OUTSIDE_TOLERANCE" | "NO_SHORTFALL";
}

/**
 * Whether a company's tolerance rule lets it approve at the submitted quotation
 * despite a lower appraisal.
 *
 * Eligibility is not approval. The rule says the exception *may* be applied; a
 * human with the right permission still records the approved purchase amount and
 * the basis, because whether the company actually granted it is a fact about the
 * real world that no formula can determine.
 */
export function evaluateQuotationException(
  input: QuotationExceptionInput
): QuotationExceptionEvaluation {
  assertNonNegativeMinor(input.submittedQuotationMinor, "Submitted quotation");
  assertNonNegativeMinor(input.independentAppraisalMinor, "Independent appraisal");
  if (!Number.isFinite(input.lowerAppraisalTolerancePercent) ||
      input.lowerAppraisalTolerancePercent < 0) {
    throw new FinancingEconomicsError(
      `Lower-appraisal tolerance must be a non-negative percentage (got ${input.lowerAppraisalTolerancePercent}).`
    );
  }

  if (input.submittedQuotationMinor === 0) {
    return { shortfallPercent: 0, eligible: false, reason: "NO_SHORTFALL" };
  }

  const shortfallMinor = input.submittedQuotationMinor - input.independentAppraisalMinor;
  if (shortfallMinor <= 0) {
    return { shortfallPercent: 0, eligible: false, reason: "NO_SHORTFALL" };
  }

  const shortfallPercent = (shortfallMinor * 100) / input.submittedQuotationMinor;

  if (!input.allowsQuotationAboveAppraisal) {
    return { shortfallPercent, eligible: false, reason: "NOT_ALLOWED" };
  }
  if (shortfallPercent > input.lowerAppraisalTolerancePercent) {
    return { shortfallPercent, eligible: false, reason: "OUTSIDE_TOLERANCE" };
  }
  return { shortfallPercent, eligible: true };
}

// ---------------------------------------------------------------------------
// Employee closing-expense custody
// ---------------------------------------------------------------------------

export interface CustodyReconciliationInput {
  advanceIssuedMinor: number;
  employeePersonalPaymentMinor: number;
  actualExpensesMinor: number;
  employeeReturnedMinor: number;
}

export interface CustodyReconciliation {
  /**
   * What is still unaccounted for.
   *
   * Positive: the employee holds money not yet returned or spent.
   * Negative: the dealership owes the employee a reimbursement.
   */
  remainingEmployeeBalanceMinor: number;
  /** Owed back to the employee, when they spent more than they were given. */
  dealerReimbursementDueMinor: number;
  /** Still held by the employee and owed back to the dealership. */
  employeeOwesDealerMinor: number;
  /** True only when nothing is left outstanding in either direction. */
  reconciled: boolean;
}

/**
 * Closes the employee custody identity:
 *
 * ```
 * advanceIssued + employeePersonalPayment
 *   = actualExpenses + employeeReturned + remainingEmployeeBalance
 * ```
 *
 * The balance is signed on purpose. An advance of 700 against 650 of expenses
 * with 50 returned reconciles to zero; the same advance against 750 of expenses
 * with 50 paid personally leaves the dealership owing the employee 50. Collapsing
 * those into one unsigned "variance" is how a reimbursement silently becomes a
 * shortage.
 */
export function reconcileEmployeeCustody(
  input: CustodyReconciliationInput
): CustodyReconciliation {
  assertNonNegativeMinor(input.advanceIssuedMinor, "Advance issued");
  assertNonNegativeMinor(input.employeePersonalPaymentMinor, "Employee personal payment");
  assertNonNegativeMinor(input.actualExpensesMinor, "Actual expenses");
  assertNonNegativeMinor(input.employeeReturnedMinor, "Amount returned by employee");

  const remainingEmployeeBalanceMinor =
    input.advanceIssuedMinor +
    input.employeePersonalPaymentMinor -
    input.actualExpensesMinor -
    input.employeeReturnedMinor;

  return {
    remainingEmployeeBalanceMinor,
    dealerReimbursementDueMinor: Math.max(0, -remainingEmployeeBalanceMinor),
    employeeOwesDealerMinor: Math.max(0, remainingEmployeeBalanceMinor),
    reconciled: remainingEmployeeBalanceMinor === 0,
  };
}

// ---------------------------------------------------------------------------
// Settlement reconciliation
// ---------------------------------------------------------------------------

export interface SettlementReconciliationInput {
  expectedDealerRemittanceMinor: number;
  /** Sum of the expected amounts across the deal's settlement lines. */
  expectedSettlementLinesTotalMinor: number;
  actualDealerReceiptTotalMinor: number;
  /** Sum of the actual amounts across the deal's receipt lines. */
  actualReceiptLinesTotalMinor: number;
  /** Variance a user has explicitly approved with a reason on record. */
  approvedAdjustmentMinor: number;
}

export interface SettlementReconciliation {
  expectedLinesBalanced: boolean;
  actualLinesBalanced: boolean;
  /** Actual receipts less what was expected, after any approved adjustment. */
  unexplainedVarianceMinor: number;
  fullySettled: boolean;
  reconciled: boolean;
}

/**
 * Reconciles a deal's settlement, keeping the two identities the dealer needs:
 *
 * ```
 * expectedSettlementLinesTotal = expectedDealerRemittance
 * actualReceiptLinesTotal      = actualDealerReceiptTotal
 * ```
 *
 * An unexplained variance is reported, never absorbed. Loosening the old exact
 * equality in `confirmDisbursement` is the point of this — real remittances
 * arrive short, late and in pieces — but "the amount is allowed to differ" and
 * "nobody has to say why" are different changes and only the first is wanted.
 */
export function reconcileSettlement(
  input: SettlementReconciliationInput
): SettlementReconciliation {
  const expectedLinesBalanced =
    input.expectedSettlementLinesTotalMinor === input.expectedDealerRemittanceMinor;
  const actualLinesBalanced =
    input.actualReceiptLinesTotalMinor === input.actualDealerReceiptTotalMinor;

  const unexplainedVarianceMinor =
    input.actualDealerReceiptTotalMinor -
    input.expectedDealerRemittanceMinor -
    input.approvedAdjustmentMinor;

  const fullySettled = unexplainedVarianceMinor === 0;

  return {
    expectedLinesBalanced,
    actualLinesBalanced,
    unexplainedVarianceMinor,
    fullySettled,
    reconciled: expectedLinesBalanced && actualLinesBalanced && fullySettled,
  };
}
