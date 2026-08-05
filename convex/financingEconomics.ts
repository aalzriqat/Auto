import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { computeSubmittedQuotation } from "../lib/financingEconomics";
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
    const canSeeCost =
      isSystemOwnerRole(auth.role) ||
      auth.role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    return {
      application: {
        ...app,
        vehiclePurchaseCostMinor: canSeeCost ? app.vehiclePurchaseCostMinor : undefined,
      },
      appraisals: appraisals.sort((a, b) => b.appraisedAt - a.appraisedAt),
      overrides: overrides.sort((a, b) => b.changedAt - a.changedAt),
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [
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

    const snapshot = await resolveRuleSnapshot(ctx, app);
    const appliedLtvPercent = resolveAppliedLtv(
      snapshot,
      args.ltvPercent ?? app.appliedLtvPercent
    );

    const customerFirstPaymentMinor =
      args.customerFirstPaymentMinor ?? app.customerFirstPaymentMinor ?? 0;
    if (
      snapshot.minimumCustomerFirstPaymentMinor !== undefined &&
      customerFirstPaymentMinor < snapshot.minimumCustomerFirstPaymentMinor
    ) {
      throw new ConvexError(
        `${snapshot.companyName} requires a customer first payment of at least ${snapshot.minimumCustomerFirstPaymentMinor} minor units.`
      );
    }

    const now = Date.now();
    // Audit any change to an already-recorded quotation, whatever the source.
    // Gating this on a reason meant a CALCULATED re-submission could rewrite
    // 12,500 to 9,000 with no trace — the exact hole this table exists to
    // close, reopened for the one figure the module calls a real external
    // document.
    if (
      app.submittedQuotationMinor !== undefined &&
      app.submittedQuotationMinor !== args.submittedQuotationMinor
    ) {
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "submittedQuotationMinor",
        previousValue: app.submittedQuotationMinor,
        newValue: args.submittedQuotationMinor,
        reason: reason ?? "Recalculated from updated deal inputs.",
        changedBy: user._id,
      });
    }

    // Re-run the solver purely to record what it would have said, so an
    // override is auditable against the figure it departed from. Never used to
    // fill in a missing input: when expenses or the buffer have not been
    // entered they are zero, not back-solved from the quotation.
    const targetForSolver = args.targetSellingAmountMinor ?? app.targetNetProceedsMinor;
    const expensesForSolver =
      args.estimatedDealerBorneExpensesMinor ?? app.estimatedDealerBorneExpensesMinor;
    const bufferForSolver = args.quotationBufferMinor ?? app.quotationBufferMinor;
    const solverResult =
      targetForSolver !== undefined
        ? computeSubmittedQuotation({
            targetNetProceedsMinor: targetForSolver,
            estimatedDealerBorneExpensesMinor: expensesForSolver ?? 0,
            quotationBufferMinor: bufferForSolver,
            customerFirstPaymentMinor,
            appliedLtvPercent,
            customerFirstPaymentOffsetsUnfinancedShare:
              snapshot.customerFirstPaymentOffsetsUnfinancedShare,
          })
        : undefined;

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
      submittedQuotationAt: now,
      submittedQuotationBy: user._id,
      appliedLtvPercent,
      customerFirstPaymentMinor,
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
    } else {
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
    const approvalMateriallyChanged =
      app.approvedDealerPurchaseAmountMinor !== undefined &&
      (app.approvedDealerPurchaseAmountMinor !== args.approvedAmountMinor ||
        app.approvedPurchaseBasis !== args.basis ||
        app.approvedPurchaseAppraisalId !== appraisal?._id ||
        app.appliedLtvPercent !== appliedLtvPercent ||
        (app.approvedPurchaseNotes ?? "") !== (args.notes?.trim() ?? ""));
    if (approvalMateriallyChanged) {
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "approvedDealerPurchaseAmountMinor",
        // Both money-determining inputs, so the row says which one moved
        // rather than only that something did.
        previousValue:
          app.approvedDealerPurchaseAmountMinor === undefined
            ? undefined
            : `${app.approvedDealerPurchaseAmountMinor} (${app.approvedPurchaseBasis ?? "unknown basis"} @ ${app.appliedLtvPercent ?? "unknown"}% LTV)`,
        newValue: `${args.approvedAmountMinor} (${args.basis} @ ${appliedLtvPercent}% LTV)`,
        reason: args.notes?.trim() ?? `Re-approved on the ${args.basis} basis.`,
        changedBy: user._id,
      });
    }

    if (appraisal && appraisal.status === "RECORDED") {
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
      approvedPurchaseApprovedBy: user._id,
      approvedPurchaseApprovedAt: now,
      approvedPurchaseNotes: args.notes?.trim(),
      appliedLtvPercent,
      // Only claim a finalized appraisal when one exists. A MANUAL approval
      // needs no appraisal, and writing FINALIZED there asserted a fact that
      // never happened — in a dimension PR 2 and PR 3 gate handover on.
      ...(appraisal ? { appraisalStatus: "FINALIZED" as const } : {}),
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
        expectedDealerRemittanceMinor: app.expectedDealerRemittanceMinor,
        disbursedAt: app.disbursedAt,
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
