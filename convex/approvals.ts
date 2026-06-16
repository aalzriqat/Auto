import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

const wizardSnapshotValidator = v.optional(v.object({
  paymentType: v.string(),
  vehiclePrice: v.number(),
  desiredProfit: v.number(),
  downPayment: v.number(),
  termMonths: v.number(),
  selectedCompanyId: v.optional(v.string()),
}));

export const requestProfitApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedProfit: v.number(),
    minimumProfit: v.number(),
    wizardSnapshot: wizardSnapshotValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    // Verify the vehicle belongs to this org
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    // Check if there is an existing pending request for this vehicle and user
    const existing = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("salespersonId"), user._id),
          q.eq(q.field("status"), "PENDING")
        )
      )
      .first();

    if (existing) {
      return await ctx.db.patch(existing._id, {
        requestedProfit: args.requestedProfit,
        minimumProfit: args.minimumProfit,
        wizardSnapshot: args.wizardSnapshot,
      });
    }

    return await ctx.db.insert("profitApprovalRequests", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      requestedProfit: args.requestedProfit,
      minimumProfit: args.minimumProfit,
      salespersonId: user._id,
      status: "PENDING",
      createdAt: Date.now(),
      wizardSnapshot: args.wizardSnapshot,
    });
  },
});

export const checkPendingApproval = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    // Verify the vehicle belongs to this org
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      return null;
    }

    // We only care about PENDING or APPROVED requests for this salesperson and vehicle.
    const requests = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
      .filter((q) => q.eq(q.field("salespersonId"), user._id))
      .collect();

    if (requests.length === 0) return null;

    // Sort by createdAt desc to get the most recent one
    requests.sort((a, b) => b.createdAt - a.createdAt);
    return requests[0];
  },
});

export const respondToApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("profitApprovalRequests"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Only managers/owners should be able to respond to approval requests
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);

    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) {
      throw new ConvexError("Approval request not found in this organization.");
    }

    if (request.status !== "PENDING") {
      throw new ConvexError("This approval request has already been resolved.");
    }

    await ctx.db.patch(args.requestId, {
      status: args.status,
      approvedBy: user._id,
      notes: args.notes,
    });
  },
});

export const countPending = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);
    const requests = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("status"), "PENDING"))
      .collect();
    return requests.length;
  },
});

export const listPendingApprovals = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // Only users with MANAGE_SETTINGS can see all pending approvals
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);

    const requests = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("status"), "PENDING"))
      .collect();

    // Map to include salesperson details and vehicle details
    return await Promise.all(
      requests.map(async (req) => {
        const salesperson = await ctx.db.get(req.salespersonId);
        const vehicle = await ctx.db.get(req.vehicleId);
        return {
          ...req,
          salespersonName: salesperson?.name || salesperson?.email || "Unknown",
          vehicleMakeModel: vehicle
            ? `${vehicle.make} ${vehicle.model} ${vehicle.year}`
            : "Unknown Vehicle",
          vehicleVin: vehicle?.vin || "N/A",
        };
      })
    );
  },
});

// Returns the calling salesperson's own non-rejected approval requests from the last 7 days.
// Used to surface "Pending Deals" on the sales page so they can resume after approval.
export const cancelMyApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("profitApprovalRequests"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) {
      throw new ConvexError("Approval request not found.");
    }
    if (request.salespersonId !== user._id) {
      throw new ConvexError("You can only cancel your own approval requests.");
    }
    if (request.status !== "PENDING") {
      throw new ConvexError("Only pending requests can be cancelled.");
    }

    await ctx.db.patch(args.requestId, { status: "REJECTED" });
  },
});

export const listMyPendingApprovals = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const requests = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_salesperson", (q) => q.eq("salespersonId", user._id))
      .collect();

    const recent = requests.filter(r => r.createdAt > cutoff && r.status !== "REJECTED");

    return await Promise.all(recent.map(async (r) => {
      const vehicle = await ctx.db.get(r.vehicleId);
      return {
        ...r,
        vehicleSummary: vehicle
          ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
          : "Unknown Vehicle",
      };
    }));
  },
});
