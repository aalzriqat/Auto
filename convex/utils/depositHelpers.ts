import { ConvexError } from "convex/values";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { throwAppError, AppErrorCode } from "./errors";
import { requireActorPermission } from "./tenancy";
import { PERMISSIONS } from "./permissions";
import { assertDifferentActors } from "./financialGuards";
import { normalizeCurrency, amountToMinorOrThrow, type DepositMethod } from "./depositRecording";
import { fromMinorUnits } from "./money";
import { liveAppliedMinorForDeposit } from "./depositApplications";
import { assertQuoteDepositConservation } from "./depositAllocation";
import { createCanonicalPayment } from "../subledger";
import {
  getOrgCurrency,
  hookDepositRefunded,
  hookDepositForfeited,
} from "../accounting/workflowHooks";

/** Used when an org hasn't configured a reservationHoldDays setting. */
export const DEFAULT_RESERVATION_HOLD_DAYS = 3;

/**
 * Resolves how long (in ms from `now`) a new reservation/deposit hold should
 * last when the caller doesn't pass an explicit expiresAt — the org's
 * configured reservationHoldDays (Settings > General), or
 * DEFAULT_RESERVATION_HOLD_DAYS if unset.
 */
export async function getDefaultReservationExpiry(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  now: number
): Promise<number> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  const holdDays = settings?.reservationHoldDays ?? DEFAULT_RESERVATION_HOLD_DAYS;
  return now + holdDays * 24 * 60 * 60 * 1000;
}

type ResolvedDepositsForQuoteResult = {
  total: number;
  /**
   * Every slice actually consumed, whatever the treatment was.
   *
   * `appliedDeposits` below is only the customer-AR ones, because that is the
   * only treatment that credits a receivable. The settlement treatment needs
   * the same list to raise its own event, and used to re-read the deposits
   * table filtering on `deposit.vehicleId` — which on a multi-vehicle quote is
   * the first line item and nothing to do with the car being sold.
   */
  consumedSlices: Array<{
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amount: number;
    vehicleId: Id<"vehicles">;
    /** The allocation consumed. Absent on a single-vehicle quote, which has no hold rows. */
    holdId?: Id<"depositVehicleHolds">;
  }>;
  appliedDeposits: Array<{
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amount: number;
    /** Which car's allocated slice this was — the application is recorded against it. */
    vehicleId: Id<"vehicles">;
    /** The allocation consumed. Absent on a single-vehicle quote. */
    holdId?: Id<"depositVehicleHolds">;
  }>;
};

/**
 * The statuses a deposit or reservation hold is allowed to promote a vehicle
 * out of, into RESERVED.
 *
 * SOURCING belongs here: a special-order car is sourced *because* a customer
 * asked for it, so a deposit against one is the most committed a hold ever
 * gets. Excluding it meant the deposit was recorded, the money posted to the
 * GL and `holdActive: true` was written, while the car stayed SOURCING — a
 * hold that existed in the database and nowhere on the vehicle. The manual
 * escape hatch was closed too (RESERVED is workflow-controlled), so the car
 * could not be reserved by any path.
 *
 * IN_INSPECTION / IN_REPAIR stay out on purpose: those describe where the car
 * physically is, and overwriting them would lose the only record of it.
 */
const HOLDABLE_STATUSES = ["AVAILABLE", "SOURCING"] as const;

type HoldableStatus = (typeof HOLDABLE_STATUSES)[number];

export function isHoldableStatus(status: string): status is HoldableStatus {
  return (HOLDABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The status `syncVehicleHoldStatus` would move this vehicle to, or null if it
 * would leave it alone. Exported so `migrations.reconcileVehicleHolds` can
 * report a dry run that cannot disagree with what the real run writes.
 */
export function resolveHoldTargetStatus(
  vehicle: Pick<Doc<"vehicles">, "status" | "preHoldStatus" | "sourceType">,
  hasHold: boolean
): HoldableStatus | "RESERVED" | null {
  if (hasHold && isHoldableStatus(vehicle.status)) return "RESERVED";
  if (!hasHold && vehicle.status === "RESERVED") {
    // A snapshot of SOURCING only still means something while the vehicle is
    // actually sourced. `vehicles.update` can flip sourceType to STOCK without
    // requesting a status change, which the workflow guard permits — restoring
    // the stale snapshot then parked owned stock in the sourcing lifecycle,
    // where it is excluded from available inventory and from the lot.
    if (vehicle.preHoldStatus === "SOURCING" && vehicle.sourceType !== "SOURCED") {
      return "AVAILABLE";
    }
    return vehicle.preHoldStatus ?? "AVAILABLE";
  }
  return null;
}

/**
 * Puts a soft hold on a vehicle when a deposit is recorded. Reserving an
 * already-RESERVED vehicle is a no-op — multiple parallel deposits/quotes on
 * the same vehicle record are allowed (the same car can be sourced again from
 * the free zone or another dealer), this is a warning, not a lock.
 */
export async function holdVehicleForDeposit(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle) return;
  if (vehicle.status === "SOLD") {
    throwAppError(AppErrorCode.VEHICLE_ALREADY_SOLD, "This vehicle has already been sold.");
  }
  if (vehicle.status === "ARCHIVED") {
    throwAppError(AppErrorCode.VEHICLE_ARCHIVED, "Cannot place a deposit on an archived vehicle.");
  }
  if (isHoldableStatus(vehicle.status)) {
    await ctx.db.patch(vehicleId, {
      status: "RESERVED" as const,
      preHoldStatus: vehicle.status,
    });
  }
}

/**
 * Every deposit actively holding a vehicle — the ones naming it directly, plus
 * the ones holding it as a *secondary* line on a multi-vehicle quote.
 *
 * That second set is easy to miss and has caused real bugs: a deposit row only
 * ever snapshots the quote's primary `vehicleId`, so cars 2 and 3 of a
 * three-car deal are recorded solely in `depositVehicleHolds`. Any check that
 * queries `deposits.by_vehicle_hold` alone concludes those vehicles are unheld
 * while they are genuinely reserved.
 *
 * Readable from a query as well as a mutation, so the sourcing pipeline and the
 * reservation guard can share one definition of "who is holding this car".
 */
export async function getActiveDepositHolds(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<Doc<"deposits">[]> {
  const direct = await ctx.db
    .query("deposits")
    .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", vehicleId).eq("holdActive", true))
    .take(50);

  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", vehicleId).eq("active", true))
    .take(50);
  const secondary = await Promise.all(secondaryHolds.map((hold) => ctx.db.get(hold.depositId)));

  const byId = new Map<string, Doc<"deposits">>();
  for (const deposit of secondary) {
    if (!deposit || deposit.isDeleted === true) continue;
    if (deposit.status !== "HELD" || deposit.holdActive !== true) continue;
    byId.set(deposit._id, deposit);
  }
  for (const deposit of direct) {
    if (!deposit || deposit.isDeleted === true) continue;
    if (deposit.status !== "HELD" || deposit.holdActive !== true) continue;
    if (byId.has(deposit._id)) continue;
    // Where a deposit carries hold rows, those rows are the whole truth about
    // which cars it is holding — including the one named on the deposit itself,
    // which is only ever the quote's FIRST line item.
    //
    // Without this, a multi-vehicle deposit that is still held for car B kept
    // car A reserved through this direct index even after A's own share had
    // been consumed, released, or refunded. The car could not be freed by any
    // means short of resolving the whole deposit.
    const holds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .take(50);
    if (holds.length > 0) continue;
    byId.set(deposit._id, deposit);
  }
  return Array.from(byId.values());
}

/** Exported for saleCancellation.ts's trade-in-reversal safety guard, in addition to internal use by syncVehicleHoldStatus below. */
export async function hasActiveDepositHold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  // One definition of "who is holding this car", shared with
  // getActiveDepositHolds. This used to carry its own copy, which answered
  // differently: it treated a deposit's own `vehicleId` as a hold on that car
  // unconditionally, so on a multi-vehicle quote the FIRST line item stayed
  // reserved off the shared row even after its own share had been consumed,
  // released or refunded — and no path could free it while any other car on the
  // quote still held part of the deposit.
  const holders = await getActiveDepositHolds(ctx, vehicleId);
  return holders.length > 0;
}

/** Exported for saleCancellation.ts's trade-in-reversal safety guard, in addition to internal use by syncVehicleHoldStatus below. */
export async function hasActiveReservationHold(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> }
): Promise<boolean> {
  const now = Date.now();
  // Filter to ACTIVE in the index and stream rather than taking a fixed page.
  //
  // `by_org_vehicle` returned oldest-first across every status, so a vehicle
  // with 50+ historical released/expired reservations pushed a genuinely active
  // one out of the window — and this function answering "no hold" is what
  // releases a vehicle back to the lot, so a car could be handed back while a
  // live reservation still pointed at it.
  //
  // Narrowing to ACTIVE is not enough on its own: a reservation keeps
  // `status: "ACTIVE"` until a sweep patches it to EXPIRED, and this index is
  // still oldest-first, so a page of stale-but-unswept rows can sit in front of
  // the live one. Iterating stops at the first row that is genuinely unexpired,
  // which is the answer being asked for.
  for await (const reservation of ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("status", "ACTIVE")
    )) {
    if (reservation.expiresAt === undefined || reservation.expiresAt > now) return true;
  }
  return false;
}

export async function syncVehicleHoldStatus(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">,
  actorId?: Id<"users">,
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.isDeleted) return;
  if (vehicle.status === "SOLD" || vehicle.status === "ARCHIVED") return;

  const hasHold =
    (await hasActiveDepositHold(ctx, vehicleId)) ||
    (await hasActiveReservationHold(ctx, { orgId: vehicle.orgId, vehicleId }));

  // One resolver decides the target for both this function and the
  // reconcileVehicleHolds migration, so a dry-run preview cannot disagree with
  // what actually gets written.
  const target = resolveHoldTargetStatus(vehicle, hasHold);
  if (target === null || target === vehicle.status) return;

  if (target === "RESERVED") {
    const patch: {
      status: "RESERVED";
      preHoldStatus: HoldableStatus;
      updatedAt: number;
      updatedBy?: Id<"users">;
    } = {
      status: "RESERVED" as const,
      // Safe: resolveHoldTargetStatus only returns RESERVED when the current
      // status is holdable.
      preHoldStatus: vehicle.status as HoldableStatus,
      updatedAt: Date.now(),
    };
    if (actorId) patch.updatedBy = actorId;
    await ctx.db.patch(vehicleId, patch);
  } else {
    // Restore where the hold found it. Rows written before preHoldStatus
    // existed have none — AVAILABLE is the right fallback for those, since
    // that was the only status a hold could previously promote from.
    const patch: {
      status: HoldableStatus;
      preHoldStatus: undefined;
      updatedAt: number;
      updatedBy?: Id<"users">;
    } = {
      status: target,
      preHoldStatus: undefined,
      updatedAt: Date.now(),
    };
    if (actorId) patch.updatedBy = actorId;
    await ctx.db.patch(vehicleId, patch);
  }
}

/**
 * Releases a vehicle's RESERVED hold back to AVAILABLE once no deposit is
 * or reservation is still actively holding it.
 */
export async function maybeReleaseVehicleHold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  await syncVehicleHoldStatus(ctx, vehicleId);
}

/**
 * Releases every vehicle a deposit holds — the primary `deposit.vehicleId`
 * plus any secondary vehicles recorded in `depositVehicleHolds` for
 * multi-vehicle quotes. Use this instead of a bare `maybeReleaseVehicleHold`
 * whenever a deposit is being resolved (released/voided/applied).
 */
export async function releaseAllVehiclesForDeposit(
  ctx: MutationCtx,
  deposit: Doc<"deposits">
): Promise<void> {
  await maybeReleaseVehicleHold(ctx, deposit.vehicleId);

  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
    .collect();

  for (const hold of secondaryHolds) {
    if (!hold.active) continue;
    await ctx.db.patch(hold._id, { active: false });
    await maybeReleaseVehicleHold(ctx, hold.vehicleId);
  }
}

/**
 * Reactivates every vehicle a deposit holds — the inverse of
 * releaseAllVehiclesForDeposit. Use when a completed sale is cancelled and
 * its APPLIED deposit is reinstated to HELD, so every vehicle on a
 * multi-vehicle quote goes back on hold, not just the primary one.
 */
export async function reactivateAllVehiclesForDeposit(
  ctx: MutationCtx,
  deposit: Doc<"deposits">
): Promise<void> {
  await syncVehicleHoldStatus(ctx, deposit.vehicleId);

  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
    .collect();

  for (const hold of secondaryHolds) {
    // Only slices that are still simply held. A slice consumed by another car's
    // sale that still stands, or released and awaiting a decision, or already
    // resolved, has been settled on its own terms — putting it back on hold
    // would re-reserve a car that was sold and resurrect money that was
    // refunded.
    const settled =
      hold.allocationStatus !== undefined && hold.allocationStatus !== "ALLOCATED";
    if (settled) continue;
    if (!hold.active) {
      await ctx.db.patch(hold._id, { active: true });
    }
    await syncVehicleHoldStatus(ctx, hold.vehicleId);
  }
}

/**
 * What was decided about a reservation deposit (عربون) when the deal it holds
 * finished.
 *
 * The reservation deposit is the customer's money paid to the DEALERSHIP
 * against its own receipt voucher. It is not the financing down payment, which
 * the customer pays to the finance company and which never passes through
 * these books. Conflating the two is the mistake this taxonomy exists to make
 * impossible: nothing here can move a reservation deposit to a finance
 * company, and nothing recognizes it as income merely because a deal closed.
 *
 *   APPLY_TO_DEALER_AMOUNT          against something the customer genuinely
 *                                   owes the dealership on this deal.
 *   APPLY_TO_TRANSACTION_SETTLEMENT against the dealership-side settlement with
 *                                   the supplier.
 *   REFUND_TO_CUSTOMER              returned.
 *   FORFEITED                       retained under the cancellation policy.
 *   OTHER                           an approved treatment none of the above
 *                                   describes. Requires a reason, and posts
 *                                   nothing — see below.
 */
export type DepositTreatment =
  | "APPLY_TO_DEALER_AMOUNT"
  | "APPLY_TO_TRANSACTION_SETTLEMENT"
  | "REFUND_TO_CUSTOMER"
  | "FORFEITED"
  | "OTHER";

/**
 * The deposit row status each treatment leaves behind.
 *
 * OTHER maps to null deliberately. It means a human has approved a treatment
 * the system has no rule for, so there is no account to credit and no honest
 * status to claim — the liability stays exactly where it is, awaiting a manual
 * journal. Only the vehicle hold is released. Picking any status here would be
 * inventing an accounting outcome from a field whose entire purpose is to say
 * that no automatic outcome applies.
 */
export function depositStatusForTreatment(
  treatment: DepositTreatment
): "APPLIED" | "REFUNDED" | "FORFEITED" | null {
  switch (treatment) {
    case "APPLY_TO_DEALER_AMOUNT":
    case "APPLY_TO_TRANSACTION_SETTLEMENT":
      return "APPLIED";
    case "REFUND_TO_CUSTOMER":
      return "REFUNDED";
    case "FORFEITED":
      return "FORFEITED";
    case "OTHER":
      return null;
  }
}

/**
 * Resolves every actively-held deposit on a quote (e.g. when its sale
 * completes) and releases the vehicle hold if nothing else is holding it.
 *
 * `appliedDeposits` lists only deposits applied to what the CUSTOMER owes the
 * dealership — those and only those become a canonical payment allocated to the
 * sale's receivable. A deposit applied to the supplier settlement, refunded, or
 * left for a manual journal never touches the customer's receivable, so
 * including it would over-settle an invoice the customer still owes.
 */
export async function resolveDepositsForQuote(
  ctx: MutationCtx,
  args: {
    quoteId: Id<"quotes">;
    /**
     * The car whose sale is being finalized. Only ITS allocated share of the
     * quote's reservation deposit is consumed.
     *
     * The عربون is quote-scoped — one payment, one receipt voucher, one
     * `deposits` row — and a quote can carry several cars. Which part of that
     * payment belongs to which car is a stored decision on
     * `depositVehicleHolds`, never a calculation. Consuming the whole row on
     * the first completion paid down one car's invoice with money the customer
     * had put against another, and took that other car off reservation for
     * nothing.
     */
    vehicleId: Id<"vehicles">;
    currency: string;
    resolution: "APPLIED" | "REFUNDED" | "FORFEITED";
    actorId: Id<"users">;
    /**
     * Recorded alongside the status when the caller made an explicit choice.
     * Absent for the implicit dealer-owned path, where "applied to what the
     * customer owes" is the only thing APPLIED has ever meant.
     */
    treatment?: DepositTreatment;
    treatmentReason?: string;
    saleId?: Id<"sales">;
  }
): Promise<ResolvedDepositsForQuoteResult> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
    .collect();

  let resolvedTotal = 0;
  const appliedDeposits: ResolvedDepositsForQuoteResult["appliedDeposits"] = [];
  const consumedSlices: ResolvedDepositsForQuoteResult["consumedSlices"] = [];
  const now = Date.now();
  const appliesToCustomerAr =
    args.treatment === undefined || args.treatment === "APPLY_TO_DEALER_AMOUNT";

  for (const deposit of deposits) {
    if (!deposit.holdActive || deposit.isDeleted === true) continue;

    const holds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .collect();

    if (holds.length === 0) {
      // Single-vehicle quote: the whole row belongs to the one car, and the
      // long-standing behaviour is exactly right.
      if (deposit.vehicleId !== args.vehicleId) continue;
      await ctx.db.patch(deposit._id, {
        status: args.resolution,
        holdActive: false,
        resolvedBy: args.actorId,
        resolvedAt: now,
        ...(args.treatment ? { resolutionTreatment: args.treatment } : {}),
        ...(args.treatmentReason ? { resolutionReason: args.treatmentReason } : {}),
        ...(args.saleId ? { resolutionSaleId: args.saleId } : {}),
      });
      resolvedTotal += deposit.amount;
      consumedSlices.push({
        depositId: deposit._id,
        customerId: deposit.customerId,
        amount: deposit.amount,
        vehicleId: deposit.vehicleId,
      });
      if (args.resolution === "APPLIED" && appliesToCustomerAr) {
        appliedDeposits.push({
          depositId: deposit._id,
          customerId: deposit.customerId,
          amount: deposit.amount,
          vehicleId: deposit.vehicleId,
        });
      }
      await releaseAllVehiclesForDeposit(ctx, deposit);
      continue;
    }

    // Multi-vehicle: consume only this car's stored slices, and leave every
    // other car's slice and hold exactly where they are.
    //
    // Slices, plural. A car can hold more than one at once — a re-allocation
    // opens a NEW hold on the receiving car rather than rewriting the released
    // one, so both histories survive. Consuming the first match credited one
    // slice and left the rest behind: the customer was billed for a deposit the
    // allocation screen had already told them was against that car, and the
    // remainder stayed active on a car that was now SOLD, where no path could
    // reach it again.
    const mine = holds.filter(
      (h) => h.vehicleId === args.vehicleId && h.active && h.allocatedAmountMinor !== undefined
    );
    if (mine.length === 0) continue;

    for (const slice of mine) {
      const sliceMinor = slice.allocatedAmountMinor ?? 0;
      await ctx.db.patch(slice._id, {
        allocationStatus:
          args.resolution === "APPLIED" ? "APPLIED" : "RELEASED_AWAITING_DECISION",
        active: false,
        ...(args.saleId ? { appliedSaleId: args.saleId } : {}),
        resolvedAt: now,
        resolvedBy: args.actorId,
      });

      resolvedTotal += fromMinorUnits(sliceMinor, args.currency);
      if (sliceMinor > 0) {
        consumedSlices.push({
          depositId: deposit._id,
          customerId: deposit.customerId,
          amount: fromMinorUnits(sliceMinor, args.currency),
          vehicleId: args.vehicleId,
          holdId: slice._id,
        });
      }
      if (args.resolution === "APPLIED" && appliesToCustomerAr && sliceMinor > 0) {
        appliedDeposits.push({
          depositId: deposit._id,
          customerId: deposit.customerId,
          amount: fromMinorUnits(sliceMinor, args.currency),
          vehicleId: args.vehicleId,
          holdId: slice._id,
        });
      }
    }
    await maybeReleaseVehicleHold(ctx, args.vehicleId);

    // The deposit row itself only closes when nothing on the quote still has a
    // live claim on it. A row cannot be half-APPLIED, so its status follows the
    // last allocation rather than the first.
    const remaining = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .collect();
    if (remaining.every((h) => h.active === false)) {
      await ctx.db.patch(deposit._id, {
        status: args.resolution,
        holdActive: false,
        resolvedBy: args.actorId,
        resolvedAt: now,
        ...(args.treatment ? { resolutionTreatment: args.treatment } : {}),
        ...(args.treatmentReason ? { resolutionReason: args.treatmentReason } : {}),
        ...(args.saleId ? { resolutionSaleId: args.saleId } : {}),
      });
    }
  }
  return { total: resolvedTotal, appliedDeposits, consumedSlices };
}

/**
 * Releases the vehicle hold without deciding anything about the money — the
 * OTHER treatment. The deposit stays HELD and its liability stays on the books;
 * what is recorded is that somebody chose a treatment the system does not post,
 * and why.
 */
export async function recordUnpostedDepositTreatment(
  ctx: MutationCtx,
  args: {
    quoteId: Id<"quotes">;
    /** Scoped like resolveDepositsForQuote — only this car's deposits. */
    vehicleId: Id<"vehicles">;
    actorId: Id<"users">;
    reason: string;
    saleId?: Id<"sales">;
  }
): Promise<{ total: number; depositIds: Id<"deposits">[] }> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
    .collect();

  let total = 0;
  const depositIds: Id<"deposits">[] = [];
  const now = Date.now();
  for (const deposit of deposits) {
    if (!deposit.holdActive) continue;
    if (deposit.vehicleId !== args.vehicleId) continue;
    await ctx.db.patch(deposit._id, {
      // status deliberately untouched — the money is still held.
      holdActive: false,
      resolvedBy: args.actorId,
      resolvedAt: now,
      resolutionTreatment: "OTHER" as const,
      resolutionReason: args.reason,
      ...(args.saleId ? { resolutionSaleId: args.saleId } : {}),
    });
    total += deposit.amount;
    depositIds.push(deposit._id);
    await releaseAllVehiclesForDeposit(ctx, deposit);
  }
  return { total, depositIds };
}

async function releaseQuoteDepositHolds(
  ctx: MutationCtx,
  quoteId: Id<"quotes">
): Promise<void> {
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))) {
    if (deposit.isDeleted === true || !deposit.holdActive) continue;
    await ctx.db.patch(deposit._id, { holdActive: false });
    await releaseAllVehiclesForDeposit(ctx, deposit);
  }
}

async function releaseReservationDepositHold(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; reservation: Doc<"vehicleReservations"> }
): Promise<void> {
  if (!args.reservation.depositId) return;

  const deposit = await ctx.db.get(args.reservation.depositId);
  if (
    deposit &&
    deposit.isDeleted !== true &&
    deposit.orgId === args.orgId &&
    deposit.status === "HELD" &&
    deposit.holdActive
  ) {
    await ctx.db.patch(args.reservation.depositId, { holdActive: false });
  }
}

async function releaseMatchingReservationHoldsForQuote(
  ctx: MutationCtx,
  args: { quote: Doc<"quotes">; actorId: Id<"users"> }
): Promise<void> {
  const { quote } = args;
  const quoteVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  const now = Date.now();

  for (const item of quoteVehicleItems) {
    const reservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", quote.orgId).eq("vehicleId", item.vehicleId).eq("status", "ACTIVE")
      )
      .take(50);

    const matchingReservations = reservations.filter((reservation) => reservation.customerId === quote.customerId);

    for (const reservation of matchingReservations) {
      await releaseReservationDepositHold(ctx, { orgId: quote.orgId, reservation });
      await ctx.db.patch(reservation._id, {
        status: "RELEASED",
        releasedAt: now,
        releasedBy: args.actorId,
      });
      await syncVehicleHoldStatus(ctx, reservation.vehicleId, args.actorId);
    }
  }
}

/**
 * Releases vehicle holds for a quote whose application was rejected or
 * cancelled. Deposit rows stay HELD so a manager still manually refunds or
 * forfeits real money, but those deposits and same-customer reservations stop
 * contributing to RESERVED inventory.
 */
export async function releaseHoldForApplicationQuote(
  ctx: MutationCtx,
  args: { quoteId: Id<"quotes">; actorId: Id<"users"> }
): Promise<void> {
  const quote = await ctx.db.get(args.quoteId);
  if (!quote) return;

  await releaseQuoteDepositHolds(ctx, args.quoteId);
  await releaseMatchingReservationHoldsForQuote(ctx, { quote, actorId: args.actorId });
}

/**
 * Pays out — or writes off — ONE vehicle's slice of a shared quote deposit.
 *
 * The whole-row path (`releaseHeldDeposit`) cannot do this: it resolves the
 * entire `deposits` row, and on a multi-vehicle quote that row is also holding
 * the other cars' money. So the slice case used to record a decision and move
 * nothing — a REFUND treatment that produced no payment, no cashflow row and no
 * journal, leaving the customer's money on the books as a liability against a
 * car that had left the deal.
 *
 * Every control the whole-row release carries applies here too, because they
 * belong to the decision and not to the size of it: approval permission,
 * separation between whoever took the deposit and whoever gives it back, a
 * refund method that can actually be paid out, and a record in the places
 * people look for cash leaving the business.
 */
export async function payOutDepositSlice(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    deposit: Doc<"deposits">;
    holdId: Id<"depositVehicleHolds">;
    vehicleId: Id<"vehicles">;
    amountMinor: number;
    currency: string;
    resolution: "REFUNDED" | "FORFEITED";
    refundMethod?: DepositMethod;
    actorId: Id<"users">;
    notes?: string;
    occurredAt: number;
    idempotencyKey?: string;
  }
): Promise<void> {
  if (args.amountMinor <= 0) return;

  if (args.resolution === "REFUNDED") {
    if (!args.refundMethod) {
      throw new ConvexError(
        "A refund needs the method the money is going out by — the deposit's own method may be one that cannot be paid out."
      );
    }
    if (args.refundMethod === "OTHER") {
      throw new ConvexError(
        "Select a specific refund method — OTHER is not accepted for a deposit refund."
      );
    }
  }

  await requireActorPermission(
    ctx,
    args.orgId,
    args.actorId,
    PERMISSIONS.APPROVE_REQUESTS,
    "Refunding or forfeiting a reservation deposit requires approval permission."
  );
  assertDifferentActors(
    args.actorId,
    args.deposit.createdBy,
    "Deposit creator cannot resolve their own deposit refund or forfeiture."
  );

  const amountMajor = fromMinorUnits(args.amountMinor, args.currency);

  if (args.resolution === "FORFEITED") {
    await hookDepositForfeited(ctx, {
      orgId: args.orgId,
      depositId: args.deposit._id,
      customerId: args.deposit.customerId,
      amountMinor: args.amountMinor,
      currency: args.currency,
      actorId: args.actorId,
      occurredAt: args.occurredAt,
      sliceHoldId: args.holdId,
    });
    return;
  }

  const [vehicle, customer] = await Promise.all([
    ctx.db.get(args.vehicleId),
    ctx.db.get(args.deposit.customerId),
  ]);
  const vehicleLabel = vehicle
    ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
    : "Vehicle";
  const customerLabel = customer
    ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer"
    : "Customer";

  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: "OUT",
    amount: amountMajor,
    date: args.occurredAt,
    category: "DEPOSIT",
    description: `Deposit refund (vehicle share) - ${vehicleLabel} - ${customerLabel}`,
    vehicleId: args.vehicleId,
    depositId: args.deposit._id,
    idempotencyKey: args.idempotencyKey,
  });

  const collectionPaymentId = await ctx.db.insert("collectionPayments", {
    orgId: args.orgId,
    customerId: args.deposit.customerId,
    vehicleId: args.vehicleId,
    direction: "OUT",
    method: "REFUND",
    amount: amountMajor,
    paymentDate: args.occurredAt,
    status: "POSTED",
    idempotencyKey: args.idempotencyKey,
    reference: `Deposit slice refund ${args.holdId}`,
    cashierId: args.actorId,
    notes: args.notes,
    createdAt: args.occurredAt,
  });

  const canonicalPaymentId = await createCanonicalPayment(ctx, {
    orgId: args.orgId,
    direction: "OUT",
    payerType: "CUSTOMER",
    customerId: args.deposit.customerId,
    method: args.refundMethod!,
    amountMinor: args.amountMinor,
    currency: args.currency,
    // Keyed on the slice, not the deposit: a quote can refund several shares of
    // one row, and a shared key would make every refund after the first return
    // the first one's payment and move no money.
    idempotencyKey: `deposit_slice_refund_${args.holdId}`,
    actorId: args.actorId,
    status: "SETTLED",
    externalReference: `Deposit slice refund ${args.holdId}`,
    receivedAt: args.occurredAt,
  });
  await ctx.db.patch(collectionPaymentId, { canonicalPaymentId });

  await hookDepositRefunded(ctx, {
    orgId: args.orgId,
    depositId: args.deposit._id,
    customerId: args.deposit.customerId,
    amountMinor: args.amountMinor,
    currency: args.currency,
    actorId: args.actorId,
    occurredAt: args.occurredAt,
    paymentMethod: args.refundMethod,
    sliceHoldId: args.holdId,
  });
}

/**
 * Releases one HELD deposit as a refund or a forfeiture, with every control
 * that decision carries.
 *
 * This exists because there are now two places a deposit can be released — the
 * deposits screen and the completion of the sale it was taken against — and the
 * controls belong to the DECISION, not to the screen it happens to be made on.
 * Reimplementing the posting in the second place produced a path that moved a
 * customer's money with none of them: no approval permission, no separation
 * between the person who took the deposit and the person who kept it, no check
 * that the refund method could actually be paid out, and no record in the
 * cashflow ledger or the payments subledger to reconcile the journal against.
 *
 * The GL entry alone is not a release. Cash leaving the business has to appear
 * in the places people look for cash leaving the business.
 */
export async function releaseHeldDeposit(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    resolution: "REFUNDED" | "FORFEITED";
    actorId: Id<"users">;
    refundMethod?: DepositMethod;
    notes?: string;
    idempotencyKey?: string;
    occurredAt?: number;
    /** Recorded on the deposit when the release was decided by closing a sale. */
    saleId?: Id<"sales">;
    treatment?: DepositTreatment;
  }
): Promise<{ amountMinor: number; currency: string }> {
  if (args.resolution === "REFUNDED" && !args.refundMethod) {
    throw new ConvexError("A refund payment method is required to refund a deposit.");
  }
  if (args.refundMethod === "OTHER") {
    throw new ConvexError("Select a specific refund method — OTHER is not accepted for a deposit refund.");
  }

  // Releasing a deposit is an approval, not a sale action. Checked against the
  // actor rather than the entry point, because completing a sale authorizes
  // `create:sales` and would otherwise carry this along for free.
  await requireActorPermission(
    ctx,
    args.orgId,
    args.actorId,
    PERMISSIONS.APPROVE_REQUESTS,
    "Refunding or forfeiting a reservation deposit requires approval permission."
  );

  const deposit = await ctx.db.get(args.depositId);
  if (!deposit || deposit.orgId !== args.orgId) {
    throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
  }
  if (deposit.status !== "HELD") {
    throwAppError(AppErrorCode.DEPOSIT_ALREADY_RESOLVED, "This deposit has already been resolved.");
  }
  assertDifferentActors(
    args.actorId,
    deposit.createdBy,
    "Deposit creator cannot resolve their own deposit refund or forfeiture."
  );

  const now = args.occurredAt ?? Date.now();
  const currency = normalizeCurrency(deposit.currency ?? (await getOrgCurrency(ctx, args.orgId)));
  const rowMinor = deposit.amountMinor ?? amountToMinorOrThrow(deposit.amount, currency);

  // Only the part of the row nobody has a claim on.
  //
  // A quote-scoped deposit is applied per car, so a 5,000 row can have 3,000
  // already credited against car A's live invoice while car B is still open.
  // Refunding the row's face value paid the customer that 3,000 a second time —
  // once off their invoice and once in cash — and posted a DEPOSIT_REFUNDED
  // journal for the whole amount on top. The row's own status cannot catch it:
  // it stays HELD until the LAST slice is consumed.
  const claimedByLiveSalesMinor = await liveAppliedMinorForDeposit(ctx, args.depositId);
  const alreadyPaidOutMinor = deposit.releasedAmountMinor ?? 0;
  const holds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", args.depositId))
    .collect();
  const slicesFinalizedMinor = holds
    .filter(
      (h) =>
        h.allocationStatus === "RESOLVED" &&
        (h.resolutionTreatment === "REFUND_TO_CUSTOMER" ||
          h.resolutionTreatment === "FORFEITED" ||
          h.resolutionTreatment === "OTHER")
    )
    .reduce((sum, h) => sum + (h.allocatedAmountMinor ?? 0), 0);
  // Money assigned to a car that is still on the deal is not free either. This
  // path resolves the ROW, and it used to take every vehicle's hold down with
  // it — refunding one car's unallocated remainder silently cancelled another
  // car's agreed share and left it unsellable. A car's share is released
  // deliberately (deposits.releaseVehicleAllocation) and decided on its own.
  //
  // A slice awaiting a decision, or still mid-reversal, is excluded for the
  // same reason: it belongs to `deposits.resolveReleasedAllocation`, which pays
  // out that share against its own identity. Paying it here left the hold
  // sitting at RELEASED_AWAITING_DECISION with its money already gone, ready to
  // be refunded a second time or quietly returned to the pool.
  //
  // APPLIED and REVERSING holds are excluded here because their application
  // rows already account for that money — `liveAppliedMinorForDeposit` counts
  // both statuses — and subtracting the hold as well took the same amount off
  // twice. That refused a genuinely free refund for as long as a deferred
  // reversal was waiting on an accounting period, with a message saying there
  // was nothing left when there was.
  const stillAllocatedMinor = holds
    .filter(
      (h) =>
        h.allocationStatus !== "APPLIED" &&
        h.allocationStatus !== "REVERSING" &&
        (h.allocationStatus === "RELEASED_AWAITING_DECISION" ||
          (h.active && h.allocationStatus !== undefined))
    )
    .reduce((sum, h) => sum + (h.allocatedAmountMinor ?? 0), 0);

  const amountMinor =
    rowMinor -
    claimedByLiveSalesMinor -
    alreadyPaidOutMinor -
    slicesFinalizedMinor -
    stillAllocatedMinor;

  if (amountMinor <= 0) {
    throw new ConvexError(
      "There is nothing left of this deposit to refund or forfeit — every part of it is applied to a completed sale, allocated to a vehicle still on the deal, awaiting its own decision, or already paid out. Cancel the sale, or resolve the vehicle's share, first."
    );
  }

  // Whether anything of this row survives the payout decides how much of it
  // closes. A row that is still carrying a live application or another car's
  // allocation stays HELD with its holds intact — only the free part has left.
  const closesTheRow = claimedByLiveSalesMinor + stillAllocatedMinor === 0;
  // Every release is its own movement of money and needs its own identity. The
  // first keeps the original key so nothing already posted changes.
  const releaseSeq = (deposit.releaseCount ?? 0) + 1;
  await ctx.db.patch(args.depositId, {
    ...(closesTheRow ? { status: args.resolution, holdActive: false } : {}),
    releasedAmountMinor: alreadyPaidOutMinor + amountMinor,
    ...(args.resolution === "FORFEITED"
      ? { forfeitedAmountMinor: (deposit.forfeitedAmountMinor ?? 0) + amountMinor }
      : { refundedAmountMinor: (deposit.refundedAmountMinor ?? 0) + amountMinor }),
    releaseCount: releaseSeq,
    resolvedBy: args.actorId,
    resolvedAt: now,
    notes: args.notes ?? deposit.notes,
    ...(args.treatment ? { resolutionTreatment: args.treatment } : {}),
    ...(args.saleId ? { resolutionSaleId: args.saleId } : {}),
  });
  if (closesTheRow) await releaseAllVehiclesForDeposit(ctx, deposit);
  const amountMajor = fromMinorUnits(amountMinor, currency);

  if (args.resolution === "REFUNDED") {
    const [vehicle, customer] = await Promise.all([
      ctx.db.get(deposit.vehicleId),
      ctx.db.get(deposit.customerId),
    ]);
    const vehicleLabel = vehicle
      ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
      : "Vehicle";
    const customerLabel = customer
      ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer"
      : "Customer";
    const sourceLabel = deposit.quoteId
      ? `quote ${deposit.quoteId}`
      : deposit.reservationId
        ? `reservation ${deposit.reservationId}`
        : "vehicle hold";

    await ctx.db.insert("transactions", {
      orgId: args.orgId,
      type: "OUT",
      amount: amountMajor,
      date: now,
      category: "DEPOSIT",
      description: `Deposit refund for ${sourceLabel} - ${vehicleLabel} - ${customerLabel}`,
      vehicleId: deposit.vehicleId,
      depositId: args.depositId,
      idempotencyKey: args.idempotencyKey,
    });

    const collectionPaymentId = await ctx.db.insert("collectionPayments", {
      orgId: args.orgId,
      customerId: deposit.customerId,
      vehicleId: deposit.vehicleId,
      direction: "OUT",
      method: "REFUND",
      amount: amountMajor,
      paymentDate: now,
      status: "POSTED",
      idempotencyKey: args.idempotencyKey,
      reference: `Deposit refund ${args.depositId}`,
      cashierId: args.actorId,
      notes: args.notes,
      createdAt: now,
    });

    const canonicalPaymentId = await createCanonicalPayment(ctx, {
      orgId: args.orgId,
      direction: "OUT",
      payerType: "CUSTOMER",
      customerId: deposit.customerId,
      method: args.refundMethod!,
      amountMinor,
      currency,
      idempotencyKey:
        releaseSeq > 1
          ? `deposit_refund_${args.depositId}_${releaseSeq}`
          : `deposit_refund_${args.depositId}`,
      actorId: args.actorId,
      status: "SETTLED",
      externalReference: `Deposit refund ${args.depositId}`,
      receivedAt: now,
    });
    await ctx.db.patch(collectionPaymentId, { canonicalPaymentId });

    await hookDepositRefunded(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      customerId: deposit.customerId,
      amountMinor,
      currency,
      actorId: args.actorId,
      occurredAt: now,
      paymentMethod: args.refundMethod,
      releaseSeq,
    });
  } else {
    await hookDepositForfeited(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      customerId: deposit.customerId,
      amountMinor,
      currency,
      actorId: args.actorId,
      occurredAt: now,
      releaseSeq,
    });
  }

  // Every dinar still has to be in exactly one bucket. This is the path that
  // moves cash out of the business, so it is the last place an imbalance may
  // be allowed to commit.
  if (deposit.quoteId) {
    await assertQuoteDepositConservation(ctx, { quoteId: deposit.quoteId, currency });
  }

  return { amountMinor, currency };
}
