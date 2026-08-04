import { v, ConvexError } from "convex/values";
import { query, MutationCtx, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

/**
 * Checks the accepted-status ids on a finance company and returns the set worth
 * storing.
 *
 * The two failure modes are not the same thing and must not be treated alike:
 *
 *  - A status that exists but belongs to **another org** is a cross-tenant
 *    reference. That still throws.
 *  - A status id that resolves to **nothing** is a dangling reference to a row
 *    that has since been deleted. `orgCustomerStatuses.remove` hard-deletes and
 *    cleans up nothing, so every finance company that accepted that status was
 *    left holding an id pointing at no row.
 *
 * Throwing on the second case bricked the record. The edit dialog seeds its form
 * from the company's stored `acceptedStatuses`, and its checkbox list only
 * renders statuses that still exist — so a dangling id was invisible in the UI,
 * impossible to untick, and re-sent on every save. The company could never be
 * edited again, and deleting the statuses and re-creating them made it worse:
 * the new rows get new ids while the company still holds the old ones.
 *
 * Dropping a dangling id leaks nothing (it names no document) and is the only
 * outcome that lets the record heal itself on the next save.
 */
async function sanitizeAcceptedStatuses(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  statusIds?: Id<"orgCustomerStatuses">[]
): Promise<Id<"orgCustomerStatuses">[] | undefined> {
  if (!statusIds) return undefined;

  const live: Id<"orgCustomerStatuses">[] = [];
  for (const statusId of statusIds) {
    const status = await ctx.db.get(statusId);
    if (status && status.orgId !== orgId) {
      throw new ConvexError("Accepted customer status not found in this organization.");
    }
    if (status) live.push(statusId);
  }
  return live;
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
    const acceptedStatuses = await sanitizeAcceptedStatuses(ctx, args.orgId, args.acceptedStatuses);
    return await ctx.db.insert("financeCompanies", {
      ...args,
      acceptedStatuses,
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
    // Writes back the sanitized list, so a company carrying ids of
    // since-deleted statuses is repaired the first time it is saved.
    const acceptedStatuses = await sanitizeAcceptedStatuses(ctx, orgId, updates.acceptedStatuses);

    await ctx.db.patch(id, { ...updates, acceptedStatuses });
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
    // Gated on EDIT_VEHICLE_VALUATIONS rather than EDIT_VEHICLES so SALES can
    // keep finance-company valuations current directly. Everything else about a
    // vehicle still goes through the vehicleEdits approval flow for that role.
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLE_VALUATIONS]);
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    const company = await ctx.db.get(args.companyId);
    if (!company || company.orgId !== args.orgId) {
      throw new ConvexError("Finance company not found in this organization.");
    }

    // v.number() accepts NaN and Infinity, and NaN defeats every comparison
    // guard downstream (NaN < 0 is false), so reject them explicitly before
    // the value reaches the financing-limit maths.
    if (!Number.isFinite(args.valuationAmount) || args.valuationAmount < 0) {
      throw new ConvexError("Valuation amount must be a non-negative number.");
    }
    if (args.expiresAt !== undefined && !Number.isFinite(args.expiresAt)) {
      throw new ConvexError("Valuation expiry must be a valid timestamp.");
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
