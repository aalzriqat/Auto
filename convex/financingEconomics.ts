import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { scaleForCurrency } from "./utils/money";
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

/** The vehicle's capitalized cost, in minor units, for the profit figures. */
async function vehicleCostMinor(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  currency: string
): Promise<number> {
  if (app.vehiclePurchaseCostMinor !== undefined) return app.vehiclePurchaseCostMinor;
  const vehicle = await ctx.db.get(app.vehicleId);
  if (!vehicle || vehicle.orgId !== app.orgId) return 0;
  const cost = vehicle.sourceType === "SOURCED" ? vehicle.sourceCost : vehicle.purchasePrice;
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return 0;
  return Math.round(cost * Math.pow(10, scaleForCurrency(currency)));
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

  const derived = deriveEconomics({
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    appliedLtvPercent: app.appliedLtvPercent,
    customerFirstPaymentMinor: app.customerFirstPaymentMinor ?? 0,
    submittedQuotationMinor: app.submittedQuotationMinor,
    dealerContributionSettlement:
      app.dealerContributionSettlement ??
      snapshot.dealerContributionSettlement ??
      "PAID_SEPARATELY",
    customerContributionSettlement:
      app.customerContributionSettlement ??
      snapshot.customerContributionSettlement ??
      "PASSED_THROUGH",
    customerContributionToFinanceCompanyMinor:
      app.customerContributionToFinanceCompanyMinor ?? app.customerFirstPaymentMinor ?? 0,
    // Fee deductions are per-deal fee rows, which arrive with the settlement
    // work. Until then nothing is withheld, which is the correct reading of
    // "no fees have been recorded" rather than a placeholder.
    feeDeductionsMinor: 0,
    customerDirectToDealerMinor: customerGapToDealer,
    dealerBorneExpensesMinor:
      app.actualClosingExpensesMinor ?? app.estimatedClosingExpensesMinor ?? 0,
    vehicleCostMinor: await vehicleCostMinor(ctx, app, currency),
  });

  await ctx.db.patch(app._id, {
    economicsCurrency: currency,
    financeCompanyFundedPortionMinor: derived.composition.financeCompanyFundedPortionMinor,
    unfinancedPortionMinor: derived.composition.unfinancedPortionMinor,
    dealerContributionMinor: derived.composition.dealerContributionMinor,
    expectedDealerRemittanceMinor: derived.remittance.expectedDealerRemittanceMinor,
    rawAppraisalGapMinor: derived.gap.rawAppraisalGapMinor,
    updatedAt: Date.now(),
  });
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
    estimatedExpensesMinor: v.number(),
    customerFirstPaymentMinor: v.number(),
    ltvPercent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
    assertMinorAmount(args.targetSellingAmountMinor, "Target selling amount");
    assertMinorAmount(args.estimatedExpensesMinor, "Estimated expenses");
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

    const suggestion = computeSubmittedQuotation({
      targetNetProceedsMinor: args.targetSellingAmountMinor,
      estimatedExpensesMinor: args.estimatedExpensesMinor,
      customerFirstPaymentMinor: args.customerFirstPaymentMinor,
      appliedLtvPercent,
    });

    return {
      appliedLtvPercent,
      currency: await getOrgCurrency(ctx, args.orgId),
      submittedQuotationMinor: suggestion.submittedQuotationMinor,
      projectedNetProceedsMinor: suggestion.projectedNetProceedsMinor,
      customerCoversUnfinancedPortion: suggestion.customerCoversUnfinancedPortion,
      financeCompanyFundedPortionMinor:
        suggestion.composition.financeCompanyFundedPortionMinor,
      unfinancedPortionMinor: suggestion.composition.unfinancedPortionMinor,
      dealerContributionMinor: suggestion.composition.dealerContributionMinor,
      customerFirstPaymentSurplusMinor:
        suggestion.composition.customerFirstPaymentSurplusMinor,
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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
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

    return {
      application: app,
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
    source: v.union(v.literal("CALCULATED"), v.literal("MANUAL")),
    overrideReason: v.optional(v.string()),
    targetSellingAmountMinor: v.optional(v.number()),
    estimatedExpensesMinor: v.optional(v.number()),
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
    if (args.estimatedExpensesMinor !== undefined) {
      assertMinorAmount(args.estimatedExpensesMinor, "Estimated expenses");
    }
    if (args.customerFirstPaymentMinor !== undefined) {
      assertMinorAmount(args.customerFirstPaymentMinor, "Customer first payment");
    }
    if (args.submittedQuotationMinor <= 0) {
      throw new ConvexError("The submitted quotation must be greater than zero.");
    }

    const reason = args.overrideReason?.trim();
    if (args.source === "MANUAL" && !reason) {
      throw new ConvexError(
        "A manually entered quotation must record why it differs from the calculated amount."
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
    if (app.submittedQuotationMinor !== undefined && reason) {
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "submittedQuotationMinor",
        previousValue: app.submittedQuotationMinor,
        newValue: args.submittedQuotationMinor,
        reason,
        changedBy: user._id,
      });
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
      ...(args.targetSellingAmountMinor !== undefined
        ? {
            targetSellingAmountMinor: args.targetSellingAmountMinor,
            targetNetProceedsMinor: args.targetSellingAmountMinor,
          }
        : {}),
      ...(args.estimatedExpensesMinor !== undefined
        ? { estimatedClosingExpensesMinor: args.estimatedExpensesMinor }
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.EDIT_VEHICLE_VALUATIONS,
    ]);
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
    const live = existing.filter(
      (appraisal) => appraisal.status === "RECORDED" || appraisal.status === "APPROVED"
    );
    const isReappraisal = live.length > 0;
    if (isReappraisal && !args.reappraisalReason?.trim()) {
      throw new ConvexError("A reappraisal must record why it was requested.");
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
    if (args.providerType !== "DEALER_ESTIMATE") {
      await ctx.db.patch(args.applicationId, {
        appraisalStatus: "COMPLETED",
        economicsCurrency: currency,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(args.applicationId, {
        dealerEstimateMinor: args.appraisalAmountMinor,
        economicsCurrency: currency,
        updatedAt: now,
      });
    }

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
    } else {
      appraisal = appraisals
        .filter((row) => row.status === "RECORDED" && row.providerType !== "DEALER_ESTIMATE")
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

    if (args.basis === "APPRAISAL") {
      if (args.approvedAmountMinor !== appraisal!.appraisalAmountMinor) {
        throw new ConvexError(
          `An approval based on the appraisal must equal it (${appraisal!.appraisalAmountMinor}). Use the exception or manual basis to approve a different amount.`
        );
      }
    }

    if (args.basis === "QUOTATION_EXCEPTION") {
      if (args.approvedAmountMinor !== app.submittedQuotationMinor) {
        throw new ConvexError(
          "A quotation exception approves at the submitted quotation. Use the manual basis for any other amount."
        );
      }
      const evaluation = evaluateQuotationException({
        submittedQuotationMinor: app.submittedQuotationMinor,
        independentAppraisalMinor: appraisal!.appraisalAmountMinor,
        allowsQuotationAboveAppraisal: snapshot.allowsQuotationAboveAppraisal ?? false,
        lowerAppraisalTolerancePercent: snapshot.lowerAppraisalTolerancePercent ?? 0,
      });
      if (!evaluation.eligible) {
        throw new ConvexError(
          evaluation.reason === "NOT_ALLOWED"
            ? `${snapshot.companyName} does not accept the submitted quotation when the appraisal is lower.`
            : evaluation.reason === "NO_SHORTFALL"
              ? "There is no appraisal shortfall, so no exception is needed."
              : `The appraisal is ${evaluation.shortfallPercent.toFixed(2)}% below the quotation, outside ${snapshot.companyName}'s tolerance of ${snapshot.lowerAppraisalTolerancePercent ?? 0}%.`
        );
      }
    }

    if (args.basis === "MANUAL" && !args.notes?.trim()) {
      throw new ConvexError("A manually approved purchase amount must record why.");
    }

    const now = Date.now();
    if (app.approvedDealerPurchaseAmountMinor !== undefined) {
      await recordOverride(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "approvedDealerPurchaseAmountMinor",
        previousValue: app.approvedDealerPurchaseAmountMinor,
        newValue: args.approvedAmountMinor,
        reason: args.notes?.trim() ?? `Re-approved on the ${args.basis} basis.`,
        changedBy: user._id,
      });
    }

    if (appraisal && appraisal.status === "RECORDED") {
      await ctx.db.patch(appraisal._id, { status: "APPROVED" });
    }

    await ctx.db.patch(args.applicationId, {
      approvedDealerPurchaseAmountMinor: args.approvedAmountMinor,
      approvedPurchaseBasis: args.basis,
      ...(appraisal ? { approvedPurchaseAppraisalId: appraisal._id } : {}),
      ...(args.basis === "QUOTATION_EXCEPTION"
        ? { approvedPurchaseExceptionRuleVersion: snapshot.ruleVersion }
        : {}),
      approvedPurchaseApprovedBy: user._id,
      approvedPurchaseApprovedAt: now,
      approvedPurchaseNotes: args.notes?.trim(),
      appliedLtvPercent,
      appraisalStatus: "FINALIZED",
      updatedAt: now,
    });

    const updated = await ctx.db.get(args.applicationId);
    if (updated) await recomputeAndPatchEconomics(ctx, updated);

    const refreshed = await ctx.db.get(args.applicationId);
    // A gap only becomes negotiable once the approval is on record. Opening it
    // here rather than leaving the dimension undefined is what stops a deal
    // with an unresolved 1,000 shortfall from looking complete.
    if (refreshed && (refreshed.rawAppraisalGapMinor ?? 0) > 0) {
      if (refreshed.gapResolution === undefined) {
        await ctx.db.patch(args.applicationId, { gapResolution: "PENDING_NEGOTIATION" });
      }
    } else if (refreshed && refreshed.gapResolution === undefined) {
      await ctx.db.patch(args.applicationId, { gapResolution: "NOT_REQUIRED" });
    }

    return args.applicationId;
  },
});
