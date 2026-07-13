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
import {
  reactivateAllVehiclesForDeposit,
  syncVehicleHoldStatus,
  hasActiveDepositHold,
  hasActiveReservationHold,
} from "./depositHelpers";

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
    reason: string;
    reversalDate: number;
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

  // cancelledAt lets accountingReports.ts's historical AR aging /
  // subledger-vs-GL reconciliation exclude this receivable for any asOfDate
  // on/after cancellation, without also hiding it from reports run for a
  // date BEFORE cancellation (when it was still genuinely outstanding).
  await ctx.db.patch(receivable._id, {
    status: "CANCELLED",
    cancelledAt: args.reversalDate,
    cancelledBy: args.actorId,
    cancellationReason: args.reason,
  });
}

/**
 * Refuses automatic trade-in reversal once the incoming vehicle has any
 * activity beyond its original acceptance that would make silently wiping
 * its cost basis and pulling it from sellable inventory unsafe: it's already
 * been resold, it's currently reserved/held by another transaction, or it
 * has landed costs or capitalized repairs recorded against it. Any of these
 * means a human needs to look at this vehicle before its trade-in can be
 * undone — see the docs/production-audit "trade-in cancellation" gap this
 * closes for the concrete failure mode (a cancelled trade-in reappearing as
 * available, zero-cost-basis inventory that could be sold with wrong COGS).
 */
async function assertTradeInVehicleSafeToReverse(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    tradeInVehicleId: Id<"vehicles">;
    tradeInVehicle: Doc<"vehicles">;
  }
) {
  if (args.tradeInVehicle.status === "SOLD") {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle has already been resold. Use a manual accounting correction."
    );
  }
  if (args.tradeInVehicle.status === "RESERVED") {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle is currently reserved. Use a manual accounting correction."
    );
  }
  const hasHold =
    (await hasActiveDepositHold(ctx, args.tradeInVehicleId)) ||
    (await hasActiveReservationHold(ctx, { orgId: args.orgId, vehicleId: args.tradeInVehicleId }));
  if (hasHold) {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle is currently held by another deposit or reservation. Use a manual accounting correction."
    );
  }

  // landedCostTotal is the same authoritative, kept-in-sync field
  // computeVehicleCapitalizedCost reads (set by vehicles.ts's
  // upsertLandedCosts) — no need to separately query vehicleLandedCosts.
  if (args.tradeInVehicle.landedCostTotal && args.tradeInVehicle.landedCostTotal > 0) {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle has received landed costs since being accepted. Use a manual accounting correction."
    );
  }

  const capitalizedExpense = await ctx.db
    .query("expenses")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.tradeInVehicleId))
    .filter((q) =>
      q.and(
        q.eq(q.field("accountingTreatment"), "CAPITALIZED_INVENTORY"),
        q.neq(q.field("isDeleted"), true)
      )
    )
    .first();
  if (capitalizedExpense) {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle has received capitalized repair/prep costs since being accepted. Use a manual accounting correction."
    );
  }
}

/**
 * Undoes a trade-in fully when the sale it was part of is cancelled: reverses
 * the TRADE_IN_ACCEPTED GL entry, voids the canonical trade-in payment (its
 * allocation was already reversed by cancelSaleReceivableIfSafe, above —
 * voidCanonicalPayment requires that first), clears the vehicle's
 * purchasePrice so it no longer reads as capitalized inventory, and — if it
 * was AVAILABLE — pulls it into IN_INSPECTION so it can't be sold again with
 * a zero cost basis before a human re-establishes one.
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

  const tradeInVehicle = await ctx.db.get(tradeInVehicleId);
  if (!tradeInVehicle || tradeInVehicle.orgId !== args.orgId) return;

  await assertTradeInVehicleSafeToReverse(ctx, {
    orgId: args.orgId,
    tradeInVehicleId,
    tradeInVehicle,
  });

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

  await ctx.db.patch(tradeInVehicleId, {
    purchasePrice: undefined,
    // Only downgrade from AVAILABLE — IN_REPAIR/IN_INSPECTION/SOURCING are
    // already not generally sellable, and ARCHIVED must never be silently
    // un-archived by a reversal.
    ...(tradeInVehicle.status === "AVAILABLE" ? { status: "IN_INSPECTION" as const } : {}),
  });
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
    reason: args.reason,
    reversalDate: args.reversalDate,
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
