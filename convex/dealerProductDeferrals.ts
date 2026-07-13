/**
 * dealerProductDeferrals.ts
 *
 * GL Phase 19: the dealer's margin on a resold warranty/GAP product is
 * deferred at sale (see ruleSaleCompleted) and recognized ratably over the
 * product's term — one row per product per sale. Recognition itself is
 * driven by crons.ts's monthly fi-commission-recognition job, which mirrors
 * fixedAssets.ts's depreciation cron exactly (paginated query here +
 * recognizeDeferredCommissionForMonth, same idempotent-per-yearMonth shape).
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { hookFiCommissionRecognized } from "./accounting/workflowHooks";

/** Not org-scoped: the monthly cron runs across every tenant, same reasoning as listActiveAssetsForDepreciation. */
export const listActiveDeferralsForRecognition = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dealerProductDeferrals")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
  },
});

export const recognizeDeferredCommissionForMonth = internalMutation({
  args: {
    orgId: v.id("organizations"),
    deferralId: v.id("dealerProductDeferrals"),
    yearMonth: v.string(), // "YYYY-MM"
    occurredAt: v.number(),
    systemActorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const deferral = await ctx.db.get(args.deferralId);
    if (!deferral || deferral.orgId !== args.orgId) return { posted: false, reason: "not_found" };
    if (deferral.status !== "ACTIVE") return { posted: false, reason: "not_active" };
    if (deferral.lastRecognizedYearMonth === args.yearMonth) return { posted: false, reason: "already_ran_this_month" };

    const remaining = deferral.totalMarginMinor - deferral.recognizedMinor;
    if (remaining <= 0) return { posted: false, reason: "fully_recognized" };

    // Straight-line, same rounding-remainder handling as fixed-asset
    // depreciation: never less than 1 minor unit/month, final month absorbs
    // whatever's left so recognizedMinor never overshoots totalMarginMinor.
    const flatMonthlyAmount = Math.floor(deferral.totalMarginMinor / deferral.termMonths);
    const amountMinor = Math.min(Math.max(flatMonthlyAmount, 1), remaining);

    const newRecognizedMinor = deferral.recognizedMinor + amountMinor;
    await ctx.db.patch(args.deferralId, {
      recognizedMinor: newRecognizedMinor,
      lastRecognizedYearMonth: args.yearMonth,
      status: newRecognizedMinor >= deferral.totalMarginMinor ? "FULLY_RECOGNIZED" : "ACTIVE",
    });

    await hookFiCommissionRecognized(ctx, {
      orgId: args.orgId,
      deferralId: args.deferralId,
      yearMonth: args.yearMonth,
      amountMinor,
      currency: deferral.currency,
      actorId: args.systemActorId,
      occurredAt: args.occurredAt,
    });

    return { posted: true, amountMinor };
  },
});
