import { MutationCtx } from "../_generated/server";
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
  if (vehicle.status === "AVAILABLE") {
    await ctx.db.patch(vehicleId, { status: "RESERVED" as const });
  }
}

async function hasActiveDepositHold(
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

async function hasActiveReservationHold(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> }
): Promise<boolean> {
  const now = Date.now();
  const reservations = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .take(50);

  return reservations.some(
    (reservation) =>
      reservation.status === "ACTIVE" &&
      (reservation.expiresAt === undefined || reservation.expiresAt > now),
  );
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

  if (hasHold && vehicle.status === "AVAILABLE") {
    const patch: { status: "RESERVED"; updatedAt: number; updatedBy?: Id<"users"> } = {
      status: "RESERVED" as const,
      updatedAt: Date.now(),
    };
    if (actorId) patch.updatedBy = actorId;
    await ctx.db.patch(vehicleId, patch);
  } else if (!hasHold && vehicle.status === "RESERVED") {
    const patch: { status: "AVAILABLE"; updatedAt: number; updatedBy?: Id<"users"> } = {
      status: "AVAILABLE" as const,
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
