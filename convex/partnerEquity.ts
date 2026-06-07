import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("partnerEquity")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    partnerName: v.string(),
    initialCapital: v.number(),
    currentBalance: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await ctx.db.insert("partnerEquity", {
      orgId: args.orgId,
      partnerName: args.partnerName,
      initialCapital: args.initialCapital,
      currentBalance: args.currentBalance,
      notes: args.notes,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    equityId: v.id("partnerEquity"),
    partnerName: v.optional(v.string()),
    initialCapital: v.optional(v.number()),
    currentBalance: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, equityId, ...updates } = args;
    
    // Clean up undefined optional values
    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );
    
    await ctx.db.patch(equityId, cleanedUpdates);
  },
});

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    equityId: v.id("partnerEquity"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await ctx.db.delete(args.equityId);
  },
});
