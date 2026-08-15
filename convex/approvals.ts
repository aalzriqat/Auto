import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, notifyUser, getActorName } from "./utils/notifications";

// Exported so requestProfitApprovalArgs.test.ts can assert it still matches
// `profitApprovalRequests.wizardSnapshot` in convex/schema.ts. Accepting a field
// here that the table schema does not declare throws an "extra field" mismatch
// at ctx.db.insert, which rolls the whole mutation back — the salesperson's
// approval request silently never persists.
export const wizardSnapshotValidator = v.optional(v.object({
  paymentType: v.string(),
  vehiclePrice: v.number(),
  desiredProfit: v.number(),
  downPayment: v.number(),
  termMonths: v.number(),
  selectedCompanyId: v.optional(v.string()),
  manualProfitRate: v.optional(v.number()),
  manualInsuranceRate: v.optional(v.number()),
  manualExecutionCommission: v.optional(v.number()),
  manualExecutionFees: v.optional(v.number()),
  manualIncludesCommissionInDebt: v.optional(v.boolean()),
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

    const actorName = await getActorName(ctx);
    const saleLabel = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;

    if (existing) {
      const result = await ctx.db.patch(existing._id, {
        requestedProfit: args.requestedProfit,
        minimumProfit: args.minimumProfit,
        wizardSnapshot: args.wizardSnapshot,
      });
      await notifyManagers(
        ctx,
        args.orgId,
        "approval.requested",
        { actorName, saleLabel },
        { link: `/${args.orgId}/approvals` }
      );
      return result;
    }

    const requestId = await ctx.db.insert("profitApprovalRequests", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      requestedProfit: args.requestedProfit,
      minimumProfit: args.minimumProfit,
      salespersonId: user._id,
      status: "PENDING",
      createdAt: Date.now(),
      wizardSnapshot: args.wizardSnapshot,
    });

    await notifyManagers(
      ctx,
      args.orgId,
      "approval.requested",
      { actorName, saleLabel },
      { link: `/${args.orgId}/approvals` }
    );

    return requestId;
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]); // Cache buster 2

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

    const vehicle = await ctx.db.get(request.vehicleId);
    const saleLabel = vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "the requested sale";
    await notifyUser(
      ctx,
      args.orgId,
      request.salespersonId,
      "approval.responded",
      { saleLabel, status: args.status === "APPROVED" ? "approved" : "rejected" },
      { link: `/${args.orgId}/sales` }
    );
  },
});

export const countPending = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // Badge count — must never throw and crash the page.
    try {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    } catch {
      return 0;
    }
    // SCRUM-100: bound on the index. `.filter()` runs *after* the read, so the
    // previous `by_org` + filter loaded every request the org ever created —
    // including each one's `wizardSnapshot` — to produce a single integer.
    const requests = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();
    return requests.length;
  },
});

export const listPendingApprovals = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // Only users with APPROVE_REQUESTS can see all pending approvals
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);

    // SCRUM-100: bound on the index rather than a post-read filter.
    const requests = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
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
  // The caller passes its clock, rounded to the minute. A Convex query re-runs
  // when its *read set* changes, never merely because time passed, so deriving
  // the window solely from a clock read inside the handler makes it stale by
  // construction and churns the query cache.
  //
  // ⚠️ Optional, not required. This query is already live in production, and the
  // frontend auto-deploys on merge while the Convex backend deploy is manual —
  // a required argument would make every Sales page in the gap between the two
  // fail argument validation and take the dashboard to its error boundary.
  args: { orgId: v.id("organizations"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    // ⚠️ Convex accepts NaN for `v.number()`. An unchecked NaN cutoff makes the
    // range comparison below meaningless, so reject it rather than fail open.
    if (args.now !== undefined && !Number.isFinite(args.now)) {
      throw new ConvexError("Invalid timestamp.");
    }

    const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    // Absorbs honest clock skew between the caller and the server.
    const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

    // ⚠️ The client chooses the cache key; the server chooses how far back it may
    // look. A caller that ignores the page's rounding and sends `now: 0` would
    // otherwise push the cutoff to 1970 and read back every approval it ever
    // filed — its own rows in its own org, so not a tenancy escape, but exactly
    // the unbounded read this issue exists to remove. Flooring against server
    // time binds only that abuse: for an honest `now` the result is unchanged,
    // so the caching benefit above survives.
    const serverNow = Date.now();
    const cutoff = Math.max(
      (args.now ?? serverNow) - WINDOW_MS,
      serverNow - WINDOW_MS - CLOCK_SKEW_MS
    );

    // SCRUM-100. `orgId` leads the index because it is the tenant boundary:
    // `by_salesperson` keys on a global user id, so this previously returned the
    // approvals of every org the caller belongs to — margins, wizard snapshots
    // and the other dealership's vehicles included.
    const recentInOrg = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_org_salesperson_createdAt", (q) =>
        q.eq("orgId", args.orgId).eq("salespersonId", user._id).gt("createdAt", cutoff)
      )
      .collect();

    // Kept in JS on purpose: the predicate is `!== "REJECTED"`, i.e. PENDING or
    // APPROVED, because APPROVED rows are what the sales page resumes from. It
    // runs over an already tenant- and week-bounded set.
    const recent = recentInOrg.filter(r => r.status !== "REJECTED");

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
