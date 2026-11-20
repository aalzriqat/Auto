import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import {
  adoptLenderCorrectionQuote,
  assertNoAgreementMoney,
  readCorrectableAgreement,
  refreshLenderEvidence,
  validateReplacementQuote,
} from "./utils/deliveredLenderCorrection";
import { assertExpectedEconomicsStamp } from "./utils/financeCorrectionState";
import {
  economicsStamp,
  GAP_RESOLUTION_CLEARED,
  shortfallFieldsFor,
} from "./utils/financingEconomics";
import { runWithIdempotency } from "./utils/idempotency";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { adoptReplacementCommercialQuote } from "./utils/quotedCommercialDeal";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

const CORRECTION_PERMISSIONS = [
  PERMISSIONS.APPROVE_FINANCE_APPLICATION,
  PERMISSIONS.VIEW_FINANCE,
  PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
];

export const detail = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  returns: v.union(
    v.null(),
    v.object({
      kind: v.literal("PENDING"),
      correctionId: v.id("deliveredLenderCorrections"),
      lenderName: v.string(),
      reason: v.string(),
      canApprove: v.boolean(),
    }),
    v.object({
      kind: v.literal("AVAILABLE"),
      handoverAt: v.number(),
      economicsStamp: v.string(),
      replacements: v.array(
        v.object({
          quoteId: v.id("quotes"),
          name: v.string(),
          termMonths: v.number(),
          createdAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, { orgId, applicationId }) => {
    const { role, user } = await requireTenantAuth(ctx, orgId);
    if (
      !isSystemOwnerRole(role) &&
      CORRECTION_PERMISSIONS.some(
        (permission) => !role.permissions.includes(permission),
      )
    )
      return null;
    const app = await requireOwnedRow(
      ctx,
      orgId,
      "financeApplications",
      applicationId,
    );
    if (app.pendingLenderCorrectionId !== undefined) {
      const correction = await ctx.db.get(app.pendingLenderCorrectionId);
      if (
        !correction ||
        correction.orgId !== orgId ||
        correction.applicationId !== applicationId ||
        correction.status !== "PENDING"
      )
        return null;
      const lender = await ctx.db.get(correction.replacementCompanyId);
      if (lender?.orgId !== orgId) return null;
      let canApprove = false;
      if (
        user._id !== correction.requestedBy &&
        user._id !== app.salespersonId &&
        readCorrectableAgreement(app) &&
        economicsStamp(app) === correction.economicsStamp &&
        app.quoteId === correction.originalQuoteId &&
        app.companyId === correction.originalCompanyId &&
        app.vehicleHandoverAt === correction.handoverAt
      ) {
        const original = await ctx.db.get(correction.originalQuoteId);
        const replacement = await ctx.db.get(correction.replacementQuoteId);
        if (original?.orgId === orgId && replacement?.orgId === orgId) {
          try {
            const candidate = await validateReplacementQuote(
              ctx,
              app,
              original,
              replacement,
            );
            await assertNoAgreementMoney(ctx, app, original, replacement);
            canApprove =
              candidate.lender._id === correction.replacementCompanyId;
          } catch (error) {
            if (!(error instanceof ConvexError)) throw error;
          }
        }
      }
      return {
        kind: "PENDING" as const,
        correctionId: correction._id,
        lenderName: lender.name,
        reason: correction.reason,
        canApprove,
      };
    }
    const agreement = readCorrectableAgreement(app);
    if (!agreement) return null;
    const original = await requireOwnedRow(ctx, orgId, "quotes", app.quoteId);
    const quotes = await ctx.db
      .query("quotes")
      .withIndex("by_org_vehicle_status", (q) =>
        q
          .eq("orgId", orgId)
          .eq("vehicleId", app.vehicleId)
          .eq("status", "ACCEPTED"),
      )
      .order("desc")
      .take(25);
    const replacements: Array<{
      quoteId: Doc<"quotes">["_id"];
      name: string;
      termMonths: number;
      createdAt: number;
    }> = [];
    for (const quote of quotes) {
      if (
        quote.customerId !== app.customerId ||
        quote.companyId === app.companyId ||
        !quote.companyId
      )
        continue;
      try {
        const { lender } = await validateReplacementQuote(
          ctx,
          app,
          original,
          quote,
        );
        await assertNoAgreementMoney(ctx, app, original, quote);
        replacements.push({
          quoteId: quote._id,
          name: lender.name,
          termMonths: quote.termMonths,
          createdAt: quote.createdAt,
        });
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error;
      }
    }
    return {
      kind: "AVAILABLE" as const,
      handoverAt: agreement.handoverAt,
      economicsStamp: economicsStamp(app),
      replacements,
    };
  },
});

export const request = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    replacementQuoteId: v.id("quotes"),
    expectedHandoverAt: v.number(),
    expectedEconomicsStamp: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.id("deliveredLenderCorrections"),
  handler: async (ctx, args) => {
    const {
      orgId,
      applicationId,
      replacementQuoteId,
      expectedHandoverAt,
      expectedEconomicsStamp,
      idempotencyKey,
    } = args;
    const { user } = await requireTenantAuth(
      ctx,
      orgId,
      CORRECTION_PERMISSIONS,
    );
    const reason = args.reason.trim();
    if (!reason || reason.length > 500) {
      throw new ConvexError(
        "Record a reason of up to 500 characters for changing the lender.",
      );
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId,
        idempotencyKey,
        actorId: user._id,
        economic: true,
        operation: "deliveredLenderCorrections.request",
        fingerprint: JSON.stringify({
          applicationId,
          replacementQuoteId,
          expectedHandoverAt,
          expectedEconomicsStamp,
          reason,
        }),
      },
      async () => {
        const app = await requireOwnedRow(
          ctx,
          orgId,
          "financeApplications",
          applicationId,
        );
        const replacement = await requireOwnedRow(
          ctx,
          orgId,
          "quotes",
          replacementQuoteId,
        );
        assertExpectedEconomicsStamp(app, expectedEconomicsStamp, true);
        const agreement = readCorrectableAgreement(app);
        if (
          !agreement ||
          agreement.handoverAt !== expectedHandoverAt ||
          app.pendingLenderCorrectionId !== undefined
        ) {
          throw new ConvexError(
            "Only a verified, open delivered deal with no first payment or pending correction can change lenders here.",
          );
        }
        const original = await requireOwnedRow(
          ctx,
          orgId,
          "quotes",
          app.quoteId,
        );
        const { lender } = await validateReplacementQuote(
          ctx,
          app,
          original,
          replacement,
        );
        await assertNoAgreementMoney(ctx, app, original, replacement);

        const requestId = await ctx.db.insert("deliveredLenderCorrections", {
          orgId,
          applicationId,
          originalQuoteId: app.quoteId,
          replacementQuoteId,
          originalCompanyId: agreement.companyId,
          replacementCompanyId: lender._id,
          handoverAt: agreement.handoverAt,
          economicsStamp: expectedEconomicsStamp,
          reason,
          requestedBy: user._id,
          requestedAt: Date.now(),
          status: "PENDING",
        });
        await ctx.db.patch(app._id, { pendingLenderCorrectionId: requestId });
        return requestId;
      },
    );
  },
});

export const withdraw = mutation({
  args: {
    orgId: v.id("organizations"),
    correctionId: v.id("deliveredLenderCorrections"),
  },
  returns: v.null(),
  handler: async (ctx, { orgId, correctionId }) => {
    const { user } = await requireTenantAuth(
      ctx,
      orgId,
      CORRECTION_PERMISSIONS,
    );
    const correction = await requireOwnedRow(
      ctx,
      orgId,
      "deliveredLenderCorrections",
      correctionId,
    );
    const app = await requireOwnedRow(
      ctx,
      orgId,
      "financeApplications",
      correction.applicationId,
    );
    if (correction.status === "WITHDRAWN") return null;
    if (
      correction.status !== "PENDING" ||
      app.pendingLenderCorrectionId !== correctionId
    ) {
      throw new ConvexError("This correction is no longer pending.");
    }
    await ctx.db.patch(correctionId, {
      status: "WITHDRAWN",
      resolvedBy: user._id,
      resolvedAt: Date.now(),
    });
    await ctx.db.patch(app._id, { pendingLenderCorrectionId: undefined });
    return null;
  },
});

export const approve = mutation({
  args: {
    orgId: v.id("organizations"),
    correctionId: v.id("deliveredLenderCorrections"),
    lenderApprovalReference: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.id("financeApplications"),
  handler: async (
    ctx,
    { orgId, correctionId, lenderApprovalReference, idempotencyKey },
  ) => {
    const { user } = await requireTenantAuth(
      ctx,
      orgId,
      CORRECTION_PERMISSIONS,
    );
    const reference = lenderApprovalReference.trim();
    if (!reference || reference.length > 200) {
      throw new ConvexError("Record the new lender’s confirmation reference.");
    }
    return await runWithIdempotency(
      ctx,
      {
        orgId,
        idempotencyKey,
        actorId: user._id,
        economic: true,
        operation: "deliveredLenderCorrections.approve",
        fingerprint: JSON.stringify({ correctionId, reference }),
      },
      async () => {
        const correction = await requireOwnedRow(
          ctx,
          orgId,
          "deliveredLenderCorrections",
          correctionId,
        );
        const app = await requireOwnedRow(
          ctx,
          orgId,
          "financeApplications",
          correction.applicationId,
        );
        if (
          user._id === correction.requestedBy ||
          user._id === app.salespersonId
        ) {
          throw new ConvexError(
            "An independent finance approver must review the lender correction.",
          );
        }
        assertExpectedEconomicsStamp(app, correction.economicsStamp, true);
        const agreement = readCorrectableAgreement(app);
        if (
          correction.status !== "PENDING" ||
          app.pendingLenderCorrectionId !== correctionId ||
          !agreement ||
          agreement.companyId !== correction.originalCompanyId ||
          app.quoteId !== correction.originalQuoteId ||
          agreement.handoverAt !== correction.handoverAt ||
          app.approvedDealerPurchaseAmountMinor === undefined
        ) {
          throw new ConvexError(
            "The delivered deal changed. Review its current records before replacing the lender.",
          );
        }
        const original = await requireOwnedRow(
          ctx,
          orgId,
          "quotes",
          correction.originalQuoteId,
        );
        const replacement = await requireOwnedRow(
          ctx,
          orgId,
          "quotes",
          correction.replacementQuoteId,
        );
        const { lender, companyRuleSnapshot, economics } =
          await validateReplacementQuote(ctx, app, original, replacement);
        if (lender._id !== correction.replacementCompanyId) {
          throw new ConvexError(
            "The financing company on the replacement quote has changed.",
          );
        }
        await assertNoAgreementMoney(ctx, app, original, replacement);
        const ruleVersion =
          companyRuleSnapshot === undefined
            ? undefined
            : await ctx.db
                .query("financeCompanyRuleVersions")
                .withIndex("by_company_version", (q) =>
                  q
                    .eq("companyId", lender._id)
                    .eq("version", companyRuleSnapshot.ruleVersion),
                )
                .first();

        const now = Date.now();
        await adoptLenderCorrectionQuote(ctx, app, replacement);
        await adoptReplacementCommercialQuote(
          ctx,
          app,
          original,
          replacement,
          now,
        );
        await refreshLenderEvidence(ctx, app, lender, now);
        await ctx.db.patch(correctionId, {
          status: "APPROVED",
          resolvedBy: user._id,
          resolvedAt: now,
          lenderApprovalReference: reference,
          originalApproval: {
            amountMinor: app.approvedDealerPurchaseAmountMinor,
            approvedAt: app.approvedPurchaseApprovedAt,
            approvedBy: app.approvedPurchaseApprovedBy,
            quotationMinor: app.submittedQuotationMinor,
            quotationAt: app.submittedQuotationAt,
            quotationBy: app.submittedQuotationBy,
          },
        });
        await ctx.db.patch(app._id, {
          companyId: lender._id,
          quoteId: replacement._id,
          status: "PENDING_DOCS",
          creditDecision: "SUBMITTED",
          appraisalStatus: "NOT_REQUESTED",
          settlementStatus: "NOT_READY",
          approvedBy: undefined,
          approvedAt: undefined,
          customerQuotePricingSnapshot:
            replacement.customerQuotePricingSnapshot,
          companyRuleSnapshot,
          companyRuleVersionId: ruleVersion?._id,
          underwritingSnapshot: undefined,
          economicsRevision: (app.economicsRevision ?? 0) + 1,
          targetSellingAmountMinor: economics.targetSellingAmountMinor,
          targetNetProceedsMinor: economics.targetSellingAmountMinor,
          customerFirstPaymentMinor: economics.customerFirstPaymentMinor,
          estimatedDealerBorneExpensesMinor: economics.dealerBorneExpensesMinor,
          estimatedClosingExpensesMinor: economics.dealerBorneExpensesMinor,
          appliedLtvPercent: undefined,
          submittedQuotationMinor: undefined,
          submittedQuotationSource: undefined,
          submittedQuotationOverrideReason: undefined,
          submittedQuotationAt: undefined,
          submittedQuotationBy: undefined,
          quotationCalculationSnapshot: undefined,
          quoteFirstPaymentCorrectedMinor: undefined,
          approvedDealerPurchaseAmountMinor: undefined,
          approvedPurchaseBasis: undefined,
          approvedPurchaseAppraisalId: undefined,
          approvedPurchaseExceptionRuleVersion: undefined,
          approvedPurchaseApprovedBy: undefined,
          approvedPurchaseApprovedAt: undefined,
          approvedPurchaseCorrectedAfterHandoverAt: undefined,
          approvedPurchaseNotes: undefined,
          financeCompanyFundedPortionMinor: undefined,
          unfinancedPortionMinor: undefined,
          dealerContributionMinor: undefined,
          dealerContributionSettlement: undefined,
          customerContributionToFinanceCompanyMinor: undefined,
          customerContributionSettlement: undefined,
          customerGapToFinanceCompanyAppliedMinor: undefined,
          customerGapToFinanceCompanyUnconfirmedMinor: undefined,
          expectedDealerRemittanceMinor: undefined,
          rawAppraisalGapMinor: undefined,
          ...shortfallFieldsFor(undefined),
          gapResolution: undefined,
          ...GAP_RESOLUTION_CLEARED,
          pendingLenderCorrectionId: undefined,
          approvedLenderCorrectionId: correctionId,
          updatedAt: now,
        });
        await ctx.db.insert("applicationStatusLog", {
          orgId,
          applicationId: app._id,
          fromStatus: app.status,
          toStatus: "PENDING_DOCS",
          changedBy: user._id,
          changedAt: now,
          note: "Finance company correction approved. Review the replacement agreement.",
        });
        return app._id;
      },
    );
  },
});
