import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookSupplierPaymentSettled } from "./accounting/workflowHooks";
import { fromMinorUnits, toMinorUnits } from "./utils/money";
import { normalizePaymentMethod, paymentMethodValidator } from "./utils/paymentMethods";
import { Id } from "./_generated/dataModel";
import { getActiveDepositHolds } from "./utils/depositHelpers";

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(
      v.union(
        v.literal("PENDING"),
        v.literal("NOT_YET_DUE"),
        v.literal("DUE_ON_SALE"),
        v.literal("PARTIALLY_PAID"),
        v.literal("PAID"),
        v.literal("DISPUTED"),
        v.literal("CANCELLED")
      )
    ),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    let payables;
    if (args.status) {
      payables = await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status!))
        .order("desc")
        .collect();
    } else {
      payables = await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .collect();
    }

    return await Promise.all(
      payables.map(async (p) => {
        // Guard: only surface joined records that belong to this org.
        const vehicle = await ctx.db.get(p.vehicleId);
        const safeVehicle = vehicle?.orgId === args.orgId ? vehicle : null;

        const sale = p.saleId ? await ctx.db.get(p.saleId) : null;
        const safeSale = sale?.orgId === args.orgId ? sale : null;

        const customer = safeSale ? await ctx.db.get(safeSale.customerId) : null;
        const safeCustomer = customer?.orgId === args.orgId ? customer : null;

        const paidByUser = p.paidBy ? await ctx.db.get(p.paidBy) : null;

        return {
          ...p,
          vehicleDesc: safeVehicle
            ? `${safeVehicle.year} ${safeVehicle.make} ${safeVehicle.model}${safeVehicle.trim ? ` ${safeVehicle.trim}` : ""}`
            : "Unknown Vehicle",
          vehicleVin: safeVehicle?.vin,
          customerName: safeCustomer
            ? `${safeCustomer.firstName} ${safeCustomer.lastName}`
            : null,
          paidByName: paidByUser && "name" in paidByUser ? paidByUser.name : null,
          daysOutstanding: Math.floor((Date.now() - p.createdAt) / (24 * 60 * 60 * 1000)),
        };
      })
    );
  },
});

/**
 * The live special-order pipeline: cars being sourced from another dealer on a
 * customer's behalf that have not yet been sold.
 *
 * This is the half of the Special Orders page that was named and described but
 * never built. `vehicleSupplierPayables` rows — the only thing the page showed
 * — are written at SALE COMPLETION (utils/saleCompletion.ts) or at acquisition
 * for owned stock bought ON_ACCOUNT, so a special order in progress produced no
 * row at all and the page sat empty for exactly as long as the order was live,
 * then filled up once it was over.
 *
 * A sourced car is in the pipeline while it is SOURCING, RESERVED (a customer
 * deposit is holding it) or AVAILABLE. SOLD and ARCHIVED cars drop out — at
 * that point the payable exists and the table below covers it.
 *
 * Arrival is read from `vehicle.arrivedAt`, not from the status: a car that
 * arrives while a deposit is holding it stays RESERVED, so status alone cannot
 * distinguish "still at the source dealer" from "here and spoken for".
 */
export const listPipeline = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    // Keyed on sourceType so this reads only sourced cars. Going through
    // by_org_status meant fetching every AVAILABLE vehicle in the org — the
    // entire lot — to keep the handful that are drop-ships.
    const pipelineStatuses = ["SOURCING", "RESERVED", "AVAILABLE"] as const;
    const byStatus = await Promise.all(
      pipelineStatuses.map((status) =>
        ctx.db
          .query("vehicles")
          .withIndex("by_org_sourceType_status", (q) =>
            q.eq("orgId", args.orgId).eq("sourceType", "SOURCED").eq("status", status)
          )
          .filter((q) => q.neq(q.field("isDeleted"), true))
          .collect()
      )
    );

    const sourcedVehicles = byStatus.flat();
    const now = Date.now();

    const rows = await Promise.all(
      sourcedVehicles.map(async (vehicle) => {
        // Who the car is being sourced for. A deposit taken in the sales wizard
        // is the strongest signal; an active reservation is the fallback.
        //
        // getActiveDepositHolds covers secondary vehicles on a multi-vehicle
        // quote, which live only in depositVehicleHolds — reading the deposits
        // table alone showed car 2 of a three-car deal with no customer and no
        // deposit while it was genuinely held.
        const activeDeposits = (await getActiveDepositHolds(ctx, vehicle._id)).filter(
          (deposit) => deposit.orgId === args.orgId
        );
        const depositTotal = activeDeposits.reduce((sum, deposit) => sum + deposit.amount, 0);

        let customerId: Id<"customers"> | null = activeDeposits[0]?.customerId ?? null;
        if (!customerId) {
          // Stream rather than take a fixed page: a reservation keeps
          // status ACTIVE until a sweep expires it and this index is
          // oldest-first, so stale rows could fill the page ahead of the live
          // one and leave the order showing an unassigned customer.
          for await (const reservation of ctx.db
            .query("vehicleReservations")
            .withIndex("by_org_vehicle_status", (q) =>
              q.eq("orgId", args.orgId).eq("vehicleId", vehicle._id).eq("status", "ACTIVE")
            )) {
            if (reservation.expiresAt === undefined || reservation.expiresAt > now) {
              customerId = reservation.customerId;
              break;
            }
          }
        }

        const customer = customerId ? await ctx.db.get(customerId) : null;
        const safeCustomer = customer?.orgId === args.orgId ? customer : null;

        return {
          _id: vehicle._id,
          vehicleDesc: `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}`,
          vin: vehicle.vin,
          status: vehicle.status,
          arrivedAt: vehicle.arrivedAt ?? null,
          hasArrived: vehicle.arrivedAt != null,
          isHeld: depositTotal > 0 || vehicle.status === "RESERVED",
          sourcedFromName: vehicle.sourcedFromName ?? null,
          sourceCost: vehicle.sourceCost ?? 0,
          sellingPrice: vehicle.sellingPrice,
          customerName: safeCustomer
            ? `${safeCustomer.firstName} ${safeCustomer.lastName}`.trim()
            : null,
          depositTotal,
          daysWaiting: Math.floor((now - (vehicle.createdAt ?? vehicle._creationTime)) / (24 * 60 * 60 * 1000)),
        };
      })
    );

    return rows.sort((a, b) => b.daysWaiting - a.daysWaiting);
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    payableId: v.id("vehicleSupplierPayables"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const p = await ctx.db.get(args.payableId);
    if (!p || p.orgId !== args.orgId) return null;

    const vehicle = await ctx.db.get(p.vehicleId);
    const safeVehicle = vehicle?.orgId === args.orgId ? vehicle : null;

    const sale = p.saleId ? await ctx.db.get(p.saleId) : null;
    const safeSale = sale?.orgId === args.orgId ? sale : null;

    const customer = safeSale ? await ctx.db.get(safeSale.customerId) : null;
    const safeCustomer = customer?.orgId === args.orgId ? customer : null;

    return {
      ...p,
      vehicle: safeVehicle,
      sale: safeSale,
      customerName: safeCustomer ? `${safeCustomer.firstName} ${safeCustomer.lastName}` : null,
    };
  },
});

export const markPaid = mutation({
  args: {
    orgId: v.id("organizations"),
    payableId: v.id("vehicleSupplierPayables"),
    paymentNotes: v.optional(v.string()),
    paymentMethod: v.optional(paymentMethodValidator),
    /** Cheque number or transfer reference. */
    paymentReference: v.optional(v.string()),
    /** The bank or cash account the money left. */
    paymentAccountId: v.optional(v.id("chartOfAccounts")),
    taxAmount: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const paymentMethod = normalizePaymentMethod(args.paymentMethod);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sourcingPayables.markPaid",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ payableId: args.payableId, paymentMethod, taxAmount: args.taxAmount ?? null }),
      },
      async () => {
        const payable = await ctx.db.get(args.payableId);
        if (!payable || payable.orgId !== args.orgId) {
          throw new ConvexError("Supplier payable not found.");
        }
        if (payable.status === "PAID") {
          throw new ConvexError("This payable has already been marked as paid.");
        }
        if (payable.status === "CANCELLED") {
          throw new ConvexError("This payable was cancelled with its sale.");
        }
        // Only what is still owed. Posting `amountDue` on a partially-paid row
        // would discharge AP-Suppliers a second time for the instalments
        // already posted, leaving the account short by exactly what had been
        // paid so far.
        const alreadyPaidBeforeSettle = payable.amountPaid ?? 0;
        const remainingToSettle = payable.amountDue - alreadyPaidBeforeSettle;
        if (remainingToSettle <= 0) {
          throw new ConvexError("This payable has already been paid in full.");
        }
        if (args.taxAmount !== undefined && (!Number.isFinite(args.taxAmount) || args.taxAmount < 0)) {
          throw new ConvexError("VAT amount cannot be negative.");
        }
        if (args.taxAmount !== undefined && args.taxAmount > remainingToSettle) {
          throw new ConvexError(
            "VAT amount cannot exceed the amount still outstanding on this payable."
          );
        }

        const now = Date.now();
        await ctx.db.patch(args.payableId, {
          status: "PAID",
          // Settling in full is exactly that: the whole entitlement recorded as
          // paid. Left at zero, `settlementView` would have to keep special-
          // casing this row forever to avoid reporting a settled supplier as
          // still owed the lot.
          amountPaid: payable.amountDue,
          paymentSeq: (payable.paymentSeq ?? 0) + 1,
          paidAt: now,
          paidBy: user._id,
          paymentMethod,
          paymentReference: args.paymentReference,
          paymentAccountId: args.paymentAccountId,
          paymentNotes: args.paymentNotes,
          taxAmount: args.taxAmount,
          updatedAt: now,
        });

        // Use the currency snapshotted at sale time — not the current org
        // currency — so settlement always matches the original AP posting scale.
        const currency = payable.currency;
        // A payable with a linked sale was created at SALE time for a sourced
        // vehicle (AP credited against COST_OF_VEHICLES_SOLD — sourced vehicles
        // never touch Vehicle Inventory), so it's unconditionally COGS. A payable
        // with no linked sale was created at ACQUISITION time for an owned
        // vehicle bought ON_ACCOUNT (AP credited against Vehicle Inventory) —
        // but if that vehicle has since sold, its cost has already been relieved
        // out of Vehicle Inventory into COGS by the normal sale posting, so the
        // reclass must follow it there rather than crediting an account the
        // vehicle's cost no longer sits in.
        let costOrigin: "COGS" | "VEHICLE_INVENTORY" = "COGS";
        if (payable.saleId == null) {
          const vehicle = await ctx.db.get(payable.vehicleId);
          costOrigin = vehicle?.status === "SOLD" ? "COGS" : "VEHICLE_INVENTORY";
        }
        await hookSupplierPaymentSettled(ctx, {
          orgId: args.orgId,
          payableId: args.payableId,
          sourcedFromName: payable.sourcedFromName,
          amountMinor: toMinorUnits(remainingToSettle, currency),
          paymentSeq: (payable.paymentSeq ?? 0) + 1,
          taxMinor: args.taxAmount ? toMinorUnits(args.taxAmount, currency) : undefined,
          currency,
          paymentMethod,
          costOrigin,
          actorId: user._id,
          occurredAt: now,
        });
      }
    );
  },
});

/**
 * Records part of what a supplier is owed, without closing the payable.
 *
 * `markPaid` settles the whole entitlement in one movement and posts the GL
 * entry for it. Real settlements arrive in instalments — a cheque on account, a
 * transfer for the balance — and forcing those through `markPaid` meant either
 * recording a payment that had not happened or leaving the supplier's balance
 * untouched until the last one landed.
 *
 * Each instalment posts its own GL entry, discharging AP-Suppliers by exactly
 * what moved. It did not, originally, on the reasoning that `settlementView`
 * reports the balance either way — which is true of a part payment and false of
 * the last one: the row reached PAID with no entry ever raised, and `markPaid`
 * (the only path that raises one) refuses a PAID payable. The supplier then
 * read as settled everywhere except the ledger, and nothing could discharge the
 * liability again.
 */
export const recordPartialPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    payableId: v.id("vehicleSupplierPayables"),
    amount: v.number(),
    paymentMethod: v.optional(paymentMethodValidator),
    paymentReference: v.optional(v.string()),
    paymentAccountId: v.optional(v.id("chartOfAccounts")),
    paymentNotes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const paymentMethod = normalizePaymentMethod(args.paymentMethod);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sourcingPayables.recordPartialPayment",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          payableId: args.payableId,
          amount: args.amount,
          paymentMethod,
          paymentReference: args.paymentReference ?? null,
        }),
      },
      async () => {
        const payable = await ctx.db.get(args.payableId);
        if (!payable || payable.orgId !== args.orgId) {
          throw new ConvexError("Supplier payable not found.");
        }
        if (!Number.isFinite(args.amount) || args.amount <= 0) {
          throw new ConvexError("A payment must be greater than zero.");
        }
        if (payable.status === "CANCELLED") {
          throw new ConvexError("This payable was cancelled with its sale.");
        }
        if (payable.status === "PAID") {
          throw new ConvexError("This payable is already settled in full.");
        }
        if (payable.status === "DISPUTED") {
          throw new ConvexError(
            "This payable is under dispute. Resolve the dispute before paying against it."
          );
        }

        // The payment must be representable in the payable's currency. JOD
        // carries three decimals, so two payments of 0.0005 would otherwise
        // settle a 0.001 payable while each accounting hook rounded to a fils —
        // discharging two fils from the ledger against a one-fils liability.
        // The mirror of the guard on the receivable side.
        if (
          fromMinorUnits(toMinorUnits(args.amount, payable.currency), payable.currency) !==
          args.amount
        ) {
          throw new ConvexError(
            `A payment in ${payable.currency} cannot be finer than the currency allows. Round ${args.amount} to the nearest representable amount.`
          );
        }

        const alreadyPaid = payable.amountPaid ?? 0;
        const projected = alreadyPaid + args.amount;
        // Both comparisons in integer minor units, the same fix applied to
        // `supplierReceivables.recordReceipt`. In major units they were float
        // comparisons against an accumulated float, which made a payable
        // permanently unsettleable: 4.440 JOD paid as three instalments of
        // 1.480 accumulates to 4.4399999999999995, so `=== amountDue` was false
        // and the status stayed PARTIALLY_PAID, while `> amountDue` rejected any
        // further payment because the residue owing is under a thousandth of a
        // fils. The supplier had been paid in full and nothing could record it.
        const dueMinor = toMinorUnits(payable.amountDue, payable.currency);
        const projectedMinor = toMinorUnits(projected, payable.currency);
        // Paying a supplier more than he is owed is a real error with real
        // money behind it, and netting it into the next payable hides which
        // deal it happened on.
        if (projectedMinor > dueMinor) {
          throw new ConvexError(
            `That would pay ${projected} against ${payable.amountDue} owed. Reduce the amount, or correct the entitlement first.`
          );
        }

        const now = Date.now();
        const settlesInFull = projectedMinor === dueMinor;
        const paymentSeq = (payable.paymentSeq ?? 0) + 1;
        await ctx.db.patch(args.payableId, {
          amountPaid: projected,
          status: settlesInFull ? "PAID" : "PARTIALLY_PAID",
          ...(settlesInFull ? { paidAt: now, paidBy: user._id } : {}),
          paymentMethod,
          paymentReference: args.paymentReference,
          paymentAccountId: args.paymentAccountId,
          paymentNotes: args.paymentNotes,
          paymentSeq,
          updatedAt: now,
        });

        // Same cost-origin reasoning as markPaid: a payable with a linked sale
        // credited AP against COGS at sale time; one without credited Vehicle
        // Inventory at acquisition, unless the vehicle has since sold and its
        // cost has already moved to COGS.
        let costOrigin: "COGS" | "VEHICLE_INVENTORY" = "COGS";
        if (payable.saleId == null) {
          const vehicle = await ctx.db.get(payable.vehicleId);
          costOrigin = vehicle?.status === "SOLD" ? "COGS" : "VEHICLE_INVENTORY";
        }
        await hookSupplierPaymentSettled(ctx, {
          orgId: args.orgId,
          payableId: args.payableId,
          sourcedFromName: payable.sourcedFromName,
          amountMinor: toMinorUnits(args.amount, payable.currency),
          currency: payable.currency,
          paymentMethod,
          costOrigin,
          paymentSeq,
          actorId: user._id,
          occurredAt: now,
        });

        // The remainder is derived from the integers, not from a major-unit
        // subtraction. That difference returns a residue like 4.4e-16 on a row
        // this same call just marked PAID — and a caller that passes the
        // returned balance back as its next payment would hand the guard above
        // an amount it rejects as unrepresentable. A float must not leak out of
        // the path whose whole purpose was to move this to integers.
        return {
          amountPaid: projected,
          remainingAmount: fromMinorUnits(Math.max(0, dueMinor - projectedMinor), payable.currency),
        };
      }
    );
  },
});

/**
 * Marks a supplier's entitlement as disputed, or lifts the dispute.
 *
 * A disputed figure is not a payable that happens to be unpaid — it is one
 * nobody has agreed. Payment is refused while it stands, so the dispute cannot
 * be settled by quietly paying it.
 */
export const setDisputed = mutation({
  args: {
    orgId: v.id("organizations"),
    payableId: v.id("vehicleSupplierPayables"),
    disputed: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const payable = await ctx.db.get(args.payableId);
    if (!payable || payable.orgId !== args.orgId) {
      throw new ConvexError("Supplier payable not found.");
    }
    if (payable.status === "CANCELLED") {
      throw new ConvexError("This payable was cancelled with its sale.");
    }
    if (payable.status === "PAID") {
      throw new ConvexError("This payable is already settled. Reverse the payment first.");
    }

    const now = Date.now();
    if (args.disputed) {
      const reason = args.reason?.trim();
      // A dispute blocks payment, so the reason is the only record of why the
      // supplier is not being paid. Left optional it would be blank exactly
      // when somebody needs it.
      if (!reason) {
        throw new ConvexError("Say what is disputed — it is the reason the supplier is not being paid.");
      }
      await ctx.db.patch(args.payableId, {
        status: "DISPUTED",
        disputedAt: now,
        disputedBy: user._id,
        disputeReason: reason,
        updatedAt: now,
      });
    } else {
      // Back to whatever the money says, not to a remembered previous status:
      // payments may have been recorded while the dispute stood.
      const alreadyPaid = payable.amountPaid ?? 0;
      await ctx.db.patch(args.payableId, {
        status: alreadyPaid > 0 ? "PARTIALLY_PAID" : "DUE_ON_SALE",
        disputedAt: undefined,
        disputedBy: undefined,
        disputeReason: undefined,
        updatedAt: now,
      });
    }
    return args.payableId;
  },
});
