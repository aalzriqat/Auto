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
      grossTransactionValue: salePrice,
      supplierSettlement: 0,
      dealershipMargin: margin,
      recognizedRevenue: salePrice,
      recognizedCost: capitalizedCost,
    };
  }

  return {
    isAgentSale: true,
    settlementRoute: consignedSettlementRoute(args),
    grossTransactionValue: salePrice,
    supplierSettlement: capitalizedCost,
    dealershipMargin: margin,
    // The whole point. Turnover is what the dealership sold, and on a consigned
    // car that is its service, not the vehicle.
    recognizedRevenue: margin,
    recognizedCost: 0,
  };
}
