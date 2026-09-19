import { ConvexError, v } from "convex/values";
import { Doc } from "../_generated/dataModel";
import { toMinorSameCurrencyOrUndefined, assertFiniteNumber, assertMajorAmountRepresentable } from "./money";
import {
  PERCENT_DECIMAL_PLACES,
  percentRoundsToZero,
  computeAppraisalGap,
  computeDealerProceeds,
  computeExpectedRemittance,
  computeFundingComposition,
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
 * A stamp of the economics an irreversible confirmation is about, demanded back
 * by the mutations that act on those figures.
 *
 * `convex/applications.ts` issues the SAME token (its private `economicsStamp`,
 * served on `get` and `dealCockpit`) and `registerVehicleHandover` compares
 * against it. That file is byte-pinned by `scripts/protectedSourcePins.test.ts`,
 * so the helper cannot be exported from there without re-pinning; this copy
 * exists for `resolveAppraisalGap`, and `financingEconomics.test.ts` holds the
 * two together — a stamp served by `get` must satisfy this function — so the
 * first divergence fails CI rather than refusing every gap resolution.
 *
 * Deliberately CARRYING NO MONEY: a revision counter that says nothing about the
 * deal but that it changed (see the pinned original for why a digest of the
 * figures would not have been safe either).
 */
export function economicsStamp(app: { economicsRevision?: number }): string {
  return `v2|${app.economicsRevision ?? 0}`;
}

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

/**
 * A fee a finance company charges. Snapshotted onto each application at
 * creation and READ-ONLY there: the expectation on a deal is the company's
 * policy as it stood that day, never edited per deal — what is recorded per
 * deal is the ACTUAL paid against it (`recordTemplateFeeActual`).
 */
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
  adminFees: v.optional(v.number()),
  feeTemplates: v.optional(v.array(financeFeeTemplateValidator)),
  /**
   * Set ONLY by `financeDealCosts.adoptCompanyFeeTemplates`: the snapshot was
   * frozen with no fee templates and an owner later adopted the company's
   * configured fees onto this deal, explicitly and audited, before any cost
   * was recorded. Absent on every snapshot whose templates were frozen at
   * creation. The rule version names WHICH company revision the templates
   * came from, since `ruleVersion` above still names the revision the
   * purchase rules were frozen at — the two need not agree, and saying so is
   * what keeps the snapshot honest about its own history.
   */
  feeTemplatesAdoptedFromRuleVersion: v.optional(v.number()),
  feeTemplatesAdoptedAt: v.optional(v.number()),
  feeTemplatesAdoptedBy: v.optional(v.id("users")),
});

/**
 * Customer-facing quote pricing snapshot.
 *
 * Freezes the complete Murabaha calculation inputs and outputs at the moment
 * the quotation is calculated, so that application underwriting (DBR, LTV)
 * and dealer-borne expenses remain permanently anchored to the exact quotation
 * terms rather than drifting if company settings or currency move later.
 */
export const customerQuotePricingSnapshotValidator = v.object({
  currency: v.string(),
  vehiclePrice: v.number(),
  downPayment: v.number(),
  termMonths: v.number(),

  executionFees: v.number(),
  commission: v.number(),
  profitRate: v.number(),
  insuranceRate: v.number(),
  gracePeriodMonths: v.number(),
  includesCommissionInDebt: v.boolean(),

  totalFinancedAmount: v.number(),
  totalContractValue: v.number(),
  monthlyInstallment: v.number(),
  totalProfit: v.number(),
  takafulAmount: v.number(),

  companyRuleVersion: v.optional(v.number()),
});

export type CustomerQuotePricingSnapshot = {
  currency: string;
  vehiclePrice: number;
  downPayment: number;
  termMonths: number;
  executionFees: number;
  commission: number;
  profitRate: number;
  insuranceRate: number;
  gracePeriodMonths: number;
  includesCommissionInDebt: boolean;
  totalFinancedAmount: number;
  totalContractValue: number;
  monthlyInstallment: number;
  totalProfit: number;
  takafulAmount: number;
  companyRuleVersion?: number;
};

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

/**
 * The appraisal a deal is currently answered by, or `undefined` when it has
 * none.
 *
 * Lifted verbatim out of `financingEconomics.recordApprovedPurchase`, which is
 * where this rule has always lived, so that the cockpit's reading of "who
 * valued this car" cannot drift from the approval's reading of "which appraisal
 * may be approved against". The rule is deliberately not re-derived anywhere:
 * this repository has already corrected a held-deposit predicate that had been
 * written three different ways, and a second opinion about which appraisal is
 * live would fork the same way.
 *
 * Two exclusions carry meaning and are not incidental:
 *
 *   - SUPERSEDED and REJECTED rows are gone. History here is append-only — a
 *     reappraisal supersedes its predecessor rather than replacing it — so the
 *     newest surviving row is the live one and the older rows must never answer
 *     for it.
 *   - A DEALER_ESTIMATE is never selected. It is not an appraisal; the schema
 *     marks it so precisely so it cannot be mistaken for one, and an approval
 *     refuses it outright. A deal carrying only an estimate therefore has NO
 *     active appraisal, which is the truthful answer rather than a convenient
 *     one.
 */
export function selectActiveAppraisal(
  appraisals: Array<Doc<"financeAppraisals">>
): Doc<"financeAppraisals"> | undefined {
  return appraisals
    .filter(
      (row) =>
        (row.status === "RECORDED" || row.status === "APPROVED") &&
        row.providerType !== "DEALER_ESTIMATE"
    )
    .sort((a, b) => b.appraisedAt - a.appraisedAt)[0];
}

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
    adminFees: company.adminFees,
    // feeTemplates is retired as a write authority and omitted from all new snapshots.
    // Historical application snapshots frozen before retirement retain their stored templates.
    feeTemplates: undefined,
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

/**
 * Whether a value is a readable minor-unit amount: a safe, non-negative
 * integer. The ONE predicate behind every "is this money a figure" decision —
 * the writers assert it, and every reader that republishes a stored amount
 * checks it, because `v.number()` admits NaN, Infinity, fractions, negatives
 * and unsafe integers, and NaN passes every negative comparison (`NaN < 0`
 * is false), so the test is positive for what is allowed.
 */
export function isMinorAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The customer's PLANNED gap contribution to the dealership —
 * `customerGapCashToDealerMinor + customerGapInstallmentToDealerMinor` —
 * composed at ONE boundary, with each present component validated BEFORE the
 * addition. Added first, a corrupt pair cancels: −100 + 200 is a perfectly
 * safe 100, and every deriver downstream would certify it. An ABSENT
 * component is zero: the writer (`resolveAppraisalGap`) records both
 * destinations together, so absence means "nothing agreed yet", never
 * "the customer pays nothing" — that is the domain's own reading and the
 * only place zero is assumed. Safe components can still overflow between
 * them; the sum is checked too.
 */
export type CustomerGapToDealer =
  | Readonly<{ readable: true; amountMinor: number }>
  | Readonly<{ readable: false; reason: "UNSAFE_AMOUNT" }>;

export function composeCustomerGapToDealer(
  app: Readonly<{ customerGapCashToDealerMinor?: number; customerGapInstallmentToDealerMinor?: number }>
): CustomerGapToDealer {
  const components = [app.customerGapCashToDealerMinor, app.customerGapInstallmentToDealerMinor];
  let amountMinor = 0;
  for (const component of components) {
    if (component === undefined) continue;
    if (!isMinorAmount(component)) return { readable: false, reason: "UNSAFE_AMOUNT" };
    amountMinor += component;
  }
  return Number.isSafeInteger(amountMinor)
    ? { readable: true, amountMinor }
    : { readable: false, reason: "UNSAFE_AMOUNT" };
}

/** The composition for a WRITER or a posting plan: the amount, or a refusal thrown before any write. */
export function requireCustomerGapToDealer(
  app: Readonly<{ customerGapCashToDealerMinor?: number; customerGapInstallmentToDealerMinor?: number }>,
  action: string
): number {
  const composed = composeCustomerGapToDealer(app);
  if (!composed.readable) {
    throw new ConvexError(
      `The customer's gap contribution to the dealership is not a readable amount (cash ${app.customerGapCashToDealerMinor}, instalments ${app.customerGapInstallmentToDealerMinor}), so ${action} is refused until the gap resolution is corrected.`
    );
  }
  return composed.amountMinor;
}

/** Rejects a caller-supplied money amount that is not a sane minor-unit integer. */
export function assertMinorAmount(value: number, label: string): void {
  if (!isMinorAmount(value)) {
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

export type CustomerLoanTerms = {
  profitRate: number;
  maxTermMonths: number;
  gracePeriodMonths: number;
  insuranceRate?: number;
  commission?: number;
  adminFees?: number;
  includesCommissionInDebt?: boolean;
};

/**
 * Asserts that customer-loan terms (profit rate, max term months, grace period,
 * insurance rate, commission, and execution fees) are finite, within their valid
 * domains, and representable in the specified currency.
 *
 * Enforces:
 * - profitRate: finite and >= 0
 * - maxTermMonths: finite, positive integer (> 0)
 * - gracePeriodMonths: finite, non-negative integer (>= 0), strictly less than maxTermMonths
 * - insuranceRate: finite and >= 0 (if present)
 * - commission: finite and >= 0, exactly representable in currency (if present)
 * - adminFees: finite and >= 0, exactly representable in currency (if present)
 */
export function assertCustomerLoanTermsValid(
  terms: CustomerLoanTerms,
  currency?: string
): void {
  assertFiniteNumber(terms.profitRate, "Profit rate");
  if (terms.profitRate < 0) {
    throw new ConvexError("Profit rate cannot be negative.");
  }

  assertFiniteNumber(terms.maxTermMonths, "Maximum term months");
  if (!Number.isInteger(terms.maxTermMonths) || terms.maxTermMonths <= 0) {
    throw new ConvexError(
      `Maximum term months must be a positive integer (got ${terms.maxTermMonths}).`
    );
  }

  assertFiniteNumber(terms.gracePeriodMonths, "Grace period months");
  if (!Number.isInteger(terms.gracePeriodMonths) || terms.gracePeriodMonths < 0) {
    throw new ConvexError(
      `Grace period months must be a non-negative integer (got ${terms.gracePeriodMonths}).`
    );
  }
  if (terms.gracePeriodMonths >= terms.maxTermMonths) {
    throw new ConvexError(
      `Grace period months (${terms.gracePeriodMonths}) must be strictly less than maximum term months (${terms.maxTermMonths}).`
    );
  }

  if (terms.insuranceRate !== undefined) {
    assertFiniteNumber(terms.insuranceRate, "Insurance rate");
    if (terms.insuranceRate < 0) {
      throw new ConvexError("Insurance rate cannot be negative.");
    }
  }

  if (terms.commission !== undefined) {
    assertFiniteNumber(terms.commission, "Commission");
    if (terms.commission < 0) {
      throw new ConvexError("Commission cannot be negative.");
    }
    if (currency) {
      assertMajorAmountRepresentable(terms.commission, currency, "Commission");
    }
  }

  if (terms.adminFees !== undefined) {
    assertFiniteNumber(terms.adminFees, "Execution fees (adminFees)");
    if (terms.adminFees < 0) {
      throw new ConvexError(
        `Execution fees (adminFees) must be a non-negative finite number (got ${terms.adminFees}).`
      );
    }
    if (currency) {
      assertMajorAmountRepresentable(
        terms.adminFees,
        currency,
        "Execution fees (adminFees)"
      );
    } else {
      const minor = Math.round(terms.adminFees * 1000);
      if (!Number.isSafeInteger(minor)) {
        throw new ConvexError(
          `Execution fees (adminFees) amount is too large to represent safely.`
        );
      }
    }
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

/**
 * The resolutions that SETTLE a positive appraisal gap — the ones
 * `resolveAppraisalGap` derives from an allocation that reconciles to the gap.
 * `NOT_REQUIRED` is deliberately absent: `approveDealerPurchaseAmount` writes it
 * only when the gap is zero, so a positive gap carrying it is a row that
 * contradicts itself, and the safe reading of a contradiction is "unsettled".
 */
export function appraisalGapIsSettled(gapResolution: GapResolution): boolean {
  return (
    gapResolution === "CUSTOMER_ABSORBS" ||
    gapResolution === "DEALER_ABSORBS" ||
    gapResolution === "SPLIT"
  );
}

/**
 * Refuses to advance a deal whose positive appraisal gap nobody has settled
 * (SCRUM-116).
 *
 * Until this existed the gap was enforced by the stage rail alone:
 * `deriveDealStages` marks GAP_RESOLUTION blocked and hides the tail behind it,
 * but `registerVehicleHandover` and `finalizeDeal` never asked. A direct call —
 * or any screen that does not draw the rail — could hand the vehicle over
 * against a shortfall nobody had allocated, and handover then SEALS the deal
 * against `resolveAppraisalGap`, so the only path that could settle it was
 * closed by the step that should have waited for it. Finalization is worse: it
 * posts the sale from `dealerContributionMinor` and the profit composition,
 * both of which the unrecorded split still moves.
 *
 * Scope is exactly the rail's: a gap that is present and positive, without a
 * settling resolution. Every other shape passes — no gap recorded (a deal that
 * predates the model, or one not yet approved), a zero gap (`NOT_REQUIRED`, as
 * the approval wrote it), and a settled one. The caller decides whether a deal
 * is in the population at all; `assertDealerEconomicsReady` already lets a
 * deal with no quotation through before reaching this.
 *
 * Runs at the mutation boundary through that shared precondition, before the
 * first write, because a refusal expressed only in the rail is a rendering, not
 * a rule. The message names the step that unblocks it.
 */
export function assertAppraisalGapSettledToAdvance(
  app: { rawAppraisalGapMinor?: number; gapResolution?: GapResolution },
  action: string
): void {
  const gap = app.rawAppraisalGapMinor;
  if (gap === undefined || !(gap > 0)) return;
  if (appraisalGapIsSettled(app.gapResolution)) return;
  // No figure in the message. The gap is a FINANCE-class field under the
  // SCRUM-117 projection and `register:vehicle_handover` is held by roles the
  // projection withholds it from; a refusal is a response like any other.
  throw new ConvexError(
    `The finance company approved less than the quotation on this deal, and who covers the difference has not been agreed. Resolve the appraisal gap before ${action}.`
  );
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
  /**
   * The finance company's purchase decision — and, inside it, the appraisal
   * gap. GAP_RESOLUTION used to be a ninth rail step of its own, shown only on
   * deals that had a gap, so the rail counted 7, 8 or 9 depending on the deal
   * and the lifecycle read differently from one deal to the next. The gap is a
   * CONDITIONAL TASK inside this stage: the stage is BLOCKED with a gap
   * blocker until the split is settled, and the same blocker keys still drive
   * the resolution action.
   */
  | "APPROVED_PURCHASE"
  | "DELIVERY_ACTIONS"
  /**
   * The moment the money actually moved — a MIRROR stage.
   *
   * `confirmDisbursement` and `confirmSupplierDisbursement` are real mutations
   * and `disbursedAt` a real field, but the rail had no stage for either: the
   * step was folded invisibly into SETTLEMENT. That hid the event a dealer
   * cares about most. AutoFlow records that the financier paid; it does not
   * cause the payment, so this stage waits on them and never refuses.
   */
  | "DISBURSEMENT"
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

/**
 * The EIGHT lifecycle stages of every financed deal, in rail order — always
 * all eight, on every deal. Nothing here is conditional: a deal with no
 * document rules still has a "handover procedures" stage (complete, since
 * nothing is required), and a deal with no appraisal gap still has an
 * approved-purchase stage (the gap is a task inside it, not a step).
 *
 * ⚠️ NOT CHRONOLOGICAL AT ONE POINT, ON PURPOSE. DISBURSEMENT is ordered before
 * HANDOVER because that is the sequence the dealer describes and the product's
 * prototype fixes, while the real transitions run the other way: both
 * disbursement mutations refuse a deal that is not CLOSED, `finalizeDeal` is
 * what closes it, and finalization refuses until the vehicle handover is
 * registered. `deriveDealStages` reconciles the two by never letting an
 * unreachable stage be the live one — see `reachable` there — so the rail
 * shows DISBURSEMENT as a quiet PENDING step ahead of a CURRENT handover.
 * `dealCockpitDerivation.test.ts` pins this order and that behaviour.
 */
export const DEAL_STAGE_ORDER: FinancedDealStageKey[] = [
  "APPLICATION",
  "CREDIT_DECISION",
  "APPRAISAL",
  "APPROVED_PURCHASE",
  "DELIVERY_ACTIONS",
  "DISBURSEMENT",
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

/**
 * Every blocker the rail can name, as VALUES rather than only as a type.
 *
 * Enumerable on purpose. The deployed cockpit renders a blocker by building its
 * translation key through interpolation — ``t(`Blocker${stage.blocker}`)`` —
 * rather than by looking one up in a map, so no static scan of the dictionaries
 * can see which keys that path needs, and `lib/i18n/keyCoverage.test.ts` says so
 * in as many words. Its guarantee was "every member resolves today", checked by
 * hand. This change added the first new member since that was written, which is
 * exactly the moment a hand-checked guarantee stops holding.
 *
 * The type is derived FROM this list so the two cannot disagree.
 */
export const DEAL_STAGE_BLOCKERS = [
  "AwaitingCreditDecision",
  "AwaitingAppraisal",
  "GapUnresolved",
  "GapNegotiationFailed",
  "NoApprovedPurchaseAmount",
  "DocumentsIncomplete",
  /** Waiting on the financing company to pay — never on the dealership. */
  "AwaitingDisbursement",
  "HandoverBlocked",
  "AwaitingSettlement",
] as const;

export type DealStageBlocker = (typeof DEAL_STAGE_BLOCKERS)[number];

/**
 * Who the deal is waiting on at this stage — the distinction the whole screen
 * turns on.
 *
 * `MIRROR` means an external party did something, or has yet to: AutoFlow
 * records the fact and has no standing to refuse it. The finance company's
 * credit decision, its appraisal, the amount it approved and the moment it
 * paid are all facts about somebody else's decision. The dealership cannot
 * take these steps, and a screen that offers a button for them is lying.
 *
 * `DEALER` means the dealership itself must decide or act. These are the only
 * stages where a refusal is legitimate, and the only ones that carry an action.
 *
 * Derived here rather than in the view because it is a property of the stage
 * model, and a second copy of it in React would be a second answer to "may this
 * be refused?" — the exact question the recording rule exists to settle.
 */
export type DealStageAuthority = "MIRROR" | "DEALER";

/**
 * Total over every key, cash and financed alike, so a new stage cannot be added
 * without answering whose move it is.
 */
const STAGE_AUTHORITY: Record<DealStageKey, DealStageAuthority> = {
  // The dealership puts the application together and sends it.
  APPLICATION: "DEALER",
  // Theirs entirely. AutoFlow never approves or evaluates a financing request.
  CREDIT_DECISION: "MIRROR",
  // Valued by the finance company or an independent appraiser; never by us.
  APPRAISAL: "MIRROR",
  // They name the amount; the dealership only puts their decision on record.
  // The gap inside it — who absorbs the shortfall — is the dealership's to
  // settle, and the stage's blocker says so when that is what it waits on.
  APPROVED_PURCHASE: "MIRROR",
  DELIVERY_ACTIONS: "DEALER",
  // They pay. The dealership confirms it happened and cannot cause it.
  DISBURSEMENT: "MIRROR",
  HANDOVER: "DEALER",
  // Deliberately DEALER, and only defensible since DISBURSEMENT was carved out
  // of it: what remains here is registering the expected payment and closing
  // the deal, both of which the dealership does. The external half — the money
  // actually moving — is its own stage now.
  SETTLEMENT: "DEALER",
  SALE_AGREED: "DEALER",
};

export interface DealStage {
  key: DealStageKey;
  state: DealStageState;
  /** A key, never a sentence — the screen owns the wording in both locales. */
  blocker?: DealStageBlocker;
  /**
   * Whose move this stage is. Required, not optional: a stage that does not say
   * lets the screen fall back to "the dealership must act", which is the wrong
   * default — it invites an operator to chase a finance company's decision.
   */
  authority: DealStageAuthority;
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
  /**
   * Whether the funding split actually came out.
   *
   * The companion to the basis above, and it is what stops the rail lying in
   * the other direction. `approveDealerPurchaseAmount` permits MANUAL with no
   * appraisal even for a company whose LTV rule multiplies the APPRAISAL — and
   * there the split cannot be computed at all, so an appraisal IS still needed
   * whatever the basis says. Reporting the stage complete then hid a real
   * prerequisite until the operator hit a handover refusal with nothing on the
   * rail to explain it.
   */
  fundingSplitComputed?: boolean;
  /** Every required document uploaded, verified or waived. */
  requiredDocumentsComplete: boolean;
  /**
   * Whether any document rule applies to this deal at all.
   *
   * Absent means "assume it does", so a caller that does not answer keeps the
   * old behaviour. When it is `false` the stage is not rendered: an org with no
   * `companyDocumentRules` has no paperwork gate, and the documents CARD is
   * already absent rather than empty in that case — the rail has to agree with
   * it, or the screen shows a blocker for a checklist that does not exist.
   */
  documentRulesApply?: boolean;
  /**
   * When the financier confirmed paying the SUPPLIER directly.
   *
   * The direct route never pays the dealership, so `disbursedAt` stays unset on
   * a deal whose money has entirely moved. Judging the disbursement stage by
   * that field alone would leave the route's own evidence unread and the stage
   * blocked forever on a finished deal.
   */
  supplierDisbursementConfirmedAt?: number;
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
  // A POSITIVE gap is settled by exactly the resolutions the mutation gate
  // (`assertAppraisalGapSettledToAdvance`) accepts — `appraisalGapIsSettled`,
  // shared so the rail cannot show a step complete that the writers refuse.
  // `NOT_REQUIRED` is written only for a zero gap; on a positive one it is a
  // row contradicting itself, and the rail reads a contradiction as unsettled.
  // A non-positive gap keeps its recorded resolution, or none if there was
  // never a gap to resolve.
  const positiveGap = (facts.rawAppraisalGapMinor ?? 0) > 0;
  const gapResolved = positiveGap
    ? appraisalGapIsSettled(gap)
    : gap === "NOT_REQUIRED" || appraisalGapIsSettled(gap) || (gap === undefined && !hasGap);

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
        facts.approvedDealerPurchaseAmountMinor !== undefined &&
        facts.fundingSplitComputed === true),
    // The amount on record AND the appraisal gap inside it settled. A gap of
    // zero is not a gap, and `undefined` means none was ever recorded.
    APPROVED_PURCHASE: facts.approvedDealerPurchaseAmountMinor !== undefined && gapResolved,
    // Every required document verified or waived. `every` over an empty
    // checklist is true, so a deal with no document rules — no paperwork
    // gate at all — has this stage complete rather than absent: the lifecycle
    // keeps its eight steps, and the documents card is still absent on its
    // own account.
    DELIVERY_ACTIONS: facts.requiredDocumentsComplete,
    // Either route's evidence closes it. Read as an OR rather than by route
    // because the route is not always recorded, and an unknown route must not
    // make a disbursement that demonstrably happened unreadable.
    DISBURSEMENT:
      facts.disbursedAt !== undefined || facts.supplierDisbursementConfirmedAt !== undefined,
    HANDOVER: handover === "HANDED_OVER",
    SETTLEMENT:
      facts.settlementComplete ??
      (settlement === "FULLY_SETTLED" || settlement === "RECONCILED"),
  };

  const blockers: Partial<Record<FinancedDealStageKey, DealStageBlocker>> = {
    CREDIT_DECISION: "AwaitingCreditDecision",
    APPRAISAL: "AwaitingAppraisal",
    // Two different waits on one stage, and the blocker names which: no
    // amount yet, or an amount whose gap nobody has settled. The gap keys are
    // the ones the cockpit's resolution action is keyed on.
    APPROVED_PURCHASE:
      facts.approvedDealerPurchaseAmountMinor === undefined
        ? "NoApprovedPurchaseAmount"
        : gap === "FAILED"
          ? "GapNegotiationFailed"
          : "GapUnresolved",
    DELIVERY_ACTIONS: "DocumentsIncomplete",
    DISBURSEMENT: "AwaitingDisbursement",
    HANDOVER: handover === "BLOCKED" ? "HandoverBlocked" : undefined,
    SETTLEMENT: "AwaitingSettlement",
  };

  /**
   * Which incomplete stages can be worked on NOW — as opposed to which exist.
   *
   * A disbursement is unreachable until the deal is CLOSED:
   * `confirmDisbursement` and `confirmSupplierDisbursement` both refuse any
   * other status, `finalizeDeal` is what closes the deal, and finalization
   * itself refuses until the vehicle handover is registered. Disbursement is
   * nevertheless ordered BEFORE handover on the rail, because that is the
   * sequence a dealer describes.
   *
   * Treating it as merely "incomplete" therefore made it the first incomplete
   * stage on every ordinary approved deal — the live stage — while the real
   * next step, handover, sat behind it as PENDING. That is not a labelling
   * problem: the cockpit renders a workflow action only when its stage is the
   * live one, and every action it has belongs to HANDOVER or SETTLEMENT, so the
   * handover button disappeared and the deal could not be progressed from the
   * screen at all. An unreachable stage is skipped when choosing the live one
   * and rendered PENDING, which is exactly what it is.
   *
   * `finalizedSaleId` is part of the test for the same reason it always was,
   * and is not redundant with CLOSED: a closed deal can be cancelled before
   * the money arrives, and that patch moves the status to CANCELLED while
   * leaving the finalized sale in place.
   */
  const reachable: Record<FinancedDealStageKey, boolean> = {
    APPLICATION: true,
    CREDIT_DECISION: true,
    APPRAISAL: true,
    APPROVED_PURCHASE: true,
    DELIVERY_ACTIONS: true,
    DISBURSEMENT:
      facts.status === "CLOSED" ||
      facts.finalizedSaleId !== undefined ||
      complete.DISBURSEMENT,
    HANDOVER: true,
    SETTLEMENT: true,
  };

  const order = DEAL_STAGE_ORDER;
  const firstIncomplete = order.find((key) => !complete[key] && reachable[key]);

  return order.map((key): DealStage => {
    if (complete[key]) return { key, state: "COMPLETE", authority: STAGE_AUTHORITY[key] };
    if (stopped) return { key, state: "STOPPED", authority: STAGE_AUTHORITY[key] };
    if (key !== firstIncomplete) return { key, state: "PENDING", authority: STAGE_AUTHORITY[key] };
    const blocker = blockers[key];
    // Whose move it is follows the ACTIVE blocker, not only the stage. The
    // finance company names the approved amount, but an unsettled appraisal
    // gap inside that stage is the dealership's to resolve — the cockpit
    // offers the dealership's ResolveGapAction on exactly these blockers —
    // so the rail must not say it is waiting on the finance company then.
    const authority: DealStageAuthority =
      key === "APPROVED_PURCHASE" &&
      (blocker === "GapUnresolved" || blocker === "GapNegotiationFailed")
        ? "DEALER"
        : STAGE_AUTHORITY[key];
    return blocker
      ? { key, state: "BLOCKED", blocker, authority }
      : { key, state: "CURRENT", authority };
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
    const authority = STAGE_AUTHORITY[key];
    if (complete[key]) return { key, state: "COMPLETE", authority };
    if (stopped) return { key, state: "STOPPED", authority };
    if (key !== firstIncomplete) return { key, state: "PENDING", authority };
    const blocker = blockers[key];
    return blocker
      ? { key, state: "BLOCKED", blocker, authority }
      : { key, state: "CURRENT", authority };
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

/** The stored status of a supplier margin claim, as the schema spells it. */
export type SupplierClaimStatus = "OPEN" | "PARTIALLY_PAID" | "PAID" | "DISPUTED" | "CANCELLED";

/**
 * Whether a receipt may be recorded against the supplier's claim right now —
 * decided by the SERVER, from the same facts `recordReceipt` refuses on.
 *
 * The position says what is OWED; this says what may be DONE about it. They
 * used to be one thing: the screen offered "Settle supplier" whenever the row
 * read OWED_TO_DEALERSHIP, and a DISPUTED claim reads exactly that — the money
 * is still owed, the two sides just disagree about it. So the button was shown
 * on a claim the mutation refuses on sight, and the operator learned of the
 * refusal only after typing the amount. Keeping the position truthful and
 * carrying the actionability beside it lets the screen say both things.
 *
 * The reasons are a closed set so a renderer can name the one it explains
 * (`CLAIM_DISPUTED` gets guidance) and stay silent on the rest. Every gap
 * fails CLOSED: no route, no claim, a claim whose status is not one the
 * mutation accepts, or an obligation that cannot be read all answer "no".
 */
export type SupplierReceiptActionability =
  | { actionable: true }
  | {
      actionable: false;
      reason:
        | "ROUTE_UNKNOWN"
        | "NOT_DIRECT_ROUTE"
        | "NO_CLAIM"
        | "CLAIM_DISPUTED"
        | "CLAIM_NOT_OPEN"
        | "OBLIGATION_NOT_OPEN";
    };

export function supplierReceiptActionability(args: {
  routeKnown: boolean;
  settlesDirect: boolean;
  /** The claim the projection resolved, or nothing — never an id the client chose. */
  claim: { id: string; status: SupplierClaimStatus } | undefined;
  obligation: ObligationState;
}): SupplierReceiptActionability {
  if (!args.routeKnown) return { actionable: false, reason: "ROUTE_UNKNOWN" };
  if (!args.settlesDirect) return { actionable: false, reason: "NOT_DIRECT_ROUTE" };
  if (!args.claim?.id) return { actionable: false, reason: "NO_CLAIM" };
  if (args.claim.status === "DISPUTED") return { actionable: false, reason: "CLAIM_DISPUTED" };
  // An allowlist of what `recordReceipt` accepts, not a denylist of what it
  // refuses: a status added to the schema tomorrow is refused here until
  // somebody decides otherwise, rather than offered by omission.
  if (args.claim.status !== "OPEN" && args.claim.status !== "PARTIALLY_PAID") {
    return { actionable: false, reason: "CLAIM_NOT_OPEN" };
  }
  if (args.obligation !== "OPEN") return { actionable: false, reason: "OBLIGATION_NOT_OPEN" };
  return { actionable: true };
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
  /**
   * The appraisal-gap share the customer AGREED to pay the dealership
   * (`customerGapCashToDealerMinor + customerGapInstallmentToDealerMinor`) —
   * `resolveAppraisalGap`'s allocation, a negotiated PLAN with no receipt,
   * cashbook entry or journal behind it. It belongs in the management
   * economics because the dealership is entitled to it, but it is PLANNED,
   * never paid or received, and its label must say so; the receipt-backed
   * figure lives in the overview's `customerPaidToDealer`.
   */
  | { key: "CUSTOMER_PLANNED_TO_DEALER"; sign: 1; amountMinor: number }
  | { key: "SUPPLIER_SETTLEMENT"; sign: -1; amountMinor: number }
  /**
   * The dealership's OWN car (STOCK): what it cost to hold, from the same
   * authority the GL posts COGS from. Never present together with
   * SUPPLIER_SETTLEMENT — a car has one owner, so a deal has one of the two.
   */
  | { key: "VEHICLE_COST"; sign: -1; amountMinor: number }
  /**
   * SOURCED only: what the dealership spent preparing the supplier's car
   * before the deal (period expenses — never capitalized, never part of the
   * supplier's entitlement). Subtracted exactly once, here.
   */
  | { key: "PREPARATION_EXPENSES"; sign: -1; amountMinor: number }
  | { key: "DEALER_CONTRIBUTION"; sign: -1; amountMinor: number }
  | { key: "ACTUAL_EXPENSES"; sign: -1; amountMinor: number }
  | { key: "FORECAST_EXPENSES"; sign: -1; amountMinor: number };

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
        /** STOCK only: the vehicle carries no cost basis to measure against. */
        | "NoVehicleCost"
        /** SOURCED only: the dealership's preparation spend cannot be stated (unreadable, too many rows, ambiguous history). */
        | "PreparationExpensesUnreadable"
        /** A dealer-borne cost line is denominated in another currency: the expense operand would be a partial sum, so the figure is withheld. */
        | "ExpensesMixedDenomination"
        /** A live cost line carries an amount that is not a safe non-negative integer, or the lines overflow: the expense operand is not a figure. */
        | "ExpensesUnreadable"
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
 * The writer exists now: `resolveAppraisalGap` (SCRUM-83, PR #303) records
 * both shares and all three destinations together, and refuses anything that
 * does not reconcile to the deal's own gap. Until 2026-09-12 no production
 * code wrote either field — every occurrence set them to `undefined` and this
 * line was structurally zero — and the `?? 0` survives from that era: it is
 * still right for a deal with no gap and for one whose gap is unsettled, where
 * absence means "nothing agreed yet", never "the customer pays nothing".
 *
 * The composition was wired in advance precisely so the writer could not be
 * forgotten. A writer that populated `customerGapShareMinor` (the share) and
 * omitted these two DESTINATION fields would silently understate profit by the
 * whole gap, and nothing here would notice — which is why the mutation takes
 * every destination as a required argument. (Was H-7b on SCRUM-26.)
 */
export function deriveManagementProfit(args: {
  /** A cancelled deal has no profit: its journal was reversed. */
  dealCancelled?: boolean;
  approvedDealerPurchaseAmountMinor?: number;
  supplierSettlementMinor?: number;
  dealerContributionMinor?: number;
  /**
   * `customerGapCashToDealerMinor + customerGapInstallmentToDealerMinor` — the
   * customer's PLANNED gap contribution to the dealership, served as
   * `CUSTOMER_PLANNED_TO_DEALER`. An allocation, not a receipt.
   */
  customerDirectToDealerMinor?: number;
  actualExpensesMinor: number;
  expectedExpensesMinor?: number;
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
  if (args.expectedExpensesMinor !== undefined && !isMinorAmount(args.expectedExpensesMinor)) {
    return { available: false, reason: "CorruptInput" };
  }
  const expenseBasisMinor = !args.fullySettled
    ? Math.max(args.expectedExpensesMinor ?? 0, args.actualExpensesMinor)
    : args.actualExpensesMinor;
  // FAIL CLOSED on EVERY operand, the same rule as the STOCK sibling below.
  // `computeDealerProceeds` asserts each input; this once checked only for
  // negatives, so NaN, Infinity, a fraction or an unsafe integer written
  // through the admin raw-JSON editor — or arriving as an unchecked expense
  // total — sailed through `< 0` and came out as a headline. A corrupt
  // operand is not a smaller profit, it is a corrupt record, and gets its own
  // reason rather than `NoDealerContribution`, which told the operator to
  // record a contribution that is already there.
  const operands = [
    args.approvedDealerPurchaseAmountMinor,
    args.supplierSettlementMinor,
    args.dealerContributionMinor,
    args.customerDirectToDealerMinor ?? 0,
    expenseBasisMinor,
  ];
  if (!operands.every(isMinorAmount)) {
    return { available: false, reason: "CorruptInput" };
  }

  const lines: ManagementProfitLine[] = [
    { key: "APPROVED_PURCHASE", sign: 1, amountMinor: args.approvedDealerPurchaseAmountMinor },
    {
      key: "CUSTOMER_PLANNED_TO_DEALER",
      sign: 1,
      amountMinor: args.customerDirectToDealerMinor ?? 0,
    },
    { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: args.supplierSettlementMinor },
    { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: args.dealerContributionMinor },
    {
      key:
        !args.fullySettled && (args.expectedExpensesMinor ?? 0) > args.actualExpensesMinor
          ? "FORECAST_EXPENSES"
          : "ACTUAL_EXPENSES",
      sign: -1,
      amountMinor: expenseBasisMinor,
    },
  ];
  // Summed from the same lines the screen renders, so the headline and its
  // derivation cannot disagree — the arithmetic happens once, here. Safe
  // operands can still overflow between them; a result that is not a safe
  // integer is not a figure.
  const amountMinor = lines.reduce((total, line) => total + line.sign * line.amountMinor, 0);
  if (!Number.isSafeInteger(amountMinor)) return { available: false, reason: "CorruptInput" };

  return {
    available: true,
    basis: "MANAGEMENT_ESTIMATE",
    amountMinor,
    currency: args.currency,
    classification: args.fullySettled ? "ACTUAL_UNPOSTABLE" : "ESTIMATED_AWAITING_SETTLEMENT",
    lines,
    postable: false,
  };
}

/**
 * `صافي ربح المعرض` for a financed deal on the dealership's OWN car (STOCK) —
 * the same management figure, measured against the vehicle's cost basis
 * instead of a supplier's settlement.
 *
 * `deriveManagementProfit` is consignment economics (ACC-1): it subtracts what
 * the SUPPLIER ends up with, and on a dealer-owned car there is no supplier,
 * so the cockpit reports NoSupplierSettlement and the owner sees nothing. A
 * STOCK deal has a cost instead, and it has ONE authority: the capitalized
 * cost `computeVehicleCapitalizedCost` returns — the figure the GL posts as
 * COGS at sale, which is frozen by construction once the car is SOLD because
 * every later expense on it is PERIOD_EXPENSE. That is what is subtracted
 * here; nothing is derived through a supplier settlement that does not exist.
 *
 * Same discipline as its sibling: every operand served, none inferred; a
 * missing operand is an `available: false` with its reason, never a zero.
 */
export function deriveStockManagementProfit(args: {
  dealCancelled?: boolean;
  approvedDealerPurchaseAmountMinor?: number;
  /** The capitalized cost basis, in the deal's minor units; undefined when the vehicle has none. */
  vehicleCostMinor?: number;
  dealerContributionMinor?: number;
  /** The customer's PLANNED gap contribution to the dealership — see `deriveManagementProfit`. */
  customerDirectToDealerMinor?: number;
  actualExpensesMinor: number;
  expectedExpensesMinor?: number;
  currency: string;
  fullySettled: boolean;
}): ManagementProfit {
  if (args.dealCancelled) return { available: false, reason: "DealCancelled" };
  if (args.approvedDealerPurchaseAmountMinor === undefined)
    return { available: false, reason: "NoApprovedPurchaseAmount" };
  if (args.vehicleCostMinor === undefined) return { available: false, reason: "NoVehicleCost" };
  if (args.dealerContributionMinor === undefined)
    return { available: false, reason: "NoDealerContribution" };
  if (args.expectedExpensesMinor !== undefined && !isMinorAmount(args.expectedExpensesMinor)) {
    return { available: false, reason: "CorruptInput" };
  }
  const expenseBasisMinor = !args.fullySettled
    ? Math.max(args.expectedExpensesMinor ?? 0, args.actualExpensesMinor)
    : args.actualExpensesMinor;
  // FAIL CLOSED on every operand, the approved amount included. `v.number()`
  // admits NaN, Infinity, fractions and unsafe integers, and a negative minor
  // amount is not a smaller cost — it is a corrupt row. None of them may reach
  // the subtraction below and come out looking like a profit.
  const operands = [
    args.approvedDealerPurchaseAmountMinor,
    args.vehicleCostMinor,
    args.dealerContributionMinor,
    args.customerDirectToDealerMinor ?? 0,
    expenseBasisMinor,
  ];
  if (!operands.every(isMinorAmount)) {
    return { available: false, reason: "CorruptInput" };
  }
  const lines: ManagementProfitLine[] = [
    { key: "APPROVED_PURCHASE", sign: 1, amountMinor: args.approvedDealerPurchaseAmountMinor },
    { key: "CUSTOMER_PLANNED_TO_DEALER", sign: 1, amountMinor: args.customerDirectToDealerMinor ?? 0 },
    { key: "VEHICLE_COST", sign: -1, amountMinor: args.vehicleCostMinor },
    { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: args.dealerContributionMinor },
    {
      key:
        !args.fullySettled && (args.expectedExpensesMinor ?? 0) > args.actualExpensesMinor
          ? "FORECAST_EXPENSES"
          : "ACTUAL_EXPENSES",
      sign: -1,
      amountMinor: expenseBasisMinor,
    },
  ];
  const amountMinor = lines.reduce((total, line) => total + line.sign * line.amountMinor, 0);
  // Safe operands can still overflow between them; a result that is not a
  // safe integer is not a figure.
  if (!Number.isSafeInteger(amountMinor)) return { available: false, reason: "CorruptInput" };
  return {
    available: true,
    basis: "MANAGEMENT_ESTIMATE",
    amountMinor,
    currency: args.currency,
    classification: args.fullySettled ? "ACTUAL_UNPOSTABLE" : "ESTIMATED_AWAITING_SETTLEMENT",
    lines,
    postable: false,
  };
}

/**
 * The consignment management profit with the dealership's pre-deal
 * preparation spend on the supplier's car subtracted — exactly once, as its
 * own line, leaving every other operand (and the supplier's entitlement)
 * exactly as the cockpit served it. An unavailable cockpit figure passes
 * through untouched; an unstatable preparation figure makes the whole
 * headline unavailable rather than silently omitting a cost.
 */
export function withPreparationExpenses(
  profit: ManagementProfit,
  preparation: { available: true; totalMinor: number } | { available: false }
): ManagementProfit {
  if (!profit.available) return profit;
  if (!preparation.available) return { available: false, reason: "PreparationExpensesUnreadable" };
  if (!Number.isSafeInteger(preparation.totalMinor) || preparation.totalMinor < 0) {
    return { available: false, reason: "CorruptInput" };
  }
  const amountMinor = profit.amountMinor - preparation.totalMinor;
  if (!Number.isSafeInteger(amountMinor)) return { available: false, reason: "CorruptInput" };
  const line: ManagementProfitLine = { key: "PREPARATION_EXPENSES", sign: -1, amountMinor: preparation.totalMinor };
  return { ...profit, amountMinor, lines: [...profit.lines, line] };
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
