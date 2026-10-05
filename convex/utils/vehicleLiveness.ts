import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-641 (D-35) — a soft-deleted vehicle is never commercial again.
 *
 * ONE definition of "this car may take new commercial authority" so every door that gives a car a
 * quote, draft, hold, deposit, allocation, profit approval, finance approval or sale asks the same
 * question and refuses with the same coded error.
 *
 * ⚠️ PRECEDENCE IS PART OF THE CONTRACT. The throwing guard keeps SOLD > ARCHIVED > DELETED; the
 * profit verdict (approvals.profitApprovalStatus) blocks every deleted car (D-40).
 *
 * ⚠️ NEVER FOR A FOREIGN CAR. `assertVehicleNotDeleted` takes a car the caller has already proven
 * is in its organisation; `requireCommercialVehicle` proves it itself. Reporting DELETED for
 * another tenant's car would confirm that the car exists.
 *
 * Historical and reversal paths (refund, forfeit, void, release, rejection, cancellation,
 * settlement) deliberately do NOT call this: a deleted car's money must still be able to leave.
 */

export const VEHICLE_DELETED_MESSAGE =
  "This vehicle has been deleted and can no longer be quoted, reserved, sold or take a deposit.";

/** True when the vehicle is soft-deleted. */
export const isVehicleDeleted = (v: Doc<"vehicles">): boolean => v.isDeleted === true;

const DELETED_VEHICLE_MESSAGES = {
  [AppErrorCode.VEHICLE_ALREADY_SOLD]: "This vehicle has already been sold.",
  [AppErrorCode.VEHICLE_ARCHIVED]: "Cannot sell an archived vehicle. Restore it first.",
  [AppErrorCode.VEHICLE_DELETED]: VEHICLE_DELETED_MESSAGE,
} as const;

type DeletedVehicleRefusal = keyof typeof DELETED_VEHICLE_MESSAGES;

/**
 * The ONE precedence ordering (SOLD, then ARCHIVED, then DELETED) for a soft-deleted car; null for a live one.
 */
function deletedVehicleRefusal(vehicle: Doc<"vehicles">): DeletedVehicleRefusal | null {
  if (!isVehicleDeleted(vehicle)) return null;
  if (vehicle.status === "SOLD") return AppErrorCode.VEHICLE_ALREADY_SOLD;
  if (vehicle.status === "ARCHIVED") return AppErrorCode.VEHICLE_ARCHIVED;
  return AppErrorCode.VEHICLE_DELETED;
}

/** Throws unless a vehicle the caller has already scoped to its organisation is not soft-deleted. No-op for null. */
export function assertVehicleNotDeleted(vehicle: Doc<"vehicles"> | null | undefined): void {
  const refusal = vehicle ? deletedVehicleRefusal(vehicle) : null;
  if (refusal) throwAppError(refusal, DELETED_VEHICLE_MESSAGES[refusal]);
}

/**
 * The acquisition authority's liveness check (see `commitments.ts`). With a `vehicle` the check runs on that
 * document with no read; otherwise it reads once. A missing or foreign car is left to the caller's own
 * not-found behaviour (never reported as DELETED).
 */
export async function assertAcquisitionTargetLive(
  ctx: QueryCtx | MutationCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles">; vehicle?: Doc<"vehicles"> }
): Promise<void> {
  if (args.vehicle && args.vehicle._id !== args.vehicleId) {
    throw new Error(`provided vehicle ${args.vehicle._id} does not match acquisition target ${args.vehicleId}`);
  }
  const vehicle = args.vehicle ?? (await ctx.db.get(args.vehicleId));
  if (vehicle && vehicle.orgId === args.orgId) assertVehicleNotDeleted(vehicle);
}

/**
 * The whole check for a door with no existing not-found path: missing or foreign is
 * VEHICLE_NOT_FOUND (never DELETED), then a deleted car is refused.
 */
export function requireCommercialVehicle(
  vehicle: Doc<"vehicles"> | null | undefined,
  orgId: Id<"organizations">
): Doc<"vehicles"> {
  if (!vehicle || vehicle.orgId !== orgId) {
    throwAppError(AppErrorCode.VEHICLE_NOT_FOUND, "Vehicle not found in this organization.");
  }
  assertVehicleNotDeleted(vehicle);
  return vehicle;
}
