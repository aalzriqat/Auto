import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { toMinorUnits } from "./money";
import { liveApplicationsForDeposit } from "./depositApplications";
import { depositsForQuoteLineage } from "../commitments";

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
 * ## The conservation invariant
 *
 * Every dinar the customer paid sits in exactly one bucket:
 *
 *     unallocated
 *   + allocated but not applied
 *   + applied to sales that still stand
 *   + mid-reversal
 *   + released and awaiting a decision
 *   + refunded
 *   + forfeited
 *   + other explicitly finalized treatments
 *   = total received
 *
 * `assertQuoteDepositConservation` recomputes it after anything moves deposit
 * money. Nothing is inferred from a deposit row's own status: a row can be
 * partly applied to one car and partly refunded, so its status describes the
 * last thing that happened to it and not where the money is.
 *
 * ## Single-vehicle quotes
 *
 * Allocated implicitly and in full, because there is exactly one place it can
 * go and no decision to make. `deposits.create` writes no hold rows for those,
 * and this module treats that shape as fully allocated to the one car.
 */

export type AllocationStatus =
  | "ALLOCATED"
  | "APPLIED"
  | "REVERSING"
  | "RELEASED_AWAITING_DECISION"
  | "RESOLVED";

export type ResolutionTreatment =
  | "REALLOCATE_TO_VEHICLE"
  | "RETURN_TO_UNALLOCATED"
  | "REFUND_TO_CUSTOMER"
  | "FORFEITED"
  | "OTHER";

export type VehicleAllocation = {
  vehicleId: Id<"vehicles">;
  /** Absent when no allocation has been entered for this car yet. */
  allocatedMinor: number | undefined;
  status: AllocationStatus | undefined;
  /** What was decided about a RESOLVED slice. */
  resolutionTreatment: ResolutionTreatment | undefined;
  active: boolean;
  holdId: Id<"depositVehicleHolds">;
  depositId: Id<"deposits">;
};

export type QuoteDepositAllocation = {
  /** Every dinar the customer has paid on this quote and not had voided. */
  totalReceivedMinor: number;
  /**
   * Kept as an alias of the total received, because that is what the phrase
   * means to everything that reads it: the ceiling an allocation may not
   * exceed. It is NOT the same as the sum of rows whose status says HELD — a
   * row can be part-applied and part-refunded, and its status only records
   * whichever happened last.
   */
  heldTotalMinor: number;
  /** True when the quote carries hold rows, i.e. more than one car. */
  isMultiVehicle: boolean;
  allocations: VehicleAllocation[];
  /**
   * The payments themselves, and how much of each is already spoken for.
   *
   * A quote can be paid in instalments, and each payment is a separate row with
   * its own receipt voucher and its own canonical payment. An allocation is
   * settled against the payment it comes out of, so a car's share has to be
   * spread across rows that can actually cover it — writing a car's whole share
   * onto one row asked a 3,000 payment to settle 5,000 and the subledger
   * refused it, from a total that was perfectly valid.
   */
  depositRows: Array<{
    depositId: Id<"deposits">;
    amountMinor: number;
    /** Applied, refunded, forfeited or otherwise finalized out of this row. */
    committedMinor: number;
  }>;
  /** Assigned to a car and not yet consumed, released or resolved. */
  allocatedMinor: number;
  /** Consumed by sales that still stand. */
  appliedMinor: number;
  /** Consumed by a sale that was cancelled, whose journal reversal is still in flight. */
  reversingMinor: number;
  /** Off its car and awaiting an explicit decision. */
  releasedAwaitingDecisionMinor: number;
  /** Paid back to the customer. Gone. */
  refundedMinor: number;
  /** Kept by the dealership under an approved forfeiture. Gone from the pool. */
  forfeitedMinor: number;
  /** Finalized under an explicitly recorded treatment the system does not post. */
  otherFinalizedMinor: number;
  /**
   * Refunded + forfeited + otherwise finalized — money that has LEFT the quote.
   *
   * Counted out of the available pool for good. Expressing these by zeroing the
   * slice let refunded money reappear as allocatable, which is the same defect
   * as paying it out twice.
   */
  resolvedOutMinor: number;
  /** Held but assigned to no car. Still a customer deposit liability. */
  unallocatedMinor: number;
  /**
   * What an allocation may divide up: the unallocated balance PLUS everything
   * currently allocated but not yet consumed.
   *
   * Allocating is an edit of the whole split, not an addition to it — a car's
   * existing share is released back into the pot before the new numbers are
   * checked. Leaving it out made a fully allocated quote impossible to
   * re-balance: moving 1,000 from one car to another read as an overdraw
   * because the money being moved was counted as still spent.
   */
  availableForAllocationMinor: number;
  /** Cars on the quote that have no allocation entered at all. */
  vehiclesWithoutAllocation: Id<"vehicles">[];
};

/** The deposits still holding something for this quote. */
async function heldDepositsForQuote(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes">
): Promise<Doc<"deposits">[]> {
  // SCRUM-195: the DEAL's money, not the quote id's.
  //
  // This is the gate the whole completion path hangs off — an empty result
  // returns NO_DEPOSIT and short-circuits before any deposit is applied. Read
  // per-quote, a deal that took a deposit on Q1 and completed on a linked Q2
  // reported "no deposit", finished the sale, and left the customer's payment
  // sitting on a superseded quote: never refunded, never credited against what
  // they owed, and still counted as an outstanding deposit liability.
  //
  // `depositsForQuoteLineage` falls back to the single quote for rows with no
  // root, so quotes predating SCRUM-195 behave exactly as before.
  const deposits = await depositsForQuoteLineage(ctx, quoteId);
  return deposits.filter((d) => d.holdActive && d.isDeleted !== true);
}

/**
 * Every deposit the customer actually paid on this quote.
 *
 * Only money that was never really received drops out — a soft-deleted row, or
 * one voided as recorded-in-error. Refunds and forfeitures stay in, because
 * they are money that came in and then left, and the buckets below are what say
 * where it went. Filtering them out here made the total shrink underneath the
 * allocations still pointing at it.
 */
async function receivedDepositsForQuote(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes">
): Promise<Doc<"deposits">[]> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .collect();
  return deposits.filter((d) => d.isDeleted !== true && d.status !== "VOIDED");
}

function depositMinor(deposit: Doc<"deposits">, currency: string): number {
  return deposit.amountMinor ?? toMinorUnits(deposit.amount, currency);
}

/**
 * The whole allocation picture for a quote: what was paid, what is assigned to
 * which car, what has been consumed, and what is still floating.
 */
export async function quoteDepositAllocation(
  ctx: QueryCtx | MutationCtx,
  args: { quoteId: Id<"quotes">; currency: string }
): Promise<QuoteDepositAllocation> {
  const deposits = await receivedDepositsForQuote(ctx, args.quoteId);
  const totalReceivedMinor = deposits.reduce(
    (sum, d) => sum + depositMinor(d, args.currency),
    0
  );

  const allocations: VehicleAllocation[] = [];
  const depositRows: QuoteDepositAllocation["depositRows"] = [];
  let appliedMinor = 0;
  let reversingMinor = 0;
  // Whole-row refunds and forfeitures recorded through `deposits.release`,
  // which pays out the part of a row that no sale has claimed.
  let rowLevelRefundedMinor = 0;
  let rowLevelForfeitedMinor = 0;

  for (const deposit of deposits) {
    // Applications are the only record of money consumed by a sale. The
    // deposit's own status cannot say: one row is applied once per car it was
    // allocated across, on different dates, against different invoices.
    let committedMinor = 0;
    for (const application of await liveApplicationsForDeposit(ctx, deposit._id)) {
      if (application.status === "REVERSING") reversingMinor += application.amountMinor;
      else appliedMinor += application.amountMinor;
      committedMinor += application.amountMinor;
    }
    if (deposit.releasedAmountMinor !== undefined && deposit.releasedAmountMinor > 0) {
      // From the recorded split, never from `status`. A row can be released
      // more than once, and its status records only whichever release was last
      // — so a 3,000 refund followed by a 2,000 forfeiture reported all 5,000
      // as forfeited.
      const forfeited = deposit.forfeitedAmountMinor ?? 0;
      const refunded =
        deposit.refundedAmountMinor ??
        (deposit.status === "FORFEITED" && forfeited === 0
          ? 0
          : deposit.releasedAmountMinor - forfeited);
      rowLevelForfeitedMinor +=
        forfeited || (deposit.status === "FORFEITED" ? deposit.releasedAmountMinor : 0);
      rowLevelRefundedMinor += Math.max(0, refunded);
      committedMinor += deposit.releasedAmountMinor;
    }

    const holds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .collect();
    for (const hold of holds) {
      if (
        hold.allocationStatus === "RESOLVED" &&
        (hold.resolutionTreatment === "REFUND_TO_CUSTOMER" ||
          hold.resolutionTreatment === "FORFEITED" ||
          hold.resolutionTreatment === "OTHER")
      ) {
        committedMinor += hold.allocatedAmountMinor ?? 0;
      }
      allocations.push({
        vehicleId: hold.vehicleId,
        allocatedMinor: hold.allocatedAmountMinor,
        status: hold.allocationStatus,
        resolutionTreatment: hold.resolutionTreatment,
        active: hold.active,
        holdId: hold._id,
        depositId: deposit._id,
      });
    }
    depositRows.push({
      depositId: deposit._id,
      amountMinor: depositMinor(deposit, args.currency),
      committedMinor,
    });
  }

  let allocated = 0;
  let released = 0;
  let sliceRefunded = 0;
  let sliceForfeited = 0;
  let otherFinalized = 0;
  const withoutAllocation: Id<"vehicles">[] = [];
  for (const a of allocations) {
    if (a.allocatedMinor === undefined) {
      if (a.active) withoutAllocation.push(a.vehicleId);
      continue;
    }
    switch (a.status) {
      case "APPLIED":
      case "REVERSING":
        // Counted from the application rows above, which know the amount that
        // actually posted. Counting the hold too would double it.
        break;
      case "RELEASED_AWAITING_DECISION":
        released += a.allocatedMinor;
        break;
      case "RESOLVED":
        // A slice re-allocated to another car, or returned to the pool, is
        // still the customer's money on this quote — it is already counted
        // wherever it now lives. Only the treatments that end the money's life
        // on this deal come out.
        if (a.resolutionTreatment === "REFUND_TO_CUSTOMER") sliceRefunded += a.allocatedMinor;
        else if (a.resolutionTreatment === "FORFEITED") sliceForfeited += a.allocatedMinor;
        else if (a.resolutionTreatment === "OTHER") otherFinalized += a.allocatedMinor;
        break;
      default:
        // Only while the hold is live. A hold deactivated because the deal was
        // rejected, or because the rest of the row was paid back, is no longer
        // an allocation of anything — counting it kept the money assigned to a
        // car it could no longer be spent on, and pushed the buckets past the
        // amount the customer actually paid.
        if (a.active) allocated += a.allocatedMinor;
    }
  }

  const refundedMinor = sliceRefunded + rowLevelRefundedMinor;
  const forfeitedMinor = sliceForfeited + rowLevelForfeitedMinor;
  const resolvedOutMinor = refundedMinor + forfeitedMinor + otherFinalized;
  // Released slices are deliberately NOT counted as available: they are
  // awaiting a decision, and treating them as spare would move a customer's
  // money from the car it was allocated against to another one by default.
  const unallocatedMinor =
    totalReceivedMinor - allocated - appliedMinor - reversingMinor - released - resolvedOutMinor;

  return {
    totalReceivedMinor,
    heldTotalMinor: totalReceivedMinor,
    isMultiVehicle: allocations.length > 0,
    allocations,
    depositRows,
    allocatedMinor: allocated,
    appliedMinor,
    reversingMinor,
    releasedAwaitingDecisionMinor: released,
    refundedMinor,
    forfeitedMinor,
    otherFinalizedMinor: otherFinalized,
    resolvedOutMinor,
    unallocatedMinor: Math.max(0, unallocatedMinor),
    availableForAllocationMinor: Math.max(0, unallocatedMinor) + allocated,
    vehiclesWithoutAllocation: withoutAllocation,
  };
}

/**
 * Recomputes the conservation invariant and refuses to let a mutation commit
 * that has broken it.
 *
 * Called at the END of anything that moves deposit money. A Convex mutation is
 * one transaction, so a throw here rolls the whole movement back — the
 * arithmetic cannot be left inconsistent and reported as fine, which is exactly
 * what happened when a refund and an application both claimed the same slice.
 */
export async function assertQuoteDepositConservation(
  ctx: QueryCtx | MutationCtx,
  args: { quoteId: Id<"quotes">; currency: string }
): Promise<QuoteDepositAllocation> {
  const summary = await quoteDepositAllocation(ctx, args);
  const buckets =
    summary.allocatedMinor +
    summary.appliedMinor +
    summary.reversingMinor +
    summary.releasedAwaitingDecisionMinor +
    summary.refundedMinor +
    summary.forfeitedMinor +
    summary.otherFinalizedMinor +
    summary.unallocatedMinor;

  if (buckets !== summary.totalReceivedMinor) {
    throw new ConvexError(
      `Deposit accounting for this quote does not balance: ${buckets} accounted for against ${summary.totalReceivedMinor} received. The operation was rolled back.`
    );
  }
  return summary;
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
  /** What is genuinely free to assign: see QuoteDepositAllocation.availableForAllocationMinor. */
  availableForAllocationMinor: number;
  /** Allocations on cars this edit is not touching, which keep their share. */
  retainedMinor: number;
  proposedMinor: number[];
}): { ok: true; unallocatedMinor: number } | { ok: false; reason: string } {
  for (const amount of args.proposedMinor) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return { ok: false, reason: "Each allocation must be a whole, non-negative amount." };
    }
  }
  // Cars left out of this call keep what they had, so they are counted against
  // the same pot — the invariant holds across the whole quote, not just the
  // part being edited.
  const proposedTotal =
    args.proposedMinor.reduce((sum, a) => sum + a, 0) + args.retainedMinor;
  const available = args.availableForAllocationMinor;
  if (proposedTotal > available) {
    return {
      ok: false,
      reason: `The allocations total more than the deposit has left to give. Available: ${available}; requested: ${proposedTotal}.`,
    };
  }
  return { ok: true, unallocatedMinor: available - proposedTotal };
}
