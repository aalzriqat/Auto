import { internalMutation } from "./_generated/server";

/**
 * Maps legacy marketplace requests still holding the pre-R1b FULFILLED status
 * onto its replacement OFFERS_RECEIVED — a fulfilling dealer reply used to set
 * FULFILLED directly; now it sets OFFERS_RECEIVED, with ACCEPTED/COMPLETED
 * reserved for buyer actions. Safe to re-run; rows already migrated are
 * skipped. Run once against prod after this deploys:
 *   npx convex run migrateMarketplaceStatuses:backfill --prod
 */
export const backfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const legacy = await ctx.db
      .query("marketplaceRequests")
      .withIndex("by_status", (q) => q.eq("status", "FULFILLED"))
      .collect();
    for (const request of legacy) {
      await ctx.db.patch(request._id, { status: "OFFERS_RECEIVED" });
    }
    return `Migrated ${legacy.length} FULFILLED requests to OFFERS_RECEIVED`;
  },
});
