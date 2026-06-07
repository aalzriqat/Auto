import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("transactions")
      .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    type: v.union(v.literal("IN"), v.literal("OUT")),
    amount: v.number(),
    date: v.number(),
    category: v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    ),
    description: v.string(),
    vehicleId: v.optional(v.id("vehicles")),
    userId: v.optional(v.id("users")),
    expenseId: v.optional(v.id("expenses")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await ctx.db.insert("transactions", {
      orgId: args.orgId,
      type: args.type,
      amount: args.amount,
      date: args.date,
      category: args.category,
      description: args.description,
      vehicleId: args.vehicleId,
      userId: args.userId,
      expenseId: args.expenseId,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
    type: v.optional(v.union(v.literal("IN"), v.literal("OUT"))),
    amount: v.optional(v.number()),
    date: v.optional(v.number()),
    category: v.optional(v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    )),
    description: v.optional(v.string()),
    vehicleId: v.optional(v.id("vehicles")),
    userId: v.optional(v.id("users")),
    expenseId: v.optional(v.id("expenses")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, transactionId, ...updates } = args;

    // Clean up undefined optional values
    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    await ctx.db.patch(transactionId, cleanedUpdates);
  },
});

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await ctx.db.delete(args.transactionId);
  },
});
