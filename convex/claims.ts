import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const list = query({
  args: { 
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("claims")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    claimDate: v.number(),
    financingEntity: v.string(),
    buyerName: v.string(),
    claimAmount: v.number(),
    status: v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("REJECTED")),
    notes: v.optional(v.string()),
    saleId: v.optional(v.id("sales")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await ctx.db.insert("claims", {
      orgId: args.orgId,
      claimDate: args.claimDate,
      financingEntity: args.financingEntity,
      buyerName: args.buyerName,
      claimAmount: args.claimAmount,
      status: args.status,
      notes: args.notes,
      saleId: args.saleId,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("REJECTED"))),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, claimId, ...updates } = args;

    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    await ctx.db.patch(claimId, cleanedUpdates);
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.claimId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });
  },
});
