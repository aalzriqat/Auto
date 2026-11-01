/**
 * Which `vehicles` fields a JOINED read may return, by tier (SCRUM-811; OWASP API3:2023, Broken Object
 * Property Level Authorization).
 *
 * A query that joins a vehicle into another record (a quote's car on the customer screen) has already
 * proven the car belongs to the caller's org (`sameOrgOrNull`). That is object-level authorization. It
 * says nothing about which PROPERTIES of the car this caller may read: the dealer's cost sits behind
 * `view:cost_price` in `vehicles.get`, `vehicles.list`, `vehicles.listAll` and `dealOverview`, so a
 * joined copy of the same document must withhold it by the same rule. Returning the whole document and
 * trusting each screen to ignore the cost is the "expose the full object, filter on the client" shape
 * the OWASP guidance names.
 *
 * The table is TOTAL over the schema's vehicle fields (a new field without a classification is a type
 * error), so adding a field forces the choice. It is an allowlist: a field that is not DISPLAY or COST
 * is not served by this projection at all.
 *
 * Tiers:
 *  - DISPLAY: what identifies and describes the car on a customer-facing record, and what the quote
 *    print template reads (make, model, year, trim, VIN, mileage, fuel, transmission, colour, notes).
 *    Served to every caller who can read the joining record.
 *  - COST: the dealer's cost and margin floor. Served only to a caller who may read vehicle cost: the
 *    system owner or a role holding `view:cost_price`, the rule the vehicle queries and
 *    `dealOverview` already apply.
 *  - NOT_SERVED: identity of the consignment supplier, internal user ids, storage ids, list price and
 *    lifecycle state. No joined screen reads them; they remain available through `vehicles.get`, which
 *    is gated by `view:vehicles`.
 */
import type { Doc } from "../_generated/dataModel";
import { isSystemOwnerRole, PERMISSIONS } from "./permissions";

export type VehicleFieldVisibility = "DISPLAY" | "COST" | "NOT_SERVED";

export const VEHICLE_FIELD_VISIBILITY = {
  _id: "DISPLAY",
  _creationTime: "NOT_SERVED",
  orgId: "NOT_SERVED",
  openingStockImportId: "NOT_SERVED",
  openingStockRowId: "NOT_SERVED",
  openingBalanceDraftId: "NOT_SERVED",
  branchId: "NOT_SERVED",
  vin: "DISPLAY",
  make: "DISPLAY",
  model: "DISPLAY",
  year: "DISPLAY",
  trim: "DISPLAY",
  mileage: "DISPLAY",
  color: "DISPLAY",
  fuelType: "DISPLAY",
  transmission: "DISPLAY",
  purchasePrice: "COST",
  landedCostTotal: "COST",
  minimumProfit: "COST",
  sourceCost: "COST",
  sellingPrice: "NOT_SERVED",
  status: "NOT_SERVED",
  preHoldStatus: "NOT_SERVED",
  soldBySaleId: "NOT_SERVED",
  sourceType: "NOT_SERVED",
  sourcedFromName: "NOT_SERVED",
  sourcedSupplierId: "NOT_SERVED",
  arrivedAt: "NOT_SERVED",
  notes: "DISPLAY",
  imageIds: "NOT_SERVED",
  inspectionStatus: "NOT_SERVED",
  accidentDisclosed: "NOT_SERVED",
  ownerCount: "NOT_SERVED",
  dealerGuarantee: "NOT_SERVED",
  createdAt: "NOT_SERVED",
  addedBy: "NOT_SERVED",
  updatedBy: "NOT_SERVED",
  updatedAt: "NOT_SERVED",
  isDeleted: "NOT_SERVED",
  deletedAt: "NOT_SERVED",
  deletedBy: "NOT_SERVED",
} as const satisfies Record<keyof Doc<"vehicles">, VehicleFieldVisibility>;

type FieldsOfTier<Tier extends VehicleFieldVisibility> = {
  [Field in keyof typeof VEHICLE_FIELD_VISIBILITY]: (typeof VEHICLE_FIELD_VISIBILITY)[Field] extends Tier ? Field : never;
}[keyof typeof VEHICLE_FIELD_VISIBILITY];

/** The car as a joined screen may read it: display fields always, cost fields only for a caller who may read cost. */
export type ProjectedVehicle = Pick<Doc<"vehicles">, FieldsOfTier<"DISPLAY">> &
  Partial<Pick<Doc<"vehicles">, FieldsOfTier<"COST">>>;

const fieldsOfTier = (tier: VehicleFieldVisibility): string[] =>
  Object.entries(VEHICLE_FIELD_VISIBILITY)
    .filter(([, fieldTier]) => fieldTier === tier)
    .map(([field]) => field);

const DISPLAY_FIELDS = fieldsOfTier("DISPLAY");
const COST_FIELDS = fieldsOfTier("COST");

/** May this role read a vehicle's cost? The system owner, or `view:cost_price` (the rule `vehicles.get` and `dealOverview` apply). */
export function mayReadVehicleCost(role: Doc<"roles">): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);
}

/**
 * The vehicle as this caller may read it through a join. Fields are copied by allowlist, never by
 * spreading the stored document, and a cost field is absent (never zeroed) for a caller without cost
 * permission: a zero would read as "this car cost nothing", which is a claim.
 */
export function projectVehicleForJoin(vehicle: Doc<"vehicles">, role: Doc<"roles">): ProjectedVehicle {
  const served = mayReadVehicleCost(role) ? [...DISPLAY_FIELDS, ...COST_FIELDS] : DISPLAY_FIELDS;
  const source = vehicle as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of served) {
    if (source[field] !== undefined) projected[field] = source[field];
  }
  return projected as ProjectedVehicle;
}
