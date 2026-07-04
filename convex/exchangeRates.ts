/**
 * GL Phase 14 — org-defined exchange rates.
 *
 * Rates exist purely so reports can offer translated display figures; the
 * ledger itself never converts. Rates are append-only points in time — a new
 * rate for the same pair supersedes older ones by asOfDate, and reports pick
 * the latest rate at or before their reporting date.
 */
import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const setRate = mutation({
  args: {
    orgId: v.id("organizations"),
    fromCurrency: v.string(),
    toCurrency: v.string(),
    rate: v.number(),
    asOfDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const fromCurrency = args.fromCurrency.toUpperCase();
    const toCurrency = args.toCurrency.toUpperCase();
    if (fromCurrency === toCurrency) {
      throw new ConvexError("From and to currencies must differ.");
    }
    if (!Number.isFinite(args.rate) || args.rate <= 0) {
      throw new ConvexError("Rate must be a positive number.");
    }

    return await ctx.db.insert("exchangeRates", {
      orgId: args.orgId,
      fromCurrency,
      toCurrency,
      rate: args.rate,
      asOfDate: args.asOfDate ?? Date.now(),
      createdBy: user._id,
      createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("exchangeRates")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(200);
  },
});
