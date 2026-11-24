import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import {
  archiveIdentityEvidence,
  canCorrectIdentityBeforeHandover,
  canVerifyIdentityCorrectionLenderReturn,
  clearedIdentityEvidence,
  commitReplacementVehicle,
  identityAgreement,
  IDENTITY_CORRECTION_PERMISSIONS,
  labelForIdentity,
  readOriginalIdentityDeal,
  readPreHandoverIdentityDealForLenderReturn,
  replacementIdentityOptions,
  replacementIdentityPatch,
  requiredCorrectionText,
  requiresLenderConfirmation,
  retireOriginalCommitment,
  verifySubstitution,
} from "./utils/deliveredDealIdentityCorrection";
import { assertExpectedEconomicsStamp } from "./utils/financeCorrectionState";
import { economicsStamp } from "./utils/financingEconomics";
import { cashRefundProofStamp, summarizeIdentityLenderReturn } from "./utils/identityCorrectionShowroomRefund";
import { runWithIdempotency } from "./utils/idempotency";
import { adoptReplacementCommercialQuote } from "./utils/quotedCommercialDeal";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

const kindValidator = v.union(v.literal("BUYER"), v.literal("VEHICLE"));
const optionValidator = v.object({
  quoteId: v.id("quotes"),
  label: v.string(),
  quotedAt: v.number(),
});
const refundDisplayFields = { amountMinor: v.number(), refundedAt: v.number() };
const lenderReturnOptionsValidator = v.object({
  originalReceipt: v.object({
    paymentId: v.id("customerFinanceCompanyPayments"),
    amountMinor: v.number(),
    currency: v.string(),
    paidAt: v.number(),
    reference: v.string(),
    receiptStamp: v.string(),
  }),
  showroomRefund: v.optional(v.object(refundDisplayFields)),
  updatedAt: v.number(),
  economicsStamp: v.string(),
  requiresLenderConfirmation: v.optional(v.literal(true)),
  options: v.array(optionValidator),
  nextCursor: v.optional(v.string()),
});

export const detail = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    kind: kindValidator,
    cursor: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({ state: v.literal("BLOCKED"), lenderReturn: v.optional(lenderReturnOptionsValidator) }),
    v.object({
      state: v.literal("AVAILABLE"), handoverAt: v.number(), economicsStamp: v.string(),
      options: v.array(optionValidator), nextCursor: v.optional(v.string()),
    }),
    v.object({
      state: v.literal("AVAILABLE_BEFORE_HANDOVER"), updatedAt: v.number(), economicsStamp: v.string(),
      requiresLenderConfirmation: v.optional(v.literal(true)),
      showroomRefund: v.optional(v.object({ ...refundDisplayFields, stamp: v.string() })),
      options: v.array(optionValidator), nextCursor: v.optional(v.string()),
    }),
    v.object({
      state: v.literal("PENDING"), correctionId: v.id("deliveredDealIdentityCorrections"),
      kind: kindValidator, label: v.string(), handoverAt: v.number(), reason: v.string(),
      canApprove: v.boolean(), canWithdraw: v.boolean(),
    }),
    v.object({
      state: v.literal("APPROVED"), kind: kindValidator,
      handoverAt: v.number(), returnedAt: v.number(), returnReference: v.string(),
    }),
  ),
  handler: async (ctx, { orgId, applicationId, kind, cursor }) => {
    let auth: Awaited<ReturnType<typeof requireTenantAuth>>;
    try {
      auth = await requireTenantAuth(ctx, orgId, IDENTITY_CORRECTION_PERMISSIONS);
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      return null;
    }
    if (auth.membership.impersonationGrantId) return null;
    const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
    const agreement = identityAgreement(app);
    const beforeHandover = !agreement && auth.user._id !== app.salespersonId && canCorrectIdentityBeforeHandover(app);
    if (app.pendingIdentityCorrectionId !== undefined) {
      const correction = await ctx.db.get(app.pendingIdentityCorrectionId);
      if (!correction || correction.orgId !== orgId || correction.applicationId !== applicationId ||
          correction.status !== "PENDING") return null;
      const [buyer, vehicle] = await Promise.all([
        ctx.db.get(correction.replacementCustomerId), ctx.db.get(correction.replacementVehicleId),
      ]);
      if (buyer?.orgId !== orgId || vehicle?.orgId !== orgId) return null;
      return {
        state: "PENDING" as const, correctionId: correction._id, kind: correction.kind,
        label: labelForIdentity(correction.kind, buyer, vehicle), reason: correction.reason, handoverAt: correction.handoverAt,
        canApprove: Boolean(agreement && economicsStamp(app) === correction.economicsStamp &&
          auth.user._id !== correction.requestedBy && auth.user._id !== app.salespersonId),
        canWithdraw: true,
      };
    }
    if (!agreement && !beforeHandover) {
      const previous = await ctx.db.query("deliveredDealIdentityCorrections")
        .withIndex("by_org_application_status", (q) =>
          q.eq("orgId", orgId).eq("applicationId", applicationId).eq("status", "APPROVED"))
        .order("desc").first();
      if (previous?.status !== "APPROVED" || previous.returnedAt === undefined || !previous.returnReference) return null;
      return { state: "APPROVED" as const, kind: previous.kind, handoverAt: previous.handoverAt,
        returnedAt: previous.returnedAt, returnReference: previous.returnReference };
    }
    let originalDeal: Awaited<ReturnType<typeof readOriginalIdentityDeal>>;
    let originalReceipt: Awaited<ReturnType<typeof readPreHandoverIdentityDealForLenderReturn>>["receipt"] = null;
    let showroomRefund: Awaited<ReturnType<typeof readPreHandoverIdentityDealForLenderReturn>>["showroomRefund"] = undefined;
    try {
      if (beforeHandover && canVerifyIdentityCorrectionLenderReturn(auth.role)) {
        const candidate = await readPreHandoverIdentityDealForLenderReturn(ctx, app);
        originalDeal = candidate.deal;
        originalReceipt = candidate.receipt;
        showroomRefund = candidate.showroomRefund;
      } else {
        originalDeal = await readOriginalIdentityDeal(ctx, app);
      }
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      return { state: "BLOCKED" as const };
    }
    const optionPage = { economicsStamp: economicsStamp(app), ...await replacementIdentityOptions(ctx, app, kind, cursor, originalDeal) };
    if (originalReceipt) {
      return {
        state: "BLOCKED" as const,
        lenderReturn: {
          ...optionPage,
          updatedAt: app.updatedAt,
          ...summarizeIdentityLenderReturn(originalReceipt, showroomRefund),
          ...(requiresLenderConfirmation(app) ? { requiresLenderConfirmation: true as const } : {}),
        },
      };
    }
    return agreement
      ? { state: "AVAILABLE" as const, handoverAt: agreement.handoverAt, ...optionPage }
      : {
          state: "AVAILABLE_BEFORE_HANDOVER" as const, updatedAt: app.updatedAt, ...optionPage,
          ...(requiresLenderConfirmation(app) ? { requiresLenderConfirmation: true as const } : {}),
          ...(showroomRefund ? {
            showroomRefund: {
              amountMinor: showroomRefund.amountMinor,
              refundedAt: showroomRefund.refundedAt,
              stamp: cashRefundProofStamp(showroomRefund),
            },
          } : {}),
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
  returns: v.id("deliveredDealIdentityCorrections"),
  handler: async (ctx, args) => {
    const { orgId, applicationId, replacementQuoteId, expectedHandoverAt, expectedEconomicsStamp } = args;
    const { user, membership } = await requireTenantAuth(ctx, orgId, IDENTITY_CORRECTION_PERMISSIONS);
    if (membership.impersonationGrantId) throw new ConvexError("End impersonation before requesting a correction.");
    const reason = requiredCorrectionText(args.reason);
    return await runWithIdempotency(ctx, {
      orgId, actorId: user._id, operation: "deliveredDealIdentityCorrections.request",
      economic: true, idempotencyKey: args.idempotencyKey,
      fingerprint: JSON.stringify([applicationId, replacementQuoteId, expectedHandoverAt, expectedEconomicsStamp, reason]),
    }, async () => {
      const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
      const quote = await requireOwnedRow(ctx, orgId, "quotes", replacementQuoteId);
      const agreement = identityAgreement(app);
      assertExpectedEconomicsStamp(app, expectedEconomicsStamp, true);
      if (!agreement || agreement.handoverAt !== expectedHandoverAt || app.pendingIdentityCorrectionId !== undefined) {
        throw new ConvexError("Review the delivered deal before requesting this correction.");
      }
      const { kind, customer, vehicle } = await verifySubstitution(ctx, app, quote, await readOriginalIdentityDeal(ctx, app));
      const now = Date.now();
      const correctionId = await ctx.db.insert("deliveredDealIdentityCorrections", {
        orgId, applicationId, status: "PENDING", kind, originalQuoteId: app.quoteId, replacementQuoteId,
        originalCustomerId: app.customerId, replacementCustomerId: customer._id,
        originalVehicleId: app.vehicleId, replacementVehicleId: vehicle._id,
        handoverAt: agreement.handoverAt, handoverBy: agreement.handoverBy, handoverNotes: app.vehicleHandoverNotes,
        economicsStamp: expectedEconomicsStamp, reason, requestedBy: user._id, requestedAt: now,
      });
      await ctx.db.patch(app._id, { pendingIdentityCorrectionId: correctionId, updatedAt: now });
      return correctionId;
    });
  },
});

export const approve = mutation({
  args: {
    orgId: v.id("organizations"),
    correctionId: v.id("deliveredDealIdentityCorrections"),
    returnedAt: v.number(),
    returnReference: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.id("financeApplications"),
  handler: async (ctx, args) => {
    const { orgId, correctionId, returnedAt } = args;
    const { user, membership } = await requireTenantAuth(ctx, orgId, IDENTITY_CORRECTION_PERMISSIONS);
    if (membership.impersonationGrantId) throw new ConvexError("End impersonation before approving a correction.");
    const reference = requiredCorrectionText(args.returnReference);
    return await runWithIdempotency(ctx, {
      orgId, actorId: user._id, operation: "deliveredDealIdentityCorrections.approve",
      economic: true, idempotencyKey: args.idempotencyKey,
      fingerprint: JSON.stringify([correctionId, returnedAt, reference]),
    }, async () => {
      const correction = await requireOwnedRow(ctx, orgId, "deliveredDealIdentityCorrections", correctionId);
      if (correction.status === "APPLIED_BEFORE_HANDOVER") {
        throw new ConvexError("This correction has already been applied.");
      }
      const app = await requireOwnedRow(ctx, orgId, "financeApplications", correction.applicationId);
      if (user._id === correction.requestedBy || user._id === app.salespersonId) {
        throw new ConvexError("An independent finance approver must verify the return and approve the correction.");
      }
      const agreement = identityAgreement(app);
      assertExpectedEconomicsStamp(app, correction.economicsStamp, true);
      if (!agreement || correction.status !== "PENDING" || app.pendingIdentityCorrectionId !== correctionId ||
          app.quoteId !== correction.originalQuoteId || app.customerId !== correction.originalCustomerId ||
          app.vehicleId !== correction.originalVehicleId || agreement.handoverAt !== correction.handoverAt ||
          agreement.handoverBy !== correction.handoverBy || app.vehicleHandoverNotes !== correction.handoverNotes) {
        throw new ConvexError("The deal changed since this correction was requested.");
      }
      const now = Date.now();
      if (!Number.isSafeInteger(returnedAt) || returnedAt < agreement.handoverAt || returnedAt > now) {
        throw new ConvexError("Enter the actual return time between the original handover and now.");
      }
      const quote = await requireOwnedRow(ctx, orgId, "quotes", correction.replacementQuoteId);
      const terms = await verifySubstitution(ctx, app, quote, await readOriginalIdentityDeal(ctx, app));
      if (terms.kind !== correction.kind || terms.customer._id !== correction.replacementCustomerId ||
          terms.vehicle._id !== correction.replacementVehicleId) {
        throw new ConvexError("The replacement buyer or vehicle changed. Request a new correction.");
      }
      const replacement = await replacementIdentityPatch(ctx, quote, terms);

      await retireOriginalCommitment(ctx, {
        app, root: terms.root, replacementVehicleId: terms.vehicle._id, actor: user._id, now,
      });
      await archiveIdentityEvidence(ctx, app, now);
      await adoptReplacementCommercialQuote(ctx, { now, identity: terms.identity });
      await ctx.db.patch(app._id, {
        ...clearedIdentityEvidence(),
        ...replacement,
        status: "PENDING_DOCS", creditDecision: "SUBMITTED", appraisalStatus: "NOT_REQUESTED",
        settlementStatus: "NOT_READY", handoverStatus: "BLOCKED",
        pendingIdentityCorrectionId: undefined, approvedIdentityCorrectionId: correctionId,
        economicsRevision: (app.economicsRevision ?? 0) + 1,
        updatedAt: now,
      });
      const replacementRootId = await commitReplacementVehicle(ctx, {
        app, quote, vehicle: terms.vehicle, actor: user._id, originalWasDelivered: true,
      });
      await ctx.db.patch(correction._id, {
        status: "APPROVED", resolvedBy: user._id, resolvedAt: now, returnedAt, returnReference: reference,
        retiredRootId: terms.root._id, replacementRootId,
        originalApproval: {
          amountMinor: agreement.amountMinor, approvedAt: app.approvedPurchaseApprovedAt,
          approvedBy: app.approvedPurchaseApprovedBy, basis: app.approvedPurchaseBasis,
          appraisalId: app.approvedPurchaseAppraisalId, notes: app.approvedPurchaseNotes,
          exceptionRuleVersion: app.approvedPurchaseExceptionRuleVersion,
          quotationMinor: app.submittedQuotationMinor, quotationAt: app.submittedQuotationAt,
          quotationBy: app.submittedQuotationBy, quotationSnapshot: app.quotationCalculationSnapshot,
          quotationSource: app.submittedQuotationSource, quotationOverrideReason: app.submittedQuotationOverrideReason,
          appliedLtvPercent: app.appliedLtvPercent, companyRuleVersionId: app.companyRuleVersionId,
          purchaseCorrectedAt: app.approvedPurchaseCorrectedAfterHandoverAt,
          underwritingSnapshot: app.underwritingSnapshot,
        },
      });
      await ctx.db.insert("applicationStatusLog", {
        orgId, applicationId: app._id, fromStatus: app.status, toStatus: "PENDING_DOCS",
        changedBy: user._id, changedAt: now,
        note: "Deal identity correction approved. Obtain fresh evidence before the replacement handover.",
      });
      return app._id;
    });
  },
});

export const withdraw = mutation({
  args: {
    orgId: v.id("organizations"),
    correctionId: v.id("deliveredDealIdentityCorrections"),
  },
  returns: v.null(),
  handler: async (ctx, { orgId, correctionId }) => {
    const { user, membership } = await requireTenantAuth(ctx, orgId, IDENTITY_CORRECTION_PERMISSIONS);
    if (membership.impersonationGrantId) throw new ConvexError("End impersonation before withdrawing a correction.");
    const correction = await requireOwnedRow(ctx, orgId, "deliveredDealIdentityCorrections", correctionId);
    const app = await requireOwnedRow(ctx, orgId, "financeApplications", correction.applicationId);
    if (correction.status === "WITHDRAWN" && app.pendingIdentityCorrectionId !== correctionId) return null;
    if (correction.status !== "PENDING" || app.pendingIdentityCorrectionId !== correctionId) {
      throw new ConvexError("This correction is no longer awaiting a decision.");
    }
    const now = Date.now();
    await ctx.db.patch(correctionId, { status: "WITHDRAWN", resolvedBy: user._id, resolvedAt: now });
    await ctx.db.patch(app._id, { pendingIdentityCorrectionId: undefined, updatedAt: now });
    return null;
  },
});
