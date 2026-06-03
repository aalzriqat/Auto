import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Validators ──────────────────────────────────────────────────────────────

const vehicleStatus = v.union(
  v.literal("AVAILABLE"),
  v.literal("RESERVED"),
  v.literal("SOLD"),
  v.literal("IN_INSPECTION"),
  v.literal("IN_REPAIR"),
  v.literal("ARCHIVED")
);

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all vehicles for an organization.
 * Optionally filters by status.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(vehicleStatus),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    if (args.status) {
      return await ctx.db
        .query("vehicles")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", args.status!)
        )
        .collect();
    }

    return await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

/**
 * Gets a single vehicle by ID. Verifies it belongs to the caller's org.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    return vehicle;
  },
});

/**
 * Searches for a vehicle by VIN within the organization.
 */
export const getByVin = query({
  args: {
    orgId: v.id("organizations"),
    vin: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    return await ctx.db
      .query("vehicles")
      .withIndex("by_org_vin", (q) =>
        q.eq("orgId", args.orgId).eq("vin", args.vin.trim().toUpperCase())
      )
      .unique();
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new vehicle in the organization's inventory.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vin: v.string(),
    make: v.string(),
    model: v.string(),
    year: v.number(),
    trim: v.optional(v.string()),
    mileage: v.number(),
    color: v.string(),
    fuelType: v.string(),
    transmission: v.string(),
    purchasePrice: v.optional(v.number()),
    sellingPrice: v.number(),
    status: v.optional(vehicleStatus),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_VEHICLES]);

    const normalizedVin = args.vin.trim().toUpperCase();

    // Check for duplicate VIN within the org
    const existing = await ctx.db
      .query("vehicles")
      .withIndex("by_org_vin", (q) =>
        q.eq("orgId", args.orgId).eq("vin", normalizedVin)
      )
      .unique();

    if (existing) {
      throw new ConvexError(`A vehicle with VIN "${normalizedVin}" already exists.`);
    }

    return await ctx.db.insert("vehicles", {
      orgId: args.orgId,
      vin: normalizedVin,
      make: args.make.trim(),
      model: args.model.trim(),
      year: args.year,
      trim: args.trim?.trim(),
      mileage: args.mileage,
      color: args.color.trim(),
      fuelType: args.fuelType,
      transmission: args.transmission,
      purchasePrice: args.purchasePrice,
      sellingPrice: args.sellingPrice,
      status: args.status ?? "AVAILABLE",
      notes: args.notes,
    });
  },
});

/**
 * Updates an existing vehicle's details.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    vin: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    trim: v.optional(v.string()),
    mileage: v.optional(v.number()),
    color: v.optional(v.string()),
    fuelType: v.optional(v.string()),
    transmission: v.optional(v.string()),
    purchasePrice: v.optional(v.number()),
    sellingPrice: v.optional(v.number()),
    status: v.optional(vehicleStatus),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    // If VIN is being changed, check for duplicates
    if (args.vin) {
      const normalizedVin = args.vin.trim().toUpperCase();
      if (normalizedVin !== vehicle.vin) {
        const existing = await ctx.db
          .query("vehicles")
          .withIndex("by_org_vin", (q) =>
            q.eq("orgId", args.orgId).eq("vin", normalizedVin)
          )
          .unique();

        if (existing) {
          throw new ConvexError(`A vehicle with VIN "${normalizedVin}" already exists.`);
        }
      }
    }

    const { orgId: _, vehicleId: __, ...updates } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        patch[key] = key === "vin" ? (value as string).trim().toUpperCase()
                   : key === "make" || key === "model" || key === "color"
                     ? (value as string).trim()
                   : value;
      }
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.vehicleId, patch);
    }
  },
});

/**
 * Deletes a vehicle. Only vehicles with status AVAILABLE or ARCHIVED can be deleted.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    if (vehicle.status === "SOLD" || vehicle.status === "RESERVED") {
      throw new ConvexError(
        `Cannot delete a vehicle with status "${vehicle.status}". Archive it first.`
      );
    }

    await ctx.db.delete(args.vehicleId);
  },
});
