import { v } from "convex/values";
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
      .query("fixedAssets")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    purchaseDate: v.number(),
    purchaseValue: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await ctx.db.insert("fixedAssets", {
      orgId: args.orgId,
      name: args.name,
      purchaseDate: args.purchaseDate,
      purchaseValue: args.purchaseValue,
      notes: args.notes,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
    name: v.optional(v.string()),
    purchaseDate: v.optional(v.number()),
    purchaseValue: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, assetId, ...updates } = args;

    // Clean up undefined optional values
    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    await ctx.db.patch(assetId, cleanedUpdates);
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    await ctx.db.patch(args.assetId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });
  },
});
