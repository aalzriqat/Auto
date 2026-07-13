import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  hookDepositApplicationReversed,
  hookTradeInReversed,
  hookFiCommissionRecognitionsReversed,
} from "../accounting/workflowHooks";
import { reverseAllocation, voidCanonicalPayment } from "../subledger";
import { restoreVehicleToAvailable } from "./saleHelpers";
import { reactivateAllVehiclesForDeposit, syncVehicleHoldStatus } from "./depositHelpers";

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

/**
 * Idempotency keys of payments this routine already knows how to safely
 * reverse (in addition to actually reversing them, below) — anything else
 * found allocated against the receivable is an unexpected customer payment,
 * which still blocks automatic cancellation.
 */
async function getSafelyReversiblePaymentKeys(
  ctx: MutationCtx,
  sale: Doc<"sales">
) {
  const keys = new Set<string>();
  if (sale.tradeInVehicleId) {
    keys.add(`trade_in_payment_${sale._id}`);
  }
  if (!sale.quoteId) return keys;
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", sale.quoteId!))
    .filter((q) => q.eq(q.field("status"), "APPLIED"))
    .collect();
  for (const deposit of deposits) {
    keys.add(`deposit_received_${deposit._id}`);
  }
  return keys;
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
  const safeKeys = await getSafelyReversiblePaymentKeys(ctx, args.sale);

  for (const allocation of activeAllocations) {
    const payment = await ctx.db.get(allocation.paymentId);
    if (!payment || payment.orgId !== args.orgId || !safeKeys.has(payment.idempotencyKey)) {
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

/**
 * Undoes a trade-in fully when the sale it was part of is cancelled: reverses
 * the TRADE_IN_ACCEPTED GL entry, voids the canonical trade-in payment (its
 * allocation was already reversed by cancelSaleReceivableIfSafe, above —
 * voidCanonicalPayment requires that first), and clears the vehicle's
 * purchasePrice so it no longer reads as capitalized inventory.
 */
async function restoreTradeInVehicle(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  const tradeInVehicleId = args.sale.tradeInVehicleId;
  // Must match saleCompletion.ts's exact gate (tradeInVehicleId && tradeInValue
  // > 0) — a sale can store a tradeInVehicleId with no positive tradeInValue,
  // in which case completion never ran the trade-in branch at all. Without
  // this check, cancelling such a sale would still wipe the vehicle's
  // unrelated, legitimate purchasePrice (e.g. from a normal acquisition).
  if (!tradeInVehicleId || !args.sale.tradeInValue || args.sale.tradeInValue <= 0) return;

  const payment = await ctx.db
    .query("canonicalPayments")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", `trade_in_payment_${args.sale._id}`)
    )
    .unique();
  if (payment && payment.status !== "VOIDED") {
    await voidCanonicalPayment(ctx, {
      orgId: args.orgId,
      paymentId: payment._id,
      actorId: args.actorId,
    });
  }

  await hookTradeInReversed(ctx, {
    orgId: args.orgId,
    vehicleId: tradeInVehicleId,
    saleId: args.sale._id,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
  });

  const tradeInVehicle = await ctx.db.get(tradeInVehicleId);
  if (tradeInVehicle && tradeInVehicle.orgId === args.orgId) {
    await ctx.db.patch(tradeInVehicleId, { purchasePrice: undefined });
  }
}

/**
 * Cancels every warranty/GAP deferral created at sale completion, clawing
 * back any month(s) of F&I commission already recognized and stopping the
 * monthly cron from recognizing any more (by moving it out of ACTIVE).
 */
async function cancelProductDeferrals(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  const deferrals = await ctx.db
    .query("dealerProductDeferrals")
    .withIndex("by_sale", (q) => q.eq("saleId", args.saleId))
    .collect();

  for (const deferral of deferrals) {
    if (deferral.orgId !== args.orgId || deferral.status === "CANCELLED") continue;
    await hookFiCommissionRecognitionsReversed(ctx, {
      orgId: args.orgId,
      deferralId: deferral._id,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });
    await ctx.db.patch(deferral._id, { status: "CANCELLED" });
  }
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
    // Puts every vehicle on the deposit's quote back on hold, not just
    // whichever vehicle belongs to the sale row being cancelled — a
    // multi-vehicle quote's other vehicles would otherwise stay AVAILABLE
    // despite the deposit being active again.
    await reactivateAllVehiclesForDeposit(ctx, deposit);
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
  // Must run after cancelSaleReceivableIfSafe: voidCanonicalPayment requires
  // the trade-in's payment allocation (reversed above) to no longer be ACTIVE.
  await restoreTradeInVehicle(ctx, {
    orgId: args.orgId,
    sale: args.sale,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
  });
  await cancelProductDeferrals(ctx, {
    orgId: args.orgId,
    saleId: args.sale._id,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
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
