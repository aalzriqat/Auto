import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { maybeAutoPostToInstagram, maybeAutoPostToFacebook } from "./utils/socialAutoPost";

const vehicleStatus = v.union(
  v.literal("AVAILABLE"),
  v.literal("RESERVED"),
  v.literal("SOLD"),
  v.literal("IN_INSPECTION"),
  v.literal("IN_REPAIR"),
  v.literal("ARCHIVED")
);

/**
 * Submitting a status change request requires Edit Vehicles to be set to
 * either Direct Access or Requires Approval — a role with No Access
 * shouldn't be able to request changes just because it can view vehicles.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedStatus: vehicleStatus,
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    if (
      role.name !== "OWNER" &&
      !role.permissions.includes(PERMISSIONS.EDIT_VEHICLES) &&
      !role.permissions.includes(PERMISSIONS.EDIT_VEHICLES_REQUEST)
    ) {
      throw new ConvexError(
        `Forbidden: Missing required permissions: ${PERMISSIONS.EDIT_VEHICLES_REQUEST}`
      );
    }

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    if (vehicle.status === args.requestedStatus) {
      throw new ConvexError(`Vehicle is already marked as ${args.requestedStatus}.`);
    }

    // Check if there's already a pending request for this vehicle by this user
    const existing = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
      .filter((q) => q.eq(q.field("status"), "PENDING"))
      .filter((q) => q.eq(q.field("requestedBy"), user._id))
      .first();

    if (existing) {
      throw new ConvexError("You already have a pending status request for this vehicle.");
    }

    await ctx.db.insert("vehicleStatusRequests", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      requestedBy: user._id,
      requestedStatus: args.requestedStatus,
      notes: args.notes,
      status: "PENDING",
      createdAt: Date.now(),
    });
  },
});

/**
 * Managers can list pending requests for their organization.
 */
export const listPending = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const requests = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();

    // Hydrate with vehicle and user info
    return await Promise.all(
      requests.map(async (req) => {
        const vehicle = await ctx.db.get(req.vehicleId);
        const user = await ctx.db.get(req.requestedBy);
        return {
          ...req,
          vehicle: vehicle ? { make: vehicle.make, model: vehicle.model, year: vehicle.year, vin: vehicle.vin, currentStatus: vehicle.status } : null,
          user: user ? { name: user.name ?? user.email, email: user.email } : null,
        };
      })
    );
  },
});

/**
 * Managers can approve or reject a request.
 */
export const resolve = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("vehicleStatusRequests"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) {
      throw new ConvexError("Request not found in this organization.");
    }

    if (request.status !== "PENDING") {
      throw new ConvexError(`This request has already been ${request.status.toLowerCase()}.`);
    }

    await ctx.db.patch(args.requestId, {
      status: args.status,
      resolvedBy: user._id,
      resolvedAt: Date.now(),
    });

    if (args.status === "APPROVED") {
      const vehicle = await ctx.db.get(request.vehicleId);
      if (vehicle) {
        await ctx.db.patch(request.vehicleId, {
          status: request.requestedStatus,
        });

        if (request.requestedStatus === "AVAILABLE" && vehicle.status !== "AVAILABLE") {
          const updatedVehicle = { ...vehicle, status: "AVAILABLE" as const };
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
  },
});
