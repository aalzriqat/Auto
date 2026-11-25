import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const getByDeposit = query({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const voucher = await ctx.db
      .query("paymentVouchers")
      .withIndex("by_deposit", (q) => q.eq("depositId", args.depositId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .first();
    if (!voucher || voucher.orgId !== args.orgId) return null;
    return voucher;
  },
});

export const listQuoteReceipts = query({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
  },
  returns: v.object({
    receipts: v.array(v.object({
      _id: v.id("deposits"),
      amount: v.number(),
      currency: v.optional(v.string()),
      status: v.union(v.literal("HELD"), v.literal("APPLIED"), v.literal("REFUNDED"),
        v.literal("FORFEITED"), v.literal("VOIDED")),
    })),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { orgId, quoteId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_SALES]);
    const quote = await requireOwnedRow(ctx, orgId, "quotes", quoteId);
    const limit = 50;
    const rows = await ctx.db.query("deposits")
      .withIndex("by_quote", (q) => q.eq("quoteId", quote._id))
      .order("desc")
      .take(limit + 1);
    const receipts = rows.slice(0, limit).reverse()
      .filter((row) => row.orgId === orgId && row.customerId === quote.customerId &&
        (row.isDeleted !== true || row.status === "VOIDED"))
      .map(({ _id, amount, currency, status }) => ({ _id, amount, currency, status }));
    return { receipts, truncated: rows.length > limit };
  },
});
