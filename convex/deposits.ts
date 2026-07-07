import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { holdVehicleForDeposit, releaseAllVehiclesForDeposit } from "./utils/depositHelpers";
import { notifyManagers, getActorName } from "./utils/notifications";
import { runWithIdempotency } from "./utils/idempotency";
import { assertDifferentActors } from "./utils/financialGuards";
import {
  hookDepositForfeited,
  hookDepositRefunded,
  hookDepositVoided,
  getOrgCurrency,
} from "./accounting/workflowHooks";
import {
  amountToMinorOrThrow,
  depositMethodValidator,
  methodOrDefault,
  normalizeCurrency,
  recordHeldDeposit,
} from "./utils/depositRecording";
import { createCanonicalPayment, voidCanonicalPayment } from "./subledger";

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    amount: v.number(),
    currency: v.optional(v.string()),
    method: v.optional(depositMethodValidator),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Recording a deposit while working a deal in the wizard is normal
    // day-to-day sales activity, not a committed sale — VIEW_SALES (held by
    // SALES/MANAGER/ACCOUNTANT/OWNER) is the right bar, same as quotes.ts.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const orgCurrency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
    const currency = args.currency ? normalizeCurrency(args.currency) : orgCurrency;
    if (currency !== orgCurrency) {
      throw new ConvexError(`Deposit currency must match organization currency (${orgCurrency}).`);
    }
    const method = methodOrDefault(args.method);
    const amountMinor = amountToMinorOrThrow(args.amount, currency);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "deposits.create",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          quoteId: args.quoteId,
          amountMinor,
          currency,
          method,
          notes: args.notes ?? null,
        }),
      },
      async () => {
        const quote = await ctx.db.get(args.quoteId);
        if (!quote || quote.orgId !== args.orgId) {
          throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
        }
        const quoteAmountMinor = amountToMinorOrThrow(quote.vehiclePrice, currency, "Quote amount");
        const existingDeposits = await ctx.db
          .query("deposits")
          .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
          .collect();
        const existingActiveMinor = existingDeposits.reduce((sum, deposit) => {
          if (deposit.isDeleted === true) return sum;
          if (deposit.status !== "HELD" && deposit.status !== "APPLIED") return sum;
          return sum + (deposit.amountMinor ?? amountToMinorOrThrow(deposit.amount, currency));
        }, 0);
        if (existingActiveMinor + amountMinor > quoteAmountMinor) {
          throw new ConvexError("Total deposits cannot exceed the quote amount.");
        }

        // Throws if a vehicle is SOLD/ARCHIVED; otherwise patches AVAILABLE -> RESERVED
        // (no-op if already RESERVED — parallel deposits are allowed). A multi-vehicle
        // quote holds every vehicle on the deal, not just the first one.
        const depositVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
        for (const item of depositVehicleItems) {
          await holdVehicleForDeposit(ctx, item.vehicleId);
        }

        const now = Date.now();
        const depositId = await recordHeldDeposit(ctx, {
          orgId: args.orgId,
          vehicleId: quote.vehicleId,
          customerId: quote.customerId,
          quoteId: args.quoteId,
          amount: args.amount,
          amountMinor,
          currency,
          method,
          idempotencyKey: args.idempotencyKey,
          notes: args.notes,
          actorId: user._id,
          now,
          sourceLabel: `quote ${args.quoteId}`,
        });

        // Only multi-vehicle deposits need a join row per vehicle — a
        // single-vehicle deposit is already fully tracked by the deposit's
        // own vehicleId + by_vehicle_hold index.
        if (depositVehicleItems.length > 1) {
          for (const item of depositVehicleItems) {
            await ctx.db.insert("depositVehicleHolds", {
              orgId: args.orgId,
              depositId,
              vehicleId: item.vehicleId,
              active: true,
              createdAt: now,
            });
          }
        }

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
        fingerprint: JSON.stringify({
          depositId: args.depositId,
          resolution: args.resolution,
          notes: args.notes ?? null,
        }),
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
        const currency = normalizeCurrency(deposit.currency ?? await getOrgCurrency(ctx, args.orgId));
        const amountMinor = deposit.amountMinor ?? amountToMinorOrThrow(deposit.amount, currency);
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
          const depositSourceLabel = deposit.quoteId
            ? `quote ${deposit.quoteId}`
            : deposit.reservationId
              ? `reservation ${deposit.reservationId}`
              : "vehicle hold";

          await ctx.db.insert("transactions", {
            orgId: args.orgId,
            type: "OUT",
            amount: deposit.amount,
            date: now,
            category: "DEPOSIT",
            description: `Deposit refund for ${depositSourceLabel} - ${refundVehicleLabel} - ${refundCustomerLabel}`,
            vehicleId: deposit.vehicleId,
            depositId: args.depositId,
            idempotencyKey: args.idempotencyKey,
          });

          const refundPaymentId = await ctx.db.insert("collectionPayments", {
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

          const canonicalRefundPaymentId = await createCanonicalPayment(ctx, {
            orgId: args.orgId,
            direction: "OUT",
            payerType: "CUSTOMER",
            customerId: deposit.customerId,
            method: "OTHER",
            amountMinor,
            currency,
            idempotencyKey: `deposit_refund_${args.depositId}`,
            actorId: user._id,
            status: "SETTLED",
            externalReference: `Deposit refund ${args.depositId}`,
            receivedAt: now,
          });
          await ctx.db.patch(refundPaymentId, { canonicalPaymentId: canonicalRefundPaymentId });

          await hookDepositRefunded(ctx, {
            orgId: args.orgId,
            depositId: args.depositId,
            customerId: deposit.customerId,
            amountMinor,
            currency,
            actorId: user._id,
            occurredAt: now,
          });
        } else {
          await hookDepositForfeited(ctx, {
            orgId: args.orgId,
            depositId: args.depositId,
            customerId: deposit.customerId,
            amountMinor,
            currency,
            actorId: user._id,
            occurredAt: now,
          });
        }

        await releaseAllVehiclesForDeposit(ctx, deposit);

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

export const voidDeposit = mutation({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);

    const deposit = await ctx.db.get(args.depositId);
    if (!deposit || deposit.orgId !== args.orgId || deposit.isDeleted === true) {
      throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
    }
    if (deposit.status !== "HELD") {
      throwAppError(AppErrorCode.DEPOSIT_ALREADY_RESOLVED, "Only HELD deposits can be voided.");
    }

    const now = Date.now();
    await ctx.db.patch(args.depositId, {
      status: "VOIDED",
      isDeleted: true,
      deletedAt: now,
      deletedBy: user._id.toString(),
      holdActive: false,
      resolvedBy: user._id,
      resolvedAt: now,
      notes: args.reason !== undefined ? args.reason : deposit.notes,
    });

    // Voiding means "recorded in error" — every artifact written when the
    // deposit was recorded must be unwound, not just the operational row:
    // the canonical payment, the mirror collectionPayment, and the
    // DEPOSIT_RECEIVED GL posting.
    const canonicalPaymentId =
      deposit.canonicalPaymentId ??
      (
        await ctx.db
          .query("canonicalPayments")
          .withIndex("by_org_idempotency", (q) =>
            q.eq("orgId", args.orgId).eq("idempotencyKey", `deposit_received_${args.depositId}`)
          )
          .unique()
      )?._id;
    if (canonicalPaymentId) {
      await voidCanonicalPayment(ctx, {
        orgId: args.orgId,
        paymentId: canonicalPaymentId,
        actorId: user._id,
      });
    }

    const mirrorPayments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_customer", (q) =>
        q.eq("orgId", args.orgId).eq("customerId", deposit.customerId)
      )
      .filter((q) => q.eq(q.field("reference"), `Deposit ${args.depositId}`))
      .collect();
    for (const mirrorPayment of mirrorPayments) {
      if (mirrorPayment.status !== "VOIDED") {
        await ctx.db.patch(mirrorPayment._id, {
          status: "VOIDED",
          voidedAt: now,
          voidedBy: user._id,
        });
      }
    }

    await hookDepositVoided(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      reason: args.reason ?? "Deposit voided",
      actorId: user._id,
      reversalDate: now,
    });

    // A void means "recorded in error" — no money moved, so the original IN
    // transaction is erased rather than offset with a new OUT (which would
    // make the legacy table look like a refund instead of a reversal).
    const originalInTx = await ctx.db
      .query("transactions")
      .withIndex("by_org_vehicle", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", deposit.vehicleId)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("depositId"), args.depositId),
          q.eq(q.field("type"), "IN"),
          q.neq(q.field("isDeleted"), true)
        )
      )
      .first();
    if (originalInTx) {
      await ctx.db.patch(originalInTx._id, {
        isDeleted: true,
        deletedAt: now,
        deletedBy: user._id.toString(),
      });
    }

    await releaseAllVehiclesForDeposit(ctx, deposit);

    return args.depositId;
  },
});

export const listByVehicle = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const primaryDeposits = await ctx.db
      .query("deposits")
      .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(50);

    // A vehicle can also be a secondary line item on a multi-vehicle deposit,
    // which only ever snapshots its primary vehicleId on the deposits row —
    // pull those in via the join table so this vehicle's deposit history is
    // complete, not just deposits where it happens to be the primary.
    const secondaryHolds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", args.vehicleId))
      .collect();
    const secondaryDeposits = await Promise.all(
      secondaryHolds.map((hold) => ctx.db.get(hold.depositId))
    );

    const byId = new Map<string, Doc<"deposits">>();
    for (const deposit of [...primaryDeposits, ...secondaryDeposits]) {
      if (deposit && deposit.orgId === args.orgId) {
        byId.set(deposit._id, deposit);
      }
    }

    return Array.from(byId.values()).sort((a, b) => b._creationTime - a._creationTime);
  },
});
