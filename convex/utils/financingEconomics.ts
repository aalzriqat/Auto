import { ConvexError, v } from "convex/values";
import { Doc } from "../_generated/dataModel";
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
  | "SETTLEMENT";

export const DEAL_STAGE_ORDER: DealStageKey[] = [
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

  const complete: Record<DealStageKey, boolean> = {
    APPLICATION: credit !== "DRAFT",
    CREDIT_DECISION: credit === "APPROVED",
    // A legacy row records no appraisal dimension at all. An approved credit
    // decision on such a row means the appraisal happened off-system, so
    // reading it as "not appraised" would assert something about the past that
    // the data does not support.
    APPRAISAL:
      appraisal === "COMPLETED" ||
      appraisal === "FINALIZED" ||
      (appraisal === undefined && credit === "APPROVED"),
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

  const blockers: Partial<Record<DealStageKey, DealStageBlocker>> = {
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
      amountMinor: number;
      currency: string;
      classification: ManagementProfitClassification;
      lines: ManagementProfitLine[];
      /** Structural, not advisory. This figure has no journal and never will. */
      postable: false;
    }
  | {
      available: false;
      reason: "NoApprovedPurchaseAmount" | "NoSupplierSettlement" | "NoDealerContribution";
    };

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
 * ⚠️ One asymmetry with `computeDealerProceeds` remains and is NOT guessed at
 * here: that function also ADDS `customerDirectToDealerMinor`, the gap the
 * customer pays the dealership directly. No such field is persisted on
 * `financeApplications`, so there is no sale-time evidence to read, and
 * inventing one would be the same error in the opposite direction. Raised on
 * SCRUM-26 as H-7b; do not close it by assuming zero.
 */
export function deriveManagementProfit(args: {
  approvedDealerPurchaseAmountMinor?: number;
  supplierSettlementMinor?: number;
  dealerContributionMinor?: number;
  actualExpensesMinor: number;
  currency: string;
  fullySettled: boolean;
}): ManagementProfit {
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

  const lines: ManagementProfitLine[] = [
    { key: "APPROVED_PURCHASE", sign: 1, amountMinor: args.approvedDealerPurchaseAmountMinor },
    { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: args.supplierSettlementMinor },
    { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: args.dealerContributionMinor },
    { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: args.actualExpensesMinor },
  ];

  return {
    available: true,
    // Summed from the same lines the screen renders, so the headline and its
    // derivation cannot disagree — the arithmetic happens once, here.
    amountMinor: lines.reduce((total, line) => total + line.sign * line.amountMinor, 0),
    currency: args.currency,
    classification: args.fullySettled ? "ACTUAL_UNPOSTABLE" : "ESTIMATED_AWAITING_SETTLEMENT",
    lines,
    postable: false,
  };
}
