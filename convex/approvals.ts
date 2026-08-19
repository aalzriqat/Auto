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

    // Check if there is an existing pending request for this vehicle and user.
    //
    // ⚠️ This is a dedup lookup whose result is PATCHED, so an unscoped read
    // here is a cross-tenant WRITE rather than a leak. `by_vehicle` keys on the
    // global vehicle id; narrowing by salesperson and status left the request's
    // org unconstrained, so another dealership's PENDING row for this same
    // vehicle id satisfied it and received this org's requested profit and
    // wizard snapshot — while this org got no approval record at all. Both
    // tenants end up wrong, and the org whose data was overwritten has no way
    // to see it happened.
    //
    // Demonstrated before fixing: Org B's row came back reading 555 instead of
    // 4242. Note the verification above proves the VEHICLE is in this org and
    // is no help — the row being written is the request, not the vehicle.
    //
    // ⚠️ REACHABILITY, stated honestly because the first version of this
    // comment did not. Triggering it needs a request whose `orgId` disagrees
    // with its vehicle's, and no user-facing path can produce one: this
    // mutation is the only writer and validates the correspondence above,
    // nothing repoints a vehicle's `orgId`, and vehicles are hard-deleted only
    // by superadmin teardown or the raw-JSON admin editor. The demonstration
    // seeds that state directly. So this is DEFENCE-IN-DEPTH against an admin
    // edit or a future writer that skips validation — not a live exploit. The
    // confirmed user-reachable defect on this ticket is the READ leak in
    // `listMyPendingApprovals`, which needs only ordinary two-org membership.
    const existing = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_org_vehicle_salesperson", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("salespersonId", user._id)
      )
      .filter((q) => q.eq(q.field("status"), "PENDING"))
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
    //
    // `orgId` leads the index for the same reason it does in the queries below,
    // and the check above is not a substitute: proving the VEHICLE belongs to
    // this org says nothing about the org of a REQUEST that references it. The
    // old read used `by_vehicle` — a global vehicle key — and narrowed only by
    // salesperson, so a request another dealership had written against this
    // vehicle id came back with its margins and wizard snapshot attached, and
    // won outright whenever it was the more recent one.
    const requests = await ctx.db
      .query("profitApprovalRequests")
      .withIndex("by_org_vehicle_salesperson", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("salespersonId", user._id)
      )
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

    // The request is proven in-org above; the vehicle it references is not.
    // Without this an approval carrying a foreign vehicle id would put that
    // car's year/make/model into a notification — the same unchecked
    // dereference the list queries now refuse, on the one path that emails the
    // result rather than merely rendering it.
    const vehicle = await ctx.db.get(request.vehicleId);
    const vehicleInOrg = vehicle && vehicle.orgId === args.orgId ? vehicle : null;
    const saleLabel = vehicleInOrg
      ? `${vehicleInOrg.year} ${vehicleInOrg.make} ${vehicleInOrg.model}`
      : "the requested sale";
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
    const enriched = await Promise.all(
      requests.map(async (req) => {
        const salesperson = await ctx.db.get(req.salespersonId);
        const vehicle = await ctx.db.get(req.vehicleId);
        // Same fail-closed rule as `listMyPendingApprovals`, and this one has
        // more to lose: it returns the VIN as well, so an unchecked foreign
        // reference discloses strictly more.
        //
        // ⚠️ SANITISED, not dropped — and the asymmetry with
        // `listMyPendingApprovals` is deliberate. This is the MANAGER's queue,
        // and `countPending` counts the same PENDING rows for the navigation
        // badge. Dropping here produced a phantom queue: a permanent nonzero
        // badge over a page with nothing on it, and no way for anyone to clear
        // the row, because rejecting it needs the `_id` that was dropped with
        // it. That is a workflow dead-end, and it was strictly worse than the
        // cosmetic relabelling it replaced — the manager could at least reject
        // the row before.
        //
        // So the row survives with its `_id` intact and every foreign
        // reference removed: no `vehicleId` to act on, no VIN, no description.
        // The manager can reject it; nothing crosses the tenant boundary.
        //
        // `listMyPendingApprovals` still drops, because its consumer feeds
        // `vehicleId` straight into the resume wizard and there is nothing
        // useful a salesperson can do with a car this dealership does not have.
        //
        // ⚠️ `salespersonId` is still NOT proven in-org. Doing so needs a
        // membership lookup per row, and unlike a VIN or a margin the exposure
        // is a display name. Tracked on SCRUM-102 — and note both independent
        // reviews raised a sharper version than "latent": a salesperson
        // offboarded from this org but still employed elsewhere keeps a live
        // global user row, so the name shown here can drift to their CURRENT
        // employer's profile.
        if (!vehicle || vehicle.orgId !== args.orgId) {
          console.error(
            `[approvals] sanitising approval ${req._id}: vehicle ${req.vehicleId} is not in org ${args.orgId}`
          );
          const { vehicleId: _foreign, ...safe } = req;
          return {
            ...safe,
            salespersonName: salesperson?.name || salesperson?.email || "Unknown",
            vehicleMakeModel: "Unknown Vehicle",
            vehicleVin: "N/A",
          };
        }
        return {
          ...req,
          salespersonName: salesperson?.name || salesperson?.email || "Unknown",
          vehicleMakeModel: `${vehicle.make} ${vehicle.model} ${vehicle.year}`,
          vehicleVin: vehicle.vin,
        };
      })
    );

    return enriched;
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
  // ⚠️ The 7-day window is derived from the SERVER clock, deliberately.
  //
  // An earlier revision let the caller pass its own clock so that identical
  // query arguments would let Convex reuse a cached result. Flooring that value
  // stopped it widening the window, but not narrowing it: a browser clock two
  // days fast produced a five-day window, and the approvals that silently
  // vanished were APPROVED ones — precisely the rows the sales page turns into
  // "Resume Deal". A skewed client clock is an ordinary condition, not an
  // attack, and losing a salesperson's resumable deal is not an acceptable
  // failure mode for a caching optimisation.
  //
  // Keeping the cutoff server-authoritative also removes the deploy-ordering
  // hazard a new required argument introduced. The caching question is real but
  // it is a separate change, to be measured on its own.
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

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
    //
    // ⚠️ The sort restores the ORDER the previous implementation produced, and
    // it is not cosmetic. Convex appends `_creationTime` to every index as the
    // final ordering field, so the old `by_salesperson` read — salesperson fixed
    // by equality — returned rows in insertion order. This index fixes org and
    // salesperson and then ranges on `createdAt`, so it would otherwise return
    // them in `createdAt` order instead. `createdAt` is an application field and
    // need not agree with insertion order, and `sales/page.tsx` renders this
    // list with a bare `.map()`, so the difference is visible on screen.
    // Sorting a set already bounded to one salesperson's last seven days is
    // cheap; changing what the salesperson sees is not.
    const recent = recentInOrg
      .filter(r => r.status !== "REJECTED")
      .sort((a, b) => a._creationTime - b._creationTime);

    const enriched = await Promise.all(recent.map(async (r) => {
      const vehicle = await ctx.db.get(r.vehicleId);
      // ⚠️ The approval row is proven in-org by the index range above; the
      // vehicle it points at is not. `requestProfitApproval` refuses a foreign
      // vehicle, so a malformed reference should not exist — but "should not
      // exist" is an argument about reachability, and this is a confidentiality
      // read.
      //
      // The row is DROPPED rather than described as "Unknown Vehicle", and the
      // difference is not cosmetic. An earlier version masked only the summary
      // while `...r` still spread the foreign `vehicleId` to the client, and
      // `sales/page.tsx` hands exactly that id to
      // `buildInitialDraftFromApproval` when a salesperson resumes. Masking the
      // label while leaving the identifier live hid the evidence instead of
      // closing the hole.
      //
      // Dropping loses nothing usable: there is no legitimate way to resume a
      // deal on a car this dealership does not have, so the row is unactionable
      // by definition. It is logged server-side because silently discarding a
      // row is only acceptable if someone can find out it happened.
      if (!vehicle || vehicle.orgId !== args.orgId) {
        console.error(
          `[approvals] dropping approval ${r._id}: vehicle ${r.vehicleId} is not in org ${args.orgId}`
        );
        return null;
      }
      return {
        ...r,
        vehicleSummary: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      };
    }));

    return enriched.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});
