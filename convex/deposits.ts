import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { holdVehicleForDeposit, maybeReleaseVehicleHold } from "./utils/depositHelpers";
import { notifyManagers, getActorName } from "./utils/notifications";
import { runWithIdempotency } from "./utils/idempotency";
import { assertDifferentActors } from "./utils/financialGuards";
import { hookDepositReceived, hookDepositRefunded, getOrgCurrency } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    amount: v.number(),
    method: v.optional(v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("PAYMENT_LINK"),
      v.literal("CARD"),
      v.literal("CHEQUE"),
      v.literal("OTHER")
    )),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Recording a deposit while working a deal in the wizard is normal
    // day-to-day sales activity, not a committed sale — VIEW_SALES (held by
    // SALES/MANAGER/ACCOUNTANT/OWNER) is the right bar, same as quotes.ts.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "deposits.create",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        const quote = await ctx.db.get(args.quoteId);
        if (!quote || quote.orgId !== args.orgId) {
          throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
        }

        // Throws if the vehicle is SOLD/ARCHIVED; otherwise patches AVAILABLE -> RESERVED
        // (no-op if it's already RESERVED — parallel deposits are allowed).
        await holdVehicleForDeposit(ctx, quote.vehicleId);

        const [vehicle, customer] = await Promise.all([
          ctx.db.get(quote.vehicleId),
          ctx.db.get(quote.customerId),
        ]);
        const vehicleLabel = vehicle
          ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
          : "Vehicle";
        const customerLabel = customer
          ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer"
          : "Customer";
        const quoteReference = args.quoteId.toString();

        const now = Date.now();
        const depositId = await ctx.db.insert("deposits", {
          orgId: args.orgId,
          vehicleId: quote.vehicleId,
          customerId: quote.customerId,
          quoteId: args.quoteId,
          amount: args.amount,
          status: "HELD",
          holdActive: true,
          idempotencyKey: args.idempotencyKey,
          notes: args.notes,
          createdBy: user._id,
          createdAt: now,
        });

        await ctx.db.insert("transactions", {
          orgId: args.orgId,
          type: "IN",
          amount: args.amount,
          date: now,
          category: "DEPOSIT",
          description: `Deposit for quote ${quoteReference} - ${vehicleLabel} - ${customerLabel}`,
          vehicleId: quote.vehicleId,
          depositId,
          idempotencyKey: args.idempotencyKey,
        });

        await ctx.db.insert("collectionPayments", {
          orgId: args.orgId,
          customerId: quote.customerId,
          vehicleId: quote.vehicleId,
          direction: "IN",
          method: args.method ?? "CASH",
          amount: args.amount,
          paymentDate: now,
          status: "POSTED",
          idempotencyKey: args.idempotencyKey,
          reference: `Deposit ${depositId}`,
          cashierId: user._id,
          notes: args.notes,
          createdAt: now,
        });

        const currency = await getOrgCurrency(ctx, args.orgId);
        await hookDepositReceived(ctx, {
          orgId: args.orgId,
          depositId,
          customerId: quote.customerId,
          amountMinor: toMinorUnits(args.amount, currency),
          currency,
          paymentMethod: args.method ?? "CASH",
          actorId: user._id,
          occurredAt: now,
        });

        const actorName = await getActorName(ctx);
        await notifyManagers(
          ctx,
          args.orgId,
          "deposit.created",
          { actorName, amount: String(args.amount) },
          { link: `/${args.orgId}/sales?highlightId=${quote.vehicleId}` }
        );

        return depositId;
      }
    );
  },
});

export const release = mutation({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    resolution: v.union(v.literal("REFUNDED"), v.literal("FORFEITED")),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "deposits.release",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {

        const deposit = await ctx.db.get(args.depositId);
        if (!deposit || deposit.orgId !== args.orgId) {
          throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
        }
        if (deposit.status !== "HELD") {
          throwAppError(AppErrorCode.DEPOSIT_ALREADY_RESOLVED, "This deposit has already been resolved.");
        }
        assertDifferentActors(
          user._id,
          deposit.createdBy,
          "Deposit creator cannot resolve their own deposit refund or forfeiture."
        );

        const now = Date.now();
        await ctx.db.patch(args.depositId, {
          status: args.resolution,
          holdActive: false,
          resolvedBy: user._id,
          resolvedAt: now,
          notes: args.notes ?? deposit.notes,
        });

        if (args.resolution === "REFUNDED") {
          const [refundVehicle, refundCustomer] = await Promise.all([
            ctx.db.get(deposit.vehicleId),
            ctx.db.get(deposit.customerId),
          ]);
          const refundVehicleLabel = refundVehicle
            ? `${refundVehicle.year} ${refundVehicle.make} ${refundVehicle.model}`.trim()
            : "Vehicle";
          const refundCustomerLabel = refundCustomer
            ? `${refundCustomer.firstName ?? ""} ${refundCustomer.lastName ?? ""}`.trim() || "Customer"
            : "Customer";

          await ctx.db.insert("transactions", {
            orgId: args.orgId,
            type: "OUT",
            amount: deposit.amount,
            date: now,
            category: "DEPOSIT",
            description: `Deposit refund for quote ${deposit.quoteId} - ${refundVehicleLabel} - ${refundCustomerLabel}`,
            vehicleId: deposit.vehicleId,
            depositId: args.depositId,
            idempotencyKey: args.idempotencyKey,
          });

          await ctx.db.insert("collectionPayments", {
            orgId: args.orgId,
            customerId: deposit.customerId,
            vehicleId: deposit.vehicleId,
            direction: "OUT",
            method: "REFUND",
            amount: deposit.amount,
            paymentDate: now,
            status: "POSTED",
            idempotencyKey: args.idempotencyKey,
            reference: `Deposit refund ${args.depositId}`,
            cashierId: user._id,
            notes: args.notes,
            createdAt: now,
          });

          const currency = await getOrgCurrency(ctx, args.orgId);
          await hookDepositRefunded(ctx, {
            orgId: args.orgId,
            depositId: args.depositId,
            customerId: deposit.customerId,
            amountMinor: toMinorUnits(deposit.amount, currency),
            currency,
            actorId: user._id,
            occurredAt: now,
          });
        }

        await maybeReleaseVehicleHold(ctx, deposit.vehicleId);

        const actorName = await getActorName(ctx);
        await notifyManagers(
          ctx,
          args.orgId,
          "deposit.released",
          { actorName, amount: String(deposit.amount) },
          { link: `/${args.orgId}/sales?highlightId=${deposit.vehicleId}` }
        );

        return args.depositId;
      }
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
