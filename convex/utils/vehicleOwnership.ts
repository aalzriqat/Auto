import { v } from "convex/values";
import { Doc } from "../_generated/dataModel";
import { grossTransactionValueForSale } from "./grossTransactionValue";
// `denominationOf`, NOT `fromMinorUnits`/`scaleForCurrency`: the latter guess a
// scale of 2 for any unrecognised code, and this module reads MONEY. See
// `recordedConsignedAmount`.
import { denominationOf } from "./money";

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
   * `null` means UNKNOWN. Callers must withhold it, never read it as zero and
   * never substitute `salePrice − cost`.
   *
   * ⚠️ SCRUM-40 O-4. This block used to name ONE cause, and an incomplete
   * enumeration in a codebase that uses these blocks as the durable record of
   * rejected alternatives misleads the next reader into "simplifying" a branch
   * it never mentioned. The complete list, each with the rule that produces it:
   *
   *  1. A financed sale settled DIRECT with the supplier whose recorded margin
   *     is MISSING — `evidenceRequired`. `salePrice − entitlement` reaches no
   *     party on that route.
   *  2. The same route with a recorded margin that nothing SUBSTANTIATES —
   *     no frozen supplier receipt, OR no financing application behind it
   *     (`financedDirectUnverified`, SCRUM-41). EITHER absence is enough to
   *     withhold, because both facts are required: the receipt is the amount,
   *     the application is its provenance. The frozen figure exists, but nothing
   *     on the row says which externally funded basis produced it.
   *  3. An agent sale whose vehicle row is gone and which froze no entitlement
   *     of its own — `evidenceRequired`'s second arm. There is no cost basis
   *     left anywhere.
   *  4. Any sale with no frozen basis whose live basis is not a basis:
   *     the vehicle row is unreadable, or it is an agent sale whose capitalized
   *     cost is zero (`basisUnknown`, SCRUM-33 / O-2). This one can be reached
   *     by a sale that does NOT classify as an agent sale — the classification
   *     itself is what could not be established.
   *  5. An AGENT sale whose derived margin comes out NEGATIVE
   *     (`derivedMarginIsCorrupt`). `saleCompletion` refuses a sourced sale
   *     below the supplier's entitlement, so a negative agent spread cannot be
   *     what the sale was posted on — it means the live `sourceCost`, which
   *     stays editable after a consigned sale, has drifted above the sale price.
   *     Corruption is not a loss. Dealer-owned is NOT included: a dealership
   *     really can sell its own stock below cost.
   *
   * ⚠️ This enumeration was already stale ONCE, which is what SCRUM-40 O-4 was.
   * Cause 5 was then added by a later round of the very same change and missed
   * again, caught by the adversarial reviewer. If you add a way for this to
   * return `null`, add it here in the same commit.
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
/**
 * The margin the SALE froze at completion, in major units, or `undefined`.
 *
 * Moved here from `reports.ts` for SCRUM-29, unchanged. The deal screen reads
 * the same frozen figure the sales report reads, so an owner cannot open one
 * deal and see a different profit from the one the report totalled — which is
 * the entire reason `saleEconomics` takes a recorded margin at all.
 *
 * Every guard is deliberate. `sales` is editable through the super-admin
 * raw-JSON editor, so a corrupt value arrives at the READER, not at the write
 * path — `saleCompletion` already refuses a sourced sale below the supplier's
 * entitlement. `NaN` is the one that does real damage: Convex accepts it under a
 * `v.number()` validator, it is not `null` so it escapes every unknown-margin
 * count, and one `total += NaN` renders an entire org's profit as `NaN`.
 *
 * Returning `undefined` hands the decision back to `saleEconomics`, which is
 * where "what does an absent margin mean on THIS route" already lives.
 */
export function recordedConsignedMargin(sale: Doc<"sales">): number | undefined {
  return recordedConsignedAmount(sale.consignedMarginMinor, sale.consignedMarginCurrency);
}

/**
 * One reader for all three frozen consigned amounts, because they are one basis.
 *
 * ⚠️ CX-D. Each of the three used to call `fromMinorUnits(minor, currency)`, and
 * `fromMinorUnits` delegates to `scaleForCurrency`, which returns **2 for
 * anything it does not recognise**. A JOD row stores minor units at scale 3, so
 * a stored `"JD"` — the SYMBOL this app puts in `orgSettings.currencySymbol`,
 * one keystroke from the ISO code — read 18,000,000 fils as 180,000 instead of
 * 18,000. Tenfold, silent, and on the receipt it also raised the entitlement
 * ceiling, so the inflated figure was published rather than withheld.
 *
 * `denominationOf` is the repository's fail-closed answer to exactly this, and
 * it is the same authority the WRITERS assert with `assertSupportedDenomination`
 * — so a reader can no longer publish money in a denomination a mutation would
 * have refused. It rejects the unsupported (`"XYZ"`), the non-canonical
 * (`"jod"`, which the writers refuse) and the present-but-meaningless (`""`,
 * which `??` never replaces and a truthiness check waves through).
 *
 * SHARED deliberately, not applied to the new reader alone. The three amounts
 * are compared against each other — margin, entitlement and receipt come off one
 * `consignedMarginCurrency` — so vouching one while the others still guess would
 * produce a MIXED basis inside a single computation, which is worse than either
 * answer on its own.
 *
 * This is the same defect class as the #227 opening-balance CRITICAL, reached
 * independently in the same week. Two lanes reaching for the guessing helper is
 * a missing constraint, not two mistakes.
 */
function recordedConsignedAmount(
  minor: number | undefined,
  currency: string | undefined
): number | undefined {
  if (minor === undefined) return undefined;
  const denomination = denominationOf(currency);
  if (denomination === null) return undefined;
  if (!Number.isFinite(minor) || minor < 0) return undefined;
  return minor / Math.pow(10, denomination.scale);
}

/**
 * What the supplier was owed on this sale, frozen at completion, in major units.
 *
 * Same guards and the same currency as the margin beside it, and for the same
 * reason: `sourceCost` stays editable after a consigned sale, so deriving the
 * supplier's entitlement from the live vehicle reports a settlement figure the
 * GL, the subledger and the claim never used. A sale frozen at a 3,000 margin
 * against a 15,000 entitlement would show 3,000 beside a live 16,000 — two
 * halves of one deal on two different bases.
 */
export function recordedSupplierEntitlement(sale: Doc<"sales">): number | undefined {
  return recordedConsignedAmount(
    sale.consignedSupplierEntitlementMinor,
    sale.consignedMarginCurrency
  );
}

/**
 * What a third party actually paid the supplier, frozen at completion, in major
 * units — `consignedSupplierGrossReceiptMinor`.
 *
 * Same guards and the same currency as the two fields above, because the one
 * writer patches all three together. On a cash direct sale this is the sale
 * price; on a financed direct one it is the finance company's approved purchase
 * amount, which is frequently NOT the sale price.
 *
 * Absent on THROUGH_DEALERSHIP by design — nobody pays him directly there — so
 * absence alone is not a defect. It is only evidence of anything on the DIRECT
 * route, where the writer always records it.
 */
export function recordedSupplierGrossReceipt(sale: Doc<"sales">): number | undefined {
  return recordedConsignedAmount(
    sale.consignedSupplierGrossReceiptMinor,
    sale.consignedMarginCurrency
  );
}

/**
 * The most the supplier can legitimately have been entitled to on this sale.
 *
 * ⚠️ SCRUM-40 O-1. This was the SALE PRICE, and that is the wrong yardstick on a
 * financed DIRECT deal: `approveDealerPurchaseAmount` bounds the approval only
 * by `> 0` and `>= entitlement`, and `MANUAL` basis accepts any figure, so an
 * approval above the sale price is writer-producible. `completeSale` then
 * compares the entitlement against the supplier's GROSS RECEIPT, never against
 * the sale price — so the reader was applying a stricter bound than the writer
 * and rejecting values the writer had legitimately stored. Reproduced by Opus:
 * `route=DIRECT, financed, entitlement=13500, salePrice=12500` withheld a
 * settlement of 13,500 that was correct.
 *
 * The receipt is the right ceiling because it IS the money that reached him: a
 * supplier cannot be owed more than the whole of what he was paid. The sale
 * price remains the ceiling wherever no receipt was recorded — every
 * THROUGH_DEALERSHIP row, where the receipt is deliberately not written and the
 * gross the dealership collected is the sale price.
 *
 * ⚠️ CX-B / CX-B2. The paragraph above states the invariant — the receipt is
 * "deliberately not written" — and the code did not ENFORCE it. It then took two
 * rounds to get the enforcement right, which is why the rule now lives in ONE
 * derivation instead of being re-decided here: round 3 checked the ROUTE and
 * still admitted a cash-direct receipt, because the route alone was never the
 * discriminator. See `supplierReceiptIsAdmissible`.
 *
 * Unenforced, a stale 50,000 receipt on a car that sold for 20,000 made a 40,000
 * entitlement eligible and published a supplier share exceeding the ENTIRE gross
 * the dealership collected.
 *
 * Takes the settlement FACTS rather than a pre-computed boolean, deliberately: a
 * caller that can pass the answer can pass the wrong answer, and this function
 * has now been given the wrong answer once already.
 */
function entitlementCeiling(
  args: {
    salePrice: number;
    recordedSupplierGrossReceipt?: number;
  } & ReceiptAdmissibilityFacts
): number {
  if (!supplierReceiptIsAdmissible(args)) return args.salePrice;
  return verifiedSupplierReceiptFor(args.recordedSupplierGrossReceipt) ?? args.salePrice;
}

/** The facts that decide whether a frozen supplier receipt is evidence at all. */
export interface ReceiptAdmissibilityFacts extends SettlementRouteFacts {
  /** FINANCED or LEASE — a third party paid the supplier something. */
  externallyFinanced?: boolean;
}

/**
 * Whether a frozen supplier receipt may raise the entitlement ceiling above the
 * sale price. THE one derivation; every consumer asks this and none re-decides.
 *
 * ⚠️ CX-B2. Derived from the WRITER paths, not from another reader's predicate:
 *
 *  • `applications.ts` supplies `supplierGrossReceiptMinor` from
 *    `approvedDealerPurchaseAmountMinor`, and only on DIRECT — that path is the
 *    finance-application finalization, so it is externally financed BY
 *    CONSTRUCTION.
 *  • `saleCompletion.ts` otherwise stores `salePriceMinor`.
 *  • NO public mutation accepts `supplierGrossReceiptMinor`.
 *
 * So on THROUGH_DEALERSHIP, and on cash DIRECT, the stored receipt is always
 * EXACTLY the sale price. A larger one on those shapes is not something the
 * product can produce — it is corruption, and it may not raise a ceiling.
 *
 * Only financed DIRECT can legitimately exceed the sale price, because
 * `approveDealerPurchaseAmount` bounds the approval by `> 0` and
 * `>= entitlement` and not by the sale price. That is O-1, and it survives.
 *
 * `=== true` and not truthiness: `externallyFinanced` absent is a DIFFERENT
 * input from `false`, it is what a legacy row carries, and it must fail closed
 * rather than be read as financed by permissiveness.
 */
export function supplierReceiptIsAdmissible(facts: ReceiptAdmissibilityFacts): boolean {
  return (
    !dealershipCollectsGross(consignedSettlementRoute(facts)) &&
    facts.externallyFinanced === true
  );
}

/**
 * The frozen receipt if it is worth believing at all.
 *
 * ONE predicate, because two questions depend on it and they must not disagree:
 * how high the supplier's entitlement may legitimately go (`entitlementCeiling`)
 * and whether a financed DIRECT row's frozen margin is substantiated
 * (`financedDirectUnverified`). Same NaN/negative discipline as every other
 * frozen field — a corrupt receipt substantiates nothing and raises no ceiling.
 */
function verifiedSupplierReceiptFor(
  recordedSupplierGrossReceipt: number | undefined
): number | undefined {
  return recordedSupplierGrossReceipt !== undefined &&
    Number.isFinite(recordedSupplierGrossReceipt) &&
    recordedSupplierGrossReceipt >= 0
    ? recordedSupplierGrossReceipt
    : undefined;
}

/**
 * The supplier's frozen entitlement, if the row carries one worth believing.
 *
 * Bounded on BOTH sides. An entitlement above the gross subtracts to a negative
 * margin; a negative one subtracts to a margin LARGER than the whole car and
 * publishes the supplier's own share as a negative number. Same corruption
 * class, opposite directions, so one rule refuses both. `NaN` needs no separate
 * case: every comparison against it is false, so it can satisfy neither bound.
 */
function validFrozenEntitlementFor(
  recordedSupplierEntitlement: number | undefined,
  ceiling: number
): number | undefined {
  return recordedSupplierEntitlement !== undefined &&
    recordedSupplierEntitlement >= 0 &&
    recordedSupplierEntitlement <= ceiling
    ? recordedSupplierEntitlement
    : undefined;
}

/**
 * Whether this sale is an AGENT (consigned) sale — the one classification.
 *
 * ⚠️ Extracted for SCRUM-29 because a second surface needed the answer and got
 * it wrong. `sales.dealCockpit` asked `vehicle ? isConsignedAgentSale(vehicle) :
 * false`, which is the narrow rule; this one is what `saleEconomics` has always
 * used. They disagree precisely when the vehicle row is GONE — reachable through
 * the `/admin` raw-JSON editor — and the sale's own frozen evidence survives.
 *
 * The consequence was not cosmetic: the cockpit's headline reported a real
 * agency margin (because `saleEconomics` classified it correctly) while the
 * stage rail reported the deal fully settled and the supplier row disappeared,
 * because the narrow rule skipped the supplier-obligation lookup entirely. The
 * screen hid an open claim for money the supplier still owed.
 *
 * The vehicle answers whenever it is present. Only when the row is genuinely
 * gone does the sale's own evidence stand in: a recorded consigned margin, a
 * direct settlement route — which `setSupplierSettlementRoute` refuses on
 * dealer-owned stock, making it a positive consignment signal — or a surviving
 * frozen entitlement, which exists ONLY on a consigned sale.
 */
export function saleIsAgentSale(args: {
  vehicle: OwnershipFacts | null;
  salePrice: number;
  recordedMargin?: number;
  recordedSupplierEntitlement?: number;
  /**
   * `consignedSupplierGrossReceiptMinor` in major units. Only ever written on a
   * consigned DIRECT sale, so it raises the entitlement's eligibility ceiling
   * under the same rule `saleEconomics` applies — the classifier and the
   * economics must not disagree about which entitlements are believable.
   */
  recordedSupplierGrossReceipt?: number;
} & ReceiptAdmissibilityFacts): boolean {
  if (args.vehicle !== null) return isConsignedAgentSale(args.vehicle);
  // Derived HERE from the route rather than accepted as a boolean. Three call
  // sites used to re-derive this with an identical but unshared formula, which
  // was consistent only by review — nothing made it stay that way.
  const settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(args));
  return (
    args.recordedMargin !== undefined ||
    // DIRECT_TO_SUPPLIER is itself a positive consignment signal, whatever paid
    // for it: `setSupplierSettlementRoute` refuses dealer-owned stock.
    settlesDirect ||
    validFrozenEntitlementFor(
      args.recordedSupplierEntitlement,
      entitlementCeiling(args)
    ) !== undefined
  );
}

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
   * What a third party actually paid the supplier, frozen at completion.
   *
   * ⚠️ SCRUM-41. This is the evidence that decides whether a frozen margin on a
   * financed DIRECT row may be believed at all, and it is not a date heuristic.
   * `utils/saleCompletion.ts` is the only writer of the frozen consigned fields
   * and it patches this one in the SAME statement as the margin on every direct
   * sale, having DERIVED the margin from it (`supplierGrossReceipt − cost`). So
   * a direct row carrying a margin and no receipt was not written by the writer
   * that derives the margin from it. What that establishes is EVIDENTIARY, not
   * chronological: nothing durable on the row substantiates which externally
   * funded basis produced that margin. Whether the frozen figure is historically
   * wrong is not knowable from the row, and the rule never needed it to be.
   *
   * Absent on THROUGH_DEALERSHIP by design. See `entitlementCeiling`, which uses
   * it for the other half of the same question.
   */
  recordedSupplierGrossReceipt?: number;
  /**
   * Whether the sale carries an `applicationId` — the finance application that
   * approved what the financier would pay.
   *
   * ⚠️ Raised by the Codex reviewer. A frozen receipt proves its own PRESENCE,
   * not its PROVENANCE: `saleCompletion`'s direct-route fallback is
   * `args.supplierGrossReceiptMinor ?? salePriceMinor`, so a receipt equal to the
   * sale price is indistinguishable from a real approval that happened to match
   * it. The reviewer's stated route to such a row was disproved — the receipt
   * field and the guard that forces a real approved amount reached main in the
   * SAME merge (51c62fc2 / PR #218), so no deployed state ever had one without
   * the other — but two things make the hardening right anyway.
   *
   * First, `/admin`'s raw-JSON editor can fabricate exactly that row, and this
   * file already treats that editor as the reason readers validate at all.
   * Second, and decisively: the CASH deal cockpit ALREADY refuses every
   * no-application financed-direct row (`financedDirectWithoutApproval` in
   * convex/sales.ts). `saleEconomics` being more permissive than a screen that
   * already ships is two authorities disagreeing about one sale — the exact
   * defect this lane exists to remove.
   *
   * It withholds nothing legitimate. A financed DIRECT sale is only
   * constructible through `finalizeDeal`, which records the application on the
   * sale; and a row predating that workflow carries no receipt either, so it was
   * already withheld.
   */
  hasFinancingApplication?: boolean;
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
  const validFrozenEntitlement = validFrozenEntitlementFor(
    args.recordedSupplierEntitlement,
    // The raw facts go in; `entitlementCeiling` asks the one admissibility
    // derivation itself, so this call site cannot answer the question wrongly.
    entitlementCeiling(args)
  );
  // Through the shared classifier, which is the same rule this function has
  // always applied — including the case where a supplier entitlement survives a
  // hard-deleted vehicle. Without that signal such a sale was classified as
  // dealer-owned and, since `capitalizedCost` arrives as 0 for a missing
  // vehicle, reported the ENTIRE ticket as profit on a car the dealership never
  // owned. SCRUM-29 exported it so the deal screen cannot reach a different
  // verdict than the economics do.
  const agent = saleIsAgentSale({
    vehicle,
    salePrice,
    recordedMargin: args.recordedMargin,
    recordedSupplierEntitlement: args.recordedSupplierEntitlement,
    recordedSupplierGrossReceipt: args.recordedSupplierGrossReceipt,
    supplierSettlementRoute: args.supplierSettlementRoute,
    externallyFinanced: args.externallyFinanced,
  });
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
  const financedDirect = agent && settlesDirect && args.externallyFinanced === true;
  const evidenceRequired =
    financedDirect || (agent && vehicleUnknown && eligibleSupplierEntitlement === undefined);
  /**
   * ⚠️ SCRUM-41 — the frozen margin is not self-certifying on this one route.
   *
   * `evidenceRequired` used to be consulted ONLY when `recordedMargin` was
   * undefined, so a row that already carried a frozen `consignedMarginMinor`
   * returned it unconditionally — including on the financed DIRECT route, where
   * the earning is `approved − entitlement` and the sale-price spread reaches no
   * party at all. `sales.create` accepts `financingType` and
   * `supplierSettlementRoute` together with no application, and the write-path
   * guard (`FINANCED_DIRECT_NEEDS_APPROVED_AMOUNT`) only landed on 2026-08-11, so
   * a row completed before it COULD carry a margin frozen at the wrong basis. On a
   * 20,000 sale with a 15,000 entitlement where the financier paid the 18,000 it
   * approved, the real earning is 3,000 and `saleEconomics` published 5,000 into
   * `reports.salesReport`'s `totalProfit`.
   *
   * That history is why the shape is reachable. It is NOT the justification, and
   * the rule must not be read as one. The discriminator is the row's own evidence,
   * never a completion date: the one writer records the receipt in the same patch
   * as the margin on every direct sale and derives the margin from it, so
   * margin-without-receipt on a DIRECT row was not produced by that writer — and
   * no other durable fact on the sale says which externally funded basis the
   * margin came from. Withhold what nothing substantiates; that is the whole rule.
   *
   * ⚠️ Raised by the ChatGPT reviewer, and the correction matters. The two fields
   * did NOT enter the codebase together — the margin arrives in the earlier
   * `c2582b9` work, the receipt and its readers later in the SCRUM-30 sequence
   * (`0746817` / `f750ee22`). So "margin present, receipt absent" cannot prove the
   * row belongs to one pre-guard population, and this block no longer claims it
   * does. Chronology is a weaker authority than the row's evidence, and the
   * evidence alone already carries the refusal.
   *
   * The identical rule already governs PAYROLL money: `commissionableEarnings`
   * refuses a financed direct sale whose receipt is unrecorded rather than
   * substituting the sale price. This is that rule reaching the owner-facing
   * report figures it had never been applied to.
   */
  // BOTH halves are required: the receipt is the amount, and the application is
  // the provenance that makes the amount an approval rather than a fallback.
  // See `hasFinancingApplication` for why presence alone is not enough.
  const financedDirectUnverified =
    financedDirect &&
    (verifiedSupplierReceiptFor(args.recordedSupplierGrossReceipt) === undefined ||
      args.hasFinancingApplication !== true);
  /**
   * ⚠️ SCRUM-33 / SCRUM-40 O-2 — no basis on the row, and none to be had.
   *
   * `salePrice − capitalizedCost` is only an earning while `capitalizedCost` is
   * a real basis. Two shapes where it is not:
   *
   * • The VEHICLE ROW IS GONE (`/admin`'s raw editor, or a partially-failed
   *   `hardDeleteOrg`), so the cost arrives as 0. The agent branch already
   *   withheld for this; a sale that carries none of the three consignment
   *   signals did not, and was read as dealer-owned stock with a zero cost — the
   *   ENTIRE ticket published as revenue AND as profit, with no unknown flag on
   *   it. That is the legacy consigned THROUGH population, whose route field and
   *   frozen margin both post-date it. The classification is what cannot be
   *   established, so it is not repaired by guessing which way it falls: the same
   *   arithmetic misstates a genuinely dealer-owned row just as badly.
   *
   * • The sale is an AGENT sale whose live cost is ZERO. A consigned car the
   *   supplier is owed nothing for is not a real consignment — `saleCompletion`
   *   refuses to complete a sourced sale without a positive cost — so zero here
   *   is missing evidence, never the fact that the car was free. Reached when a
   *   frozen entitlement is present but INELIGIBLE and `sourceCost` has also been
   *   cleared: Opus reproduced `cost=0, entitlement=13500, margin=undefined` →
   *   `margin=12500, settle=0`.
   *
   * Deliberately NARROW on both sides. A dealer-owned row keeps the live cost
   * whatever it is, and an agent row with a POSITIVE live cost keeps it too —
   * that is what a genuine legacy consigned sale was posted on, and withholding a
   * derivable number is a different wrong answer, not a safer one.
   */
  const basisUnknown =
    args.recordedMargin === undefined &&
    eligibleSupplierEntitlement === undefined &&
    (vehicleUnknown || (agent && !(capitalizedCost > 0)));
  /**
   * ⚠️ The SUPPLIER's basis, asked independently of the dealership's.
   *
   * Raised by the Codex reviewer and reproduced: `basisUnknown` requires the
   * margin to be absent, so an agent row that HAS a frozen margin skipped it
   * entirely — and the settlement beside it then fell through to a live cost of
   * zero and published "the supplier is owed nothing for his own car", with no
   * unknown-settlement count to say otherwise.
   *
   * The two figures answer different questions from different evidence, and
   * their uncertainty is not shared: a surviving margin says nothing about
   * whether the supplier's basis survived. `consignedSupplierEntitlementMinor`
   * post-dates `consignedMarginMinor`, so a row carrying one and not the other
   * is an ordinary legacy shape rather than a corrupt one.
   *
   * This does NOT contradict the "ONE predicate governs BOTH halves" rule an
   * earlier round established. That rule is about which ENTITLEMENT is eligible
   * — an entitlement unfit to derive the margin is still unfit to be published —
   * and it is untouched. This is about which figure may be WITHHELD, where the
   * two are independent.
   */
  const supplierBasisUnknown =
    agent && eligibleSupplierEntitlement === undefined && !(capitalizedCost > 0);
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

  // The two withholding rules above are checked BEFORE the recorded margin,
  // because each names a case where the recorded margin — or its absence — is
  // exactly what cannot be relied on. Everything after them is unchanged.
  /**
   * The margin this row would carry if it has to be derived rather than read.
   *
   * ⚠️ A NEGATIVE one is refused on an AGENT sale — raised by the Codex reviewer
   * and reproduced. `sourceCost` stays editable after a consigned sale (a
   * consigned car is never capitalized, so the acquisition lock never engages),
   * so a later correction can raise it above what the car sold for and this
   * subtraction goes negative. That is not a loss: `saleCompletion` REFUSES to
   * complete a sourced sale below the supplier's entitlement, so a negative
   * agent spread cannot be what the sale was posted on. It is evidence the live
   * basis has drifted away from the frozen one.
   *
   * This is the same rule `recordedConsignedMargin` applies to a corrupt frozen
   * margin and `validFrozenEntitlementFor` applies to a corrupt entitlement —
   * "corruption is not a loss" — reaching the one basis that had escaped it.
   *
   * DEALER-OWNED is deliberately untouched. A dealership can and does sell its
   * own stock below cost, that is a real trading result, and withholding it
   * would hide a fact the owner needs.
   *
   * The old dashboard floored this at zero (`Math.max(0, …)`) while
   * `reports.ts` never did, so the two surfaces disagreed AND the floor
   * published a confident zero. `null` is the honest answer, and putting it
   * here rather than at either call site is what stops them diverging again.
   */
  const derivedMargin = salePrice - (eligibleSupplierEntitlement ?? capitalizedCost);
  const derivedMarginIsCorrupt = agent && derivedMargin < 0;

  const margin =
    financedDirectUnverified || basisUnknown
      ? null
      : agent && args.recordedMargin !== undefined
        ? args.recordedMargin
        : evidenceRequired || derivedMarginIsCorrupt
          ? null
          : derivedMargin;

  if (!agent) {
    return {
      isAgentSale: false,
      settlementRoute: null,
      grossTransactionValue: grossTransactionValueForSale({ salePrice }),
      // Zero is a CLAIM that no supplier is owed anything, and a row nobody can
      // classify is in no position to make it. `null` keeps it out of
      // `totalSupplierSettlement` and into `unknownSupplierSettlementSaleCount`,
      // which is what tells the owner the total is a floor.
      supplierSettlement: basisUnknown ? null : 0,
      dealershipMargin: margin,
      // Null exactly when the margin is — the documented contract of this
      // object. Publishing the sale price as turnover for a row whose basis
      // could not be read is the SCRUM-33 defect wearing revenue's name.
      recognizedRevenue: basisUnknown ? null : salePrice,
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
    //
    // `basisUnknown` joins the same arm: where the live cost is not a basis at
    // all, publishing it as the supplier's share is the same error as publishing
    // it as the dealership's margin. `financedDirectUnverified` does NOT — what
    // the supplier is owed is its own frozen fact and does not depend on proving
    // what the financier paid.
    //
    // `derivedMarginIsCorrupt` joins them: in that branch the settlement comes
    // from the SAME drifted `capitalizedCost`, and publishing a supplier share
    // larger than the whole car is the corruption the entitlement ceiling
    // already refuses — arriving through the live basis instead of the frozen
    // one.
    supplierSettlement:
      eligibleSupplierEntitlement ??
      (evidenceRequired || basisUnknown || supplierBasisUnknown || derivedMarginIsCorrupt
        ? null
        : capitalizedCost),
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
