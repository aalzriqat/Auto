import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

export const requestProfitApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedProfit: v.number(),
    minimumProfit: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) throw new Error("User not found");

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
      // Update the existing request with the new requested profit
      return await ctx.db.patch(existing._id, {
        requestedProfit: args.requestedProfit,
        minimumProfit: args.minimumProfit,
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
    });
  },
});

export const checkPendingApproval = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) return null;

    // We only care about PENDING or APPROVED requests for this salesperson and vehicle.
    // Wait, if it's approved, the user can proceed. We return the latest request.
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
    requestId: v.id("profitApprovalRequests"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) throw new Error("User not found");

    await ctx.db.patch(args.requestId, {
      status: args.status,
      approvedBy: user._id,
      notes: args.notes,
    });
  },
});

export const listPendingApprovals = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
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
