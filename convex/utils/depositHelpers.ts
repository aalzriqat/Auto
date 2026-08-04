import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { throwAppError, AppErrorCode } from "./errors";

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
  appliedDeposits: Array<{
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amount: number;
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
  for (const deposit of [...direct, ...secondary]) {
    if (!deposit || deposit.isDeleted === true) continue;
    if (deposit.status !== "HELD" || deposit.holdActive !== true) continue;
    byId.set(deposit._id, deposit);
  }
  return Array.from(byId.values());
}

/** Exported for saleCancellation.ts's trade-in-reversal safety guard, in addition to internal use by syncVehicleHoldStatus below. */
export async function hasActiveDepositHold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", vehicleId).eq("holdActive", true))
    .take(50);

  if (deposits.some((deposit) => deposit.isDeleted !== true)) return true;

  // Covers secondary vehicles on a multi-vehicle deposit, which only ever
  // snapshot their primary vehicleId on the `deposits` row itself.
  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", vehicleId).eq("active", true))
    .take(50);
  return secondaryHolds.length > 0;
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
    if (!hold.active) {
      await ctx.db.patch(hold._id, { active: true });
    }
    await syncVehicleHoldStatus(ctx, hold.vehicleId);
  }
}

/**
 * Resolves every actively-held deposit on a quote (e.g. when its sale
 * completes) and releases the vehicle hold if nothing else is holding it.
 */
export async function resolveDepositsForQuote(
  ctx: MutationCtx,
  args: {
    quoteId: Id<"quotes">;
    resolution: "APPLIED" | "REFUNDED" | "FORFEITED";
    actorId: Id<"users">;
  }
): Promise<ResolvedDepositsForQuoteResult> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
    .collect();

  let resolvedTotal = 0;
  const appliedDeposits: ResolvedDepositsForQuoteResult["appliedDeposits"] = [];
  const now = Date.now();
  for (const deposit of deposits) {
    if (!deposit.holdActive) continue;
    await ctx.db.patch(deposit._id, {
      status: args.resolution,
      holdActive: false,
      resolvedBy: args.actorId,
      resolvedAt: now,
    });
    resolvedTotal += deposit.amount;
    if (args.resolution === "APPLIED") {
      appliedDeposits.push({
        depositId: deposit._id,
        customerId: deposit.customerId,
        amount: deposit.amount,
      });
    }
    await releaseAllVehiclesForDeposit(ctx, deposit);
  }
  return { total: resolvedTotal, appliedDeposits };
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
