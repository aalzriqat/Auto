import { ConvexError, v } from "convex/values";
import { Doc } from "../_generated/dataModel";
import {
  classifyGapResolution,
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

export const quotationSourceValidator = v.union(
  v.literal("CALCULATED"),
  v.literal("MANUAL")
);

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
  vehicleCostMinor: number;
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
    vehicleCostMinor: args.vehicleCostMinor,
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

export { classifyGapResolution, evaluateQuotationException };

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
  if (facts.vehicleHandoverAt) return "HANDED_OVER";
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
