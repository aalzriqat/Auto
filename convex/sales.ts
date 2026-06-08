import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { rateLimiter } from "./rateLimit";

// ─── Validators ──────────────────────────────────────────────────────────────

const saleStatus = v.union(
  v.literal("PENDING"),
  v.literal("COMPLETED"),
  v.literal("CANCELLED")
);

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all sales for an organization, hydrated with related data.
 * Optionally filters by salesperson.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    salespersonId: v.optional(v.id("users")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    let pageResult;

    if (args.salespersonId) {
      pageResult = await ctx.db
        .query("sales")
        .withIndex("by_org_salesperson", (q) =>
          q.eq("orgId", args.orgId).eq("salespersonId", args.salespersonId!)
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .paginate(args.paginationOpts);
    } else {
      pageResult = await ctx.db
        .query("sales")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .paginate(args.paginationOpts);
    }

    const page = await Promise.all(
      pageResult.page.map(async (sale) => {
        const vehicle = await ctx.db.get(sale.vehicleId);
        const customer = await ctx.db.get(sale.customerId);
        const salesperson = await ctx.db.get(sale.salespersonId);

        return {
          ...sale,
          vehicleSummary: vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
            : "Unknown",
          vehicleVin: vehicle?.vin ?? "",
          customerName: customer
            ? `${customer.firstName} ${customer.lastName}`
            : "Unknown",
          salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
        };
      })
    );
    
    return { ...pageResult, page };
  },
});

/**
 * Gets a single sale by ID, fully hydrated.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throw new ConvexError("Sale not found in this organization.");
    }

    const vehicle = await ctx.db.get(sale.vehicleId);
    const customer = await ctx.db.get(sale.customerId);
    const salesperson = await ctx.db.get(sale.salespersonId);

    return {
      ...sale,
      vehicle,
      customer,
      salesperson: salesperson
        ? { _id: salesperson._id, name: salesperson.name, email: salesperson.email }
        : null,
    };
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new sale record.
 * Validates all cross-references and automatically marks the vehicle as SOLD.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    salePrice: v.number(),
    saleDate: v.number(),
    status: v.optional(saleStatus),
    taxRate: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    dealerFees: v.optional(v.number()),
    downPayment: v.optional(v.number()),
    tradeInVehicleId: v.optional(v.id("vehicles")),
    tradeInValue: v.optional(v.number()),
    financingType: v.optional(v.union(v.literal("CASH"), v.literal("FINANCED"), v.literal("LEASE"))),
    loanAmount: v.optional(v.number()),
    apr: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    warrantySold: v.optional(v.number()),
    gapSold: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "create");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    // Validate vehicle belongs to org and is available
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    if (vehicle.status === "SOLD") {
      throw new ConvexError("This vehicle has already been sold.");
    }
    if (vehicle.status === "ARCHIVED") {
      throw new ConvexError("Cannot sell an archived vehicle. Restore it first.");
    }

    // Validate customer belongs to org
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    // Validate salesperson is a member of the org
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.salespersonId)
      )
      .unique();

    if (!membership) {
      throw new ConvexError("Salesperson is not a member of this organization.");
    }

    // Create the sale
    const saleId = await ctx.db.insert("sales", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      customerId: args.customerId,
      salespersonId: args.salespersonId,
      salePrice: args.salePrice,
      saleDate: args.saleDate,
      status: args.status ?? "PENDING",
      taxRate: args.taxRate,
      taxAmount: args.taxAmount,
      dealerFees: args.dealerFees,
      downPayment: args.downPayment,
      tradeInVehicleId: args.tradeInVehicleId,
      tradeInValue: args.tradeInValue,
      financingType: args.financingType,
      loanAmount: args.loanAmount,
      apr: args.apr,
      termMonths: args.termMonths,
      warrantySold: args.warrantySold,
      gapSold: args.gapSold,
    });

    // Mark the vehicle as SOLD
    await ctx.db.patch(args.vehicleId, { status: "SOLD" as const });

    // Log the transaction in the General Ledger
    await ctx.db.insert("transactions", {
      orgId: args.orgId,
      type: "IN",
      amount: args.salePrice,
      date: args.saleDate,
      category: "VEHICLE_SALE",
      description: `Sale of vehicle ${vehicle.year} ${vehicle.make} ${vehicle.model} (VIN: ${vehicle.vin})`,
      vehicleId: args.vehicleId,
    });

    // Close any open leads for this vehicle+customer as WON
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) =>
        q.and(
          q.eq(q.field("customerId"), args.customerId),
          q.eq(q.field("vehicleId"), args.vehicleId),
          q.neq(q.field("stage"), "WON"),
          q.neq(q.field("stage"), "LOST")
        )
      )
      .collect();

    for (const lead of leads) {
      await ctx.db.patch(lead._id, { stage: "WON" as const });
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "New Sale Recorded",
      `${actorName} recorded a new sale for ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      `/sales?highlightId=${saleId}`
    );

    return saleId;
  },
});

/**
 * Updates a sale's details (e.g. price correction, status change).
 * If status changes to CANCELLED, restores the vehicle to AVAILABLE.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    salePrice: v.optional(v.number()),
    saleDate: v.optional(v.number()),
    status: v.optional(saleStatus),
    taxRate: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    dealerFees: v.optional(v.number()),
    downPayment: v.optional(v.number()),
    tradeInVehicleId: v.optional(v.id("vehicles")),
    tradeInValue: v.optional(v.number()),
    financingType: v.optional(v.union(v.literal("CASH"), v.literal("FINANCED"), v.literal("LEASE"))),
    loanAmount: v.optional(v.number()),
    apr: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    warrantySold: v.optional(v.number()),
    gapSold: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_SALES]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throw new ConvexError("Sale not found in this organization.");
    }

    const patch: Record<string, unknown> = {};
    if (args.salePrice !== undefined) patch.salePrice = args.salePrice;
    if (args.saleDate !== undefined) patch.saleDate = args.saleDate;
    if (args.status !== undefined) patch.status = args.status;
    if (args.taxRate !== undefined) patch.taxRate = args.taxRate;
    if (args.taxAmount !== undefined) patch.taxAmount = args.taxAmount;
    if (args.dealerFees !== undefined) patch.dealerFees = args.dealerFees;
    if (args.downPayment !== undefined) patch.downPayment = args.downPayment;
    if (args.tradeInVehicleId !== undefined) patch.tradeInVehicleId = args.tradeInVehicleId;
    if (args.tradeInValue !== undefined) patch.tradeInValue = args.tradeInValue;
    if (args.financingType !== undefined) patch.financingType = args.financingType;
    if (args.loanAmount !== undefined) patch.loanAmount = args.loanAmount;
    if (args.apr !== undefined) patch.apr = args.apr;
    if (args.termMonths !== undefined) patch.termMonths = args.termMonths;
    if (args.warrantySold !== undefined) patch.warrantySold = args.warrantySold;
    if (args.gapSold !== undefined) patch.gapSold = args.gapSold;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.saleId, patch);
    }

    // If sale is cancelled, restore the vehicle to AVAILABLE
    if (args.status === "CANCELLED" && sale.status !== "CANCELLED") {
      const vehicle = await ctx.db.get(sale.vehicleId);
      if (vehicle && vehicle.status === "SOLD") {
        await ctx.db.patch(sale.vehicleId, { status: "AVAILABLE" as const });
      }
    }

    if (Object.keys(patch).length > 0) {
      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "Sale Updated",
        `${actorName} updated a sale record.`,
        `/sales?highlightId=${args.saleId}`
      );
    }
  },
});

/**
 * Soft deletes a sale record. Only CANCELLED or PENDING sales can be deleted.
 * Restores the vehicle to AVAILABLE if it was marked SOLD.
 */
// TODO: Add admin recovery endpoint if needed
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_SALES]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throw new ConvexError("Sale not found in this organization.");
    }

    if (sale.status === "COMPLETED") {
      throw new ConvexError(
        "Cannot delete a completed sale. Cancel it first."
      );
    }

    // Restore vehicle status if it was marked SOLD from this sale
    const vehicle = await ctx.db.get(sale.vehicleId);
    if (vehicle && vehicle.status === "SOLD") {
      await ctx.db.patch(sale.vehicleId, { status: "AVAILABLE" as const });
    }

    await ctx.db.patch(args.saleId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Sale Deleted",
      `${actorName} deleted a sale record.`
    );
  },
});
