import { v, ConvexError } from "convex/values";
import { MutationCtx, QueryCtx, query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import {
  requireTenantAuth,
  redactSettlementEvidence,
} from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { notifyManagers, notifyByPermission, getActorName } from "./utils/notifications";
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
import {
  toMinorUnits,
  assertValidMinorAmount,
  toMinorSameCurrencyOrUndefined,
  outstandingMinorFromMajor,
  scaleForCurrency,
} from "./utils/money";
import { assertProfitApproved, quoteModeRequiresMinimumProfit } from "./utils/profitApproval";
import {
  buildRuleSnapshot,
  creditDecisionForStatus,
  deriveDealStages,
  deriveManagementProfit,
  handoverStatusForFacts,
  obligationFromRow,
  positionForObligation,
  settlementIsComplete,
  settlementStatusForFacts,
  type FinanceCompanyRuleSnapshot,
  type ObligationState,
  type SettlementObligations,
} from "./utils/financingEconomics";
// The anomaly verdict, from the module that owns it. Both handover
// confirmations must warn about the same deals; see the helper's own note.
import { approvedAmountIsFarFromEvidenceFor } from "./financingEconomics";
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
  directSettlementBelowEntitlementRefusal,
  isConsignedAgentSale,
  settlementPayer,
  type SettlementPayer,
} from "./utils/vehicleOwnership";
import { computeVehicleCapitalizedCost } from "./utils/vehicleCost";
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
/**
 * Which settlement route this deal is on, and whether the sale still stands.
 *
 * Extracted from `resolveSettlement` unchanged. `sales.update` can cancel a
 * completed sale — cancelling the supplier claim and reversing the GL — while
 * the finance application keeps its own status, so reading the sale only for
 * its route left a cancelled deal rendering as live work.
 */
async function resolveDealRoute(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  opts: { vehicle: Doc<"vehicles"> | null; consigned: boolean }
): Promise<{ routeKnown: boolean; settlesDirect: boolean; saleCancelled: boolean }> {
  let routeKnown = true;
  let settlesDirect = false;
  let saleCancelled = false;

  if (app.finalizedSaleId) {
    const sale = await ctx.db.get(app.finalizedSaleId);
    if (!sale || sale.orgId !== app.orgId) routeKnown = false;
    else saleCancelled = sale.status === "CANCELLED";
    if (sale && sale.orgId === app.orgId) {
      settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(sale));
    }
  } else if (opts.vehicle === null) {
    routeKnown = false;
  } else {
    settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(app)) && opts.consigned;
  }

  return { routeKnown, settlesDirect, saleCancelled };
}

/**
 * What the supplier still owes, or is still owed. Extracted unchanged.
 *
 * The two branches are not symmetric and must not be made so: on the direct
 * route the supplier owes the dealership its margin, and on the through route
 * the dealership owes the supplier his share.
 */
async function resolveSupplierObligation(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  opts: {
    settlesDirect: boolean;
    consigned: boolean;
    currency: string;
    supplierClaim: Doc<"vehicleSupplierReceivables"> | undefined;
    margin: MarginEvidence;
  }
): Promise<ObligationState> {
  const { settlesDirect, consigned, currency, supplierClaim, margin } = opts;

  if (settlesDirect) {
    if (supplierClaim) {
      return obligationFromRow({
        due: supplierClaim.amountDue,
        settled: supplierClaim.amountReceived ?? 0,
        rowCurrency: supplierClaim.currency,
        queryCurrency: currency,
        storedPaid: supplierClaim.status === "PAID",
      });
    }
    // No claim is the CORRECT state for a zero-margin deal: sale completion
    // deliberately opens none. Demanding a paid claim as proof therefore
    // demanded a record whose absence is right, and such deals could never
    // finish. But an absent claim on a deal that DID earn a margin is missing
    // evidence, not proof — so only a margin PROVEN to be exactly zero counts
    // as nothing to collect.
    //
    // A negative margin is not "nothing to collect" either. The sale sold below
    // the supplier's cost, which means the dealership owes rather than is owed,
    // and no record here expresses that. Reporting NONE would close a deal on
    // the strength of a figure that contradicts its own paperwork.
    return !margin.known ? "UNKNOWN" : margin.minor === 0 ? "NONE" : "UNKNOWN";
  }

  const payables = app.finalizedSaleId
    ? await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", app.finalizedSaleId))
        .collect()
    : [];
  const payable = payables.find((row) => row.orgId === app.orgId && row.status !== "CANCELLED");
  if (!payable) {
    // On a CONSIGNED through-route deal the dealership collects the gross and
    // owes the supplier his share, so the payable is the record of a debt that
    // certainly exists. Its absence is a missing record, not a settled one, and
    // answering NONE marked the deal complete while the supplier was still
    // unpaid. Only a deal that was never consigned genuinely owes nothing.
    return consigned ? "UNKNOWN" : "NONE";
  }
  return obligationFromRow({
    due: payable.amountDue,
    settled: payable.amountPaid ?? 0,
    rowCurrency: payable.currency,
    queryCurrency: currency,
    storedPaid: payable.status === "PAID",
  });
}

/** What the finance company still owes. Extracted unchanged. */
function resolveFinancierObligation(
  app: Doc<"financeApplications">,
  settlesDirect: boolean
): ObligationState {
  if (settlesDirect) {
    // A contradicted advice cannot settle anything, whichever side of the
    // approval it falls on.
    //
    // This is deliberately a check on the STATE and not on the arithmetic
    // below. Every mismatch that existed when that arithmetic was written was
    // an advice BELOW the approval, where `>=` happens to be false — so the
    // deal stayed open by accident of the comparison rather than because a
    // contradiction had been decided to block completion. An advice ABOVE the
    // approval was stored, flagged REQUIRES_RECONCILIATION, and satisfied `>=`
    // in the same breath: the stage rail read COMPLETE and the headline was
    // published as ACTUAL on a deal whose entire premise is that nobody yet
    // knows how much money the supplier is holding.
    //
    // UNKNOWN, not OPEN. OPEN asserts the financier still owes money, which is
    // the opposite of true when it has sent too much; UNKNOWN says the state
    // cannot be established, which is exactly the situation, and
    // `settlementIsComplete` already treats it as not-done.
    if (app.supplierDisbursementStatus === "REQUIRES_RECONCILIATION") return "UNKNOWN";
    // The financier pays the SUPPLIER the approved purchase amount. An advice
    // for less than that is a PART payment and the money is not finished — the
    // previous predicate accepted any positive advice, so half the money
    // reported a completed deal.
    if (app.approvedDealerPurchaseAmountMinor === undefined) return "UNKNOWN";
    if (app.supplierDisbursedAmountMinor === undefined) return "OPEN";
    return app.supplierDisbursedAmountMinor >= app.approvedDealerPurchaseAmountMinor
      ? "CLOSED"
      : "OPEN";
  }
  // `settlementStatus` is the lifecycle hint, and it only ever spoke for the
  // financier's leg. It is authoritative here precisely because the supplier's
  // leg is judged separately.
  const statusSettlement = app.settlementStatus ?? settlementStatusForFacts(app);
  return statusSettlement === "FULLY_SETTLED" || statusSettlement === "RECONCILED"
    ? "CLOSED"
    : "OPEN";
}

async function resolveSettlement(ctx: QueryCtx, app: Doc<"financeApplications">) {
  const vehicle = await ctx.db.get(app.vehicleId);
  const consigned = vehicle != null && isConsignedAgentSale(vehicle);

  const { routeKnown, settlesDirect, saleCancelled } = await resolveDealRoute(ctx, app, {
    vehicle,
    consigned,
  });

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

  // Resolved ONCE, from immutable sale-time records, and shared by the
  // obligation below and the headline in `buildCockpitMoney`. Two independent
  // derivations of the same number are two answers waiting to disagree, which
  // is exactly how the party rows came to contradict the stage rail.
  const margin = await saleTimeMarginMinor(ctx, app, { currency, consigned, supplierClaim });
  // The supplier's own side, resolved from the same immutable sale-time record
  // and by the same rules. What he KEEPS is his entitlement — on either route,
  // and whatever the car sold for.
  const supplierEntitlement = await saleTimeSupplierEntitlementMinor(ctx, app, {
    currency,
    consigned,
  });

  const supplierObligation = await resolveSupplierObligation(ctx, app, {
    settlesDirect,
    consigned,
    currency,
    supplierClaim,
    margin,
  });
  const financierObligation = resolveFinancierObligation(app, settlesDirect);

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
    /** The one resolution of what the supplier keeps, for the same reason. */
    supplierEntitlement,
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
 * ⚠️ SUPERSEDED, and recorded here so it is not reinstated. A third version
 * read the CLAIM rows: `vehicleSupplierReceivables` is keyed by `saleId`, and
 * completion opens a claim iff the margin is positive, so "no row for this
 * sale" looked like proof of a zero margin. One reviewer verified that chain
 * exhaustively and accepted it; another found that `hardDeleteOrg` removes
 * receivables before sales, so a partially-failed run leaves claimless sales.
 * Both were right — and an invariant that has to be re-proved by enumerating
 * every possible row-removal path is not an invariant. Do not "simplify" this
 * back to a claim query.
 *
 * So the SALE records what it earned. `consignedMarginMinor` is written at
 * completion on every sourced sale, zero included, with the currency it is
 * denominated in beside it. This function reads that fact and nothing else:
 *
 *   - a LIVE claim carries the margin in `amountDue`, frozen at completion —
 *     `recordReceipt` moves `amountReceived`, never this;
 *   - otherwise the sale's recorded margin, when it is present, readable, in
 *     this query's currency, and not negative;
 *   - anything else is UNKNOWN. Never zero.
 *
 * Nothing is deduced from the absence of a record, and nothing here reads the
 * vehicle, so no other deal's rows are reachable.
 */
type MarginEvidence = { known: true; minor: number } | { known: false };

/**
 * The two records of one supplier payment when they disagree, plus the rest of
 * what the advice says, for the screen that has to state the discrepancy and
 * the form that corrects it.
 *
 * Declared rather than inferred so the cockpit's two return arms carry the same
 * shape: the gated arm supplies it, the ungated arm supplies `null`, and a
 * caller cannot end up with a type that says the field is always absent.
 */
type SettlementAdviceEvidence = {
  recordedMinor: number | null;
  approvedMinor: number | null;
  currency: string | null;
  recordedReference: string | null;
  recordedAt: number | null;
};

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

  // The margin the SALE recorded, not an inference from a missing record.
  //
  // A previous version read "no claim row for this sale" as proof the margin
  // was zero, because completion opens a claim only when it is positive. That
  // was unsound in both directions a reviewer could reach: a sale predating the
  // claims table has no row, and `hardDeleteOrg` removes receivables (step 58)
  // before sales (step 70), so a failed run leaves sales whose claims are gone.
  // Either would have reported a deal fully settled with the margin still
  // uncollected — the precise error this screen exists to prevent.
  //
  // `consignedMarginMinor` is written on every sourced sale, zero included.
  // Absent means the row predates the field: UNKNOWN, and specifically not zero.
  const sale = await ctx.db.get(app.finalizedSaleId);
  if (!sale || sale.orgId !== app.orgId) return { known: false };
  const recorded = sale.consignedMarginMinor;
  if (recorded === undefined || !Number.isFinite(recorded)) return { known: false };
  // Denominated in the currency the sale recorded, which is the ORG's — while
  // this query's currency comes from the application. They agree today only
  // because they were resolved at different times, and `orgSettings` does not
  // count `financeApplications` among the rows that lock an org's currency.
  // Absent means the row predates the field: unreadable, not assumed to match.
  if (sale.consignedMarginCurrency !== currency) return { known: false };
  // The write path cannot produce a negative — `saleCompletion` refuses a
  // sourced sale below the supplier's entitlement — which is exactly why the
  // READER rejects one. `sales` is editable through the super-admin raw-JSON
  // editor, and a negative here would flow through as `disbursed − (−X)` and
  // publish an inflated profit that the `CorruptInput` guard never sees.
  if (recorded < 0) return { known: false };
  return { known: true, minor: recorded };
}

/**
 * What the SUPPLIER keeps on this deal, from the record the sale owns.
 *
 * His entitlement, and nothing else. It is the same figure on both routes and
 * it does not depend on what the car sold for: on THROUGH_DEALERSHIP the
 * dealership owes it to him as a payable, and on DIRECT the financier pays him
 * that much of what it disburses.
 *
 * The direct branch used to derive this as `disbursed − margin`, which was only
 * ever equal to the entitlement when the disbursement happened to equal the sale
 * price. Where a finance company approved below the quotation the screen showed
 * an amount no party would pay — 13,000 against a real entitlement of 15,000 in
 * the case that opened SCRUM-30 — and it moved whenever the recorded margin did,
 * which is not a property the supplier's entitlement has.
 *
 * Same discipline as `saleTimeMarginMinor`, and for the same reasons: a missing,
 * unreadable, foreign-currency or negative record is UNKNOWN, never zero. It
 * reads only the sale, so no other deal's rows are reachable, and it is read
 * rather than recomputed from the vehicle because `sourceCost` stays editable
 * after the sale — recomputing would let a later edit restate a closed deal.
 */
async function saleTimeSupplierEntitlementMinor(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  opts: { currency: string; consigned: boolean }
): Promise<MarginEvidence> {
  if (!opts.consigned || !app.finalizedSaleId) return { known: false };

  const sale = await ctx.db.get(app.finalizedSaleId);
  if (!sale || sale.orgId !== app.orgId) return { known: false };

  const recorded = sale.consignedSupplierEntitlementMinor;
  // Absent means the sale predates the field. A deal completed before it
  // existed genuinely has no record of what the supplier was owed, and the
  // screen says so rather than inventing one.
  if (recorded === undefined || !Number.isFinite(recorded)) return { known: false };
  // Denominated alongside the margin, in `consignedMarginCurrency` — the two
  // are written in the same patch, so one currency governs both.
  if (sale.consignedMarginCurrency !== opts.currency) return { known: false };
  // A supplier cannot be owed a negative amount. The write path cannot produce
  // one, which is precisely why the reader refuses it: `sales` is editable
  // through the super-admin raw-JSON editor, and a negative entitlement would
  // otherwise INFLATE the owner-facing profit with nothing to catch it.
  if (recorded < 0) return { known: false };
  return { known: true, minor: recorded };
}

/*
 * SCRUM-29 moved four helpers out of this file, unchanged:
 * `toMinorSameCurrencyOrUndefined` and `outstandingMinorFromMajor` to
 * `utils/money.ts`, `obligationFromRow` and `positionForObligation` to
 * `utils/financingEconomics.ts`. The CASH deal screen resolves the same supplier
 * rows, and a second implementation of "what does this row owe" is how two
 * screens come to describe one deal differently. Their reasoning travelled with
 * them — including the binary-residue defect that kept a fully collected claim
 * OPEN forever, and the rule that a query degrades one row to UNKNOWN rather
 * than throwing, because a throw blanks the whole cockpit.
 */

/**
 * `المصاريف الفعلية` — the deal's fee lines and what they total. Extracted from
 * `buildCockpitMoney` unchanged.
 *
 * `actualAmountMinor` unset means unpaid or unrecorded — NOT zero. Only lines
 * with a real actual are summed, and the count of those without one is reported
 * so the screen can say the total is still incomplete rather than presenting a
 * partial sum as the final cost.
 *
 * The dealership's PROFIT is reduced by what the dealership itself bore, which
 * is not the total of every fee on the deal: `paidBy` names who actually paid,
 * and a transfer fee the customer paid or a commission the finance company
 * deducted is not a cost to the dealership. `summarizeFees` already draws that
 * line and is reused rather than reimplemented — a second copy of a money
 * computation is a second answer waiting to disagree.
 */
async function summarizeCockpitExpenses(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  currency: string
) {
  const fees = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  const liveFees = fees.filter((fee) => fee.voidedAt === undefined);

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
  const otherCurrencyFees = liveFees.length - sameCurrencyFees.length;

  return {
    feeLines,
    actualExpensesMinor: sameCurrencySummary.dealerBorneActualMinor,
    feesAwaitingActuals: sameCurrencySummary.linesAwaitingActual + otherCurrencyFees,
    // RECORDED and RECONCILED are different claims: an amount somebody typed and
    // an amount somebody checked against its evidence. Only the second can close
    // a deal, so only the second may call the headline "actual".
    expensesFullyReconciled:
      otherCurrencyFees === 0 &&
      sameCurrencySummary.linesAwaitingActual === 0 &&
      sameCurrencySummary.linesAwaitingReconciliation === 0,
  };
}

/**
 * What the customer has put in and is still holding. Extracted unchanged.
 *
 * `amountMinor` is OPTIONAL — `amount`, in major units, is the required field,
 * and deposits taken before minor units existed carry only that. Falling back to
 * zero made the screen assert the customer had put nothing in while the AR aging
 * report showed the money.
 *
 * Every amount goes through the query's one guarded conversion. A raw
 * `toMinorUnits` survived here once, and a legacy deposit carrying only a
 * non-representable `amount` would have thrown and taken the whole cockpit down
 * on the single row the guard was not applied to. A deposit that cannot be read
 * is left out of the total AND counted, so the screen can say the figure is
 * incomplete rather than quietly understating what the customer has paid.
 */
async function resolveCustomerDeposits(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  opts: { quote: Doc<"quotes"> | null; currency: string }
) {
  const { quote, currency } = opts;
  const deposits = quote ? await getQuoteDeposits(ctx, app.quoteId) : [];
  const heldDeposits = deposits.filter((deposit) => deposit.status === "HELD");

  let unreadableDeposits = 0;
  const heldDepositMinor = heldDeposits.reduce((total, deposit) => {
    const depositCurrency = deposit.currency ?? currency;
    // The currency is checked BEFORE choosing which field supplies the amount.
    // Written as `amountMinor ?? convert(...)` the check lived only inside the
    // fallback, so a foreign-currency deposit that happened to carry
    // `amountMinor` was added to the total unconverted — 500 USD cents counted
    // as 500 JOD fils. The stored minor amount is denominated too; it is not a
    // currency-free number.
    const minor =
      depositCurrency !== currency
        ? undefined
        : (deposit.amountMinor ??
          toMinorSameCurrencyOrUndefined(deposit.amount, depositCurrency, currency));
    if (minor === undefined) {
      // Counted whatever the reason — unreadable amount OR another currency.
      unreadableDeposits += 1;
      return total;
    }
    return total + minor;
  }, 0);

  // The mockup shows a receipt number against the customer row. It lives on the
  // canonical payment, not the deposit.
  const depositPaymentId = heldDeposits.find(
    (deposit) => deposit.canonicalPaymentId
  )?.canonicalPaymentId;
  const depositPayment = depositPaymentId ? await ctx.db.get(depositPaymentId) : null;

  return { heldDepositMinor, unreadableDeposits, depositPayment };
}

/** `amountDue` is stored in MAJOR units on both supplier tables, unlike every
 *  `*Minor` field on the application. Converting at the ROW's own currency, and
 *  refusing to mix currencies, is what keeps a 3-decimal JOD figure from being
 *  read as a 2-decimal one. Both callers subtract AFTER conversion: taking the
 *  difference in major units first leaves a float residue that the row then
 *  displays as a balance still outstanding. */
function customerPosition(args: {
  routeKnown: boolean;
  unreadableDeposits: number;
  heldDepositMinor: number;
}) {
  if (!args.routeKnown) return "UNKNOWN" as const;
  // A deposit whose amount could not be read makes this row's total a partial
  // one. Reporting NOT_INVOLVED would tell the dealership the customer had put
  // nothing in.
  if (args.unreadableDeposits > 0) return "UNKNOWN" as const;
  return args.heldDepositMinor > 0 ? ("DEALERSHIP_HOLDS" as const) : ("NOT_INVOLVED" as const);
}

function financierPosition(args: {
  routeKnown: boolean;
  settlesDirect: boolean;
  hasReceivable: boolean;
  outstandingMinor: number | undefined;
}) {
  if (!args.routeKnown) return "UNKNOWN" as const;
  // It paid the supplier directly, so it never owed the dealership anything on
  // this deal. Reporting a zero receivable would suggest a debt that was
  // settled; there was never one to settle.
  if (args.settlesDirect) return "NOT_INVOLVED" as const;
  if (!args.hasReceivable) return "NOT_INVOLVED" as const;
  // A balance in another currency is a balance nobody here can state. Rendering
  // "owes 0" would report a real debt as settled.
  if (args.outstandingMinor === undefined) return "UNKNOWN" as const;
  return args.outstandingMinor === 0 ? ("SETTLED" as const) : ("OWED_TO_DEALERSHIP" as const);
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

  const expenses = await summarizeCockpitExpenses(ctx, app, currency);
  const { feeLines, actualExpensesMinor, feesAwaitingActuals, expensesFullyReconciled } = expenses;

  // --- the supplier's position -----------------------------------------
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
    ? outstandingMinorFromMajor(
        payable.amountDue,
        payable.amountPaid ?? 0,
        payable.currency,
        currency
      )
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
  //
  // ORIGINAL is no longer computed here at all. The headline reads the margin
  // from `settlementFacts.margin`, which resolves it once from immutable
  // sale-time records; a second local reading of `amountDue` was how the party
  // row and the headline came to disagree in the first place.
  const supplierClaimOutstandingMinor = supplierClaim
    ? outstandingMinorFromMajor(
        supplierClaim.amountDue,
        supplierClaim.amountReceived ?? 0,
        supplierClaim.currency,
        currency
      )
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

  const { heldDepositMinor, unreadableDeposits, depositPayment } = await resolveCustomerDeposits(
    ctx,
    app,
    { quote, currency }
  );

  const parties = [
    {
      party: "CUSTOMER" as const,
      name: "",
      position: customerPosition({ routeKnown, unreadableDeposits, heldDepositMinor }),
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
      position: financierPosition({
        routeKnown,
        settlesDirect,
        hasReceivable: Boolean(financeReceivable),
        outstandingMinor: financeOutstandingMinor,
      }),
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
  const supplierSettlementMinor = resolveSupplierSettlementMinor({
    routeKnown,
    settlesDirect,
    supplierEntitlement: settlementFacts.supplierEntitlement,
    margin: settlementFacts.margin,
    payable,
    currency,
  });

  // A DIRECT deal can never reach FULLY_SETTLED through the status field: the
  // only writer of it is `confirmDisbursement`, which refuses the direct route
  // outright, and `confirmSupplierDisbursement` deliberately writes EXPECTED.
  // Reading settlement off that field alone left the direct route's terminal
  // stage permanently blocked and its qualifier permanently "estimated" — on
  // deals that were completely finished.
  const fullySettled = moneySettled && expensesFullyReconciled;

  const managementProfit = deriveManagementProfit({
      // A cancelled sale keeps its approval, its recorded margin and its
      // disbursement, so every input stays computable and the figure they
      // produce describes a deal whose journal was reversed.
      dealCancelled: settlementFacts.saleCancelled,
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
    });

  return {
    currency,
    settlesDirectToSupplier: settlesDirect,
    routeKnown,
    /**
     * The canonical headline field, shared with the cash deal screen and typed
     * as the `DealProfit` union so a renderer must branch on `basis`.
     */
    profit: managementProfit,
    /**
     * ⚠️ TRANSITIONAL DUPLICATE — remove once the frontend carrying `profit` is
     * deployed. Tracked as a SCRUM-29 follow-up.
     *
     * This is not indecision about the field name. The Convex backend deploys
     * BEFORE the frontend (merging auto-deploys Vercel, so the order is forced),
     * which means that between the two there is a live frontend reading
     * `money.managementProfit`. Renaming outright would have made that read
     * `undefined` and `undefined.available` throws — white-screening the
     * financed cockpit, a production accounting surface, for the length of the
     * deploy. Emitting both keys costs one line and removes the window entirely.
     */
    managementProfit,
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

/**
 * What the supplier ends up with, which is what the headline subtracts.
 * Extracted from `buildCockpitMoney` unchanged.
 *
 * THROUGH_DEALERSHIP: the payable the dealership owes him. DIRECT: what the
 * financier actually paid him, less the margin he owes back.
 */
function resolveSupplierSettlementMinor(args: {
  routeKnown: boolean;
  settlesDirect: boolean;
  supplierEntitlement: MarginEvidence;
  margin: MarginEvidence;
  payable: Doc<"vehicleSupplierPayables"> | undefined;
  currency: string;
}): number | undefined {
  const { routeKnown, settlesDirect, supplierEntitlement, margin, payable, currency } = args;

  let supplierSettlementMinor: number | undefined;
  if (!routeKnown) supplierSettlementMinor = undefined;
  else if (settlesDirect) {
    // What the supplier KEEPS is his entitlement. On this route the financier
    // pays him, and the dealership's share of that payment is a claim it holds
    // against him — so what remains his is exactly what he was owed for the car.
    //
    // Two earlier derivations of this line were wrong, in opposite directions,
    // and both because they measured the supplier's position against something
    // that is not his entitlement:
    //
    //   `approved − margin claim` — the `approved` term cancels algebraically,
    //     leaving `sale price − source cost`;
    //   `disbursed − margin` — equal to the entitlement ONLY when the
    //     disbursement equals the sale price. Where the finance company approved
    //     below the quotation it rendered a `تسوية المورد` line for an amount no
    //     party would ever pay: 13,000 against a real entitlement of 15,000, the
    //     mismatch that opened SCRUM-30.
    //
    // Both also moved whenever the recorded margin moved, which is not a
    // property the supplier's entitlement has.
    //
    // It no longer depends on the settlement advice at all, and that is a
    // strengthening rather than a relaxation: the entitlement is a fact frozen
    // at completion, so a missing, partial or contradictory advice can no longer
    // distort the amount. It never could have been evidence of what he keeps —
    // an advice of half the approval used to report a profit as though the whole
    // deal had paid, and one below the margin produced a NEGATIVE supplier
    // settlement and therefore a profit larger than the entire purchase. What
    // the advice still governs is whether the deal is SETTLED, which is carried
    // by the obligation state and the profit's classification badge, not by
    // silently reshaping the number.
    //
    // Unreadable, foreign-currency, negative or unrecorded evidence stays
    // UNKNOWN — `saleTimeSupplierEntitlementMinor` is where that is enforced —
    // and the headline reports why instead of inventing a figure.
    //
    // The MARGIN is required too, even though the rendered amount no longer
    // derives from it. That is deliberate and it is not leftover coupling: what
    // the supplier keeps and what he owes back are two halves of one position,
    // and the screen cannot honestly publish a profit for a deal whose claim
    // record is missing, unreadable, negative or denominated in another
    // currency. Dropping this gate — which the entitlement rewrite did at first
    // — let the headline render a confident figure beside a supplier row
    // reading UNKNOWN, which is precisely the confident-wrong-number failure
    // this screen exists to prevent. Withholding both together is the smaller
    // error, and it keeps every fail-closed guarantee written before the
    // rewrite.
    supplierSettlementMinor =
      supplierEntitlement.known && margin.known ? supplierEntitlement.minor : undefined;
  } else if (payable) {
    supplierSettlementMinor = toMinorSameCurrencyOrUndefined(
      payable.amountDue,
      payable.currency,
      currency
    );
  }
  return supplierSettlementMinor;
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
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]); // Reusing sales permission for now

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
          // The list spreads the whole document too, and it authorizes on the
          // same VIEW_SALES as the detail query — so redacting the three detail
          // endpoints while leaving this one open would hand the same evidence
          // to the same caller through the paginated list. The fourth door.
          ...redactSettlementEvidence(app, role),
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
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;

    /**
     * Settlement evidence is withheld from a caller who may not see money.
     *
     * This query authorizes on VIEW_SALES and returns the whole application
     * document, which predates this release — but the settlement fields inside
     * it do not. `supplierDisbursedAmountMinor`, `supplierDisbursementReference`,
     * `supplierDisbursementStatus` and `supplierDisbursementApprovedAtRecordingMinor`
     * appear nowhere in `origin/main`'s schema. So the release put exactly the
     * figures `dealCockpit` gates behind VIEW_FINANCE into a payload the default
     * SALES template can read, and gating one of the two queries that return the
     * same document gates nothing.
     *
     * `approvedDealerPurchaseAmountMinor` goes with them even though the field
     * itself predates the release. The discrepancy IS the difference between
     * approved and disbursed; withholding one side while publishing the other
     * closes nothing, and the approved amount is one subtraction from the
     * supplier's entitlement — the disclosure the cockpit's split exists to
     * prevent.
     *
     * The ROUTE stays visible. It is a workflow fact about how the deal
     * settles, not an amount, and the cockpit likewise leaves
     * `settlementAdviceRequiresReconciliation` ungated so a stuck deal is still
     * visible to the people who work it.
     */
    const visibleApp = redactSettlementEvidence(app, role);

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
      ...visibleApp,
      // Issued from the UNREDACTED row, deliberately. The stamp is a comparison
      // token, not evidence: a caller whose amounts were withheld above still
      // has to prove the deal did not move under them.
      economicsStamp: economicsStamp(app),
      /**
       * The server's anomaly verdict, so this screen's handover confirmation
       * warns about the same deals the cockpit's does.
       *
       * Both entry points open the SAME one-way door. Passing `false` here — as
       * this screen briefly did — meant the cockpit could say an amount is
       * unlike the quotation and every appraisal on file while the other
       * confirmation presented it as ordinary. Read from the shared derivation
       * rather than recomputed, so the two cannot form separate opinions.
       */
      /**
       * The SAME projection the cockpit consumes, so the two doors into the
       * handover cannot describe the same deal differently — including how its
       * figures are denominated.
       */
      handoverEvidence: await handoverEvidenceFor(ctx, app, role),
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
/**
 * A stamp of the economics a handover confirmation is about, issued to every
 * caller who can load the deal and demanded back by `registerVehicleHandover`.
 *
 * Deliberately NOT permission-shaped: a caller whose amounts are redacted still
 * needs one, because the deal must not be sealed against figures that moved
 * regardless of who is looking. Keying this to visibility is what left default
 * SALES unguarded and dead-ended `confirm:finance_disbursement` roles at once.
 *
 * And deliberately CARRYING NO MONEY. The first version of this encoded the
 * approved amount and its split directly — `v1|<approved>|<funded>|<contribution>`
 * — and then projected it to every caller, handing the exact figures
 * `redactSettlementEvidence` withholds to the callers it withholds them from,
 * legible at a glance. A digest would not have saved it: the format is known
 * and at 100% LTV the search collapses to a single figure. So the token is a
 * revision counter and says nothing about the deal but that it changed.
 */
function economicsStamp(app: Doc<"financeApplications">): string {
  return `v2|${app.economicsRevision ?? 0}`;
}

/**
 * Everything the handover confirmation is allowed to show, resolved ONCE on the
 * server and consumed identically by `dealCockpit` and `applications.get`.
 *
 * Five defects of one class reached this screen before it looked like this:
 * some of what the operator saw came from one query and some from another, or
 * some from a snapshot and some from live props, and the two disagreed. The
 * cure is not another careful patch — it is that there is now exactly one
 * answer, computed in one place, for both doors into the same one-way action.
 *
 * THE FIGURES MOVE TOGETHER. The split is not separately gated: with the
 * approved amount withheld but its two addends shown, an operator recovers the
 * withheld figure by adding them — `funded + contribution` IS the approved
 * amount. Showing a decomposition of a number that is being withheld is not a
 * partial disclosure, it is the whole one with an extra step.
 *
 * CURRENCY FAILS CLOSED. `economicsCurrency` is the deal's own denomination and
 * the only trustworthy one. The organization's current currency is NOT a
 * fallback: `orgSettings` does not count `financeApplications` among the rows
 * that lock it, so an org can record economics in JOD and later switch to USD —
 * this schema says so in as many words. Guessing would render 1,150,000 minor
 * units of USD as 1,150 JOD on the screen that seals the deal permanently. When
 * the denomination cannot be established, this returns null and the client
 * refuses the confirmation rather than spelling a number in a currency nobody
 * verified.
 */
async function handoverEvidenceFor(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  role: Doc<"roles">
): Promise<{
  approvedPurchaseAmountMinor: number | null;
  financeCompanyFundedPortionMinor: number | null;
  dealerContributionMinor: number | null;
  approvedAmountIsFarFromEvidence: boolean;
  currency: { code: string; scale: number } | null;
}> {
  const visibleAmount = redactSettlementEvidence(app, role).approvedDealerPurchaseAmountMinor;
  const maySeeFigures = visibleAmount !== undefined;
  const appraisals = await ctx.db
    .query("financeAppraisals")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  return {
    approvedPurchaseAmountMinor: visibleAmount ?? null,
    financeCompanyFundedPortionMinor: maySeeFigures
      ? app.financeCompanyFundedPortionMinor ?? null
      : null,
    dealerContributionMinor: maySeeFigures ? app.dealerContributionMinor ?? null : null,
    approvedAmountIsFarFromEvidence: approvedAmountIsFarFromEvidenceFor(
      app,
      appraisals,
      maySeeFigures
    ),
    currency: app.economicsCurrency
      ? { code: app.economicsCurrency, scale: scaleForCurrency(app.economicsCurrency) }
      : null,
  };
}

/**
 * The handover stamp on its own, for a caller who may perform the handover.
 *
 * `dealCockpit` and `applications.get` both authorize on `view:sales`, and a
 * role can hold `register:vehicle_handover` without it. Requiring a stamp those
 * callers had no query to obtain would have dead-ended them exactly as keying
 * the old obligation to `view:finance` dead-ended `confirm:finance_disbursement`
 * — the same defect, one layer down, which is why this exists rather than a
 * note telling operators to open a different screen.
 *
 * Authorized on the permission to ACT, so the ability to obtain the token
 * follows from the ability to use it. It returns the token and nothing else:
 * no figures, no identity, no status.
 */
export const handoverStamp = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REGISTER_VEHICLE_HANDOVER]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;
    return economicsStamp(app);
  },
});

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

    const [customer, vehicle, company, salesperson, quote, finalizedSale] = await Promise.all([
      ctx.db.get(app.customerId),
      ctx.db.get(app.vehicleId),
      app.companyId ? ctx.db.get(app.companyId) : Promise.resolve(null),
      ctx.db.get(app.salespersonId),
      ctx.db.get(app.quoteId),
      app.finalizedSaleId ? ctx.db.get(app.finalizedSaleId) : Promise.resolve(null),
    ]);

    /**
     * The sale this deal should be READ at — or null when there is no sale that
     * can actually render one.
     *
     * Deliberately NOT `app.finalizedSaleId`. That id survives operations which
     * make the sale unreadable: `sales.softDelete` sets `isDeleted` and nothing
     * anywhere clears `finalizedSaleId`, so a finalized deal whose sale was
     * deleted still carries a perfectly plausible-looking id. `sales.dealCockpit`
     * returns `null` for a deleted sale, so sending a caller there would replace
     * a screen that renders with one that says the sale does not exist — and the
     * application cockpit, which still renders fine, would have become
     * unreachable. Settlement notifications deep-link to the application URL, so
     * that is a live audit path, not a hypothetical one.
     *
     * Validated on the server because the client cannot see `isDeleted` and must
     * not be the thing deciding whether a redirect target is real.
     */
    const canonicalSaleId =
      finalizedSale && !finalizedSale.isDeleted && finalizedSale.orgId === app.orgId
        ? finalizedSale._id
        : null;

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
      // Without the BASIS the rail cannot tell an approval that rests on
      // appraisal evidence from one the company named directly — and went on
      // demanding an appraisal that would never be recorded for the second.
      approvedPurchaseBasis: app.approvedPurchaseBasis,
      // Whether the split actually came out. A MANUAL approval only makes the
      // appraisal moot when the economics could be computed without one.
      fundingSplitComputed: app.financeCompanyFundedPortionMinor !== undefined,
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

    const adviceRequiresReconciliation =
      app.supplierDisbursementStatus === "REQUIRES_RECONCILIATION";
    const settlementAdviceEvidence: SettlementAdviceEvidence | null =
      adviceRequiresReconciliation
        ? {
            recordedMinor: app.supplierDisbursedAmountMinor ?? null,
            approvedMinor:
              app.supplierDisbursementApprovedAtRecordingMinor ??
              app.approvedDealerPurchaseAmountMinor ??
              null,
            currency: app.economicsCurrency ?? null,
            /**
             * The rest of the recorded advice, so the correction form can open
             * showing what is actually on file.
             *
             * Not decoration. A dialog that is never told the cheque number
             * cannot prefill it, and the first version of this form opened
             * blank on the reference and on today's date — so an operator
             * correcting the amount submitted an empty reference and a wrong
             * date alongside it. The server no longer accepts that as an
             * instruction to erase them, and this stops the form asking.
             */
            recordedReference: app.supplierDisbursementReference ?? null,
            recordedAt: app.supplierDisbursementConfirmedAt ?? null,
          }
        : null;

    /**
     * `finalizeDeal`'s settlement-route prerequisite, evaluated with its own
     * inputs rather than approximated.
     *
     * Scoped exactly as the mutation scopes it: a consigned car (the supplier's,
     * so somebody owes somebody), and an EXTERNAL financier — which is the quote
     * MODE, not `companyId`, because a MANUAL_FINANCE_COMPANY deal structurally
     * cannot carry one. Nothing already closed is asked, since its sale has
     * already posted one of the two answers.
     */
    const settlementRouteRequired =
      app.status !== "CLOSED" &&
      app.supplierSettlementRoute === undefined &&
      vehicle !== null &&
      isConsignedAgentSale(vehicle) &&
      (await settlementPayerForApplication(ctx, app)).external;

    const base = {
      /**
       * What KIND of deal this is. SCRUM-29 put a cash deal on the same screen,
       * and the view branches on this rather than inferring the kind from which
       * fields happen to be populated.
       */
      dealKind: "FINANCED" as const,
      /** The id whose tail the header shows — the application on this side. */
      dealRef: app._id as string,
      applicationId: app._id,
      /** The sale this became, once it has one. Absent before finalization. */
      saleId: app.finalizedSaleId ?? null,
      /**
       * Where this deal's canonical screen lives, or null when it lives here.
       *
       * Differs from `saleId` exactly when the sale exists but cannot be read —
       * see the derivation above. Callers routing on this must use it rather than
       * `saleId`, or they will send an operator to a screen that reports the sale
       * does not exist.
       */
      canonicalSaleId,
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
      /**
       * That the recorded settlement advice disagrees with what the deal was
       * approved at — and nothing about by how much.
       *
       * Outside the money gate on purpose. This is a WORKFLOW condition: it
       * says the deal is waiting on a human, and a state nobody is shown is not
       * a recovery path, it is the same dead end in a different place. Whoever
       * can see the deal can see that it is stuck.
       *
       * An earlier revision put the amounts out here with it, on the reasoning
       * that the person who chases a settlement advice is not always the one
       * allowed to see margins. That reasoning was wrong about which figure was
       * being published: `approvedMinor` is one subtraction from the
       * dealership's margin, so it handed `view:sales` exactly what the money
       * gate exists to withhold. The condition is public; the evidence is not.
       */
      settlementAdviceRequiresReconciliation: adviceRequiresReconciliation,
      /**
       * Whether the fact `finalizeDeal` demands about the payment is on file.
       *
       * Deliberately `expectedPaymentMethod && expectedPaymentDate` — the exact
       * pair `finalizeDeal` refuses without — and NOT the
       * `expectedPaymentRegisteredAt` timestamp that `registerExpectedPayment`
       * checks for a repeat. The two answer different questions, and the
       * difference is only visible on a row written before that timestamp
       * existed: reading the timestamp would tell such a deal to register a
       * payment it already has, and the mutation would agree and overwrite it.
       * The review dialog gates on the method for the same reason.
       *
       * A WORKFLOW condition, so it sits outside the money gate with
       * `settlementAdviceRequiresReconciliation`: it carries no amount, no date
       * and no method — only that the step is done. Whoever may see the deal may
       * see which step it is waiting on.
       */
      expectedPaymentRegistered: Boolean(app.expectedPaymentMethod && app.expectedPaymentDate),
      /**
       * That `finalizeDeal` will refuse until the settlement route is recorded.
       *
       * The SAME predicate the mutation refuses on, evaluated here rather than
       * reconstructed: a consigned car, an external financier, and no route
       * chosen. It cannot be derived from anything the screen already had —
       * `money.routeKnown` answers whether the SALE is readable, and an absent
       * route reads as the legacy THROUGH_DEALERSHIP default everywhere else, so
       * both would report this deal as perfectly fine.
       *
       * Without it the cockpit offered a close that the server was certain to
       * reject, on the ordinary shape of a consigned financed deal, and it did
       * so one step AFTER handover had sealed the approved amount.
       *
       * A workflow condition with no amounts in it, so it sits outside the money
       * gate like the other two.
       */
      supplierSettlementRouteRequired: settlementRouteRequired,
      /**
       * The stamp the handover confirmation must send back, on `base` so it
       * survives the money gate below.
       *
       * A caller who cannot see the figures still needs it: the deal must not
       * be sealed against economics that moved, whoever is looking. Putting it
       * inside `money` would have recreated the defect this replaces — an
       * obligation only the permitted could discharge.
       */
      economicsStamp: economicsStamp(app),
      /**
       * What the handover confirmation shows, on `base` so it survives the
       * money gate — and derived through `redactSettlementEvidence`, the same
       * policy `applications.get` uses.
       *
       * The cockpit used to read these from `getEconomics`, which it only
       * mounts for `view:finance_applications`. A role holding
       * `confirm:finance_disbursement` without it is ENTITLED to the approved
       * amount — `applications.get` shows it — yet the cockpit rendered the
       * confirmation with no figures and no anomaly warning, while the stamp
       * still arrived and the handover still sealed. The two entry points to
       * the same one-way door disagreed about the same deal for the same
       * caller, and the cockpit was the one that showed less.
       *
       * Redaction is a DISPLAY question and belongs here. What must never come
       * back is keying the OBLIGATION to it: the stamp above is demanded of
       * everyone, and a caller shown nothing is still held to the deal not
       * having moved.
       */
      handoverEvidence: await handoverEvidenceFor(ctx, app, role),
      /**
       * The FIGURES behind that flag, and they are gated.
       *
       * `null` here means one of two different things and the client must not
       * try to tell them apart: either there is no discrepancy, or the caller
       * may not see the amounts. `settlementAdviceRequiresReconciliation`
       * above is the only thing that answers "is this deal stuck".
       */
      settlementAdviceDiscrepancy: null as SettlementAdviceEvidence | null,
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

    return {
      ...base,
      settlementAdviceDiscrepancy: settlementAdviceEvidence,
      money: await buildCockpitMoney(ctx, app, quote, settlementFacts),
    };
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
          //
          // Widened to any recorded advice, matching the guard on
          // `sales.update`. A mismatched advice is a question about how much the
          // supplier was paid, never about whether — and the version of this
          // check that only looked at the timestamp let a deal whose advice had
          // been rejected cancel as though the company had never paid.
          if (
            app.supplierDisbursementConfirmedAt !== undefined ||
            app.supplierDisbursedAmountMinor !== undefined
          ) {
            throw new ConvexError(
              app.supplierDisbursementStatus === "REQUIRES_RECONCILIATION"
                ? "The finance company has already paid the supplier on this deal, and the recorded advice does not agree with the approved amount. Cancelling would reverse a sale that has been funded while that disagreement is still unresolved — settle what was actually paid first, then unwind it with the company and record a manual accounting correction."
                : "The finance company has already paid the supplier on this deal. That payment is between the company and the supplier and can't be reversed from here — unwind it with them and record a manual accounting correction instead."
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
    /**
     * The economics the operator's screen was built from, as the server stamped
     * them — `economicsStamp` from the same `dealCockpit` / `get` payload the
     * confirmation was rendered against.
     *
     * WHY A STAMP AND NOT THE AMOUNT. Handover is the moment those figures
     * become permanent. Between a dialog rendering them and the operator
     * pressing confirm, another approver can legitimately record different ones
     * — the vehicle has not gone out yet, so nothing refuses them — and sealing
     * against a figure that has since moved is the exact confidence this
     * confirmation was built to create, pointed at the wrong number.
     *
     * The first attempt asked for the approved amount back and demanded it only
     * from callers who could SEE it. That was wrong in both directions, and the
     * regression tests for both directions live in `financingEconomics.test.ts`:
     *
     *   • TOO NARROW — default SALES holds neither `view:finance` nor
     *     `confirm:finance_disbursement`, so the obligation was never raised for
     *     the role most likely to hand a vehicle over. It sealed silently.
     *   • TOO BROAD — a role holding `confirm:finance_disbursement` without
     *     `view:finance_applications` was required to confirm a figure the
     *     cockpit could not display to it, dead-ending handover entirely.
     *
     * Visibility was never the right basis. Whether a caller may READ the
     * amount and whether the deal may be SEALED against figures that moved are
     * different questions, and `approvedDealerPurchaseAmountMinor` is in any
     * case a display gate rather than a confidentiality boundary — see the note
     * in `redactSettlementEvidence`. So the stamp is issued to every caller who
     * can load the deal, redacted or not, and demanded from all of them. There
     * is no predicate left to keep exhaustive across four queries.
     *
     * Compared inside the mutation's own transaction, so there is no window
     * between the check and the write.
     *
     * Optional in the VALIDATOR only so a client running a bundle from before
     * this change gets the readable refusal below instead of a raw validator
     * dump. The handler demands it unconditionally: absent is refused, exactly
     * like stale. Fail closed — a brief loud refusal during a deploy, never a
     * silent seal.
     */
    economicsStamp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REGISTER_VEHICLE_HANDOVER]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
    if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before registering handover.");
    if (app.vehicleHandoverAt) throw new ConvexError("Vehicle handover has already been registered.");
    // Deal fitness first. A deal that cannot be handed over at all is not
    // improved by being asked to confirm a figure — and the refusal that names
    // the missing funding split is the more useful one to reach the operator.
    assertDealerEconomicsRecorded(app, "handing over the vehicle");
    /**
     * The concurrency check — asked of everyone, keyed to nothing about the
     * caller. See the argument's note for why visibility was the wrong basis.
     */
    if (args.economicsStamp === undefined) {
      throw new ConvexError(
        "Confirm the handover from the deal screen so the figures you acted on can be checked. If you were already on it, reload the page and try again."
      );
    }
    if (args.economicsStamp !== economicsStamp(app)) {
      throw new ConvexError(
        "The deal's approved figures changed while you were confirming the handover. Re-check them on the deal before handing the vehicle over."
      );
    }

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
    // A date this mutation ACCEPTS but `finalizeDeal` will not.
    //
    // `v.number()` admits 0 and NaN, and 0 is what the date field produces for
    // 1970-01-01. `finalizeDeal` tests `!app.expectedPaymentDate`, so a zero
    // sails in here and then blocks the close — while THIS mutation refuses a
    // second attempt because it has already stamped
    // `expectedPaymentRegisteredAt`. With the handover recorded the approval can
    // no longer be reopened either, so the deal has no supported way forward at
    // all: the only remedy left is cancelling the application.
    //
    // Refused at the boundary rather than repaired downstream, because the
    // state is unrecoverable once written.
    if (!Number.isFinite(args.expectedDate) || args.expectedDate <= 0) {
      throw new ConvexError("Record a valid date for the expected payment.");
    }

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
      // The mirror of the check `approveDealerPurchaseAmount` makes.
      //
      // That one fires when the amount is entered on a deal already routed
      // direct; this one fires when the route is chosen on a deal already
      // approved. Either ordering reaches the same illegal state — the supplier
      // paid less than he is owed — and a guard that covers only one of them is
      // a guard with a documented way around it.
      if (app.approvedDealerPurchaseAmountMinor !== undefined) {
        const costAmount = await computeVehicleCapitalizedCost(ctx, vehicle);
        if (costAmount > 0) {
          const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
          const refusal = directSettlementBelowEntitlementRefusal({
            approvedAmountMinor: app.approvedDealerPurchaseAmountMinor,
            supplierEntitlementMinor: toMinorUnits(costAmount, currency),
            supplierName: vehicle.sourcedFromName,
          });
          if (refusal) throw new ConvexError(refusal);
        }
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

          // On the direct route the approved amount IS the settlement, so it is
          // not optional here.
          //
          // `assertDealerEconomicsRecorded` lets a deal with no recorded
          // quotation through untouched, which is right for a legacy deal
          // settling through the dealership and wrong for this one: the direct
          // route is only ever reachable with an external financier paying the
          // supplier (`setSupplierSettlementRoute` refuses otherwise), and the
          // amount they pay him is the approval. Without it `completeSale` would
          // fall back to the sale price and open a supplier debt for money that
          // never reached him — the exact defect this redesign closes, reached
          // through a legacy door. A guard whose evidence is missing refuses.
          if (
            app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER" &&
            app.approvedDealerPurchaseAmountMinor === undefined
          ) {
            throw new ConvexError(
              `On this deal the finance company pays ${vehicle?.sourcedFromName ?? "the supplier"} directly, so what it approved is the amount he actually receives — and the dealership's claim on him is measured from it. That approved purchase amount is not recorded on this deal. Record it before finalizing.`
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
          // What the finance company actually pays the supplier on this deal.
          //
          // Only on the direct route, and only from the FROZEN approval — the
          // one amount contractually committed to before any money moves. On
          // the through route the dealership collects the gross and this must
          // stay absent, or the sale would measure its margin against an amount
          // nobody paid the supplier.
          //
          // Without it, `completeSale` fell back to `quote.vehiclePrice` and
          // opened a supplier debt for `salePrice − entitlement`. Where the
          // company approved BELOW the quotation, `salePrice − approved` of that
          // debt had never reached the supplier: with a 20,000 sale, a 15,000
          // entitlement and an 18,000 approval, he was made debtor for 5,000
          // while holding 3,000 of the dealership's money. The rest is either
          // paid to the dealership directly by the customer or collected by
          // nobody — and per SCRUM-23 it is a management figure on no invoice,
          // so it may not appear in anybody's subledger.
          supplierGrossReceiptMinor:
            app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER"
              ? app.approvedDealerPurchaseAmountMinor
              : undefined,
          // Carried WITH the amount, never assumed. The approval is stored in
          // minor units of the application's pinned `economicsCurrency`, and
          // `completeSale` resolves the sale's currency from the org — which can
          // have changed since the deal was priced. Completion compares the two
          // and refuses on a mismatch instead of subtracting cents from fils.
          supplierGrossReceiptCurrency:
            app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER"
              ? (app.economicsCurrency ?? undefined)
              : undefined,
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
 *
 * It is nonetheless COMPARED, because the supplier's debt was accrued from the
 * approval and a disagreement means the dealership holds two contradictory
 * records of one payment. That is recorded as
 * `supplierDisbursementStatus: "REQUIRES_RECONCILIATION"` rather than raised as
 * an error, for two reasons:
 *
 *   - a throw rolls back the write it is reacting to, so the evidence of the
 *     discrepancy would be discarded along with the advice, leaving nothing
 *     for anyone to reconcile;
 *   - the approval is immutable after finalization by design — it is the frozen
 *     basis for the supplier claim, the agency revenue, the salesperson's
 *     commission and the reports — so refusing the advice left the operator
 *     with no legal move at all.
 *
 * Neither the approval nor the claim is touched here. If the ADVICE was
 * mistyped, `amendSupplierDisbursementAdvice` corrects it under audit. If the
 * APPROVAL itself turns out to have been wrong, that is a financial correction
 * against a closed sale — supplier claim, GL, commission and reporting must all
 * move together — and it does not happen by editing a field.
 *
 * A bank or wire fee is not a revised approval. Who bears it is a separate
 * question with its own answer; it must not be settled by quietly restating
 * what the finance company approved.
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
        // CLOSED is not the same as live: `sales.update` can cancel a completed
        // sale and nothing in that path touches the application, so it stays
        // CLOSED carrying every field this mutation writes.
        //
        // The payment is still RECORDED. What the finance company paid the
        // supplier is a fact about two other parties, true whether or not the
        // dealership's sale survived — and this mutation already records an
        // advice that contradicts the approval for exactly that reason. Refusing
        // here would leave an operator unable to write down a payment that
        // really happened, and `sales.update` refuses to cancel a sale whose
        // disbursement is already confirmed, so cancel-then-confirm is the only
        // order in which this can occur at all.
        //
        // What is suppressed is the CALL TO ACTION. The reconciliation notice
        // exists to send somebody to the cockpit to resolve a stuck deal; on a
        // cancelled one there is nothing to resolve, the cockpit renders it
        // STOPPED, and the notice would be an alarm about a deal that no longer
        // exists.
        const linkedSale = app.finalizedSaleId ? await ctx.db.get(app.finalizedSaleId) : null;
        const saleIsCancelled = linkedSale?.status === "CANCELLED";
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

        // The advice must record the amount the deal was approved at.
        //
        // The dealership's ruling is that on a financed direct deal the finance
        // company pays the supplier in exactly ONE payment, for the approved
        // amount. That makes any other figure a contradiction between two
        // records of the same fact — not a partial payment, which this route
        // does not have — and this mutation accepted any positive number, so the
        // contradiction could be stored silently and then read back as evidence.
        //
        // It matters even though the supplier claim no longer derives from this
        // field. The claim is accrued at finalization from the approval, so an
        // advice that disagrees means either the approval on file is not what
        // the company actually approved, or the money that reached the supplier
        // is not what the claim was raised against. Both need a human. Refusing
        // here is what makes the accrual VERIFIABLE rather than merely assumed —
        // the enforcement and the re-grounding are two halves of one fix, and
        // either alone leaves the debt derivable from the wrong quantity.
        //
        // Ordered AFTER the already-recorded check so a second advice is told
        // that one exists, which is the more specific and more actionable
        // answer, rather than being turned away over its amount.
        if (app.approvedDealerPurchaseAmountMinor === undefined) {
          throw new ConvexError(
            "This deal has no approved purchase amount recorded, so there is nothing to check the company's payment against. Record what it approved before confirming what it paid."
          );
        }
        const approvedAtRecordingMinor = app.approvedDealerPurchaseAmountMinor;
        const adviceAgreesWithApproval =
          args.disbursedAmountMinor === approvedAtRecordingMinor;

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
          // Recorded either way, and NOT thrown on when it disagrees. A throw
          // here would roll back the very evidence it is reacting to — the
          // dealership would be left knowing the supplier was paid and holding
          // no record that he was, which is the state that let a paid deal stay
          // cancellable. The contradiction is a fact about the deal, so it is
          // stored as one.
          supplierDisbursementStatus: adviceAgreesWithApproval
            ? ("CONFIRMED" as const)
            : ("REQUIRES_RECONCILIATION" as const),
          ...(adviceAgreesWithApproval
            ? {}
            : { supplierDisbursementApprovedAtRecordingMinor: approvedAtRecordingMinor }),
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
          description: `${payerName} paid ${supplierName} ${args.disbursedAmountMinor} minor units directly${args.reference ? ` (ref ${args.reference})` : ""}. No dealership cash moved; the dealership's margin remains a claim on ${supplierName}.${
            adviceAgreesWithApproval
              ? ""
              : ` NEEDS RECONCILIATION: the deal was approved at ${approvedAtRecordingMinor} minor units, so the advice and the approval disagree by ${Math.abs(args.disbursedAmountMinor - approvedAtRecordingMinor)}. The supplier claim was raised against the approval and has NOT been changed.`
          }`,
          before: { supplierDisbursementConfirmedAt: null },
          after: {
            supplierDisbursementConfirmedAt: confirmedAt,
            supplierDisbursedAmountMinor: args.disbursedAmountMinor,
            settlementCounterparty: payerName,
            supplierDisbursementStatus: adviceAgreesWithApproval
              ? "CONFIRMED"
              : "REQUIRES_RECONCILIATION",
            ...(adviceAgreesWithApproval
              ? {}
              : { approvedDealerPurchaseAmountMinor: approvedAtRecordingMinor }),
          },
          idempotencyKey: args.idempotencyKey,
        });

        if (saleIsCancelled) {
          // Its own exception, with its own owner.
          //
          // Suppressing the reconciliation notice was right — nothing can be
          // reconciled on a cancelled deal and the cockpit renders it STOPPED —
          // but suppression alone left a payment recorded outside any live deal
          // with nobody told about it at all. The supplier has been paid for a
          // car whose sale was reversed and which may already be back in
          // sellable inventory; that is a human problem, and it is a different
          // one from a discrepancy.
          //
          // Fires whether or not the amount agreed with the approval: the
          // exception is WHERE the money landed, not how much of it.
          await notifyByPermission(
            ctx,
            args.orgId,
            PERMISSIONS.MANAGE_FINANCE,
            "application.payment_on_cancelled_deal" as const,
            { actorName: await getActorName(ctx) },
            { link: `/${args.orgId}/applications/${args.applicationId}/deal` }
          );
        } else if (!adviceAgreesWithApproval) {
          // A discrepancy nobody is told about is a discrepancy nobody resolves.
          //
          // Its own type, because it borrowed `application.created` — whose
          // template reads "{actorName} submitted a new finance application for
          // {customerName}" and which was never given a `customerName`, so the
          // renderer substituted only what it received and shipped the
          // placeholder verbatim. Recipients were told a new application had
          // arrived for a customer called `{customerName}`, about a deal that
          // had in fact stopped. Nothing in it said reconciliation.
          //
          // Routed on the finance authority rather than `notifyManagers`, which
          // selects on `manage:users` — a permission an org can reasonably give
          // an office administrator, and one that says nothing about being
          // allowed to see deal money.
          //
          // And it carries NO amount. `dispatch` stores `data` on the row as
          // given and `notifications.list` returns rows unprojected, so the
          // disbursed figure was not merely unrendered — it was readable by
          // every recipient, which put settlement evidence the cockpit gates
          // behind `view:finance` into the hands of people selected without it.
          // The message says what happened; the figures stay on the cockpit,
          // behind the gate that already exists for them.
          await notifyByPermission(
            ctx,
            args.orgId,
            PERMISSIONS.MANAGE_FINANCE,
            "application.settlement_advice_discrepancy" as const,
            {
              actorName: await getActorName(ctx),
            },
            // The cockpit route, which is the page that renders the
            // discrepancy and carries the correction action. There is no page
            // at `/applications/{id}` and no rewrite covering it — the only
            // redirect configured is `/login` — so the shorter form 404s, which
            // on the one notification whose entire job is to get somebody to
            // the recovery path is worse than not sending it.
            { link: `/${args.orgId}/applications/${args.applicationId}/deal` }
          );
        }

        return {
          confirmedAt,
          disbursedAmountMinor: args.disbursedAmountMinor,
          status: adviceAgreesWithApproval
            ? ("CONFIRMED" as const)
            : ("REQUIRES_RECONCILIATION" as const),
        };
      }
    );
  },
});

/**
 * Corrects a settlement advice that was recorded wrongly.
 *
 * This is the ONLY thing on a finalized direct deal that may be restated, and
 * the boundary is deliberate. The advice is the dealership's transcription of a
 * document from someone else, so a mistyped cheque number or amount is an error
 * in the transcription and correcting it makes the record more true.
 *
 * The approved purchase amount is not in that category and is not touched here.
 * It is the frozen basis the supplier claim, the agency revenue, the
 * salesperson's commission and the reports were all measured from. Editing it
 * after finalization would move a number those four already depend on without
 * moving any of them, which is strictly more dangerous than leaving a deal in
 * `REQUIRES_RECONCILIATION` until a human decides what actually happened. If
 * the approval on file really was wrong, the answer is a financial correction
 * against a closed sale in which every dependent figure moves together — not
 * this mutation.
 *
 * Amending re-evaluates the advice against the approval, so a correction that
 * makes the two agree clears the flag, and one that does not leaves it standing.
 * The reconciliation state is derived from the evidence every time rather than
 * being something an operator can set.
 */
export const amendSupplierDisbursementAdvice = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** The corrected amount from the advice. */
    disbursedAmountMinor: v.number(),
    reference: v.optional(v.string()),
    /**
     * Remove the recorded reference outright.
     *
     * Separate from omitting `reference`, which means "not part of this
     * correction". Without this there is no way to say "the advice carries no
     * cheque number" — a cleared form field arrives as `undefined`, identical
     * to silence, so the wrong reference survived while the operator was told
     * the correction had been saved.
     */
    clearReference: v.optional(v.boolean()),
    disbursedAt: v.optional(v.number()),
    /**
     * Why the recorded advice was wrong. Required, and stored on the audit
     * record: an amendment with no stated cause is indistinguishable from
     * someone making the discrepancy go away.
     */
    reason: v.string(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertValidMinorAmount(args.disbursedAmountMinor, "disbursed amount");
    if (args.disbursedAmountMinor <= 0) {
      throw new ConvexError("Disbursement amount must be positive.");
    }
    const reason = args.reason.trim();
    if (reason.length < 10) {
      throw new ConvexError(
        "Say why the recorded advice was wrong. This amendment changes evidence about a payment somebody else made, and the reason is the only account of it."
      );
    }
    // Same validation as recording one: this field is operator-supplied and
    // Convex stores a NaN as a `v.number()` without complaint.
    if (args.disbursedAt !== undefined) {
      if (!Number.isSafeInteger(args.disbursedAt) || args.disbursedAt <= 0) {
        throw new ConvexError("That disbursement date is not a valid date.");
      }
      if (args.disbursedAt > Date.now()) {
        throw new ConvexError("The disbursement date cannot be in the future.");
      }
    }
    // Deliberately stricter than recording the advice. Recording is routine
    // back-office work; overwriting a record of somebody else's payment is not,
    // and MANAGE_FINANCE is the permission the default templates give to the
    // roles that answer for the deal rather than the ones that key it in.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.amendSupplierDisbursementAdvice",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          disbursedAmountMinor: args.disbursedAmountMinor,
          reference: args.reference ?? null,
          clearReference: args.clearReference ?? false,
          disbursedAt: args.disbursedAt ?? null,
          reason,
        }),
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found.");
        if (app.supplierDisbursementConfirmedAt === undefined) {
          throw new ConvexError(
            "There is no recorded settlement advice on this deal to amend. Record what the company paid the supplier first."
          );
        }
        if (app.approvedDealerPurchaseAmountMinor === undefined) {
          throw new ConvexError(
            "This deal has no approved purchase amount recorded, so there is nothing to check the corrected advice against."
          );
        }

        const previous = {
          supplierDisbursedAmountMinor: app.supplierDisbursedAmountMinor ?? null,
          supplierDisbursementReference: app.supplierDisbursementReference ?? null,
          supplierDisbursementConfirmedAt: app.supplierDisbursementConfirmedAt,
          supplierDisbursementStatus: app.supplierDisbursementStatus ?? "CONFIRMED",
        };

        const approvedAtRecordingMinor = app.approvedDealerPurchaseAmountMinor;
        const agrees = args.disbursedAmountMinor === approvedAtRecordingMinor;
        const confirmedAt = args.disbursedAt ?? app.supplierDisbursementConfirmedAt;

        // Three distinct instructions, told apart explicitly.
        //
        // Omitted means "not part of this correction", never "clear it".
        // Convex removes a field patched with `undefined`, so passing the
        // argument straight through DELETED the cheque number whenever the
        // caller did not resend it — on an amount-only correction, which is the
        // common case, and on the one path whose whole purpose is to keep the
        // evidence about somebody else's payment straight.
        //
        // But that left no way to say "this reference was never on the advice".
        // A cleared field arrived as `undefined`, indistinguishable from
        // silence, so the operator was told the correction succeeded while the
        // wrong cheque number survived — and the audit below recorded `null`,
        // asserting a removal that did not happen. On a record whose entire job
        // is to state what somebody else's document said, an audit entry that
        // contradicts the stored value is worse than the refused edit.
        const effectiveReference = args.clearReference
          ? undefined
          : (args.reference ?? app.supplierDisbursementReference);

        await ctx.db.patch(args.applicationId, {
          supplierDisbursedAmountMinor: args.disbursedAmountMinor,
          supplierDisbursementReference: effectiveReference,
          supplierDisbursementConfirmedAt: confirmedAt,
          supplierDisbursementConfirmedBy: user._id,
          supplierDisbursementStatus: agrees
            ? ("CONFIRMED" as const)
            : ("REQUIRES_RECONCILIATION" as const),
          // Cleared when it no longer applies rather than left behind, so the
          // frozen approval never outlives the discrepancy it was recording.
          supplierDisbursementApprovedAtRecordingMinor: agrees
            ? undefined
            : approvedAtRecordingMinor,
          updatedAt: Date.now(),
        });

        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "AMEND_SUPPLIER_DISBURSEMENT_ADVICE",
          resourceType: "financeApplications",
          resourceId: args.applicationId,
          description: `Settlement advice corrected to ${args.disbursedAmountMinor} minor units${args.clearReference ? " (reference removed)" : args.reference ? ` (ref ${args.reference})` : ""}. Reason: ${reason}. The approved purchase amount (${approvedAtRecordingMinor}) and the supplier claim raised against it are unchanged.`,
          before: previous,
          after: {
            supplierDisbursedAmountMinor: args.disbursedAmountMinor,
            // What was actually persisted, not what was passed in. These two
            // disagreed on exactly the case the operator cares about.
            supplierDisbursementReference: effectiveReference ?? null,
            supplierDisbursementConfirmedAt: confirmedAt,
            supplierDisbursementStatus: agrees ? "CONFIRMED" : "REQUIRES_RECONCILIATION",
          },
          idempotencyKey: args.idempotencyKey,
        });

        return {
          disbursedAmountMinor: args.disbursedAmountMinor,
          status: agrees ? ("CONFIRMED" as const) : ("REQUIRES_RECONCILIATION" as const),
        };
      }
    );
  },
});
