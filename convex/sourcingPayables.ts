import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookSupplierPaymentSettled } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";
import { normalizePaymentMethod, paymentMethodValidator } from "./utils/paymentMethods";
import { Id } from "./_generated/dataModel";
import { getActiveDepositHolds } from "./utils/depositHelpers";

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("CANCELLED"))),
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
        if (args.taxAmount !== undefined && (!Number.isFinite(args.taxAmount) || args.taxAmount < 0)) {
          throw new ConvexError("VAT amount cannot be negative.");
        }
        if (args.taxAmount !== undefined && args.taxAmount > payable.amountDue) {
          throw new ConvexError("VAT amount cannot exceed the amount due.");
        }

        const now = Date.now();
        await ctx.db.patch(args.payableId, {
          status: "PAID",
          paidAt: now,
          paidBy: user._id,
          paymentMethod,
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
          amountMinor: toMinorUnits(payable.amountDue, currency),
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
