import { ConvexError, v } from "convex/values";
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
    idempotencyKey: v.string(),
  },
  returns: v.id("financeApplications"),
  handler: async (ctx, args) => {
    const { orgId, applicationId, replacementQuoteId, expectedEconomicsStamp, expectedUpdatedAt } = args;
    const { user, membership } = await requireTenantAuth(ctx, orgId, IDENTITY_CORRECTION_PERMISSIONS);
    if (membership.impersonationGrantId) throw new ConvexError("End impersonation before approving a correction.");
    const reason = requiredCorrectionText(args.reason);
    return await runWithIdempotency(ctx, {
      orgId, actorId: user._id, operation: "financeIdentityBeforeHandover.applyCorrection",
      economic: true, idempotencyKey: args.idempotencyKey,
      fingerprint: JSON.stringify([applicationId, replacementQuoteId, expectedEconomicsStamp, expectedUpdatedAt, reason]),
    }, async () => {
      const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
      const quote = await requireOwnedRow(ctx, orgId, "quotes", replacementQuoteId);
      if (user._id === app.salespersonId) throw new ConvexError("An independent finance approver must apply the correction.");
      if (!canCorrectIdentityBeforeHandover(app)) {
        throw new ConvexError("Only an eligible deal awaiting documents or credit review can be corrected before handover.");
      }
      assertExpectedEconomicsStamp(app, expectedEconomicsStamp, true);
      if (app.updatedAt !== expectedUpdatedAt) throwStaleDealCorrection("This deal changed. Open the correction again.");
      const terms = await verifySubstitution(ctx, app, quote, await readOriginalIdentityDeal(ctx, app));
      const replacement = await replacementIdentityPatch(ctx, quote, terms);
      const now = Date.now();
      await retireOriginalCommitment(ctx, { app, root: terms.root, replacementVehicleId: replacement.vehicleId, actor: user._id, now });
      await archiveIdentityEvidence(ctx, app, now);
      await adoptReplacementCommercialQuote(ctx, { now, identity: terms.identity });
      await ctx.db.patch(app._id, {
        ...clearedIdentityEvidence(),
        ...replacement,
        status: "PENDING_DOCS",
        creditDecision: "SUBMITTED",
        economicsRevision: (app.economicsRevision ?? 0) + 1,
        updatedAt: now,
      });
      const replacementRootId = await commitReplacementVehicle(ctx, {
        app, quote, vehicle: terms.vehicle, actor: user._id, originalWasDelivered: false,
      });
      await writeAuditLog(ctx, user, {
        orgId, action: "CORRECT_FINANCE_IDENTITY_BEFORE_HANDOVER", targetTable: "financeApplications", targetId: app._id,
        before: { quoteId: app.quoteId, customerId: app.customerId, vehicleId: app.vehicleId, rootId: terms.root._id },
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
