/**
 * SCRUM-766 PR-C: the supplier concession on a SOURCED (consigned) vehicle.
 *
 * Owner ruling SCRUM-760 c23812, ruling 3 (2026-10-28): the supplier may absorb part or
 * all of the server-computed TOTAL NET SHORTFALL by conceding part of his own entitlement.
 * SOURCED vehicles only; a stock car's concession stays refused.
 *
 *   contract entitlement  E   = vehicle.sourceCost (the supplier agreement)
 *   concession            S   = application.supplierGapShareMinor, 0 <= S < E
 *   effective entitlement E_eff = E - S  (what the dealership owes him at completion)
 *   financed consigned margin M = K - E_eff - contra
 *       K = the server-derived consideration, contra = the showroom's contribution
 *       reduction. M is the ONE commission basis, at completion and at recalculation.
 *
 * Why the concession is not a new account: the dealership's payable to the supplier is
 * E_eff instead of E, and the agent's commission (A - E_eff on the THROUGH route) rises by
 * exactly S. Nothing is paid to or received from the supplier for S, so no cash and no new
 * ledger account is involved. Standards: IFRS 15 B34-B38 (an agent recognises only its
 * fee); a concession agreed AFTER the price is fixed would be a transaction-price change
 * (IFRS 15.50-59), which is why a post-finalize concession stays refused (pending owner
 * ruling Q2). Not checked: Jordanian GAAP, auditor acceptance, supplier-agreement
 * enforceability.
 *
 * Everything here is server-side derivation: no figure is read from a client argument
 * except the supplier terms the operator OBSERVED, which are only ever compared, never used.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { IN_FLIGHT_FINANCE_STATUSES } from "./financeStatuses";
import { denominationOf, toMinorUnits } from "./money";
import { isConsignedAgentSale } from "./vehicleOwnership";

/**
 * Refusal messages. None carries a figure: the callers of the vehicle-edit and completion
 * doors may hold no finance view, and a refusal is a response like any other (ACC-10).
 */
export const SUPPLIER_CONCESSION_REFUSALS = {
  NOT_SOURCED:
    "A supplier concession applies only to a sourced (consigned) vehicle. This vehicle is dealership stock, so the shortfall cannot be placed on a supplier.",
  MULTI_VEHICLE:
    "A supplier concession cannot be recorded on an application with more than one vehicle.",
  BASIS_REQUIRED:
    "A supplier concession must be recorded against the supplier terms you reviewed. Reload the deal and confirm the supplier and the amount owed to him before recording it.",
  BASIS_STALE:
    "The supplier terms on this vehicle are not what the supplier concession was agreed against. Re-check the supplier and the amount owed to him, then record the concession again.",
  NO_ENTITLEMENT:
    "This vehicle has no recorded amount owed to its supplier, so a supplier concession cannot be recorded against it.",
  NOT_BELOW_ENTITLEMENT:
    "A supplier concession must leave the supplier with something. It cannot be as large as everything he is owed on this vehicle.",
  INVALID_AMOUNT:
    "A supplier concession must be a whole number of minor units that is not negative.",
  UNAVAILABLE_SHORTFALL:
    "The shortfall on this deal could not be worked out from its recorded quotation, so a supplier concession cannot be recorded against it.",
  HELD_BY_DEAL:
    "This vehicle's supplier terms are held by a supplier concession on an open deal. Reopen that deal's approved amount to release the concession before changing the supplier, the cost or the vehicle type.",
} as const;

/**
 * Pending owner ruling Q3: may a concession be recorded against a GROSS_MANUAL shortfall (the
 * operator-typed fallback when the quotation cannot be netted)? True by default because the
 * shortfall is still server-computed and the shares must conserve to it; set false to refuse.
 * UNAVAILABLE shortfalls are always refused.
 */
export const SUPPLIER_CONCESSION_ALLOWS_GROSS_MANUAL = true as boolean;

/** What the stored basis records: the supplier terms the concession was agreed against. */
export interface SupplierConcessionBasis {
  contractEntitlementMinor: number;
  currency: string;
  supplierName: string;
  supplierId?: Id<"suppliers">;
}

const isSafeMinor = (value: number): boolean => Number.isSafeInteger(value);

/**
 * E_eff = E - S. Both must be safe integers and 0 <= S < E, so the supplier is always left
 * with at least one minor unit: a payable cannot be zeroed by a concession, and a corrupt
 * stored figure (NaN, a fraction, 2^53) is refused rather than carried into the books.
 */
export function effectiveSupplierEntitlementMinor(args: {
  entitlementMinor: number;
  concessionMinor: number;
}): number {
  const { entitlementMinor, concessionMinor } = args;
  if (!isSafeMinor(entitlementMinor) || entitlementMinor <= 0) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.NO_ENTITLEMENT);
  }
  if (!isSafeMinor(concessionMinor) || concessionMinor < 0) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.INVALID_AMOUNT);
  }
  if (concessionMinor >= entitlementMinor) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.NOT_BELOW_ENTITLEMENT);
  }
  return entitlementMinor - concessionMinor;
}

/**
 * M = K - E_eff - contra, signed. The shared commission margin of a financed consigned deal
 * (owner c22421: whoever covers the gap, the margin is the same). The commission clamps a
 * loss at zero where it is used; the signed figure is what is frozen.
 */
export function financedConsignedNetMinor(args: {
  considerationMinor: number;
  entitlementMinor: number;
  contraMinor: number;
}): number {
  const { considerationMinor, entitlementMinor, contraMinor } = args;
  for (const value of [considerationMinor, entitlementMinor, contraMinor]) {
    if (!isSafeMinor(value)) {
      throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.INVALID_AMOUNT);
    }
  }
  const net = considerationMinor - entitlementMinor - contraMinor;
  if (!isSafeMinor(net)) throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.INVALID_AMOUNT);
  return net;
}

/** Every vehicle the application covers: `vehicleItems ?? [{ vehicleId }]`. */
export function applicationVehicleIds(
  app: Pick<Doc<"financeApplications">, "vehicleId" | "vehicleItems">
): Id<"vehicles">[] {
  return app.vehicleItems && app.vehicleItems.length > 0
    ? app.vehicleItems.map((item) => item.vehicleId)
    : [app.vehicleId];
}

/** The concession stored on an application: 0 when none, throws on a corrupt stored value. */
export function storedConcessionMinor(
  app: Pick<Doc<"financeApplications">, "supplierGapShareMinor">
): number {
  const stored = app.supplierGapShareMinor;
  if (stored === undefined) return 0;
  if (!isSafeMinor(stored) || stored < 0) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.INVALID_AMOUNT);
  }
  return stored;
}

/**
 * The supplier's contractual entitlement E in minor units, from the vehicle row (whose
 * `sourceCost` is in MAJOR units), or `undefined` when the vehicle is not consigned, has no
 * usable cost, or the currency is not a supported canonical code.
 */
export function contractEntitlementMinorOf(
  vehicle: Pick<Doc<"vehicles">, "sourceType" | "sourceCost">,
  currency: string
): number | undefined {
  if (!isConsignedAgentSale(vehicle)) return undefined;
  if (denominationOf(currency) === null) return undefined;
  const cost = vehicle.sourceCost;
  if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return undefined;
  const minor = toMinorUnits(cost, currency);
  return minor > 0 ? minor : undefined;
}

const sameName = (a: string | undefined, b: string): boolean => (a ?? "").trim() === b.trim();

/**
 * At RESOLUTION: the operator's observed supplier terms must equal the vehicle's now. Returns
 * the basis to store. Refuses a stock car, a vehicle with no entitlement, an unobserved
 * basis, and a basis that has moved since the dialog rendered.
 *
 * The counterparty is compared by its ID, not by its name (SCRUM-868 P3, Seat 2 B1). A name is
 * a label two different suppliers can share, so a basis observed for supplier A would otherwise
 * be recorded against supplier B once the vehicle moved to a same-name, same-terms B, and the
 * concession would shrink B's payable. The id is the key ERP payables use for the supplier
 * (Oracle Payables: a supplier's unique identifiers, not its name, key its transactions). The
 * observed id must be present and equal the vehicle's current id; a vehicle with no id cannot
 * be bound to a counterparty and is refused. A foreign, deleted or invented observed id fails
 * the same equality, so the refusal reveals nothing about which ids exist.
 */
export function assertObservedBasisMatchesVehicle(args: {
  vehicle: Pick<Doc<"vehicles">, "sourceType" | "sourceCost" | "sourcedFromName" | "sourcedSupplierId">;
  currency: string;
  concessionMinor: number;
  observedEntitlementMinor: number | undefined;
  observedSupplierName: string | undefined;
  observedSupplierId: Id<"suppliers"> | undefined;
}): SupplierConcessionBasis {
  const { vehicle, currency, concessionMinor } = args;
  if (!isConsignedAgentSale(vehicle)) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.NOT_SOURCED);
  }
  const entitlementMinor = contractEntitlementMinorOf(vehicle, currency);
  if (entitlementMinor === undefined) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.NO_ENTITLEMENT);
  }
  const supplierName = (vehicle.sourcedFromName ?? "").trim();
  if (supplierName === "") {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.BASIS_STALE);
  }
  if (
    args.observedEntitlementMinor === undefined ||
    args.observedSupplierName === undefined ||
    args.observedSupplierId === undefined
  ) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.BASIS_REQUIRED);
  }
  if (
    args.observedEntitlementMinor !== entitlementMinor ||
    !sameName(args.observedSupplierName, supplierName) ||
    vehicle.sourcedSupplierId === undefined ||
    args.observedSupplierId !== vehicle.sourcedSupplierId
  ) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.BASIS_STALE);
  }
  // Bounds last, so a wrong basis is reported as such before an amount problem.
  effectiveSupplierEntitlementMinor({ entitlementMinor, concessionMinor });
  return { contractEntitlementMinor: entitlementMinor, currency, supplierName, supplierId: vehicle.sourcedSupplierId };
}

/**
 * At COMPLETION: the stored concession is applied only if the vehicle is still the contract
 * it was agreed against. Returns {contract E, concession S, effective E_eff} for the sale to
 * freeze; for a deal with no concession returns S = 0 and E_eff = E untouched.
 */
export function resolveEffectiveEntitlementForCompletion(args: {
  app: Pick<
    Doc<"financeApplications">,
    "vehicleId" | "vehicleItems" | "supplierGapShareMinor" | "supplierGapBasis"
  >;
  vehicle: Pick<Doc<"vehicles">, "sourceType" | "sourceCost" | "sourcedFromName" | "sourcedSupplierId">;
  currency: string;
}): { concessionMinor: number; contractEntitlementMinor: number | undefined } {
  const concessionMinor = storedConcessionMinor(args.app);
  const contractEntitlementMinor = contractEntitlementMinorOf(args.vehicle, args.currency);
  if (concessionMinor === 0) {
    return { concessionMinor: 0, contractEntitlementMinor };
  }
  if (!isConsignedAgentSale(args.vehicle)) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.NOT_SOURCED);
  }
  if (applicationVehicleIds(args.app).length !== 1) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.MULTI_VEHICLE);
  }
  const basis = args.app.supplierGapBasis;
  if (
    basis === undefined ||
    contractEntitlementMinor === undefined ||
    basis.contractEntitlementMinor !== contractEntitlementMinor ||
    basis.currency !== args.currency ||
    !sameName(args.vehicle.sourcedFromName, basis.supplierName) ||
    !basis.supplierId ||
    basis.supplierId !== args.vehicle.sourcedSupplierId
  ) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.BASIS_STALE);
  }
  // Called for its refusal (a concession must stay strictly below the entitlement); the
  // effective figure itself is recomputed by the caller from the plan.
  effectiveSupplierEntitlementMinor({ entitlementMinor: contractEntitlementMinor, concessionMinor });
  return { concessionMinor, contractEntitlementMinor };
}

/** Upper bound on applications examined per vehicle; reaching it fails closed. */
const APPLICATIONS_PER_VEHICLE_BOUND = 200;

/**
 * Refuses a change to the supplier terms (cost, supplier name, vehicle type) of a vehicle
 * that an OPEN application holds a supplier concession against. The concession was agreed
 * against those terms and is revalidated at completion; refusing the edit up front gives
 * the operator the reason at the time instead of a blocked closing later. Releasing it is
 * a recorded act: reopen the approved amount, which clears the concession.
 */
export async function assertNoHeldSupplierConcession(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<void> {
  const applications = await ctx.db
    .query("financeApplications")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
    .take(APPLICATIONS_PER_VEHICLE_BOUND);
  if (applications.length >= APPLICATIONS_PER_VEHICLE_BOUND) {
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.HELD_BY_DEAL);
  }
  for (const app of applications) {
    if ((app.supplierGapShareMinor ?? 0) <= 0) continue;
    if (app.finalizedSaleId !== undefined) continue;
    // Cancelled, rejected or closed: the application no longer holds its car, so it released the concession.
    if (!IN_FLIGHT_FINANCE_STATUSES.includes(app.status)) continue;
    throw new ConvexError(SUPPLIER_CONCESSION_REFUSALS.HELD_BY_DEAL);
  }
}
