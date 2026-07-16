import { internalMutation } from "./_generated/server";

/**
 * Assigns a Request Room token to marketplace requests created before
 * publicId existed. Safe to re-run; rows that already have one are skipped.
 * Run once against prod after deploy:
 *   npx convex run migrateMarketplacePublicIds:backfillMarketplacePublicIds --prod
 */
export const backfillMarketplacePublicIds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const requests = await ctx.db.query("marketplaceRequests").collect();
    let patched = 0;
    for (const request of requests) {
      if (request.publicId) continue;
      await ctx.db.patch(request._id, { publicId: crypto.randomUUID().replace(/-/g, "") });
      patched += 1;
    }
    return `Assigned publicIds to ${patched} of ${requests.length} marketplace requests`;
  },
});
