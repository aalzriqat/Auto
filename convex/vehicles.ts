import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";

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

    let vehicles;
    if (args.status) {
      vehicles = await ctx.db
        .query("vehicles")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", args.status!)
        )
        .collect();
    } else {
      vehicles = await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();
    }

    const pendingRequests = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();

    const pendingMap = new Map<string, string>();
    for (const req of pendingRequests) {
      pendingMap.set(req.vehicleId, req.requestedStatus);
    }

    return Promise.all(
      vehicles.map(async (vehicle) => {
        const imageUrls = await Promise.all(
          (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
        );
        return { 
          ...vehicle, 
          imageUrls,
          pendingStatusRequest: pendingMap.get(vehicle._id) ?? null
        };
      })
    );
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

    const imageUrls = await Promise.all(
      (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
    );

    return { ...vehicle, imageUrls };
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
    imageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_VEHICLES]);

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

    const id = await ctx.db.insert("vehicles", {
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
      imageIds: args.imageIds,
      addedBy: user._id,
      updatedBy: user._id,
      updatedAt: Date.now(),
    });

    const { orgId: _, ...payloadArgs } = args;
    await ctx.db.insert("vehicleEdits", {
      orgId: args.orgId,
      requestedBy: user._id,
      type: "CREATE",
      payload: payloadArgs,
      status: "APPROVED",
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      createdAt: Date.now(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "New Vehicle Added",
      `${actorName} added a ${args.year} ${args.make.trim()} ${args.model.trim()}`,
      `/vehicles?highlightId=${id}`
    );

    return id;
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
    imageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

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
        const newValue = key === "vin" ? (value as string).trim().toUpperCase()
                   : key === "make" || key === "model" || key === "color"
                     ? (value as string).trim()
                   : value;
        
        if (key === "imageIds") {
          const oldImages = JSON.stringify(vehicle.imageIds || []);
          const newImages = JSON.stringify(newValue || []);
          if (oldImages !== newImages) patch[key] = newValue;
        } else {
          const oldValue = vehicle[key as keyof typeof vehicle];
          const normNew = newValue === "" ? undefined : newValue;
          const normOld = oldValue === "" ? undefined : oldValue;
          if (normNew !== normOld) {
            patch[key] = newValue;
          }
        }
      }
    }
    
    if (Object.keys(patch).length > 0) {
      await ctx.db.insert("vehicleEdits", {
        orgId: args.orgId,
        vehicleId: args.vehicleId,
        requestedBy: user._id,
        type: "UPDATE",
        payload: patch,
        status: "APPROVED",
        resolvedBy: user._id,
        resolvedAt: Date.now(),
        createdAt: Date.now(),
      });

      patch.updatedBy = user._id;
      patch.updatedAt = Date.now();
      await ctx.db.patch(args.vehicleId, patch);
      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "Vehicle Updated",
        `${actorName} updated details for the ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        `/vehicles?highlightId=${args.vehicleId}`
      );
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

    // Delete associated images
    for (const imageId of vehicle.imageIds ?? []) {
      await ctx.storage.delete(imageId);
    }

    await ctx.db.delete(args.vehicleId);

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Vehicle Deleted",
      `${actorName} deleted a ${vehicle.year} ${vehicle.make} ${vehicle.model} (VIN: ${vehicle.vin})`
    );
  },
});

/**
 * Generates an upload URL for uploading vehicle images.
 */
export const generateUploadUrl = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Deletes an image from a vehicle and storage.
 */
export const deleteImage = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    // Delete from storage
    await ctx.storage.delete(args.storageId);

    // Remove from vehicle array
    const newImageIds = (vehicle.imageIds ?? []).filter((id) => id !== args.storageId);
    await ctx.db.patch(args.vehicleId, { imageIds: newImageIds });
  },
});
