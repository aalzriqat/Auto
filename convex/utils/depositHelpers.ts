import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { throwAppError, AppErrorCode } from "./errors";

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

  return deposits.some((deposit) => deposit.isDeleted !== true);
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
    await maybeReleaseVehicleHold(ctx, deposit.vehicleId);
  }
  return { total: resolvedTotal, appliedDeposits };
}

/**
 * Releases the vehicle hold for a quote whose application was rejected or
 * cancelled, but leaves the deposit's own `status` as HELD — a manager still
 * has to manually refund or forfeit it, mirroring how a real cash refund
 * needs a person to confirm it rather than happening automatically.
 */
export async function releaseHoldForApplicationQuote(
  ctx: MutationCtx,
  args: { quoteId: Id<"quotes"> }
): Promise<void> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
    .collect();

  for (const deposit of deposits) {
    if (!deposit.holdActive) continue;
    await ctx.db.patch(deposit._id, { holdActive: false });
    await maybeReleaseVehicleHold(ctx, deposit.vehicleId);
  }
}
