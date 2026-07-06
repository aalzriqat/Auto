import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
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
