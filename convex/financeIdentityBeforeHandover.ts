import { ConvexError, v } from "convex/values";
import type { Value } from "convex/values";
import { mutation } from "./functions";
import { writeAuditLog } from "./utils/auditLog";
import { reserveReceiptIdentity, validatedReference } from "./utils/customerFinanceCompanyPayments";
import {
  archiveIdentityEvidence,
  canCorrectIdentityBeforeHandover,
  canVerifyIdentityCorrectionLenderReturn,
  clearedIdentityEvidence,
  commitReplacementVehicle,
  IDENTITY_CORRECTION_PERMISSIONS,
  readOriginalIdentityDeal,
  readPreHandoverIdentityDealForLenderReturn,
  replacementIdentityPatch,
  requiredCorrectionText,
  requiresLenderConfirmation,
  retireOriginalCommitment,
  verifySubstitution,
} from "./utils/deliveredDealIdentityCorrection";
import { assertExpectedEconomicsStamp, throwStaleDealCorrection } from "./utils/financeCorrectionState";
import { identityCorrectionReceiptStamp } from "./utils/identityCorrectionShowroomRefund";
import { runWithIdempotency } from "./utils/idempotency";
import { adoptReplacementCommercialQuote } from "./utils/quotedCommercialDeal";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

export const applyCorrection = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    replacementQuoteId: v.id("quotes"),
    expectedEconomicsStamp: v.string(),
    expectedUpdatedAt: v.number(),
    reason: v.string(),
    lenderConfirmationReference: v.optional(v.string()),
    lenderReturn: v.optional(v.object({
      paymentId: v.id("customerFinanceCompanyPayments"),
      receiptStamp: v.string(),
      reference: v.string(),
      refundedAt: v.number(),
      amountMinor: v.number(),
      verifiedSamePayer: v.literal(true),
    })),
    idempotencyKey: v.string(),
  },
  returns: v.id("financeApplications"),
  handler: async (ctx, args) => {
    const { orgId, applicationId, replacementQuoteId, expectedEconomicsStamp, expectedUpdatedAt } = args;
    const { user, membership, role } = await requireTenantAuth(ctx, orgId, IDENTITY_CORRECTION_PERMISSIONS);
    if (membership.impersonationGrantId) throw new ConvexError("End impersonation before approving a correction.");
    const reason = requiredCorrectionText(args.reason);
    const lenderConfirmationReference = args.lenderConfirmationReference?.trim();
    if (lenderConfirmationReference !== undefined && (!lenderConfirmationReference || lenderConfirmationReference.length > 160)) {
      throw new ConvexError("Enter the financing company's confirmation reference using up to 160 characters.");
    }
    const returnInput = args.lenderReturn;
    const mayVerifyReturn = canVerifyIdentityCorrectionLenderReturn(role);
    if (returnInput && !mayVerifyReturn) {
      throw new ConvexError("Ask a finance approver who can verify lender payments to apply this correction.");
    }
    return await runWithIdempotency(ctx, {
      orgId, actorId: user._id, operation: "financeIdentityBeforeHandover.applyCorrection",
      economic: true, idempotencyKey: args.idempotencyKey,
      fingerprint: JSON.stringify([
        applicationId, replacementQuoteId, expectedEconomicsStamp, expectedUpdatedAt, reason,
        ...(lenderConfirmationReference === undefined ? [] : [lenderConfirmationReference]),
        ...(returnInput === undefined ? [] : [returnInput]),
      ]),
    }, async () => {
      const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
      const quote = await requireOwnedRow(ctx, orgId, "quotes", replacementQuoteId);
      if (user._id === app.salespersonId) throw new ConvexError("An independent finance approver must apply the correction.");
      if (!canCorrectIdentityBeforeHandover(app)) {
        throw new ConvexError("Only eligible pre-handover deals can be corrected here.");
      }
      assertExpectedEconomicsStamp(app, expectedEconomicsStamp, true);
      if (app.updatedAt !== expectedUpdatedAt) throwStaleDealCorrection("This deal changed. Open the correction again.");
      const hasRecordedTerms = requiresLenderConfirmation(app);
      if (hasRecordedTerms && !lenderConfirmationReference) {
        throw new ConvexError("Enter the financing company's confirmation reference before replacing the recorded terms.");
      }
      if (!hasRecordedTerms && lenderConfirmationReference !== undefined) {
        throw new ConvexError("This deal has no recorded financing terms to withdraw.");
      }
      const original = mayVerifyReturn
        ? await readPreHandoverIdentityDealForLenderReturn(ctx, app)
        : { deal: await readOriginalIdentityDeal(ctx, app), receipt: null, showroomRefund: undefined };
      const returnEvidence = returnInput && await requireOwnedRow(
        ctx, orgId, "customerFinanceCompanyPayments", returnInput.paymentId,
      );
      if (original.receipt && !returnInput) {
        throw new ConvexError("Review the deal’s existing payment records and confirm that the lender returned the full amount on the original receipt.");
      }
      if (returnInput && (!original.receipt || !returnEvidence ||
          returnEvidence._id !== original.receipt._id || returnEvidence.applicationId !== app._id ||
          returnInput.receiptStamp !== identityCorrectionReceiptStamp(returnEvidence, original.showroomRefund))) {
        throwStaleDealCorrection("The original first-payment evidence changed. Reopen the correction.");
      }
      const terms = await verifySubstitution(ctx, app, quote, original.deal);
      const replacement = await replacementIdentityPatch(ctx, quote, terms);
      const now = Date.now();
      let returnProof: { reference: string; normalizedReference: string } | undefined;
      if (returnInput && returnEvidence) {
        if (returnInput.amountMinor !== returnEvidence.amountMinor) {
          throw new ConvexError("Confirm a full lender refund of the amount on the original receipt.");
        }
        const { refundedAt } = returnInput;
        if (!Number.isSafeInteger(refundedAt) || refundedAt < returnEvidence.paidAt || refundedAt > now) {
          throw new ConvexError({
            code: "LENDER_REFUND_TIME",
            message: "Enter the real date and time of the lender refund, from the original receipt through now.",
          });
        }
        const reference = validatedReference({
          reference: returnInput.reference, amountMinor: returnInput.amountMinor, paidAt: returnInput.refundedAt,
        });
        const { normalizedReference } = await reserveReceiptIdentity(ctx, app, reference, { kind: "FIRST_PAYMENT" });
        returnProof = { reference, normalizedReference };
      }
      const applicationPatch = {
        ...clearedIdentityEvidence(),
        ...replacement,
        status: "PENDING_DOCS" as const,
        creditDecision: "SUBMITTED" as const,
        appraisalStatus: "NOT_REQUESTED" as const,
        handoverStatus: "BLOCKED" as const,
        ...(hasRecordedTerms || app.identityFinanceTermsRequiredSince !== undefined
          ? { identityFinanceTermsRequiredSince: now }
          : {}),
        ...(returnProof || app.identityLenderReturnCorrectionAt !== undefined ? { identityLenderReturnCorrectionAt: now } : {}),
        economicsRevision: (app.economicsRevision ?? 0) + 1,
        updatedAt: now,
      };
      const originalValues: Record<string, Value> = {};
      for (const key of [...Object.keys(applicationPatch), "currentCommitmentClaims"]) {
        const value = app[key as keyof typeof app];
        if (value !== undefined) originalValues[key] = value;
      }
      await retireOriginalCommitment(ctx, {
        app, root: terms.root, replacementVehicleId: replacement.vehicleId, actor: user._id, now,
        showroomRefund: original.showroomRefund,
      });
      await archiveIdentityEvidence(ctx, app, now);
      await adoptReplacementCommercialQuote(ctx, { now, identity: terms.identity });
      await ctx.db.patch(app._id, applicationPatch);
      const replacementRootId = await commitReplacementVehicle(ctx, {
        app, quote, vehicle: terms.vehicle, actor: user._id, originalWasDelivered: false,
      });
      const correctionId = await ctx.db.insert("deliveredDealIdentityCorrections", {
        orgId, applicationId, status: "APPLIED_BEFORE_HANDOVER", kind: terms.kind,
        originalQuoteId: app.quoteId, replacementQuoteId: replacement.quoteId,
        resolvedBy: user._id, resolvedAt: now, reason,
        ...(lenderConfirmationReference === undefined ? {} : { lenderConfirmationReference }),
        ...(returnProof && returnEvidence ? { returnedDirectFirstPaymentId: returnEvidence._id } : {}),
        ...(original.showroomRefund ? { returnedShowroomDepositId: original.showroomRefund.depositId } : {}),
        retiredRootId: terms.root._id, replacementRootId, originalValues,
      });
      if (returnInput && returnEvidence && returnProof) {
        await ctx.db.patch(returnEvidence._id, {
          status: "VOIDED",
          voidedAt: now,
          voidedBy: user._id,
          voidReason: reason,
          lenderReturn: {
            ...returnProof,
            refundedAt: returnInput.refundedAt,
            amountMinor: returnInput.amountMinor,
            originalCustomerId: app.customerId,
            verifiedSamePayer: returnInput.verifiedSamePayer,
          },
        });
      }
      await writeAuditLog(ctx, user, {
        orgId, action: "CORRECT_FINANCE_IDENTITY_BEFORE_HANDOVER", targetTable: "financeApplications", targetId: app._id,
        before: {
          quoteId: app.quoteId, customerId: app.customerId, vehicleId: app.vehicleId, rootId: terms.root._id,
          ...(app.approvedAt === undefined || app.approvedBy === undefined
            ? {} : { creditApproval: { approvedAt: app.approvedAt, approvedBy: app.approvedBy } }),
        },
        after: {
          quoteId: replacement.quoteId, customerId: replacement.customerId, vehicleId: replacement.vehicleId,
          rootId: replacementRootId, correctionId, reason,
        },
      });
      await ctx.db.insert("applicationStatusLog", {
        orgId, applicationId: app._id, fromStatus: app.status, toStatus: "PENDING_DOCS",
        changedBy: user._id, changedAt: now, note: "Buyer or vehicle corrected before handover. Obtain fresh finance evidence.",
      });
      return app._id;
    });
  },
});
