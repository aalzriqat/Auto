import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookSupplierPaymentSettled, getOrgCurrency } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
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
        const vehicle = await ctx.db.get(p.vehicleId);
        const sale = p.saleId ? await ctx.db.get(p.saleId) : null;
        const customer = sale ? await ctx.db.get(sale.customerId) : null;
        const paidByUser = p.paidBy ? await ctx.db.get(p.paidBy) : null;

        return {
          ...p,
          vehicleDesc: vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}`
            : "Unknown Vehicle",
          vehicleVin: vehicle?.vin,
          customerName: customer
            ? `${customer.firstName} ${customer.lastName}`
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
    const sale = p.saleId ? await ctx.db.get(p.saleId) : null;
    const customer = sale ? await ctx.db.get(sale.customerId) : null;

    return {
      ...p,
      vehicle,
      sale,
      customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
    };
  },
});

export const markPaid = mutation({
  args: {
    orgId: v.id("organizations"),
    payableId: v.id("vehicleSupplierPayables"),
    paymentNotes: v.optional(v.string()),
    paymentMethod: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sourcingPayables.markPaid",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        const payable = await ctx.db.get(args.payableId);
        if (!payable || payable.orgId !== args.orgId) {
          throw new ConvexError("Supplier payable not found.");
        }
        if (payable.status === "PAID") {
          throw new ConvexError("This payable has already been marked as paid.");
        }

        const now = Date.now();
        await ctx.db.patch(args.payableId, {
          status: "PAID",
          paidAt: now,
          paidBy: user._id,
          paymentNotes: args.paymentNotes,
          updatedAt: now,
        });

        const currency = await getOrgCurrency(ctx, args.orgId);
        await hookSupplierPaymentSettled(ctx, {
          orgId: args.orgId,
          payableId: args.payableId,
          sourcedFromName: payable.sourcedFromName,
          amountMinor: toMinorUnits(payable.amountDue, currency),
          currency,
          paymentMethod: args.paymentMethod,
          actorId: user._id,
          occurredAt: now,
        });
      }
    );
  },
});
