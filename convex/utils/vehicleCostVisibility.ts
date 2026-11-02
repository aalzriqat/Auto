/**
 * SCRUM-886: one server-side rule for which vehicle fields a caller may read.
 *
 * Standard: OWASP API3:2023 (Broken Object Property Level Authorization) and Convex's
 * authorization guidance (https://docs.convex.dev/auth/functions-auth): enforce on the server, per
 * caller, and return only the properties the caller may see.
 *
 * Before this module each reader hand-picked which cost fields to drop. `get` and `list` dropped
 * `purchasePrice` only, `listAll` dropped `purchasePrice` and `sourceCost`, and five readers
 * returned the stored row untouched, so `sourceCost`, `landedCostTotal` and `minimumProfit`
 * reached every role that holds `view:vehicles`.
 *
 * The restricted projection is an ALLOWLIST. `VEHICLE_READ_TIER` is total over the stored row
 * (a new schema field is a type error until it is classified), and a field is withheld unless it
 * is classified OPEN. A field that is hidden is ABSENT, never zeroed: a zero would read as "cost
 * nothing".
 *
 * Permission: the existing `view:cost_price` (`PERMISSIONS.VIEW_COST_PRICE`), or the system
 * owner, whom `requireTenantAuth` already lets through every permission list. No new grant.
 */
import type { Doc } from "../_generated/dataModel";
import { isSystemOwnerRole, PERMISSIONS } from "./permissions";

type VehicleReadTier = "OPEN" | "COST";

/**
 * Every stored vehicle field, classified. COST fields are the acquisition cost, the landed cost,
 * the consignment cost and the margin floor derived from them. Supplier identity
 * (`sourcedFromName`, `sourcedSupplierId`) stays OPEN: the vehicle screens show it to every viewer
 * today and it is not a price. That is a product decision recorded on SCRUM-886, not an oversight.
 */
export const VEHICLE_READ_TIER = {
  _id: "OPEN",
  _creationTime: "OPEN",
  orgId: "OPEN",
  openingStockImportId: "OPEN",
  openingStockRowId: "OPEN",
  openingBalanceDraftId: "OPEN",
  branchId: "OPEN",
  vin: "OPEN",
  make: "OPEN",
  model: "OPEN",
  year: "OPEN",
  trim: "OPEN",
  mileage: "OPEN",
  color: "OPEN",
  fuelType: "OPEN",
  transmission: "OPEN",
  purchasePrice: "COST",
  landedCostTotal: "COST",
  minimumProfit: "COST",
  sellingPrice: "OPEN",
  status: "OPEN",
  preHoldStatus: "OPEN",
  soldBySaleId: "OPEN",
  sourceType: "OPEN",
  sourcedFromName: "OPEN",
  sourcedSupplierId: "OPEN",
  sourceCost: "COST",
  arrivedAt: "OPEN",
  notes: "OPEN",
  imageIds: "OPEN",
  inspectionStatus: "OPEN",
  accidentDisclosed: "OPEN",
  ownerCount: "OPEN",
  dealerGuarantee: "OPEN",
  createdAt: "OPEN",
  addedBy: "OPEN",
  updatedBy: "OPEN",
  updatedAt: "OPEN",
  isDeleted: "OPEN",
  deletedAt: "OPEN",
  deletedBy: "OPEN",
} as const satisfies Record<keyof Doc<"vehicles">, VehicleReadTier>;

type VehicleEditPayload = Doc<"vehicleEdits">["payload"];

/**
 * The same classification for a pending or resolved edit request's `payload`, which carries the
 * proposed vehicle fields plus the acquisition payment routing (`purchasePaymentMethod`,
 * `bankAccountId`, `purchaseSupplierName`, `purchaseSupplierId`). Those four describe how and from
 * whom the car was bought, so they move with the price.
 */
export const VEHICLE_EDIT_PAYLOAD_TIER = {
  vin: "OPEN",
  make: "OPEN",
  model: "OPEN",
  year: "OPEN",
  trim: "OPEN",
  mileage: "OPEN",
  color: "OPEN",
  fuelType: "OPEN",
  transmission: "OPEN",
  purchasePrice: "COST",
  purchasePaymentMethod: "COST",
  bankAccountId: "COST",
  purchaseSupplierName: "COST",
  purchaseSupplierId: "COST",
  minimumProfit: "COST",
  sellingPrice: "OPEN",
  status: "OPEN",
  sourceType: "OPEN",
  sourcedFromName: "OPEN",
  sourcedSupplierId: "OPEN",
  sourceCost: "COST",
  notes: "OPEN",
  imageIds: "OPEN",
  inspectionStatus: "OPEN",
  accidentDisclosed: "OPEN",
  ownerCount: "OPEN",
  dealerGuarantee: "OPEN",
} as const satisfies Record<keyof VehicleEditPayload, VehicleReadTier>;

/** True when the caller may read vehicle cost and margin: the system owner, or `view:cost_price`. */
export function canReadVehicleCost(role: Doc<"roles">): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);
}

function keepOpenFields<T extends object>(source: T, tiers: Record<string, VehicleReadTier>): Partial<T> {
  const kept: Partial<T> = {};
  for (const key of Object.keys(source) as Array<keyof T & string>) {
    if (tiers[key] === "OPEN") kept[key] = source[key];
  }
  return kept;
}

/**
 * The vehicle as this caller may read it. A caller who may read cost gets the stored row. Any
 * other caller gets only the fields classified OPEN, so a field added to the schema later is
 * withheld until someone classifies it.
 */
export function projectVehicleForRole(vehicle: Doc<"vehicles">, role: Doc<"roles">): Doc<"vehicles"> {
  if (canReadVehicleCost(role)) return vehicle;
  return keepOpenFields(vehicle, VEHICLE_READ_TIER) as Doc<"vehicles">;
}

/** `projectVehicleForRole` for a reader that may have no vehicle (a missing or deleted row). */
export function projectOptionalVehicleForRole(
  vehicle: Doc<"vehicles"> | null | undefined,
  role: Doc<"roles">
): Doc<"vehicles"> | null {
  return vehicle ? projectVehicleForRole(vehicle, role) : null;
}

/**
 * True when an edit payload carries any field that is not classified OPEN (the same allowlist rule
 * as `keepOpenFields`, so an unclassified key counts as cost). A caller who cannot read cost must
 * not submit one: the server's answer to a submitted cost (a no-change refusal, a precision check
 * against the stored value) would tell them whether it equals the stored cost. Decided by which
 * keys are present, never by their values, so the answer carries no signal about the stored row.
 */
export function editPayloadCarriesCost(payload: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(payload).some(
    ([key, value]) => value !== undefined && VEHICLE_EDIT_PAYLOAD_TIER[key as keyof VehicleEditPayload] !== "OPEN"
  );
}

/** An edit request's payload as this caller may read it; same allowlist rule as the vehicle. */
export function projectVehicleEditPayloadForRole(
  payload: VehicleEditPayload,
  role: Doc<"roles">
): VehicleEditPayload {
  if (canReadVehicleCost(role)) return payload;
  return keepOpenFields(payload, VEHICLE_EDIT_PAYLOAD_TIER) as VehicleEditPayload;
}
