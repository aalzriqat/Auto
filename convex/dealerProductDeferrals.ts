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
    // Lexicographic comparison is safe for "YYYY-MM" strings. Equality alone
    // (the old check) only blocked re-running the *same* month — it let a
    // stale/earlier month slip through as a genuine second posting (its
    // idempotency key differs from any month already posted), silently
    // over-recognizing revenue.
    if (deferral.lastRecognizedYearMonth && args.yearMonth <= deferral.lastRecognizedYearMonth) {
      return { posted: false, reason: "not_after_last_recognized_month" };
    }

    const remaining = deferral.totalMarginMinor - deferral.recognizedMinor;
    if (remaining <= 0) return { posted: false, reason: "fully_recognized" };

    // Explicit month-count schedule: the (termMonths)th month always absorbs
    // whatever remains, so the deferral finishes in exactly termMonths
    // (never termMonths+1, which Math.floor's remainder could previously
    // require) regardless of rounding. Earlier months recognize a ceil'd
    // flat share so the schedule never has to overshoot to catch up.
    const monthsRecognized = deferral.monthsRecognized ?? 0;
    const isFinalContractualMonth = monthsRecognized + 1 >= deferral.termMonths;
    const flatMonthlyAmount = Math.ceil(deferral.totalMarginMinor / deferral.termMonths);
    const amountMinor = isFinalContractualMonth ? remaining : Math.min(flatMonthlyAmount, remaining);

    const newRecognizedMinor = deferral.recognizedMinor + amountMinor;
    await ctx.db.patch(args.deferralId, {
      recognizedMinor: newRecognizedMinor,
      monthsRecognized: monthsRecognized + 1,
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
