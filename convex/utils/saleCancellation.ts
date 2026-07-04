import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { hookDepositApplicationReversed } from "../accounting/workflowHooks";
import { reverseAllocation } from "../subledger";
import { restoreVehicleToAvailable } from "./saleHelpers";
import { syncVehicleHoldStatus } from "./depositHelpers";

async function getActiveReceivableAllocations(
  ctx: MutationCtx,
  receivableDocumentId: Id<"receivableDocuments">
) {
  return await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();
}

async function getAppliedDepositPaymentKeys(
  ctx: MutationCtx,
  quoteId: Id<"quotes"> | undefined
) {
  if (!quoteId) return new Set<string>();
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .filter((q) => q.eq(q.field("status"), "APPLIED"))
    .collect();

  return new Set(deposits.map((deposit) => `deposit_received_${deposit._id}`));
}

async function cancelSaleReceivableIfSafe(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    actorId: Id<"users">;
  }
) {
  if (!args.sale.canonicalReceivableDocumentId) return;
  const receivable = await ctx.db.get(args.sale.canonicalReceivableDocumentId);
  if (!receivable || receivable.orgId !== args.orgId || receivable.status === "CANCELLED") return;

  const activeAllocations = await getActiveReceivableAllocations(ctx, receivable._id);
  const appliedDepositPaymentKeys = await getAppliedDepositPaymentKeys(ctx, args.sale.quoteId);

  for (const allocation of activeAllocations) {
    const payment = await ctx.db.get(allocation.paymentId);
    if (!payment || payment.orgId !== args.orgId || !appliedDepositPaymentKeys.has(payment.idempotencyKey)) {
      throw new ConvexError(
        "Cannot automatically cancel a sale with customer payments already applied. Refund or reverse those payments first."
      );
    }
  }

  for (const allocation of activeAllocations) {
    await reverseAllocation(ctx, {
      orgId: args.orgId,
      allocationId: allocation._id,
      actorId: args.actorId,
    });
  }

  await ctx.db.patch(receivable._id, { status: "CANCELLED" });
}

async function cancelPendingSupplierPayables(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    actorId: Id<"users">;
    now: number;
  }
) {
  const payables = await ctx.db
    .query("vehicleSupplierPayables")
    .withIndex("by_sale", (q) => q.eq("saleId", args.saleId))
    .collect();

  const orgPayables = payables.filter((payable) => payable.orgId === args.orgId);
  if (orgPayables.some((payable) => payable.status === "PAID")) {
    throw new ConvexError(
      "Cannot automatically cancel a sale after the supplier payable has been paid. Use a manual accounting correction."
    );
  }

  for (const payable of orgPayables) {
    if (payable.status === "PENDING") {
      await ctx.db.patch(payable._id, {
        status: "CANCELLED",
        cancelledAt: args.now,
        cancelledBy: args.actorId,
        updatedAt: args.now,
      });
    }
  }
}

async function reinstateAppliedDeposits(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    quoteId: Id<"quotes"> | undefined;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  if (!args.quoteId) return;
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId!))
    .filter((q) => q.eq(q.field("status"), "APPLIED"))
    .collect();

  for (const deposit of deposits) {
    await ctx.db.patch(deposit._id, {
      status: "HELD",
      holdActive: true,
      resolvedBy: undefined,
      resolvedAt: undefined,
    });
    await hookDepositApplicationReversed(ctx, {
      orgId: args.orgId,
      depositId: deposit._id,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });
  }
}

export async function cancelCompletedSaleOperationalRecords(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  if (args.sale.commissionPaidAt != null) {
    throw new ConvexError(
      "Cannot automatically cancel a sale after commission has been paid. Use a manual accounting correction."
    );
  }

  await cancelPendingSupplierPayables(ctx, {
    orgId: args.orgId,
    saleId: args.sale._id,
    actorId: args.actorId,
    now: args.reversalDate,
  });
  await cancelSaleReceivableIfSafe(ctx, {
    orgId: args.orgId,
    sale: args.sale,
    actorId: args.actorId,
  });
  await restoreVehicleToAvailable(ctx, args.sale.vehicleId);
  await reinstateAppliedDeposits(ctx, {
    orgId: args.orgId,
    quoteId: args.sale.quoteId,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
  });
  await syncVehicleHoldStatus(ctx, args.sale.vehicleId, args.actorId);
}
