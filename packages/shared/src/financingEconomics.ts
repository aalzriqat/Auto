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
 * Decimal places kept when a percentage is pinned to an exact integer.
 *
 * Six is far beyond any real LTV or tolerance a finance company quotes, and
 * small enough that the products below stay well inside BigInt's comfortable
 * range.
 */
export const PERCENT_DECIMAL_PLACES = 6;
const PERCENT_SCALE = BigInt(10 ** PERCENT_DECIMAL_PLACES);
/** Denominator for `amount × percent`: 100 (the percent) × PERCENT_SCALE. */
const PERCENT_DENOMINATOR = BigInt(100) * PERCENT_SCALE;
// Written as calls rather than `0n`/`1n`/`2n`: the app's root tsconfig targets
// ES2017, where BigInt *literals* are a syntax error, while the BigInt global
// itself is typed through `lib: esnext` and available everywhere this runs.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

/**
 * Pins a human percentage to an exact scaled integer.
 *
 * `85` and `64.6` are decimal quantities a person typed, but neither survives
 * binary floating point intact — `250 * 64.6` evaluates to 16149.999999999998,
 * not 16150. Rounding the float to six decimals recovers the value that was
 * actually meant, once, at the boundary; every calculation downstream is exact
 * integer arithmetic on the result.
 */
function toScaledPercent(percent: number): bigint {
  const scaled = Math.round(percent * Number(PERCENT_SCALE));
  if (!Number.isSafeInteger(scaled)) {
    throw new FinancingEconomicsError(`Percentage ${percent} cannot be represented exactly.`);
  }
  return BigInt(scaled);
}

/**
 * Whether a positive percentage vanishes at the scale the engine keeps.
 *
 * Exported so a caller validating a stored setting tests the same boundary the
 * arithmetic will later apply, instead of restating the scale. Restating it is
 * how the settings form came to promise `0.000001%` as the minimum when the
 * rounding actually admits half of that — a value that saved cleanly and then
 * divided by zero on every quotation.
 */
export function percentRoundsToZero(percent: number): boolean {
  return Math.round(percent * Number(PERCENT_SCALE)) === 0;
}

function fromBigInt(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new FinancingEconomicsError(`${label} overflows safe integer range.`);
  }
  return Number(value);
}

/**
 * `amount × percent`, rounded half-up, exactly.
 *
 * Deliberately not `Math.floor(x / y + 0.5)` on floating-point operands, which
 * is what this used to be: for 250 minor units at 64.6% the true product is
 * 161.5 and half-up gives 162, but the float product lands a hair below 16150
 * and the result came out 161. The composition still summed to the approved
 * amount — the lost unit silently moved to the dealer's contribution — so
 * nothing failed loudly. That is the worst shape a money bug can have.
 *
 * Half-up rather than banker's rounding, and every operand here is
 * non-negative, so `floor((2n + d) / 2d)` is the whole rule.
 */
function percentOf(amountMinor: number, percent: number): number {
  const numerator = BigInt(amountMinor) * toScaledPercent(percent);
  const rounded = (TWO * numerator + PERCENT_DENOMINATOR) / (TWO * PERCENT_DENOMINATOR);
  return fromBigInt(rounded, "Rounded amount");
}

/**
 * The smallest amount whose `percent` share covers `amountMinor`, exactly.
 *
 * Same floating-point hazard in the other direction: 82 ÷ 65.6% is exactly 125,
 * but the float quotient is 125.00000000000001 and `Math.ceil` returned 126 —
 * quoting the finance company one minor unit more than the dealership needed,
 * every time the division happened to land just above an integer.
 */
function divideByPercentCeil(amountMinor: number, percent: number): number {
  const scaledPercent = toScaledPercent(percent);
  if (scaledPercent <= ZERO) {
    throw new FinancingEconomicsError("Cannot divide by a non-positive percentage.");
  }
  const numerator = BigInt(amountMinor) * PERCENT_DENOMINATOR;
  // Ceiling division on non-negative integers.
  const result = (numerator + scaledPercent - ONE) / scaledPercent;
  return fromBigInt(result, "Computed amount");
}

// ---------------------------------------------------------------------------
// Funding composition
// ---------------------------------------------------------------------------

/** What a finance company's LTV percentage is applied to. */
export type LtvBasis =
  | "INDEPENDENT_APPRAISAL"
  | "SUBMITTED_QUOTATION"
  | "APPROVED_PURCHASE_AMOUNT"
  | "LOWER_OF_APPRAISAL_AND_QUOTATION";

export interface LtvBaseAmounts {
  approvedPurchaseAmountMinor: number;
  submittedQuotationMinor?: number;
  independentAppraisalMinor?: number;
}

/**
 * The amount a company's LTV percentage actually multiplies.
 *
 * Companies differ, and the difference is real money: at 85% on an approval of
 * 12,500 against an appraisal of 11,500, an APPROVED_PURCHASE_AMOUNT basis
 * funds 10,625 while an INDEPENDENT_APPRAISAL basis funds 9,775 — an 850
 * swing in what the dealership has to contribute.
 *
 * Returns `undefined` when the configured basis names an amount that has not
 * been recorded. Substituting the approved amount instead reads as a safe
 * fallback and is not one: a company configured to lend against the appraisal,
 * approving manually with no appraisal on file, would silently have its funding
 * computed against a *different and larger* basis — understating the
 * dealership's own required contribution. The caller's job is to leave the
 * economics unwritten until the fact exists, not to compute them from a
 * substitute.
 */
export function resolveLtvBaseMinor(
  basis: LtvBasis | undefined,
  amounts: LtvBaseAmounts
): number | undefined {
  switch (basis) {
    case "INDEPENDENT_APPRAISAL":
      return amounts.independentAppraisalMinor;
    case "SUBMITTED_QUOTATION":
      return amounts.submittedQuotationMinor;
    case "LOWER_OF_APPRAISAL_AND_QUOTATION":
      // "Lower of two" needs both. With one operand it is not a lower-of rule,
      // it is whichever happened to be recorded first.
      return amounts.independentAppraisalMinor !== undefined &&
        amounts.submittedQuotationMinor !== undefined
        ? Math.min(amounts.independentAppraisalMinor, amounts.submittedQuotationMinor)
        : undefined;
    case "APPROVED_PURCHASE_AMOUNT":
    default:
      return amounts.approvedPurchaseAmountMinor;
  }
}

export interface FundingCompositionInput {
  /** What the financing company will actually buy the vehicle at. */
  approvedPurchaseAmountMinor: number;
  /** The LTV rule actually applied, as a percentage (85 means 85%). */
  appliedLtvPercent: number;
  /** What the customer pays toward the purchase amount, whoever receives it. */
  customerFirstPaymentMinor: number;
  /**
   * What the LTV multiplies, when the company's rule is not "the approved
   * purchase amount". Defaults to the approved amount.
   */
  ltvBaseMinor?: number;
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
  /**
   * True when the LTV base produced a figure above the approved amount and was
   * clamped to it. Surfaced rather than absorbed: a SUBMITTED_QUOTATION basis
   * on a 20,000 quotation against an 11,500 approval reports a zero dealer
   * contribution, which is arithmetically right and almost certainly a
   * misconfiguration worth showing someone.
   */
  ltvBaseCapApplied: boolean;
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
  if (input.ltvBaseMinor !== undefined) {
    assertNonNegativeMinor(input.ltvBaseMinor, "LTV base amount");
  }

  const approved = input.approvedPurchaseAmountMinor;
  const ltvBase = input.ltvBaseMinor ?? approved;
  // Capped at the approved amount: a base larger than what the company is
  // actually buying at (an LTV applied to the submitted quotation after a lower
  // approval, say) would otherwise compute a funded portion exceeding the whole
  // purchase and drive the unfinanced slice negative.
  const uncappedFundableMinor = percentOf(ltvBase, input.appliedLtvPercent);
  const maximumFundableMinor = Math.min(uncappedFundableMinor, approved);
  const ltvBaseCapApplied = uncappedFundableMinor > approved;
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
    ltvBaseCapApplied,
  };
}

// ---------------------------------------------------------------------------
// Submitted quotation
// ---------------------------------------------------------------------------

export interface SubmittedQuotationInput {
  /** The dealership's desired net proceeds — its normal target selling amount. */
  targetNetProceedsMinor: number;
  /**
   * Sum of the itemized closing costs the dealership expects to BEAR.
   *
   * A real cost. Never inferred: if nobody has itemized the fees, this is zero
   * and the suggested quotation is correspondingly lower, which is the honest
   * answer rather than a fabricated allowance.
   */
  estimatedDealerBorneExpensesMinor: number;
  /**
   * Optional negotiation headroom — a commercial choice, not a cost.
   *
   * Deliberately separate from expenses even though the arithmetic treats them
   * alike, because the books must not learn to believe a buffer is money spent.
   */
  quotationBufferMinor?: number;
  /** What the customer can put down. */
  customerFirstPaymentMinor: number;
  /** The LTV the financing company is expected to apply. */
  appliedLtvPercent: number;
  /**
   * The company's rule: does the customer's first payment offset the unfinanced
   * share? The solver's algebra depends on it and it is not universal, so an
   * unrecorded rule makes the solver unavailable rather than assumed.
   */
  customerFirstPaymentOffsetsUnfinancedShare: boolean | undefined;
}

/** Why the solver cannot produce a figure. */
export type QuotationSolverUnavailableReason =
  /** The company's rule on whether the customer's payment offsets the unfinanced share is unrecorded. */
  | "OFFSET_RULE_UNKNOWN"
  /** The company's rule says it does not, so this algebra does not describe the deal. */
  | "OFFSET_RULE_DOES_NOT_APPLY";

export interface SubmittedQuotationSuggestion {
  submittedQuotationMinor: number;
  /** The composition that quotation implies, if approved in full. */
  composition: FundingComposition;
  /** Net proceeds the quotation actually yields — may exceed target by rounding. */
  projectedNetProceedsMinor: number;
  /**
   * True when the customer's payment already covers the whole unfinanced slice,
   * so the quotation is simply target + expenses + buffer and no dealer
   * contribution arises.
   */
  customerCoversUnfinancedPortion: boolean;
  /** Echoed back so the caller can snapshot exactly what produced this figure. */
  inputs: SubmittedQuotationInput;
}

export type SubmittedQuotationResult =
  | ({ available: true } & SubmittedQuotationSuggestion)
  | { available: false; reason: QuotationSolverUnavailableReason };

/**
 * An OPTIONAL solver for the quotation to send the financing company.
 *
 * ## What this is, and is not
 *
 * It is one way to pick a quotation, available when the selected company's
 * rules confirm it applies. It is **not** the domain rule, and a dealership is
 * free to type a figure it negotiated instead — see the three calculation modes
 * the caller must support.
 *
 * ## The algebra, and its precondition
 *
 * When the customer's first payment offsets the unfinanced share, the
 * dealership receives the approved purchase amount `Q`, pays in its own
 * contribution, and bears its expenses:
 *
 * ```
 * net = Q − dealerContribution(Q) − expenses − buffer
 *     = Q − (Q × (1 − LTV) − customerContribution) − expenses − buffer
 *     = Q × LTV + customerContribution − expenses − buffer
 * ```
 *
 * Setting that equal to the target and solving:
 *
 * ```
 * Q = (target + expenses + buffer − applicable customer contribution) ÷ LTV
 * ```
 *
 * That precondition is a real per-company fact, not a universal truth, so it is
 * passed in explicitly and the solver refuses rather than guessing when it is
 * unrecorded. Different companies structure the unfinanced share differently.
 *
 * ## The inputs are separate on purpose
 *
 * `estimatedDealerBorneExpensesMinor` is the sum of itemized costs the
 * dealership actually expects to bear. `quotationBufferMinor` is negotiation
 * headroom — a commercial choice, not a cost. They behave identically in the
 * arithmetic and mean entirely different things, and collapsing them into one
 * "expenses" figure is how a buffer silently becomes a cost the books believe
 * in. Both default to zero; neither is ever inferred.
 *
 * Rounded *up*, so rounding never lands the dealership below its target.
 */
export function computeSubmittedQuotation(
  input: SubmittedQuotationInput
): SubmittedQuotationResult {
  if (input.customerFirstPaymentOffsetsUnfinancedShare === undefined) {
    return { available: false, reason: "OFFSET_RULE_UNKNOWN" };
  }
  if (!input.customerFirstPaymentOffsetsUnfinancedShare) {
    return { available: false, reason: "OFFSET_RULE_DOES_NOT_APPLY" };
  }

  assertNonNegativeMinor(input.targetNetProceedsMinor, "Target net proceeds");
  assertNonNegativeMinor(
    input.estimatedDealerBorneExpensesMinor,
    "Estimated dealer-borne expenses"
  );
  assertNonNegativeMinor(input.quotationBufferMinor ?? 0, "Quotation buffer");
  assertNonNegativeMinor(input.customerFirstPaymentMinor, "Customer first payment");
  assertLtvPercent(input.appliedLtvPercent);

  const buffer = input.quotationBufferMinor ?? 0;
  const dealerSideTotal =
    input.targetNetProceedsMinor + input.estimatedDealerBorneExpensesMinor + buffer;
  const required = dealerSideTotal - input.customerFirstPaymentMinor;

  // The customer's payment alone already meets the dealer-side total: no
  // financing-company funding is needed to reach it, so quote the plain sum.
  const financedCase =
    required > 0 ? divideByPercentCeil(required, input.appliedLtvPercent) : 0;
  const cashCase = dealerSideTotal;

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

  // The buffer is headroom the dealership expects to keep, so it is NOT
  // subtracted here — only real expenses reduce proceeds. That is precisely the
  // distinction collapsing the two inputs would destroy.
  const projectedNetProceedsMinor =
    submittedQuotationMinor -
    composition.dealerContributionMinor -
    input.estimatedDealerBorneExpensesMinor;

  return {
    available: true,
    submittedQuotationMinor,
    composition,
    projectedNetProceedsMinor,
    customerCoversUnfinancedPortion,
    inputs: input,
  };
}

// ---------------------------------------------------------------------------
// Residual reporting
// ---------------------------------------------------------------------------

export interface QuotationResidual {
  /** What the structure nets the dealership before any expense is deducted. */
  proceedsBeforeExpensesMinor: number;
  /**
   * Proceeds-before-expenses less the target.
   *
   * Deliberately unclassified. It may be closing expenses, negotiation
   * headroom, a company commission, or simply that the quotation was a
   * negotiated round number and this is what falls out. The system cannot tell
   * which, so it reports the number and names none of them.
   */
  unreconciledResidualMinor: number;
}

/**
 * Reports the gap between what a quotation actually nets and the stated target,
 * without deciding what the gap is.
 *
 * Exists because the temptation to classify it is exactly the mistake to avoid.
 * Working backwards from a quotation of 12,500 against a target of 10,500
 * yields a residual of 625 — and calling that "closing expenses" would turn an
 * arithmetic leftover into a business fact nobody stated. Show it; let a person
 * say what it is.
 */
export function describeQuotationResidual(args: {
  submittedQuotationMinor: number;
  targetNetProceedsMinor: number;
  dealerContributionMinor: number;
}): QuotationResidual {
  const proceedsBeforeExpensesMinor =
    args.submittedQuotationMinor - args.dealerContributionMinor;
  return {
    proceedsBeforeExpensesMinor,
    unreconciledResidualMinor: proceedsBeforeExpensesMinor - args.targetNetProceedsMinor,
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
    percentOf(input.submittedQuotationMinor, input.appliedLtvPercent) -
    percentOf(input.approvedDealerPurchaseAmountMinor, input.appliedLtvPercent);

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

export interface GapOutcomeInput {
  submittedQuotationMinor: number;
  approvedDealerPurchaseAmountMinor: number;
  appliedLtvPercent: number;
  customerFirstPaymentMinor: number;
  /** The dealership's original target, to measure the outcome against. */
  targetNetProceedsMinor: number;
  /** Itemized costs the dealership bears. Never inferred. */
  dealerBorneExpensesMinor: number;
  vehicleCostMinor: number;
  /** The negotiated split of the RAW gap. */
  customerGapShareMinor: number;
  dealerGapShareMinor: number;
  /** The part of the customer's share actually payable to the dealership. */
  customerGapPaymentToDealerMinor: number;
}

/**
 * Every figure the dealership needs to see side by side when an appraisal comes
 * in low — reported separately, never netted into one headline.
 */
export interface GapOutcome {
  /** What the parties negotiate: quotation − approved amount. */
  rawAppraisalGapMinor: number;
  /** How much less the company funds. Context only, never the negotiated figure. */
  fundedPortionReductionMinor: number;
  /** What the dealership would have contributed at the original quotation. */
  originalDealerContributionMinor: number;
  /** What it contributes at the approved amount — lower, because the purchase is lower. */
  recalculatedDealerContributionMinor: number;
  /** The customer's share actually reaching the dealership. */
  customerGapPaymentToDealerMinor: number;
  dealerGapShareMinor: number;
  finalProjectedDealerNetProceedsMinor: number;
  /** Signed: positive means the outcome beats the original target. */
  varianceFromTargetNetProceedsMinor: number;
  finalProjectedProfitMinor: number;
  /** Set whenever the outcome differs from target in either direction. */
  proceedsDifferFromTarget: boolean;
}

/**
 * The full picture of a lower approval, with nothing reallocated.
 *
 * A customer who absorbs the whole raw gap can leave the dealership *better
 * off* than the original deal — in the confirmed example, 10,650 against a
 * 10,500 target — because the dealership's own required contribution falls from
 * 1,375 to 1,225 at the same time as the customer pays the full 1,000. That is
 * an arithmetic consequence of the confirmed commercial rule, not a defect, and
 * it must NOT be smoothed away by quietly adjusting the shares: the customer's
 * obligation is the raw gap, and the split is what the parties agreed.
 *
 * So every component is returned separately and the variance is flagged for a
 * human to look at. Netting them into a single "profit" figure is what hides
 * the 150 and makes the allocation look wrong.
 */
export function computeGapOutcome(input: GapOutcomeInput): GapOutcome {
  const originalComposition = computeFundingComposition({
    approvedPurchaseAmountMinor: input.submittedQuotationMinor,
    appliedLtvPercent: input.appliedLtvPercent,
    customerFirstPaymentMinor: input.customerFirstPaymentMinor,
  });
  const recalculatedComposition = computeFundingComposition({
    approvedPurchaseAmountMinor: input.approvedDealerPurchaseAmountMinor,
    appliedLtvPercent: input.appliedLtvPercent,
    customerFirstPaymentMinor: input.customerFirstPaymentMinor,
  });

  const gap = computeAppraisalGap({
    submittedQuotationMinor: input.submittedQuotationMinor,
    approvedDealerPurchaseAmountMinor: input.approvedDealerPurchaseAmountMinor,
    appliedLtvPercent: input.appliedLtvPercent,
  });

  const proceeds = computeDealerProceeds({
    approvedDealerPurchaseAmountMinor: input.approvedDealerPurchaseAmountMinor,
    dealerContributionMinor: recalculatedComposition.dealerContributionMinor,
    customerDirectToDealerMinor: input.customerGapPaymentToDealerMinor,
    dealerBorneExpensesMinor: input.dealerBorneExpensesMinor,
    vehicleCostMinor: input.vehicleCostMinor,
  });

  const varianceFromTargetNetProceedsMinor =
    proceeds.netProceedsMinor - input.targetNetProceedsMinor;

  return {
    rawAppraisalGapMinor: gap.rawAppraisalGapMinor,
    fundedPortionReductionMinor: gap.fundingReductionMinor,
    originalDealerContributionMinor: originalComposition.dealerContributionMinor,
    recalculatedDealerContributionMinor: recalculatedComposition.dealerContributionMinor,
    customerGapPaymentToDealerMinor: input.customerGapPaymentToDealerMinor,
    dealerGapShareMinor: input.dealerGapShareMinor,
    finalProjectedDealerNetProceedsMinor: proceeds.netProceedsMinor,
    varianceFromTargetNetProceedsMinor,
    finalProjectedProfitMinor: proceeds.profitMinor,
    proceedsDifferFromTarget: varianceFromTargetNetProceedsMinor !== 0,
  };
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

  // Reported for display, so a float is fine here.
  const shortfallPercent = (shortfallMinor * 100) / input.submittedQuotationMinor;

  if (!input.allowsQuotationAboveAppraisal) {
    return { shortfallPercent, eligible: false, reason: "NOT_ALLOWED" };
  }
  // The decision, though, is exact. Comparing the float percentage against the
  // tolerance would let an appraisal exactly on the boundary fall either side
  // depending on which decimals happened to survive the division — and that
  // boundary is the difference between a deal the company will fund and one it
  // will not. Cross-multiplied: shortfall/quotation > tolerance/100.
  const outsideTolerance =
    BigInt(shortfallMinor) * PERCENT_DENOMINATOR >
    BigInt(input.submittedQuotationMinor) * toScaledPercent(input.lowerAppraisalTolerancePercent);
  if (outsideTolerance) {
    return { shortfallPercent, eligible: false, reason: "OUTSIDE_TOLERANCE" };
  }
  return { shortfallPercent, eligible: true };
}

// ---------------------------------------------------------------------------
// Employee closing-expense custody
// ---------------------------------------------------------------------------

export interface CustodyReconciliationInput {
  advanceIssuedMinor: number;
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
  /**
   * How much of the employee's own money went into the deal, DERIVED.
   *
   * Never an input. It is the arithmetic consequence of expenses exceeding the
   * net advance, and taking it as a separate figure meant a caller who
   * dutifully recorded "they put in 50 of their own" added it to the same side
   * as the advance — cancelling the debt, driving
   * `dealerReimbursementDueMinor` from 50 to zero and flipping `reconciled` to
   * true. That is the reimbursement silently becoming a shortage that this
   * function exists to prevent, reached through its own argument list.
   */
  employeeFundedFromOwnPocketMinor: number;
  /** True only when nothing is left outstanding in either direction. */
  reconciled: boolean;
}

/**
 * Closes the employee custody identity:
 *
 * ```
 * advanceIssued - employeeReturned - actualExpenses = remainingEmployeeBalance
 * ```
 *
 * The balance is signed on purpose. An advance of 700 against 650 of expenses
 * with 50 returned reconciles to zero; the same advance against 750 of expenses
 * leaves the dealership owing the employee 50, because the employee covered
 * that 50 themselves. Collapsing those into one unsigned "variance" is how a
 * reimbursement silently becomes a shortage.
 *
 * ## Why the employee's own money is not an input
 *
 * It used to be, added on the same side as the advance — and that quietly
 * cancelled the very debt the signed balance exists to surface. Recording "the
 * employee put in 50 of their own" against a 700 advance and 750 of expenses
 * took `dealerReimbursementDueMinor` from 50 to zero and reported
 * `reconciled: true`, so a dealership that documented its employee's
 * contribution most carefully was the one that erased it. The contribution is
 * not independent information: it is exactly the amount by which expenses
 * exceed what the employee was given and did not return, so it is derived here
 * and cannot disagree with the balance.
 */
export function reconcileEmployeeCustody(
  input: CustodyReconciliationInput
): CustodyReconciliation {
  assertNonNegativeMinor(input.advanceIssuedMinor, "Advance issued");
  assertNonNegativeMinor(input.actualExpensesMinor, "Actual expenses");
  assertNonNegativeMinor(input.employeeReturnedMinor, "Amount returned by employee");

  const remainingEmployeeBalanceMinor =
    input.advanceIssuedMinor - input.employeeReturnedMinor - input.actualExpensesMinor;

  return {
    remainingEmployeeBalanceMinor,
    dealerReimbursementDueMinor: Math.max(0, -remainingEmployeeBalanceMinor),
    employeeOwesDealerMinor: Math.max(0, remainingEmployeeBalanceMinor),
    employeeFundedFromOwnPocketMinor: Math.max(0, -remainingEmployeeBalanceMinor),
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
