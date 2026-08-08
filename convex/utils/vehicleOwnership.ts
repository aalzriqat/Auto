import { grossTransactionValueForSale } from "./grossTransactionValue";

/**
 * Who owns a vehicle, and what the dealership is when it sells one.
 *
 * A vehicle with `sourceType: SOURCED` is legally the supplier's — a confirmed
 * business rule, not an inference. The dealership displays it, sells it on his
 * behalf, and earns the spread over his entitlement.
 *
 * Both facts are DERIVED rather than stored, deliberately. The requirement is
 * that every active SOURCED vehicle has legal owner SUPPLIER and commercial
 * role CONSIGNED_AGENT. Storing them as columns would make that an invariant
 * something has to check and keep true; deriving them makes it an invariant
 * nothing can break — there is no write that can leave a row claiming supplier
 * ownership with principal accounting.
 *
 * What genuinely needs storing is the TRANSITION: a car bought in from the
 * supplier stops being consigned, and when that happened matters. That is a
 * recorded event on the vehicle's history, not a mutable flag beside
 * `sourceType` that can drift out of step with it.
 */

/** The subset of a vehicle these questions actually depend on. */
export interface OwnershipFacts {
  sourceType?: "STOCK" | "SOURCED";
}

export type LegalOwnerType = "DEALERSHIP" | "SUPPLIER";
export type CommercialRole = "DEALER_OWNED_PRINCIPAL" | "CONSIGNED_AGENT";

/**
 * Vehicles predating `sourceType` are dealer-owned by definition — the field
 * was added for drop-ships, so its absence means ordinary stock. Treating them
 * as unknown would strand the entire historical fleet outside both accounting
 * bases.
 */
export function legalOwnerTypeOf(vehicle: OwnershipFacts): LegalOwnerType {
  return vehicle.sourceType === "SOURCED" ? "SUPPLIER" : "DEALERSHIP";
}

export function commercialRoleOf(vehicle: OwnershipFacts): CommercialRole {
  return vehicle.sourceType === "SOURCED" ? "CONSIGNED_AGENT" : "DEALER_OWNED_PRINCIPAL";
}

/**
 * Whether selling this vehicle must post on agent basis: commission on the
 * margin only, no vehicle revenue, no COGS, no inventory relief.
 */
export function isConsignedAgentSale(vehicle: OwnershipFacts): boolean {
  return legalOwnerTypeOf(vehicle) === "SUPPLIER";
}

/**
 * Where the buyer's money went on a consigned sale.
 *
 * Unlike ownership this is NOT derivable — the same consigned vehicle can be
 * sold either way, and only the agreement says which. So it is recorded on the
 * sale, and this is the one place that reads it.
 */
export type ConsignedSettlementRoute = "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";

/** The subset of a sale the route question depends on. */
export interface SettlementRouteFacts {
  supplierSettlementRoute?: ConsignedSettlementRoute;
}

/**
 * Absent means THROUGH_DEALERSHIP, because that is what every consigned sale
 * written before the field existed actually posted — the old code passed the
 * route as a hardcoded literal. Reading absent as anything else would
 * retroactively restate those deals.
 */
export function consignedSettlementRoute(sale: SettlementRouteFacts): ConsignedSettlementRoute {
  return sale.supplierSettlementRoute ?? "THROUGH_DEALERSHIP";
}

/**
 * Whether gross proceeds ran through the dealership's own bank on the
 * supplier's behalf. Decides three things that must agree: whether the
 * dealership owes the supplier (a payable) or the supplier owes the dealership
 * (a receivable), whether the customer owes the dealership for the vehicle at
 * all, and therefore what a customer deposit can legitimately be applied to.
 */
export function dealershipCollectsGross(route: ConsignedSettlementRoute): boolean {
  return route === "THROUGH_DEALERSHIP";
}

/**
 * What one sale is worth, told apart into the four figures a dealership
 * actually needs — because on a consigned sale they are four different numbers
 * that a single "revenue" column silently conflates.
 */
export interface SaleEconomics {
  isAgentSale: boolean;
  settlementRoute: ConsignedSettlementRoute | null;
  /**
   * What the customer transacted for. On an agent sale this is real and worth
   * showing — it is the size of the deal the dealership arranged — but it is
   * NOT the dealership's revenue, because the car was never its to sell.
   */
  grossTransactionValue: number;
  /** The supplier's share of that gross. Zero on dealer-owned stock. */
  supplierSettlement: number;
  /** What the dealership actually earned: its commission, or its gross profit. */
  dealershipMargin: number;
  /** What belongs in turnover. The margin on an agent sale; the price on an owned one. */
  recognizedRevenue: number;
  /** Cost of sales. Zero on an agent sale — there is no cost of a car you never bought. */
  recognizedCost: number;
}

/**
 * Splits a sale into agent-aware economics.
 *
 * `dealershipMargin` is deliberately identical under both bases — price less
 * cost — which is why restating a historical consigned sale changes turnover
 * and cost of sales but not profit. It is also why a corrected historical sale
 * and a newly-posted one report the same numbers: both are derived from the
 * sale and the vehicle, not from whichever basis the ledger happens to carry.
 *
 * `capitalizedCost` must come from `computeVehicleCapitalizedCost`, the single
 * cost basis the GL and commissions also use. For a SOURCED vehicle that IS the
 * supplier's entitlement, so nothing here re-derives it.
 */
/**
 * Gross transaction value comes from the shared definition rather than being
 * spelled `salePrice` again here, so the reports that read this object and the
 * ones that read the cashflow ledger cannot drift apart. See
 * utils/grossTransactionValue.
 */
export function saleEconomics(args: {
  salePrice: number;
  vehicle: OwnershipFacts;
  capitalizedCost: number;
  supplierSettlementRoute?: ConsignedSettlementRoute;
}): SaleEconomics {
  const { salePrice, capitalizedCost } = args;
  const agent = isConsignedAgentSale(args.vehicle);
  const margin = salePrice - capitalizedCost;

  if (!agent) {
    return {
      isAgentSale: false,
      settlementRoute: null,
      grossTransactionValue: grossTransactionValueForSale({ salePrice }),
      supplierSettlement: 0,
      dealershipMargin: margin,
      recognizedRevenue: salePrice,
      recognizedCost: capitalizedCost,
    };
  }

  return {
    isAgentSale: true,
    settlementRoute: consignedSettlementRoute(args),
    grossTransactionValue: grossTransactionValueForSale({ salePrice }),
    supplierSettlement: capitalizedCost,
    dealershipMargin: margin,
    // The whole point. Turnover is what the dealership sold, and on a consigned
    // car that is its service, not the vehicle.
    recognizedRevenue: margin,
    recognizedCost: 0,
  };
}

/**
 * Refuses to change what a vehicle IS after it has been sold, in either
 * direction. Returns the operator-facing message, or null when the change is
 * allowed.
 *
 * Shared because there are two doors into a vehicle patch — `vehicles.update`
 * and the approval workflow's `vehicleEdits.resolve` — and the guard lived on
 * only one of them. A user with `edit:vehicles:request` (the default SALES
 * template) could submit the change as a request and have a manager approve it,
 * flipping the basis of a sold car through the first-class path while the
 * direct mutation refused it.
 *
 * Why both directions are refused:
 *
 *  - SOURCED→STOCK: the sale posted on agent basis — commission on the margin,
 *    no COGS, no inventory — so converting now capitalizes Vehicle Inventory
 *    for a car that has already left the lot. Nothing will ever relieve that
 *    asset, because the sale that would have is in the past.
 *  - STOCK→SOURCED: the sale posted as principal — gross revenue, COGS,
 *    inventory relieved. Declaring the car consigned afterwards says the
 *    dealership never owned what it has already recognised revenue and cost of
 *    sales on, and pulls the sale into the consigned population that
 *    `migrateConsignedSaleBasis` will restate.
 *
 * A genuine historical correction goes through the audited correction path,
 * which posts a correcting journal and leaves a record, rather than editing the
 * basis out from under a posted sale.
 */
export function retroactiveOwnershipChangeRefusal(args: {
  currentSourceType: "STOCK" | "SOURCED" | undefined;
  requestedSourceType: "STOCK" | "SOURCED" | undefined;
  status: string | undefined;
}): string | null {
  if (args.requestedSourceType === undefined) return null;
  if (args.status !== "SOLD") return null;
  // `undefined` predates the field and means owned stock — the same reading
  // `legalOwnerTypeOf` uses, so an old row is not treated as a change.
  const current = args.currentSourceType ?? "STOCK";
  if (args.requestedSourceType === current) return null;

  return current === "SOURCED"
    ? "This vehicle has already been sold on the supplier's behalf, so it cannot be converted to dealership stock now. Convert it before the sale, or correct the sale first."
    : "This vehicle has already been sold as the dealership's own stock, so it cannot be reclassified as a supplier's vehicle now — the completed sale already recognized revenue and cost of sales on it. Correct the sale through the consigned-sale correction instead.";
}
