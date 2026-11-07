import { summarizeFees } from "../financeDealCosts";
import { executionFeePosition, executionFeeHeadline, executionFeeUnrecorded, type ExecutionFeeHeadline } from "./executionFeePosition";
import { composeCustomerGapToDealer, deriveManagementProfit, type ManagementProfit } from "./financingEconomics";
import type { Doc } from "../_generated/dataModel";
import { manualPayerOf } from "./manualFinancePayer";
import { settlementStatusForFacts, obligationFromRow, type ObligationState } from "./financingEconomics";
import { financedSaleRecognitionApplies, type DealMode } from "./financedSaleRecognition";
import { dealershipCollectsGross, consignedSettlementRoute } from "./vehicleOwnership";
import { toMinorSameCurrencyOrUndefined } from "./money";
export type MarginEvidence = { known: true; minor: number } | { known: false };
type FinancierLeg = "NONE" | "EXPECTED" | "UNKNOWN";
export function isProvablyFinancierless(
  app: Doc<"financeApplications">,
  facts: {
    settlesDirect: boolean;
    financingType: Doc<"sales">["financingType"] | undefined;
    mode: DealMode | undefined;
  }
): boolean {
  return (
    !facts.settlesDirect &&
    !financedSaleRecognitionApplies(app, { settlesDirect: false }) &&
    (facts.mode === "INTERNAL_INSTALLMENT" || facts.financingType === "CASH")
  );
}

export function resolveFinancierLeg(
  app: Doc<"financeApplications">,
  route: { routeKnown: boolean; settlesDirect: boolean; saleCancelled: boolean },
  sale: Doc<"sales"> | null,
  mode: DealMode | undefined
): FinancierLeg {
  if (
    app.status === "CLOSED" &&
    app.finalizedSaleId !== undefined &&
    sale !== null &&
    sale.applicationId === app._id &&
    sale.status === "COMPLETED" &&
    route.routeKnown &&
    !route.saleCancelled &&
    isProvablyFinancierless(app, {
      settlesDirect: route.settlesDirect,
      financingType: sale.financingType,
      mode,
    })
  ) {
    return "NONE";
  }
  // SCRUM-27: a manual finance company whose approval letter has been entered
  // owes the full approved amount exactly like a configured one. Before the
  // letter is entered nobody knows who the payer is, so it stays UNKNOWN
  // (waiting) - never NONE.
  return app.companyId || manualPayerOf(app) ? "EXPECTED" : "UNKNOWN";
}

export function resolveFinancierObligation(
  app: Doc<"financeApplications">,
  settlesDirect: boolean,
  financierLeg: FinancierLeg = "UNKNOWN"
): ObligationState {
  // PROVEN that no finance company pays the dealership: there is no obligation
  // on this leg to be open. The supplier leg is still judged on its own.
  if (financierLeg === "NONE") return "NONE";
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

export function resolveDealRoute(
  app: Doc<"financeApplications">,
  opts: { vehicle: Doc<"vehicles"> | null; consigned: boolean; sale: Doc<"sales"> | null }
): { routeKnown: boolean; settlesDirect: boolean; saleCancelled: boolean } {
  let routeKnown = true;
  let settlesDirect = false;
  let saleCancelled = false;

  if (app.finalizedSaleId) {
    // The caller has already loaded this document and org-checked it, so it is
    // passed in rather than read a second time. `opts.sale` is null on exactly
    // the two conditions this branch used to re-derive — no such document, or a
    // document belonging to another org — which is why one guard replaces two.
    if (!opts.sale) routeKnown = false;
    else {
      saleCancelled = opts.sale.status === "CANCELLED";
      settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(opts.sale));
    }
  } else if (opts.vehicle === null) {
    routeKnown = false;
  } else {
    settlesDirect = !dealershipCollectsGross(consignedSettlementRoute(app)) && opts.consigned;
  }

  return { routeKnown, settlesDirect, saleCancelled };
}

export function resolveSupplierSettlementMinor(args: {
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

export function saleMarginEvidence(sale: Doc<"sales"> | null, app: Doc<"financeApplications">,
  opts: { currency: string; consigned: boolean; supplierClaim: Doc<"vehicleSupplierReceivables"> | undefined }): MarginEvidence {
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
export function saleSupplierEvidence(sale: Doc<"sales"> | null, app: Doc<"financeApplications">,
  opts: { currency: string; consigned: boolean }): MarginEvidence {
  if (!opts.consigned || !app.finalizedSaleId) return { known: false };

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

export function supplierObligationFromRows(app: Doc<"financeApplications">,
  opts: { settlesDirect: boolean; consigned: boolean; currency: string;
    supplierClaim: Doc<"vehicleSupplierReceivables"> | undefined; margin: MarginEvidence },
  payables: Doc<"vehicleSupplierPayables">[]): ObligationState {
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

export function cockpitFeeSummary(app: Doc<"financeApplications">, liveFees: Doc<"financeDealFees">[], currency: string) {
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
  // SCRUM-690 F-PNTR-1: the finance company's execution fee as ONE position —
  // the overview reads the same helper, so the two headlines cannot disagree.
  const executionFee = executionFeePosition(app, liveFees, currency);

  return {
    feeLines,
    executionFee: executionFeeHeadline(executionFee),
    actualExpensesMinor: sameCurrencySummary.dealerBorneActualMinor,
    feesAwaitingActuals: sameCurrencySummary.linesAwaitingActual + otherCurrencyFees,
    // RECORDED and RECONCILED are different claims: an amount somebody typed and
    // an amount somebody checked against its evidence. Only the second can close
    // a deal, so only the second may call the headline "actual".
    expensesFullyReconciled:
      otherCurrencyFees === 0 &&
      sameCurrencySummary.linesAwaitingActual === 0 &&
      sameCurrencySummary.linesAwaitingReconciliation === 0 &&
      // A fee the finance company charged and nobody has recorded is not a
      // finished cost, however reconciled the other lines are.
      !executionFeeUnrecorded(executionFee),
  };
}

export function cockpitManagementProfit(args: {
  app: Doc<"financeApplications">;
  saleCancelled: boolean;
  supplierSettlementMinor: number | undefined;
  actualExpensesMinor: number;
  executionFee: ExecutionFeeHeadline | null;
  currency: string;
  fullySettled: boolean;
}): ManagementProfit {
  const { app } = args;
  const gap = composeCustomerGapToDealer(app);
  if (!gap.readable) return { available: false, reason: "CorruptInput" };
  return deriveManagementProfit({
    dealCancelled: args.saleCancelled,
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    supplierSettlementMinor: args.supplierSettlementMinor,
    dealerContributionMinor: app.dealerContributionMinor,
    customerDirectToDealerMinor: gap.amountMinor,
    actualExpensesMinor: args.actualExpensesMinor,
    expectedExpensesMinor: app.estimatedDealerBorneExpensesMinor,
    executionFee: args.executionFee,
    currency: args.currency,
    fullySettled: args.fullySettled,
  });
}
