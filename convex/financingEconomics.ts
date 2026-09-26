import { ConvexError, v } from "convex/values";
import { resolveDealCurrency, settlementDeductedTotalMinor } from "./utils/settlementDeductions";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import {
  mayEstablishAppliedLtv,
  mayReadFinanceEconomics,
  mayReadQuotationWorkflow,
  projectFinanceApplication,
  projectFinanceApplicationOverrides,
  requiresLtvPercentFor,
} from "./utils/financeApplicationProjection";
import { PERMISSIONS } from "./utils/permissions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import {
  computeSubmittedQuotation,
  isApprovalFarFromEvidence,
} from "../lib/financingEconomics";
import {
  consignedSettlementRoute,
  dealershipCollectsGross,
  directSettlementBelowEntitlementRefusal,
  isConsignedAgentSale,
} from "./utils/vehicleOwnership";
import { computeVehicleCapitalizedCost } from "./utils/vehicleCost";
import {
  toMinorUnits,
  toMinorSameCurrencyOrUndefined,
  assertSupportedDenomination,
  denominationOf,
} from "./utils/money";
import {
  assertGapResolutionValid,
  assertMinorAmount,
  buildRuleSnapshot,
  classifyGapResolution,
  deriveEconomics,
  economicsStamp,
  evaluateQuotationException,
  requireCustomerGapToDealer,
  resolveAppliedLtv,
  selectActiveAppraisal,
  type FinanceCompanyRuleSnapshot,
} from "./utils/financingEconomics";

/**
 * The dealer side of a financed vehicle sale: what we quoted the financing
 * company, what it appraised the vehicle at, what it will actually buy at, and
 * what that leaves the dealership.
 *
 * `applications.ts` next door owns the credit-file lifecycle — documents,
 * status, handover, disbursement. This module owns the money, and deliberately
 * writes only its own fields so the two can ship independently.
 *
 * Every stored figure is recomputed here from stored inputs. The wizard renders
 * the same numbers because it imports the same pure module, never because the
 * backend trusted what it posted.
 */

// ---------------------------------------------------------------------------
// Shared loading and derivation
// ---------------------------------------------------------------------------

const APPLICATION_NOT_FOUND = "Finance application not found in this organization.";

/**
 * The rule snapshot governing a deal.
 *
 * Reads the copy stored on the application when there is one. Falling back to
 * the live company row is only for applications created before snapshots
 * existed — and it is a fallback, not the normal path, because reading rules
 * live is precisely how editing a company's LTV next month would retroactively
 * change what a closed deal was approved under.
 */
async function resolveRuleSnapshot(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">
): Promise<FinanceCompanyRuleSnapshot> {
  if (app.companyRuleSnapshot) return app.companyRuleSnapshot;
  if (!app.companyId) {
    throw new ConvexError(
      "This application has no finance company, so it has no dealer-side purchase rules."
    );
  }
  const company = await ctx.db.get(app.companyId);
  if (!company || company.orgId !== app.orgId) {
    throw new ConvexError("Finance company not found in this organization.");
  }
  return buildRuleSnapshot(company);
}

/**
 * Recomputes every derived figure and patches them onto the application.
 *
 * Called after any write that moves an input. Nothing derived is ever stored
 * from a caller's arguments, so the funding composition and the gap cannot
 * drift from the quotation and approval they come from.
 *
 * Silently does nothing until both the quotation and the approved purchase
 * amount exist — before that there is no composition to compute, and writing
 * zeroes would read as "the company funds nothing", which is a different and
 * false claim.
 */
/**
 * Re-derive one application's economics from whatever is on the record now.
 *
 * Exported so the step that ESTABLISHES a deal's accounting can also refresh
 * the figures it is establishing. The settlement costs feed the expected
 * remittance, and a cost recorded after the last recompute would otherwise
 * leave a stored figure that no longer follows from the deal's own rows.
 *
 * Safe to call at any point: it is a pure re-derivation of stored inputs, and
 * it does nothing at all until the quotation, the approval and the applied LTV
 * all exist.
 */
export async function recomputeEconomicsForApplication(
  ctx: MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<void> {
  const app = await ctx.db.get(applicationId);
  if (!app) return;
  // A deal with no configured financier has no dealer-side purchase rules to
  // derive anything from, and `resolveRuleSnapshot` refuses rather than
  // inventing some. Classifying such a deal is still perfectly legitimate — it
  // simply has no funding split — so this declines to run rather than turning a
  // successful classification into a failure about rules the deal never had.
  if (!app.companyId) return;
  await recomputeAndPatchEconomics(ctx, app);
}

async function recomputeAndPatchEconomics(
  ctx: MutationCtx,
  app: Doc<"financeApplications">
): Promise<void> {
  // Defense in depth. Every caller is guarded at its own handler top, but this
  // is the shared writer of the derived split — if a future mutation reaches it
  // without its own check, the bad denomination stops here rather than being
  // persisted and scaled by a guess further downstream.
  assertSupportedDenomination(app.economicsCurrency, "recomputing these economics");
  const snapshot = await resolveRuleSnapshot(ctx, app);
  // Pinning is the moment an unpinned deal's denomination becomes permanent.
  // It must agree with the cost/custody rows already recorded against the deal
  // (SCRUM-319): those were written in the org currency of their day and are
  // protected by the settings lock, so a pin that disagreed with them could
  // only come from a raw edit — and is refused rather than persisted.
  const currency = await resolveDealCurrency(ctx, app, "recomputing these economics");

  if (
    app.submittedQuotationMinor === undefined ||
    app.approvedDealerPurchaseAmountMinor === undefined ||
    app.appliedLtvPercent === undefined
  ) {
    return;
  }

  // Refused before any write: a corrupt component must not be recomputed
  // into the stored economics, and added inline a corrupt pair cancels.
  const customerGapToDealer = requireCustomerGapToDealer(app, "recomputing this deal's economics");

  // The appraisal the approval was actually based on, for companies whose LTV
  // rule multiplies the appraisal rather than the approved amount.
  const basisAppraisal = app.approvedPurchaseAppraisalId
    ? await ctx.db.get(app.approvedPurchaseAppraisalId)
    : null;

  // An unknown first payment is not zero (SCRUM-373): deriving with 0 moved
  // the whole payment into the dealer's contribution. Withhold the split the
  // same way an unrecorded LTV basis does, below. Recording a quotation always
  // persists a first payment now, so this is reached only by a legacy row.
  const firstPaymentUnknown = app.customerFirstPaymentMinor === undefined;

  const derived = firstPaymentUnknown ? null : deriveEconomics({
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    appliedLtvPercent: app.appliedLtvPercent,
    customerFirstPaymentMinor: app.customerFirstPaymentMinor as number,
    submittedQuotationMinor: app.submittedQuotationMinor,
    ltvBasis: snapshot.ltvBasis,
    ...(basisAppraisal && basisAppraisal.orgId === app.orgId
      ? { independentAppraisalMinor: basisAppraisal.appraisalAmountMinor }
      : {}),
    dealerContributionSettlement:
      app.dealerContributionSettlement ??
      snapshot.dealerContributionSettlement ??
      "PAID_SEPARATELY",
    customerContributionSettlement:
      app.customerContributionSettlement ??
      snapshot.customerContributionSettlement ??
      "PASSED_THROUGH",
    // Zero until somebody records that the customer actually paid the finance
    // company. Defaulting to the whole first payment decided the destination on
    // the customer's behalf: for a RETAINED_BY_COMPANY company it subtracted
    // the full amount from the expected remittance on the unproven assumption
    // that the dealership never received it. The field is documented as "what
    // the customer pays, whoever receives it" — so the server must not guess
    // who did.
    customerContributionToFinanceCompanyMinor:
      app.customerContributionToFinanceCompanyMinor ?? 0,
    // What the company actually withholds, read from the deal's own recorded
    // cost lines.
    //
    // This was a literal zero, described as the correct reading of "no fees have
    // been recorded". It was that on the day it was written and stopped being it
    // the moment fee rows existed: the stored remittance then asserted that a
    // company withholding a commission would nonetheless transfer the whole
    // gross. Every consumer read that number as authoritative, so the overstatement
    // was invisible — there was nothing to compare it against.
    //
    // Recorded actuals only, and a line still awaiting one contributes nothing.
    // That is not a claim it withholds nothing: `classifyDealAccounting` refuses
    // while any line lacks an actual, and finalization refuses an unclassified
    // deal, so no journal is ever posted from a partially-recorded settlement.
    feeDeductionsMinor: await settlementDeductedTotalMinor(ctx, app._id, currency),
    customerDirectToDealerMinor: customerGapToDealer,
    dealerBorneExpensesMinor:
      app.actualClosingExpensesMinor ?? app.estimatedClosingExpensesMinor ?? 0,
    // The profit figures are not stored yet, so the vehicle's cost is not read
    // here — it cost a ctx.db.get on every quotation and approval write to
    // compute a number nothing consumed.
  });

  // The company's LTV rule names an amount nobody has recorded — commonly a
  // manual approval under a company that lends against the appraisal. Leave
  // every derived figure unset rather than storing one computed against a
  // substitute basis, and say so.
  if (!derived) {
    await ctx.db.patch(app._id, {
      economicsCurrency: currency,
      // Clearing the split moves it just as much as recomputing it: a
      // confirmation rendered against the old figures must stop matching.
      economicsRevision: (app.economicsRevision ?? 0) + 1,
      financeCompanyFundedPortionMinor: undefined,
      unfinancedPortionMinor: undefined,
      dealerContributionMinor: undefined,
      expectedDealerRemittanceMinor: undefined,
      rawAppraisalGapMinor: undefined,
      needsFinancingReconciliation: true,
      financingReconciliationReason: appendReconciliationReason(
        app.financingReconciliationReason,
        firstPaymentUnknown
          ? "The customer's first payment is not recorded on this deal. Record it before relying on the funding split."
          : `This finance company applies its LTV to the ${(snapshot.ltvBasis ?? "APPROVED_PURCHASE_AMOUNT").toLowerCase().replace(/_/g, " ")}, which has not been recorded on this deal. Record it before relying on the funding split.`
      ),
      updatedAt: Date.now(),
    });
    return;
  }

  // Only meaningful once somebody has recorded where the customer's money
  // actually went. For a company that retains customer funds, assuming it
  // retained nothing overstates the remittance by the whole first payment —
  // the mirror of the assumption this stopped making in the other direction.
  const remittanceIsKnowable =
    (app.customerContributionSettlement ??
      snapshot.customerContributionSettlement ??
      "PASSED_THROUGH") === "PASSED_THROUGH" ||
    app.customerContributionToFinanceCompanyMinor !== undefined;

  await ctx.db.patch(app._id, {
    economicsCurrency: currency,
    // The shared recompute — the writer the first pass at this missed, and the
    // reason the guard test exists rather than three careful edits. It moves
    // the funding split without touching the approved amount, so a handover
    // confirmation showing the old split would otherwise still have sealed.
    economicsRevision: (app.economicsRevision ?? 0) + 1,
    financeCompanyFundedPortionMinor: derived.composition.financeCompanyFundedPortionMinor,
    unfinancedPortionMinor: derived.composition.unfinancedPortionMinor,
    dealerContributionMinor: derived.composition.dealerContributionMinor,
    expectedDealerRemittanceMinor: remittanceIsKnowable
      ? derived.remittance.expectedDealerRemittanceMinor
      : undefined,
    rawAppraisalGapMinor: derived.gap.rawAppraisalGapMinor,
    // Blanking the remittance silently would be worse than the assumption it
    // replaced. Nothing writes customerContributionToFinanceCompanyMinor yet,
    // so for a company that retains customer funds this is not a transient
    // gap — it is every deal, permanently — and an unflagged blank reads
    // downstream exactly like agreement.
    ...(remittanceIsKnowable
      ? {}
      : {
          needsFinancingReconciliation: true,
          financingReconciliationReason: appendReconciliationReason(
            app.financingReconciliationReason,
            `${snapshot.companyName} keeps the customer's payment rather than passing it through, and how much reached them has not been recorded. The expected dealer remittance cannot be determined until it is.`
          ),
        }),
    updatedAt: Date.now(),
  });
}

/**
 * Adds a reason without discarding one already on the row.
 *
 * Overwriting lost the earlier note — typically the migration's account of why
 * a legacy deal needs looking at — and left whoever picks the row up with only
 * the most recent of several genuine problems.
 */
function appendReconciliationReason(existing: string | undefined, addition: string): string {
  if (!existing) return addition;
  if (existing.includes(addition)) return existing;
  return `${existing} ${addition}`;
}

/**
 * The appraisal an approved amount is JUDGED against — newest real one on file.
 *
 * Not the approval's basis appraisal, which under MANUAL is deliberately not
 * adopted unless the company's LTV rule needs it. Shared by the mutation that
 * refuses an unacknowledged outlier and by the query that tells the screen an
 * amount is unusual, so the two cannot reach different conclusions about the
 * same deal. That drift is not hypothetical: the first cut of this check reused
 * the basis appraisal and ended up comparing against the quotation alone.
 */
/**
 * Whether the recorded approved amount is unlike every figure on file.
 *
 * ONE derivation, consumed by `getEconomics` and by `applications.get`. The
 * cockpit reads the first and the legacy Review screen reads the second, and
 * for a while the legacy screen simply passed `false` — so the same deal could
 * be flagged as anomalous on one entry point to the one-way door and presented
 * as ordinary on the other. Re-deriving it there would have been worse: two
 * opinions about what counts as unusual, free to disagree with each other and
 * with the mutation that refuses an unacknowledged outlier.
 *
 * `visible` gates it, because this is a judgement ABOUT a figure the caller may
 * not be shown, and emphasis is meaningless where there is nothing to emphasise.
 */
export function approvedAmountIsFarFromEvidenceFor(
  app: Doc<"financeApplications">,
  appraisals: Array<Doc<"financeAppraisals">>,
  visible: boolean
): boolean {
  if (!visible || app.approvedDealerPurchaseAmountMinor === undefined) return false;
  return isApprovalFarFromEvidence({
    approvedAmountMinor: app.approvedDealerPurchaseAmountMinor,
    submittedQuotationMinor: app.submittedQuotationMinor,
    appraisalAmountMinor: resolveComparisonAppraisal(appraisals)?.appraisalAmountMinor,
  });
}

/**
 * Retained as a NAME, not as a second rule: "the appraisal this approval is
 * compared against" and "the appraisal this deal is currently answered by" are
 * the same row, and they were previously two byte-identical copies of the same
 * predicate in this file. The reading now has one home in
 * `utils/financingEconomics`, so the cockpit cannot disagree with the approval
 * about which appraisal is live.
 */
function resolveComparisonAppraisal(
  appraisals: Array<Doc<"financeAppraisals">>
): Doc<"financeAppraisals"> | undefined {
  return selectActiveAppraisal(appraisals);
}

async function recordOverride(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    field: string;
    previousValue: number | string | undefined;
    newValue: number | string;
    reason: string;
    changedBy: Id<"users">;
  }
): Promise<void> {
  await ctx.db.insert("financeApplicationOverrides", {
    orgId: args.orgId,
    applicationId: args.applicationId,
    field: args.field,
    previousValue: args.previousValue === undefined ? undefined : String(args.previousValue),
    newValue: String(args.newValue),
    reason: args.reason,
    changedBy: args.changedBy,
    changedAt: Date.now(),
  });
}


/** Why an exception was refused, phrased for the person who asked for it. */
function quotationExceptionRefusal(
  evaluation: ReturnType<typeof evaluateQuotationException>,
  snapshot: FinanceCompanyRuleSnapshot
): string {
  if (evaluation.reason === "NOT_ALLOWED") {
    return `${snapshot.companyName} does not accept the submitted quotation when the appraisal is lower.`;
  }
  if (evaluation.reason === "NO_SHORTFALL") {
    return "There is no appraisal shortfall, so no exception is needed.";
  }
  return `The appraisal is ${evaluation.shortfallPercent.toFixed(2)}% below the quotation, outside ${snapshot.companyName}'s tolerance of ${snapshot.lowerAppraisalTolerancePercent ?? 0}%.`;
}

/**
 * Enforces the rule belonging to the basis the caller named.
 *
 * Extracted from the approval handler so each basis reads as one rule rather
 * than a branch inside a function that also loads the application, resolves the
 * LTV and the appraisal, writes an audit row and patches three times.
 */
/**
 * Whether the company's LTV rule is applied to an APPRAISAL amount.
 *
 * `resolveLtvBaseMinor` needs the appraisal for these two bases and cannot
 * compute a funding split without one, whatever basis the approval was recorded
 * under — which is why the approval keeps the appraisal as its LTV base even
 * when the decision itself was a manually named figure.
 */
function ltvRuleNeedsAppraisal(ltvBasis: FinanceCompanyRuleSnapshot["ltvBasis"]): boolean {
  return ltvBasis === "INDEPENDENT_APPRAISAL" || ltvBasis === "LOWER_OF_APPRAISAL_AND_QUOTATION";
}

function assertApprovalBasisValid(args: {
  basis: "APPRAISAL" | "QUOTATION_EXCEPTION" | "MANUAL";
  approvedAmountMinor: number;
  submittedQuotationMinor: number;
  appraisal: Doc<"financeAppraisals"> | undefined;
  snapshot: FinanceCompanyRuleSnapshot;
  notes?: string;
}): void {
  if (args.basis === "APPRAISAL") {
    const appraised = args.appraisal!.appraisalAmountMinor;
    if (args.approvedAmountMinor !== appraised) {
      throw new ConvexError(
        `An approval based on the appraisal must equal it (${appraised}). Use the exception or manual basis to approve a different amount.`
      );
    }
    return;
  }

  if (args.basis === "QUOTATION_EXCEPTION") {
    if (args.approvedAmountMinor !== args.submittedQuotationMinor) {
      throw new ConvexError(
        "A quotation exception approves at the submitted quotation. Use the manual basis for any other amount."
      );
    }
    const evaluation = evaluateQuotationException({
      submittedQuotationMinor: args.submittedQuotationMinor,
      independentAppraisalMinor: args.appraisal!.appraisalAmountMinor,
      allowsQuotationAboveAppraisal: args.snapshot.allowsQuotationAboveAppraisal ?? false,
      lowerAppraisalTolerancePercent: args.snapshot.lowerAppraisalTolerancePercent ?? 0,
    });
    if (!evaluation.eligible) {
      throw new ConvexError(quotationExceptionRefusal(evaluation, args.snapshot));
    }
    return;
  }

  if (!args.notes?.trim()) {
    throw new ConvexError("A manually approved purchase amount must record why.");
  }
}

/** The solver inputs a caller may override; anything omitted comes off the deal. */
interface QuotationSolverOverrides {
  targetSellingAmountMinor?: number;
  estimatedDealerBorneExpensesMinor?: number;
  quotationBufferMinor?: number;
  customerFirstPaymentMinor?: number;
  ltvPercent?: number;
}

type CustomerFirstPaymentSource = "EXPLICIT" | "STORED" | "QUOTE_SEED";

/**
 * The customer first payment a quotation is solved with, and where it came
 * from (SCRUM-373).
 *
 * An absent first payment is UNKNOWN, never zero. This replaced
 * `override ?? stored ?? 0`, which persisted a confident zero onto every
 * application created before `createFromQuote` seeded the field — seven of ten
 * production deals, one of them showing 0 beside a quote that said 700.
 *
 * Order: an explicit argument; else the value already on the application (a
 * stored zero included — refusing to trust it is the historical correction's
 * job, not this resolver's); else the originating quote's down payment, the
 * same seed `createFromQuote` writes, read only from a quote owned by the
 * deal's own org. Undefined when none exists: the caller refuses rather than
 * solving with a substitute.
 */
async function resolveCustomerFirstPayment(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  override: number | undefined
): Promise<{ minor: number; source: CustomerFirstPaymentSource } | undefined> {
  if (override !== undefined) return { minor: override, source: "EXPLICIT" };
  if (app.customerFirstPaymentMinor !== undefined) {
    return { minor: app.customerFirstPaymentMinor, source: "STORED" };
  }
  const quote = await ctx.db.get(app.quoteId);
  if (!quote || quote.orgId !== app.orgId) return undefined;
  if (typeof quote.downPayment !== "number" || !Number.isFinite(quote.downPayment)) {
    return undefined;
  }
  const currency = await resolveDealCurrency(ctx, app, "seeding the customer's first payment");
  // The non-throwing conversion: `toMinorUnits` throws on overflow, which
  // would surface its own text instead of CUSTOMER_FIRST_PAYMENT_UNKNOWN. A
  // quote saved today cannot hold such an amount; a legacy or hand-edited one can.
  const minor = toMinorSameCurrencyOrUndefined(quote.downPayment, currency, currency);
  if (minor === undefined || minor < 0) return undefined;
  return { minor, source: "QUOTE_SEED" };
}

/**
 * Stable, figure-free: safe for a caller who may not read finance economics
 * (the query forwards ConvexError text only to finance readers anyway).
 */
const CUSTOMER_FIRST_PAYMENT_UNKNOWN =
  "The customer's first payment is not recorded on this deal and its originating quote does not carry one. Record it before the quotation.";

/**
 * Runs the solver for an EXISTING application, under the rules that govern it.
 *
 * One function, two callers — `suggestQuotationForApplication` and
 * `recordSubmittedQuotation` — because the mutation now demands exact equality
 * with the solver's figure, and the only query that solved anything took a
 * `companyId` and built its snapshot from the LIVE company row. A deal created
 * under v1 whose company was since edited to v2 would therefore be shown a v2
 * figure and have it rejected against v1, with the error naming a number the
 * screen never displayed. Sharing the resolution makes "what you were shown is
 * what will be accepted" structural rather than a coincidence maintained by
 * hand in two places.
 *
 * Returns `result: undefined` when no target is recorded anywhere, which is a
 * different state from the solver running and being unavailable.
 */
async function solveQuotationForApplication(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  overrides: QuotationSolverOverrides
): Promise<{
  snapshot: FinanceCompanyRuleSnapshot;
  appliedLtvPercent: number;
  customerFirstPaymentMinor: number;
  customerFirstPaymentSource: CustomerFirstPaymentSource;
  targetForSolver: number | undefined;
  expensesForSolver: number | undefined;
  bufferForSolver: number | undefined;
  result: ReturnType<typeof computeSubmittedQuotation> | undefined;
}> {
  const snapshot = await resolveRuleSnapshot(ctx, app);
  const appliedLtvPercent = resolveAppliedLtv(
    snapshot,
    overrides.ltvPercent ?? app.appliedLtvPercent
  );

  const firstPayment = await resolveCustomerFirstPayment(
    ctx,
    app,
    overrides.customerFirstPaymentMinor
  );
  if (firstPayment === undefined) {
    throw new ConvexError(CUSTOMER_FIRST_PAYMENT_UNKNOWN);
  }
  const customerFirstPaymentMinor = firstPayment.minor;
  if (
    snapshot.minimumCustomerFirstPaymentMinor !== undefined &&
    customerFirstPaymentMinor < snapshot.minimumCustomerFirstPaymentMinor
  ) {
    throw new ConvexError(
      `${snapshot.companyName} requires a customer first payment of at least ${snapshot.minimumCustomerFirstPaymentMinor} minor units.`
    );
  }

  const targetForSolver = overrides.targetSellingAmountMinor ?? app.targetNetProceedsMinor;
  const expensesForSolver =
    overrides.estimatedDealerBorneExpensesMinor ?? app.estimatedDealerBorneExpensesMinor;
  const bufferForSolver = overrides.quotationBufferMinor ?? app.quotationBufferMinor;

  const result =
    targetForSolver !== undefined
      ? computeSubmittedQuotation({
          targetNetProceedsMinor: targetForSolver,
          // Never back-solved from the quotation: with nothing itemized this is
          // zero and the suggestion is correspondingly lower, which is the
          // honest figure rather than a fabricated allowance.
          estimatedDealerBorneExpensesMinor: expensesForSolver ?? 0,
          quotationBufferMinor: bufferForSolver,
          customerFirstPaymentMinor,
          appliedLtvPercent,
          customerFirstPaymentOffsetsUnfinancedShare:
            snapshot.customerFirstPaymentOffsetsUnfinancedShare,
        })
      : undefined;

  return {
    snapshot,
    appliedLtvPercent,
    customerFirstPaymentMinor,
    customerFirstPaymentSource: firstPayment.source,
    targetForSolver,
    expensesForSolver,
    bufferForSolver,
    result,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The quotation to send the finance company for a deal that does not exist yet.
 *
 * Used by the sales wizard, where there is no application row to hang anything
 * off. Returns the suggestion and the composition it implies so the wizard can
 * show the dealer contribution before anyone commits to the deal.
 */
export const suggestQuotation = query({
  args: {
    orgId: v.id("organizations"),
    companyId: v.id("financeCompanies"),
    targetSellingAmountMinor: v.number(),
    /**
     * Sum of the itemized costs the dealership expects to bear. Required, and
     * never inferred: with no fees itemized this is 0 and the suggestion is
     * correspondingly lower, which is the honest figure rather than a
     * fabricated allowance.
     */
    estimatedDealerBorneExpensesMinor: v.number(),
    /** Optional negotiation headroom. A commercial choice, not a cost. */
    quotationBufferMinor: v.optional(v.number()),
    customerFirstPaymentMinor: v.number(),
    ltvPercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
    assertMinorAmount(args.targetSellingAmountMinor, "Target selling amount");
    assertMinorAmount(
      args.estimatedDealerBorneExpensesMinor,
      "Estimated dealer-borne expenses"
    );
    if (args.quotationBufferMinor !== undefined) {
      assertMinorAmount(args.quotationBufferMinor, "Quotation buffer");
    }
    assertMinorAmount(args.customerFirstPaymentMinor, "Customer first payment");

    const company = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeCompanies",
      args.companyId,
      "Finance company not found in this organization."
    );
    const snapshot = buildRuleSnapshot(company);
    const appliedLtvPercent = resolveAppliedLtv(snapshot, args.ltvPercent);

    if (
      snapshot.minimumCustomerFirstPaymentMinor !== undefined &&
      args.customerFirstPaymentMinor < snapshot.minimumCustomerFirstPaymentMinor
    ) {
      throw new ConvexError(
        `${company.name} requires a customer first payment of at least ${snapshot.minimumCustomerFirstPaymentMinor} minor units.`
      );
    }

    const currency = await getOrgCurrency(ctx, args.orgId);
    const result = computeSubmittedQuotation({
      targetNetProceedsMinor: args.targetSellingAmountMinor,
      estimatedDealerBorneExpensesMinor: args.estimatedDealerBorneExpensesMinor,
      quotationBufferMinor: args.quotationBufferMinor,
      customerFirstPaymentMinor: args.customerFirstPaymentMinor,
      appliedLtvPercent,
      customerFirstPaymentOffsetsUnfinancedShare:
        snapshot.customerFirstPaymentOffsetsUnfinancedShare,
    });

    // The solver is optional. When the company's rules do not establish that it
    // applies, say so and let the user enter the quotation they negotiated —
    // returning a figure anyway would present one dealership's arrangement as
    // every company's rule.
    if (!result.available) {
      return {
        available: false as const,
        reason: result.reason,
        appliedLtvPercent,
        currency,
        ruleVersion: snapshot.ruleVersion,
      };
    }

    return {
      available: true as const,
      appliedLtvPercent,
      currency,
      ruleVersion: snapshot.ruleVersion,
      submittedQuotationMinor: result.submittedQuotationMinor,
      projectedNetProceedsMinor: result.projectedNetProceedsMinor,
      customerCoversUnfinancedPortion: result.customerCoversUnfinancedPortion,
      financeCompanyFundedPortionMinor:
        result.composition.financeCompanyFundedPortionMinor,
      unfinancedPortionMinor: result.composition.unfinancedPortionMinor,
      dealerContributionMinor: result.composition.dealerContributionMinor,
      customerFirstPaymentSurplusMinor:
        result.composition.customerFirstPaymentSurplusMinor,
      ltvBaseCapApplied: result.composition.ltvBaseCapApplied,
    };
  },
});

/**
 * The quotation to send the finance company for a deal that already exists.
 *
 * The counterpart of `suggestQuotation`, and not a convenience wrapper over it:
 * that one resolves rules from the LIVE company row, which is right for a deal
 * nobody has created yet and wrong for one already in flight. This resolves
 * them from the application's own snapshot — the rules the deal is actually
 * governed by — so the figure it returns is the figure
 * `recordSubmittedQuotation` will accept as SYSTEM_CALCULATED.
 *
 * ## The read boundary (SCRUM-117, owner-proxy ruling 2026-09-13)
 *
 * This query was the hole in the row projection, and the hole was not the
 * SOLVER, it was the RETURN SHAPE. Three facts composed into a bypass:
 *
 *   1. it authorized on VIEW_FINANCE_APPLICATIONS alone, which the default
 *      SALES and MANAGER templates both carry;
 *   2. `solveQuotationForApplication` falls back from an omitted argument to
 *      the STORED row (`targetForSolver = overrides.targetSellingAmountMinor ??
 *      app.targetNetProceedsMinor`), and `recordSubmittedQuotation` populates
 *      that fallback on every recorded quotation — so the cockpit's own
 *      argument-less call ran entirely off gated figures;
 *   3. for SYSTEM_CALCULATED provenance the writer REQUIRES solver output to
 *      equal the stored quotation, so the response was an exact echo of it —
 *      together with `appliedLtvPercent` and the whole funding composition.
 *
 * The ruling fixes it as a POLICY REFINEMENT, not by blanking the calculator:
 *
 *   • the internal calculation may still read the stored row. Internal use is
 *     not disclosure; the RETURNED SHAPE is the security boundary;
 *   • the minimal quotation-workflow result — available/unavailable, a
 *     non-sensitive reason, the currency to label it in, and the suggested
 *     amount — requires QUOTATION-WORKFLOW authority (`create:` or `approve:`
 *     a finance application, or `view:finance`), not merely
 *     `view:finance_applications`. A custom view-only role gets nothing;
 *   • the accounting economics — `appliedLtvPercent`, the funding composition,
 *     the projected proceeds, the LTV cap flag — require `view:finance`, and
 *     are `undefined` for everyone else rather than a different return shape.
 */
export const suggestQuotationForApplication = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    targetSellingAmountMinor: v.optional(v.number()),
    estimatedDealerBorneExpensesMinor: v.optional(v.number()),
    quotationBufferMinor: v.optional(v.number()),
    customerFirstPaymentMinor: v.optional(v.number()),
    ltvPercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
    ]);
    /**
     * The quotation-workflow tier, ON TOP of the module's own door permission.
     *
     * `requireTenantAuth` takes an array with AND semantics, which cannot
     * express "any of the roles that legitimately quote", so the OR lives here
     * — but it lives here as the projection's own exported predicate, not as a
     * second hand-written copy of the rule.
     *
     * REFUSED AS AN ANSWER, NOT AS A THROW, and not because a soft refusal is
     * gentler: a ConvexError out of a query reaches `useQuery` during render
     * and takes the whole deal screen down. This file carries two other
     * comments written after exactly that failure. Nothing is disclosed either
     * way — the payload is the same "no calculation for you" the unavailable
     * branches already return — so the safe shape is the one that cannot lose
     * a screen. The cockpit never reaches it: it skips the query unless the
     * caller holds `create:finance_application`.
     */
    if (!mayReadQuotationWorkflow(auth.role)) {
      return {
        appliedLtvPercent: undefined,
        currency: await getOrgCurrency(ctx, args.orgId),
        ruleVersion: undefined,
        available: false as const,
        reason: "NOT_AUTHORIZED" as const,
      };
    }
    /**
     * A SIMULATION IS A REQUEST THIS CALLER MAY NOT MAKE — said out loud
     * (SCRUM-117, owner-proxy ruling 2026-09-14 08:31, superseding the 13:48
     * instruction to disregard these arguments silently).
     *
     * What stood here honored the five what-if controls for a `view:finance`
     * caller and quietly dropped them for everyone else, answering
     * `available: true` with the canonical figure and no indication that the
     * inputs had been ignored. That was my instruction at the time and it did
     * not leak — the figure returned was the deal's own canonical quotation,
     * and no product screen sends an override — but it made one request mean
     * two different calculations depending on who asked, with nothing in the
     * response to tell them apart. An ambiguous calculation contract is a
     * defect even when it is not a disclosure.
     *
     * So an unauthorized simulation is now REFUSED rather than reinterpreted.
     *
     * PRESENCE, not truthiness. `value !== undefined` is the test, so
     * `quotationBufferMinor: 0` and a value equal to the one already stored are
     * refused exactly like any other. Truthiness would have let `0` through —
     * and `0` is half of the reproduced attack, which pinned expenses and
     * buffer to zero.
     *
     * ALL FIVE, `ltvPercent` included. Four are monetary and it is easy to
     * enumerate only those; the rate is the sharpest of them, because at 100%
     * the composition collapses in a single step.
     *
     * Decided from the authenticated role and the arguments alone, BEFORE the
     * ownership read, the rule snapshot and the solver — so a refused request
     * reads nothing about the deal and can carry nothing out of it. The
     * currency comes from the ORG, which this caller is already authenticated
     * against, and is the same field the `NOT_AUTHORIZED` answer above
     * carries.
     *
     * An ANSWER, not a throw, for the reason documented above: a `ConvexError`
     * out of a query reaches `useQuery` during render and takes the whole deal
     * screen down.
     */
    const economicsVisible = mayReadFinanceEconomics(auth.role);
    const suppliedAnyOverride = [
      args.targetSellingAmountMinor,
      args.estimatedDealerBorneExpensesMinor,
      args.quotationBufferMinor,
      args.customerFirstPaymentMinor,
      args.ltvPercent,
    ].some((value) => value !== undefined);
    if (!economicsVisible && suppliedAnyOverride) {
      return {
        appliedLtvPercent: undefined,
        currency: await getOrgCurrency(ctx, args.orgId),
        ruleVersion: undefined,
        available: false as const,
        reason: "OVERRIDES_REQUIRE_FINANCE" as const,
      };
    }

    for (const [value, label] of [
      [args.targetSellingAmountMinor, "Target selling amount"],
      [args.estimatedDealerBorneExpensesMinor, "Estimated dealer-borne expenses"],
      [args.quotationBufferMinor, "Quotation buffer"],
      [args.customerFirstPaymentMinor, "Customer first payment"],
    ] as const) {
      if (value !== undefined) assertMinorAmount(value, label);
    }

    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );

    const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));

    /**
     * A denomination nobody can vouch for is an ANSWER here, never a refusal.
     *
     * Guards belong on the writers; this is a read. A ConvexError from a query
     * reaches `useQuery` during render and takes the whole deal screen down —
     * see the note immediately below, written after exactly that failure.
     * Throwing here hid the legacy rows this rule protects behind a blank page,
     * leaving no screen to restate the currency from: the guard defeated its
     * own purpose. It arrived by pattern-matching a line instead of reading
     * what enclosed it.
     *
     * Reported rather than silently suggested, because a figure scaled by a
     * guessed fallback is worse than no suggestion at all.
     */
    if (app.economicsCurrency !== undefined && denominationOf(app.economicsCurrency) === null) {
      return {
        appliedLtvPercent: undefined,
        currency,
        ruleVersion: undefined,
        available: false as const,
        reason: "UNSUPPORTED_CURRENCY",
      };
    }

    /**
     * The rules may not resolve at all — and that is an ANSWER, not an error.
     *
     * This query's whole contract is "here is a figure, or here is why there
     * isn't one", and it already says so for two other unsolvable cases.
     * `resolveAppliedLtv` and `resolveRuleSnapshot` instead THROW: no default
     * LTV on the company, no company on the application, a rate outside the
     * snapshot's own bounds. Convex surfaces that to `useQuery`, which throws
     * during render — so a company whose purchase rate nobody has entered cost
     * the operator the entire deal screen rather than one suggestion.
     *
     * Only `ConvexError` is caught, and its own message is returned rather than
     * a generic one, so nothing is silently swallowed and the operator is told
     * which setting to fix. Its sibling `suggestQuotation` keeps its throw: that
     * one is called from the wizard with caller-supplied inputs, not mounted
     * beside a screen it can take down.
     */
    /**
     * ONE BASIS, FOR EVERY READER.
     *
     * `args` unconditionally, which is the point: anyone who reaches this line
     * either holds `view:finance` — and keeps the full simulator, since nothing
     * is protected by refusing a what-if to someone who may read every operand
     * anyway — or supplied no override at all, because the refusal above turned
     * them back. The role-conditioned substitution that used to sit here is
     * gone, so the same application state and the same request can no longer
     * produce two different numerical bases.
     *
     * The five controls still fall back to stored fields when omitted, which is
     * exactly why the refusal above exists rather than a filter here: a caller
     * who may not read those fields could otherwise pin four of them and read
     * the fifth out of the answer. Reproduced against `10791edb7` for the
     * default SALES template — `estimatedDealerBorneExpensesMinor: 0`,
     * `quotationBufferMinor: 0` and either `ltvPercent: 100` or a very large
     * `customerFirstPaymentMinor` collapses the dealer contribution to zero and
     * the returned quotation IS `targetNetProceedsMinor` — with a control
     * showing the ordinary argument-less call returns a different figure.
     *
     * `economicsVisible` still governs what the RESPONSE carries: the rate, the
     * rule version, the composition and the projected proceeds are accounting
     * economics and stay behind `view:finance` either way.
     */
    let solved: Awaited<ReturnType<typeof solveQuotationForApplication>>;
    try {
      solved = await solveQuotationForApplication(ctx, app, args);
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      /**
       * ERRORS ARE OUTPUTS TOO.
       *
       * `resolveAppliedLtv` and the minimum-first-payment guard put real
       * figures in their messages — the snapshot's LTV bounds and the company's
       * minimum payment — and this catch forwarded `error.data` verbatim. Those
       * come from the deal's FROZEN snapshot, which can differ from the live
       * company row, so the message could carry a deal-specific historical fact
       * to a caller who may not read it. A non-finance caller gets a stable
       * code instead; an unknown error still rethrows rather than becoming an
       * "available: false" success, and an auth/tenancy error is never swallowed
       * because only ConvexError is caught at all.
       */
      return {
        appliedLtvPercent: undefined,
        currency,
        ruleVersion: undefined,
        available: false as const,
        reason: economicsVisible
          ? typeof error.data === "string"
            ? error.data
            : "RULES_UNAVAILABLE"
          : ("RULES_UNAVAILABLE" as const),
      };
    }

    /**
     * Ruling #3: the rate and the rule version are accounting economics, so a
     * quotation-workflow caller without `view:finance` gets the SAME KEYS with
     * `undefined` values rather than a narrower object. One return shape means
     * no consumer has to narrow a union to read the amount, and
     * `JSON.stringify` drops the blanks on the wire — the same technique
     * `projectFinanceApplication` uses on the row.
     */
    const base = {
      appliedLtvPercent: economicsVisible
        ? (solved.appliedLtvPercent as number | undefined)
        : undefined,
      currency,
      ruleVersion: economicsVisible
        ? (solved.snapshot.ruleVersion as number | undefined)
        : undefined,
    };

    // No target recorded anywhere is a different state from the solver running
    // and declining, and collapsing the two would tell the user their finance
    // company's rules are the problem when the missing input is theirs.
    if (!solved.result) {
      return { ...base, available: false as const, reason: "NO_TARGET_RECORDED" as const };
    }
    if (!solved.result.available) {
      /**
       * KEPT for every caller. Unlike the thrown messages caught above, this is
       * the solver's own fixed enumeration of rule states and carries no
       * figure — and with all five what-if controls disregarded for a
       * non-finance caller, they cannot STEER which reason appears either, so
       * it is not an oracle. Withholding it would only cost the operator the
       * sentence telling them which company setting to fix.
       */
      return { ...base, available: false as const, reason: solved.result.reason };
    }
    /**
     * The quotation itself travels to the whole quotation-workflow tier (ruling
     * #1); everything the figure was BUILT FROM stays behind `view:finance`
     * (ruling #3). `undefined` rather than omitted, for the reason above.
     *
     * `customerCoversUnfinancedPortion` and `ltvBaseCapApplied` look
     * qualitative and are not: each names how the composition resolved, and the
     * ruling withholds the composition. `projectedNetProceedsMinor` is the
     * solver's own output figure. All four are economics.
     */
    const composition = solved.result.composition;
    return {
      ...base,
      available: true as const,
      submittedQuotationMinor: solved.result.submittedQuotationMinor,
      projectedNetProceedsMinor: economicsVisible
        ? solved.result.projectedNetProceedsMinor
        : undefined,
      customerCoversUnfinancedPortion: economicsVisible
        ? solved.result.customerCoversUnfinancedPortion
        : undefined,
      financeCompanyFundedPortionMinor: economicsVisible
        ? composition.financeCompanyFundedPortionMinor
        : undefined,
      unfinancedPortionMinor: economicsVisible ? composition.unfinancedPortionMinor : undefined,
      dealerContributionMinor: economicsVisible ? composition.dealerContributionMinor : undefined,
      customerFirstPaymentSurplusMinor: economicsVisible
        ? composition.customerFirstPaymentSurplusMinor
        : undefined,
      ltvBaseCapApplied: economicsVisible ? composition.ltvBaseCapApplied : undefined,
    };
  },
});

/** Everything the dealership needs to answer "what happened on this deal". */
export const getEconomics = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
    ]);
    // Inline rather than behind a helper on purpose: scripts/tenantWriteGuard
    // only accepts proof it can see inside the handler, and "the ownership
    // check is somewhere else" is the exact shape that shipped two Criticals.
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );

    const appraisals = await ctx.db
      .query("financeAppraisals")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    const overrides = await ctx.db
      .query("financeApplicationOverrides")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    // The projection's OWN decision about the approved amount, reused rather
    // than restated. Whether this caller may see the figure is a rule that
    // lives in one place; asking the projected row is how the anomaly verdict
    // below inherits it instead of maintaining a second copy that could drift.
    //
    // Cost follows the same allowlist (VIEW_COST_PRICE): SALES and RECEPTION
    // hold VIEW_FINANCE_APPLICATIONS but not that, and the day
    // vehiclePurchaseCostMinor starts being populated must not be the day the
    // vehicle's cost quietly reaches the sales floor.
    const visibleApp = projectFinanceApplication(app, auth.role);
    const approvedAmountVisible = visibleApp.approvedDealerPurchaseAmountMinor !== undefined;

    return {
      application: visibleApp,
      appraisals: appraisals.sort((a, b) => b.appraisedAt - a.appraisedAt),
      /**
       * The history, projected (SCRUM-117).
       *
       * `recordOverride` stringifies every corrected figure into
       * `previousValue`/`newValue` and takes a free-text reason, so the raw
       * rows restated the approved amount and the gap allocation to a caller
       * the projection above had just withheld them from — the third of the
       * three documented recovery routes, and the one the row projection
       * cannot reach.
       */
      overrides: projectFinanceApplicationOverrides(
        overrides.sort((a, b) => b.changedAt - a.changedAt),
        auth.role
      ),
      /**
       * Whether the operator must name the purchase LTV for this deal, as a
       * FACT rather than as three fields to compare.
       *
       * The screen derived it from `companyRuleSnapshot` and
       * `appliedLtvPercent`, both of which are now finance-gated — and a SALES
       * caller who is not told the rate is missing types a quotation the server
       * then refuses. Published as a boolean that names no rate, so the
       * ordinary workflow survives the boundary.
       */
      requiresLtvPercent: requiresLtvPercentFor(app),
      /**
       * Whether the recorded approved amount is unlike every figure on file.
       *
       * Derived HERE, by the same rule and against the same appraisal the
       * mutation uses to refuse an unacknowledged outlier, so a screen can flag
       * an anomalous figure without owning a second opinion about what counts
       * as anomalous. Any screen that needs this asks the server; none of them
       * re-derives it.
       *
       * Withheld with the amount itself: it is a judgement ABOUT a figure this
       * caller may not see, and on its own it would tell them something about a
       * number the row deliberately withholds. Emphasis is meaningless where
       * there is nothing to emphasise.
       */
      approvedAmountIsFarFromEvidence: approvedAmountIsFarFromEvidenceFor(
        app,
        appraisals,
        approvedAmountVisible
      ),
    };
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Records the quotation the dealership actually sent the financing company.
 *
 * `source` says whether it came out of the calculator or a person overrode it,
 * and an override must carry a reason. This is the one number in the model that
 * is a real external document, so storing a computed value with no indication
 * that nobody chose it would misrepresent what was sent.
 */
export const recordSubmittedQuotation = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    submittedQuotationMinor: v.number(),
    /**
     * Three supported modes:
     *  - SYSTEM_CALCULATED: the solver's figure, sent as-is.
     *  - MANUAL_ENTRY: a figure the dealership negotiated. No solver involved.
     *  - CALCULATED_WITH_OVERRIDE: the solver ran and a person departed from
     *    it, which requires a reason.
     */
    source: v.union(
      v.literal("SYSTEM_CALCULATED"),
      v.literal("MANUAL_ENTRY"),
      v.literal("CALCULATED_WITH_OVERRIDE")
    ),
    overrideReason: v.optional(v.string()),
    targetSellingAmountMinor: v.optional(v.number()),
    /** Itemized costs the dealership bears. Never inferred from the quotation. */
    estimatedDealerBorneExpensesMinor: v.optional(v.number()),
    /** Negotiation headroom. Never inferred from the quotation. */
    quotationBufferMinor: v.optional(v.number()),
    customerFirstPaymentMinor: v.optional(v.number()),
    ltvPercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    /**
     * THE AUTHORITY DECISION COMES FIRST, BEFORE ANYTHING IS READ ABOUT THE DEAL.
     *
     * The cross-family review round found this guard sitting after
     * `requireOwnedRow` and the closed / already-approved lifecycle branches, so
     * the refusal an unauthorized caller received varied with the row's state.
     *
     * I could not reproduce the disclosure that was said to create - the
     * already-approved branch is unconditional and fires for the same caller
     * sending no `ltvPercent` at all, so the endpoint's ordinary use already
     * tells them that much - but the ordering is worth fixing on its own terms.
     * Asking the authority question first makes the refusal independent of every
     * row fact rather than of the stored RATE alone, mirrors the sibling
     * `approveDealerPurchaseAmount`, and strictly REDUCES what an unauthorized
     * caller learns.
     *
     * Tenancy is unaffected: `requireOwnedRow` still runs before every
     * authorized read and write below, so a caller who passes this check still
     * cannot reach another tenant's row.
     */
    /**
     * Naming the rate this deal is financed at is an APPROVER's decision.
     *
     * Recording the quotation is a transcription — "this is the figure we sent"
     * — and the SALES template may do it. `ltvPercent` is a different act. It is
     * stored as `appliedLtvPercent` and scales the finance company's funded
     * portion, which fixes the unfinanced portion and therefore the dealership's
     * own contribution: a salesperson able to set it could move the dealer's
     * money by typing a different number into the field beside the amount. The
     * sibling `approveDealerPurchaseAmount` already takes this same rate behind
     * `APPROVE_FINANCE_APPLICATION`; this door did not, so the weaker role
     * reached the same figure by the earlier step.
     *
     * The guard fires only where the argument is LOAD-BEARING — where it
     * establishes or moves the rate the deal already stands on:
     *
     *  - snapshot carries no default and none has been recorded → any rate is
     *    the exceptional per-deal recovery, and needs an approver;
     *  - the deal already has a rate and the caller re-sends the SAME one →
     *    nothing moves, and re-recording a quotation stays ordinary sales work;
     *  - the snapshot's own configured rate, sent explicitly → likewise a
     *    no-op, so the normal configured path is untouched;
     *  - a rate DIFFERENT from either → an override of the company's rules,
     *    which moves exactly the money the recovery case does and gets exactly
     *    the same authority.
     *
     * Checked before the solver runs and before anything is patched, so a
     * refusal never leaves a recorded quotation standing on a rate the recorder
     * was not entitled to set.
     */
    if (args.ltvPercent !== undefined) {
      /**
       * ONE authority question, asked before anything is read, compared,
       * solved, audited or written.
       *
       * What stood here was a three-way test — approver, or finance-visible
       * with an equal rate, or refuse — and the middle branch is what kept this
       * subsystem leaking. It resolved the snapshot and compared the supplied
       * rate against `app.appliedLtvPercent ?? snapshot.defaultLtvPercent`,
       * both FINANCE-classified, so the accept/refuse outcome was itself a
       * search oracle over the stored rate.
       *
       * The replacement asks nothing about the deal. `mayEstablishAppliedLtv`
       * reads the ROLE and nothing else, so the refusal is independent of the
       * stored rate and identical whether the supplied value is equal to it,
       * different from it, or the deal has no rate at all. An equal value does
       * not bypass — that allowance WAS the oracle.
       *
       * OMISSION is untouched: a deal whose rate is already established stays
       * ordinary work for the roles that do that work. `DealCockpit` sends
       * `ltvPercent` only while `requiresLtvPercent` is true, so no screen ever
       * sends the argument this refuses unless the deal genuinely needs a rate
       * established — which is precisely the decision that now needs both
       * permissions.
       */
      if (!mayEstablishAppliedLtv(role)) {
        throw new ConvexError(
          "Setting the LTV this deal is financed at needs both finance visibility and approval authority. Ask a finance-authorized approver to record the rate the financing company confirmed."
        );
      }
    }

    assertMinorAmount(args.submittedQuotationMinor, "Submitted quotation");
    if (args.targetSellingAmountMinor !== undefined) {
      assertMinorAmount(args.targetSellingAmountMinor, "Target selling amount");
    }
    if (args.estimatedDealerBorneExpensesMinor !== undefined) {
      assertMinorAmount(
        args.estimatedDealerBorneExpensesMinor,
        "Estimated dealer-borne expenses"
      );
    }
    if (args.quotationBufferMinor !== undefined) {
      assertMinorAmount(args.quotationBufferMinor, "Quotation buffer");
    }
    if (args.customerFirstPaymentMinor !== undefined) {
      assertMinorAmount(args.customerFirstPaymentMinor, "Customer first payment");
    }
    if (args.submittedQuotationMinor <= 0) {
      throw new ConvexError("The submitted quotation must be greater than zero.");
    }

    const reason = args.overrideReason?.trim();
    if (args.source === "CALCULATED_WITH_OVERRIDE" && !reason) {
      throw new ConvexError(
        "Departing from the calculated quotation must record why."
      );
    }

    // Inline rather than behind a helper on purpose: scripts/tenantWriteGuard
    // only accepts proof it can see inside the handler, and "the ownership
    // check is somewhere else" is the exact shape that shipped two Criticals.
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    if (app.status === "CLOSED" || app.status === "CANCELLED") {
      throw new ConvexError(
        "This application is closed. Its submitted quotation can no longer be changed."
      );
    }
    if (app.approvedDealerPurchaseAmountMinor !== undefined) {
      throw new ConvexError(
        "The finance company has already approved a purchase amount on this application. Reopen the approval before changing the quotation it was based on."
      );
    }

    /**
     * THE INPUT BOUNDARY, on the WRITE side (same ruling).
     *
     * Fixing only the query would have left a write-then-read route, and this
     * is the half I had missed: the patch below does not merely solve from
     * these arguments, it PERSISTS them. `targetSellingAmountMinor` fans out
     * into `targetSellingAmountMinor` AND `targetNetProceedsMinor`;
     * `estimatedDealerBorneExpensesMinor` into two more; the resolved first
     * payment and buffer are written as well. So a caller without VIEW_FINANCE
     * could record a MANUAL_ENTRY carrying chosen inputs — no solver check
     * applies to that mode — and then read the now-poisoned row back through
     * the canonical, "safe", override-free query. The arithmetic that recovers
     * the hidden figure is identical; only the timing changes.
     *
     * Hence REFUSED rather than ignored, and refused HERE: before the LTV
     * guard, before the solver, before the audit rows and before `ctx.db.patch`.
     * Ignoring them silently would be worse than refusing — the operator would
     * believe they had recorded a target that was never stored.
     *
     * Applies to EVERY provenance mode, MANUAL_ENTRY included. The quotation
     * amount, its source and the override reason remain ordinary operator
     * inputs; only the calculation OPERANDS need finance authority.
     *
     * The code is stable and names no protected value. Nothing in the product
     * sends these: `DealCockpit` calls the query argument-less and sends the
     * mutation only `submittedQuotationMinor` / `source` / `overrideReason` /
     * `ltvPercent`.
     */
    const financeVisible = mayReadFinanceEconomics(role);
    if (!financeVisible) {
      const suppliedCalculationInputs = [
        args.targetSellingAmountMinor,
        args.estimatedDealerBorneExpensesMinor,
        args.quotationBufferMinor,
        args.customerFirstPaymentMinor,
      ].some((value) => value !== undefined);
      if (suppliedCalculationInputs) {
        throw new ConvexError("CALCULATION_INPUTS_REQUIRE_FINANCE");
      }
    }


    // The same resolution `suggestQuotationForApplication` runs, so the figure
    // the user was shown is the figure the guard below accepts. Two copies of
    // this would drift the moment either gained an input.
    const {
      snapshot,
      appliedLtvPercent,
      customerFirstPaymentMinor,
      customerFirstPaymentSource,
      targetForSolver,
      expensesForSolver,
      bufferForSolver,
      result: solverResult,
    } = await solveQuotationForApplication(ctx, app, args);

    const now = Date.now();
    // Audit any change to an already-recorded quotation, whatever the source.
    // Gating this on a reason meant a CALCULATED re-submission could rewrite
    // 12,500 to 9,000 with no trace — the exact hole this table exists to
    // close, reopened for the one figure the module calls a real external
    // document.
    //
    // The amount is not the only thing worth a trace. The patch below rewrites
    // the source label, the recorder, the timestamp, the override reason and
    // the whole calculation snapshot unconditionally, and there is no history
    // table for any of them. Keying the audit on the amount alone therefore let
    // a re-record at the SAME figure erase why an override existed: submit
    // 13,000 as CALCULATED_WITH_OVERRIDE with a reason, re-submit 13,000 as
    // MANUAL_ENTRY with none, and the reason is deleted (an explicit undefined
    // in a patch removes the field), the mode flips, the prior calculated
    // figure vanishes with the snapshot — and the override table gets nothing,
    // because the number did not move.
    const quotationPreviouslyRecorded = app.submittedQuotationMinor !== undefined;
    const amountChanged = app.submittedQuotationMinor !== args.submittedQuotationMinor;
    const sourceChanged = app.submittedQuotationSource !== args.source;
    const reasonChanged = (app.submittedQuotationOverrideReason ?? "") !== (reason ?? "");
    // The RECORDER belongs in this set for the same reason the approver belongs
    // in `approveDealerPurchaseAmount`'s: the patch below rewrites it
    // unconditionally, and who sent the finance company its quotation is the
    // provenance of a real external document. Without it, a colleague
    // re-entering the same figure from the same paperwork — or a retry after a
    // dropped response — became the recorder of record, with a new timestamp,
    // and no row anywhere saying so. That sibling mutation learned this two
    // rounds ago; this one had no caller outside tests until SCRUM-68 exposed
    // it, so nobody could reach the case.
    const recorderChanged = quotationPreviouslyRecorded && app.submittedQuotationBy !== user._id;
    /**
     * The CALCULATION INPUTS, which the patch below also rewrites.
     *
     * Comparing only the four headline fields let a re-record move the target,
     * the dealer-borne expenses, the buffer, the customer's first payment or the
     * applied LTV at an identical amount, source, reason and recorder — silently
     * changing every derived figure the economics engine computes from them,
     * with no audit row and no new submission stamp. The resolved values are
     * compared rather than the raw arguments, because an omitted argument means
     * "keep what the deal already has" and is not a change.
     */
    /**
     * The two arguments the patch FANS OUT into more than one stored field.
     *
     * `targetSellingAmountMinor` writes both `targetSellingAmountMinor` and
     * `targetNetProceedsMinor`; `estimatedDealerBorneExpensesMinor` writes both
     * `estimatedDealerBorneExpensesMinor` and `estimatedClosingExpensesMinor`.
     * They normally hold the same value, because the patch always writes them
     * from one argument — but on a row where they have drifted apart, one
     * argument moves one field and not the other.
     *
     * Stated once, as a table, and read by BOTH the gate below and the audit
     * description further down. Three review rounds found three defects in the
     * hand-written version of this rule — a move reported that never happened,
     * a move missed that did, and then a field mutated with no audit row at all
     * because the gate never opened — each in a different clause, each fixed
     * separately, each fix leaving the next one wrong. Two fields, two readers
     * and one hand-maintained rule is what kept producing them; the arithmetic
     * was never the hard part.
     */
    const fannedOutInputs = [
      {
        supplied: args.targetSellingAmountMinor,
        fields: [
          ["target", app.targetSellingAmountMinor],
          ["target net proceeds", app.targetNetProceedsMinor],
        ],
      },
      {
        supplied: args.estimatedDealerBorneExpensesMinor,
        fields: [
          ["expenses", app.estimatedDealerBorneExpensesMinor],
          ["closing expenses", app.estimatedClosingExpensesMinor],
        ],
      },
    ] as const satisfies ReadonlyArray<{
      supplied: number | undefined;
      fields: ReadonlyArray<readonly [string, number | undefined]>;
    }>;

    /**
     * Every stored field a supplied argument would actually move — counted
     * once per DISTINCT starting value.
     *
     * Fields of a pair that held the same value move identically, and naming
     * both is one move described twice: an ordinary expenses change would have
     * read "expenses 300000, closing expenses 300000". Only a field that stood
     * somewhere else is a second, genuinely different move, which is exactly
     * the drifted row this table exists for. So an ordinary re-record produces
     * one entry per argument, as it always has, and a drifted row produces one
     * per figure that was really there.
     */
    const fannedOutMoves = fannedOutInputs.flatMap(({ supplied, fields }) => {
      if (supplied === undefined) return [];
      const distinctStartingValues = new Set<number | undefined>();
      return fields
        .filter(([, before]) => before !== supplied)
        .filter(([, before]) => {
          if (distinctStartingValues.has(before)) return false;
          distinctStartingValues.add(before);
          return true;
        })
        .map(([label, before]) => [label, before, supplied] as const);
    });

    const inputsChanged =
      quotationPreviouslyRecorded &&
      (fannedOutMoves.length > 0 ||
        (args.quotationBufferMinor !== undefined &&
          args.quotationBufferMinor !== app.quotationBufferMinor) ||
        customerFirstPaymentMinor !== app.customerFirstPaymentMinor ||
        appliedLtvPercent !== app.appliedLtvPercent);
    const materiallyChanged =
      amountChanged || sourceChanged || reasonChanged || recorderChanged || inputsChanged;
    if (quotationPreviouslyRecorded && materiallyChanged) {
      /**
       * Every input that MOVED, on both sides — not just the headline four.
       *
       * A row whose two value fields read identically is not a trace. That was
       * the lesson the approver audit next door had to learn, and this writer
       * repeated it one level down: when only a calculation input changed, the
       * described values were byte-identical and the fallback reason claimed a
       * source/reason/recorder change that had not happened — while the patch
       * below overwrote the previous inputs and the whole snapshot, leaving the
       * cause of every moved derived figure unrecoverable.
       */
      const movedInputs: Array<[string, unknown, unknown]> = [];
      const noteMove = (label: string, before: unknown, after: unknown) => {
        if (before !== after) movedInputs.push([label, before, after]);
      };
      // The same table the gate above read, so what opened the gate is exactly
      // what the row describes. Nothing appears for an omitted argument,
      // because then nothing was patched.
      for (const [label, before, after] of fannedOutMoves) {
        noteMove(label, before, after);
      }
      noteMove("buffer", app.quotationBufferMinor, bufferForSolver);
      noteMove("first payment", app.customerFirstPaymentMinor, customerFirstPaymentMinor);
      noteMove("LTV", app.appliedLtvPercent, appliedLtvPercent);

      const describe = (
        amountMinor: number | undefined,
        source: string | undefined,
        why: string | undefined,
        recordedBy: Id<"users"> | undefined,
        side: 0 | 1
      ): string => {
        const inputs = movedInputs
          .map(([label, before, after]) => `${label} ${(side === 0 ? before : after) ?? "unset"}`)
          .join(", ");
        return `${amountMinor ?? "unset"} (${source ?? "unknown source"}${why ? `: ${why}` : ""}${
          recordedBy ? ` by ${recordedBy}` : ""
        }${inputs ? `; ${inputs}` : ""})`;
      };

      // Names what actually moved, so the row does not assert a change that did
      // not happen. Only reached when the caller gave no reason of their own.
      const changedFields = [
        ...(amountChanged ? ["the amount"] : []),
        ...(sourceChanged ? ["the source"] : []),
        ...(reasonChanged ? ["the reason"] : []),
        ...(recorderChanged ? ["the recorder"] : []),
        ...movedInputs.map(([label]) => label),
      ];
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "submittedQuotationMinor",
        previousValue: describe(
          app.submittedQuotationMinor,
          app.submittedQuotationSource,
          app.submittedQuotationOverrideReason,
          app.submittedQuotationBy,
          0
        ),
        newValue: describe(args.submittedQuotationMinor, args.source, reason, user._id, 1),
        reason: reason ?? `Re-recorded; changed: ${changedFields.join(", ")}.`,
        changedBy: user._id,
      });
    }

    // The solver figure is recorded alongside the submitted one so an override
    // is auditable against what it departed from. It is never used to fill in a
    // missing input: when expenses or the buffer have not been entered they are
    // zero, not back-solved from the quotation.
    //
    // Both calculated modes are claims about provenance, and the snapshot
    // records `calculatedQuotationMinor` and `finalQuotationMinor`
    // independently — so unchecked, either label could sit on an amount the
    // solver never produced, or never ran to produce. SYSTEM_CALCULATED is the
    // mode a later reader trusts *because* it says no human touched it;
    // CALCULATED_WITH_OVERRIDE is the one they trust to name a real departure
    // from a real calculation. Guarding only the first left the second as an
    // open door to the same forgery, reached by supplying any reason at all.
    //
    // MANUAL_ENTRY is the honest label whenever no calculation stands behind
    // the figure, and it is always available — nothing here blocks recording a
    // negotiated number.
    if (args.source === "SYSTEM_CALCULATED" || args.source === "CALCULATED_WITH_OVERRIDE") {
      const modeLabel =
        args.source === "SYSTEM_CALCULATED"
          ? "calculated by the system"
          : "calculated with an override";
      if (!solverResult) {
        throw new ConvexError(
          `This quotation is recorded as ${modeLabel}, but no target selling amount is set, so the calculator never ran. Record the target, or submit it as a manual entry.`
        );
      }
      if (!solverResult.available) {
        // The reason is a fixed enumeration of RULE STATES (an unrecorded
        // offset rule, and so on) and carries no figure, so it stays: it tells
        // the operator which setting to fix. Ruling #4 is about computed
        // NUMBERS, and removing this as well cost actionable guidance for no
        // security gain.
        throw new ConvexError(
          `This quotation is recorded as ${modeLabel}, but the calculator could not run (${solverResult.reason}). Submit it as a manual entry instead.`
        );
      }
      const matchesSolver =
        solverResult.submittedQuotationMinor === args.submittedQuotationMinor;
      /**
       * NAMES NO FIGURE. The message used to read "...the calculator produced
       * 10231041 minor units, not 1", which handed the computed value to
       * anyone who could call this mutation — a third route to the same leak,
       * through an error rather than a response, and one that no response-shape
       * gate would ever have caught. The operator already sees the calculated
       * figure on the screen they are submitting from, so nothing is lost.
       */
      if (args.source === "SYSTEM_CALCULATED" && !matchesSolver) {
        throw new ConvexError(
          "This quotation is recorded as calculated by the system, but it does not match the calculated figure. Record it as a calculated quotation with an override and say why it differs, or submit it as a manual entry."
        );
      }
      // An "override" that departs from nothing is not an override. Letting it
      // through would put a departure on the record, complete with a reason
      // explaining a difference that does not exist.
      if (args.source === "CALCULATED_WITH_OVERRIDE" && matchesSolver) {
        // Names no figure either: the caller supplied the amount, so saying it
        // MATCHES the calculation discloses the calculation.
        throw new ConvexError(
          "This quotation is recorded as an override, but it matches the calculated figure exactly. Record it as calculated by the system instead."
        );
      }
    }

    // Same reason as the other writers: `??` preserves an unrecognised code
    // rather than replacing it, so recording a quotation would carry it into
    // every figure derived from this deal afterwards.
    assertSupportedDenomination(app.economicsCurrency, "recording this quotation");
    await ctx.db.patch(args.applicationId, {
      economicsCurrency: await resolveDealCurrency(ctx, app, "recording this quotation"),
      submittedQuotationMinor: args.submittedQuotationMinor,
      submittedQuotationSource: args.source,
      submittedQuotationOverrideReason: reason,
      // A retry is not a new submission. Advancing these on an identical
      // re-record made "when did we send this quotation, and who sent it"
      // answer the retry rather than the send — the same rule
      // `approveDealerPurchaseAmount` keeps for its own approval stamp.
      ...(quotationPreviouslyRecorded && !materiallyChanged
        ? {}
        : { submittedQuotationAt: now, submittedQuotationBy: user._id }),
      appliedLtvPercent,
      customerFirstPaymentMinor,
      // Rewritten only when something moved, for the same reason as the stamp
      // above: on an identical retry the snapshot's own `recordedAt` used to
      // creep forward while the submission stamp stayed frozen, leaving two
      // provenance fields answering the same question differently.
      ...(quotationPreviouslyRecorded && !materiallyChanged
        ? {}
        : {
      quotationCalculationSnapshot: {
        mode: args.source,
        targetNetProceedsMinor: targetForSolver,
        estimatedDealerBorneExpensesMinor: expensesForSolver,
        quotationBufferMinor: bufferForSolver,
        customerFirstPaymentMinor,
        customerFirstPaymentSource,
        appliedLtvPercent,
        customerFirstPaymentOffsetsUnfinancedShare:
          snapshot.customerFirstPaymentOffsetsUnfinancedShare,
        ...(solverResult?.available
          ? { calculatedQuotationMinor: solverResult.submittedQuotationMinor }
          : {}),
        ...(solverResult && !solverResult.available
          ? { solverUnavailableReason: solverResult.reason }
          : {}),
        finalQuotationMinor: args.submittedQuotationMinor,
        ...(reason ? { overrideReason: reason } : {}),
        ruleVersion: snapshot.ruleVersion,
        recordedBy: user._id,
        recordedAt: now,
      },
          }),
      ...(args.targetSellingAmountMinor !== undefined
        ? {
            targetSellingAmountMinor: args.targetSellingAmountMinor,
            targetNetProceedsMinor: args.targetSellingAmountMinor,
          }
        : {}),
      ...(args.estimatedDealerBorneExpensesMinor !== undefined
        ? {
            estimatedDealerBorneExpensesMinor: args.estimatedDealerBorneExpensesMinor,
            estimatedClosingExpensesMinor: args.estimatedDealerBorneExpensesMinor,
          }
        : {}),
      ...(args.quotationBufferMinor !== undefined
        ? { quotationBufferMinor: args.quotationBufferMinor }
        : {}),
      // Sending the quotation is what puts the appraisal in play. Covers
      // NOT_REQUESTED as well as unset: createFromQuote seeds the former, so
      // testing only for undefined left every new application's appraisal
      // dimension stuck at "not requested" after the quotation had gone out.
      // Never downgrades a later state — a completed or finalized appraisal
      // must not be reopened by a quotation edit.
      ...(app.appraisalStatus === undefined || app.appraisalStatus === "NOT_REQUESTED"
        ? { appraisalStatus: "PENDING" as const }
        : {}),
      updatedAt: now,
    });

    // A seeded first payment is a value this write CHOSE, not one anybody
    // entered: record where it came from (SCRUM-373). It seeds only while the
    // application holds no value, so a retry finds it STORED and adds no row.
    if (customerFirstPaymentSource === "QUOTE_SEED") {
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "customerFirstPaymentMinor",
        previousValue: undefined,
        newValue: customerFirstPaymentMinor,
        reason: `Seeded from the originating quote ${app.quoteId}'s down payment when the quotation was recorded.`,
        changedBy: user._id,
      });
    }

    const updated = await ctx.db.get(args.applicationId);
    if (updated) await recomputeAndPatchEconomics(ctx, updated);
    return args.applicationId;
  },
});

/**
 * Records an appraisal against this application.
 *
 * Append-only. A reappraisal supersedes its predecessor rather than
 * overwriting it, so the negotiation history stays readable and a vehicle
 * re-used in a later deal cannot rewrite what an earlier deal was approved on
 * — which is exactly what the shared, mutable `vehicleValuations` row did.
 */
export const recordAppraisal = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    appraisalAmountMinor: v.number(),
    providerType: v.union(
      v.literal("FINANCE_COMPANY"),
      v.literal("INDEPENDENT"),
      v.literal("DEALER_ESTIMATE")
    ),
    providerName: v.optional(v.string()),
    appraisedAt: v.number(),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    reappraisalReason: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // providerType is self-declared, so the permission has to match the
    // strongest claim the caller can make with it. SALES holds
    // EDIT_VEHICLE_VALUATIONS; letting that record a FINANCE_COMPANY appraisal
    // would let a salesperson set the appraisal equal to their own quotation,
    // producing a zero gap and erasing the customer's obligation — the same
    // dealer-controlled-number problem the DEALER_ESTIMATE rules exist to
    // prevent, through a different door.
    const { user } = await requireTenantAuth(
      ctx,
      args.orgId,
      args.providerType === "DEALER_ESTIMATE"
        ? [PERMISSIONS.EDIT_VEHICLE_VALUATIONS]
        : [PERMISSIONS.REVIEW_FINANCE_APPLICATION]
    );
    assertMinorAmount(args.appraisalAmountMinor, "Appraisal amount");
    if (!Number.isFinite(args.appraisedAt)) {
      throw new ConvexError("The appraisal date must be a valid timestamp.");
    }

    // Inline rather than behind a helper on purpose: scripts/tenantWriteGuard
    // only accepts proof it can see inside the handler, and "the ownership
    // check is somewhere else" is the exact shape that shipped two Criticals.
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    if (app.status === "CLOSED" || app.status === "CANCELLED") {
      throw new ConvexError("This application is closed. No further appraisal can be recorded.");
    }

    const existing = await ctx.db
      .query("financeAppraisals")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    // Supersession is scoped to the same kind of evidence. A dealer estimate
    // and a finance company's appraisal are not versions of one another, and
    // treating them as one chain broke the workflow in both directions:
    // recording an estimate after the real appraisal marked that appraisal
    // SUPERSEDED, leaving nothing for the approval to select and no route
    // forward except MANUAL — which bypasses every rule guard; and recording
    // the estimate first (the natural order — you estimate before you quote)
    // made the real appraisal look like a reappraisal and demanded a reason
    // for the first appraisal on the deal.
    const isDealerEstimate = args.providerType === "DEALER_ESTIMATE";
    const sameClass = existing.filter(
      (appraisal) => (appraisal.providerType === "DEALER_ESTIMATE") === isDealerEstimate
    );
    const live = sameClass.filter(
      (appraisal) => appraisal.status === "RECORDED" || appraisal.status === "APPROVED"
    );
    const isReappraisal = live.length > 0;
    if (isReappraisal && !args.reappraisalReason?.trim()) {
      throw new ConvexError("A reappraisal must record why it was requested.");
    }

    // A real appraisal arriving after the company has already approved a
    // purchase amount invalidates that approval — it was based on evidence
    // that has just been replaced. Leaving both in place produced an
    // application claiming an APPRAISAL basis whose amount matched no live
    // appraisal, with a stale gap and nothing to indicate it. Clear the
    // approval and reopen the deal instead, on the record.
    const supersedesApproval =
      !isDealerEstimate && app.approvedDealerPurchaseAmountMinor !== undefined;
    if (supersedesApproval && app.vehicleHandoverAt) {
      // The vehicle is already with the customer. Silently voiding the
      // approval here would leave a handed-over deal with no approved purchase
      // amount and no signal, and finalizeDeal only checks status === APPROVED
      // so the sale could still be completed on economics nothing supports.
      throw new ConvexError(
        "The vehicle has already been handed over on this deal. Cancel the application to reverse it before recording a new appraisal."
      );
    }
    if (supersedesApproval) {
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "approvedDealerPurchaseAmountMinor",
        previousValue: app.approvedDealerPurchaseAmountMinor,
        newValue: "cleared",
        reason:
          args.reappraisalReason?.trim() ??
          "A new appraisal replaced the evidence the approval was based on.",
        changedBy: user._id,
      });
    }

    const now = Date.now();
    assertSupportedDenomination(app.economicsCurrency, "recording these economics");
    const currency = await resolveDealCurrency(ctx, app, "recording these economics");
    const appraisalId = await ctx.db.insert("financeAppraisals", {
      orgId: args.orgId,
      applicationId: args.applicationId,
      vehicleId: app.vehicleId,
      ...(app.companyId ? { companyId: app.companyId } : {}),
      appraisalAmountMinor: args.appraisalAmountMinor,
      currency,
      providerType: args.providerType,
      providerName: args.providerName?.trim(),
      appraisedAt: args.appraisedAt,
      documentStorageIds: args.documentStorageIds,
      isReappraisal,
      reappraisalReason: args.reappraisalReason?.trim(),
      status: "RECORDED",
      notes: args.notes?.trim(),
      recordedBy: user._id,
      recordedAt: now,
    });

    for (const superseded of live) {
      await ctx.db.patch(superseded._id, {
        status: "SUPERSEDED",
        supersededAt: now,
        supersededByAppraisalId: appraisalId,
      });
    }

    // A dealer estimate is not an appraisal and must not move the appraisal
    // dimension — treating it as one is how a dealer-controlled number ends up
    // driving a gap calculation.
    if (isDealerEstimate) {
      await ctx.db.patch(args.applicationId, {
        dealerEstimateMinor: args.appraisalAmountMinor,
        economicsCurrency: currency,
        updatedAt: now,
      });
      return appraisalId;
    }

    await ctx.db.patch(args.applicationId, {
      appraisalStatus: "COMPLETED",
      economicsCurrency: currency,
      updatedAt: now,
      ...(supersedesApproval
        ? {
            // The approval is being withdrawn, so a confirmation taken against
            // it must stop matching. See `economicsRevision` in the schema.
            economicsRevision: (app.economicsRevision ?? 0) + 1,
            approvedDealerPurchaseAmountMinor: undefined,
            approvedPurchaseBasis: undefined,
            approvedPurchaseAppraisalId: undefined,
            approvedPurchaseExceptionRuleVersion: undefined,
            approvedPurchaseApprovedBy: undefined,
            approvedPurchaseApprovedAt: undefined,
            approvedPurchaseNotes: undefined,
            // Everything derived from the approval goes with it, rather than
            // lingering as figures nothing now supports.
            financeCompanyFundedPortionMinor: undefined,
            unfinancedPortionMinor: undefined,
            dealerContributionMinor: undefined,
            expectedDealerRemittanceMinor: undefined,
            rawAppraisalGapMinor: undefined,
            gapResolution: undefined,
            customerGapShareMinor: undefined,
            dealerGapShareMinor: undefined,
            customerGapCashToDealerMinor: undefined,
            customerGapInstallmentToDealerMinor: undefined,
            customerGapToFinanceCompanyMinor: undefined,
            gapResolvedAt: undefined,
            gapResolvedBy: undefined,
            // The note says things like "customer agreed to absorb the full
            // 1,000" — it cannot outlive the 1,000.
            gapResolutionNotes: undefined,
            // Out of READY: nothing may be handed over against an approval that
            // no longer exists. finalizeDeal's own guard (below) is the other
            // half of this.
            handoverStatus: "BLOCKED" as const,
          }
        : {}),
    });

    return appraisalId;
  },
});

/**
 * Records the amount the financing company will actually buy the vehicle at.
 *
 * Stored explicitly with its basis rather than inferred: equal to the appraisal
 * in the ordinary case, equal to the submitted quotation when the company's own
 * tolerance rule allows it despite a lower appraisal, or some third negotiated
 * figure. A formula cannot tell these apart because the difference is a fact
 * about what the company decided, not about the numbers.
 *
 * Eligibility for the exception is checked against the rule version snapshotted
 * on the application, so a company that tightens its tolerance next month
 * cannot retroactively invalidate a deal it already approved.
 */
export const approveDealerPurchaseAmount = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    approvedAmountMinor: v.number(),
    basis: v.union(
      v.literal("APPRAISAL"),
      v.literal("QUOTATION_EXCEPTION"),
      v.literal("MANUAL")
    ),
    appraisalId: v.optional(v.id("financeAppraisals")),
    appliedLtvPercent: v.optional(v.number()),
    notes: v.optional(v.string()),
    /**
     * The operator was shown how far this amount sits from the deal's own
     * figures, and stood by it.
     *
     * Required only for an amount unlike EVERY figure on file. The dialog sets
     * it when the person answers the question; without it the mutation refuses
     * and names the figures, so the challenge cannot be skipped by a stale tab
     * or any caller that is not this dialog. That is the whole point — a check
     * that exists only in a React component is not a check on the data.
     *
     * It gates, it does not cap: an acknowledged outlier is recorded exactly as
     * typed. AutoFlow is not entitled to decide the finance company's number is
     * impossible, only to make sure a person meant to type it.
     */
    outlierAcknowledged: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.APPROVE_FINANCE_APPLICATION,
    ]);
    /**
     * THE SECOND LTV DOOR (SCRUM-117, owner-proxy ruling 2026-09-13 15:33).
     *
     * Round 3 closed `recordSubmittedQuotation` and this endpoint kept the same
     * authority open: it is gated on `APPROVE_FINANCE_APPLICATION` alone, the
     * default MANAGER template holds that without `view:finance`, and it writes
     * `appliedLtvPercent` straight through. So the reproduced attack survived
     * its own fix by moving one endpoint sideways — write 100 here, then make
     * the ordinary argument-less suggestion call and read the protected target
     * out of the answer.
     *
     * That is why the predicate is SHARED rather than restated. Two endpoints
     * each carrying their own copy of one authority rule is exactly what let
     * this one lag a round behind.
     *
     * Placed immediately after the auth call, so it precedes the ownership
     * lookup's protected reads, `resolveRuleSnapshot`, `resolveAppliedLtv`,
     * every solve, the override audit rows and the patch. A refusal therefore
     * reads nothing about the deal and moves nothing on it, and is identical
     * whether the supplied rate equals the stored one or not.
     *
     * OMISSION is untouched, and that is the whole operational workflow: the
     * resolution below is `args.appliedLtvPercent ?? app.appliedLtvPercent`, so
     * a default MANAGER still approves a purchase amount on a deal whose rate
     * is already established. What they can no longer do is establish or change
     * it.
     */
    if (args.appliedLtvPercent !== undefined && !mayEstablishAppliedLtv(role)) {
      throw new ConvexError(
        "Setting the LTV this deal is financed at needs both finance visibility and approval authority. Ask a finance-authorized approver to record the rate the financing company confirmed."
      );
    }
    assertMinorAmount(args.approvedAmountMinor, "Approved purchase amount");
    if (args.approvedAmountMinor <= 0) {
      throw new ConvexError("The approved purchase amount must be greater than zero.");
    }

    // Inline rather than behind a helper on purpose: scripts/tenantWriteGuard
    // only accepts proof it can see inside the handler, and "the ownership
    // check is somewhere else" is the exact shape that shipped two Criticals.
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    if (app.status === "CLOSED" || app.status === "CANCELLED") {
      throw new ConvexError("This application is closed. Its approval can no longer be changed.");
    }
    /**
     * At the TOP of the handler, so every approval route runs it.
     *
     * It previously sat three conditions deep inside consigned
     * direct-settlement handling, so dealer-owned stock, through-dealership
     * routes and zero-cost rows all skipped it. That is not a theoretical gap:
     * a legacy deal with a quotation already on file could record an approval
     * that `finalizeDeal` then refuses forever, while the handover lock blocks
     * correcting it — a deal stranded short of a sale with no in-app way back.
     */
    assertSupportedDenomination(app.economicsCurrency, "recording this approval");
    /**
     * The THIRD writer of this number, and the one that had no door on it.
     *
     * `reopenApproval` refuses after handover, and `recordAppraisal`'s
     * superseding branch refuses too — so the product's rule is already that
     * the vehicle going out seals the approved amount. This mutation is the
     * other way to change it, and re-approving is a supported path rather than
     * an exotic one: the override recorded below exists precisely because a
     * second call with a different figure is expected.
     *
     * Without this guard the handover confirmation SCRUM-78 put in front of the
     * operator — "after the vehicle is handed over the recorded approved amount
     * can no longer be corrected through the normal correction flow" — was
     * simply untrue, and a screen that tells someone a figure is now permanent
     * while a sibling writer rewrites it is worse than one that says nothing.
     *
     * Scoped to a CORRECTION, not to every write — and the test suite is what
     * insisted on the distinction. A first guard on `vehicleHandoverAt` alone
     * failed 63 existing cases, all of them recording economics on a deal that
     * was handed over with none: `assertDealerEconomicsRecorded` lets a deal
     * with no quotation through, so that order is genuinely reachable, and
     * SCRUM-61 exists precisely to let such a deal record the approval it never
     * had. Blocking that would have created the dead end one step earlier than
     * the one that issue is about.
     *
     * The claim the dialog makes is about a figure the operator READ, and it
     * only shows one when there is one. Where no amount was ever recorded there
     * is nothing to correct and nothing was verified, so the door does not
     * apply.
     */
    if (app.vehicleHandoverAt && app.approvedDealerPurchaseAmountMinor !== undefined) {
      throw new ConvexError(
        "The vehicle has already been handed over on this deal, so the approved purchase amount can no longer be changed. Cancel the application to reverse it instead."
      );
    }
    if (app.submittedQuotationMinor === undefined) {
      throw new ConvexError(
        "Record the quotation sent to the finance company before recording what it approved."
      );
    }
    // Same separation of duties updateStatus already enforces for the credit
    // decision. This mutation sets the number the dealer contribution derives
    // from, and the MANUAL basis accepts any amount with only a note, so it is
    // if anything the more consequential of the two to leave self-serve.
    if (user._id === app.salespersonId) {
      throw new ConvexError("You cannot approve the purchase amount on your own application.");
    }

    // An approval below the supplier's entitlement, on a deal where the company
    // pays HIM. Refused at the point the number is entered.
    //
    // Only where the route is already recorded as direct. Before it is chosen
    // there is no fact to check against — on the through route the dealership
    // collects the gross and the customer remains liable for the whole sale
    // price, so an approval under the entitlement is an ordinary partly-funded
    // deal rather than a shortfall to anyone. `setSupplierSettlementRoute`
    // applies the mirror of this check when the route is chosen after the
    // approval, and `completeSale` refuses at the commit point regardless, so
    // neither ordering can slip through. This one exists so the operator learns
    // it here rather than at the finalize button.
    if (!dealershipCollectsGross(consignedSettlementRoute(app))) {
      const vehicle = await ctx.db.get(app.vehicleId);
      if (vehicle && vehicle.orgId === args.orgId && isConsignedAgentSale(vehicle)) {
        const costAmount = await computeVehicleCapitalizedCost(ctx, vehicle);
        // A vehicle with no recorded cost is not evidence that nothing is owed;
        // `completeSale` refuses that sale outright. Nothing is asserted here.
        if (costAmount > 0) {
          const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
          const refusal = directSettlementBelowEntitlementRefusal({
            approvedAmountMinor: args.approvedAmountMinor,
            supplierEntitlementMinor: toMinorUnits(costAmount, currency),
            supplierName: vehicle.sourcedFromName,
          });
          if (refusal) throw new ConvexError(refusal);
        }
      }
    }

    const snapshot = await resolveRuleSnapshot(ctx, app);
    const appliedLtvPercent = resolveAppliedLtv(
      snapshot,
      args.appliedLtvPercent ?? app.appliedLtvPercent
    );

    const appraisals = await ctx.db
      .query("financeAppraisals")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    let appraisal: Doc<"financeAppraisals"> | undefined;
    if (args.appraisalId) {
      appraisal = appraisals.find((row) => row._id === args.appraisalId);
      if (!appraisal) {
        throw new ConvexError("That appraisal does not belong to this application.");
      }
      // Naming an appraisal explicitly must not be a way to reach one the
      // reappraisal flow already invalidated. Without this the explicit path
      // was weaker than the automatic one below: a caller could pick a
      // superseded appraisal that happens to sit inside the exception
      // tolerance when the current one does not, and approve on evidence the
      // finance company has replaced.
      if (appraisal.status === "SUPERSEDED" || appraisal.status === "REJECTED") {
        throw new ConvexError(
          `That appraisal has been ${appraisal.status.toLowerCase()} and cannot be the basis for an approval. Use the current appraisal.`
        );
      }
    } else if (args.basis !== "MANUAL" || ltvRuleNeedsAppraisal(snapshot.ltvBasis)) {
      // Auto-resolution is for the bases that ARE based on an appraisal — plus
      // the one case where the appraisal is not the approval's evidence but the
      // company's LTV BASE.
      //
      // Those are two different roles for one row, and conflating them cost a
      // defect in each direction. Adopting it under MANUAL unconditionally wrote
      // a self-contradictory record: basis MANUAL, beside a link to evidence the
      // amount was explicitly not based on, with that evidence flipped to
      // APPROVED below. Dropping it unconditionally then broke the other role:
      // for a company whose rule multiplies the APPRAISAL, `deriveEconomics` has
      // no base without it, so the funding split was blanked, the deal was
      // flagged for reconciliation — and SCRUM-61's handover guard refuses a
      // deal whose split could not be computed. A legitimate manually approved
      // figure became unfinishable.
      //
      // So: adopt it where the RULE needs it, never let MANUAL stamp it as
      // approved (see the status patch below), and keep the basis saying exactly
      // what the operator said. A caller that really does mean to link one under
      // any basis still can, by naming it: the branch above honours that.
      //
      // APPROVED as well as RECORDED: the first approval flips the chosen
      // appraisal to APPROVED, so matching only RECORDED made every
      // re-approval fail to find one — leaving the explicit appraisalId
      // argument as the sole route through, which is the weaker path.
      appraisal = selectActiveAppraisal(appraisals);
    }

    if (args.basis !== "MANUAL" && !appraisal) {
      throw new ConvexError(
        "Record the finance company's appraisal before approving a purchase amount based on it."
      );
    }
    if (appraisal?.providerType === "DEALER_ESTIMATE") {
      throw new ConvexError(
        "A dealer estimate cannot be the basis for an approved purchase amount. Record the finance company's own appraisal."
      );
    }

    assertApprovalBasisValid({
      basis: args.basis,
      approvedAmountMinor: args.approvedAmountMinor,
      submittedQuotationMinor: app.submittedQuotationMinor,
      appraisal,
      snapshot,
      notes: args.notes,
    });

    // The only numeric check between a keystroke and this deal's economics.
    //
    // Nothing else looks at whether the figure is plausible: the MANUAL basis
    // asks only for a non-empty note, and `computeAppraisalGap` measures a
    // SHORTFALL, so an approval that overshoots reports zero. That is how
    // 150,000 landed on a deal quoted at 17,000 and appraised at 16,000, and
    // how a 150,000 expected dealer remittance followed from it.
    //
    // A refusal the caller can answer, not a rule about what a finance company
    // may decide — the acknowledgement is the answer, and an acknowledged
    // amount is stored exactly as given.
    //
    // Compared against the deal's OWN current appraisal, not `appraisal` above.
    // That one is the approval's BASIS, and under MANUAL it is deliberately not
    // adopted unless the company's LTV rule needs it — so reusing it would have
    // left the server comparing against the quotation alone on exactly the
    // deals the dialog compares against both. The screen would then ask a
    // question the server did not, or stay silent where the server refused.
    const comparisonAppraisal = resolveComparisonAppraisal(appraisals);
    if (
      !args.outlierAcknowledged &&
      isApprovalFarFromEvidence({
        approvedAmountMinor: args.approvedAmountMinor,
        submittedQuotationMinor: app.submittedQuotationMinor,
        appraisalAmountMinor: comparisonAppraisal?.appraisalAmountMinor,
      })
    ) {
      // Names the figures it was compared against. "Confirm this amount" with
      // no numbers is a challenge the operator cannot check.
      const compared = [
        app.submittedQuotationMinor === undefined
          ? undefined
          : `quotation ${app.submittedQuotationMinor}`,
        comparisonAppraisal === undefined
          ? undefined
          : `appraisal ${comparisonAppraisal.appraisalAmountMinor}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" and ");
      throw new ConvexError(
        `${args.approvedAmountMinor} is far from this deal's ${compared}. Confirm it is the amount the finance company communicated.`
      );
    }

    const now = Date.now();
    const previousRawGapMinor = app.rawAppraisalGapMinor ?? 0;
    // Any material change, not only the amount. Narrowing this to the amount
    // meant re-approving 11,500 on the MANUAL basis instead of APPRAISAL
    // silently replaced the basis, the approver, the timestamp and the notes —
    // and wrote nothing to the table whose whole purpose is that a number
    // changing without a status changing leaves a trace.
    // The LTV belongs in this set as much as the amount does. It is patched
    // unconditionally below and recomputeAndPatchEconomics derives the funded
    // portion, the dealer contribution and the expected remittance from it — so
    // a re-approval passing a different LTV with an identical amount, basis,
    // appraisal and notes moved every funding figure on the deal and left the
    // override table, whose entire purpose is that a number cannot change
    // without a trace, completely empty.
    // The approver is in this set for the same reason the LTV is: it is patched
    // unconditionally below. Without it, a second person re-submitting a
    // byte-identical approval — a double-click, a retry after a dropped
    // connection, a colleague confirming — silently became the approver of
    // record, with a new timestamp, and no row anywhere saying so. That is the
    // separation-of-duties evidence for a money decision being rewritten by an
    // action that changed nothing else.
    const approvalMateriallyChanged =
      app.approvedDealerPurchaseAmountMinor !== undefined &&
      (app.approvedDealerPurchaseAmountMinor !== args.approvedAmountMinor ||
        app.approvedPurchaseBasis !== args.basis ||
        app.approvedPurchaseAppraisalId !== appraisal?._id ||
        app.appliedLtvPercent !== appliedLtvPercent ||
        app.approvedPurchaseApprovedBy !== user._id ||
        (app.approvedPurchaseNotes ?? "") !== (args.notes?.trim() ?? ""));
    if (approvalMateriallyChanged) {
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "approvedDealerPurchaseAmountMinor",
        // EVERY input in the change condition above, on both sides — not just
        // the money ones. Recording the approver in the condition but not in
        // the payload wrote a row whose two value fields were the identical
        // string, so a second approver replacing the first left a trace that
        // said a change happened and not what it was. The prior approver was
        // still unrecoverable: this table is the only history, and
        // applicationStatusLog records status transitions only.
        previousValue:
          app.approvedDealerPurchaseAmountMinor === undefined
            ? undefined
            : `${app.approvedDealerPurchaseAmountMinor} (${app.approvedPurchaseBasis ?? "unknown basis"} @ ${app.appliedLtvPercent ?? "unknown"}% LTV, approved by ${app.approvedPurchaseApprovedBy ?? "unrecorded"})`,
        newValue: `${args.approvedAmountMinor} (${args.basis} @ ${appliedLtvPercent}% LTV, approved by ${user._id})`,
        reason: args.notes?.trim() ?? `Re-approved on the ${args.basis} basis.`,
        changedBy: user._id,
      });
    }

    // APPROVED on the appraisal row means the company approved AGAINST it. A
    // MANUAL approval is the one basis that says it did not, even where the
    // appraisal is still in play as the company's LTV base — so the row keeps
    // whatever status it had.
    if (appraisal && appraisal.status === "RECORDED" && args.basis !== "MANUAL") {
      await ctx.db.patch(appraisal._id, { status: "APPROVED" });
    }

    // Every basis-specific field is written unconditionally — set to the new
    // value or cleared. Spreading them in only when they apply left the
    // previous approval's traces behind: re-approving on the APPRAISAL basis
    // after an exception kept `approvedPurchaseExceptionRuleVersion` pointing
    // at a rule version that no longer had anything to do with the approval.
    await ctx.db.patch(args.applicationId, {
      // Any confirmation an operator was holding is now against figures that
      // have moved. See `economicsRevision` in the schema.
      economicsRevision: (app.economicsRevision ?? 0) + 1,
      approvedDealerPurchaseAmountMinor: args.approvedAmountMinor,
      approvedPurchaseBasis: args.basis,
      approvedPurchaseAppraisalId: appraisal?._id,
      approvedPurchaseExceptionRuleVersion:
        args.basis === "QUOTATION_EXCEPTION" ? snapshot.ruleVersion : undefined,
      // Only re-stamp when something actually moved. A byte-identical
      // re-submission by the same person is a retry, not a new decision, and
      // advancing the timestamp made "when was this approved" answer the retry
      // rather than the approval. A DIFFERENT approver counts as a material
      // change above, so that case still re-stamps — and now leaves a row.
      ...(approvalMateriallyChanged || app.approvedPurchaseApprovedAt === undefined
        ? { approvedPurchaseApprovedBy: user._id, approvedPurchaseApprovedAt: now }
        : {}),
      approvedPurchaseNotes: args.notes?.trim(),
      appliedLtvPercent,
      // Only claim a finalized appraisal when one exists AND the company
      // approved against it. A MANUAL approval needs no appraisal, and writing
      // FINALIZED there asserted a fact that never happened — in a dimension
      // PR 2 and PR 3 gate handover on.
      //
      // The basis condition is not redundant with `appraisal` being present.
      // Under MANUAL an appraisal can now be adopted as the company's LTV BASE,
      // which is a different fact from the company having approved against it —
      // and without this the row would say RECORDED while the application said
      // FINALIZED about the same event. Three facts, three conditions: the LTV
      // base is resolved above, the row's own status flips only for an
      // appraisal-based approval, and this dimension follows the same rule.
      ...(appraisal && args.basis !== "MANUAL"
        ? { appraisalStatus: "FINALIZED" as const }
        : {}),
      updatedAt: now,
    });

    const updated = await ctx.db.get(args.applicationId);
    if (updated) await recomputeAndPatchEconomics(ctx, updated);

    const refreshed = await ctx.db.get(args.applicationId);
    if (!refreshed) return args.applicationId;

    // `?? 0` would be wrong here. recomputeAndPatchEconomics CLEARS the gap when
    // the company's LTV basis names an amount nobody recorded — reachable via a
    // manual approval with no appraisal under an appraisal-based basis — and
    // reading that absence as zero wrote gapResolution: NOT_REQUIRED, declaring
    // a deal gap-free on the strength of economics that could not be computed
    // at all. Unknown is not zero.
    // Approving restores handover readiness. recordAppraisal and reopenApproval
    // both drop the deal to BLOCKED when they clear an approval, and nothing
    // put it back — updateStatus cannot run again because APPROVED is terminal
    // there — so a reappraised deal stayed permanently un-handoverable in the
    // dimension PR 3 gates handover on.
    if (refreshed.handoverStatus === "BLOCKED" && refreshed.status === "APPROVED") {
      await ctx.db.patch(args.applicationId, { handoverStatus: "READY" });
    }

    const economicsIncomplete = refreshed.rawAppraisalGapMinor === undefined;
    if (economicsIncomplete) {
      // Leave the gap dimension unset: it is genuinely undetermined until the
      // missing operand is recorded, and the reconciliation flag already set by
      // the recompute is what carries the problem to a human.
      await ctx.db.patch(args.applicationId, { gapResolution: undefined });
      return args.applicationId;
    }

    const rawGapMinor = refreshed.rawAppraisalGapMinor ?? 0;
    const gapChanged = rawGapMinor !== previousRawGapMinor;

    if (rawGapMinor <= 0) {
      // Nothing left to negotiate. Any shares agreed against the old gap are
      // void — leaving them would let a resolution reconciled against a
      // different number stay attached to this deal.
      await ctx.db.patch(args.applicationId, {
        gapResolution: "NOT_REQUIRED",
        ...(gapChanged
          ? {
              customerGapShareMinor: undefined,
              dealerGapShareMinor: undefined,
              customerGapCashToDealerMinor: undefined,
              customerGapInstallmentToDealerMinor: undefined,
              customerGapToFinanceCompanyMinor: undefined,
              gapResolvedAt: undefined,
              gapResolvedBy: undefined,
              gapResolutionNotes: undefined,
            }
          : {}),
      });
    } else if (
      gapChanged ||
      refreshed.gapResolution === undefined ||
      // FAILED is written when a deal is rejected or cancelled with a gap open.
      // REJECTED -> PENDING_DOCS is a legal transition, so a reopened deal
      // carried "negotiation failed" against a live shortfall and this branch
      // never reopened it, because FAILED is neither undefined nor a change.
      refreshed.gapResolution === "FAILED"
    ) {
      // The gap moved, so whatever the parties agreed was agreed about a
      // different amount. Reopen the negotiation rather than carrying a stale
      // NOT_REQUIRED (or a stale split) against a live shortfall.
      await ctx.db.patch(args.applicationId, {
        gapResolution: "PENDING_NEGOTIATION",
        ...(gapChanged
          ? {
              customerGapShareMinor: undefined,
              dealerGapShareMinor: undefined,
              customerGapCashToDealerMinor: undefined,
              customerGapInstallmentToDealerMinor: undefined,
              customerGapToFinanceCompanyMinor: undefined,
              gapResolvedAt: undefined,
              gapResolvedBy: undefined,
              gapResolutionNotes: undefined,
            }
          : {}),
      });
    }

    return args.applicationId;
  },
});

/**
 * Withdraws an approved purchase amount so the deal can be re-quoted.
 *
 * `recordSubmittedQuotation` refuses to change a quotation the company has
 * already approved against, and told the user to "reopen the approval" — an
 * action that did not exist. The only way to clear an approval was to record a
 * fresh appraisal, so a dealership wanting to withdraw and resubmit at a
 * different figure — an ordinary commercial move — had to manufacture
 * appraisal evidence to do it. That is exactly the dealer-controlled-number
 * problem the rest of this module is built to prevent.
 *
 * Clears the same field set a superseding appraisal does, on the record.
 */
export const reopenApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.APPROVE_FINANCE_APPLICATION,
    ]);
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Reopening an approval must record why.");
    }

    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    if (app.status === "CLOSED" || app.status === "CANCELLED") {
      throw new ConvexError("This application is closed. Its approval can no longer be reopened.");
    }
    if (app.approvedDealerPurchaseAmountMinor === undefined) {
      throw new ConvexError("This application has no approved purchase amount to reopen.");
    }
    if (app.vehicleHandoverAt) {
      throw new ConvexError(
        "The vehicle has already been handed over on this deal. Cancel the application to reverse it instead."
      );
    }
    // The SAME separation of duties `approveDealerPurchaseAmount` applies, and
    // for a stronger reason: clearing the approved amount IS controlling it.
    // Without this, a salesperson who also holds the approval permission — an
    // owner or manager who personally sells, which this card is built for —
    // could wipe their own deal's economics and then be refused by the writer
    // that puts the figure back, stranding it for anyone but a second approver.
    // Enforced here rather than only in the card, because a guard that lives in
    // the UI is not enforcement: this mutation is reachable directly.
    if (user._id === app.salespersonId) {
      throw new ConvexError(
        "You cannot reopen the approved amount on your own application. A manager or the dealership owner reopens it."
      );
    }

    await recordOverride(ctx, {
      orgId: args.orgId,
      applicationId: args.applicationId,
      field: "approvedDealerPurchaseAmountMinor",
      previousValue: app.approvedDealerPurchaseAmountMinor,
      newValue: "reopened",
      reason,
      changedBy: user._id,
    });

    await ctx.db.patch(args.applicationId, {
      // See `economicsRevision` in the schema.
      economicsRevision: (app.economicsRevision ?? 0) + 1,
      approvedDealerPurchaseAmountMinor: undefined,
      approvedPurchaseBasis: undefined,
      approvedPurchaseAppraisalId: undefined,
      approvedPurchaseExceptionRuleVersion: undefined,
      approvedPurchaseApprovedBy: undefined,
      approvedPurchaseApprovedAt: undefined,
      approvedPurchaseNotes: undefined,
      financeCompanyFundedPortionMinor: undefined,
      unfinancedPortionMinor: undefined,
      dealerContributionMinor: undefined,
      expectedDealerRemittanceMinor: undefined,
      rawAppraisalGapMinor: undefined,
      gapResolution: undefined,
      customerGapShareMinor: undefined,
      dealerGapShareMinor: undefined,
      customerGapCashToDealerMinor: undefined,
      customerGapInstallmentToDealerMinor: undefined,
      customerGapToFinanceCompanyMinor: undefined,
      gapResolvedAt: undefined,
      gapResolvedBy: undefined,
      gapResolutionNotes: undefined,
      // Only when there was one. A MANUAL approval needs no appraisal, and
      // upgrading PENDING to COMPLETED here asserted a completed appraisal on a
      // deal with no appraisal rows at all — the same false claim removed from
      // approveDealerPurchaseAmount last round, through a different door.
      ...(app.approvedPurchaseAppraisalId ? { appraisalStatus: "COMPLETED" as const } : {}),
      handoverStatus: "BLOCKED",
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});

/**
 * The deals whose financing figures somebody still has to look at.
 *
 * The flag was write-only: three code paths set it and nothing listed or
 * cleared it, and the documented procedure was to grep a raw table dump. Since
 * `finalizeDeal` flags essentially every financed deal until PR 2 reconciles
 * the receivable, a queue with no exit would have been permanent noise.
 *
 * Paginated because that same breadth is what makes `.collect()` wrong here:
 * the backfill flags legacy deals per organization, so for an established
 * dealership this is closer to "every financed deal ever" than to a short list,
 * and a single unbounded read would exceed the query's limit and make the queue
 * unreadable exactly where it matters most. The projection is deliberate too —
 * the queue renders an identity and the figures a triager decides on, and
 * returning whole application documents would ship underwriting snapshots and
 * document payloads to a screen that shows none of it.
 */
/**
 * Records how the parties agreed to settle the appraisal gap (SCRUM-83).
 *
 * Until this existed, a finance company approving below the quotation — the
 * ordinary case, and the whole reason a gap exists — left the deal at
 * `PENDING_NEGOTIATION` with nothing in the codebase able to move it. The stage
 * rail named a step no writer could take, and every stage behind it was hidden.
 *
 * WHAT THIS IS NOT ALLOWED TO GET WRONG, in order of what it costs:
 *
 * 1. The destinations are recorded, never inferred. `deriveManagementProfit`
 *    (read by `dealCockpit`) folds `customerGapCashToDealerMinor +
 *    customerGapInstallmentToDealerMinor` into the owner's profit, and
 *    `recomputeAndPatchEconomics` feeds the same sum to the remittance analysis
 *    as money the customer paid the dealership directly; both deliberately
 *    exclude `customerGapToFinanceCompanyMinor` — money the customer pays the financier
 *    is not dealership money and must never become a dealer receivable or
 *    profit. A writer that recorded the share and omitted the split would
 *    understate the profit by the entire gap and nothing downstream would
 *    notice. That is why every destination is a required argument: absence is
 *    not zero here.
 * 2. It is atomic. Either the resolution, both shares, all three destinations
 *    and the audit stamp land together, or nothing does. A half-resolved row is
 *    a deal whose agreed split does not reconcile to its own gap.
 * 3. It reconciles against the gap on the deal NOW. The operator's dialog was
 *    rendered against a figure a re-approval can move underneath them, and an
 *    allocation that adds up to yesterday's shortfall is not a smaller error
 *    than one that adds up to nothing.
 *
 * The arithmetic is `validateGapShares` (through `assertGapResolutionValid`) and
 * the classification is `classifyGapResolution`, both from the shared engine,
 * not restated here. The resolution is DERIVED from the shares rather than
 * accepted from the caller, so a client cannot label a split "customer absorbs"
 * and leave the record disagreeing with its own numbers.
 *
 * The dealership absorbing the whole shortfall IS an allowed outcome here
 * (owner-proxy 2026-09-12: "customer share / dealer share", with "dealer
 * absorbs all" a required case). An earlier revision of this command refused
 * DEALER_ABSORBS at the server; that refusal is superseded, not forgotten — the
 * outcome is recorded with the same audit row as every other split.
 */
export const resolveAppraisalGap = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /**
     * The economics the operator's screen was showing — `get` / `dealCockpit`
     * serve it as `economicsStamp`. Demanded of every caller with no permission
     * predicate: a caller whose amounts are redacted still has to prove the
     * deal did not move under them.
     */
    economicsStamp: v.string(),
    customerGapShareMinor: v.number(),
    dealerGapShareMinor: v.number(),
    customerGapCashToDealerMinor: v.number(),
    customerGapInstallmentToDealerMinor: v.number(),
    customerGapToFinanceCompanyMinor: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    /**
     * BOTH permissions, and the money one is not decoration.
     *
     * The cockpit withholds this action from a caller who cannot see the
     * deal's figures, and `dealCockpit` withholds the figures themselves on the
     * same rule — `isSystemOwnerRole(role) || VIEW_FINANCE`. But a permission
     * enforced by rendering is not enforced: a default MANAGER holds
     * `approve:finance_application` WITHOUT `view:finance`, so they could call
     * this mutation directly and settle a shortfall the product deliberately
     * does not show them. Settling a shortfall moves the owner-facing profit, so
     * it takes the money permission — on AUTHORITY, not secrecy (a MANAGER can
     * read `rawAppraisalGapMinor` through `getEconomics` regardless).
     *
     * `requireTenantAuth` applies the system-owner bypass itself, so this is
     * the SAME authority the cockpit computes rather than a second rule free to
     * drift from it.
     */
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.APPROVE_FINANCE_APPLICATION,
      PERMISSIONS.VIEW_FINANCE,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId
    );

    // Separation of duties, the same one `approveDealerPurchaseAmount` and
    // `reopenApproval` enforce. Deciding where the customer's share of a
    // shortfall lands moves the owner-facing profit — routing all of it to the
    // dealership raises the figure by the whole gap — so the person who sold
    // the vehicle does not get to decide it on their own deal, however senior.
    // Enforced here and not only in the card, because this mutation is
    // reachable directly.
    if (user._id === app.salespersonId) {
      throw new ConvexError(
        "You cannot settle the appraisal gap on your own application. A manager or the dealership owner records it."
      );
    }

    // The lifecycle, before anything else about the money.
    //
    // These economics are SEALED by the steps that follow. `registerVehicleHandover`
    // freezes the approved figures and `finalizeDeal` creates the sale and writes
    // the remittance — a resolution recorded afterwards would recompute the
    // owner's profit behind a deal whose journal already exists, and on a
    // direct-to-supplier deal would overwrite the zero remittance finalization
    // deliberately wrote. The negotiation belongs before the vehicle leaves.
    if (app.status !== "APPROVED") {
      throw new ConvexError(
        "Only an approved application can have its appraisal gap settled."
      );
    }
    // ONE exception to the handover seal, and it is exactly as wide as the
    // shape that needs it (SCRUM-116). Handover now refuses a positive gap
    // nobody has settled (`assertAppraisalGapSettledToAdvance`), so every gap
    // still open after the vehicle went out is one of two things: a row from
    // before that gate existed, or a gap created by the FIRST approval the
    // server permits AFTER handover (it refuses only a CHANGE to a recorded
    // approval). The second is the ordinary direct-route order and would be
    // stranded without this — unable to settle here, refused at finalization,
    // `reopenApproval` sealed too. It is told apart by the record, not
    // inferred: an approval timestamp LATER than the handover's is a gap the
    // handover never stamped, and there is nothing sealed to disturb. An
    // approval timestamp EARLIER than the handover's is the pre-gate shape and
    // keeps the seal — no longer produced, and a repair decision rather than
    // something to settle after the fact.
    //
    // EQUAL timestamps are temporally ambiguous: two transactions can share a
    // `Date.now()` millisecond, so equality can be the recovery shape or an
    // equal-time legacy row, and the record cannot tell them apart. The
    // ambiguity is deliberately admitted (`>=`, not `>`) because a strict
    // comparison would strand exactly the recovery this exists for, while
    // admitting an equal-time legacy row lets it be settled through the same
    // reviewed writer instead of being stranded too. Finalization seals both
    // shapes. The one-resolution rule below is untouched.
    if (app.vehicleHandoverAt !== undefined) {
      const approvalNotBeforeHandover =
        app.approvedPurchaseApprovedAt !== undefined &&
        app.approvedPurchaseApprovedAt >= app.vehicleHandoverAt;
      if (!approvalNotBeforeHandover) {
        throw new ConvexError(
          "The vehicle has already been handed over on this deal, so its figures are sealed and the appraisal gap can no longer be settled here."
        );
      }
    }
    if (app.finalizedSaleId !== undefined) {
      throw new ConvexError(
        "This deal has already been closed, so its figures are sealed and the appraisal gap can no longer be settled here."
      );
    }

    assertSupportedDenomination(app.economicsCurrency, "recording this gap resolution");

    // Stale first, before any arithmetic: an allocation reconciling to a gap
    // this deal no longer has is not worth validating.
    if (args.economicsStamp !== economicsStamp(app)) {
      throw new ConvexError(
        "This deal's figures changed while you were agreeing the split. Re-check the appraisal gap before recording how it is settled."
      );
    }

    const rawAppraisalGapMinor = app.rawAppraisalGapMinor;
    if (rawAppraisalGapMinor === undefined) {
      throw new ConvexError(
        "This deal's appraisal gap has not been worked out yet, so there is nothing to settle. Record the missing economics first."
      );
    }
    if (rawAppraisalGapMinor <= 0) {
      // `approveDealerPurchaseAmount` already wrote NOT_REQUIRED for this deal;
      // there is no split to record and nothing here to correct.
      throw new ConvexError(
        "This deal has no appraisal gap, so there is nothing to settle between the customer and the dealership."
      );
    }

    /**
     * INITIAL resolution only. The raw gap is allocated exactly once.
     *
     * Every other guard here answered "may this caller act, on this deal, on
     * these figures" — and none of them asked whether the shortfall had ALREADY
     * been settled. The screen hides the action once resolved; that is not a
     * boundary, this is a public mutation. Reopening stays possible and stays
     * deliberate — re-approval already clears the resolution back to
     * PENDING_NEGOTIATION when the gap moves, and `reopenApproval` clears it
     * outright — both recorded acts by someone with the authority to move the
     * approved amount. What is refused is a silent second allocation wearing
     * the first one's clothes.
     */
    const alreadyResolved =
      app.gapResolution === "CUSTOMER_ABSORBS" ||
      app.gapResolution === "SPLIT" ||
      app.gapResolution === "DEALER_ABSORBS";
    if (alreadyResolved) {
      throw new ConvexError(
        "Who covers this difference has already been agreed and recorded on this deal. To change it, reopen the approved purchase amount — that clears the agreement and puts the deal back into negotiation."
      );
    }

    const settlement = {
      customerGapShareMinor: args.customerGapShareMinor,
      dealerGapShareMinor: args.dealerGapShareMinor,
      customerGapCashToDealerMinor: args.customerGapCashToDealerMinor,
      customerGapInstallmentToDealerMinor: args.customerGapInstallmentToDealerMinor,
      customerGapToFinanceCompanyMinor: args.customerGapToFinanceCompanyMinor,
    };
    // The SHARED assertion — every violation named, and the mutation refuses
    // outright. Not a local re-implementation: a second copy of the two
    // identities is how the destination fields get dropped.
    assertGapResolutionValid(rawAppraisalGapMinor, settlement);

    const resolution = classifyGapResolution(
      rawAppraisalGapMinor,
      args.customerGapShareMinor,
      args.dealerGapShareMinor
    );

    const notes = args.notes?.trim();
    await ctx.db.patch(args.applicationId, {
      gapResolution: resolution,
      ...settlement,
      gapResolvedAt: Date.now(),
      gapResolvedBy: user._id,
      // Distinct from omitting it: an emptied note clears the previous one
      // rather than leaving a stale explanation attached to a new agreement.
      gapResolutionNotes: notes ? notes : undefined,
    });

    // The canonical recomputation, not a local sum. It is what folds the
    // customer's dealership-bound share into the owner's profit figure.
    const updated = await ctx.db.get(args.applicationId);
    if (!updated) {
      // The patch and this re-read happen inside the SAME Convex mutation, so
      // no partial state is commit-able; a throw rolls everything back, which
      // is the only safe answer to "the row I just wrote is gone".
      throw new ConvexError(
        "This deal could not be re-read after recording the split, so its figures were not updated. Nothing was saved — try again."
      );
    }
    await recomputeAndPatchEconomics(ctx, updated);

    // History, because the row only ever holds the CURRENT agreement. Who moved
    // a shortfall onto the customer, and when, is exactly what gets asked months
    // later when the profit figure is questioned.
    await recordOverride(ctx, {
      orgId: args.orgId,
      applicationId: args.applicationId,
      field: "gapResolution",
      previousValue: app.gapResolution,
      newValue: `${resolution} (customer ${args.customerGapShareMinor}, dealer ${args.dealerGapShareMinor}; customer share as cash ${args.customerGapCashToDealerMinor}, installments ${args.customerGapInstallmentToDealerMinor}, to the finance company ${args.customerGapToFinanceCompanyMinor}; against a raw gap of ${rawAppraisalGapMinor})`,
      // `notes ? notes : …`, NOT `??`: a whitespace-only note trims to "", which
      // is defined, so nullish coalescing would write an EMPTY reason onto the
      // one audit row that explains why money moved.
      reason: notes ? notes : `Appraisal gap settled as ${resolution}.`,
      changedBy: user._id,
    });

    return args.applicationId;
  },
});

export const listNeedingReconciliation = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
    ]);
    const page = await ctx.db
      .query("financeApplications")
      .withIndex("by_org_reconciliation", (q) =>
        q.eq("orgId", args.orgId).eq("needsFinancingReconciliation", true)
      )
      .paginate(args.paginationOpts);

    return {
      ...page,
      /**
       * Built from the PROJECTED row, not the raw one (SCRUM-117).
       *
       * This queue authorizes on VIEW_FINANCE_APPLICATIONS and hand-listed the
       * quotation, the approved amount, the LTV, the funded portion, the dealer
       * contribution, the raw gap and the remittance — every figure the
       * boundary withholds elsewhere, served raw to the same default SALES and
       * MANAGER templates. A door that assembles its own row is exactly the
       * shape an allowlist exists to catch; it now reads what the caller may
       * read and nothing else.
       */
      page: page.page.map((app) => {
        const visible = projectFinanceApplication(app, role);
        return {
          _id: visible._id,
          _creationTime: visible._creationTime,
          customerId: visible.customerId,
          vehicleId: visible.vehicleId,
          companyId: visible.companyId,
          status: visible.status,
          financingReconciliationReason: visible.financingReconciliationReason,
          economicsCurrency: visible.economicsCurrency,
          submittedQuotationMinor: visible.submittedQuotationMinor,
          approvedDealerPurchaseAmountMinor: visible.approvedDealerPurchaseAmountMinor,
          appliedLtvPercent: visible.appliedLtvPercent,
          financeCompanyFundedPortionMinor: visible.financeCompanyFundedPortionMinor,
          dealerContributionMinor: visible.dealerContributionMinor,
          rawAppraisalGapMinor: visible.rawAppraisalGapMinor,
          expectedDealerRemittanceMinor: visible.expectedDealerRemittanceMinor,
          // The migration's own note for a disbursed row says "re-enter the
          // approved purchase amount, the applied LTV and the actual receipt".
          // Carrying `disbursedAt` but not the amount told a triager THAT money
          // moved and not how much — so working the queue meant opening every row.
          disbursedAt: visible.disbursedAt,
          disbursedAmountMinor: visible.disbursedAmountMinor,
          actualDealerReceiptTotalMinor: visible.actualDealerReceiptTotalMinor,
          finalizedSaleId: visible.finalizedSaleId,
          updatedAt: visible.updatedAt,
        };
      }),
    };
  },
});

/**
 * Marks a flagged deal as reviewed.
 *
 * Deliberately requires a note saying what was checked: the flag exists because
 * a figure could not be trusted, and clearing it without a record would leave
 * no evidence that anyone actually looked.
 */
export const resolveFinancingReconciliation = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const note = args.note.trim();
    if (!note) {
      throw new ConvexError("Record what was checked before clearing the reconciliation flag.");
    }

    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    if (!app.needsFinancingReconciliation) {
      throw new ConvexError("This deal is not flagged for reconciliation.");
    }

    await recordOverride(ctx, {
      orgId: args.orgId,
      applicationId: args.applicationId,
      field: "needsFinancingReconciliation",
      previousValue: app.financingReconciliationReason ?? "true",
      newValue: "resolved",
      reason: note,
      changedBy: user._id,
    });

    await ctx.db.patch(args.applicationId, {
      needsFinancingReconciliation: false,
      financingReconciliationReason: undefined,
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});
