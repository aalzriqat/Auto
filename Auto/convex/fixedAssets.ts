import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("fixedAssets")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
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

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await ctx.db.delete(args.assetId);
  },
});
