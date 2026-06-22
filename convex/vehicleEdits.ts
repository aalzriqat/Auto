import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { ConvexError } from "convex/values";
import { maybeAutoPostToInstagram, maybeAutoPostToFacebook } from "./utils/socialAutoPost";

export const requestCreate = mutation({
  args: {
    orgId: v.id("organizations"),
    payload: v.object({
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
      status: v.optional(v.string()),
      notes: v.optional(v.string()),
      imageIds: v.optional(v.array(v.id("_storage"))),
    }), // The vehicle creation payload
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const requestId = await ctx.db.insert("vehicleEdits", {
      orgId: args.orgId,
      requestedBy: user._id,
      type: "CREATE",
      payload: args.payload,
      status: "PENDING",
      createdAt: Date.now(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Vehicle Creation Request",
      `${actorName} requested to add a new vehicle (${args.payload.year} ${args.payload.make} ${args.payload.model}).`,
      `/${args.orgId}/vehicles?approvals=true`
    );

    return requestId;
  },
});

export const requestUpdate = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    payload: v.object({
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
      status: v.optional(v.string()),
      notes: v.optional(v.string()),
      imageIds: v.optional(v.array(v.id("_storage"))),
    }), // The vehicle update payload (patch)
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found.");
    }

    const filteredPayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.payload)) {
      if (key === "imageIds") {
        const oldImages = JSON.stringify(vehicle.imageIds || []);
        const newImages = JSON.stringify(value || []);
        if (oldImages !== newImages) filteredPayload[key] = value;
      } else {
        const newValue = typeof value === "string" ? value.trim() : value;
        const oldValue = vehicle[key as keyof typeof vehicle];
        
        const normNew = newValue === "" ? undefined : newValue;
        const normOld = oldValue === "" ? undefined : oldValue;
        
        if (normNew !== normOld) {
          filteredPayload[key] = value;
        }
      }
    }

    if (Object.keys(filteredPayload).length === 0) {
      throw new ConvexError("No changes detected.");
    }

    const requestId = await ctx.db.insert("vehicleEdits", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      requestedBy: user._id,
      type: "UPDATE",
      payload: filteredPayload,
      status: "PENDING",
      createdAt: Date.now(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Vehicle Update Request",
      `${actorName} requested to update details for the ${vehicle.year} ${vehicle.make} ${vehicle.model}.`,
      `/${args.orgId}/vehicles?approvals=true`
    );

    return requestId;
  },
});

export const listPending = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const requests = await ctx.db
      .query("vehicleEdits")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .order("desc")
      .collect();

    // Enrich with user and vehicle info
    return Promise.all(
      requests.map(async (req) => {
        const user = await ctx.db.get(req.requestedBy);
        const vehicle = req.vehicleId ? await ctx.db.get(req.vehicleId) : null;
        return {
          ...req,
          user: user ? { name: user.name || "Unknown", email: user.email } : null,
          vehicle,
        };
      })
    );
  },
});

export const resolve = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("vehicleEdits"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) {
      throw new ConvexError("Request not found.");
    }

    if (request.status !== "PENDING") {
      throw new ConvexError("Request is already resolved.");
    }

    await ctx.db.patch(request._id, {
      status: args.status,
      resolvedBy: user._id,
      resolvedAt: Date.now(),
    });

    if (args.status === "APPROVED") {
      if (request.type === "CREATE") {
        await ctx.db.insert("vehicles", {
          ...(request.payload as any),
          orgId: args.orgId,
          addedBy: request.requestedBy,
          updatedBy: user._id, // Manager who approved it
          updatedAt: Date.now(),
        });
      } else if (request.type === "UPDATE" && request.vehicleId) {
        const previousVehicle = await ctx.db.get(request.vehicleId);

        await ctx.db.patch(request.vehicleId, {
          ...(request.payload as any),
          updatedBy: user._id, // Manager who approved it
          updatedAt: Date.now(),
        });

        const payload = request.payload as { status?: string };
        if (payload.status === "AVAILABLE" && previousVehicle && previousVehicle.status !== "AVAILABLE") {
          const updatedVehicle = await ctx.db.get(request.vehicleId);
          if (updatedVehicle) {
            await maybeAutoPostToInstagram(ctx, {
              orgId: args.orgId,
              vehicle: updatedVehicle,
              triggeredByUserId: user._id,
            });
            await maybeAutoPostToFacebook(ctx, {
              orgId: args.orgId,
              vehicle: updatedVehicle,
              triggeredByUserId: user._id,
            });
          }
        }
      }
    }
  },
});

export const getHistory = query({
  args: { 
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles") 
  },
  handler: async (ctx, args) => {
    // We allow anyone in the org to view history
    await requireTenantAuth(ctx, args.orgId);

    const edits = await ctx.db
      .query("vehicleEdits")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("vehicleId"), args.vehicleId))
      .order("desc")
      .collect();

    // Enrich with user names
    return Promise.all(
      edits.map(async (edit) => {
        const requestedBy = await ctx.db.get(edit.requestedBy);
        const resolvedBy = edit.resolvedBy ? await ctx.db.get(edit.resolvedBy) : null;
        
        return {
          ...edit,
          requestedByName: requestedBy?.name || "Unknown",
          resolvedByName: resolvedBy?.name,
        };
      })
    );
  },
});
