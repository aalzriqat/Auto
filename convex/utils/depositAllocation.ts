import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { toMinorUnits } from "./money";

/**
 * How much of a quote's reservation deposit belongs to each car on it.
 *
 * ## Why this is a stored decision and not a calculation
 *
 * The عربون is quote-scoped: one payment, one receipt voucher, one `deposits`
 * row for the whole deal. A quote can carry several cars, each sold on its own
 * sale, so finalizing one of them has to know how much of that one payment is
 * against THAT car — and nothing in the data answers it.
 *
 * Every rule that looks like it would is wrong in a way that ends up in the
 * ledger:
 *
 *  - `deposit.vehicleId` is the quote's FIRST line item, nothing more. Reading
 *    it as an allocation assigns the entire deposit to whichever car was
 *    listed first, and leaves the others looking undeposited.
 *  - `min(heldTotal, thisCarsBill)` lets the first car finalized absorb as much
 *    as it can hold, so the answer depends on the order the sales were closed.
 *  - Proportional-to-price and FIFO are both plausible and both invent a
 *    customer decision nobody made. A customer who put 5,000 down on a 3,000
 *    car and a 20,000 car may well have meant 3,000 and 2,000.
 *
 * So the allocation is entered by a person and persisted on
 * `depositVehicleHolds`. The UI may suggest a split; a suggestion is not an
 * allocation until it is confirmed and stored.
 *
 * ## The invariant
 *
 *     sum(active allocations) <= held quote deposit
 *
 * The difference is the quote-level unallocated balance. It stays a customer
 * deposit liability — not spare change to be swept into whichever sale closes
 * next — until it is explicitly allocated or resolved.
 *
 * ## Single-vehicle quotes
 *
 * Allocated implicitly and in full, because there is exactly one place it can
 * go and no decision to make. `deposits.create` writes no hold rows for those,
 * and this module treats that shape as fully allocated to the one car.
 */

export type VehicleAllocation = {
  vehicleId: Id<"vehicles">;
  /** Absent when no allocation has been entered for this car yet. */
  allocatedMinor: number | undefined;
  status: "ALLOCATED" | "APPLIED" | "RELEASED" | "RESOLVED" | undefined;
  /** What was decided about a RESOLVED slice. */
  resolutionTreatment:
    | "REALLOCATE_TO_VEHICLE"
    | "RETURN_TO_UNALLOCATED"
    | "REFUND_TO_CUSTOMER"
    | "FORFEITED"
    | "OTHER"
    | undefined;
  active: boolean;
  holdId: Id<"depositVehicleHolds">;
};

export type QuoteDepositAllocation = {
  /** Every HELD deposit on the quote, summed. */
  heldTotalMinor: number;
  /** True when the quote carries hold rows, i.e. more than one car. */
  isMultiVehicle: boolean;
  allocations: VehicleAllocation[];
  /** Allocated to a car and not yet consumed or released. */
  allocatedMinor: number;
  /** Consumed by a completed sale. */
  appliedMinor: number;
  /** Released by a cancellation and awaiting an explicit decision. */
  releasedAwaitingDecisionMinor: number;
  /**
   * Refunded to the customer or forfeited — money that has LEFT the quote.
   *
   * Counted out of the available pool for good. Expressing these by zeroing the
   * slice let refunded money reappear as allocatable, which is the same defect
   * as paying it out twice.
   */
  resolvedOutMinor: number;
  /** Held but assigned to no car. Still a customer deposit liability. */
  unallocatedMinor: number;
  /** Cars on the quote that have no allocation entered at all. */
  vehiclesWithoutAllocation: Id<"vehicles">[];
};

/** The deposits still holding something for this quote. */
async function heldDepositsForQuote(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes">
): Promise<Doc<"deposits">[]> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .collect();
  return deposits.filter((d) => d.holdActive && d.isDeleted !== true);
}

/**
 * Every deposit whose money is still on the quote — held OR already applied to
 * one of its sales.
 *
 * The summary has to keep counting a deposit after the last car consumed it,
 * or the allocation view reads as if the customer never paid anything. Only
 * money that genuinely left (refunded, forfeited, voided) drops out.
 */
async function liveDepositsForQuote(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes">
): Promise<Doc<"deposits">[]> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .collect();
  return deposits.filter(
    (d) => d.isDeleted !== true && (d.status === "HELD" || d.status === "APPLIED")
  );
}

/**
 * How many slices of this deposit have already been applied.
 *
 * Carried into the GL event's version, because `postAccountingEvent` dedupes on
 * (eventType, sourceType, sourceId, eventVersion) as well as the idempotency
 * key. One deposit row applied once per car is several movements of money, and
 * without a distinct version the second silently returns "already posted".
 */
export async function appliedAllocationCount(
  ctx: QueryCtx | MutationCtx,
  depositId: Id<"deposits">
): Promise<number> {
  const holds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .collect();
  return holds.filter((h) => h.allocationStatus === "APPLIED").length;
}

function depositMinor(deposit: Doc<"deposits">, currency: string): number {
  return deposit.amountMinor ?? toMinorUnits(deposit.amount, currency);
}

/**
 * The whole allocation picture for a quote: what is held, what is assigned to
 * which car, and what is still floating.
 */
export async function quoteDepositAllocation(
  ctx: QueryCtx | MutationCtx,
  args: { quoteId: Id<"quotes">; currency: string }
): Promise<QuoteDepositAllocation> {
  const deposits = await liveDepositsForQuote(ctx, args.quoteId);
  const heldTotalMinor = deposits.reduce((sum, d) => sum + depositMinor(d, args.currency), 0);

  const allocations: VehicleAllocation[] = [];
  for (const deposit of deposits) {
    const holds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .collect();
    for (const hold of holds) {
      allocations.push({
        vehicleId: hold.vehicleId,
        allocatedMinor: hold.allocatedAmountMinor,
        status: hold.allocationStatus,
        resolutionTreatment: hold.resolutionTreatment,
        active: hold.active,
        holdId: hold._id,
      });
    }
  }

  let allocated = 0;
  let applied = 0;
  let released = 0;
  let resolvedOut = 0;
  const withoutAllocation: Id<"vehicles">[] = [];
  for (const a of allocations) {
    if (a.allocatedMinor === undefined) {
      if (a.active) withoutAllocation.push(a.vehicleId);
      continue;
    }
    if (a.status === "APPLIED") applied += a.allocatedMinor;
    else if (a.status === "RELEASED") released += a.allocatedMinor;
    else if (a.status === "RESOLVED") {
      // Only money that actually left the quote is subtracted. A slice
      // re-allocated to another car, or returned to the unallocated balance, is
      // still on the quote and is already counted where it now lives.
      if (
        a.resolutionTreatment === "REFUND_TO_CUSTOMER" ||
        a.resolutionTreatment === "FORFEITED"
      ) {
        resolvedOut += a.allocatedMinor;
      }
    } else allocated += a.allocatedMinor;
  }

  return {
    heldTotalMinor,
    isMultiVehicle: allocations.length > 0,
    allocations,
    allocatedMinor: allocated,
    appliedMinor: applied,
    releasedAwaitingDecisionMinor: released,
    resolvedOutMinor: resolvedOut,
    // Released slices are deliberately NOT counted as available: they are
    // awaiting a decision, and treating them as spare would move a customer's
    // money from the car it was allocated against to another one by default.
    // Refunded and forfeited slices are gone for good.
    unallocatedMinor: Math.max(
      0,
      heldTotalMinor - allocated - applied - released - resolvedOut
    ),
    vehiclesWithoutAllocation: withoutAllocation,
  };
}

export type VehicleDepositAllocation =
  | { kind: "SINGLE_VEHICLE_QUOTE"; allocatedMinor: number }
  | { kind: "ALLOCATED"; allocatedMinor: number; holdId: Id<"depositVehicleHolds"> }
  | { kind: "NOT_ALLOCATED" }
  | { kind: "NO_DEPOSIT"; allocatedMinor: 0 };

/**
 * How much of the quote's deposit this one car may consume when it completes.
 *
 * This is the ONLY figure a sale finalization may use. Comparing the whole
 * quote's deposit against one line item's bill is what made a two-car quote
 * demand a deposit treatment on the first completion and then refuse every
 * treatment offered — with no client able to supply one.
 */
export async function allocatedDepositForVehicle(
  ctx: QueryCtx | MutationCtx,
  args: { quoteId: Id<"quotes">; vehicleId: Id<"vehicles">; currency: string }
): Promise<VehicleDepositAllocation> {
  const deposits = await heldDepositsForQuote(ctx, args.quoteId);
  if (deposits.length === 0) return { kind: "NO_DEPOSIT", allocatedMinor: 0 };

  // Summed across every deposit on the quote, because a customer can pay the
  // عربون in more than one instalment and each payment is its own row with its
  // own hold rows. Returning the first match consumed one instalment's share
  // and left the rest of the customer's money sitting unapplied.
  let sawHoldRows = false;
  let totalAllocatedMinor = 0;
  let anyAllocation = false;
  let firstHoldId: Id<"depositVehicleHolds"> | undefined;
  for (const deposit of deposits) {
    const holds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .collect();
    if (holds.length > 0) sawHoldRows = true;

    for (const hold of holds) {
      if (hold.vehicleId !== args.vehicleId) continue;
      if (!hold.active) continue;
      if (hold.allocatedAmountMinor === undefined) continue;
      totalAllocatedMinor += hold.allocatedAmountMinor;
      anyAllocation = true;
      firstHoldId ??= hold._id;
    }
  }
  if (anyAllocation) {
    return { kind: "ALLOCATED", allocatedMinor: totalAllocatedMinor, holdId: firstHoldId! };
  }

  // No hold rows at all: `deposits.create` writes them only for quotes with
  // more than one car, so this is the single-vehicle shape — one place the
  // money can go and no decision to make.
  if (!sawHoldRows) {
    return {
      kind: "SINGLE_VEHICLE_QUOTE",
      allocatedMinor: deposits.reduce((sum, d) => sum + depositMinor(d, args.currency), 0),
    };
  }

  return { kind: "NOT_ALLOCATED" };
}

/** Raised when a multi-vehicle quote is finalized before anyone allocated its deposit. */
export function throwAllocationRequired(): never {
  throw new ConvexError(
    "This quote covers more than one vehicle and its reservation deposit has not been allocated between them. Record how much of the deposit belongs to this vehicle before completing its sale — the split is the customer's decision and cannot be inferred from the prices."
  );
}

/**
 * Marks a vehicle's slice as consumed by its sale.
 *
 * The deposit row itself stays HELD while any other car on the quote still has
 * a live allocation; only when nothing is left to consume does the deposit
 * become APPLIED. A single row cannot be half-APPLIED, so the per-vehicle
 * consumption is tracked here and the row's own status follows it.
 */
export async function markAllocationApplied(
  ctx: MutationCtx,
  args: { holdId: Id<"depositVehicleHolds">; saleId: Id<"sales">; actorId: Id<"users"> }
): Promise<void> {
  await ctx.db.patch(args.holdId, {
    allocationStatus: "APPLIED",
    appliedSaleId: args.saleId,
    active: false,
    resolvedAt: Date.now(),
    resolvedBy: args.actorId,
  });
}

/** True once no active allocation remains against this deposit. */
export async function depositFullyConsumed(
  ctx: QueryCtx | MutationCtx,
  depositId: Id<"deposits">
): Promise<boolean> {
  const holds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .collect();
  if (holds.length === 0) return true;
  return holds.every((h) => h.active === false);
}

/**
 * Validates a proposed set of allocations against the invariant, in minor units.
 *
 * Kept pure so the client can check a split before submitting it and get the
 * identical answer the mutation will give.
 */
export function validateAllocationTotals(args: {
  heldTotalMinor: number;
  /** Already consumed by completed sales — not available to re-allocate. */
  appliedMinor: number;
  /** Awaiting an explicit decision after a cancellation — also not available. */
  releasedAwaitingDecisionMinor: number;
  proposedMinor: number[];
}): { ok: true; unallocatedMinor: number } | { ok: false; reason: string } {
  for (const amount of args.proposedMinor) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return { ok: false, reason: "Each allocation must be a whole, non-negative amount." };
    }
  }
  const proposedTotal = args.proposedMinor.reduce((sum, a) => sum + a, 0);
  const available =
    args.heldTotalMinor - args.appliedMinor - args.releasedAwaitingDecisionMinor;
  if (proposedTotal > available) {
    return {
      ok: false,
      reason: `The allocations total more than the deposit has left to give. Available: ${available}; requested: ${proposedTotal}.`,
    };
  }
  return { ok: true, unallocatedMinor: available - proposedTotal };
}
