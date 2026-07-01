import { ConvexError } from "convex/values";

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
