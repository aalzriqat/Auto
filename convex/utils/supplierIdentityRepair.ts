/**
 * SCRUM-868 P3 round 2: how a supplier money row written before supplier ids existed gets its id.
 *
 * WHY THIS EXISTS. P2 is deployed. Sale completion, the cost-recovery opener and the concession
 * recorder on `main` wrote supplier payables, receivables, recoveries and concession bases with a
 * NAME and no `supplierId`. P3 makes every settlement door (and the concession completion check)
 * refuse a row with no id, and no door can give an existing row one. Without this repair those
 * rows would be refused for the rest of their life, and a handed-over concession deal could not be
 * finalized (the deal cannot be reopened and its gap cannot be resolved twice).
 *
 * THE ONE RULE. A row's id comes ONLY from the frozen supplier link of the vehicle the row belongs
 * to (`vehicles.sourcedSupplierId`, frozen by N11 once money exists). A name is never an id source
 * (invariant I3): it is corroboration. The id is written only when ALL of these hold, and every
 * failure leaves the row exactly as it was:
 *   1. the vehicle exists, belongs to the same organization, and is a SOURCED (consignment) car;
 *   2. the vehicle carries a `sourcedSupplierId`;
 *   3. that supplier exists in the same organization;
 *   4. the name stored on the row is that supplier master's display name, or one of its aliases
 *      (ACTIVE or RETIRED), compared by the registry's own `normalizeNameKey`;
 *   5. if the row recorded a snapshot version, the master has reached it (a row cannot have seen a
 *      version the master never had).
 * No version is invented: a row that recorded none gets none. The audit stamp records that the id came
 * from the vehicle link and what the name matched on.
 *
 * Read-only helpers only; the writers are in `convex/supplierIdentityRepair.ts`.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { supplierNameEvidence } from "./supplierRegistry";
import { storedVehicleSourceType } from "./vehicleSourceShape";

/** Rows examined by one repair or count call unless the caller asks for fewer. */
export const REPAIR_PAGE_DEFAULT = 25;
/**
 * The hard ceiling on one call, whatever the caller sends. A page reads at most this many rows, and
 * each row costs one vehicle read, one supplier read and two alias point reads, so a page stays far
 * inside a single transaction's read and write limits (https://docs.convex.dev/production/state/limits).
 */
export const REPAIR_PAGE_MAX = 100;

export function clampRepairPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return REPAIR_PAGE_DEFAULT;
  return Math.min(REPAIR_PAGE_MAX, Math.max(1, Math.floor(requested)));
}

/** Why a row could not be bound. Fixed vocabulary: it is printed as a count by the release step. */
export type UnresolvedReason =
  | "NO_VEHICLE"
  | "VEHICLE_OTHER_ORG"
  | "VEHICLE_NOT_SOURCED"
  | "VEHICLE_NO_SUPPLIER_LINK"
  | "SUPPLIER_NOT_IN_ORG"
  | "NAME_MISMATCH"
  | "VERSION_AHEAD_OF_MASTER";

export type LinkVerdict =
  | { kind: "RESOLVED"; supplierId: Id<"suppliers">; nameMatchedOn: "DISPLAY_NAME" | "ALIAS" }
  | { kind: "UNRESOLVED"; reason: UnresolvedReason };

export type RepairStamp = { at: number; source: "VEHICLE_LINK"; nameMatchedOn: "DISPLAY_NAME" | "ALIAS" };

export const UNRESOLVED_REASONS: readonly UnresolvedReason[] = [
  "NO_VEHICLE",
  "VEHICLE_OTHER_ORG",
  "VEHICLE_NOT_SOURCED",
  "VEHICLE_NO_SUPPLIER_LINK",
  "SUPPLIER_NOT_IN_ORG",
  "NAME_MISMATCH",
  "VERSION_AHEAD_OF_MASTER",
];

export type ReasonCounts = Record<UnresolvedReason, number>;

export function emptyReasonCounts(): ReasonCounts {
  return {
    NO_VEHICLE: 0,
    VEHICLE_OTHER_ORG: 0,
    VEHICLE_NOT_SOURCED: 0,
    VEHICLE_NO_SUPPLIER_LINK: 0,
    SUPPLIER_NOT_IN_ORG: 0,
    NAME_MISMATCH: 0,
    VERSION_AHEAD_OF_MASTER: 0,
  };
}

/**
 * Decides whether a row on `vehicleId`, carrying `snapshot`, may be bound to the vehicle's frozen
 * supplier. Pure decision plus point reads; the caller writes.
 */
export async function evaluateVehicleLink(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles"> | undefined,
  snapshot: { name: string; version?: number },
): Promise<LinkVerdict> {
  if (vehicleId === undefined) return { kind: "UNRESOLVED", reason: "NO_VEHICLE" };
  const vehicle = await ctx.db.get("vehicles", vehicleId);
  if (!vehicle) return { kind: "UNRESOLVED", reason: "NO_VEHICLE" };
  if (vehicle.orgId !== orgId) return { kind: "UNRESOLVED", reason: "VEHICLE_OTHER_ORG" };
  if (storedVehicleSourceType(vehicle.sourceType) !== "SOURCED") {
    return { kind: "UNRESOLVED", reason: "VEHICLE_NOT_SOURCED" };
  }
  if (vehicle.sourcedSupplierId === undefined) return { kind: "UNRESOLVED", reason: "VEHICLE_NO_SUPPLIER_LINK" };
  const evidence = await supplierNameEvidence(ctx, orgId, vehicle.sourcedSupplierId, snapshot.name);
  if (evidence.kind === "NOT_IN_ORG") return { kind: "UNRESOLVED", reason: "SUPPLIER_NOT_IN_ORG" };
  if (evidence.kind === "NO_NAME_MATCH") return { kind: "UNRESOLVED", reason: "NAME_MISMATCH" };
  if (
    snapshot.version !== undefined &&
    (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || snapshot.version > evidence.version)
  ) {
    return { kind: "UNRESOLVED", reason: "VERSION_AHEAD_OF_MASTER" };
  }
  return { kind: "RESOLVED", supplierId: vehicle.sourcedSupplierId, nameMatchedOn: evidence.matchedOn };
}

export function repairStamp(at: number, nameMatchedOn: "DISPLAY_NAME" | "ALIAS"): RepairStamp {
  return { at, source: "VEHICLE_LINK", nameMatchedOn };
}
