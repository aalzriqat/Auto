import { ConvexError } from "convex/values";
import { AppErrorCode } from "./errors";

/**
 * SCRUM-944: an opening-stock import proof (a COMPLETED `vehicles.importBulk.openingStock` command row) can outlive
 * its vehicle. The vehicle may have been deleted outside the app, soft-deleted, sold, or no longer carry a cost, so it
 * is no longer one of the organization's costed owned unsold stock cars. Every proof must still be matched by such a
 * car (the opening inventory control is the sum over exactly those cars), so the opening can never be saved while
 * one remains. That was always refused, but only by a generic totals message that names neither cause nor remedy.
 *
 * This refusal changes WHICH message the caller reads and nothing else: it is raised only where the generic totals
 * check would already have refused (see `prepareOpeningInventoryControls`), a proof is never dropped from the
 * evidence, and nothing is written.
 *
 * The VINs come from the proof's own `result.vin` in the caller's organization, so naming them reveals nothing
 * another tenant holds. The proof's vehicle row is deliberately never read: a proof can name a document of another
 * organization, and the operator's remedy is identical for every cause.
 *
 * LEAF MODULE (SCRUM-302): imports only `./errors`, so any convex module may import it without a cycle.
 */

/** At most this many VINs are named; the rest are counted in `more`. */
export const OPENING_STOCK_PROOF_VIN_LIMIT = 10;

// Identical to `ServerError_OPENING_STOCK_PROOF_ORPHANED` (English) in lib/i18n/domains/common.ts; the screen fills
// {count}, {vins} and {more} from the payload below.
export const OPENING_STOCK_PROOF_ORPHANED_TEMPLATE =
  "Some opening stock import proofs refer to cars that are no longer live owned stock (deleted, sold or without a cost), so the opening cannot be saved. Affected proofs: {count}. VINs: {vins}. Further proofs not listed: {more}. Ask finance or support to review the opening stock import proofs. Nothing has been changed.";

type OrphanedProofEvidence = { readonly vehicleId: string; readonly vin: string };

/** The proofs whose vehicle is not one of the live costed owned unsold cars. Order follows the evidence. */
export function orphanedOpeningStockProofs<Evidence extends OrphanedProofEvidence>(
  evidence: readonly Evidence[],
  liveCostedOwnedCarIds: ReadonlySet<string>,
): Evidence[] {
  return evidence.filter((proof) => !liveCostedOwnedCarIds.has(proof.vehicleId));
}

export function refuseOrphanedOpeningStockProofs(vins: readonly string[]): never {
  const sorted = [...vins].sort();
  const listed = sorted.slice(0, OPENING_STOCK_PROOF_VIN_LIMIT).join(", ");
  const more = Math.max(0, sorted.length - OPENING_STOCK_PROOF_VIN_LIMIT);
  const values: Record<string, string> = { count: String(sorted.length), vins: listed, more: String(more) };
  const message = OPENING_STOCK_PROOF_ORPHANED_TEMPLATE.replace(/\{(\w+)\}/g, (token, name: string) => values[name] ?? token);
  throw new ConvexError({
    code: AppErrorCode.OPENING_STOCK_PROOF_ORPHANED,
    message,
    count: sorted.length,
    vins: listed,
    more,
  });
}

type AllocatedInventory = { readonly allocatedInventoryMinor: number; readonly allocatedVehicleIds: ReadonlySet<unknown> };
type InventoryControlTotals = { readonly inventoryMinor: number };
type InventoryControlEvidence = {
  readonly evidencedVehicleIds: ReadonlySet<unknown>;
  readonly openingStockEvidence: readonly OrphanedProofEvidence[];
  readonly costedOwnedCars: readonly { readonly _id: string }[];
};
/**
 * The opening inventory control must match the allocated cars exactly. Raised only where the generic totals check below
 * would already have refused: `prepareOpeningInventoryControls` refuses any costed owned car without a proof, so a proof
 * the live costed cars do not cover is the only way `costedOwnedCars.length !== evidencedVehicleIds.size` can hold. Naming it first,
 * after every per-row refusal (a consigned car keeps its own coded error), changes only which refusal is read, never
 * what is accepted.
 */
export function assertOpeningInventoryControl(
  allocated: AllocatedInventory,
  totals: InventoryControlTotals,
  controls: InventoryControlEvidence,
): void {
  const { evidencedVehicleIds, openingStockEvidence, costedOwnedCars } = controls;
  const liveCarIds = new Set(costedOwnedCars.map((car) => String(car._id)));
  const orphaned = orphanedOpeningStockProofs(openingStockEvidence, liveCarIds);
  if (orphaned.length > 0) refuseOrphanedOpeningStockProofs(orphaned.map((proof) => proof.vin));
  if (
    allocated.allocatedInventoryMinor !== totals.inventoryMinor ||
    allocated.allocatedVehicleIds.size !== evidencedVehicleIds.size ||
    costedOwnedCars.length !== evidencedVehicleIds.size
  ) {
    throw new ConvexError("Every imported opening car must match the vehicle inventory control balance exactly.");
  }
}