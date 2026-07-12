import { ConvexError, v } from "convex/values";

// Phase 61 trust-passport fields — shared across the vehicles table schema,
// the direct create/update mutations, and the vehicleEdits request/approval
// payloads, so the validator shape only needs to change in one place.
// PARTNER_VERIFIED is deliberately excluded here: it's reserved for a future
// partner-API integration and is never accepted from these dealer-facing
// entry points (see vehicles table schema for the full 3-literal union).
export const trustPassportFieldValidators = {
  inspectionStatus: v.optional(v.union(v.literal("NONE"), v.literal("SELF_REPORTED"))),
  accidentDisclosed: v.optional(v.boolean()),
  ownerCount: v.optional(v.number()),
  dealerGuarantee: v.optional(v.boolean()),
};

export const vehicleLifecycleStatuses = [
  "AVAILABLE",
  "RESERVED",
  "SOLD",
  "IN_INSPECTION",
  "IN_REPAIR",
  "ARCHIVED",
  "SOURCING",
] as const;

export type VehicleLifecycleStatus = (typeof vehicleLifecycleStatuses)[number];

const knownVehicleStatuses = new Set<string>(vehicleLifecycleStatuses);
const workflowControlledStatuses = new Set<VehicleLifecycleStatus>(["RESERVED", "SOLD"]);

export function normalizeVehicleStatus(
  status: string | undefined,
): VehicleLifecycleStatus | undefined {
  if (status === undefined) return undefined;

  const normalized = status.trim().toUpperCase();
  if (!knownVehicleStatuses.has(normalized)) {
    throw new ConvexError("Invalid vehicle status.");
  }

  return normalized as VehicleLifecycleStatus;
}

export function assertDirectVehicleCreateStatus(status: string | undefined) {
  const normalizedStatus = normalizeVehicleStatus(status);
  if (!normalizedStatus) return;

  if (workflowControlledStatuses.has(normalizedStatus)) {
    throw new ConvexError(
      normalizedStatus === "SOLD"
        ? "Complete a sale to mark a vehicle as sold."
        : "Create a reservation or hold deposit to reserve a vehicle.",
    );
  }
}

export function assertDirectVehicleStatusTransition(
  currentStatus: string,
  nextStatus: string | undefined,
) {
  const normalizedCurrent = normalizeVehicleStatus(currentStatus);
  const normalizedNext = normalizeVehicleStatus(nextStatus);
  if (!normalizedNext || normalizedNext === normalizedCurrent) return;

  if (workflowControlledStatuses.has(normalizedNext)) {
    throw new ConvexError(
      normalizedNext === "SOLD"
        ? "Complete a sale to mark a vehicle as sold."
        : "Create a reservation or hold deposit to reserve a vehicle.",
    );
  }

  if (normalizedCurrent && workflowControlledStatuses.has(normalizedCurrent)) {
    throw new ConvexError(
      normalizedCurrent === "SOLD"
        ? "Cancel or reverse the sale workflow before changing this vehicle status."
        : "Release the reservation or deposit workflow before changing this vehicle status.",
    );
  }
}
