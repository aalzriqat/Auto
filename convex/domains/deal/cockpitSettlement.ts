import {
  supplierObligationFromRows,
  resolveFinancierLeg,
  resolveFinancierObligation,
  resolveDealRoute,
  saleMarginEvidence,
  saleSupplierEvidence,
  type MarginEvidence,
} from "../../utils/dealSettlementFigures";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import {
  financedSaleRecognitionApplies,
  dealModeOf,
} from "../../utils/financedSaleRecognition";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import {
  composeCustomerGapToDealer,
  settlementIsComplete,
  type FinancierLeg,
  type ObligationState,
  type SettlementObligations,
} from "../../utils/financingEconomics";
import {
  resolveCustomerInvoicePosition,
  toCockpitCustomerInvoice,
  type CustomerInvoicePosition,
} from "../../utils/customerInvoiceObligation";
import {
  isConsignedAgentSale,
  recordedConsignedMargin,
  recordedFinancedConsideration,
  recordedSupplierEntitlement,
  recordedSupplierGrossReceipt,
  saleIsAgentSale,
} from "../../utils/vehicleOwnership";

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
  },
): Promise<ObligationState> {
  if (opts.settlesDirect) return supplierObligationFromRows(app, opts, []);
  const payables = app.finalizedSaleId
    ? await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", app.finalizedSaleId))
        .collect()
    : [];
  return supplierObligationFromRows(app, opts, payables);
}

/**
 * SCRUM-567: the deal facts that prove no finance company pays the dealership.
 * Shared by `finalizeDeal` (write) and `resolveFinancierLeg` (read) so they
 * cannot drift. `manualPayerOf(app) === null` means "payer not known yet", never
 * "no payer", so a manual-mode application is excluded by mode, not by letter.
 */

/**
 * Whether a finance company pays the dealership on this deal (SCRUM-446).
 *
 * Invariant: `NONE` is returned only when the server can PROVE, from records
 * that cannot drift under the deal, that no finance company ever pays the
 * dealership on it:
 * - the application is CLOSED and its linked sale exists in this org, is
 *   COMPLETED and names THIS application back (`sale.applicationId`);
 * - the route is known, not cancelled and settles through the dealership;
 * - `isProvablyFinancierless` holds: no configured company, no manual finance
 *   mode, and either the mode is `INTERNAL_INSTALLMENT` or the sale's own
 *   `financingType` is `CASH` (SCRUM-567, including a mode-less application).
 *
 * Owner rulings OR-1 / OR-2 (SCRUM-486 c21360): a MANUAL finance company and a
 * LEASE company that purchases the vehicle owe the dealership the full amount
 * exactly like a configured one, so MANUAL_FINANCE_COMPANY and LEASE with no
 * `companyId` are money EXPECTED from a financier, never `NONE`. An unreadable
 * `financingType` and every other shape of missing evidence are `UNKNOWN`;
 * unknown evidence is never read as `NONE`.
 *
 * Deliberately NOT `NONE`: a configured company with a zero net (SCRUM-315), a
 * direct-to-supplier deal (the financier pays the supplier and its own stage
 * evidence applies), a cancelled or missing sale, and a pre-close application.
 *
 * Pure, and fed the sale the caller has ALREADY loaded and org-checked, so the
 * cockpit and `confirmDisbursement` cannot reach two different answers.
 */

/** What the finance company still owes. */

/**
 * The org-checked finalized sale, the vehicle, whether the sale is an agent
 * sale, and the resolved route. The ONE loader behind the cockpit and the
 * `confirmDisbursement` guard, so they cannot compute different routes.
 */
export async function loadDealRoute(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
) {
  const vehicle = await ctx.db.get(app.vehicleId);
  /**
   * ⚠️ SCRUM-42 — through the SHARED classifier once a sale exists.
   *
   * This asked `vehicle != null && isConsignedAgentSale(vehicle)`, the NARROW
   * rule. `saleEconomics` has always applied a broader one: a vehicle row that
   * is gone does not stop a sale from having been an agent sale when the sale's
   * own frozen evidence survives — a recorded consigned margin, a
   * `DIRECT_TO_SUPPLIER` route, or a valid frozen entitlement. The two disagree
   * exactly when the vehicle has been hard-deleted, which the `/admin` raw-JSON
   * editor and a partially-failed `hardDeleteOrg` both reach.
   *
   * `consigned` gates the supplier-obligation resolution below. Wrongly `false`,
   * the obligation reads as ABSENT rather than UNKNOWN — so the stage rail can
   * report the deal COMPLETE and the supplier row disappears while a real claim
   * is still open, all while the headline reports a genuine agency margin
   * because `saleEconomics` classified the same sale correctly. The screen said
   * the deal was settled and nothing was owed, over money the supplier still
   * held.
   *
   * SCRUM-29 hit the identical bug on the new CASH cockpit and fixed it there by
   * extracting `saleIsAgentSale`. The financed cockpit was deliberately left
   * alone then — pre-existing, in production, outside that PR's frozen scope.
   *
   * The vehicle still answers whenever it is present, and BEFORE a sale exists
   * it is the only evidence there is — which is why the fallback is the old test
   * rather than a guess. (`settlesDirectToSupplier` above keeps the narrow rule
   * for exactly that pre-sale case.)
   */
  const finalizedSale = app.finalizedSaleId
    ? await ctx.db.get(app.finalizedSaleId)
    : null;
  const sale =
    finalizedSale && finalizedSale.orgId === app.orgId ? finalizedSale : null;
  const consigned = sale
    ? saleIsAgentSale({
        vehicle,
        salePrice: sale.salePrice,
        recordedMargin: recordedConsignedMargin(sale),
        recordedSupplierEntitlement: recordedSupplierEntitlement(sale),
        recordedSupplierGrossReceipt: recordedSupplierGrossReceipt(sale),
        recordedConsideration: recordedFinancedConsideration(sale),
        // The FACTS, not a pre-derived boolean — see `supplierReceiptIsAdmissible`.
        supplierSettlementRoute: sale.supplierSettlementRoute,
        externallyFinanced:
          sale.financingType === "FINANCED" || sale.financingType === "LEASE",
      })
    : vehicle != null && isConsignedAgentSale(vehicle);

  const route = resolveDealRoute(app, { vehicle, consigned, sale });
  return { vehicle, sale, consigned, route };
}

export async function resolveSettlement(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
) {
  const { vehicle, sale, consigned, route } = await loadDealRoute(ctx, app);
  const { routeKnown, settlesDirect, saleCancelled } = route;

  const supplierClaim = app.finalizedSaleId
    ? (
        await ctx.db
          .query("vehicleSupplierReceivables")
          .withIndex("by_org_sale", (q) =>
            q.eq("orgId", app.orgId).eq("saleId", app.finalizedSaleId!),
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
  const margin = await saleTimeMarginMinor(ctx, app, {
    currency,
    consigned,
    supplierClaim,
  });
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
  const financierLeg = resolveFinancierLeg(
    app,
    { routeKnown, settlesDirect, saleCancelled },
    sale,
    // Only a CLOSED, company-less deal with a finalized sale can resolve NONE,
    // and only then does the mode matter (see `resolveFinancierLeg`); a CASH
    // sale proves it without the mode, so the quote read is skipped.
    app.status === "CLOSED" &&
      !app.companyId &&
      app.finalizedSaleId !== undefined &&
      sale?.financingType !== "CASH"
      ? await dealModeOf(ctx, app)
      : undefined,
  );
  const financierObligation = resolveFinancierObligation(
    app,
    settlesDirect,
    financierLeg,
  );

  // The customer's side is judged on EVERY financier leg (SCRUM-571 D-43).
  // A cancelled sale's books were reversed, so there is no invoice to describe:
  // NONE, as the cash cockpit reads it, and without touching the invoice at all.
  // Any other linked sale that is not COMPLETED (e.g. PENDING) fails closed to
  // UNKNOWN WITHOUT reading the invoice: its books are not final, so a paid
  // invoice plus a posted event cannot prove the customer is settled, and NONE
  // would count as "nothing owed" in settlementIsComplete (S2-C1). With no
  // linked sale (pre-finalization) the position is resolved as before.
  const saleCancelledForInvoice = saleCancelled || sale?.status === "CANCELLED";
  const saleNotCompleted = sale != null && sale.status !== "COMPLETED";
  const customerPosition: CustomerInvoicePosition = !routeKnown
    ? { state: "UNKNOWN", outstandingMinor: null }
    : saleCancelledForInvoice
      ? { state: "NONE", outstandingMinor: null }
      : saleNotCompleted
        ? { state: "UNKNOWN", outstandingMinor: null }
        : await resolveCustomerPosition(
            ctx,
            app,
            sale,
            currency,
            financierLeg,
            settlesDirect,
          );
  const obligations: SettlementObligations = routeKnown
    ? {
        financier: financierObligation,
        supplier: supplierObligation,
        customer: customerPosition.state,
      }
    : { financier: "UNKNOWN", supplier: "UNKNOWN", customer: "UNKNOWN" };

  return {
    vehicle,
    consigned,
    routeKnown,
    settlesDirect,
    saleCancelled,
    financierLeg,
    supplierClaim,
    /** The one resolution of the margin, so the headline cannot reach a second. */
    margin,
    /** The one resolution of what the supplier keeps, for the same reason. */
    supplierEntitlement,
    obligations,
    /** The customer-invoice debt, from the same read the customer obligation was judged on. */
    customerInvoice: toCockpitCustomerInvoice(customerPosition, currency),
    // A cancelled sale's books were reversed: whatever the obligations say, the
    // money on it is not "settled" (SCRUM-446). Without this a CLOSED application
    // over a cancelled sale read SETTLEMENT as COMPLETE.
    moneySettled: !saleCancelled && settlementIsComplete(obligations),
  };
}

/**
 * What the customer still owes on this deal (SCRUM-571 D-43), judged by the
 * shared invoice predicate. "NONE" only before finalization, when there is no
 * sale and so no invoice yet. An unreadable gap is UNKNOWN, never zero. Once the
 * deal is finalized the canonical invoice is ALWAYS judged, including on a
 * plan-covered deal whose customer gap is exactly 0: the gap is a figure on the
 * application, the invoice is what the customer actually owes, and a deal reads
 * settled only when that invoice is proven paid (a paid zero-value invoice still
 * reads CLOSED). On the legacy plan-less path the finalization transfer already
 * shrank the invoice to what the customer owes, so it is judged directly.
 */
async function resolveCustomerPosition(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  sale: Doc<"sales"> | null | undefined,
  currency: string,
  financierLeg: FinancierLeg,
  settlesDirect: boolean,
): Promise<CustomerInvoicePosition> {
  const financed = financierLeg !== "NONE";
  if (financed && !app.finalizedSaleId)
    return { state: "NONE", outstandingMinor: null };
  if (
    financed &&
    financedSaleRecognitionApplies(app, { settlesDirect }) &&
    !composeCustomerGapToDealer(app).readable
  ) {
    return { state: "UNKNOWN", outstandingMinor: null };
  }
  return resolveCustomerInvoicePosition(ctx, sale, {
    orgId: app.orgId,
    currency,
  });
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

async function saleTimeMarginMinor(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  opts: {
    currency: string;
    consigned: boolean;
    supplierClaim: Doc<"vehicleSupplierReceivables"> | undefined;
  },
): Promise<MarginEvidence> {
  const sale =
    !opts.supplierClaim && opts.consigned && app.finalizedSaleId
      ? await ctx.db.get(app.finalizedSaleId)
      : null;
  return saleMarginEvidence(sale, app, opts);
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
  opts: { currency: string; consigned: boolean },
): Promise<MarginEvidence> {
  const sale =
    opts.consigned && app.finalizedSaleId
      ? await ctx.db.get(app.finalizedSaleId)
      : null;
  return saleSupplierEvidence(sale, app, opts);
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
