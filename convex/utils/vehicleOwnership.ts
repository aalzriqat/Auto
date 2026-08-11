import { v } from "convex/values";
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

/**
 * The same two literals as an argument/schema validator.
 *
 * Exported from beside the type rather than declared a third time, because the
 * route now has to agree across three surfaces — the sale that posts it, the
 * finance application that decides it before the sale exists, and the schema
 * that stores both. Two of those already spelled the union out by hand; a third
 * copy is the point at which one of them silently stops matching.
 */
export const consignedSettlementRouteValidator = v.union(
  v.literal("THROUGH_DEALERSHIP"),
  v.literal("DIRECT_TO_SUPPLIER")
);

/** The subset of a sale the route question depends on. */
export interface SettlementRouteFacts {
  supplierSettlementRoute?: ConsignedSettlementRoute;
}

/** How a quote was priced, which is what decides who pays the supplier. */
export type FinanceQuoteMode =
  | "CASH"
  | "CONFIGURED_FINANCE_COMPANY"
  | "MANUAL_FINANCE_COMPANY"
  | "INTERNAL_INSTALLMENT"
  | "LEASE";

/** The subset of a finance application the payer question depends on. */
export interface SettlementPayerFacts {
  /** `quoteModeAtSubmission`, falling back to the quote's current mode. */
  quoteMode?: FinanceQuoteMode;
  /** Only ever set on CONFIGURED_FINANCE_COMPANY deals. */
  financeCompanyId?: string;
  /** `manualFinanceSnapshot.providerName` — the manual financier's identity. */
  manualProviderName?: string;
}

/**
 * Who pays for the car, and whether a settlement advice can name them.
 *
 * `external` decides whether the settlement route is a real question — if
 * nobody outside the dealership pays, the direct route is incoherent and there
 * is nothing to ask. `counterparty` decides whether the DIRECT route can
 * actually be recorded, because an external payment nobody can be named for is
 * unauditable.
 *
 * These are two separate questions and collapsing them is a mistake worth
 * naming. LEASE is external in business terms, so it must not silently default
 * THROUGH_DEALERSHIP — but the model carries no lease-provider identity
 * anywhere, so it cannot take DIRECT either. It gets asked the question and
 * refused the answer, rather than being waved through on one side or hidden on
 * the other.
 */
export type SettlementPayer =
  | { external: false }
  | {
      external: true;
      counterparty:
        | { kind: "FINANCE_COMPANY"; financeCompanyId: string }
        | { kind: "MANUAL_PROVIDER"; name: string };
    }
  | { external: true; counterparty: null; unidentifiedReason: "LEASE" | "PAYER_UNNAMED" };

/**
 * `companyId` was the original proxy for "an external financier exists", and it
 * is wrong in both directions.
 *
 * `convex/quotes.ts` rejects `companyId` on every mode except
 * CONFIGURED_FINANCE_COMPANY, so a MANUAL_FINANCE_COMPANY deal — an ordinary
 * "other finance option", entered by name rather than picked from the
 * configured list — structurally cannot carry one. It was therefore read as
 * having no external financier at all: the finalize route requirement never
 * fired, so the deal defaulted THROUGH_DEALERSHIP and booked a customer
 * receivable plus a supplier payable even when the financier paid the supplier
 * directly, while `setSupplierSettlementRoute` refused the DIRECT route that
 * would have described it correctly. A real external financier treated as none,
 * in both directions at once.
 *
 * The MODE is the fact that decides this, and it is snapshotted onto the
 * application at submission, so it cannot drift when the quote is edited
 * afterwards. The identity is read from the same snapshot for the same reason:
 * a settlement advice records who paid, and that must not be re-derived later
 * from a mutable quote field.
 */
export function settlementPayer(facts: SettlementPayerFacts): SettlementPayer {
  switch (facts.quoteMode) {
    case "CONFIGURED_FINANCE_COMPANY":
      // Validated at quote time, but a row missing it is external-and-unnamed
      // rather than not-external — the same treatment an unnamed manual
      // provider gets, for the same reason.
      return facts.financeCompanyId
        ? {
            external: true,
            counterparty: { kind: "FINANCE_COMPANY", financeCompanyId: facts.financeCompanyId },
          }
        : { external: true, counterparty: null, unidentifiedReason: "PAYER_UNNAMED" };

    case "MANUAL_FINANCE_COMPANY": {
      const name = facts.manualProviderName?.trim();
      return name
        ? { external: true, counterparty: { kind: "MANUAL_PROVIDER", name } }
        : { external: true, counterparty: null, unidentifiedReason: "PAYER_UNNAMED" };
    }

    case "LEASE":
      return { external: true, counterparty: null, unidentifiedReason: "LEASE" };

    // CASH is the customer paying, and INTERNAL_INSTALLMENT is the DEALERSHIP
    // financing the customer — it owes the supplier itself, so no outside party
    // pays him.
    case "CASH":
    case "INTERNAL_INSTALLMENT":
      return { external: false };

    // No mode recorded at all. `mode` is optional on both the quote and the
    // application and `saveQuote` explicitly permits a `companyId` without one,
    // so this is a real legacy shape rather than a corrupt row — and when it
    // carries a configured finance company, that company IS the answer the mode
    // cannot give.
    //
    // Falling through to `external: false` here regressed exactly the
    // population the mode fallback exists to protect: before the resolver, a
    // populated `companyId` was what made `finalizeDeal` demand a route, so a
    // legacy consigned deal would have stopped being asked and defaulted
    // THROUGH_DEALERSHIP while the direct route it may genuinely need was
    // refused.
    default:
      return facts.financeCompanyId
        ? {
            external: true,
            counterparty: { kind: "FINANCE_COMPANY", financeCompanyId: facts.financeCompanyId },
          }
        : { external: false };
  }
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
  /**
   * The supplier's share of that gross. Zero on dealer-owned stock.
   *
   * `null` means UNKNOWN, under exactly the same rule as `dealershipMargin`
   * below and for the same reason. These two are one pair: publishing a frozen
   * margin beside a live entitlement describes a deal no ledger recognizes,
   * and `sourceCost` stays editable, so the live figure can drift arbitrarily
   * far from what the sale was posted on. Callers must withhold it, never read
   * it as zero and never substitute the vehicle's current cost.
   */
  supplierSettlement: number | null;
  /**
   * What the dealership actually earned: its commission, or its gross profit.
   *
   * `null` means UNKNOWN — the row is a financed sale settled directly with the
   * supplier whose recorded margin is missing, so what it earned cannot be
   * derived from the sale price. Callers must withhold it, never read it as
   * zero and never substitute `salePrice − cost`.
   */
  dealershipMargin: number | null;
  /**
   * What belongs in turnover. The margin on an agent sale; the price on an
   * owned one — so it is `null` exactly when the margin is.
   */
  recognizedRevenue: number | null;
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
  /**
   * The vehicle, or `null` when its row could not be read at all.
   *
   * The distinction matters and an empty object cannot carry it. `sourceType`
   * is optional, so a legacy dealer-owned vehicle and a vanished one both look
   * like "no sourceType" — and callers were passing `{}` for the vanished case.
   * `isConsignedAgentSale({})` is false, so a hard-deleted vehicle (reachable
   * through the `/admin` raw editor) silently reclassified a consigned sale as
   * the dealership's own: the frozen margin was discarded even though the sale
   * still carried it, and the whole ticket was published as revenue against a
   * cost basis that vanished with the vehicle.
   *
   * `null` means "ask the sale instead". The vehicle stays authoritative
   * whenever it is present.
   */
  vehicle: OwnershipFacts | null;
  capitalizedCost: number;
  supplierSettlementRoute?: ConsignedSettlementRoute;
  /**
   * The margin the SALE recorded at completion, when it has one. Reports read
   * this rather than re-deriving, so the operational figures cannot disagree
   * with the ledger about what a deal earned.
   *
   * On a financed DIRECT deal `salePrice − capitalizedCost` is not the
   * dealership's earning: the finance company pays the supplier what it
   * approved, and `salePrice − approved` reaches nobody. The GL, the supplier
   * subledger and the P&L all recognize `approved − entitlement`, and without
   * this the sales report published the larger figure beside them — two
   * owner-facing profit numbers for one deal.
   *
   * Absent means the sale predates the field, was never a consigned direct
   * one, or had the value cleared. For every shape where `salePrice − cost` is
   * genuinely what the row was posted on — owned stock, THROUGH_DEALERSHIP,
   * cash direct — that fallback is correct and old rows keep reconciling. For a
   * financed direct row it is not: see `externallyFinanced`.
   */
  recordedMargin?: number;
  /**
   * What the supplier was owed, frozen at completion, when the sale recorded it.
   *
   * `capitalizedCost` is the live vehicle's basis and it moves: a consigned car
   * is never capitalized into inventory, so `sourceCost` remains editable after
   * the sale. Reporting the supplier's settlement from it put the frozen margin
   * and a live entitlement side by side in one row, disagreeing with the GL and
   * the subledger that raised the claim.
   */
  recordedSupplierEntitlement?: number;
  /**
   * Whether a third party financed this sale (FINANCED or LEASE).
   *
   * It is what separates the two readings of an absent `recordedMargin`. On a
   * cash direct sale the buyer really hands the supplier the sale price, so the
   * spread over his entitlement is the earning. On a financed one the finance
   * company pays him only what it approved, and `salePrice − approved` reaches
   * no party at all — so without the recorded margin the earning is genuinely
   * UNKNOWN, and this returns `null` rather than confidently publishing the
   * larger figure beside a P&L that says otherwise.
   */
  externallyFinanced?: boolean;
}): SaleEconomics {
  const { salePrice, capitalizedCost } = args;
  const settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(args));
  // The vehicle answers whenever it is present, so every surface that holds one
  // reaches the same conclusion this function has always reached. Only when the
  // row is genuinely gone does the sale's own evidence stand in: a recorded
  // consigned margin, or a direct settlement route — which `setSupplierSettlementRoute`
  // refuses on dealer-owned stock, making it a positive consignment signal.
  const vehicle = args.vehicle;
  const vehicleUnknown = vehicle === null;
  // Validated BEFORE classification, because it is itself one of the signals.
  // Not agent-gated here for the same reason: asking "is this consigned" using
  // an answer that already assumed it would be circular.
  // Bounded on BOTH sides. An entitlement above the gross subtracts to a
  // negative margin; a negative one subtracts to a margin LARGER than the whole
  // car and publishes the supplier's own share as a negative number. Same
  // corruption class, opposite directions, so one rule refuses both. `NaN`
  // needs no separate case: every comparison against it is false, so it can
  // satisfy neither bound.
  const validFrozenEntitlement =
    args.recordedSupplierEntitlement !== undefined &&
    args.recordedSupplierEntitlement >= 0 &&
    args.recordedSupplierEntitlement <= salePrice
      ? args.recordedSupplierEntitlement
      : undefined;
  const agent =
    vehicle === null
      ? args.recordedMargin !== undefined ||
        settlesDirect ||
        // A supplier entitlement exists ONLY on a consigned sale, so its
        // presence is as strong a consignment signal as the recorded margin.
        // Without it, a hard-deleted consigned vehicle was classified as
        // dealer-owned and — since `capitalizedCost` arrives as 0 for a missing
        // vehicle — reported the ENTIRE ticket as profit on a car the
        // dealership never owned.
        validFrozenEntitlement !== undefined
      : isConsignedAgentSale(vehicle);
  // AGENT ONLY. A supplier basis must never derive a dealer-owned row's profit:
  // that row keeps its own cost, and mixing the two makes `revenue − cost`
  // disagree with `margin` on the same sale.
  const eligibleSupplierEntitlement = agent ? validFrozenEntitlement : undefined;
  // With no vehicle there is no cost basis either — `capitalizedCost` arrives as
  // 0 — so `salePrice − cost` would report the entire ticket as the dealership's
  // margin. An agent sale whose earning cannot be read from the sale is UNKNOWN,
  // not the whole ticket.
  //
  // ...unless the frozen entitlement survived, which IS a basis. The missing
  // vehicle is then no longer the reason to withhold, so it stops being one.
  // The financed-direct arm is untouched: there the earning is
  // `supplierGrossReceipt − entitlement`, never `salePrice − entitlement`, so a
  // surviving entitlement must not become a back door to the sale-price spread
  // this whole change exists to stop reporting.
  const evidenceRequired =
    agent &&
    ((settlesDirect && args.externallyFinanced === true) ||
      (vehicleUnknown && eligibleSupplierEntitlement === undefined));
  // When the margin is missing, rebuild it from the SURVIVING FROZEN basis
  // before reaching for the live one.
  //
  // This arrived by elimination, and both reviewers landed on it independently.
  // The first proposal was to fail the missing half closed whenever its sibling
  // was present. That was implemented and REJECTED: it broke "a negative
  // recorded margin is not read as a loss" and "NaN does not poison the profit
  // of every other sale", whose rows complete through the real writer and are
  // then corrupted on the margin alone. Nulling withholds a number that is
  // still perfectly derivable, which is not the safe direction.
  //
  // But the live fallback was not right either. `sourceCost` stays editable
  // after the sale — the acquisition lock only fires on a posted VEHICLE_ACQUIRED
  // event, which a consigned car never emits — so re-deriving from it reports a
  // margin against a basis the sale never used, beside a settlement still
  // frozen at the old one. The row then fails to reconcile: margin + settlement
  // no longer equals the gross.
  //
  // Preferring the frozen entitlement keeps BOTH halves on ONE basis, which is
  // the invariant this whole change exists to enforce, and withholds nothing.
  // The live cost remains the answer for a genuine legacy row that carries
  // neither frozen field — for those it IS what the sale was posted on.
  //
  // Two guards on which basis is eligible, both learned the hard way:
  //
  // • AGENT ONLY. This expression runs before the non-agent branch returns, so
  //   without the check a dealer-owned row carrying a stale entitlement would
  //   take its profit from the supplier's basis while still reporting the full
  //   sale price as revenue and the vehicle's own cost as cost — `revenue −
  //   cost` would disagree with `margin` on the same row.
  // • NOT ABOVE THE GROSS. An entitlement larger than the sale price subtracts
  //   to a negative, which is a second route to the answer that "a negative
  //   recorded margin is not read as a loss" already refuses. Corruption is not
  //   a loss, whichever field it arrives in.
  //
  // ONE predicate, used by BOTH halves below. Guarding only the margin left the
  // settlement reading the corrupt value, so a row could report a margin from
  // the clean basis and a settlement from the dirty one and sum to more than
  // the whole car — the exact inverse of the identity this rule exists to keep.
  // If an entitlement is not fit to derive the margin, it is not fit to be
  // published as the supplier's share either.

  const margin =
    agent && args.recordedMargin !== undefined
      ? args.recordedMargin
      : evidenceRequired
        ? null
        : salePrice - (eligibleSupplierEntitlement ?? capitalizedCost);

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
    // What the sale recorded, when it recorded it. Falls back to the live basis
    // only for rows written before the field existed — for those, the live cost
    // IS what the sale was posted on.
    //
    // But it takes the SAME `evidenceRequired` arm as the margin. Without it, a
    // financed-direct row carrying a frozen margin and no frozen entitlement
    // published the frozen figure beside a live one, and a later `sourceCost`
    // edit moved the supplier's reported share while the claim and the GL
    // stayed put. The two figures describe one deal; deriving them under
    // different rules about missing evidence is what makes the report disagree
    // with the ledger.
    supplierSettlement:
      eligibleSupplierEntitlement ?? (evidenceRequired ? null : capitalizedCost),
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

/**
 * Why an approved purchase amount cannot be settled directly to this supplier,
 * or `null` when it can.
 *
 * On the direct route the finance company's approved amount IS what reaches the
 * supplier, so approving below his entitlement pays him less than he is owed.
 * `approveDealerPurchaseAmount` guarded only `<= 0`, and the completion-time
 * guard it relied on compared the SALE PRICE with the entitlement — a different
 * quantity, and one that stays comfortably above it on exactly the deals where
 * the approval falls below. So a sale at 20,000 with an entitlement of 15,000
 * and an approval of 14,000 passed every check and left the supplier 1,000 short.
 *
 * It refuses rather than clamping the resulting claim to zero. A shortfall means
 * somebody has to fund the difference; treating it as "the dealership simply has
 * no claim" silently elects the supplier to absorb it, and AutoFlow does not
 * model who tops it up. Returned as a message rather than thrown so each caller
 * can raise it as its own error type — a `ConvexError`, so the operator is told
 * which number to fix instead of meeting a redacted "unexpected error".
 *
 * Both amounts are integer minor units in the same currency. A caller that
 * cannot establish the entitlement must not call this and read `null` as
 * permission — absent evidence is not proof of sufficiency.
 */
export function directSettlementBelowEntitlementRefusal(args: {
  approvedAmountMinor: number;
  supplierEntitlementMinor: number;
  supplierName?: string;
}): string | null {
  if (args.approvedAmountMinor >= args.supplierEntitlementMinor) return null;
  const shortfall = args.supplierEntitlementMinor - args.approvedAmountMinor;
  const supplier = args.supplierName ?? "the supplier";
  return `On this deal the finance company pays ${supplier} directly, so the approved amount is what he actually receives — and ${args.approvedAmountMinor} minor units is ${shortfall} below the ${args.supplierEntitlementMinor} he is owed for the car. Somebody has to cover that difference, and who does is not something the deal can decide for itself. Agree a lower supplier amount, record the shortfall against the supplier agreement, or settle this deal through the dealership instead.`;
}
