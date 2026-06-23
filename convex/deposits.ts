import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { holdVehicleForDeposit, maybeReleaseVehicleHold } from "./utils/depositHelpers";
import { notifyManagers, getActorName } from "./utils/notifications";

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    amount: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Recording a deposit while working a deal in the wizard is normal
    // day-to-day sales activity, not a committed sale — VIEW_SALES (held by
    // SALES/MANAGER/ACCOUNTANT/OWNER) is the right bar, same as quotes.ts.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
    }

    // Throws if the vehicle is SOLD/ARCHIVED; otherwise patches AVAILABLE -> RESERVED
    // (no-op if it's already RESERVED — parallel deposits are allowed).
    await holdVehicleForDeposit(ctx, quote!.vehicleId);

    const depositId = await ctx.db.insert("deposits", {
      orgId: args.orgId,
      vehicleId: quote!.vehicleId,
      customerId: quote!.customerId,
      quoteId: args.quoteId,
      amount: args.amount,
      status: "HELD",
      holdActive: true,
      notes: args.notes,
      createdBy: user._id,
      createdAt: Date.now(),
    });

    await ctx.db.insert("transactions", {
      orgId: args.orgId,
      type: "IN",
      amount: args.amount,
      date: Date.now(),
      category: "DEPOSIT",
      description: `Deposit held for quote ${args.quoteId}`,
      vehicleId: quote!.vehicleId,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "deposit.created",
      { actorName, amount: String(args.amount) },
      { link: `/${args.orgId}/sales?highlightId=${quote!.vehicleId}` }
    );

    return depositId;
  },
});

export const release = mutation({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    resolution: v.union(v.literal("REFUNDED"), v.literal("FORFEITED")),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);

    const deposit = await ctx.db.get(args.depositId);
    if (!deposit || deposit.orgId !== args.orgId) {
      throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
    }
    if (deposit!.status !== "HELD") {
      throwAppError(AppErrorCode.DEPOSIT_ALREADY_RESOLVED, "This deposit has already been resolved.");
    }

    await ctx.db.patch(args.depositId, {
      status: args.resolution,
      holdActive: false,
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      notes: args.notes ?? deposit!.notes,
    });

    if (args.resolution === "REFUNDED") {
      await ctx.db.insert("transactions", {
        orgId: args.orgId,
        type: "OUT",
        amount: deposit!.amount,
        date: Date.now(),
        category: "DEPOSIT",
        description: `Deposit refunded for quote ${deposit!.quoteId}`,
        vehicleId: deposit!.vehicleId,
      });
    }

    await maybeReleaseVehicleHold(ctx, deposit!.vehicleId);

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "deposit.released",
      { actorName, amount: String(deposit!.amount) },
      { link: `/${args.orgId}/sales?highlightId=${deposit!.vehicleId}` }
    );
  },
});

export const listByVehicle = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const deposits = await ctx.db
      .query("deposits")
      .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(50);

    return deposits.filter((d) => d.orgId === args.orgId);
  },
});
