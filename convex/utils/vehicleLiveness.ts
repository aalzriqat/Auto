import type { Doc, Id } from "../_generated/dataModel";
import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-641 (D-35) — a soft-deleted vehicle is never commercial again.
 *
 * ONE definition of "this car may take new commercial authority" so every door that gives a car a
 * quote, draft, hold, deposit, allocation, profit approval, finance approval or sale asks the same
 * question and refuses with the same coded error.
 *
 * ⚠️ PRECEDENCE IS PART OF THE CONTRACT. A car that is deleted AND sold (or archived) keeps
 * reporting SOLD (or ARCHIVED): that is the more specific, older fact and the one callers and
 * tests already know. DELETED is reported only for a car that is otherwise sellable.
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

/** Throws unless a vehicle the caller has already scoped to its organisation is not soft-deleted. No-op for null. */
export function assertVehicleNotDeleted(vehicle: Doc<"vehicles"> | null | undefined): void {
  if (!vehicle || vehicle.isDeleted !== true) return;
  if (vehicle.status === "SOLD") {
    throwAppError(AppErrorCode.VEHICLE_ALREADY_SOLD, "This vehicle has already been sold.");
  }
  if (vehicle.status === "ARCHIVED") {
    throwAppError(AppErrorCode.VEHICLE_ARCHIVED, "Cannot sell an archived vehicle. Restore it first.");
  }
  throwAppError(AppErrorCode.VEHICLE_DELETED, VEHICLE_DELETED_MESSAGE);
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
