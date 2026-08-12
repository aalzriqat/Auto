import { ConvexError, v } from "convex/values";
import { Doc } from "../_generated/dataModel";
import { toMinorSameCurrencyOrUndefined } from "./money";
import {
  PERCENT_DECIMAL_PLACES,
  percentRoundsToZero,
  computeAppraisalGap,
  computeDealerProceeds,
  computeExpectedRemittance,
  computeFundingComposition,
  evaluateQuotationException,
  resolveLtvBaseMinor,
  validateGapShares,
  type CustomerContributionSettlement,
  type DealerContributionSettlement,
  type LtvBasis,
} from "../../lib/financingEconomics";

// Pass-throughs, re-exported directly so they do not sit in this module's local
// scope pretending to be used here.
export { classifyGapResolution, evaluateQuotationException } from "../../lib/financingEconomics";

/**
 * Server-side vocabulary and invariants for the dealer side of a financed sale.
 *
 * The arithmetic itself lives in `packages/shared/src/financingEconomics.ts` so
 * the wizard, the mobile app, the backend and the reports cannot drift apart.
 * What lives here is everything that needs a Convex document to be meaningful:
 * the validators, the rule snapshot, and the guards that refuse to persist a
 * state the dealership could not explain to an auditor.
 *
 * Nothing here trusts a number the client computed. The client may show the
 * same figures — it uses the same module — but every stored value is recomputed
 * from stored inputs before it is written.
 */

// ---------------------------------------------------------------------------
// Validators — the five orthogonal dimensions
// ---------------------------------------------------------------------------

/**
 * The financing company's decision on the customer's creditworthiness.
 *
 * Deliberately separate from every other dimension below. The legacy
 * `financeApplications.status` conflated all five, so "APPROVED" could not
 * distinguish "credit approved, appraisal still pending" from "ready to hand
 * over the vehicle", and the ordering had to be re-derived from timestamps
 * scattered across four mutations.
 */
export const creditDecisionValidator = v.union(
  v.literal("DRAFT"),
  v.literal("SUBMITTED"),
  v.literal("UNDER_REVIEW"),
  v.literal("APPROVED"),
  v.literal("REJECTED"),
  v.literal("CANCELLED")
);

export const appraisalStatusValidator = v.union(
  v.literal("NOT_REQUESTED"),
  v.literal("PENDING"),
  v.literal("COMPLETED"),
  v.literal("REAPPRAISAL_REQUESTED"),
  v.literal("FINALIZED")
);

export const gapResolutionValidator = v.union(
  v.literal("NOT_REQUIRED"),
  v.literal("PENDING_NEGOTIATION"),
  v.literal("CUSTOMER_ABSORBS"),
  v.literal("DEALER_ABSORBS"),
  v.literal("SPLIT"),
  v.literal("FAILED")
);

export const settlementStatusValidator = v.union(
  v.literal("NOT_READY"),
  v.literal("EXPECTED"),
  v.literal("PARTIALLY_SETTLED"),
  v.literal("FULLY_SETTLED"),
  v.literal("RECONCILED")
);

export const handoverStatusValidator = v.union(
  v.literal("BLOCKED"),
  v.literal("READY"),
  v.literal("HANDED_OVER")
);

// ---------------------------------------------------------------------------
// Validators — basis, responsibility and failure
// ---------------------------------------------------------------------------

/**
 * How the approved dealer purchase amount was arrived at.
 *
 * Stored explicitly and never inferred from the appraisal: a company operating
 * a tolerance rule can approve at the submitted quotation even though the
 * appraisal came in lower, and a deal approved at some third negotiated figure
 * is neither.
 */
export const approvedPurchaseBasisValidator = v.union(
  v.literal("APPRAISAL"),
  v.literal("QUOTATION_EXCEPTION"),
  v.literal("MANUAL")
);

/**
 * How the stored quotation was arrived at.
 *
 * Three modes, kept distinct because they carry different evidentiary weight:
 * a figure the solver produced, a figure a person typed, and a solver figure a
 * person deliberately departed from. The third must record why.
 */
export const quotationSourceValidator = v.union(
  v.literal("SYSTEM_CALCULATED"),
  v.literal("MANUAL_ENTRY"),
  v.literal("CALCULATED_WITH_OVERRIDE")
);

/**
 * Everything that produced a stored quotation, frozen at the moment it was
 * recorded.
 *
 * Snapshotted rather than recomputed so the figure sent to the financing
 * company stays explainable after the company's rules, the vehicle's target or
 * the itemized fees have all moved on.
 */
export const quotationCalculationSnapshotValidator = v.object({
  mode: quotationSourceValidator,
  targetNetProceedsMinor: v.optional(v.number()),
  estimatedDealerBorneExpensesMinor: v.optional(v.number()),
  quotationBufferMinor: v.optional(v.number()),
  customerFirstPaymentMinor: v.optional(v.number()),
  appliedLtvPercent: v.optional(v.number()),
  customerFirstPaymentOffsetsUnfinancedShare: v.optional(v.boolean()),
  /** What the solver produced, when it was available. */
  calculatedQuotationMinor: v.optional(v.number()),
  /** Why the solver produced nothing, when it did not. */
  solverUnavailableReason: v.optional(v.string()),
  /** What was actually recorded — the same as calculated unless overridden. */
  finalQuotationMinor: v.number(),
  overrideReason: v.optional(v.string()),
  ruleVersion: v.optional(v.number()),
  recordedBy: v.id("users"),
  recordedAt: v.number(),
});

/**
 * Why a financing transaction failed.
 *
 * The appraisal-fee treatment keys off this, never off the status alone: a deal
 * that dies because the appraisal came in too low and the gap could not be
 * bridged leaves the fee with the dealership, while a customer who simply walks
 * away after an acceptable appraisal does not.
 */
export const financingFailureReasonValidator = v.union(
  v.literal("APPRAISAL_TOO_LOW"),
  v.literal("CUSTOMER_WITHDREW"),
  v.literal("CREDIT_REJECTED"),
  v.literal("DOCUMENTS_INCOMPLETE"),
  v.literal("DEALER_REJECTED_ECONOMICS"),
  v.literal("CUSTOMER_REJECTED_GAP"),
  v.literal("GAP_NEGOTIATION_FAILED"),
  v.literal("OTHER")
);

export const feeResponsibilityValidator = v.union(
  v.literal("DEALER"),
  v.literal("CUSTOMER"),
  v.literal("FINANCE_COMPANY"),
  v.literal("EMPLOYEE"),
  v.literal("UNRESOLVED")
);

export const dealerContributionSettlementValidator = v.union(
  v.literal("PAID_SEPARATELY"),
  v.literal("NETTED_FROM_REMITTANCE")
);

export const customerContributionSettlementValidator = v.union(
  v.literal("PASSED_THROUGH"),
  v.literal("RETAINED_BY_COMPANY")
);

/** What the company's LTV percentage is applied to. */
export const ltvBasisValidator = v.union(
  v.literal("INDEPENDENT_APPRAISAL"),
  v.literal("SUBMITTED_QUOTATION"),
  v.literal("APPROVED_PURCHASE_AMOUNT"),
  v.literal("LOWER_OF_APPRAISAL_AND_QUOTATION")
);

export const financeFeeTypeValidator = v.union(
  v.literal("FINANCE_COMPANY_FEE"),
  v.literal("APPRAISAL_FEE"),
  v.literal("INSURANCE"),
  v.literal("STAMPS"),
  v.literal("LICENSING"),
  v.literal("OWNERSHIP_TRANSFER"),
  v.literal("LIEN_REGISTRATION"),
  v.literal("LIEN_RELEASE"),
  v.literal("INSPECTION"),
  v.literal("ADMINISTRATIVE_FEE"),
  v.literal("COMMISSION"),
  v.literal("OTHER_CLOSING_EXPENSE")
);

/**
 * How a fee or settlement component lands in the general ledger.
 *
 * Every component carries one explicitly. The alternative — defaulting a
 * dealer-absorbed amount to Sales Discounts and Allowances — is wrong for most
 * of these: an appraisal fee the dealership swallows is an expense, an amount
 * the customer still owes is a receivable, and money fronted by an employee is
 * a payable to that employee. Where the right answer genuinely depends on the
 * dealership's own accounting policy, the mapping is configuration rather than
 * a silent hard-coded guess.
 */
export const feeAccountingTreatmentValidator = v.union(
  v.literal("SALE_CONSIDERATION_REDUCTION"),
  v.literal("APPRAISAL_EXPENSE"),
  v.literal("INSURANCE_EXPENSE"),
  v.literal("OWNERSHIP_TRANSFER_EXPENSE"),
  v.literal("FINANCE_COMPANY_COMMISSION"),
  v.literal("SELLING_EXPENSE"),
  v.literal("CUSTOMER_RECEIVABLE"),
  v.literal("EMPLOYEE_RECEIVABLE"),
  v.literal("EMPLOYEE_PAYABLE"),
  v.literal("REFUNDABLE_DEPOSIT"),
  v.literal("DEALER_CONCESSION"),
  v.literal("CAPITALIZED_TO_VEHICLE")
);

export const feePartyValidator = v.union(
  v.literal("DEALER"),
  v.literal("CUSTOMER"),
  v.literal("FINANCE_COMPANY"),
  v.literal("EMPLOYEE"),
  v.literal("APPRAISER"),
  v.literal("INSURER"),
  v.literal("GOVERNMENT"),
  v.literal("OTHER")
);

/** A default fee a finance company usually charges. Always editable per deal. */
export const financeFeeTemplateValidator = v.object({
  feeType: financeFeeTypeValidator,
  description: v.optional(v.string()),
  estimatedAmountMinor: v.number(),
  paidBy: feePartyValidator,
  paidTo: feePartyValidator,
  includedInQuotation: v.boolean(),
  deductedFromSettlement: v.boolean(),
  refundable: v.boolean(),
  accountingTreatment: feeAccountingTreatmentValidator,
});

/**
 * The finance company's rules as they stood when the application was created.
 *
 * Snapshotted onto the application rather than read live, so editing a
 * company's LTV or tolerance next month cannot retroactively change what a
 * historical deal was approved under. The `ruleVersion` points back at the
 * immutable `financeCompanyRuleVersions` row this came from.
 */
export const financeCompanyRuleSnapshotValidator = v.object({
  ruleVersion: v.number(),
  companyName: v.string(),
  defaultLtvPercent: v.optional(v.number()),
  minimumLtvPercent: v.optional(v.number()),
  maximumLtvPercent: v.optional(v.number()),
  ltvBasis: v.optional(ltvBasisValidator),
  minimumCustomerFirstPaymentMinor: v.optional(v.number()),
  allowedAppraisalVariancePercent: v.optional(v.number()),
  allowsQuotationAboveAppraisal: v.optional(v.boolean()),
  lowerAppraisalTolerancePercent: v.optional(v.number()),
  quotationExceptionApproval: v.optional(
    v.union(v.literal("AUTOMATIC"), v.literal("MANUAL"))
  ),
  dealerContributionSettlement: v.optional(dealerContributionSettlementValidator),
  customerContributionSettlement: v.optional(customerContributionSettlementValidator),
  feesDeductedFromSettlement: v.optional(v.boolean()),
  // Whether the customer's first payment offsets the unfinanced share. The
  // quotation solver's algebra depends on it and it is not universal, so it is
  // recorded per company and the solver declines when it is unset rather than
  // generalising one dealership's arrangement to every company.
  customerFirstPaymentOffsetsUnfinancedShare: v.optional(v.boolean()),
  feeTemplates: v.optional(v.array(financeFeeTemplateValidator)),
});

// ---------------------------------------------------------------------------
// Derived TypeScript types
// ---------------------------------------------------------------------------

export type CreditDecision = Doc<"financeApplications">["creditDecision"];
export type AppraisalStatus = Doc<"financeApplications">["appraisalStatus"];
export type GapResolution = Doc<"financeApplications">["gapResolution"];
export type SettlementStatus = Doc<"financeApplications">["settlementStatus"];
export type HandoverStatus = Doc<"financeApplications">["handoverStatus"];
export type FinanceCompanyRuleSnapshot = NonNullable<
  Doc<"financeApplications">["companyRuleSnapshot"]
>;

/** The economics fields, as the guards below need to read them. */
export interface ApplicationEconomics {
  economicsCurrency?: string;
  vehiclePurchaseCostMinor?: number;
  targetSellingAmountMinor?: number;
  submittedQuotationMinor?: number;
  appliedLtvPercent?: number;
  approvedDealerPurchaseAmountMinor?: number;
  financeCompanyFundedPortionMinor?: number;
  customerFirstPaymentMinor?: number;
  customerContributionToFinanceCompanyMinor?: number;
  dealerContributionMinor?: number;
  expectedDealerRemittanceMinor?: number;
  actualDealerReceiptTotalMinor?: number;
  estimatedClosingExpensesMinor?: number;
  actualClosingExpensesMinor?: number;
  rawAppraisalGapMinor?: number;
  customerGapShareMinor?: number;
  dealerGapShareMinor?: number;
  customerGapCashToDealerMinor?: number;
  customerGapInstallmentToDealerMinor?: number;
  customerGapToFinanceCompanyMinor?: number;
}

// ---------------------------------------------------------------------------
// Rule-snapshot defaults
// ---------------------------------------------------------------------------

/**
 * The rule values used when a company has not configured one.
 *
 * Deliberately conservative rather than permissive: no quotation exception, no
 * fee deduction, contribution paid separately. A dealership that has not told
 * us its company grants exceptions should not have deals silently approved
 * above the appraisal.
 */
export const RULE_DEFAULTS = {
  ltvBasis: "APPROVED_PURCHASE_AMOUNT" as const,
  allowsQuotationAboveAppraisal: false,
  lowerAppraisalTolerancePercent: 0,
  quotationExceptionApproval: "MANUAL" as const,
  dealerContributionSettlement: "PAID_SEPARATELY" as const satisfies DealerContributionSettlement,
  customerContributionSettlement: "PASSED_THROUGH" as const satisfies CustomerContributionSettlement,
  feesDeductedFromSettlement: false,
} as const;

/** Builds the immutable snapshot stored on an application from a live company row. */
export function buildRuleSnapshot(
  company: Doc<"financeCompanies">
): FinanceCompanyRuleSnapshot {
  return {
    ruleVersion: company.ruleVersion ?? 1,
    companyName: company.name,
    // Deliberately NOT falling back to maxFinancingLTV. That reads as helpful
    // and is fail-open: `FinanceCompanyDialog` writes `maxFinancingLTV: 100`
    // for any company that never had one, so a company whose real rate is 85%
    // would be quoted at 100% — funding the whole purchase and reporting a
    // dealer contribution of zero where the confirmed deal needs 1,375.
    // `resolveAppliedLtv` throws a clear, actionable error instead.
    defaultLtvPercent: company.defaultLtvPercent,
    minimumLtvPercent: company.minimumLtvPercent,
    maximumLtvPercent: company.maxFinancingLTV,
    ltvBasis: company.ltvBasis ?? RULE_DEFAULTS.ltvBasis,
    minimumCustomerFirstPaymentMinor: company.minimumCustomerFirstPaymentMinor,
    allowedAppraisalVariancePercent: company.allowedAppraisalVariancePercent,
    allowsQuotationAboveAppraisal:
      company.allowsQuotationAboveAppraisal ?? RULE_DEFAULTS.allowsQuotationAboveAppraisal,
    lowerAppraisalTolerancePercent:
      company.lowerAppraisalTolerancePercent ?? RULE_DEFAULTS.lowerAppraisalTolerancePercent,
    quotationExceptionApproval:
      company.quotationExceptionApproval ?? RULE_DEFAULTS.quotationExceptionApproval,
    dealerContributionSettlement:
      company.dealerContributionSettlement ?? RULE_DEFAULTS.dealerContributionSettlement,
    customerContributionSettlement:
      company.customerContributionSettlement ?? RULE_DEFAULTS.customerContributionSettlement,
    feesDeductedFromSettlement:
      company.feesDeductedFromSettlement ?? RULE_DEFAULTS.feesDeductedFromSettlement,
    // Deliberately no default. Unset means "nobody has told us", which makes
    // the solver decline — the correct outcome, since guessing either way
    // invents a commercial arrangement.
    customerFirstPaymentOffsetsUnfinancedShare:
      company.customerFirstPaymentOffsetsUnfinancedShare,
    feeTemplates: company.feeTemplates,
  };
}

/**
 * The LTV to apply, clamped to the snapshot's own bounds.
 *
 * A caller may propose one (the company approved at a different rate than its
 * default), but never outside the range the company's rules allowed at the time
 * — otherwise the "snapshot" is decoration and the applied rate is whatever the
 * last person typed.
 */
export function resolveAppliedLtv(
  snapshot: FinanceCompanyRuleSnapshot,
  proposedLtvPercent?: number
): number {
  const candidate = proposedLtvPercent ?? snapshot.defaultLtvPercent;
  if (candidate === undefined || !Number.isFinite(candidate)) {
    throw new ConvexError(
      "No LTV is configured for this finance company. Set a default LTV before quoting."
    );
  }
  if (candidate <= 0 || candidate > 100) {
    throw new ConvexError(`LTV must be greater than 0 and at most 100 (got ${candidate}).`);
  }
  // The same boundary `assertDealerRulesValid` applies to a company's stored
  // rules, applied to the per-deal LTV a caller passes. Without it, 0.0000004
  // is positive, passes every check here, and then scales to zero inside the
  // engine — so `financeCompanyFundedPortionMinor` becomes 0 and the dealer
  // contribution silently becomes the ENTIRE approved purchase amount, with no
  // throw and no reconciliation flag. On the quotation path the same value
  // instead reaches a division and surfaces as an opaque engine error.
  if (percentRoundsToZero(candidate)) {
    throw new ConvexError(
      `An LTV of ${candidate}% rounds to zero at the ${PERCENT_DECIMAL_PLACES} decimal places the financing calculations keep, so it cannot be used.`
    );
  }
  const minimum = snapshot.minimumLtvPercent;
  const maximum = snapshot.maximumLtvPercent;
  if (minimum !== undefined && candidate < minimum) {
    throw new ConvexError(
      `An LTV of ${candidate}% is below this company's minimum of ${minimum}%.`
    );
  }
  if (maximum !== undefined && candidate > maximum) {
    throw new ConvexError(
      `An LTV of ${candidate}% is above this company's maximum of ${maximum}%.`
    );
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Server-side invariants
// ---------------------------------------------------------------------------

/** Rejects a caller-supplied money amount that is not a sane minor-unit integer. */
export function assertMinorAmount(value: number, label: string): void {
  // v.number() accepts NaN and Infinity, and NaN passes every comparison guard
  // (NaN < 0 is false), so test positively for what is allowed.
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new ConvexError(
      `${label} must be a non-negative whole number of minor units (got ${value}).`
    );
  }
}

export function assertPercent(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConvexError(`${label} must be a percentage between 0 and 100 (got ${value}).`);
  }
}

/**
 * Recomputes every derived economics figure from the stored inputs.
 *
 * Called on every write that can move one of the inputs, so the stored
 * derivations can never be stale relative to what they were derived from — and
 * so a client cannot post its own idea of the dealer contribution.
 */
export function deriveEconomics(args: {
  approvedDealerPurchaseAmountMinor: number;
  appliedLtvPercent: number;
  customerFirstPaymentMinor: number;
  submittedQuotationMinor: number;
  /** The company's rule for what its LTV multiplies. */
  ltvBasis?: LtvBasis;
  /** The approved appraisal, when the basis names it. */
  independentAppraisalMinor?: number;
  dealerContributionSettlement: DealerContributionSettlement;
  customerContributionSettlement: CustomerContributionSettlement;
  customerContributionToFinanceCompanyMinor: number;
  feeDeductionsMinor: number;
  customerDirectToDealerMinor: number;
  dealerBorneExpensesMinor: number;
  /** Only needed for the profit figures, which nothing stores yet. */
  vehicleCostMinor?: number;
}) {
  // The snapshotted basis has to reach the arithmetic, not just sit in the
  // snapshot: at 85% on a 12,500 approval against an 11,500 appraisal, an
  // appraisal basis funds 9,775 where an approved-amount basis funds 10,625 —
  // an 850 difference in what the dealership has to put in.
  const ltvBaseMinor = resolveLtvBaseMinor(args.ltvBasis, {
    approvedPurchaseAmountMinor: args.approvedDealerPurchaseAmountMinor,
    submittedQuotationMinor: args.submittedQuotationMinor,
    independentAppraisalMinor: args.independentAppraisalMinor,
  });

  // The company's rule names an amount nobody has recorded. Report that rather
  // than computing against a substitute — a manual approval with no appraisal,
  // under a company that lends against the appraisal, would otherwise fund
  // against the larger approved amount and understate the dealership's own
  // contribution, with nothing to show the basis had been swapped.
  if (ltvBaseMinor === undefined) return undefined;

  const composition = computeFundingComposition({
    approvedPurchaseAmountMinor: args.approvedDealerPurchaseAmountMinor,
    appliedLtvPercent: args.appliedLtvPercent,
    customerFirstPaymentMinor: args.customerFirstPaymentMinor,
    ltvBaseMinor,
  });

  const gap = computeAppraisalGap({
    submittedQuotationMinor: args.submittedQuotationMinor,
    approvedDealerPurchaseAmountMinor: args.approvedDealerPurchaseAmountMinor,
    appliedLtvPercent: args.appliedLtvPercent,
  });

  const remittance = computeExpectedRemittance({
    approvedDealerPurchaseAmountMinor: args.approvedDealerPurchaseAmountMinor,
    dealerContributionMinor: composition.dealerContributionMinor,
    dealerContributionSettlement: args.dealerContributionSettlement,
    customerContributionToFinanceCompanyMinor: args.customerContributionToFinanceCompanyMinor,
    customerContributionSettlement: args.customerContributionSettlement,
    feeDeductionsMinor: args.feeDeductionsMinor,
  });

  const proceeds = computeDealerProceeds({
    approvedDealerPurchaseAmountMinor: args.approvedDealerPurchaseAmountMinor,
    dealerContributionMinor: composition.dealerContributionMinor,
    customerDirectToDealerMinor: args.customerDirectToDealerMinor,
    dealerBorneExpensesMinor: args.dealerBorneExpensesMinor,
    vehicleCostMinor: args.vehicleCostMinor ?? 0,
  });

  return { composition, gap, remittance, proceeds };
}

/**
 * Refuses a gap resolution that does not satisfy the dealer's two identities.
 *
 * Throws on the first violation with every problem listed, so a caller fixing
 * one does not immediately hit the next.
 */
export function assertGapResolutionValid(
  rawAppraisalGapMinor: number,
  settlement: {
    customerGapShareMinor: number;
    dealerGapShareMinor: number;
    customerGapCashToDealerMinor: number;
    customerGapInstallmentToDealerMinor: number;
    customerGapToFinanceCompanyMinor: number;
  }
): void {
  const violations = validateGapShares(rawAppraisalGapMinor, settlement);
  if (violations.length > 0) {
    throw new ConvexError(violations.map((violation) => violation.message).join(" "));
  }
}


// ---------------------------------------------------------------------------
// Keeping the dimensions in step with the legacy status
// ---------------------------------------------------------------------------

/**
 * The shape the dimension derivations need — a real application row, or the
 * fields the migration is about to write.
 */
export interface LifecycleFacts {
  status: Doc<"financeApplications">["status"];
  vehicleHandoverAt?: number;
  finalizedSaleId?: unknown;
  disbursedAt?: number;
}

/**
 * The credit decision a legacy status is really carrying.
 *
 * One source of truth for the mapping, shared by the migration and by every
 * mutation that moves `status`. Duplicating it would guarantee the two drift,
 * and a dimension that disagrees with the status it was derived from is worse
 * than no dimension at all.
 *
 * CLOSED maps to APPROVED rather than a terminal value of its own: closing is
 * what `finalizeDeal` does *after* credit was approved, so the credit
 * dimension's value is APPROVED and it is settlement and handover that record
 * the deal completing.
 */
export function creditDecisionForStatus(
  status: Doc<"financeApplications">["status"]
): NonNullable<CreditDecision> {
  switch (status) {
    case "DRAFT":
      return "DRAFT";
    case "PENDING_DOCS":
      return "SUBMITTED";
    case "UNDER_REVIEW":
      return "UNDER_REVIEW";
    case "APPROVED":
    case "CLOSED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
  }
}

/** Whether the vehicle can be, or already has been, handed to the customer. */
export function handoverStatusForFacts(facts: LifecycleFacts): NonNullable<HandoverStatus> {
  // A finalized sale means the vehicle was handed over, whether or not it was
  // timestamped: the timestamp only exists from the commit that introduced the
  // pre-finalize handover step, 587 commits back, so every financed deal closed
  // before it carries none, and reading those as BLOCKED would tell the
  // dealership its entire earlier history cannot be handed to the customer.
  //
  // `finalizedSaleId` is the evidence, deliberately NOT `status === "CLOSED"`
  // on its own. The old updateStatus could set CLOSED without creating a sale,
  // stranding the application permanently — those rows are a known malformed
  // state, and inferring a handover from the status alone would make them
  // indistinguishable from deals that physically completed.
  if (facts.vehicleHandoverAt || facts.finalizedSaleId) return "HANDED_OVER";
  return facts.status === "APPROVED" ? "READY" : "BLOCKED";
}

/**
 * How far the money has got.
 *
 * `FULLY_SETTLED` records that a disbursement was confirmed — a real event with
 * a real timestamp. It asserts nothing about the amount being right, which is
 * why the migration also flags legacy disbursed rows for reconciliation.
 */
export function settlementStatusForFacts(
  facts: LifecycleFacts
): NonNullable<SettlementStatus> {
  // Checked before finalizedSaleId, which cancelApplication deliberately keeps
  // on a reversed deal. Without this the backfill would read a cancelled,
  // GL-reversed application as EXPECTED — asserting the finance company still
  // owes money on a voided deal, and contradicting what cancelApplication
  // itself writes for the identical facts.
  if (facts.status === "CANCELLED" || facts.status === "REJECTED") return "NOT_READY";
  if (facts.disbursedAt) return "FULLY_SETTLED";
  if (facts.finalizedSaleId) return "EXPECTED";
  return "NOT_READY";
}

/**
 * Who ends up bearing the appraisal fee when a deal dies.
 *
 * Confirmed with the dealership: it swallows the fee when its own asking price
 * could not be reconciled with the appraisal, and does not when the customer
 * walks away from an appraisal that was perfectly acceptable.
 *
 * Returns UNRESOLVED rather than guessing for the reasons that genuinely depend
 * on the deal — a rejected credit file or missing documents can fall either way
 * depending on who caused it — so the dealership records the answer instead of
 * inheriting a wrong default silently.
 */
export function defaultAppraisalFeeResponsibility(
  failureReason: Doc<"financeApplications">["failureReason"]
): "DEALER" | "CUSTOMER" | "UNRESOLVED" {
  switch (failureReason) {
    case "APPRAISAL_TOO_LOW":
    case "GAP_NEGOTIATION_FAILED":
    case "DEALER_REJECTED_ECONOMICS":
      return "DEALER";
    case "CUSTOMER_WITHDREW":
    case "CUSTOMER_REJECTED_GAP":
      return "CUSTOMER";
    default:
      return "UNRESOLVED";
  }
}

// ---------------------------------------------------------------------------
// Deal cockpit — the stage rail and the management profit figure
// ---------------------------------------------------------------------------

/**
 * The eight stages the cockpit renders, in order.
 *
 * Driven off the lifecycle dimensions rather than `status`, which is a workflow
 * enum with a different job: a deal can be APPROVED while its appraisal gap is
 * unresolved and its documents are missing, and a single enum cannot say so.
 */
export type DealStageKey =
  | "APPLICATION"
  | "CREDIT_DECISION"
  | "APPRAISAL"
  | "GAP_RESOLUTION"
  | "APPROVED_PURCHASE"
  | "DELIVERY_ACTIONS"
  | "HANDOVER"
  | "SETTLEMENT"
  /**
   * CASH only. The moment a sale record exists at all — the cash equivalent of
   * `APPLICATION`, and deliberately not the same key: "finance application
   * submitted" is not a thing that happens on a cash deal, and reusing the key
   * would have put a stage on the rail whose label lies about what it means.
   */
  | "SALE_AGREED";

/**
 * The stages a FINANCED deal has — every key except the cash-only one.
 *
 * Written as an exclusion rather than a second hand-maintained list so the two
 * cannot drift. It exists to keep `deriveDealStages` exhaustively checked: its
 * `complete` map is a total `Record` over these keys, so adding a financed stage
 * fails the build instead of silently inheriting whichever branch happened to be
 * the fallback. Widening that map to a `Partial` to accommodate `SALE_AGREED`
 * would have quietly discarded that guarantee.
 */
export type FinancedDealStageKey = Exclude<DealStageKey, "SALE_AGREED">;

/** The three stages a CASH deal has, kept exhaustive for the same reason. */
export type CashDealStageKey = Extract<
  DealStageKey,
  "SALE_AGREED" | "HANDOVER" | "SETTLEMENT"
>;

export const DEAL_STAGE_ORDER: FinancedDealStageKey[] = [
  "APPLICATION",
  "CREDIT_DECISION",
  "APPRAISAL",
  "GAP_RESOLUTION",
  "APPROVED_PURCHASE",
  "DELIVERY_ACTIONS",
  "HANDOVER",
  "SETTLEMENT",
];

/**
 * `STOPPED` is not a synonym for BLOCKED. A blocked stage waits on something
 * somebody can still do; a stopped one belongs to a deal that was rejected or
 * cancelled, where the remaining stages will never happen at all. Rendering
 * those as merely "pending" invites an operator to work a dead deal.
 */
export type DealStageState = "COMPLETE" | "CURRENT" | "BLOCKED" | "PENDING" | "STOPPED";

export type DealStageBlocker =
  | "AwaitingCreditDecision"
  | "AwaitingAppraisal"
  | "GapUnresolved"
  | "GapNegotiationFailed"
  | "NoApprovedPurchaseAmount"
  | "DocumentsIncomplete"
  | "HandoverBlocked"
  | "AwaitingSettlement";

export interface DealStage {
  key: DealStageKey;
  state: DealStageState;
  /** A key, never a sentence — the screen owns the wording in both locales. */
  blocker?: DealStageBlocker;
}

export interface DealStageFacts extends LifecycleFacts {
  creditDecision?: CreditDecision;
  appraisalStatus?: AppraisalStatus;
  gapResolution?: GapResolution;
  settlementStatus?: SettlementStatus;
  handoverStatus?: HandoverStatus;
  rawAppraisalGapMinor?: number;
  approvedDealerPurchaseAmountMinor?: number;
  /**
   * What the approved amount was based on.
   *
   * Load-bearing for the APPRAISAL stage: `approveDealerPurchaseAmount` permits
   * `MANUAL` with no appraisal — a figure the company named directly — and
   * deliberately does not mark the appraisal dimension finalized there, because
   * that would assert a valuation that never happened. Without this fact the
   * rail went on demanding an appraisal nobody would ever record, on a deal
   * that was already approved.
   */
  approvedPurchaseBasis?: "APPRAISAL" | "QUOTATION_EXCEPTION" | "MANUAL";
  /** Every required document uploaded, verified or waived. */
  requiredDocumentsComplete: boolean;
  /**
   * The deal is over for a reason the credit dimension cannot express — the
   * sale itself was cancelled from the sales side, which reverses the GL and
   * cancels the supplier claim while the application keeps its own status.
   */
  dealCancelled?: boolean;
  /**
   * Whether the money is finished, when the caller can answer it better than
   * `settlementStatus` can.
   *
   * A DIRECT_TO_SUPPLIER deal never reaches FULLY_SETTLED through that field —
   * the only mutation that writes it refuses that route — so judging both routes
   * by it left the direct route's terminal stage permanently blocked on deals
   * that were completely finished. The caller knows the route and the supplier's
   * claim; this leaves room for it to say so.
   */
  settlementComplete?: boolean;
}

/**
 * The stage rail for one deal.
 *
 * All five lifecycle dimensions are OPTIONAL on `financeApplications`, so every
 * application created before they existed answers none of them. Falling back to
 * the same `*ForFacts` helpers the backfill uses — rather than reading an unset
 * dimension as "not done" — is what keeps a completed historical deal from
 * rendering as a deal that never started.
 *
 * Each stage is judged on its OWN evidence rather than on the stage before it,
 * so a legacy row that was handed over and settled while its document checklist
 * was never filled in still shows both of those complete. The alternative —
 * marking everything after the first gap as pending — would tell a dealership
 * its delivered car had not been delivered.
 */
export function deriveDealStages(facts: DealStageFacts): DealStage[] {
  const credit = facts.creditDecision ?? creditDecisionForStatus(facts.status);
  const handover = facts.handoverStatus ?? handoverStatusForFacts(facts);
  const settlement = facts.settlementStatus ?? settlementStatusForFacts(facts);
  const appraisal = facts.appraisalStatus;
  const gap = facts.gapResolution;

  // `dealCancelled` covers the case the credit dimension cannot see: the sale
  // can be cancelled from the sales side, which reverses the GL and cancels the
  // supplier claim, while the application keeps its own status.
  const stopped = credit === "REJECTED" || credit === "CANCELLED" || facts.dealCancelled === true;
  // A gap of zero is not a gap, and `undefined` means none was ever recorded.
  const hasGap = (facts.rawAppraisalGapMinor ?? 0) !== 0;

  const complete: Record<FinancedDealStageKey, boolean> = {
    APPLICATION: credit !== "DRAFT",
    CREDIT_DECISION: credit === "APPROVED",
    // A legacy row records no appraisal dimension at all. An approved credit
    // decision on such a row means the appraisal happened off-system, so
    // reading it as "not appraised" would assert something about the past that
    // the data does not support.
    APPRAISAL:
      appraisal === "COMPLETED" ||
      appraisal === "FINALIZED" ||
      (appraisal === undefined && credit === "APPROVED") ||
      // A manually named approval is a decision taken WITHOUT an appraisal, and
      // the writer that records it says so by refusing to finalize the
      // dimension. So the question is moot rather than outstanding — the rail
      // follows the writer that owns the decision instead of demanding evidence
      // that will never arrive. Narrow on purpose: APPRAISAL and
      // QUOTATION_EXCEPTION both rest on real appraisal evidence and are
      // unaffected, and an approval with no recorded basis is not evidence of a
      // manual decision.
      (facts.approvedPurchaseBasis === "MANUAL" &&
        facts.approvedDealerPurchaseAmountMinor !== undefined),
    GAP_RESOLUTION:
      gap === "NOT_REQUIRED" ||
      gap === "CUSTOMER_ABSORBS" ||
      gap === "DEALER_ABSORBS" ||
      gap === "SPLIT" ||
      (gap === undefined && !hasGap),
    APPROVED_PURCHASE: facts.approvedDealerPurchaseAmountMinor !== undefined,
    DELIVERY_ACTIONS: facts.requiredDocumentsComplete,
    HANDOVER: handover === "HANDED_OVER",
    SETTLEMENT:
      facts.settlementComplete ??
      (settlement === "FULLY_SETTLED" || settlement === "RECONCILED"),
  };

  const blockers: Partial<Record<FinancedDealStageKey, DealStageBlocker>> = {
    CREDIT_DECISION: "AwaitingCreditDecision",
    APPRAISAL: "AwaitingAppraisal",
    GAP_RESOLUTION: gap === "FAILED" ? "GapNegotiationFailed" : "GapUnresolved",
    APPROVED_PURCHASE: "NoApprovedPurchaseAmount",
    DELIVERY_ACTIONS: "DocumentsIncomplete",
    HANDOVER: handover === "BLOCKED" ? "HandoverBlocked" : undefined,
    SETTLEMENT: "AwaitingSettlement",
  };

  const firstIncomplete = DEAL_STAGE_ORDER.find((key) => !complete[key]);

  return DEAL_STAGE_ORDER.map((key): DealStage => {
    if (complete[key]) return { key, state: "COMPLETE" };
    if (stopped) return { key, state: "STOPPED" };
    if (key !== firstIncomplete) return { key, state: "PENDING" };
    const blocker = blockers[key];
    return blocker ? { key, state: "BLOCKED", blocker } : { key, state: "CURRENT" };
  });
}

/**
 * The stages a CASH deal actually has — three, not eight.
 *
 * Credit decision, appraisal, gap resolution and approved purchase are things a
 * FINANCE COMPANY does. A cash deal does not skip them; it does not have them.
 * That difference is why this is a different ORDER rather than the financed rail
 * with stages greyed out: a permanently-inactive stage teaches operators that
 * grey means "ignore", and this same rail has to carry a real blocker.
 *
 * `DELIVERY_ACTIONS` is absent for the same reason, and it is the one that took
 * an argument to settle. The document checklist is driven by
 * `companyDocumentRules` and its per-deal status lives in `applicationDocuments`,
 * keyed by APPLICATION — a cash sale has no row there and no way to acquire one.
 * Including the stage would have produced either a permanently blocked stage
 * (status can never become VERIFIED) or a permanently complete one (no rule can
 * ever be unsatisfied). Both are noise dressed as workflow, and the second is
 * worse: a stage that is always green is a checklist item nobody checked.
 */
export const CASH_DEAL_STAGE_ORDER: CashDealStageKey[] = [
  "SALE_AGREED",
  "HANDOVER",
  "SETTLEMENT",
];

export interface CashDealStageFacts {
  /** `sales.status`. */
  saleStatus: "PENDING" | "COMPLETED" | "CANCELLED";
  /**
   * Whether the money is finished — the supplier's claim or payable closed on a
   * consigned sale, and trivially true on dealer-owned stock where there is no
   * third party to settle with.
   *
   * `undefined` is NOT "settled". It means the caller could not establish the
   * obligation, and the stage stays open rather than reporting a deal finished
   * on the strength of a missing answer. Same UNKNOWN-never-zero rule the
   * financed rail follows.
   */
  settlementComplete?: boolean;
}

/**
 * The stage rail for one CASH deal.
 *
 * A sale row is the anchor: if the screen is rendering, the deal was agreed, so
 * `SALE_AGREED` is complete by construction rather than by a field. The rest is
 * read from evidence, and each stage is judged on its OWN evidence — the same
 * rule `deriveDealStages` follows, so a sale delivered before anyone filled in
 * the document checklist still shows the handover complete.
 *
 * A CANCELLED sale stops the rail rather than leaving it pending, for the same
 * reason a rejected application does: the remaining stages will never happen,
 * and rendering them as merely "pending" invites an operator to work a dead deal.
 */
export function deriveCashDealStages(facts: CashDealStageFacts): DealStage[] {
  const stopped = facts.saleStatus === "CANCELLED";

  const complete: Record<CashDealStageKey, boolean> = {
    SALE_AGREED: true,
    // A cash sale carries no handover dimension of its own — `sales` has no
    // handover field — so COMPLETED is the delivery fact the data actually
    // supports. Inventing a richer handover state here would be asserting
    // something no row records.
    HANDOVER: facts.saleStatus === "COMPLETED",
    // Requires the sale to have COMPLETED as well as the supplier obligation to
    // be closed or absent. Without the status condition a PENDING sale of
    // dealership-owned stock reported its settlement finished the moment it was
    // drafted — there is no supplier to owe, so "nothing outstanding" was true
    // and vacuous. A deal that has not happened has not settled.
    SETTLEMENT: facts.saleStatus === "COMPLETED" && facts.settlementComplete === true,
  };

  const blockers: Partial<Record<CashDealStageKey, DealStageBlocker>> = {
    SETTLEMENT: "AwaitingSettlement",
  };

  const firstIncomplete = CASH_DEAL_STAGE_ORDER.find((key) => !complete[key]);

  return CASH_DEAL_STAGE_ORDER.map((key): DealStage => {
    if (complete[key]) return { key, state: "COMPLETE" };
    if (stopped) return { key, state: "STOPPED" };
    if (key !== firstIncomplete) return { key, state: "PENDING" };
    const blocker = blockers[key];
    return blocker ? { key, state: "BLOCKED", blocker } : { key, state: "CURRENT" };
  });
}

/**
 * Whether one party's obligation on a deal is finished.
 *
 * `NONE` and `CLOSED` both mean "nothing more will move", and they are kept
 * apart because they are different facts: a zero-margin deal legitimately has
 * NO supplier claim, and demanding a paid one as proof made such deals
 * impossible to finish. `UNKNOWN` is not a soft OPEN — it means the evidence
 * that would settle the question is missing, and it must never satisfy
 * completion.
 */
export type ObligationState = "CLOSED" | "OPEN" | "UNKNOWN" | "NONE";

/**
 * The obligations a financed consigned deal carries, per settlement route.
 *
 * Replaces a single `moneySettled` boolean that grew one condition per defect
 * and produced three of its own: a partial financier advice counted as full
 * payment, a through-route deal counted as settled while the supplier was still
 * owed, and a zero-margin deal could never complete. Those are three different
 * obligations to three different parties, and one boolean could not tell them
 * apart — so it is not a boolean any more.
 */
export interface SettlementObligations {
  /** What the finance company owes — to the dealership, or to the supplier. */
  financier: ObligationState;
  /** What is owed to the supplier, or by him for the dealership's margin. */
  supplier: ObligationState;
}

/** Every obligation proven finished, or proven never to have existed. */
export function settlementIsComplete(obligations: SettlementObligations): boolean {
  const done = (state: ObligationState) => state === "CLOSED" || state === "NONE";
  return done(obligations.financier) && done(obligations.supplier);
}

/**
 * What a subledger row says about its obligation, decided in integer minor units.
 *
 * Returns the state rather than a boolean because "not settled" and "cannot be
 * read" are different answers, and a boolean forces them together. A predecessor
 * returned `false` for an unreadable amount, so a claim with a corrupt
 * `amountDue` rendered as `OWED_TO_DEALERSHIP` — the screen asserting a debt on
 * the strength of a figure it had just failed to parse. Unreadable evidence is
 * UNKNOWN in both directions: it is no more proof of a debt than of settlement.
 *
 * Moved here from `applications.ts` for SCRUM-29, unchanged, so the cash deal
 * path reaches the same verdict about a supplier row as the financed one.
 */
export function obligationFromRow(args: {
  due: number;
  settled: number;
  rowCurrency: string;
  queryCurrency: string;
  /** The row's own stored status, which is evidence but not the only evidence. */
  storedPaid: boolean;
}): ObligationState {
  const dueMinor = toMinorSameCurrencyOrUndefined(args.due, args.rowCurrency, args.queryCurrency);
  const settledMinor = toMinorSameCurrencyOrUndefined(
    args.settled,
    args.rowCurrency,
    args.queryCurrency
  );
  if (dueMinor === undefined || settledMinor === undefined) return "UNKNOWN";
  return args.storedPaid || dueMinor - settledMinor <= 0 ? "CLOSED" : "OPEN";
}

/**
 * How a party row reads an obligation.
 *
 * One translation, used by every row on every deal screen, so a row can never
 * disagree with the settlement stage about whether somebody still owes money.
 * `openPosition` is the only per-row difference — which way an OPEN obligation
 * points, since the dealership owes the supplier on one route and is owed by him
 * on the other.
 *
 * NONE is "nothing outstanding", not "cannot tell": a zero-margin deal has no
 * claim, and that absence is the correct answer rather than missing evidence.
 */
export function positionForObligation(
  obligation: ObligationState,
  openPosition: "DEALERSHIP_OWES" | "OWED_TO_DEALERSHIP"
) {
  switch (obligation) {
    case "CLOSED":
      return "SETTLED" as const;
    case "NONE":
      return "NOT_INVOLVED" as const;
    case "OPEN":
      return openPosition;
    default:
      return "UNKNOWN" as const;
  }
}

/**
 * How settled the headline figure's inputs are.
 *
 * `ACTUAL_UNPOSTABLE` is deliberately not called "settled" or "final": even
 * once every input has stopped moving, this figure still has no journal behind
 * it and never will. A name that suggested otherwise is what would let it drift
 * into a report.
 */
export type ManagementProfitClassification =
  | "ESTIMATED_AWAITING_SETTLEMENT"
  | "ACTUAL_UNPOSTABLE";

export type ManagementProfitLine =
  | { key: "APPROVED_PURCHASE"; sign: 1; amountMinor: number }
  | { key: "CUSTOMER_DIRECT_TO_DEALER"; sign: 1; amountMinor: number }
  | { key: "SUPPLIER_SETTLEMENT"; sign: -1; amountMinor: number }
  | { key: "DEALER_CONTRIBUTION"; sign: -1; amountMinor: number }
  | { key: "ACTUAL_EXPENSES"; sign: -1; amountMinor: number };

/**
 * `صافي ربح المعرض` — a MANAGEMENT figure, never an accounting result.
 *
 * Derived from the finance company's approved purchase amount, NOT from the
 * price the customer was sold at. On a consigned financed deal those differ by a
 * spread that appears on no invoice and no receipt, which is precisely why this
 * number must never be posted, reconciled against the GL, or shown without its
 * classification. Amount and classification travel in ONE object so a caller
 * cannot render the figure having dropped the qualifier — the shape is the
 * enforcement, not a convention someone has to remember.
 */
export type ManagementProfit =
  | {
      available: true;
      /**
       * Which KIND of number this is, carried in the payload rather than
       * inferred by the reader from the presence of a classification.
       *
       * SCRUM-29 put a second, genuinely different profit on the same screen —
       * a cash deal's margin, which IS an accounting result and DOES reconcile
       * to the GL. The two must never be confused in either direction, so the
       * distinction is a discriminant on the type instead of a convention: a
       * renderer that forgets to branch on it does not compile.
       */
      basis: "MANAGEMENT_ESTIMATE";
      amountMinor: number;
      currency: string;
      classification: ManagementProfitClassification;
      lines: ManagementProfitLine[];
      /** Structural, not advisory. This figure has no journal and never will. */
      postable: false;
    }
  | {
      available: false;
      reason:
        | "NoApprovedPurchaseAmount"
        | "NoSupplierSettlement"
        | "NoDealerContribution"
        | "CorruptInput"
        | "DealCancelled";
    };

/**
 * The lines behind a CASH deal's profit.
 *
 * Deliberately a different set from `ManagementProfitLine`. A cash deal has no
 * approved purchase amount and no dealer contribution — those are things a
 * finance company does — and reusing the financed line keys would have produced
 * a derivation that renders plausibly and means nothing.
 */
export type AccountingProfitLine =
  | { key: "SALE_PRICE"; sign: 1; amountMinor: number }
  | { key: "VEHICLE_COST"; sign: -1; amountMinor: number }
  | { key: "SUPPLIER_ENTITLEMENT"; sign: -1; amountMinor: number };

/**
 * A CASH deal's profit — an ordinary accounting result that reconciles.
 *
 * The opposite of `ManagementProfit` in the one way that matters. This figure
 * IS what the ledger recognizes: it is `saleEconomics().dealershipMargin`, the
 * same number `reports.salesReport` totals into `totalProfit` and the same one
 * the P&L is built from. It carries no `تقديري` qualifier because there is
 * nothing estimated about it.
 *
 * ⚠️ It carries `reconcilesToLedger`, NOT `postable: true`, and the asymmetry is
 * deliberate. "This agrees with the books" and "this is an instruction to post"
 * are different claims, and only the first one is true here: nothing in the
 * codebase posts from this object — it is a READ assembled for a screen, and the
 * journal it agrees with was written by `completeSale`, long before anyone asks
 * for a headline. A field named `postable: true` on a derived figure invites a
 * future caller to treat it as a posting source, which is precisely the class of
 * confusion this union exists to prevent. `postable` therefore survives on the
 * financed side ONLY, as a one-way prohibition.
 *
 * `available: false` with `reason: "UnknownMargin"` is NOT a zero. It is the
 * `dealershipMargin === null` case — a consigned sale whose frozen margin is
 * missing — and the reports already refuse to guess at it, counting such rows
 * separately so an owner is told the figure is incomplete rather than handed a
 * confident wrong one. This screen refuses on the same evidence.
 */
export type AccountingProfit =
  | {
      available: true;
      basis: "ACCOUNTING_RESULT";
      amountMinor: number;
      currency: string;
      lines: AccountingProfitLine[];
      /**
       * A journal already exists for this sale and this figure agrees with it.
       * That is the whole difference from the financed one — and it is a
       * statement about the BOOKS, not a licence to post from this object.
       */
      reconcilesToLedger: true;
    }
  | {
      available: false;
      reason:
        | "UnknownMargin"
        | "DealCancelled"
        | "SaleNotCompleted"
        | "FinancedDirectUnverified";
    };

/**
 * What the deal screen's headline can be.
 *
 * A union rather than one widened type, so the two cannot be built from each
 * other's parts. `basis` is the discriminant, and the two arms carry DIFFERENT
 * ledger fields rather than the same field with opposite values: financed
 * carries `postable: false`, cash carries `reconcilesToLedger: true`. Neither is
 * independently settable, and no caller can read one arm's field off the other —
 * TypeScript refuses the access outside its branch.
 */
export type DealProfit = ManagementProfit | AccountingProfit;

/**
 * Returns `available: false` rather than a zero when an input is missing.
 *
 * A profit of zero and a profit nobody can compute are different claims, and on
 * the screen a dealership reads to decide whether a deal made money, showing
 * the first in place of the second is the more damaging of the two errors.
 *
 * H-7, RULED by the dealership on 2026-08-10: this figure NETS
 * `dealerContributionMinor`, and its components are the same dealer economics
 * `computeDealerProceeds` uses. Whether the finance company nets the
 * contribution from its remittance or the dealership pays it separately changes
 * cash movement, not profit — `computeExpectedRemittance` treats
 * `NETTED_FROM_REMITTANCE` purely as a deduction, and the dealership funds the
 * contribution either way. Calling the pre-contribution number `صافي ربح المعرض`
 * while the dealership still has to put money in was materially misleading: at
 * 85% LTV it overstated a real deal by roughly 875 JOD.
 *
 * Nor is it double-counting the customer's money. `computeFundingComposition`
 * defines the contribution as `approved − financeCompanyFunded −
 * customerFirstPaymentApplied`, so the customer's first payment has already
 * been taken out before the dealership's share is what remains.
 *
 * What this deliberately is NOT is a third profit formula. The ONE thing that
 * still separates it from `computeDealerProceeds` is classification, not
 * arithmetic: the approved-purchase spread has no journal, so the figure keeps
 * ESTIMATED_AWAITING_SETTLEMENT / ACTUAL_UNPOSTABLE and stays unpostable.
 *
 * H-7b, CORRECTED 2026-08-10. An earlier revision of this comment claimed that
 * `customerDirectToDealerMinor` — the gap the customer pays the dealership
 * directly — had no persisted source and so could not be included. **That was
 * wrong**, and the claim was reached by grepping for a field of that name
 * instead of for the quantity. It is composed from two fields that ARE stored
 * on `financeApplications`, exactly as `recomputeAndPatchEconomics` composes it:
 *
 *     customerGapCashToDealerMinor + customerGapInstallmentToDealerMinor
 *
 * Leaving it out while subtracting the dealer contribution did not converge on
 * `computeDealerProceeds` — it moved the error to the other side of zero. On a
 * deal where the customer absorbs a 1,000 gap and the dealership contributes
 * 1,000, the true profit is unchanged, but the half-applied version reported it
 * 1,000 LOW, under a label asserting the contribution had been accounted for.
 * Understating an owner's profit is not the safe direction; it is the same
 * defect wearing the opposite sign.
 *
 * ⚠️ READ THIS BEFORE BUILDING THE GAP-RESOLUTION MUTATION. As of 2026-08-10
 * **no production code writes either field.** Every occurrence sets them to
 * `undefined`; nothing writes `gapResolution: CUSTOMER_ABSORBS | DEALER_ABSORBS
 * | SPLIT` either. The recording workflow does not exist yet, so this line is
 * structurally zero on every current deal and the `?? 0` is safe — but it is
 * safe by circumstance, NOT because absence means "no gap was negotiated".
 *
 * The composition is wired in advance precisely so the future writer cannot be
 * forgotten. A writer that populates `customerGapShareMinor` (the share) and
 * omits these two DESTINATION fields would silently understate profit by the
 * whole gap, and nothing here would notice. Populate both. Tracked as H-7b on
 * SCRUM-26.
 */
export function deriveManagementProfit(args: {
  /** A cancelled deal has no profit: its journal was reversed. */
  dealCancelled?: boolean;
  approvedDealerPurchaseAmountMinor?: number;
  supplierSettlementMinor?: number;
  dealerContributionMinor?: number;
  /** `customerGapCashToDealerMinor + customerGapInstallmentToDealerMinor`. */
  customerDirectToDealerMinor?: number;
  actualExpensesMinor: number;
  currency: string;
  fullySettled: boolean;
}): ManagementProfit {
  // Checked first. A cancelled sale still carries its approval, its recorded
  // margin and its disbursement, so every input below remains computable — and
  // the figure they produce describes a deal whose journal has been reversed.
  // Reporting a profit for it is not a smaller error than reporting none.
  if (args.dealCancelled) return { available: false, reason: "DealCancelled" };
  if (args.approvedDealerPurchaseAmountMinor === undefined)
    return { available: false, reason: "NoApprovedPurchaseAmount" };
  if (args.supplierSettlementMinor === undefined)
    return { available: false, reason: "NoSupplierSettlement" };
  // Defaulting this to zero would be the very error H-7 corrects, just reached
  // from a different direction: it would publish the pre-contribution number
  // under the post-contribution name. Today the two fields are written and
  // cleared in the same patch, so an approval without a composition should not
  // occur — but that is an invariant of the current writers, not evidence about
  // the row in hand, and the failure mode of assuming it is an overstated profit.
  if (args.dealerContributionMinor === undefined)
    return { available: false, reason: "NoDealerContribution" };
  // `computeDealerProceeds` asserts non-negativity on every input; this had no
  // equivalent, so a negative value written through the admin raw-JSON editor
  // would INFLATE the owner-facing figure with nothing to catch it. A negative
  // amount on either line is not a smaller profit, it is a corrupt record.
  if (
    args.dealerContributionMinor < 0 ||
    (args.customerDirectToDealerMinor ?? 0) < 0 ||
    args.actualExpensesMinor < 0
  ) {
    // Its own reason rather than `NoDealerContribution`, which told the operator
    // to record a contribution that is already there — a defensive branch that
    // lies about which field is corrupt defeats its own purpose.
    return { available: false, reason: "CorruptInput" };
  }

  const lines: ManagementProfitLine[] = [
    { key: "APPROVED_PURCHASE", sign: 1, amountMinor: args.approvedDealerPurchaseAmountMinor },
    {
      key: "CUSTOMER_DIRECT_TO_DEALER",
      sign: 1,
      amountMinor: args.customerDirectToDealerMinor ?? 0,
    },
    { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: args.supplierSettlementMinor },
    { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: args.dealerContributionMinor },
    { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: args.actualExpensesMinor },
  ];

  return {
    available: true,
    basis: "MANAGEMENT_ESTIMATE",
    // Summed from the same lines the screen renders, so the headline and its
    // derivation cannot disagree — the arithmetic happens once, here.
    amountMinor: lines.reduce((total, line) => total + line.sign * line.amountMinor, 0),
    currency: args.currency,
    classification: args.fullySettled ? "ACTUAL_UNPOSTABLE" : "ESTIMATED_AWAITING_SETTLEMENT",
    lines,
    postable: false,
  };
}

/**
 * A CASH deal's profit, from the figures the ledger was posted on.
 *
 * ⚠️ This function performs NO arithmetic of its own on the headline. The
 * amount is `saleEconomics().dealershipMargin` exactly as computed there — the
 * single definition the GL, the P&L, `reports.salesReport` and the commission
 * engine already share. Re-deriving `salePrice − cost` here would have created a
 * THIRD profit formula for one deal, which is the defect SCRUM-26 spent three
 * review rounds removing from the financed side.
 *
 * The lines are presentational only: they explain the figure, they do not
 * produce it. They are therefore NOT summed to reach `amountMinor`, unlike
 * `deriveManagementProfit` where the lines genuinely are the derivation. On an
 * agent sale `VEHICLE_COST` is zero — there is no cost of a car the dealership
 * never bought — and the supplier's entitlement carries the subtraction instead.
 */
export function deriveAccountingProfit(args: {
  /** A cancelled sale's journal was reversed; it has no profit to report. */
  dealCancelled?: boolean;
  /**
   * Whether the sale has actually COMPLETED — i.e. whether a journal exists.
   *
   * ⚠️ `reconcilesToLedger: true` is a claim that this figure has a journal
   * behind it to agree with.
   * On a PENDING draft that claim is false: `createDraftSale` performs no
   * accounting side effects, so there is nothing posted to reconcile against.
   * Publishing an unqualified accounting headline for a draft would assert a
   * ledger entry that does not exist — the same class of false statement, in
   * the opposite direction, as dropping the qualifier from the financed figure.
   */
  saleCompleted: boolean;
  /**
   * Externally financed AND settled DIRECT_TO_SUPPLIER, with no application to
   * prove what the financier approved.
   *
   * ⚠️ Refuses even when a frozen margin is present, and that is the whole
   * point. On this route the earning is `approved − entitlement`; the finance
   * company pays the supplier what it approved, and `salePrice − entitlement`
   * reaches no party at all. `sales.create` accepts `financingType` and
   * `supplierSettlementRoute` together, and the write-path guard
   * (`FINANCED_DIRECT_NEEDS_APPROVED_AMOUNT`) only arrived with the SCRUM-30
   * release — so rows completed before it can carry a `consignedMarginMinor`
   * frozen at the sale-price spread. `saleEconomics` returns that recorded
   * margin unconditionally (its recorded-margin branch is checked before the
   * evidence rule), so on a 20,000 sale against a 15,000 entitlement where the
   * financier actually paid 18,000, the screen would publish a POSTABLE 5,000
   * for a deal that earned 3,000.
   *
   * There is no field on such a row that can prove otherwise, so the figure is
   * withheld rather than guessed. New rows of this shape cannot be created, so
   * refusing costs nothing going forward and protects every legacy one.
   *
   * Found by an adversarial reviewer AFTER I had rejected the weaker form of
   * the same claim. The rejection was wrong: I checked that the dangerous shape
   * could not be CREATED and failed to check whether it could already EXIST.
   */
  financedDirectWithoutApproval?: boolean;
  /** `saleEconomics().dealershipMargin` — `null` means genuinely UNKNOWN. */
  dealershipMarginMinor: number | null;
  /**
   * `null` means the figure could not be READ — a corrupt or foreign-currency
   * amount — never that the car sold for nothing.
   *
   * ⚠️ These were plain `number`s reached through `?? 0`, and that was a
   * confirmed defect. On an agent sale carrying a recorded margin the HEADLINE
   * does not depend on `salePrice` at all, so a `NaN` price (Convex accepts it
   * under a `v.number()` validator) left a valid, postable headline sitting
   * above a breakdown line reading "Sale price: 0.000" — a false statement about
   * a real deal, on an owner-facing screen. Nullable so the refusal survives all
   * the way to the renderer.
   */
  salePriceMinor: number | null;
  /** Zero on an agent sale; `null` under the same unreadable rule. */
  recognizedCostMinor: number | null;
  /** `saleEconomics().supplierSettlement` — `null` under the same UNKNOWN rule. */
  supplierEntitlementMinor: number | null;
  currency: string;
}): AccountingProfit {
  if (args.dealCancelled) return { available: false, reason: "DealCancelled" };
  // Before the margin is even consulted: a draft has earned nothing yet, and
  // saying so is not the same as saying the figure is unknown.
  if (!args.saleCompleted) return { available: false, reason: "SaleNotCompleted" };
  // Before the recorded margin is consulted, because on this route the recorded
  // margin is exactly what cannot be trusted.
  if (args.financedDirectWithoutApproval)
    return { available: false, reason: "FinancedDirectUnverified" };
  // Never coerced to zero. `reports.salesReport` counts these rows separately
  // and excludes them from `totalProfit` precisely so an incomplete report is
  // visible as incomplete; a screen that rendered 0 here would be the confident
  // wrong answer that refusal exists to prevent.
  if (args.dealershipMarginMinor === null) return { available: false, reason: "UnknownMargin" };

  /**
   * The breakdown is ALL-OR-NOTHING, and that is the point.
   *
   * These lines exist to explain the headline. A breakdown missing a term, or
   * one that does not add up to the figure above it, is worse than no breakdown
   * at all — it invites the reader to check the arithmetic and find it wrong.
   *
   * So: every term must be readable, and their signed sum must equal the
   * headline. Otherwise no lines are emitted and the screen shows the figure
   * alone. The headline itself is unaffected — it comes from
   * `dealershipMargin`, which has its own evidence.
   *
   * The sum check is not paranoia about arithmetic. `dealershipMargin` can come
   * from the FROZEN recorded margin while these lines are built from the sale
   * price and the entitlement, and those are separately stored, separately
   * editable fields. Nothing enforces that they agree, so this asks.
   */
  const supplierEntitlementLine =
    args.supplierEntitlementMinor !== null
      ? {
          key: "SUPPLIER_ENTITLEMENT" as const,
          sign: -1 as const,
          amountMinor: args.supplierEntitlementMinor,
        }
      : null;

  const lines: AccountingProfitLine[] =
    args.salePriceMinor === null || args.recognizedCostMinor === null
      ? []
      : [
          { key: "SALE_PRICE", sign: 1, amountMinor: args.salePriceMinor },
          { key: "VEHICLE_COST", sign: -1, amountMinor: args.recognizedCostMinor },
          ...(supplierEntitlementLine ? [supplierEntitlementLine] : []),
        ];

  const reconciles =
    lines.length > 0 &&
    lines.reduce((total, line) => total + line.sign * line.amountMinor, 0) ===
      args.dealershipMarginMinor;

  return {
    available: true,
    basis: "ACCOUNTING_RESULT",
    amountMinor: args.dealershipMarginMinor,
    currency: args.currency,
    lines: reconciles ? lines : [],
    reconcilesToLedger: true,
  };
}
