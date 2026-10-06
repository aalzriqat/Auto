/**
 * SCRUM-717 (D-45): the ONE definition of a coherent vehicle ownership shape.
 *
 * A vehicle is either
 *   - SOURCED  ("برسم البيع", consignment): the supplier's car. It carries the
 *     supplier's name and a positive agreed cost, and nothing is paid or posted
 *     at intake; or
 *   - STOCK    (owned): the dealership bought it. It carries `purchasePrice` and a
 *     settlement method, and NEVER a consignment supplier or supplier cost.
 *
 * `sourcedFromName` used to double as the creditor of an owned car bought ON
 * ACCOUNT. That overload is what let a STOCK row carry consignment fields, so the
 * owned creditor now travels in its own argument (`purchaseSupplierName`) and
 * this guard REFUSES, never strips, a submission that contradicts itself.
 *
 * Pure: it reads no database, so every door (create, request/approve, update,
 * createSourced, importBulk) applies the identical rule.
 */
import { AppErrorCode, throwAppError } from "./errors";

export type VehicleSourceType = "STOCK" | "SOURCED";

/** The fields that describe a vehicle's ownership. All optional: an update carries a subset. */
export interface VehicleSourceFields {
  sourceType?: string | null;
  sourcedFromName?: string | null;
  sourceCost?: number | null;
}

/** English texts equal the dictionary entries under ServerError_<code> (lib/i18n/domains/common.ts). */
export const VEHICLE_SOURCE_SHAPE_MESSAGES = {
  VEHICLE_SOURCE_TYPE_REQUIRED:
    "Choose how this vehicle is held before saving: consignment (on sale for a supplier, nothing paid now) or owned by the dealership.",
  VEHICLE_STOCK_CARRIES_SOURCING:
    "An owned vehicle can't carry a consignment supplier or supplier cost. Remove them, or mark the vehicle as consignment.",
  VEHICLE_SOURCED_SUPPLIER_REQUIRED: "A consignment vehicle needs the supplier's name.",
  VEHICLE_SOURCED_COST_INVALID: "A consignment vehicle needs a supplier cost greater than zero.",
  VEHICLE_PURCHASE_SUPPLIER_REQUIRED: "A supplier name is required for a vehicle purchased on account.",
  VEHICLE_OWNERSHIP_FLIP_POSTED:
    "This vehicle's purchase has already been posted to accounting, so it can't be changed to consignment. To fix a mistaken entry, use 'Correct purchase cost' or ask your accountant for a reversal.",
  VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE:
    "Changing how a vehicle is held (consignment or owned) can't go through an approval request. A finance user makes this change directly from the vehicle's edit screen.",
  VEHICLE_BUYOUT_TERMS_REQUIRED:
    "Buying out a consignment vehicle needs the agreed purchase price (greater than zero) and how it was paid. For a purchase on account, also enter the supplier's name.",
  VEHICLE_OWNERSHIP_FIELDS_LOCKED:
    "A vehicle's ownership type, consignment supplier, supplier cost, purchase price and payment method drive accounting and can't be changed in the data browser. Use the vehicle's edit screen or the cost-correction workflow.",
} as const;

export type VehicleSourceShapeCode = keyof typeof VEHICLE_SOURCE_SHAPE_MESSAGES;

/** Throws the coded refusal for `code` with its English message. */
export function throwVehicleSourceShape(code: VehicleSourceShapeCode): never {
  throwAppError(AppErrorCode[code], VEHICLE_SOURCE_SHAPE_MESSAGES[code]);
}

/**
 * Canonical type of a submitted value, or null when it is blank or unrecognised.
 * Trim and case are forgiven (a spreadsheet cell says "sourced "); nothing else is.
 */
export function parseVehicleSourceType(raw: string | null | undefined): VehicleSourceType | null {
  const value = (raw ?? "").trim().toUpperCase();
  return value === "STOCK" || value === "SOURCED" ? value : null;
}

const hasText = (value: string | null | undefined) => (value ?? "").trim().length > 0;
const hasNumber = (value: number | null | undefined) => value !== undefined && value !== null;

/** What a stored row means by its (possibly absent) sourceType: absent is owned stock. */
export function storedVehicleSourceType(raw: string | null | undefined): VehicleSourceType {
  return parseVehicleSourceType(raw) ?? "STOCK";
}

function assertShapeFor(type: VehicleSourceType, name: string | null | undefined, cost: number | null | undefined): void {
  if (type === "STOCK") {
    if (hasText(name) || hasNumber(cost)) throwVehicleSourceShape("VEHICLE_STOCK_CARRIES_SOURCING");
    return;
  }
  if (!hasText(name)) throwVehicleSourceShape("VEHICLE_SOURCED_SUPPLIER_REQUIRED");
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
    throwVehicleSourceShape("VEHICLE_SOURCED_COST_INVALID");
  }
}

/**
 * INTAKE: a vehicle being created. The type must be an explicit, recognised
 * choice (no default to STOCK), and the fields must agree with it. Returns the
 * canonical type. Call it on the RAW submission, before any normalisation.
 */
export function assertVehicleIntakeSourceShape(input: VehicleSourceFields): VehicleSourceType {
  const type = parseVehicleSourceType(input.sourceType);
  if (!type) throwVehicleSourceShape("VEHICLE_SOURCE_TYPE_REQUIRED");
  assertShapeFor(type, input.sourcedFromName, input.sourceCost);
  return type;
}

/**
 * UPDATE: fires only when the patch CHANGES the type, the supplier or the cost
 * relative to the stored row, so an existing inconsistent row (a STOCK car that
 * already carries a supplier) can still have unrelated fields edited, and a
 * round-tripped unchanged value passes.
 *
 * For a STOCK target only what the patch itself submits is judged: values the row
 * already carries (for example after a buy-out) are history, not a new claim.
 */
export function assertVehicleSourceShapeOnUpdate(
  existing: VehicleSourceFields,
  patch: VehicleSourceFields
): void {
  const existingType = storedVehicleSourceType(existing.sourceType);
  const patchType = parseVehicleSourceType(patch.sourceType);
  if (patch.sourceType != null && !patchType) throwVehicleSourceShape("VEHICLE_SOURCE_TYPE_REQUIRED");
  const typeChanges = patchType !== null && patchType !== existingType;
  const nameChanges =
    patch.sourcedFromName !== undefined &&
    (patch.sourcedFromName ?? "").trim() !== (existing.sourcedFromName ?? "").trim();
  const costChanges =
    patch.sourceCost !== undefined && (patch.sourceCost ?? undefined) !== (existing.sourceCost ?? undefined);
  if (!typeChanges && !nameChanges && !costChanges) return;

  const targetType = patchType ?? existingType;
  if (targetType === "STOCK") {
    if ((nameChanges && hasText(patch.sourcedFromName)) || (costChanges && hasNumber(patch.sourceCost))) {
      throwVehicleSourceShape("VEHICLE_STOCK_CARRIES_SOURCING");
    }
    return;
  }
  assertShapeFor(
    "SOURCED",
    patch.sourcedFromName !== undefined ? patch.sourcedFromName : existing.sourcedFromName,
    patch.sourceCost !== undefined ? patch.sourceCost : existing.sourceCost
  );
}

/**
 * The settlement of an OWNED purchase: a priced car must say how it was paid, and
 * an on-account purchase must name its creditor in `purchaseSupplierName` (never
 * `sourcedFromName`). Both are required before anything is written.
 */
export function assertOwnedPurchaseTerms(input: OwnedPurchaseTermsInput): void {
  const priced = typeof input.purchasePrice === "number" && input.purchasePrice > 0;
  if (priced && !input.purchasePaymentMethod) {
    throwAppError(AppErrorCode.VALIDATION_FAILED, "Payment method is required when a purchase price is entered.");
  }
  assertOnAccountHasCreditor(input.purchasePaymentMethod, input.purchaseSupplierName);
}

export interface OwnedPurchaseTermsInput {
  purchasePrice?: number | null;
  purchasePaymentMethod?: string | null;
  purchaseSupplierName?: string | null;
}

/** An on-account purchase must name its creditor; any other method needs none. */
export function assertOnAccountHasCreditor(
  method: string | null | undefined,
  creditorName: string | null | undefined
): void {
  if (method === "ON_ACCOUNT" && !hasText(creditorName)) {
    throwVehicleSourceShape("VEHICLE_PURCHASE_SUPPLIER_REQUIRED");
  }
}

/**
 * True when the submission states a positive finite price, a settlement method
 * and (for ON_ACCOUNT) a creditor — the buy-out / owned-purchase terms in full.
 */
export function ownedPurchaseTermsComplete(input: OwnedPurchaseTermsInput): boolean {
  return (
    typeof input.purchasePrice === "number" &&
    Number.isFinite(input.purchasePrice) &&
    input.purchasePrice > 0 &&
    !!input.purchasePaymentMethod &&
    (input.purchasePaymentMethod !== "ON_ACCOUNT" || hasText(input.purchaseSupplierName))
  );
}

/**
 * INTAKE of a new vehicle: the explicit, coherent ownership shape, plus — for an
 * owned (non-SOURCED) row — its purchase terms. Returns the canonical type.
 * (importBulk keeps the bare shape guard: its terms are batch-level.)
 */
export function assertVehicleIntake(input: VehicleSourceFields & OwnedPurchaseTermsInput): VehicleSourceType {
  const type = assertVehicleIntakeSourceShape(input);
  if (type !== "SOURCED") assertOwnedPurchaseTerms(input);
  return type;
}

/** Direct shape check for a consignment vehicle's supplier and cost. */
export function assertSourcedShape(name: string | null | undefined, cost: number | null | undefined): void {
  assertShapeFor("SOURCED", name, cost);
}

/**
 * The type a patch asks the vehicle to BECOME, or null when it names none or
 * names the type the stored row already has (absent stored type = STOCK).
 */
export function requestedVehicleSourceTypeChange(
  existing: VehicleSourceFields,
  patch: VehicleSourceFields
): VehicleSourceType | null {
  const requested = parseVehicleSourceType(patch.sourceType);
  return requested !== null && requested !== storedVehicleSourceType(existing.sourceType) ? requested : null;
}

/** The six fields that make up a vehicle's ownership and acquisition terms. */
export const VEHICLE_OWNERSHIP_FIELD_KEYS = [
  "sourceType",
  "sourcedFromName",
  "sourceCost",
  "purchasePrice",
  "purchasePaymentMethod",
  "purchaseSupplierName",
] as const;
