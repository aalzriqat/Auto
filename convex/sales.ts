import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { rateLimiter } from "./rateLimit";
import { validateInput } from "./utils/validation";
import { CreateSaleSchema, UpdateSaleSchema } from "./validations/sales";
import {
  markVehicleAsSold,
  restoreVehicleToAvailable,
  createSaleTransaction,
  closeLeadsAsWon,
} from "./utils/saleHelpers";
import { throwAppError, AppErrorCode } from "./utils/errors";

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
      throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
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
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    validateInput(CreateSaleSchema, args);

    // Validate vehicle belongs to org and is available
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throwAppError(AppErrorCode.VEHICLE_NOT_FOUND, "Vehicle not found in this organization.");
    }
    if (vehicle.status === "SOLD") {
      throwAppError(AppErrorCode.VEHICLE_ALREADY_SOLD, "This vehicle has already been sold.");
    }
    if (vehicle.status === "ARCHIVED") {
      throwAppError(AppErrorCode.VEHICLE_ARCHIVED, "Cannot sell an archived vehicle. Restore it first.");
    }

    // Validate customer belongs to org
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throwAppError(AppErrorCode.CUSTOMER_NOT_FOUND, "Customer not found in this organization.");
    }

    // Validate salesperson is a member of the org
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.salespersonId)
      )
      .unique();

    if (!membership) {
      throwAppError(AppErrorCode.SALESPERSON_NOT_MEMBER, "Salesperson is not a member of this organization.");
    }

    // Calculate commission based on salesperson's rate and gross profit
    let commissionAmount: number | undefined;
    const commissionRate = membership!.commissionRate ?? 0;
    if (commissionRate > 0) {
      const grossProfit = vehicle!.purchasePrice != null
        ? args.salePrice - vehicle!.purchasePrice
        : args.salePrice;
      commissionAmount = Math.max(0, grossProfit * (commissionRate / 100));
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
      commissionAmount,
    });

    await markVehicleAsSold(ctx, args.vehicleId);
    await createSaleTransaction(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      salePrice: args.salePrice,
      saleDate: args.saleDate,
      vehicle,
    });
    await closeLeadsAsWon(ctx, {
      orgId: args.orgId,
      customerId: args.customerId,
      vehicleId: args.vehicleId,
    });

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
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_SALES]);

    validateInput(UpdateSaleSchema, args);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
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

    if (args.status === "CANCELLED" && sale.status !== "CANCELLED") {
      await restoreVehicleToAvailable(ctx, sale.vehicleId);
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
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_SALES]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throwAppError(AppErrorCode.UNAUTHENTICATED, "Unauthenticated");

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
    }

    if (sale.status === "COMPLETED") {
      throwAppError(AppErrorCode.SALE_ALREADY_COMPLETED, "Cannot delete a completed sale. Cancel it first.");
    }

    await restoreVehicleToAvailable(ctx, sale.vehicleId);

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

// ─── Commission Queries & Mutations ──────────────────────────────────────────

export const listCommissions = query({
  args: {
    orgId: v.id("organizations"),
    salespersonId: v.optional(v.id("users")),
    paidStatus: v.optional(v.union(v.literal("paid"), v.literal("unpaid"))),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_COMMISSIONS]);

    let sales;
    if (args.salespersonId) {
      sales = await ctx.db
        .query("sales")
        .withIndex("by_org_salesperson", (q) =>
          q.eq("orgId", args.orgId).eq("salespersonId", args.salespersonId!)
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .collect();
    } else {
      sales = await ctx.db
        .query("sales")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .collect();
    }

    // Only include sales that have a commission amount set
    const withCommission = sales.filter(s => s.commissionAmount != null && s.commissionAmount > 0);

    // Apply paid/unpaid filter
    const filtered = args.paidStatus === "paid"
      ? withCommission.filter(s => s.commissionPaidAt != null)
      : args.paidStatus === "unpaid"
        ? withCommission.filter(s => s.commissionPaidAt == null)
        : withCommission;

    return await Promise.all(
      filtered.map(async (sale) => {
        const vehicle = await ctx.db.get(sale.vehicleId);
        const customer = await ctx.db.get(sale.customerId);
        const salesperson = await ctx.db.get(sale.salespersonId);
        const paidBy = sale.commissionPaidBy ? await ctx.db.get(sale.commissionPaidBy) : null;
        return {
          ...sale,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
          paidByName: paidBy?.name ?? paidBy?.email ?? null,
        };
      })
    );
  },
});

export const markCommissionPaid = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throw new Error("Sale not found.");
    }
    if (sale.commissionPaidAt != null) {
      throw new Error("Commission already marked as paid.");
    }

    await ctx.db.patch(args.saleId, {
      commissionPaidAt: Date.now(),
      commissionPaidBy: user._id,
    });
  },
});

export const markCommissionUnpaid = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throw new Error("Sale not found.");
    }

    await ctx.db.patch(args.saleId, {
      commissionPaidAt: undefined,
      commissionPaidBy: undefined,
    });
  },
});

export const setCommissionAmount = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    commissionAmount: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throw new Error("Sale not found.");
    }

    await ctx.db.patch(args.saleId, {
      commissionAmount: Math.max(0, args.commissionAmount),
    });
  },
});
