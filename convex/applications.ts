import { v, ConvexError } from "convex/values";
import { MutationCtx, QueryCtx, query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { releaseHoldForApplicationQuote, type DepositTreatment } from "./utils/depositHelpers";
import { depositMethodValidator, type DepositMethod } from "./utils/depositRecording";
import { completeSale } from "./utils/saleCompletion";
import { cancelCompletedSaleOperationalRecords } from "./utils/saleCancellation";
import { runWithIdempotency } from "./utils/idempotency";
import { registerChequeCore, markChequeClearedCore } from "./collections";
import {
  hookFinanceDisbursed,
  hookFinanceCashReceived,
  hookFinanceDisbursementCancelled,
  hookSaleCancelled,
  reverseCommissionForSale,
  getOrgCurrency,
} from "./accounting/workflowHooks";
import { toMinorUnits, assertValidMinorAmount, scaleForCurrency } from "./utils/money";
import { assertProfitApproved, quoteModeRequiresMinimumProfit } from "./utils/profitApproval";
import {
  buildRuleSnapshot,
  creditDecisionForStatus,
  deriveDealStages,
  deriveManagementProfit,
  handoverStatusForFacts,
  settlementIsComplete,
  settlementStatusForFacts,
  type FinanceCompanyRuleSnapshot,
  type ObligationState,
  type SettlementObligations,
} from "./utils/financingEconomics";
import {
  allocatePaymentToReceivable,
  createCanonicalPayment,
  ensureReceivableDocument,
  getReceivableOutstandingMinor,
} from "./subledger";
import { summarizeFees } from "./financeDealCosts";
import {
  consignedSettlementRoute,
  consignedSettlementRouteValidator,
  dealershipCollectsGross,
  isConsignedAgentSale,
  settlementPayer,
  type SettlementPayer,
} from "./utils/vehicleOwnership";
import { auditLog } from "./financialAudit";

/** sourceType used for the canonical finance-company receivable opened at finalizeDeal. */
const FINANCE_APP_RECEIVABLE_SOURCE = "finance_application";

/**
 * Opens (or finds) the canonical receivable owed BY the finance company for a
 * finalized deal. Idempotent per application via the by_org_source index.
 */
async function ensureFinanceCompanyReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    financeCompanyId: Id<"financeCompanies">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    now: number;
  }
) {
  return await ensureReceivableDocument(ctx, {
    orgId: args.orgId,
    documentType: "INVOICE",
    payerType: "FINANCE_COMPANY",
    financeCompanyId: args.financeCompanyId,
    customerId: args.customerId,
    sourceType: FINANCE_APP_RECEIVABLE_SOURCE,
    sourceId: args.applicationId,
    originalAmountMinor: args.amountMinor,
    currency: args.currency,
    issueDate: args.now,
    dueDate: args.now,
    actorId: args.actorId,
  });
}

function receivableStatusForBalance(
  originalAmountMinor: number,
  allocatedMinor: number
): Doc<"receivableDocuments">["status"] {
  if (originalAmountMinor <= 0 || allocatedMinor >= originalAmountMinor) return "PAID";
  return allocatedMinor > 0 ? "PARTIALLY_PAID" : "OPEN";
}

async function getActiveReceivableAllocations(
  ctx: MutationCtx,
  receivableDocumentId: Id<"receivableDocuments">
) {
  return await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();
}

/**
 * Refuses to advance a deal whose dealer-side economics are not actually there.
 *
 * A reappraisal or a reopened approval clears the approved purchase amount
 * while `status` stays APPROVED throughout, so status alone cannot be the gate.
 * Deals with no quotation recorded predate this model entirely and are let
 * through, so nothing in flight is stranded.
 *
 * One copy, two callers: handover and finalization applied the same two checks
 * in the same order and differed only in the closing verb. Two copies of a
 * money-path gate drift, and the drift shows up as the stricter one being
 * quietly bypassed through the other door.
 */
function assertDealerEconomicsRecorded(
  app: Doc<"financeApplications">,
  action: "handing over the vehicle" | "finalizing"
): void {
  if (app.submittedQuotationMinor === undefined) return;
  if (app.approvedDealerPurchaseAmountMinor === undefined) {
    throw new ConvexError(
      `The finance company's approved purchase amount is not recorded on this deal. Record it before ${action}.`
    );
  }
  // An approval whose funding split could not be computed — the company's LTV
  // basis names an amount nobody recorded — is not something to hand a vehicle
  // over against, or to sell on. The approval being present is not enough.
  if (app.financeCompanyFundedPortionMinor === undefined) {
    throw new ConvexError(
      `This deal's funding split could not be calculated. Resolve the reconciliation note on it before ${action}.`
    );
  }
}

/**
 * Whether this deal's money goes straight from the finance company to the
 * supplier, so nothing gross ever reaches the dealership's books.
 *
 * Both halves are required and neither is derivable from the other. The route
 * says who the cheque is made out to; the vehicle says whether there is a
 * supplier at all. A route naming a supplier settlement on dealer-owned stock
 * is a contradiction rather than a direct deal, and reading it as direct would
 * suppress the finance-company receivable on an ordinary financed sale — the
 * dealership would simply stop recording that the company owes it the money.
 * So this fails closed onto the ordinary path.
 *
 * `consignedSettlementRoute` supplies the absent-means-THROUGH_DEALERSHIP
 * reading, which is what keeps every deal finalized before the field existed
 * behaving exactly as it did.
 */
async function settlesDirectToSupplier(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">
): Promise<boolean> {
  if (dealershipCollectsGross(consignedSettlementRoute(app))) return false;
  const vehicle = await ctx.db.get(app.vehicleId);
  return vehicle != null && isConsignedAgentSale(vehicle);
}

/**
 * The same question, asked of a deal that has already posted.
 *
 * `settlesDirectToSupplier` re-derives the route from the live vehicle, which is
 * right before the sale exists and wrong afterwards: the sale is the thing that
 * committed to one side or the other, and `sales.update` locks its route once
 * completed. Re-deriving post-sale means a later edit to the vehicle can flip
 * the answer under a deal that already posted.
 *
 * It also fails CLOSED. In `confirmDisbursement` a `false` answer PERMITS the
 * mutation, so a vehicle row that has gone missing — the super-admin panel can
 * hard-delete one — would have let a direct-route deal post DR Bank / CR
 * AR-Finance-Companies, inventing bank cash the dealership never received. A
 * guard whose evidence has disappeared must refuse, not wave the caller through.
 */
async function closedDealSettlesDirectToSupplier(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">
): Promise<boolean> {
  if (app.finalizedSaleId) {
    const sale = await ctx.db.get(app.finalizedSaleId);
    // A sale this application NAMES but which cannot be loaded is missing
    // evidence, not absent evidence. Falling through would let the caller
    // proceed on a guess about money that has already posted.
    if (!sale || sale.orgId !== app.orgId) {
      throw new ConvexError(
        "The sale behind this deal could not be loaded, so which way it settles cannot be established. Resolve that before recording any settlement against it."
      );
    }
    return !dealershipCollectsGross(consignedSettlementRoute(sale));
  }

  // No sale was ever linked. That is a legacy shape rather than a broken one —
  // `confirmDisbursement` already tolerates deals closed before the canonical
  // receivable existed — so refusing here would strand them. The application's
  // own route is what `finalizeDeal` acted on, and absent reads as
  // THROUGH_DEALERSHIP, which is exactly what those deals posted.
  return !dealershipCollectsGross(consignedSettlementRoute(app));
}

/**
 * Resolves who pays for the car on this deal, from the application's own
 * snapshot.
 *
 * The MODE falls back to the quote's current mode when the application predates
 * `quoteModeAtSubmission`, which is exactly what `finalizeDeal` already does
 * when it derives `financingType` — so the two cannot disagree about what kind
 * of deal this is.
 *
 * The IDENTITY does NOT fall back. A settlement advice records who paid the
 * supplier, and re-deriving that later from a quote field the operator can
 * still edit would let the named payer change after the payment was recorded.
 * A legacy row carrying no snapshot therefore resolves as external-but-unnamed
 * and is refused the direct route, rather than being attributed to whoever the
 * quote happens to name today.
 */
async function settlementPayerForApplication(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">
): Promise<SettlementPayer> {
  let quoteMode = app.quoteModeAtSubmission;
  if (quoteMode === undefined) {
    const quote = await ctx.db.get(app.quoteId);
    if (quote && quote.orgId === app.orgId) quoteMode = quote.mode;
  }
  return settlementPayer({
    quoteMode,
    financeCompanyId: app.companyId,
    manualProviderName: app.manualFinanceSnapshot?.providerName,
  });
}

/** The operator-facing reason an external payer cannot take the direct route. */
function unidentifiedPayerRefusal(reason: "LEASE" | "PAYER_UNNAMED"): string {
  return reason === "LEASE"
    ? "This is a lease, and the leasing provider is not recorded anywhere on the deal — so a payment to the supplier could not be attributed to anyone. Settle through the dealership until the provider is recorded."
    : "The finance provider on this deal is not named, so a payment to the supplier could not be attributed to anyone. Record the provider on the quote, then choose this route.";
}

async function hasHeldQuoteDeposit(ctx: QueryCtx, quoteId: Id<"quotes">): Promise<boolean> {
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_quote_status", (q) => q.eq("quoteId", quoteId).eq("status", "HELD"))) {
    if (deposit.isDeleted !== true) return true;
  }
  return false;
}

async function getQuoteDeposits(ctx: QueryCtx, quoteId: Id<"quotes">): Promise<Array<Doc<"deposits">>> {
  const deposits: Array<Doc<"deposits">> = [];
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))) {
    if (deposit.isDeleted !== true) {
      deposits.push(deposit);
    }
  }
  return deposits;
}

export async function transferFinancedAmountFromCustomerReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    saleAmountMinor: number;
    financedAmountMinor: number;
  }
) {
  const sale = await ctx.db.get(args.saleId);
  if (!sale || sale.orgId !== args.orgId) throw new ConvexError("Finalized sale not found.");
  if (!sale.canonicalReceivableDocumentId) {
    throw new ConvexError("Finalized sale is missing its canonical customer receivable.");
  }

  const customerReceivable = await ctx.db.get(sale.canonicalReceivableDocumentId);
  if (!customerReceivable || customerReceivable.orgId !== args.orgId) {
    throw new ConvexError("Sale customer receivable not found.");
  }

  const customerPortionMinor = Math.max(0, args.saleAmountMinor - args.financedAmountMinor);
  if (customerReceivable.originalAmountMinor === customerPortionMinor) return;

  const activeAllocations = await getActiveReceivableAllocations(ctx, customerReceivable._id);
  const allocatedMinor = activeAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  if (allocatedMinor > customerPortionMinor) {
    throw new ConvexError(
      "Customer receivable allocations exceed the non-financed customer balance. Reconcile the sale before finalizing financing."
    );
  }

  await ctx.db.patch(customerReceivable._id, {
    originalAmountMinor: customerPortionMinor,
    status: receivableStatusForBalance(customerPortionMinor, allocatedMinor),
  });
}

type FinanceApplicationStatus =
  | "DRAFT"
  | "PENDING_DOCS"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "CLOSED"
  | "CANCELLED";

type QuoteMode =
  | "CASH"
  | "CONFIGURED_FINANCE_COMPANY"
  | "MANUAL_FINANCE_COMPANY"
  | "INTERNAL_INSTALLMENT"
  | "LEASE";

const VALID_STATUS_TRANSITIONS: Record<FinanceApplicationStatus, readonly FinanceApplicationStatus[]> = {
  DRAFT: ["PENDING_DOCS"],
  PENDING_DOCS: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "PENDING_DOCS"],
  // APPROVED is terminal for this mutation on purpose. The only legitimate way
  // out of it is finalizeDeal, which patches CLOSED itself after creating the
  // sale — see the guard in updateStatus.
  APPROVED: [],
  REJECTED: ["PENDING_DOCS"],
  CLOSED: [],
  CANCELLED: [],
};

/**
 * How a party row reads an obligation.
 *
 * One translation, used by every row, so a row can never disagree with the
 * settlement stage about whether somebody still owes money. `openPosition` is
 * the only per-row difference — which way an OPEN obligation points, since the
 * dealership owes the supplier on one route and is owed by him on the other.
 *
 * NONE is "nothing outstanding", not "cannot tell": a zero-margin deal has no
 * claim, and that absence is the correct answer rather than missing evidence.
 */
function positionForObligation(
  obligation: ObligationState,
  openPosition: "DEALERSHIP_OWES" | "OWED_TO_DEALERSHIP"
) {
  switch (obligation) {
    case "CLOSED":
      return "SETTLED" as const;
    case "NONE":
      return "NOT_INVOLVED" as const;
    case "OPEN":
      return openPosition;
    default:
      return "UNKNOWN" as const;
  }
}

/**
 * The money half of the cockpit: `أطراف الصفقة` and the headline figure.
 *
 * Every row arrives already classified — who holds the money, which way it is
 * owed, and whether an action is available — rather than as a raw balance the
 * screen has to interpret. A client deciding for itself that a positive balance
 * on one table means "owed to us" and on another means "we owe" is how the same
 * deal ends up described two different ways on two different screens.
 */
/**
 * Which way this deal settles, and whether the money is finished — resolved
 * ONCE, because the stage rail and the money panel must never disagree about it.
 *
 * The SALE is the authority once it exists: `sales.update` locks the route on
 * completion, so re-deriving from the live vehicle afterwards would let a later
 * edit flip the answer under a deal that has already posted. Before a sale
 * exists the vehicle is the only evidence there is.
 *
 * Unlike the mutation-side guard this does NOT throw when the evidence is
 * missing. This is a read, and refusing would blank the operator's whole screen
 * at the moment they most need to see what is wrong. It reports the route as
 * unknown and every caller withholds what depends on it — the same fail-closed
 * outcome, without destroying the diagnostic.
 */
async function resolveSettlement(ctx: QueryCtx, app: Doc<"financeApplications">) {
  const vehicle = await ctx.db.get(app.vehicleId);
  const consigned = vehicle != null && isConsignedAgentSale(vehicle);

  let routeKnown = true;
  let settlesDirect = false;
  // `sales.update` can cancel a completed sale — it cancels the supplier claim
  // and reverses the GL — while the finance application keeps its own status.
  // Reading the sale only for its route left a cancelled deal rendering as live
  // work with a next step and a blocked settlement stage.
  let saleCancelled = false;
  if (app.finalizedSaleId) {
    const sale = await ctx.db.get(app.finalizedSaleId);
    if (!sale || sale.orgId !== app.orgId) routeKnown = false;
    else saleCancelled = sale.status === "CANCELLED";
    if (sale && sale.orgId === app.orgId) settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(sale));
  } else if (vehicle === null) {
    routeKnown = false;
  } else {
    settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(app)) && consigned;
  }

  const supplierClaim = app.finalizedSaleId
    ? (
        await ctx.db
          .query("vehicleSupplierReceivables")
          .withIndex("by_org_sale", (q) =>
            q.eq("orgId", app.orgId).eq("saleId", app.finalizedSaleId!)
          )
          .collect()
      ).find((row) => row.status !== "CANCELLED")
    : undefined;

  const orgCurrency = await getOrgCurrency(ctx, app.orgId);
  const currency = app.economicsCurrency ?? orgCurrency;
  const sameCurrency = (rowCurrency: string) => rowCurrency === currency;

  // Resolved ONCE, from immutable sale-time records, and shared by the
  // obligation below and the headline in `buildCockpitMoney`. Two independent
  // derivations of the same number are two answers waiting to disagree, which
  // is exactly how the party rows came to contradict the stage rail.
  const margin = await saleTimeMarginMinor(ctx, app, { currency, consigned, supplierClaim });

  // --- what the supplier still owes, or is still owed ---------------------
  let supplierObligation: ObligationState = "UNKNOWN";
  if (settlesDirect) {
    if (supplierClaim) {
      supplierObligation = obligationFromRow({
        due: supplierClaim.amountDue,
        settled: supplierClaim.amountReceived ?? 0,
        rowCurrency: supplierClaim.currency,
        queryCurrency: currency,
        storedPaid: supplierClaim.status === "PAID",
      });
    } else {
      // No claim is the CORRECT state for a zero-margin deal: sale completion
      // deliberately opens none. Demanding a paid claim as proof therefore
      // demanded a record whose absence is right, and such deals could never
      // finish. But an absent claim on a deal that DID earn a margin is missing
      // evidence, not proof — so only a margin PROVEN to be exactly zero counts
      // as nothing to collect.
      //
      // A negative margin is not "nothing to collect" either. The sale sold
      // below the supplier's cost, which means the dealership owes rather than
      // is owed, and no record here expresses that. Reporting NONE would close
      // a deal on the strength of a figure that contradicts its own paperwork.
      supplierObligation = !margin.known ? "UNKNOWN" : margin.minor === 0 ? "NONE" : "UNKNOWN";
    }
  } else {
    const payables = app.finalizedSaleId
      ? await ctx.db
          .query("vehicleSupplierPayables")
          .withIndex("by_sale", (q) => q.eq("saleId", app.finalizedSaleId))
          .collect()
      : [];
    const payable = payables.find((row) => row.orgId === app.orgId && row.status !== "CANCELLED");
    supplierObligation = !payable
      ? // On a CONSIGNED through-route deal the dealership collects the gross and
        // owes the supplier his share, so the payable is the record of a debt
        // that certainly exists. Its absence is a missing record, not a settled
        // one, and answering NONE marked the deal complete while the supplier
        // was still unpaid. Only a deal that was never consigned genuinely owes
        // a supplier nothing.
        consigned
        ? "UNKNOWN"
        : "NONE"
      : obligationFromRow({
          due: payable.amountDue,
          settled: payable.amountPaid ?? 0,
          rowCurrency: payable.currency,
          queryCurrency: currency,
          storedPaid: payable.status === "PAID",
        });
  }

  // --- what the finance company still owes --------------------------------
  const statusSettlement = app.settlementStatus ?? settlementStatusForFacts(app);
  let financierObligation: ObligationState;
  if (settlesDirect) {
    // The financier pays the SUPPLIER the approved purchase amount. An advice
    // for less than that is a PART payment and the money is not finished —
    // the previous predicate accepted any positive advice, so half the money
    // reported a completed deal.
    financierObligation =
      app.approvedDealerPurchaseAmountMinor === undefined
        ? "UNKNOWN"
        : app.supplierDisbursedAmountMinor === undefined
          ? "OPEN"
          : app.supplierDisbursedAmountMinor >= app.approvedDealerPurchaseAmountMinor
            ? "CLOSED"
            : "OPEN";
  } else {
    // `settlementStatus` is the lifecycle hint, and it only ever spoke for the
    // financier's leg. It is authoritative here precisely because the supplier's
    // leg is now judged separately above.
    financierObligation =
      statusSettlement === "FULLY_SETTLED" || statusSettlement === "RECONCILED" ? "CLOSED" : "OPEN";
  }

  const obligations: SettlementObligations = routeKnown
    ? { financier: financierObligation, supplier: supplierObligation }
    : { financier: "UNKNOWN", supplier: "UNKNOWN" };

  return {
    vehicle,
    consigned,
    routeKnown,
    settlesDirect,
    saleCancelled,
    supplierClaim,
    /** The one resolution of the margin, so the headline cannot reach a second. */
    margin,
    obligations,
    moneySettled: settlementIsComplete(obligations),
  };
}

/**
 * What the dealership earned on this deal, from records the SALE owns.
 *
 * Two earlier versions of this got it wrong in the same way, which is what the
 * convergence breaker was reporting. The first re-derived the margin as
 * `salePrice − computeVehicleCapitalizedCost`, and that helper reads the
 * vehicle's CURRENT `sourceCost` — so correcting a supplier's price next week
 * silently re-decided whether last week's deal had earned anything. The second
 * read `transactions`, and **that table has no `saleId`**: every predicate over
 * it (recognized-rows-only, all-sale-rows, live-rows-only) was a different way
 * of guessing which sale a row belonged to. The last of them turned a withheld
 * figure into a confidently wrong one — a cancelled deal could read its
 * successor's margin — which is worse than the gap it closed.
 *
 * The evidence was in the wrong table. `vehicleSupplierReceivables` is keyed by
 * `saleId`, so it answers "whose sale is this" natively, and sale completion
 * opens a claim on the direct route **iff the margin is positive**
 * (`utils/saleCompletion.ts`; a sourced sale without a positive cost throws
 * before reaching it). That makes the claim rows a complete record:
 *
 *   - a LIVE claim carries the margin in `amountDue`, frozen at completion —
 *     `recordReceipt` moves `amountReceived`, never this;
 *   - ANY row for the sale, including a CANCELLED one, means a margin existed,
 *     so a missing live claim is missing evidence — never zero;
 *   - NO row at all for the sale is positive proof the margin was zero, which
 *     is the one case where opening no claim was correct.
 *
 * Nothing here reads the vehicle, so a second sale of the same car cannot
 * contaminate the first, and no row from another deal is reachable.
 */
type MarginEvidence = { known: true; minor: number } | { known: false };

async function saleTimeMarginMinor(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  opts: {
    currency: string;
    consigned: boolean;
    supplierClaim: Doc<"vehicleSupplierReceivables"> | undefined;
  }
): Promise<MarginEvidence> {
  const { currency, consigned, supplierClaim } = opts;

  if (supplierClaim) {
    // An amount in another currency, or one this currency cannot represent, is
    // evidence nobody here can read — which is not evidence of zero.
    const minor = toMinorSameCurrencyOrUndefined(
      supplierClaim.amountDue,
      supplierClaim.currency,
      currency
    );
    return minor === undefined ? { known: false } : { known: true, minor };
  }

  if (!consigned || !app.finalizedSaleId) return { known: false };

  // Every claim ever raised for THIS sale, cancelled ones included. The
  // cancelled row is the point: it is the difference between "the deal earned
  // nothing" and "the deal earned something and the claim was voided".
  const claims = await ctx.db
    .query("vehicleSupplierReceivables")
    .withIndex("by_org_sale", (q) =>
      q.eq("orgId", app.orgId).eq("saleId", app.finalizedSaleId!)
    )
    .collect();
  return claims.length === 0 ? { known: true, minor: 0 } : { known: false };
}

/**
 * Whether a subledger row is fully settled, decided in integer minor units.
 *
 * `amountDue`, `amountReceived` and `amountPaid` are MAJOR units — floats. The
 * previous `due - paid <= 0` left a binary residue: a 2.410 JOD claim collected
 * as 1.205 twice ends about 4.4e-16 short, which is greater than zero, so the
 * claim stayed OPEN permanently, the deal could never reach COMPLETE, and the
 * collection button kept inviting a receipt from a supplier who owed nothing.
 * Money is compared as integers or it is not compared.
 */
/**
 * The ONLY conversion this query performs, and the only place it can refuse.
 *
 * `toMinorUnits` throws on anything it cannot represent as a safe integer, and
 * Convex accepts `NaN` as a `v.number()` — a stored amount reachable through the
 * admin raw-JSON editor. This runs inside a QUERY whose contract is to degrade
 * one row to UNKNOWN rather than refuse, because a throw blanks the entire
 * cockpit.
 *
 * A first attempt guarded `rowFullySettled` and the margin resolution with
 * `Number.isFinite`, which was on the wrong side of the problem: the same NaN
 * reached `toMinorUnits` again through the party-row conversions a few lines
 * later, and finiteness says nothing about overflow — `1e18` is finite and
 * `1e21` is not a safe integer. Every conversion in this query now goes through
 * here, and `undefined` is the single way a bad amount leaves it.
 */
function toMinorSameCurrencyOrUndefined(
  amount: number,
  rowCurrency: string,
  queryCurrency: string
): number | undefined {
  if (rowCurrency !== queryCurrency) return undefined;
  if (!Number.isFinite(amount)) return undefined;
  // Computed the same way `toMinorUnits` computes it, and checked BEFORE
  // calling it — that function raises on an unsafe result, so inspecting its
  // return value is too late to avoid the throw.
  const candidate = Math.round(amount * Math.pow(10, scaleForCurrency(rowCurrency)));
  if (!Number.isSafeInteger(candidate)) return undefined;
  return toMinorUnits(amount, rowCurrency);
}

/**
 * What a subledger row says about its obligation, decided in integer minor units.
 *
 * Returns the state rather than a boolean because "not settled" and "cannot be
 * read" are different answers, and a boolean forces them together. A predecessor
 * returned `false` for an unreadable amount, so a claim with a corrupt
 * `amountDue` rendered as `OWED_TO_DEALERSHIP` — the screen asserting a debt on
 * the strength of a figure it had just failed to parse. Unreadable evidence is
 * UNKNOWN in both directions: it is no more proof of a debt than of settlement.
 */
function obligationFromRow(args: {
  due: number;
  settled: number;
  rowCurrency: string;
  queryCurrency: string;
  /** The row's own stored status, which is evidence but not the only evidence. */
  storedPaid: boolean;
}): ObligationState {
  const dueMinor = toMinorSameCurrencyOrUndefined(args.due, args.rowCurrency, args.queryCurrency);
  const settledMinor = toMinorSameCurrencyOrUndefined(
    args.settled,
    args.rowCurrency,
    args.queryCurrency
  );
  if (dueMinor === undefined || settledMinor === undefined) return "UNKNOWN";
  return args.storedPaid || dueMinor - settledMinor <= 0 ? "CLOSED" : "OPEN";
}

async function buildCockpitMoney(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes"> | null,
  settlementFacts: Awaited<ReturnType<typeof resolveSettlement>>
) {
  const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, app.orgId));
  const { vehicle, routeKnown, settlesDirect, moneySettled } = settlementFacts;
  const supplierName = vehicle?.sourcedFromName ?? "";

  // --- actual expenses --------------------------------------------------
  const fees = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  const liveFees = fees.filter((fee) => fee.voidedAt === undefined);
  // `actualAmountMinor` unset means unpaid or unrecorded — NOT zero. Only lines
  // with a real actual are summed, and the count of those without one is
  // reported so the screen can say the total is still incomplete rather than
  // presenting a partial sum as the final cost.
  //
  // The dealership's PROFIT is reduced by what the dealership itself bore, which
  // is not the same as the total of every fee on the deal: `paidBy` names who
  // actually paid, and a transfer fee the customer paid or a commission the
  // finance company deducted is not a cost to the dealership. `summarizeFees`
  // already draws that line and is reused rather than reimplemented — a second
  // copy of a money computation is a second answer waiting to disagree.
  const feeLines = liveFees.map((fee) => ({
    id: fee._id,
    feeType: fee.feeType,
    description: fee.description,
    estimatedAmountMinor: fee.estimatedAmountMinor,
    actualAmountMinor: fee.actualAmountMinor,
    currency: fee.currency,
    reconciled: fee.reconciledAt !== undefined,
  }));
  // A fee recorded in another currency cannot be added to this total, so it is
  // withheld from the summary and counted as outstanding rather than converted
  // at a rate nobody agreed.
  const sameCurrencyFees = liveFees.filter((fee) => fee.currency === currency);
  const sameCurrencySummary = summarizeFees(sameCurrencyFees);
  const actualExpensesMinor = sameCurrencySummary.dealerBorneActualMinor;
  const otherCurrencyFees = liveFees.length - sameCurrencyFees.length;
  const feesAwaitingActuals = sameCurrencySummary.linesAwaitingActual + otherCurrencyFees;
  // RECORDED and RECONCILED are different claims: an amount somebody typed and
  // an amount somebody checked against its evidence. Only the second can close
  // a deal, so only the second may call the headline "actual".
  const expensesFullyReconciled =
    otherCurrencyFees === 0 &&
    sameCurrencySummary.linesAwaitingActual === 0 &&
    sameCurrencySummary.linesAwaitingReconciliation === 0;

  // --- the supplier's position -----------------------------------------
  /** `amountDue` is stored in MAJOR units on both supplier tables, unlike every
   *  `*Minor` field on the application. Converting at the ROW's own currency,
   *  and refusing to mix currencies, is what keeps a 3-decimal JOD figure from
   *  being read as a 2-decimal one. */
  /** Routed through the query's one guarded conversion — see its comment. */
  const toMinorSameCurrency = (amount: number, rowCurrency: string): number | undefined =>
    toMinorSameCurrencyOrUndefined(amount, rowCurrency, currency);

  const payables = app.finalizedSaleId
    ? await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", app.finalizedSaleId))
        .collect()
    : await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_vehicle", (q) => q.eq("vehicleId", app.vehicleId))
        .collect();
  const payable = payables.find((row) => row.orgId === app.orgId && row.status !== "CANCELLED");
  // Converted before subtracting, as above.
  const payableOutstandingMinor = payable
    ? (() => {
        const due = toMinorSameCurrency(payable.amountDue, payable.currency);
        const paid = toMinorSameCurrency(payable.amountPaid ?? 0, payable.currency);
        return due === undefined || paid === undefined ? undefined : Math.max(0, due - paid);
      })()
    : undefined;

  const supplierClaim = settlementFacts.supplierClaim;
  // Two different figures, and conflating them was a CRITICAL defect.
  //
  // OUTSTANDING is what the supplier still owes — the party row and the
  // collection action. ORIGINAL is what the dealership earned on the deal, and
  // it never moves: `recordReceipt` patches `amountReceived` and leaves
  // `amountDue` alone. Deriving the headline from the outstanding figure made
  // every dinar collected reduce reported profit one-for-one, so a fully
  // collected deal reported a loss equal to its expenses — and it was already
  // wrong on day one, because `openSupplierReceivable` seeds `amountReceived`
  // with any customer deposit applied at sale time.
  // Subtracted AFTER conversion, for the same reason the obligation is: taking
  // the difference in major units first leaves a float residue that the row then
  // displays as a balance still outstanding.
  //
  // ORIGINAL is no longer computed here at all. The headline reads the margin
  // from `settlementFacts.margin`, which resolves it once from immutable
  // sale-time records; a second local reading of `amountDue` was how the party
  // row and the headline came to disagree in the first place.
  const supplierClaimOutstandingMinor = supplierClaim
    ? (() => {
        const due = toMinorSameCurrency(supplierClaim.amountDue, supplierClaim.currency);
        const received = toMinorSameCurrency(
          supplierClaim.amountReceived ?? 0,
          supplierClaim.currency
        );
        return due === undefined || received === undefined
          ? undefined
          : Math.max(0, due - received);
      })()
    : undefined;

  // --- the finance company's position ----------------------------------
  const financeReceivables = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q
        .eq("orgId", app.orgId)
        .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
        .eq("sourceId", app._id)
    )
    .collect();
  // CANCELLED is not the only status that means "nothing is owed". A written-off
  // or reversed receivable would otherwise render at its full outstanding
  // balance, asserting the finance company still owes money the dealership has
  // already given up on.
  const financeReceivable = financeReceivables.find(
    (row) => row.status !== "CANCELLED" && row.status !== "WRITTEN_OFF" && row.status !== "REVERSED"
  );
  // Through the shared subledger helper rather than a second summation here.
  // The balance is not stored on the document — a copy of a figure derivable
  // from the allocations is a figure that can disagree with them — and this
  // helper is what the mutation side already trusts, including its handling of
  // reversed allocations, which must not count as paid.
  const financeOutstandingMinor =
    financeReceivable && financeReceivable.currency === currency
      ? await getReceivableOutstandingMinor(ctx, financeReceivable._id)
      : undefined;

  // --- the customer's position -----------------------------------------
  const deposits = quote ? await getQuoteDeposits(ctx, app.quoteId) : [];
  const heldDeposits = deposits.filter((deposit) => deposit.status === "HELD");
  // `amountMinor` is stored on the deposit itself, so nothing is converted here
  // — and a deposit taken in another currency is excluded rather than summed at
  // a rate nobody agreed. Legacy rows predate `currency`; those carry the org's,
  // which is what `currency` already resolves to.
  // `amountMinor` is OPTIONAL — `amount`, in major units, is the required field,
  // and deposits taken before minor units existed carry only that. Falling back
  // to zero made the screen assert the customer had put nothing in while the AR
  // aging report showed the money. Every other reader in the codebase converts;
  // this one now does too.
  const heldDepositMinor = heldDeposits.reduce((total, deposit) => {
    const depositCurrency = deposit.currency ?? currency;
    if (depositCurrency !== currency) return total;
    return total + (deposit.amountMinor ?? toMinorUnits(deposit.amount, depositCurrency));
  }, 0);
  // The mockup shows a receipt number against the customer row. It lives on the
  // canonical payment, not the deposit.
  const depositPaymentId = heldDeposits.find((deposit) => deposit.canonicalPaymentId)?.canonicalPaymentId;
  const depositPayment = depositPaymentId ? await ctx.db.get(depositPaymentId) : null;

  const parties = [
    {
      party: "CUSTOMER" as const,
      name: "",
      position: !routeKnown
        ? ("UNKNOWN" as const)
        : heldDepositMinor > 0
          ? ("DEALERSHIP_HOLDS" as const)
          : ("NOT_INVOLVED" as const),
      amountMinor: heldDepositMinor,
      currency,
      reference: depositPayment?.externalReference,
    },
    settlesDirect && routeKnown
      ? {
          party: "SUPPLIER" as const,
          name: supplierName,
          // On the direct route the financier pays the supplier, so nothing is
          // owed TO him — what remains is the dealership's agency margin, owed
          // BY him. Same row, opposite direction, which is exactly why the
          // screen cannot hard-code the mockup's THROUGH_DEALERSHIP layout.
          //
          // Read from the OBLIGATION, not re-derived from the claim. Deriving it
          // here independently made one response contradict itself: a
          // zero-margin deal has no claim, so this said UNKNOWN while the
          // obligation said NONE and the stage rail said COMPLETE — the screen
          // announcing the deal was finished and that it could not tell, at the
          // same time. There is one authority on who still owes what.
          position: positionForObligation(
            settlementFacts.obligations.supplier,
            "OWED_TO_DEALERSHIP"
          ),
          amountMinor: supplierClaimOutstandingMinor ?? 0,
          currency,
          reference: supplierClaim?.receiptReference,
          // The collection action is keyed to THIS claim. Returning the id the
          // server already resolved means the client never names a receivable
          // of its own choosing — `recordReceipt` re-checks the org anyway, but
          // a screen that can only act on the claim it was shown is a smaller
          // surface than one that can post against any id it can guess.
          receivableId: supplierClaim?._id,
        }
      : {
          party: "SUPPLIER" as const,
          name: supplierName,
          // What is LEFT on the payable, not what it started at. `amountPaid`
          // exists and was previously ignored, so a part-paid payable overstated
          // the debt and a settled one still displayed a full balance — three
          // rows on one panel following two different conventions.
          // Same authority as the direct row above: the obligation, not a second
          // reading of the payable.
          position: positionForObligation(
            settlementFacts.obligations.supplier,
            "DEALERSHIP_OWES"
          ),
          amountMinor: payableOutstandingMinor ?? 0,
          currency,
          reference: undefined,
        },
    {
      party: "FINANCIER" as const,
      name: app.manualFinanceSnapshot?.providerName ?? "",
      position: !routeKnown
        ? ("UNKNOWN" as const)
        : settlesDirect
          ? // It paid the supplier directly, so it never owed the dealership
            // anything on this deal. Reporting a zero receivable would suggest
            // a debt that was settled; there was never one to settle.
            ("NOT_INVOLVED" as const)
          : !financeReceivable
            ? ("NOT_INVOLVED" as const)
            : financeOutstandingMinor === undefined
              ? // A balance in another currency is a balance nobody here can
                // state. Rendering "owes 0" would report a real debt as settled.
                ("UNKNOWN" as const)
              : financeOutstandingMinor === 0
                ? ("SETTLED" as const)
                : ("OWED_TO_DEALERSHIP" as const),
      amountMinor: settlesDirect ? 0 : (financeOutstandingMinor ?? 0),
      currency,
    },
  ];

  // What the supplier ends up with, which is what the headline subtracts.
  // THROUGH_DEALERSHIP: the payable the dealership owes him. DIRECT: the
  // approved amount minus the dealership's margin claim, because the financier
  // pays him the gross and he owes the margin back. Both reduce to the same
  // economics — margin less expenses — which is the point of computing it here
  // once rather than twice on the client.
  let supplierSettlementMinor: number | undefined;
  if (!routeKnown) supplierSettlementMinor = undefined;
  else if (settlesDirect) {
    // From the RECORDED settlement advice, not from the approved amount.
    //
    // Deriving it as `approved − margin claim` looked reasonable and was not:
    // the `approved` term cancels algebraically, leaving `sale price − source
    // cost` — precisely the basis this screen exists to avoid — and it rendered
    // a `تسوية المورد` line for an amount no party would ever pay, because the
    // supplier's actual entitlement is whatever the advice says it was.
    //
    // `supplierDisbursedAmountMinor` is what the financier actually paid him,
    // recorded by `confirmSupplierDisbursement` off the advice document. What he
    // NETS is that, less the margin he owes back. Until that advice exists there
    // is no honest figure, so the headline reports why instead of inventing one.
    // Only from a PROVEN-COMPLETE advice. A partial one is not evidence of what
    // the supplier ends up with: an advice of half the approval reported a
    // profit as if the whole deal had paid, and an advice below the margin
    // produced a NEGATIVE supplier settlement and therefore a profit larger
    // than the entire approved purchase amount.
    //
    // The margin comes from the shared sale-time resolution, and when it is not
    // provable the headline is withheld. It used to read
    // `supplierClaimOriginalMinor ?? 0`, so a claim that was missing, cancelled
    // or denominated in another currency silently became "the supplier owes
    // nothing back" — and the screen published a profit equal to the ENTIRE
    // disbursement as though it were a fact about the deal. Reporting no figure
    // is a smaller error than reporting a confident wrong one.
    const marginBack = settlementFacts.margin;
    supplierSettlementMinor =
      settlementFacts.obligations.financier === "CLOSED" &&
      app.supplierDisbursedAmountMinor !== undefined &&
      marginBack.known
        ? app.supplierDisbursedAmountMinor - marginBack.minor
        : undefined;
    // A supplier cannot net a negative amount; if the recorded facts imply one,
    // they disagree with each other and the figure is not reportable.
    if (supplierSettlementMinor !== undefined && supplierSettlementMinor < 0) {
      supplierSettlementMinor = undefined;
    }
  } else if (payable) {
    supplierSettlementMinor = toMinorSameCurrency(payable.amountDue, payable.currency);
  }

  // A DIRECT deal can never reach FULLY_SETTLED through the status field: the
  // only writer of it is `confirmDisbursement`, which refuses the direct route
  // outright, and `confirmSupplierDisbursement` deliberately writes EXPECTED.
  // Reading settlement off that field alone left the direct route's terminal
  // stage permanently blocked and its qualifier permanently "estimated" — on
  // deals that were completely finished. Each route is judged on the evidence
  // it can actually produce: the advice being recorded, and the supplier's
  // margin claim being collected in full.
  const fullySettled = moneySettled && expensesFullyReconciled;

  return {
    currency,
    settlesDirectToSupplier: settlesDirect,
    routeKnown,
    managementProfit: deriveManagementProfit({
      approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
      supplierSettlementMinor,
      // H-7: read from the application, where the approval froze it. Not
      // recomputed from today's LTV and first payment — the same rule the
      // margin now follows, for the same reason.
      dealerContributionMinor: app.dealerContributionMinor,
      // H-7b: the offsetting half. Composed from the two stored gap fields the
      // same way `recomputeAndPatchEconomics` composes it, so the cockpit and
      // the economics engine cannot disagree about what the customer paid the
      // dealership directly.
      customerDirectToDealerMinor:
        (app.customerGapCashToDealerMinor ?? 0) +
        (app.customerGapInstallmentToDealerMinor ?? 0),
      actualExpensesMinor,
      currency,
      fullySettled,
    }),
    expenses: {
      lines: feeLines,
      actualTotalMinor: actualExpensesMinor,
      /** Non-zero means the total above is not the whole cost yet. */
      awaitingActuals: feesAwaitingActuals,
    },
    parties,
    /** `فرق تخمين` — a read of what was recorded, never a fresh computation. */
    appraisalGapMinor: app.rawAppraisalGapMinor,
  };
}

async function assertRequiredApplicationDocumentsComplete(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes">
) {
  const rules = await ctx.db
    .query("companyDocumentRules")
    .withIndex("by_org", (q) => q.eq("orgId", app.orgId))
    .collect();
  const requiredRules = rules.filter((rule) => rule.isRequired && (!rule.companyId || rule.companyId === quote.companyId));
  if (requiredRules.length === 0) return;

  const docs = await ctx.db
    .query("applicationDocuments")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  const docsByRule = new Map(docs.map((doc) => [doc.ruleId, doc]));

  const missing = requiredRules
    .filter((rule) => {
      const doc = docsByRule.get(rule._id);
      return !doc || (doc.status !== "VERIFIED" && doc.status !== "WAIVED");
    })
    .map((rule) => rule.documentName);

  if (missing.length > 0) {
    throw new ConvexError(
      `Required finance documents must be verified or waived before approval: ${missing.join(", ")}`
    );
  }
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.string()), // DRAFT, PENDING_DOCS, etc.
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]); // Reusing sales permission for now

    let pageResult;
    if (args.status) {
      pageResult = await ctx.db
        .query("financeApplications")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status as "APPROVED" | "REJECTED" | "DRAFT" | "PENDING_DOCS" | "UNDER_REVIEW" | "CLOSED"))
        .paginate(args.paginationOpts);
    } else {
      pageResult = await ctx.db
        .query("financeApplications")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .paginate(args.paginationOpts);
    }

    // Enrich
    const page = await Promise.all(
      pageResult.page.map(async (app) => {
        const customer = await ctx.db.get(app.customerId);
        const vehicle = await ctx.db.get(app.vehicleId);
        const company = app.companyId ? await ctx.db.get(app.companyId) : null;
        const salesperson = await ctx.db.get(app.salespersonId);
        const quote = await ctx.db.get(app.quoteId);
        const hasPendingDepositResolution =
          app.status === "REJECTED" || app.status === "CANCELLED"
            ? await hasHeldQuoteDeposit(ctx, app.quoteId)
            : false;
        // Through the shared resolver, not a fourth hand-rolled reading of the
        // same rule — this file has been corrected twice already for exactly
        // that. The pure form, because `quote` is loaded here anyway for the
        // financed amounts, so it costs no extra read.
        const payer = settlementPayer({
          quoteMode: app.quoteModeAtSubmission ?? quote?.mode,
          financeCompanyId: app.companyId,
          manualProviderName: app.manualFinanceSnapshot?.providerName,
        });
        // Trimmed, matching `settlementPayer` — `saveQuote` applies no trim, so
        // a whitespace-only provider name is reachable, and raw truthiness
        // would render it as a blank cell while the resolver correctly called
        // the payer unnamed.
        const manualProviderName = app.manualFinanceSnapshot?.providerName?.trim() || undefined;

        return {
          ...app,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          // Not `company ? company.name : "Cash / Direct"`. A
          // MANUAL_FINANCE_COMPANY deal has no company row by construction, so
          // every one of them was listed as "Cash / Direct" — on a screen whose
          // whole subject is financed deals, and where "Direct" is now also the
          // name of the other settlement route. The operator finds the deal
          // here before opening it.
          // The nameless cases come back as a key the client translates —
          // returning English here put "Finance provider" and "Lease" into the
          // Arabic UI.
          //
          // `companyName` still carries a displayable string in every case, and
          // must never be empty: the MOBILE list renders it directly
          // (`apps/mobile/src/features/workspace/modules/applications.tsx`)
          // and knows nothing about the key, so an empty string would leave a
          // dangling separator there — and the mobile bundle publishes over
          // the air on merge. The web client prefers the key and translates.
          //
          // It is also what the list searches, so a manual provider's name
          // being the value here is what lets an operator find the deal by it.
          companyName:
            company?.name ??
            manualProviderName ??
            (!payer.external
              ? "Cash / Direct"
              : payer.counterparty === null && payer.unidentifiedReason === "LEASE"
                ? "Lease"
                : "Finance provider"),
          companyLabelKey: (company?.name ?? manualProviderName)
            ? null
            : !payer.external
              ? "CashOrDirect"
              : payer.counterparty === null && payer.unidentifiedReason === "LEASE"
                ? "LeaseFinancing"
                : "UnnamedFinanceProvider",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
          financedAmount: quote?.totalFinancedAmount || 0,
          monthlyInstallment: quote?.monthlyInstallment || 0,
          hasPendingDepositResolution,
        };
      })
    );

    return { ...pageResult, page };
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;

    const customer = await ctx.db.get(app.customerId);
    const vehicle = await ctx.db.get(app.vehicleId);
    const company = app.companyId ? await ctx.db.get(app.companyId) : null;
    const salesperson = await ctx.db.get(app.salespersonId);
    const quote = await ctx.db.get(app.quoteId);
    const deposits = await getQuoteDeposits(ctx, app.quoteId);

    // Derived here rather than in the dialog, because the client must not hold
    // a second opinion about who pays for the car. A previous version of this
    // change shipped the rule twice — once on the server and once in
    // `lib/consignedRouteGuard.ts` — and the copies were free to disagree about
    // what the operator was allowed to choose. One answer, from the side that
    // enforces it.
    //
    // Through the same helper the mutations use, not a second assembly of the
    // same facts: an inline copy here would be a third opinion in the file that
    // exists to remove the second one.
    const payer = await settlementPayerForApplication(ctx, app);
    // The payer is not the only thing that can refuse the direct route.
    // `setSupplierSettlementRoute` also refuses it while a عربون is held,
    // because on that route the dealership bills the customer nothing for the
    // car and the deposit has nowhere to land. Deriving the screen's answer
    // from the payer alone offered an enabled option the server would reject —
    // the same UI/server disagreement this query exists to prevent, one guard
    // further along. Read off the deposits already loaded above rather than
    // re-querying them.
    const hasHeldDeposit = deposits.some((deposit) => deposit.status === "HELD");
    const payerAllowsDirect = payer.external && payer.counterparty !== null;

    return {
      ...app,
      customer,
      vehicle,
      company,
      salesperson,
      quote,
      deposits,
      /** Whether an outside party pays for the car at all. */
      hasExternalFinancier: payer.external,
      /** Whether DIRECT_TO_SUPPLIER is available, and why not when it is not. */
      canSettleDirectToSupplier: payerAllowsDirect && !hasHeldDeposit,
      directRouteRefusal: !payer.external
        ? "NoExternalFinancier"
        : payer.counterparty === null
          ? payer.unidentifiedReason
          : hasHeldDeposit
            ? "HeldDeposit"
            : null,
    };
  },
});

/**
 * Everything the financed-deal cockpit renders, from one query.
 *
 * Deliberately not six queries with the arithmetic done in React. The screen's
 * headline is `صافي ربح المعرض`, a MANAGEMENT figure derived from the finance
 * company's approved purchase amount rather than from what the customer paid —
 * a number the books do not support and must never be asked to. Computing it on
 * the client would make it trivially separable from the qualifier that says so,
 * and would give the screen a second opinion about money the ledger already has
 * an opinion about. One assembly, server-side, is the enforcement.
 *
 * Returns `null` for an application that does not exist or belongs to another
 * org — the same shape `get` uses, so the screen has one not-found path.
 */
export const dealCockpit = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;

    // The money panel is a separate permission from the deal itself: a
    // salesperson tracks their own deal's progress without seeing what the
    // dealership makes on it. Withheld on the SERVER rather than hidden in the
    // component, because a permission enforced by rendering is not enforced.
    const canSeeMoney =
      isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_FINANCE);

    const [customer, vehicle, company, salesperson, quote] = await Promise.all([
      ctx.db.get(app.customerId),
      ctx.db.get(app.vehicleId),
      app.companyId ? ctx.db.get(app.companyId) : Promise.resolve(null),
      ctx.db.get(app.salespersonId),
      ctx.db.get(app.quoteId),
    ]);

    // --- documents, which drive both the checklist and the delivery stage ----
    const rules = await ctx.db
      .query("companyDocumentRules")
      .withIndex("by_org", (q) => q.eq("orgId", app.orgId))
      .collect();
    // Same filter `assertRequiredApplicationDocumentsComplete` applies before
    // approval: an org-wide rule, or one for this deal's company. A screen that
    // counted rules the approval gate ignores would show a checklist the
    // dealership can never finish.
    const applicableRules = rules.filter(
      (rule) => !rule.companyId || rule.companyId === quote?.companyId
    );
    const docRows = await ctx.db
      .query("applicationDocuments")
      .withIndex("by_application", (q) => q.eq("applicationId", app._id))
      .collect();
    const docByRule = new Map(docRows.map((doc) => [doc.ruleId, doc]));

    const documents = applicableRules.map((rule) => {
      const doc = docByRule.get(rule._id);
      return {
        ruleId: rule._id,
        name: rule.documentName,
        required: rule.isRequired === true,
        // A rule with no row yet is MISSING, not absent — the checklist exists
        // to name what has not been done.
        status: doc?.status ?? ("MISSING" as const),
        uploadedAt: doc?.uploadedAt,
      };
    });
    const requiredDocs = documents.filter((doc) => doc.required);
    const requiredDocumentsComplete = requiredDocs.every(
      (doc) => doc.status === "VERIFIED" || doc.status === "WAIVED"
    );

    // --- the stage rail --------------------------------------------------
    // Resolved once, and shared with the money panel below, so the rail and the
    // figures can never disagree about which way the deal settles or whether it
    // is finished. The rail is qualitative — stage names and blocker keys, no
    // amounts — so it is safe to show a caller who cannot see the money.
    const settlementFacts = await resolveSettlement(ctx, app);
    const stages = deriveDealStages({
      settlementComplete: settlementFacts.moneySettled,
      dealCancelled: settlementFacts.saleCancelled,
      status: app.status,
      vehicleHandoverAt: app.vehicleHandoverAt,
      finalizedSaleId: app.finalizedSaleId,
      disbursedAt: app.disbursedAt,
      creditDecision: app.creditDecision,
      appraisalStatus: app.appraisalStatus,
      gapResolution: app.gapResolution,
      settlementStatus: app.settlementStatus,
      handoverStatus: app.handoverStatus,
      rawAppraisalGapMinor: app.rawAppraisalGapMinor,
      approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
      requiredDocumentsComplete,
    });

    const timeline = await ctx.db
      .query("applicationStatusLog")
      .withIndex("by_application", (q) => q.eq("applicationId", app._id))
      .collect();
    const actorNames = new Map<string, string>();
    for (const entry of timeline) {
      if (actorNames.has(entry.changedBy)) continue;
      const actor = await ctx.db.get(entry.changedBy);
      actorNames.set(entry.changedBy, actor?.name ?? "");
    }

    const base = {
      applicationId: app._id,
      status: app.status,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      customer: customer && { id: customer._id, name: `${customer.firstName} ${customer.lastName}`.trim(), phone: customer.phone },
      vehicle: vehicle && {
        id: vehicle._id,
        label: `${vehicle.make} ${vehicle.model} ${vehicle.year}`.trim(),
        vin: vehicle.vin,
        /** `لدى المورد` vs dealership-owned. The screen says whose car this is. */
        consigned: isConsignedAgentSale(vehicle),
        supplierName: vehicle.sourcedFromName,
      },
      salespersonName: salesperson?.name ?? "",
      financeCompanyName: company?.name ?? app.manualFinanceSnapshot?.providerName ?? "",
      stages,
      documents,
      timeline: timeline
        .slice()
        .sort((a, b) => a.changedAt - b.changedAt)
        .map((entry) => ({
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          changedAt: entry.changedAt,
          actorName: actorNames.get(entry.changedBy) ?? "",
          note: entry.note,
        })),
    };

    if (!canSeeMoney) return { ...base, money: null };

    return { ...base, money: await buildCockpitMoney(ctx, app, quote, settlementFacts) };
  },
});

export const createFromQuote = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throw new ConvexError("Quote not found.");
    }
    const customer = await ctx.db.get(quote.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Quote customer not found in this organization.");
    }

    const quoteVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId, unitPrice: quote.vehiclePrice }];
    // Financed deals stay single-vehicle for now — finalizeDeal only ever
    // completes app.vehicleId's sale, so a multi-vehicle quote reaching this
    // point would silently drop every other vehicle at finalization. The
    // wizard never produces this today (multi-vehicle is CASH-only), but
    // reject it defensively rather than relying on that never changing.
    if (quoteVehicleItems.length !== 1) {
      throw new ConvexError("Finance applications currently support exactly one vehicle.");
    }
    for (const item of quoteVehicleItems) {
      const lineVehicle = await ctx.db.get(item.vehicleId);
      if (!lineVehicle || lineVehicle.orgId !== args.orgId || lineVehicle.isDeleted) {
        throw new ConvexError("Quote vehicle not found in this organization.");
      }
    }
    // Kept for the rule snapshot below rather than re-fetched: this handler
    // already validates the company here, and reading it twice per application
    // buys nothing.
    let quoteCompany: Doc<"financeCompanies"> | null = null;
    if (quote.companyId) {
      quoteCompany = await ctx.db.get(quote.companyId);
      if (!quoteCompany || quoteCompany.orgId !== args.orgId) {
        throw new ConvexError("Quote finance company not found in this organization.");
      }
    }

    // Check if application already exists for this quote
    const existing = await ctx.db
      .query("financeApplications")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("quoteId"), args.quoteId))
      .first();

    if (existing) {
      throw new ConvexError("An application already exists for this quote.");
    }

    // Every vehicle on the quote should only have one in-flight application at
    // a time. Use an explicit allowlist of blocking statuses so REJECTED and
    // CLOSED applications (which are effectively terminal) don't strand the
    // vehicle indefinitely and allow a fresh deal to begin without cancellation.
    const IN_FLIGHT_STATUSES: string[] = ["DRAFT", "PENDING_DOCS", "UNDER_REVIEW", "APPROVED"];
    for (const item of quoteVehicleItems) {
      const activeForVehicle = await ctx.db
        .query("financeApplications")
        .withIndex("by_vehicle", (q) => q.eq("vehicleId", item.vehicleId))
        .filter((q) => q.eq(q.field("orgId"), args.orgId))
        .collect()
        .then((rows) => rows.find((r) => IN_FLIGHT_STATUSES.includes(r.status)));
      if (activeForVehicle) {
        throw new ConvexError(
          "This vehicle already has an active finance application. Cancel it before starting a new one."
        );
      }
    }

    const guarantors = await ctx.db
      .query("guarantors")
      .withIndex("by_customer", (q) => q.eq("customerId", quote.customerId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();

    const salary = customer.employment?.salary;
    const existingMonthlyDebt = customer.financials?.totalMonthlyDebt;
    const proposedInstallment = quote.monthlyInstallment ?? 0;
    const dbr =
      salary && salary > 0
        ? ((existingMonthlyDebt ?? 0) + proposedInstallment) / salary
        : undefined;

    let vehicleValuation: number | undefined;
    let ltv: number | undefined;
    if (quote.companyId) {
      const valuations = await Promise.all(
        quoteVehicleItems.map((item) =>
          ctx.db
            .query("vehicleValuations")
            .withIndex("by_vehicle", (q) => q.eq("vehicleId", item.vehicleId))
            .filter((q) => q.eq(q.field("companyId"), quote.companyId))
            .first()
        )
      );
      // Only treat the combined valuation as meaningful if every vehicle on the
      // quote has one — a partial sum would understate true collateral value.
      const allValued = valuations.every((v) => v?.valuationAmount !== undefined);
      vehicleValuation = allValued
        ? valuations.reduce((sum, v) => sum + (v?.valuationAmount ?? 0), 0)
        : undefined;
      if (vehicleValuation && quote.totalFinancedAmount !== undefined) {
        ltv = (quote.totalFinancedAmount / vehicleValuation) * 100;
      }
    }

    const underwritingSnapshot = {
      salaryAtSubmission: salary,
      employerAtSubmission: customer.employment?.employer,
      jobTitleAtSubmission: customer.employment?.title,
      totalMonthlyDebtAtSubmission: existingMonthlyDebt,
      proposedMonthlyInstallment: proposedInstallment,
      dbrAtSubmission: dbr,
      guarantorsAtSubmission: guarantors.map((g) => ({
        guarantorId: g._id,
        firstName: g.firstName,
        lastName: g.lastName,
        nationalIdLastFour: g.nationalId.slice(-4),
        phone: g.phone,
        income: g.income,
        relationship: g.relationship,
      })),
      vehicleValuationAtSubmission: vehicleValuation,
      ltvAtSubmission: ltv,
    };

    const now = Date.now();
    const manualFinanceSnapshot =
      quote.mode === "MANUAL_FINANCE_COMPANY"
        ? {
            ...(quote.manualProviderName !== undefined ? { providerName: quote.manualProviderName } : {}),
            ...(quote.manualProfitRate !== undefined ? { profitRate: quote.manualProfitRate } : {}),
            ...(quote.manualInsuranceRate !== undefined ? { insuranceRate: quote.manualInsuranceRate } : {}),
            ...(quote.manualAdminFees !== undefined ? { adminFees: quote.manualAdminFees } : {}),
            ...(quote.manualCommission !== undefined ? { commission: quote.manualCommission } : {}),
            ...(quote.manualIncludesCommissionInDebt !== undefined
              ? { includesCommissionInDebt: quote.manualIncludesCommissionInDebt }
              : {}),
            ...(quote.totalFinancedAmount !== undefined ? { totalFinancedAmount: quote.totalFinancedAmount } : {}),
            ...(quote.monthlyInstallment !== undefined ? { monthlyInstallment: quote.monthlyInstallment } : {}),
            ...(quote.totalProfit !== undefined ? { totalProfit: quote.totalProfit } : {}),
          }
        : undefined;

    // Snapshot the finance company's dealer-purchase rules onto the
    // application, and point at the immutable version row they came from.
    // Read live, these would let an edit to the company next month
    // retroactively change the terms this deal was approved under.
    let companyRuleSnapshot: FinanceCompanyRuleSnapshot | undefined;
    let companyRuleVersionId: Id<"financeCompanyRuleVersions"> | undefined;
    if (quoteCompany) {
      companyRuleSnapshot = buildRuleSnapshot(quoteCompany);
      const versionRow = await ctx.db
        .query("financeCompanyRuleVersions")
        .withIndex("by_company_version", (q) =>
          q.eq("companyId", quoteCompany!._id).eq("version", companyRuleSnapshot!.ruleVersion)
        )
        .first();
      if (versionRow) companyRuleVersionId = versionRow._id;
    }

    const appId = await ctx.db.insert("financeApplications", {
      orgId: args.orgId,
      quoteId: quote._id,
      customerId: quote.customerId,
      vehicleId: quote.vehicleId,
      ...(quote.vehicleItems ? { vehicleItems: quote.vehicleItems } : {}),
      companyId: quote.companyId,
      salespersonId: auth.user._id,
      status: "PENDING_DOCS",
      // The legacy `status` above stays the field every existing reader uses.
      // These carry the five dimensions it conflates; a new application has
      // been submitted for credit and nothing else has happened yet.
      creditDecision: "SUBMITTED",
      appraisalStatus: "NOT_REQUESTED",
      settlementStatus: "NOT_READY",
      handoverStatus: "BLOCKED",
      ...(companyRuleSnapshot ? { companyRuleSnapshot } : {}),
      ...(companyRuleVersionId ? { companyRuleVersionId } : {}),
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
      ...(quote.mode !== undefined ? { quoteModeAtSubmission: quote.mode } : {}),
      ...(manualFinanceSnapshot ? { manualFinanceSnapshot } : {}),
      underwritingSnapshot,
    });

    await ctx.db.insert("applicationStatusLog", {
      orgId: args.orgId,
      applicationId: appId,
      toStatus: "PENDING_DOCS",
      changedBy: auth.user._id,
      changedAt: now,
    });

    // Automatically assign required documents based on rules
    const rules = await ctx.db
      .query("companyDocumentRules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    for (const rule of rules) {
      // If rule applies to ALL companies, or exactly to this quote's company
      if (!rule.companyId || rule.companyId === quote.companyId) {
        await ctx.db.insert("applicationDocuments", {
          orgId: args.orgId,
          applicationId: appId,
          ruleId: rule._id,
          status: "MISSING",
        });
      }
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "application.created",
      { actorName, customerName: `${customer?.firstName} ${customer?.lastName}` },
      { link: `/${args.orgId}/applications` }
    );

    return appId;
  },
});

export const updateStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_DOCS"),
      v.literal("UNDER_REVIEW"),
      v.literal("APPROVED"),
      v.literal("REJECTED"),
      v.literal("CLOSED")
    ),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId);
    const hasView =
      isSystemOwnerRole(auth.role) ||
      auth.role.permissions.includes(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    if (!hasView) {
      throw new ConvexError("Forbidden: Missing required permissions.");
    }

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) {
      throw new ConvexError("Application not found");
    }

    // CLOSED is not a status you set; it is what finalizeDeal leaves behind
    // once it has created the sale, marked the vehicle sold, resolved deposits
    // and posted the accounting — and it always writes finalizedSaleId with it.
    // Setting it here skipped every one of those preconditions and produced a
    // CLOSED application with no sale, which finalizeDeal then rejects forever
    // because it requires APPROVED. The deal could never be completed.
    if (args.status === "CLOSED") {
      throw new ConvexError(
        "An application is closed by finalizing the deal, not by setting its status. Use finalizeDeal."
      );
    }

    const allowedNextStatuses = VALID_STATUS_TRANSITIONS[app.status];
    if (!allowedNextStatuses.includes(args.status)) {
      throw new ConvexError(
        `Invalid finance application status transition: ${app.status} -> ${args.status}.`
      );
    }

    if (args.status === "UNDER_REVIEW" || args.status === "REJECTED") {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REVIEW_FINANCE_APPLICATION]);
    }

    let approvedBy = app.approvedBy;
    let approvedAt = app.approvedAt;

    if (args.status === "APPROVED") {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_FINANCE_APPLICATION]);
      if (auth.user._id === app.salespersonId) {
        throw new ConvexError("You cannot approve your own application");
      }
      const quote = await ctx.db.get(app.quoteId);
      if (!quote || quote.orgId !== args.orgId) {
        throw new ConvexError("Application quote not found.");
      }
      await assertRequiredApplicationDocumentsComplete(ctx, app, quote);
      approvedBy = auth.user._id;
      approvedAt = Date.now();
    }

    const patchedAt = Date.now();
    const nextFacts = { ...app, status: args.status };
    await ctx.db.patch(args.applicationId, {
      status: args.status,
      updatedAt: patchedAt,
      approvedBy,
      approvedAt,
      // The dimensions have to move with the status that drives them. Setting
      // them once at creation and never again left a normally-completed deal
      // reading creditDecision=SUBMITTED and handoverStatus=BLOCKED forever,
      // with the backfill skipping it because creditDecision was already set —
      // a wrong value is harder to find than a missing one.
      creditDecision: creditDecisionForStatus(args.status),
      handoverStatus: handoverStatusForFacts(nextFacts),
      ...(args.status === "REJECTED" && app.gapResolution === "PENDING_NEGOTIATION"
        ? { gapResolution: "FAILED" as const }
        : {}),
    });

    await ctx.db.insert("applicationStatusLog", {
      orgId: args.orgId,
      applicationId: args.applicationId,
      fromStatus: app.status,
      toStatus: args.status,
      changedBy: auth.user._id,
      changedAt: patchedAt,
    });

    if (args.status === "REJECTED" && app.status !== "REJECTED") {
      await releaseHoldForApplicationQuote(ctx, { quoteId: app.quoteId, actorId: auth.user._id });
    }
  },
});

/**
 * Voids an application that was submitted in error (e.g. against the wrong
 * vehicle) so the deal can be redone cleanly on a fresh quote. CANCELLED is
 * terminal — the application stays visible for audit purposes but can no
 * longer be acted on. Releases any deposit-driven vehicle hold tied to the
 * quote, same as a rejection. CLOSED applications can be cancelled only while
 * no disbursement has been confirmed, because that branch unwinds the sale,
 * vehicle, deposits, and posted accounting records.
 */
export const cancelApplication = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_FINANCE_APPLICATION]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.cancelApplication",
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({ applicationId: args.applicationId, reason: args.reason }),
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) {
          throw new ConvexError("Application not found");
        }

        if (app.status === "CANCELLED") {
          await releaseHoldForApplicationQuote(ctx, { quoteId: app.quoteId, actorId: auth.user._id });
          return;
        }

        // Reversing an already-APPROVED decision is more sensitive than voiding
        // a draft/in-review one, so require the same permission used to approve.
        if (app.status === "APPROVED") {
          await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_FINANCE_APPLICATION]);
        }

        const reason = args.reason ?? "Finance application cancelled";
        const now = Date.now();

        if (app.status === "CLOSED") {
          // Undoing a finalized deal touches the sale, vehicle, deposits, and
          // posted GL — require finalization authority (the same permission
          // needed to close the deal in the first place), not just approval.
          await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.FINALIZE_FINANCED_DEAL]);

          if (app.disbursedAt) {
            throw new ConvexError(
              "Disbursement has already been confirmed for this deal — funds have been received from the finance company. " +
              "This can't be auto-reversed from here; void it through a manual accounting correction instead."
            );
          }

          // The direct route's mirror of the refusal above, and NOT the same
          // fact as the supplier-receipt refusal inside
          // `cancelSupplierReceivablesForSale`. That one fires when the supplier
          // has paid the DEALERSHIP its margin; this fires when the finance
          // company has paid the SUPPLIER. A deal where the company has paid but
          // the supplier has not yet remitted passed every guard and cancelled
          // cleanly — reversing the sale, cancelling the margin claim, and
          // returning a financed, paid-for, already-handed-over car to sellable
          // inventory while the dealership silently wrote off a margin it is
          // still owed. Handover is a precondition of finalization, so the
          // customer always has the car by this point.
          if (app.supplierDisbursementConfirmedAt !== undefined) {
            throw new ConvexError(
              "The finance company has already paid the supplier on this deal. That payment is between the company and the supplier and can't be reversed from here — unwind it with them and record a manual accounting correction instead."
            );
          }

          if (app.finalizedSaleId) {
            const sale = await ctx.db.get(app.finalizedSaleId);
            if (sale && sale.orgId === args.orgId) {
              await cancelCompletedSaleOperationalRecords(ctx, {
                orgId: args.orgId,
                sale,
                actorId: auth.user._id,
                reason,
                reversalDate: now,
              });

              if (sale.status !== "CANCELLED") {
                await ctx.db.patch(sale._id, { status: "CANCELLED" });
                await hookSaleCancelled(ctx, {
                  orgId: args.orgId,
                  saleId: sale._id,
                  reason,
                  actorId: auth.user._id,
                  reversalDate: now,
                });
                // Accrual plus every correction posted against it, called
                // unconditionally for the same reason sales.update's
                // cancellation does — it is the same entry point, so the two
                // void paths cannot drift apart.
                await reverseCommissionForSale(ctx, {
                  orgId: args.orgId,
                  saleId: sale._id,
                  adjustmentSeq: sale.commissionAdjustmentSeq ?? 0,
                  reason,
                  actorId: auth.user._id,
                  reversalDate: now,
                });
              }
            }
          }

          const quote = await ctx.db.get(app.quoteId);
          const financeReceivable = app.companyId
            ? await ctx.db
                .query("receivableDocuments")
                .withIndex("by_org_source", (q) =>
                  q
                    .eq("orgId", args.orgId)
                    .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
                    .eq("sourceId", args.applicationId)
                )
                .unique()
            : null;
          // Deliberately NOT gated on the settlement route.
          //
          // It looks like it should be: on the direct route `finalizeDeal`
          // posted no FINANCE_DISBURSED event and opened no finance-company
          // receivable, so there is nothing to reverse. But the block is already
          // a no-op in that case — `reverseEventIfPosted` returns NOT_POSTED
          // when nothing was posted, `cancelPendingPostByKey` finds no queued
          // row, and `financeReceivable` is null so the patch is skipped. The
          // guard bought nothing.
          //
          // What it DID buy was a hole. It re-derived the route from the LIVE
          // vehicle, while finalization acted on the state as it was months
          // earlier. A vehicle converted SOURCED -> STOCK before finalization
          // (allowed: `retroactiveOwnershipChangeRefusal` only refuses once the
          // vehicle is SOLD) posts the ordinary finance receivable, and being
          // converted back to SOURCED afterwards made this branch skip the
          // reversal that `origin/main` performs — leaving AR-Finance-Companies
          // debited and an OPEN receivable on a voided deal, permanently.
          //
          // Same reasoning as `sales.ts`: "reverseEventIfPosted no-ops when
          // there is nothing on the books and cancels anything still queued, so
          // gating on the live amount only created holes."
          if (
            app.companyId &&
            ((quote?.totalFinancedAmount ?? 0) > 0 || financeReceivable)
          ) {
            await hookFinanceDisbursementCancelled(ctx, {
              orgId: args.orgId,
              applicationId: args.applicationId,
              reason,
              actorId: auth.user._id,
              reversalDate: now,
            });

            // The canonical finance-company receivable opened at finalizeDeal
            // is no longer owed once the deal is voided (this branch already
            // rejects deals whose disbursement was received).
            if (financeReceivable && financeReceivable.status !== "CANCELLED") {
              await ctx.db.patch(financeReceivable._id, { status: "CANCELLED" });
            }
          }
        } else {
          await releaseHoldForApplicationQuote(ctx, { quoteId: app.quoteId, actorId: auth.user._id });
        }

        await ctx.db.patch(args.applicationId, {
          status: "CANCELLED",
          updatedAt: now,
          cancelledBy: auth.user._id,
          cancelledAt: now,
          cancellationReason: args.reason,
          creditDecision: "CANCELLED",
          // This branch has already reversed the sale and voided the
          // finance-company receivable, so nothing is expected any more. The
          // handover timestamp is deliberately left alone — the vehicle
          // physically went to the customer and later came back, and erasing
          // that is not the same as reversing it — but a cancelled deal that
          // was never handed over must not keep claiming it is READY to be.
          settlementStatus: "NOT_READY",
          handoverStatus: handoverStatusForFacts({ ...app, status: "CANCELLED" }),
          // A gap nobody will now negotiate. FAILED is the terminal value the
          // validator already carries for exactly this.
          ...(app.gapResolution === "PENDING_NEGOTIATION"
            ? { gapResolution: "FAILED" as const }
            : {}),
        });

        await ctx.db.insert("applicationStatusLog", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          fromStatus: app.status,
          toStatus: "CANCELLED",
          changedBy: auth.user._id,
          changedAt: now,
          note: args.reason,
        });

        const actorName = await getActorName(ctx);
        const customer = await ctx.db.get(app.customerId);
        await notifyManagers(
          ctx,
          args.orgId,
          "application.cancelled",
          {
            actorName,
            customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          },
          { link: `/${args.orgId}/applications`, excludeUserId: auth.user._id }
        );
      }
    );
  },
});

export const getLog = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const entries = await ctx.db
      .query("applicationStatusLog")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .order("asc")
      .collect();

    return Promise.all(
      entries.map(async (entry) => {
        const user = await ctx.db.get(entry.changedBy);
        return {
          ...entry,
          changedByName: user && "name" in user ? (user.name ?? user.email) : "Unknown",
        };
      })
    );
  },
});

const expectedPaymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("INTERNAL_INSTALLMENT"),
  v.literal("CHEQUE"),
  v.literal("BANK_TRANSFER"),
);

/**
 * التنازل بالسيارة للعميل — records that the vehicle has been handed over to
 * the customer. Required before finalizeDeal. Data-capture only, no document
 * is generated.
 */
export const registerVehicleHandover = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REGISTER_VEHICLE_HANDOVER]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
    if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before registering handover.");
    if (app.vehicleHandoverAt) throw new ConvexError("Vehicle handover has already been registered.");
    assertDealerEconomicsRecorded(app, "handing over the vehicle");

    const now = Date.now();
    await ctx.db.patch(args.applicationId, {
      vehicleHandoverAt: now,
      vehicleHandoverBy: user._id,
      vehicleHandoverNotes: args.notes,
      handoverStatus: "HANDED_OVER",
      updatedAt: now,
    });
    return now;
  },
});

/**
 * Registers how and when the deal's payment is expected to arrive — cash,
 * in-house installment with the customer, a cheque (from the finance company
 * or the customer's bank), or a bank transfer — before finalizeDeal. For
 * CHEQUE this also opens a real postDatedCheques record so it flows through
 * the existing cheque lifecycle (HELD -> DEPOSITED -> CLEARED).
 */
export const registerExpectedPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    method: expectedPaymentMethodValidator,
    expectedDate: v.number(),
    chequeDetails: v.optional(v.object({
      bank: v.string(),
      chequeNumber: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REGISTER_EXPECTED_PAYMENT]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
    if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before registering expected payment.");
    if (!app.vehicleHandoverAt) throw new ConvexError("Register the vehicle handover before the expected payment.");
    if (app.expectedPaymentRegisteredAt) throw new ConvexError("Expected payment has already been registered.");

    if (args.method === "CHEQUE") {
      if (!args.chequeDetails?.bank?.trim() || !args.chequeDetails?.chequeNumber?.trim()) {
        throw new ConvexError("Bank and cheque number are required for a cheque payment.");
      }
      const quote = await ctx.db.get(app.quoteId);
      const amount = quote?.totalFinancedAmount ?? quote?.vehiclePrice ?? 0;
      await registerChequeCore(ctx, {
        orgId: args.orgId,
        customerId: app.customerId,
        vehicleId: app.vehicleId,
        applicationId: args.applicationId,
        bank: args.chequeDetails.bank,
        chequeNumber: args.chequeDetails.chequeNumber,
        chequeDate: args.expectedDate,
        amount,
        actorId: user._id,
      });
    }

    const now = Date.now();
    await ctx.db.patch(args.applicationId, {
      expectedPaymentMethod: args.method,
      expectedPaymentDate: args.expectedDate,
      expectedPaymentRegisteredAt: now,
      expectedPaymentRegisteredBy: user._id,
      updatedAt: now,
    });
    return now;
  },
});

/**
 * Records who the finance company pays on a consigned deal.
 *
 * A decision, not a derivation. The finance company sends the cheque in full
 * with no deduction, made out to the supplier or to the dealership depending on
 * who owns the car, and only the agreement says which — so it is captured
 * before finalization the same way the handover and the expected payment are,
 * and `finalizeDeal` carries it onto the sale.
 *
 * Refused on dealer-owned stock rather than stored and ignored. There is no
 * supplier to settle with, and a stored route on such a deal would make every
 * later reader re-derive whether the vehicle was consigned before it could
 * trust the field — the same reasoning that keeps it off dealer-owned sales.
 *
 * Refused once the application is CLOSED because that is the point the ledger
 * committed: the sale has posted either a supplier payable or a supplier
 * receivable, and flipping the route afterwards would leave the subledger
 * describing the opposite deal from the journal. Correcting a posted deal is a
 * correction, not an edit.
 */
export const setSupplierSettlementRoute = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    route: consignedSettlementRouteValidator,
  },
  handler: async (ctx, args) => {
    // `FINALIZE_FINANCED_DEAL`, not `MANAGE_FINANCE`. The decision has to belong
    // to whoever triggers the posting, and the default MANAGER and SALES
    // templates hold the former and not the latter — so gating this on
    // MANAGE_FINANCE hid the selector from exactly the people who close these
    // deals and know which way the cheque was made out. They would finalize
    // with no route recorded, an absent route reads as THROUGH_DEALERSHIP, and
    // the deal posts the inversion this whole change exists to remove.
    //
    // Chosen over adding MANAGE_FINANCE to the MANAGER template, which would
    // widen access to every other finance mutation and needs a role backfill.
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.FINALIZE_FINANCED_DEAL,
    ]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found.");

    if (app.status === "CLOSED") {
      throw new ConvexError(
        "This deal is already finalized and its settlement has posted, so the route cannot be changed. Correct the sale instead."
      );
    }
    if (app.status === "CANCELLED") {
      throw new ConvexError("This application was cancelled.");
    }

    const vehicle = await ctx.db.get(app.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) throw new ConvexError("Vehicle not found.");
    if (!isConsignedAgentSale(vehicle)) {
      throw new ConvexError(
        "This vehicle is dealership stock, so there is no supplier to settle with and no settlement route to choose."
      );
    }
    // Somebody outside the dealership has to be the one paying the supplier.
    //
    // An INTERNAL_INSTALLMENT deal is financed BY THE DEALERSHIP: the customer
    // pays it over time and it owes the supplier, so no external party pays him
    // and the direct route is incoherent. Accepting it was not merely
    // meaningless — `completeSale` reads the route to decide the customer's
    // vehicle receivable, so it zeroed the record of instalments the customer
    // genuinely owes, and `confirmSupplierDisbursement` then refused the deal
    // forever because it has no finance company. A dead end with the customer's
    // debt erased on the way in.
    //
    // Asked of the quote MODE rather than of `companyId`, which is only ever
    // set on CONFIGURED_FINANCE_COMPANY deals — see `settlementPayer`.
    if (args.route === "DIRECT_TO_SUPPLIER") {
      const payer = await settlementPayerForApplication(ctx, app);
      if (!payer.external) {
        throw new ConvexError(
          "This deal has no outside financier, so nobody outside the dealership pays the supplier — the direct route does not apply. If the dealership is financing the customer itself, settle through the dealership."
        );
      }
      // External, but nobody the advice could name. Refused rather than
      // recorded as an unattributable payment.
      if (payer.counterparty === null) {
        throw new ConvexError(unidentifiedPayerRefusal(payer.unidentifiedReason));
      }
    }
    // A held عربون and the direct route together are refused, deliberately and
    // for now.
    //
    // On this route the dealership bills the customer nothing for the car, so
    // the deposit always exceeds what it billed and what becomes of it is a
    // decision the sale cannot make for itself. The treatments available are
    // genuinely constrained: applying it to the supplier settlement is refused
    // whenever it exceeds the margin — which `depositSettlementPlan` calls
    // ordinary, since deposits run 5-10% of the price and consignment margins
    // are often smaller — and refunding it needs a method, an approver
    // different from whoever took it, and the deposit permissions.
    //
    // That is a whole product surface, and the mockup gives it one: a
    // `معالجة العربون` action of its own. Building half of it inside the
    // finalize button produced two dead ends in review. So the combination
    // fails closed here, at the point where the operator is choosing, with
    // somewhere to go — rather than at finalization, where they would be stuck
    // holding a deal they can neither complete nor unwind.
    if (args.route === "DIRECT_TO_SUPPLIER" && (await hasHeldQuoteDeposit(ctx, app.quoteId))) {
      throw new ConvexError(
        "This deal is holding a reservation deposit, and on the direct route the dealership bills the customer nothing for the car — so what happens to that deposit has to be settled first. Resolve the deposit, then choose this route."
      );
    }

    const previous = consignedSettlementRoute(app);
    await ctx.db.patch(args.applicationId, {
      supplierSettlementRoute: args.route,
      updatedAt: Date.now(),
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "SET_SUPPLIER_SETTLEMENT_ROUTE",
      resourceType: "financeApplications",
      resourceId: args.applicationId,
      description:
        args.route === "DIRECT_TO_SUPPLIER"
          ? `Financed consigned deal will settle DIRECT to ${vehicle.sourcedFromName ?? "the supplier"}: the finance company pays him, and the dealership holds only a claim for its margin.`
          : `Financed consigned deal will settle THROUGH the dealership: gross arrives here on ${vehicle.sourcedFromName ?? "the supplier"}'s behalf and his entitlement is owed to him.`,
      before: { supplierSettlementRoute: previous },
      after: { supplierSettlementRoute: args.route },
    });

    return { route: args.route };
  },
});

export const finalizeDeal = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    // Only consulted when the deal's vehicle is consigned AND the buyer paid
    // the supplier directly — the one case where what the customer owes the
    // dealership does not imply what its reservation deposit is applied to.
    depositResolution: v.optional(
      v.object({
        treatment: v.union(
          v.literal("APPLY_TO_DEALER_AMOUNT"),
          v.literal("APPLY_TO_TRANSACTION_SETTLEMENT"),
          v.literal("REFUND_TO_CUSTOMER"),
          v.literal("FORFEITED"),
          v.literal("OTHER")
        ),
        reason: v.optional(v.string()),
        refundMethod: v.optional(depositMethodValidator),
      })
    ),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.FINALIZE_FINANCED_DEAL]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.finalizeDeal",
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
        if (app.status === "CLOSED" && app.finalizedSaleId) return app.finalizedSaleId;
        if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before finalizing");
        if (!app.vehicleHandoverAt) {
          throw new ConvexError("Register the vehicle handover to the customer before finalizing the deal.");
        }
        if (!app.expectedPaymentMethod || !app.expectedPaymentDate) {
          throw new ConvexError("Register how and when the payment is expected before finalizing the deal.");
        }
        // Same guard as registerVehicleHandover: an approval cleared by a
        // reappraisal leaves status APPROVED, so this is the only thing
        // stopping a sale being completed on economics nothing supports.
        assertDealerEconomicsRecorded(app, "finalizing");

        // On a consigned car financed by an external company, the route decides
        // opposite balance sheets from the same sale — a payable to the supplier
        // for his whole entitlement, or a claim on him for the margin. An absent
        // route reads as THROUGH_DEALERSHIP, which is the right reading for
        // history but a dangerous default for a NEW deal: forgetting to choose
        // posts one of the two silently.
        //
        // Scoped to the population where the question is both meaningful and
        // new — consigned vehicle, external financier. Dealer-owned stock has no
        // supplier, and a deal with no finance company cannot take the direct
        // route at all. Nothing already CLOSED is touched, so no history is
        // restated; an in-flight deal is asked the question once.
        //
        // "External financier" is the quote MODE, not `companyId`. A
        // MANUAL_FINANCE_COMPANY deal structurally cannot carry a `companyId`
        // (`convex/quotes.ts` rejects one on every mode but CONFIGURED), so
        // gating on it meant an ordinary "other finance option" deal was never
        // asked the question and defaulted through the dealership — booking a
        // customer receivable and a supplier payable on a deal where the
        // financier paid the supplier directly.
        //
        // LEASE is asked too, even though it cannot answer DIRECT: being unable
        // to record the right answer is not a reason to silently post the wrong
        // one, and the refusal names why.
        {
          const vehicle = await ctx.db.get(app.vehicleId);
          const payer = await settlementPayerForApplication(ctx, app);
          if (
            vehicle &&
            isConsignedAgentSale(vehicle) &&
            payer.external &&
            app.supplierSettlementRoute === undefined
          ) {
            throw new ConvexError(
              `This car belongs to ${vehicle.sourcedFromName ?? "the supplier"} and the deal is financed, so who the finance company pays decides whether the dealership owes him his entitlement or holds a claim on him for its margin. Record the settlement route before finalizing.`
            );
          }
        }

        // The same refusal as `setSupplierSettlementRoute`, by the other door.
        //
        // That guard sees only the moment the route is chosen. A deposit taken
        // AFTERWARDS slips past it — `deposits.create` needs only VIEW_SALES and
        // the vehicle is RESERVED rather than SOLD, so nothing stops one. The
        // deal then reached `resolveReservationDeposits`, whose message names
        // five treatments this PR removed the UI for, leaving the operator at
        // the finalize button being told to do something the product no longer
        // offers. That is precisely the stranding the route-time refusal exists
        // to prevent, so it is refused here too and in the same terms.
        if (
          app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER" &&
          (await hasHeldQuoteDeposit(ctx, app.quoteId))
        ) {
          throw new ConvexError(
            "This deal is holding a reservation deposit, and on the direct route the dealership bills the customer nothing for the car — so what happens to that deposit has to be settled first. Resolve the deposit, then finalize."
          );
        }

        const quote = await ctx.db.get(app.quoteId);
        if (!quote || quote.orgId !== args.orgId) throw new ConvexError("Quote not found");
        if (quote.customerId !== app.customerId || quote.vehicleId !== app.vehicleId) {
          throw new ConvexError("Application quote does not match the application customer and vehicle.");
        }
        if (quote.companyId && quote.companyId !== app.companyId) {
          throw new ConvexError("Application finance company does not match the quote.");
        }
        await assertRequiredApplicationDocumentsComplete(ctx, app, quote);

        // Re-verify at the commit point, not just at quote time: the approval
        // could have been rejected or the vehicle's minimum raised in between.
        // Quotes written before `desiredProfit` existed carry no margin to check
        // and are let through — the check binds from this deploy forward rather
        // than stranding deals already in flight.
        if (quote.desiredProfit !== undefined && quoteModeRequiresMinimumProfit(quote.mode)) {
          await assertProfitApproved(ctx, {
            orgId: args.orgId,
            vehicleId: app.vehicleId,
            desiredProfit: quote.desiredProfit,
            subject: "deal",
          });
        }

        const quoteMode: QuoteMode | undefined = app.quoteModeAtSubmission ?? quote.mode;
        const financingType =
          quoteMode === "LEASE"
            ? "LEASE"
            : quoteMode === "CONFIGURED_FINANCE_COMPANY" ||
                quoteMode === "MANUAL_FINANCE_COMPANY" ||
                quoteMode === "INTERNAL_INSTALLMENT"
              ? "FINANCED"
              : "CASH";

        const saleId = await completeSale(ctx, {
          orgId: args.orgId,
          vehicleId: app.vehicleId,
          customerId: app.customerId,
          salespersonId: app.salespersonId,
          salePrice: quote.vehiclePrice,
          saleDate: Date.now(),
          status: "COMPLETED",
          downPayment: quote.downPayment,
          financingType: quoteMode === undefined && app.companyId ? "FINANCED" : financingType,
          loanAmount: quote.totalFinancedAmount,
          termMonths: quote.termMonths,
          applicationId: args.applicationId,
          quoteId: app.quoteId,
          // Carried from the application onto the sale. Without this every
          // financed consigned deal posted THROUGH_DEALERSHIP no matter what
          // was agreed, because an absent route reads as that — so a deal whose
          // buyer's financier paid the supplier booked a payable to him and a
          // receivable at the gross, both inverted.
          supplierSettlementRoute: app.supplierSettlementRoute,
          depositResolution: args.depositResolution as
            | { treatment: DepositTreatment; reason?: string; refundMethod?: DepositMethod }
            | undefined,
          idempotencyKey: args.idempotencyKey,
          actorId: auth.user._id,
        });

        const now = Date.now();
        // Resolved once, before anything reads it: the patch below and the
        // posting block further down must agree about which way this deal
        // settles, and re-deriving it twice invites them to disagree.
        const directToSupplier = await settlesDirectToSupplier(ctx, app);

        // The finance-company receivable below is still opened for
        // quote.totalFinancedAmount — the customer's principal — while this PR
        // computes expectedDealerRemittanceMinor from the approved purchase
        // amount. Reconciling the two is PR 2's job, but shipping the
        // divergence silently is not acceptable: flag it so the deal enters
        // the same queue the legacy rows do rather than looking settled.

        // NOTE: no reconciliation flag is raised here, deliberately.
        //
        // This module still opens the finance-company receivable from
        // quote.totalFinancedAmount — the customer's financing principal, which
        // is not what the company owes the dealership. PR 2 replaces that
        // posting. Flagging every new financed deal in the meantime would make
        // "we know this is wrong" a normal operating state, and a queue nobody
        // can act on is worse than a defect nobody has been told about twice.
        //
        // So this PR stays behaviorally dormant on the money path: it adds the
        // model and the arithmetic, and changes no posting. The migration still
        // flags LEGACY rows, which is diagnosis of state that already exists
        // rather than a new deal knowingly created wrong.

        await ctx.db.patch(args.applicationId, {
          status: "CLOSED",
          finalizedSaleId: saleId,
          finalizationIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
          // Credit stays APPROVED — CLOSED is the sale being created, not a
          // change of decision. What moves is settlement: from here the
          // finance company owes the dealership money.
          creditDecision: "APPROVED",
          settlementStatus: "EXPECTED",
          // …except on the direct route, where it owes the dealership nothing.
          // The expected remittance is what the COMPANY will send HERE, and on
          // this route it sends it to the supplier instead. Left at a positive
          // figure it asserts a remittance that will never arrive, and puts the
          // deal into the reconciliation triage queue describing the wrong
          // arrangement — the queue a later settlement PR reconciles against.
          ...(directToSupplier ? { expectedDealerRemittanceMinor: 0 } : {}),
        });

        // On the direct route the finance company pays the SUPPLIER, so none of
        // the three postings below apply — and each would be wrong in its own
        // way rather than merely redundant:
        //
        //  - `transferFinancedAmountFromCustomerReceivable` reduces the customer
        //    receivable to `sale − financed`, which is zero or negative here. On
        //    the direct route that document holds only the dealership's OWN
        //    charges (documentation fees, warranty, GAP), because the car was
        //    invoiced to the buyer by the supplier. It would zero a fee the
        //    customer genuinely owes and mark it PAID, while the GL still
        //    carries the matching AR debit — subledger and ledger disagreeing by
        //    the whole fee.
        //  - `hookFinanceDisbursed` posts DR AR-Finance / CR AR-Customers for
        //    the full principal against a customer AR that was never debited
        //    with it, driving that account to a large credit balance for a
        //    customer who owes nothing.
        //  - the canonical finance-company receivable would record the company
        //    owing the dealership money it will pay to the supplier instead —
        //    a claim nothing can ever settle, sitting beside the real claim,
        //    which runs the other way and is opened against the supplier by
        //    `completeSale`.
        //
        // The dealership's asset on this deal is that supplier margin claim.
        // It is already open by the time this runs.

        // Post the finance receivable transfer when a finance company is on the deal
        if (!directToSupplier && app.companyId && quote.totalFinancedAmount && quote.totalFinancedAmount > 0) {
          const currency = await getOrgCurrency(ctx, args.orgId);
          const loanAmountMinor = toMinorUnits(quote.totalFinancedAmount, currency);
          const saleAmountMinor = toMinorUnits(quote.vehiclePrice, currency);
          await hookFinanceDisbursed(ctx, {
            orgId: args.orgId,
            applicationId: args.applicationId,
            saleId,
            financeCompanyId: app.companyId,
            customerId: app.customerId,
            loanAmountMinor,
            currency,
            actorId: auth.user._id,
            occurredAt: now,
          });

          await transferFinancedAmountFromCustomerReceivable(ctx, {
            orgId: args.orgId,
            saleId,
            saleAmountMinor,
            financedAmountMinor: loanAmountMinor,
          });

          // Open the canonical finance-company receivable alongside the GL
          // transfer, so the amount owed by the finance company is tracked in
          // the subledger and settled by allocation at confirmDisbursement —
          // not just as an untracked GL balance.
          await ensureFinanceCompanyReceivable(ctx, {
            orgId: args.orgId,
            applicationId: args.applicationId,
            financeCompanyId: app.companyId,
            customerId: app.customerId,
            amountMinor: loanAmountMinor,
            currency,
            actorId: auth.user._id,
            now,
          });
        }

        return saleId;
      }
    );
  },
});

/**
 * Records actual receipt of disbursement funds from the finance company.
 * Only valid after finalizeDeal has been called and only once per application.
 */
export const confirmDisbursement = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    disbursedAmountMinor: v.number(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // The expected-amount comparison further down is skipped whenever the quote
    // carries no totalFinancedAmount — a schema-legal state — so it cannot be
    // relied on to reject NaN. Validate the input unconditionally.
    assertValidMinorAmount(args.disbursedAmountMinor, "disbursed amount");
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.confirmDisbursement",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          disbursedAmountMinor: args.disbursedAmountMinor,
        }),
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found.");
        if (app.status !== "CLOSED") throw new ConvexError("Disbursement can only be confirmed on a closed application.");
        if (app.disbursedAt) throw new ConvexError("Disbursement has already been confirmed for this application.");
        if (!app.companyId) throw new ConvexError("This application has no finance company — no disbursement expected.");
        if (args.disbursedAmountMinor <= 0) throw new ConvexError("Disbursement amount must be positive.");

        // This mutation books DR Bank / CR AR-Finance Companies: money that
        // arrived in the dealership's own account, settling a receivable it
        // holds. On the direct route neither exists — the cheque went to the
        // supplier and no finance-company receivable was ever opened. Running it
        // anyway would create bank cash out of nothing and drive AR-Finance
        // Companies negative.
        //
        // Refused rather than quietly redirected to the supplier confirmation.
        // The two record different facts about different money, and an operator
        // who reaches for the wrong one is telling us their understanding of the
        // deal disagrees with what was recorded — which is worth stopping on.
        if (await closedDealSettlesDirectToSupplier(ctx, app)) {
          throw new ConvexError(
            "This deal settles directly with the supplier, so the finance company's payment never reaches the dealership's account and there is nothing here to receive. Record the company's payment to the supplier instead, and collect the dealership's margin from the supplier when he pays it."
          );
        }

        const quote = await ctx.db.get(app.quoteId);
        if (quote?.totalFinancedAmount !== undefined) {
          const currency = await getOrgCurrency(ctx, args.orgId);
          const expectedAmountMinor = toMinorUnits(quote.totalFinancedAmount, currency);
          if (args.disbursedAmountMinor !== expectedAmountMinor) {
            throw new ConvexError(
              `Disbursed amount (${args.disbursedAmountMinor}) does not match the financed amount on the deal (${expectedAmountMinor}).`
            );
          }
        }

        // registerExpectedPayment always opens a HELD postDatedCheques row when
        // the registered method is CHEQUE — link this confirmation to it so the
        // cheque doesn't stay HELD forever while the payment says settled.
        // (Not yet handled: a cheque that bounces AFTER this clears it — see
        // the note below, after the cheque is transitioned.)
        let chequeToClear: Doc<"postDatedCheques"> | null = null;
        if (app.expectedPaymentMethod === "CHEQUE") {
          const cheque = await ctx.db
            .query("postDatedCheques")
            .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
            .filter((q) => q.neq(q.field("isDeleted"), true))
            .unique();
          if (!cheque) {
            throw new ConvexError("Expected cheque record not found for this application.");
          }
          if (cheque.status === "RETURNED" || cheque.status === "CANCELLED") {
            throw new ConvexError(
              "This cheque was returned/cancelled — register a replacement or a different payment method before confirming disbursement."
            );
          }
          if (cheque.status !== "CLEARED") {
            chequeToClear = cheque;
          }
        }

        const now = Date.now();
        await ctx.db.patch(args.applicationId, {
          disbursedAt: now,
          disbursedAmountMinor: args.disbursedAmountMinor,
          disbursementIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
          // This mutation still accepts a single full receipt only, so
          // confirming it settles the deal outright. Partial and repeated
          // receipts, and the actualDealerReceiptTotalMinor they roll up into,
          // arrive with the settlement-line work.
          settlementStatus: "FULLY_SETTLED",
        });

        if (chequeToClear) {
          // Transitions the cheque only — deliberately not clearCheque's
          // legacy collectionPayments/GL posting, since this disbursement is
          // already posted through the canonical finance-company receivable
          // below. A cheque that bounces after this point (post-hoc reversal)
          // is not yet handled; see clearCheque's applicationId guard.
          await markChequeClearedCore(ctx, {
            orgId: args.orgId,
            chequeId: chequeToClear._id,
            clearedAt: now,
          });
        }

        // Post the actual receipt of funds: DR Bank / CR Accounts Receivable —
        // Finance Companies. Without this the finance-company receivable opened
        // at finalizeDeal stays open forever even after the money arrives.
        const currency = await getOrgCurrency(ctx, args.orgId);
        await hookFinanceCashReceived(ctx, {
          orgId: args.orgId,
          applicationId: args.applicationId,
          financeCompanyId: app.companyId,
          customerId: app.customerId,
          amountMinor: args.disbursedAmountMinor,
          currency,
          actorId: user._id,
          occurredAt: now,
        });

        // Record the money in the canonical subledger and settle the
        // finance-company receivable opened at finalizeDeal. Deals finalized
        // before that receivable existed get one created here so the
        // settlement always has a document to allocate against.
        const receivableDocumentId = await ensureFinanceCompanyReceivable(ctx, {
          orgId: args.orgId,
          applicationId: args.applicationId,
          financeCompanyId: app.companyId,
          customerId: app.customerId,
          amountMinor: args.disbursedAmountMinor,
          currency,
          actorId: user._id,
          now,
        });
        // Reflects whatever method was registered before finalization
        // (registerExpectedPayment) instead of assuming bank transfer.
        const disbursementMethod =
          app.expectedPaymentMethod === "CASH" || app.expectedPaymentMethod === "CHEQUE"
            ? app.expectedPaymentMethod
            : "BANK_TRANSFER";
        const canonicalPaymentId = await createCanonicalPayment(ctx, {
          orgId: args.orgId,
          direction: "IN",
          payerType: "FINANCE_COMPANY",
          financeCompanyId: app.companyId,
          method: disbursementMethod,
          amountMinor: args.disbursedAmountMinor,
          currency,
          idempotencyKey: `finance_disbursement_${args.applicationId}`,
          actorId: user._id,
          status: "SETTLED",
          externalReference: `Finance disbursement for application ${args.applicationId}`,
          receivedAt: now,
        });
        const receivableDoc = await ctx.db.get(receivableDocumentId);
        if (receivableDoc) {
          const activeAllocations = await ctx.db
            .query("paymentAllocations")
            .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
            .filter((q) => q.eq(q.field("status"), "ACTIVE"))
            .collect();
          const allocatedMinor = activeAllocations.reduce((sum, a) => sum + a.amountMinor, 0);
          const outstandingMinor = Math.max(0, receivableDoc.originalAmountMinor - allocatedMinor);
          const allocationMinor = Math.min(outstandingMinor, args.disbursedAmountMinor);
          if (allocationMinor > 0) {
            await allocatePaymentToReceivable(ctx, {
              orgId: args.orgId,
              paymentId: canonicalPaymentId,
              receivableDocumentId,
              amountMinor: allocationMinor,
              actorId: user._id,
            });
          }
        }

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "application.created" as const, {
          actorName,
          amount: String(args.disbursedAmountMinor),
        }, { link: `/${args.orgId}/accounting` });
      }
    );
  },
});

/**
 * Records that the finance company paid the SUPPLIER, on the direct route.
 *
 * This money never touches the dealership. It is read off the settlement advice
 * and recorded because it is the event that makes the supplier's margin
 * genuinely collectable — before it, the dealership is owed by a supplier who
 * has not himself been paid.
 *
 * **It posts no journal and creates no payment.** Every existing disbursement
 * path books cash into the dealership's bank; doing that here would invent
 * money the dealership never received. The dealership's asset on this deal is
 * the supplier margin claim `completeSale` already opened, and the only thing
 * that discharges it is `supplierReceivables.recordReceipt` when the supplier
 * actually hands the margin over. Settling the claim here instead would report
 * the money as collected on the day somebody else was paid.
 *
 * The amount is recorded as stated rather than checked against the deal's own
 * figures. What the company pays the supplier is a transaction between two
 * other parties, and the dealership's approved purchase amount is its
 * expectation of it, not its terms — refusing a mismatch would block recording
 * a fact that is true whether or not it matches.
 */
export const confirmSupplierDisbursement = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** What the settlement advice says the company paid the supplier. */
    disbursedAmountMinor: v.number(),
    /** Cheque number or transfer reference from the advice. */
    reference: v.optional(v.string()),
    /** Defaults to now; set it when recording an advice that arrived earlier. */
    disbursedAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertValidMinorAmount(args.disbursedAmountMinor, "disbursed amount");
    // Convex accepts NaN as a `v.number()`, and every other timestamp on this
    // record comes from `Date.now()`. This one is operator-supplied, and its
    // documented purpose is backdating an advice that already arrived — so a
    // future date is not a valid one, and a NaN would be stored and returned.
    if (args.disbursedAt !== undefined) {
      if (!Number.isSafeInteger(args.disbursedAt) || args.disbursedAt <= 0) {
        throw new ConvexError("That disbursement date is not a valid date.");
      }
      if (args.disbursedAt > Date.now()) {
        throw new ConvexError("The disbursement date cannot be in the future.");
      }
    }
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.confirmSupplierDisbursement",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // Every field that gets PERSISTED belongs here. `runWithIdempotency`
        // rejects key reuse only when fingerprints differ, so omitting the
        // reference and the date meant a replay carrying a corrected cheque
        // number returned the prior result and silently discarded the
        // correction — leaving stale evidence on a record whose whole purpose
        // is to hold what the settlement advice said.
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          disbursedAmountMinor: args.disbursedAmountMinor,
          reference: args.reference ?? null,
          disbursedAt: args.disbursedAt ?? null,
        }),
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found.");
        if (app.status !== "CLOSED") {
          throw new ConvexError(
            "The company's payment to the supplier can only be recorded once the deal is finalized."
          );
        }
        // The payer has to be nameable, because that is what this record IS —
        // evidence that a specific third party paid the supplier. A configured
        // finance company is identified by id; a manual provider by the name
        // snapshotted at submission. Neither is `receivableDocuments.
        // financeCompanyId`: the direct route deliberately opens no
        // finance-company receivable, and this is provenance, not a payer of
        // one.
        const payer = await settlementPayerForApplication(ctx, app);
        if (!payer.external) {
          throw new ConvexError("This application has no outside financier — no disbursement expected.");
        }
        if (payer.counterparty === null) {
          throw new ConvexError(unidentifiedPayerRefusal(payer.unidentifiedReason));
        }
        if (args.disbursedAmountMinor <= 0) {
          throw new ConvexError("Disbursement amount must be positive.");
        }
        if (!(await closedDealSettlesDirectToSupplier(ctx, app))) {
          throw new ConvexError(
            "This deal settles through the dealership, so the finance company pays the dealership rather than the supplier. Confirm the disbursement on the deal instead."
          );
        }
        // Not folded into the idempotency key's job. A retry with the same key
        // is suppressed upstream; this catches a SECOND advice recorded under a
        // different key, which is a correction somebody has to make
        // deliberately rather than a second payment on the same deal.
        if (app.supplierDisbursementConfirmedAt !== undefined) {
          throw new ConvexError(
            // Names where a correction goes, rather than stopping dead. Once
            // this is recorded, a corrected reference or date cannot be
            // resubmitted here at all: the same idempotency key fails on the
            // fingerprint and a new key fails on this guard. That is deliberate
            // — a second advice on one deal must not be a routine action — but
            // an operator who mistyped a cheque number still needs somewhere to
            // go, and silence sent them nowhere. A first-class amend path with
            // its own audit record is tracked separately.
            "The company's payment to the supplier has already been recorded on this deal. To correct the amount, reference or date on a recorded advice, ask an administrator to amend it — it cannot be re-submitted here."
          );
        }

        const vehicle = await ctx.db.get(app.vehicleId);
        const supplierName = vehicle?.sourcedFromName ?? "the supplier";
        const confirmedAt = args.disbursedAt ?? Date.now();
        // Name the payer in the audit trail rather than calling every one of
        // them "the finance company". On a manual provider that phrase was
        // simply untrue, and this record is the only place the settlement
        // advice's counterparty is written down.
        let payerName = "The finance company";
        if (payer.counterparty.kind === "MANUAL_PROVIDER") {
          payerName = payer.counterparty.name;
        } else if (app.companyId) {
          const company = await ctx.db.get(app.companyId);
          if (company && company.orgId === args.orgId) payerName = company.name;
        }

        await ctx.db.patch(args.applicationId, {
          supplierDisbursementConfirmedAt: confirmedAt,
          supplierDisbursedAmountMinor: args.disbursedAmountMinor,
          supplierDisbursementReference: args.reference,
          supplierDisbursementConfirmedBy: user._id,
          updatedAt: Date.now(),
          // Deliberately NOT FULLY_SETTLED. Nothing has been settled to the
          // dealership: the company has paid the supplier, and the dealership's
          // margin is still outstanding on the supplier claim. Marking this
          // settled would report the deal as collected on the strength of
          // somebody else's receipt.
          settlementStatus: "EXPECTED",
        });

        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "CONFIRM_SUPPLIER_DISBURSEMENT",
          resourceType: "financeApplications",
          resourceId: args.applicationId,
          description: `${payerName} paid ${supplierName} ${args.disbursedAmountMinor} minor units directly${args.reference ? ` (ref ${args.reference})` : ""}. No dealership cash moved; the dealership's margin remains a claim on ${supplierName}.`,
          before: { supplierDisbursementConfirmedAt: null },
          after: {
            supplierDisbursementConfirmedAt: confirmedAt,
            supplierDisbursedAmountMinor: args.disbursedAmountMinor,
            settlementCounterparty: payerName,
          },
          idempotencyKey: args.idempotencyKey,
        });

        return { confirmedAt, disbursedAmountMinor: args.disbursedAmountMinor };
      }
    );
  },
});
