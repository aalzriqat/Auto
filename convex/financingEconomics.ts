import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import {
  requireOwnedRow,
  requireTenantAuth,
  redactSettlementEvidence,
  canSeeApprovedPurchaseAmount,
} from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
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
import { toMinorUnits } from "./utils/money";
import {
  assertMinorAmount,
  buildRuleSnapshot,
  deriveEconomics,
  evaluateQuotationException,
  resolveAppliedLtv,
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
async function recomputeAndPatchEconomics(
  ctx: MutationCtx,
  app: Doc<"financeApplications">
): Promise<void> {
  const snapshot = await resolveRuleSnapshot(ctx, app);
  const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, app.orgId));

  if (
    app.submittedQuotationMinor === undefined ||
    app.approvedDealerPurchaseAmountMinor === undefined ||
    app.appliedLtvPercent === undefined
  ) {
    return;
  }

  const customerGapToDealer =
    (app.customerGapCashToDealerMinor ?? 0) + (app.customerGapInstallmentToDealerMinor ?? 0);

  // The appraisal the approval was actually based on, for companies whose LTV
  // rule multiplies the appraisal rather than the approved amount.
  const basisAppraisal = app.approvedPurchaseAppraisalId
    ? await ctx.db.get(app.approvedPurchaseAppraisalId)
    : null;

  const derived = deriveEconomics({
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    appliedLtvPercent: app.appliedLtvPercent,
    customerFirstPaymentMinor: app.customerFirstPaymentMinor ?? 0,
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
    // Fee deductions are per-deal fee rows, which arrive with the settlement
    // work. Until then nothing is withheld, which is the correct reading of
    // "no fees have been recorded" rather than a placeholder.
    feeDeductionsMinor: 0,
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
      financeCompanyFundedPortionMinor: undefined,
      unfinancedPortionMinor: undefined,
      dealerContributionMinor: undefined,
      expectedDealerRemittanceMinor: undefined,
      rawAppraisalGapMinor: undefined,
      needsFinancingReconciliation: true,
      financingReconciliationReason: appendReconciliationReason(
        app.financingReconciliationReason,
        `This finance company applies its LTV to the ${(snapshot.ltvBasis ?? "APPROVED_PURCHASE_AMOUNT").toLowerCase().replace(/_/g, " ")}, which has not been recorded on this deal. Record it before relying on the funding split.`
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
 * Turns a stored override row into something a screen may show.
 *
 * The rows are written for an AUDIT TABLE, not for a person. `recordOverride`
 * stringifies whatever changed, and the approval site builds that string with
 * the whole decision in it:
 *
 *   "150000000 (MANUAL @ 85% LTV, approved by pd78fs58de9dnyrek2hvw0k63s88wmc4)"
 *
 * Rendering that verbatim would put a raw minor-unit integer and an internal
 * user id in front of an operator — a money figure a thousand times too large,
 * beside an identifier that means nothing to anyone. So the amount is extracted
 * as a NUMBER for the client to format in the deal's own currency, and every
 * other part of the string is dropped rather than displayed.
 *
 * Values that cannot be presented safely are omitted entirely. A history line
 * that shows only the reason, the person and the time is worth having; one that
 * shows a raw internal string is not, and "show it anyway" is how the id would
 * reach the screen through some field nobody thought about.
 */
function presentOverrideValues(row: Doc<"financeApplicationOverrides">): {
  previousAmountMinor?: number;
  newAmountMinor?: number;
  newIsReopened: boolean;
} {
  // Only money fields carry a leading minor-unit integer, and only they should
  // ever be rendered as a figure. Keyed off the field NAME rather than off
  // whether the string happens to start with digits, so a future non-money
  // override whose value begins with a number is not silently shown as money.
  const isAmountField = row.field.endsWith("Minor");
  const leadingAmount = (value: string | undefined): number | undefined => {
    if (!isAmountField || value === undefined) return undefined;
    // DELIMITED, not merely leading. `^(\d+)` alone reads "12.5" as 12 and
    // renders it as twelve minor units — a plausible-looking figure produced by
    // silently truncating a decimal, which is worse than showing nothing. The
    // real rows are either the bare integer or the integer followed by a space
    // and the parenthesised decision, so anything else is a value this function
    // does not understand and must not present.
    const match = /^(\d+)(?=$|[\s(])/.exec(value.trim());
    if (!match) return undefined;
    const parsed = Number(match[1]);
    // Fails closed on anything outside the range money can be counted in.
    // `Number.isSafeInteger` covers NaN, ±Infinity, fractions and magnitudes
    // past 2^53 — beyond which the arithmetic that would follow is not exact
    // anyway. A figure that cannot be trusted is omitted, never rounded into
    // something that looks trustworthy.
    if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
    return parsed;
  };

  return {
    previousAmountMinor: leadingAmount(row.previousValue),
    // The sentinel the reopen path writes. It is a state, not a figure, so it
    // is reported as one and the client says it in the operator's language.
    newIsReopened: row.newValue === "reopened",
    newAmountMinor: row.newValue === "reopened" ? undefined : leadingAmount(row.newValue),
  };
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

  const customerFirstPaymentMinor =
    overrides.customerFirstPaymentMinor ?? app.customerFirstPaymentMinor ?? 0;
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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
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
    let solved: Awaited<ReturnType<typeof solveQuotationForApplication>>;
    try {
      solved = await solveQuotationForApplication(ctx, app, args);
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      return {
        appliedLtvPercent: undefined,
        currency,
        ruleVersion: undefined,
        available: false as const,
        reason: typeof error.data === "string" ? error.data : "RULES_UNAVAILABLE",
      };
    }

    const base = {
      appliedLtvPercent: solved.appliedLtvPercent as number | undefined,
      currency,
      ruleVersion: solved.snapshot.ruleVersion as number | undefined,
    };

    // No target recorded anywhere is a different state from the solver running
    // and declining, and collapsing the two would tell the user their finance
    // company's rules are the problem when the missing input is theirs.
    if (!solved.result) {
      return { ...base, available: false as const, reason: "NO_TARGET_RECORDED" as const };
    }
    if (!solved.result.available) {
      return { ...base, available: false as const, reason: solved.result.reason };
    }
    return {
      ...base,
      available: true as const,
      submittedQuotationMinor: solved.result.submittedQuotationMinor,
      projectedNetProceedsMinor: solved.result.projectedNetProceedsMinor,
      customerCoversUnfinancedPortion: solved.result.customerCoversUnfinancedPortion,
      financeCompanyFundedPortionMinor:
        solved.result.composition.financeCompanyFundedPortionMinor,
      unfinancedPortionMinor: solved.result.composition.unfinancedPortionMinor,
      dealerContributionMinor: solved.result.composition.dealerContributionMinor,
      customerFirstPaymentSurplusMinor:
        solved.result.composition.customerFirstPaymentSurplusMinor,
      ltvBaseCapApplied: solved.result.composition.ltvBaseCapApplied,
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

    // Cost-bearing figures follow the same rule as everywhere else in the
    // codebase (see the vehicle queries): SALES and RECEPTION hold
    // VIEW_FINANCE_APPLICATIONS but not VIEW_COST_PRICE. Stripping them here
    // rather than when something first writes them means the day
    // vehiclePurchaseCostMinor starts being populated is not the day the
    // vehicle's cost quietly starts reaching the sales floor.
    //
    // Blanked rather than omitted so the returned shape stays the same for
    // every caller — a union of "has the key" and "does not" would make every
    // consumer narrow before reading anything.
    // The SAME predicate `redactSettlementEvidence` applies to the amount
    // itself — imported, not restated, so the history and the figure it
    // describes can never disagree about who may see them.
    const canWorkDisbursement = canSeeApprovedPurchaseAmount(auth.role);
    const canSeeCost =
      isSystemOwnerRole(auth.role) ||
      auth.role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    return {
      application: {
        // Through the SAME helper `applications.get` uses. This query authorizes
        // on VIEW_FINANCE_APPLICATIONS, which the default SALES template holds,
        // and spread the whole document while redacting exactly one field — so
        // gating the other two doors left the settlement evidence readable here
        // by a weaker role than the one that had just been closed.
        ...redactSettlementEvidence(app, auth.role),
        vehiclePurchaseCostMinor: canSeeCost ? app.vehiclePurchaseCostMinor : undefined,
      },
      appraisals: appraisals.sort((a, b) => b.appraisedAt - a.appraisedAt),
      /**
       * The corrections on this deal, newest first — with the person named.
       *
       * WITHHELD from a caller who may not see the approved amount, because
       * `recordOverride` stringifies that amount into `previousValue` and
       * `newValue`. `redactSettlementEvidence` names this query's `overrides[]`
       * as one of three routes by which a `view:sales` caller recovers a figure
       * the row itself withholds, and until now nothing rendered them so the
       * exposure was API-only. Putting them on screen without this gate would
       * have printed the withheld number in front of exactly the role it is
       * withheld from.
       *
       * This closes ONE of the three named routes. It does not create the
       * boundary — the other two (deriving it from the funded portion and the
       * LTV, and reading it out of the free-text approval notes) are untouched,
       * and that rework is tracked separately. Claiming otherwise here would be
       * the "false assurance behind a longer comment" that helper warns about.
       */
      overrides: canWorkDisbursement
        ? await Promise.all(
            overrides
              .sort((a, b) => b.changedAt - a.changedAt)
              .map(async (row) => ({
                _id: row._id,
                field: row.field,
                reason: row.reason,
                changedAt: row.changedAt,
                // Resolved here rather than in the browser: the id alone tells
                // an operator nothing, and a history that cannot say who made a
                // correction is not an audit trail.
                changedByName: (await ctx.db.get(row.changedBy))?.name,
                ...presentOverrideValues(row),
              }))
          )
        : [],
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
      const snapshot = await resolveRuleSnapshot(ctx, app);
      const establishedLtvPercent = app.appliedLtvPercent ?? snapshot.defaultLtvPercent;
      const mayApprove =
        isSystemOwnerRole(role) ||
        role.permissions.includes(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
      if (args.ltvPercent !== establishedLtvPercent && !mayApprove) {
        throw new ConvexError(
          "Only a user who can approve finance applications may set the LTV this deal is financed at. Ask a manager to record the rate the financing company confirmed."
        );
      }
    }

    // The same resolution `suggestQuotationForApplication` runs, so the figure
    // the user was shown is the figure the guard below accepts. Two copies of
    // this would drift the moment either gained an input.
    const {
      snapshot,
      appliedLtvPercent,
      customerFirstPaymentMinor,
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
        throw new ConvexError(
          `This quotation is recorded as ${modeLabel}, but the calculator could not run (${solverResult.reason}). Submit it as a manual entry instead.`
        );
      }
      const matchesSolver =
        solverResult.submittedQuotationMinor === args.submittedQuotationMinor;
      if (args.source === "SYSTEM_CALCULATED" && !matchesSolver) {
        throw new ConvexError(
          `This quotation is recorded as calculated by the system, but the calculator produced ${solverResult.submittedQuotationMinor} minor units, not ${args.submittedQuotationMinor}. Record it as a calculated quotation with an override and say why it differs.`
        );
      }
      // An "override" that departs from nothing is not an override. Letting it
      // through would put a departure on the record, complete with a reason
      // explaining a difference that does not exist.
      if (args.source === "CALCULATED_WITH_OVERRIDE" && matchesSolver) {
        throw new ConvexError(
          `This quotation is recorded as an override, but it matches the calculated figure of ${solverResult.submittedQuotationMinor} minor units exactly. Record it as calculated by the system instead.`
        );
      }
    }

    await ctx.db.patch(args.applicationId, {
      economicsCurrency: app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId)),
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
    const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.APPROVE_FINANCE_APPLICATION,
    ]);
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
      appraisal = appraisals
        .filter(
          (row) =>
            (row.status === "RECORDED" || row.status === "APPROVED") &&
            row.providerType !== "DEALER_ESTIMATE"
        )
        .sort((a, b) => b.appraisedAt - a.appraisedAt)[0];
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
    const comparisonAppraisal = appraisals
      .filter(
        (row) =>
          (row.status === "RECORDED" || row.status === "APPROVED") &&
          row.providerType !== "DEALER_ESTIMATE"
      )
      .sort((a, b) => b.appraisedAt - a.appraisedAt)[0];
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
export const listNeedingReconciliation = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
    const page = await ctx.db
      .query("financeApplications")
      .withIndex("by_org_reconciliation", (q) =>
        q.eq("orgId", args.orgId).eq("needsFinancingReconciliation", true)
      )
      .paginate(args.paginationOpts);

    return {
      ...page,
      page: page.page.map((app) => ({
        _id: app._id,
        _creationTime: app._creationTime,
        customerId: app.customerId,
        vehicleId: app.vehicleId,
        companyId: app.companyId,
        status: app.status,
        financingReconciliationReason: app.financingReconciliationReason,
        economicsCurrency: app.economicsCurrency,
        submittedQuotationMinor: app.submittedQuotationMinor,
        approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
        appliedLtvPercent: app.appliedLtvPercent,
        financeCompanyFundedPortionMinor: app.financeCompanyFundedPortionMinor,
        dealerContributionMinor: app.dealerContributionMinor,
        rawAppraisalGapMinor: app.rawAppraisalGapMinor,
        expectedDealerRemittanceMinor: app.expectedDealerRemittanceMinor,
        // The migration's own note for a disbursed row says "re-enter the
        // approved purchase amount, the applied LTV and the actual receipt".
        // Carrying `disbursedAt` but not the amount told a triager THAT money
        // moved and not how much — so working the queue meant opening every row.
        disbursedAt: app.disbursedAt,
        disbursedAmountMinor: app.disbursedAmountMinor,
        actualDealerReceiptTotalMinor: app.actualDealerReceiptTotalMinor,
        finalizedSaleId: app.finalizedSaleId,
        updatedAt: app.updatedAt,
      })),
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
