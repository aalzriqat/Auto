import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// --- Finance Companies ---

export const listCompanies = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return await ctx.db
      .query("financeCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
  },
});

export const createCompany = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    profitRate: v.number(),
    maxTermMonths: v.number(),
    gracePeriodMonths: v.number(),
    insuranceRate: v.optional(v.number()),
    adminFees: v.optional(v.number()),
    commission: v.optional(v.number()),
    includesCommissionInDebt: v.optional(v.boolean()),
    maxFinancingLTV: v.optional(v.number()),
    isActive: v.boolean(),
    acceptedStatuses: v.optional(v.array(v.id("orgCustomerStatuses"))),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);
    return await ctx.db.insert("financeCompanies", {
      ...args,
    });
  },
});

export const updateCompany = mutation({
  args: {
    id: v.id("financeCompanies"),
    orgId: v.id("organizations"),
    name: v.string(),
    profitRate: v.number(),
    maxTermMonths: v.number(),
    gracePeriodMonths: v.number(),
    insuranceRate: v.optional(v.number()),
    adminFees: v.optional(v.number()),
    commission: v.optional(v.number()),
    includesCommissionInDebt: v.optional(v.boolean()),
    maxFinancingLTV: v.optional(v.number()),
    isActive: v.boolean(),
    acceptedStatuses: v.optional(v.array(v.id("orgCustomerStatuses"))),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);
    const { id, orgId, ...updates } = args;
    
    const existing = await ctx.db.get(id);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");
    
    await ctx.db.patch(id, updates);
  },
});

export const deleteCompany = mutation({
  args: { 
    id: v.id("financeCompanies"),
    orgId: v.id("organizations"),
  },
  handler: async (ctx, { id, orgId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.MANAGE_SETTINGS]);
    const existing = await ctx.db.get(id);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");
    await ctx.db.delete(id);
  },
});

// --- Vehicle Valuations ---

export const listValuations = query({
  args: { 
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles") 
  },
  handler: async (ctx, { orgId, vehicleId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return await ctx.db
      .query("vehicleValuations")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId))
      .filter((q) => q.eq(q.field("orgId"), orgId))
      .collect();
  },
});

export const saveValuation = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    companyId: v.id("financeCompanies"),
    valuationAmount: v.number(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    
    // Check if one already exists for this company
    const existing = await ctx.db
      .query("vehicleValuations")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
      .filter((q) => q.eq(q.field("companyId"), args.companyId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        valuationAmount: args.valuationAmount,
        expiresAt: args.expiresAt,
      });
      return existing._id;
    } else {
      return await ctx.db.insert("vehicleValuations", {
        ...args,
      });
    }
  },
});
