import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookSupplierPaymentSettled } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";
import { normalizePaymentMethod, paymentMethodValidator } from "./utils/paymentMethods";

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
        await hookSupplierPaymentSettled(ctx, {
          orgId: args.orgId,
          payableId: args.payableId,
          sourcedFromName: payable.sourcedFromName,
          amountMinor: toMinorUnits(payable.amountDue, currency),
          taxMinor: args.taxAmount ? toMinorUnits(args.taxAmount, currency) : undefined,
          currency,
          paymentMethod,
          // A payable with no linked sale was created at ACQUISITION time for
          // an owned vehicle bought ON_ACCOUNT (AP credited against Vehicle
          // Inventory, not COGS) — see vehicles.postVehicleAcquisitionIfOwned.
          costOrigin: payable.saleId == null ? "VEHICLE_INVENTORY" : "COGS",
          actorId: user._id,
          occurredAt: now,
        });
      }
    );
  },
});
