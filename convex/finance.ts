import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

async function validateAcceptedStatuses(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  statusIds?: Id<"orgCustomerStatuses">[]
) {
  if (!statusIds) return;
  for (const statusId of statusIds) {
    const status = await ctx.db.get(statusId);
    if (!status || status.orgId !== orgId) {
      throw new ConvexError("Accepted customer status not found in this organization.");
    }
  }
}

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
    await requireOwner(ctx, args.orgId);
    await validateAcceptedStatuses(ctx, args.orgId, args.acceptedStatuses);
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
    await requireOwner(ctx, args.orgId);
    const { id, orgId, ...updates } = args;
    
    const existing = await ctx.db.get(id);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");
    await validateAcceptedStatuses(ctx, orgId, updates.acceptedStatuses);
    
    await ctx.db.patch(id, updates);
  },
});

export const deleteCompany = mutation({
  args: { 
    id: v.id("financeCompanies"),
    orgId: v.id("organizations"),
  },
  handler: async (ctx, { id, orgId }) => {
    const { user } = await requireOwner(ctx, orgId);
    const existing = await ctx.db.get(id);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");
    await ctx.db.patch(id, {
      isActive: false,
      deactivatedAt: Date.now(),
      deactivatedBy: user._id,
    });
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
    const vehicle = await ctx.db.get(vehicleId);
    if (!vehicle || vehicle.orgId !== orgId) throw new ConvexError("Vehicle not found in this organization.");
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
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    const company = await ctx.db.get(args.companyId);
    if (!company || company.orgId !== args.orgId) {
      throw new ConvexError("Finance company not found in this organization.");
    }
    
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
