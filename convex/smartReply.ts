import { v, ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { requireOwner } from "./utils/tenancy";

/**
 * Saves Smart Reply config — the rule-based price/financing/availability/
 * vehicleInfo/location auto-answer feature. A single mutation covers both
 * platforms' enable flags plus the shared fields (financing mode, default
 * down payment / finance company, visibility) since those settings apply
 * identically to Instagram and Facebook; two separate per-platform setters
 * would risk a last-write-wins conflict on the shared fields. Owner-only,
 * same gating as the other social integration settings.
 */
export const setSmartReplyConfig = mutation({
  args: {
    orgId: v.id("organizations"),
    instagramEnabled: v.boolean(),
    facebookEnabled: v.boolean(),
    financingMode: v.union(v.literal("calculated"), v.literal("generic")),
    defaultDownPaymentPercent: v.optional(v.number()),
    defaultFinanceCompanyId: v.optional(v.id("financeCompanies")),
    visibility: v.union(v.literal("public"), v.literal("dm")),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    if (
      args.defaultDownPaymentPercent !== undefined &&
      (args.defaultDownPaymentPercent < 0 || args.defaultDownPaymentPercent >= 100)
    ) {
      throw new ConvexError("Down payment percent must be between 0 and 100.");
    }
    if (args.financingMode === "calculated" && !args.defaultFinanceCompanyId) {
      throw new ConvexError("Select a finance company before enabling calculated financing estimates.");
    }

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings) {
      throw new ConvexError("Connect Instagram or Facebook before configuring Smart Reply.");
    }

    await ctx.db.patch(settings._id, {
      instagramSmartReplyEnabled: args.instagramEnabled,
      facebookSmartReplyEnabled: args.facebookEnabled,
      smartReplyFinancingMode: args.financingMode,
      smartReplyDefaultDownPaymentPercent: args.defaultDownPaymentPercent,
      smartReplyDefaultFinanceCompanyId: args.defaultFinanceCompanyId,
      smartReplyVisibility: args.visibility,
    });
  },
});
