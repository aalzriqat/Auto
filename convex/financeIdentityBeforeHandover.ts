import { ConvexError, v } from "convex/values";
import type { Value } from "convex/values";
import { mutation } from "./functions";
import { writeAuditLog } from "./utils/auditLog";
import {
  archiveIdentityEvidence,
  canCorrectIdentityBeforeHandover,
  clearedIdentityEvidence,
  commitReplacementVehicle,
  IDENTITY_CORRECTION_PERMISSIONS,
  readOriginalIdentityDeal,
  replacementIdentityPatch,
  requiredCorrectionText,
  retireOriginalCommitment,
  verifySubstitution,
} from "./utils/deliveredDealIdentityCorrection";
import { assertExpectedEconomicsStamp, throwStaleDealCorrection } from "./utils/financeCorrectionState";
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
    idempotencyKey: v.string(),
  },
  returns: v.id("financeApplications"),
  handler: async (ctx, args) => {
    const { orgId, applicationId, replacementQuoteId, expectedEconomicsStamp, expectedUpdatedAt } = args;
    const { user, membership } = await requireTenantAuth(ctx, orgId, IDENTITY_CORRECTION_PERMISSIONS);
    if (membership.impersonationGrantId) throw new ConvexError("End impersonation before approving a correction.");
    const reason = requiredCorrectionText(args.reason);
    const lenderConfirmationReference = args.lenderConfirmationReference?.trim();
    if (lenderConfirmationReference !== undefined && (!lenderConfirmationReference || lenderConfirmationReference.length > 160)) {
      throw new ConvexError("Enter the financing company's confirmation reference using up to 160 characters.");
    }
    return await runWithIdempotency(ctx, {
      orgId, actorId: user._id, operation: "financeIdentityBeforeHandover.applyCorrection",
      economic: true, idempotencyKey: args.idempotencyKey,
      fingerprint: JSON.stringify([
        applicationId, replacementQuoteId, expectedEconomicsStamp, expectedUpdatedAt, reason,
        ...(lenderConfirmationReference === undefined ? [] : [lenderConfirmationReference]),
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
      if (app.submittedQuotationMinor !== undefined && !lenderConfirmationReference) {
        throw new ConvexError("Enter the financing company's confirmation reference before replacing the recorded terms.");
      }
      const terms = await verifySubstitution(ctx, app, quote, await readOriginalIdentityDeal(ctx, app));
      const replacement = await replacementIdentityPatch(ctx, quote, terms);
      const now = Date.now();
      const applicationPatch = {
        ...clearedIdentityEvidence(),
        ...replacement,
        status: "PENDING_DOCS" as const,
        creditDecision: "SUBMITTED" as const,
        appraisalStatus: "NOT_REQUESTED" as const,
        handoverStatus: "BLOCKED" as const,
        economicsRevision: (app.economicsRevision ?? 0) + 1,
        updatedAt: now,
      };
      const originalValues: Record<string, Value> = {};
      for (const key of [...Object.keys(applicationPatch), "currentCommitmentClaims"]) {
        const value = app[key as keyof typeof app];
        if (value !== undefined) originalValues[key] = value;
      }
      await retireOriginalCommitment(ctx, { app, root: terms.root, replacementVehicleId: replacement.vehicleId, actor: user._id, now });
      await archiveIdentityEvidence(ctx, app, now);
      await adoptReplacementCommercialQuote(ctx, { now, identity: terms.identity });
      await ctx.db.patch(app._id, applicationPatch);
      const replacementRootId = await commitReplacementVehicle(ctx, {
        app, quote, vehicle: terms.vehicle, actor: user._id, originalWasDelivered: false,
      });
      await ctx.db.insert("deliveredDealIdentityCorrections", {
        orgId, applicationId, status: "APPLIED_BEFORE_HANDOVER", kind: terms.kind,
        originalQuoteId: app.quoteId, replacementQuoteId: replacement.quoteId,
        resolvedBy: user._id, resolvedAt: now, reason,
        ...(lenderConfirmationReference === undefined ? {} : { lenderConfirmationReference }),
        retiredRootId: terms.root._id, replacementRootId, originalValues,
      });
      await writeAuditLog(ctx, user, {
        orgId, action: "CORRECT_FINANCE_IDENTITY_BEFORE_HANDOVER", targetTable: "financeApplications", targetId: app._id,
        before: {
          quoteId: app.quoteId, customerId: app.customerId, vehicleId: app.vehicleId, rootId: terms.root._id,
          ...(app.approvedAt === undefined || app.approvedBy === undefined
            ? {} : { creditApproval: { approvedAt: app.approvedAt, approvedBy: app.approvedBy } }),
        },
        after: {
          quoteId: replacement.quoteId, customerId: replacement.customerId, vehicleId: replacement.vehicleId,
          rootId: replacementRootId, reason,
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
