import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { rateLimiter } from "./rateLimit";
import { validateInput } from "./utils/validation";
import { CreateVehicleSchema, UpdateVehicleSchema } from "./validations/vehicles";

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

import { paginationOptsValidator } from "convex/server";

/**
 * Lists all vehicles for an organization.
 * Optionally filters by status.
 * This is paginated.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(vehicleStatus),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const canViewCostPrice = role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    let q;

    if (args.status) {
      q = ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!)
      ).filter(q => q.neq(q.field("isDeleted"), true));
    } else {
      q = ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter(q => q.neq(q.field("isDeleted"), true));
    }

    const pageResult = await q.order("desc").paginate(args.paginationOpts);

    const pendingRequests = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();

    const pendingMap = new Map<string, string>();
    for (const req of pendingRequests) {
      pendingMap.set(req.vehicleId, req.requestedStatus);
    }

    const page = await Promise.all(
      pageResult.page.map(async (vehicle) => {
        const imageUrls = await Promise.all(
          (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
        );
        const { purchasePrice, ...rest } = vehicle;
        return {
          ...rest,
          ...(canViewCostPrice ? { purchasePrice } : {}),
          imageUrls,
          pendingStatusRequest: pendingMap.get(vehicle._id) ?? null
        };
      })
    );

    return { ...pageResult, page };
  },
});

/**
 * Lists all vehicles for an organization without pagination (for dropdowns).
 * Optionally filters by status.
 */
export const listAll = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(vehicleStatus),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const canViewCostPrice = role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    let q;

    if (args.status) {
      q = ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!)
      ).filter(q => q.neq(q.field("isDeleted"), true));
    } else {
      q = ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter(q => q.neq(q.field("isDeleted"), true));
    }

    const vehicles = await q.order("desc").take(200);

    const pendingRequests = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();

    const pendingMap = new Map<string, string>();
    for (const req of pendingRequests) {
      pendingMap.set(req.vehicleId, req.requestedStatus);
    }

    return await Promise.all(
      vehicles.map(async (vehicle) => {
        const docUrls = await Promise.all(
          (vehicle.imageIds || []).map((id) => ctx.storage.getUrl(id))
        );

        let purchasePrice = vehicle.purchasePrice;
        if (!canViewCostPrice) {
          purchasePrice = undefined;
        }

        return {
          ...vehicle,
          purchasePrice,
          pendingStatusRequest: pendingMap.get(vehicle._id) || null,
          imageUrls: docUrls,
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
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const canViewCostPrice = role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    const imageUrls = await Promise.all(
      (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
    );

    const { purchasePrice, ...rest } = vehicle;
    return {
      ...rest,
      ...(canViewCostPrice ? { purchasePrice } : {}),
      imageUrls
    };
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
    minimumProfit: v.optional(v.number()),
    sellingPrice: v.number(),
    status: v.optional(vehicleStatus),
    notes: v.optional(v.string()),
    imageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "create");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_VEHICLES]);

    validateInput(CreateVehicleSchema, args);

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
      minimumProfit: args.minimumProfit,
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
    minimumProfit: v.optional(v.number()),
    sellingPrice: v.optional(v.number()),
    status: v.optional(vehicleStatus),
    notes: v.optional(v.string()),
    imageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    validateInput(UpdateVehicleSchema, args);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
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
 * Soft deletes a vehicle. Only vehicles with status AVAILABLE or ARCHIVED can be deleted.
 */
// TODO: Add admin recovery endpoint if needed
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_VEHICLES]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    if (vehicle.status === "SOLD" || vehicle.status === "RESERVED") {
      throw new ConvexError(
        `Cannot delete a vehicle with status "${vehicle.status}". Archive it first.`
      );
    }

    // We no longer delete associated images, we just soft-delete the record
    await ctx.db.patch(args.vehicleId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

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
  args: {
    orgId: v.id("organizations"),
    mimeType: v.string(),
    sizeInBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "upload");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    // 5MB limit
    if (args.sizeInBytes > 5 * 1024 * 1024) {
      throw new ConvexError("File size exceeds 5MB limit.");
    }

    if (!args.mimeType.startsWith("image/")) {
      throw new ConvexError("Only image files are allowed for vehicles.");
    }

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
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    // Delete from storage
    await ctx.storage.delete(args.storageId);

    // Remove from vehicle array
    const newImageIds = (vehicle.imageIds ?? []).filter((id) => id !== args.storageId);
    await ctx.db.patch(args.vehicleId, { imageIds: newImageIds });
  },
});

export const getRelations = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    // 1. Fetch Sales
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("vehicleId"), args.vehicleId))
      .collect();

    const enrichedSales = await Promise.all(
      sales.map(async (sale) => {
        const customer = await ctx.db.get(sale.customerId);
        const salesperson = await ctx.db.get(sale.salespersonId);
        return {
          ...sale,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
        };
      })
    );

    // 2. Fetch Leads
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("vehicleId"), args.vehicleId))
      .collect();

    const enrichedLeads = await Promise.all(
      leads.map(async (lead) => {
        const customer = await ctx.db.get(lead.customerId);
        const assignedUser = lead.assignedUserId ? await ctx.db.get(lead.assignedUserId) : null;
        return {
          ...lead,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unassigned",
        };
      })
    );

    // 3. Fetch Expenses
    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .collect();

    const enrichedExpenses = await Promise.all(
      expenses.map(async (exp) => {
        const payer = exp.payerId ? await ctx.db.get(exp.payerId) : null;
        return {
          ...exp,
          payerName: payer && "name" in payer ? payer.name : null,
          status: exp.status || "PAID",
        };
      })
    );

    // 4. Fetch Tasks
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .collect();

    const enrichedTasks = await Promise.all(
      tasks.map(async (task) => {
        const assignedUser = await ctx.db.get(task.assignedTo);
        return {
          ...task,
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unknown",
        };
      })
    );

    // 5. Fetch Test Drives
    const testDrives = await ctx.db
      .query("test_drives")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .collect();

    const enrichedTestDrives = await Promise.all(
      testDrives.map(async (td) => {
        const customer = await ctx.db.get(td.customerId);
        const salesperson = await ctx.db.get(td.salespersonId);
        return {
          ...td,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
        };
      })
    );

    // 6. Fetch Work Orders
    const workOrders = await ctx.db
      .query("workOrders")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .collect();

    return {
      sales: enrichedSales.sort((a, b) => b.saleDate - a.saleDate),
      leads: enrichedLeads.sort((a, b) => b._creationTime - a._creationTime),
      expenses: enrichedExpenses.sort((a, b) => b.date - a.date),
      tasks: enrichedTasks.sort((a, b) => a.dueDate - b.dueDate),
      testDrives: enrichedTestDrives.sort((a, b) => b.startTime - a.startTime),
      workOrders: workOrders.sort((a, b) => b._creationTime - a._creationTime),
    };
  },
});
