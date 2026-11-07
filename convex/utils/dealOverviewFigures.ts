import type { Doc } from "../_generated/dataModel";
import { deriveExpectedFees, summarizeFees, unreadableFeeAmounts, type ExpectedFeeRow } from "../financeDealCosts";
import { unrecordedConfiguredFeePositions } from "./settlementDeductions";
import { composeCustomerGapToDealer, deriveStockManagementProfit, isMinorAmount, type ManagementProfit, type AccountingProfit } from "./financingEconomics";
import { deriveDealFinancialSummary, type DealFinancialSummary, type DealFinancialSummaryInputs, type RecordedCostsReason } from "./dealFinancialSummary";
import { type DealerPreparationExpenses, type VehicleCostBasis } from "./vehicleCostBasis";
import { toMinorUnits } from "./money";
import { deriveDealManagementCosts, type ProfitCommissions } from "./dealManagementNet";
import { executionFeeHeadline, executionFeePosition, executionFeeUnrecorded, type ExecutionFeeHeadline } from "./executionFeePosition";

export type OverviewMoney = Pick<DealFinancialSummaryInputs, "currency" | "routeKnown" | "settlesDirectToSupplier" | "parties"> & {
  expenses: { actualTotalMinor: number; awaitingActuals: number };
  profit: ManagementProfit | AccountingProfit;
};
function frozenMajorAmountToMinorOrUnreadable(amount: number, currency: string): number {
  try {
    return toMinorUnits(amount, currency);
  } catch {
    return Number.NaN;
  }
}

export function frozenExecutionFeeActualMinor(
  fees: ReadonlyArray<Doc<"financeDealFees">>,
  dealCurrency: string
): number {
  let total = 0;
  for (const fee of fees) {
    if (
      fee.voidedAt !== undefined ||
      fee.feeType !== "FINANCE_COMPANY_FEE" ||
      (fee.paidBy !== "DEALER" && fee.paidBy !== "EMPLOYEE") ||
      fee.currency !== dealCurrency ||
      fee.actualAmountMinor === undefined
    ) {
      continue;
    }
    if (!isMinorAmount(fee.actualAmountMinor)) return Number.NaN;
    total += fee.actualAmountMinor;
    if (!Number.isSafeInteger(total)) return Number.NaN;
  }
  return total;
}

export function dealerBorneExpected(
  source: ReturnType<typeof deriveExpectedFees>["source"],
  rows: ReadonlyArray<ExpectedFeeRow>,
  /** The deal's denomination; a matched actual in any other is refused, never netted. */
  dealCurrency: string,
  /**
   * Whether ANY live dealer-borne line — matched to a template or not — is
   * denominated otherwise (`dealerBorneLinesMixed`). The rows above see only
   * the configured positions; an unplanned foreign line is invisible to them
   * and would leave this figure standing beside a recorded total that had
   * silently dropped it.
   */
  dealerBorneLineForeign = false,
  estimatedDealerBorneExpensesMinor?: number,
  dealerBorneActualMinor = 0
): DealFinancialSummaryInputs["expectedDealerBorne"] {
  // If the application carries a frozen expected fee total (Execution Fees / adminFees):
  if (estimatedDealerBorneExpensesMinor !== undefined) {
    if (dealerBorneLineForeign) {
      return { totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" };
    }
    if (!isMinorAmount(estimatedDealerBorneExpensesMinor) || !isMinorAmount(dealerBorneActualMinor)) {
      return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
    }
    const totalMinor = estimatedDealerBorneExpensesMinor;
    const remainingMinor = Math.max(0, totalMinor - dealerBorneActualMinor);
    if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(remainingMinor)) {
      return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
    }
    return { totalMinor, remainingMinor, reason: null };
  }

  if (source !== "COMPANY_RULE_SNAPSHOT") return { totalMinor: null, remainingMinor: null, reason: "NO_POLICY" };
  const dealerRows = rows.filter((row) => row.paidBy === "DEALER" || row.paidBy === "EMPLOYEE");
  // FAIL CLOSED: an actual recorded in another currency cannot be subtracted
  // from an expectation in this one, and a template estimate the checklist
  // already withheld (`expectedAmountMinor === null`), or one that reaches
  // here unreadable anyway, or an actual that is not a readable figure, is
  // not an operand.
  if (dealerBorneLineForeign || dealerRows.some((row) => row.actual !== null && row.actual.currency !== dealCurrency)) {
    return { totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" };
  }
  const readable: Array<{ expectedAmountMinor: number; actualAmountMinor: number | undefined }> = [];
  for (const row of dealerRows) {
    const actualAmountMinor = row.actual?.actualAmountMinor;
    if (
      row.expectedAmountMinor === null ||
      !isMinorAmount(row.expectedAmountMinor) ||
      (actualAmountMinor !== undefined && !isMinorAmount(actualAmountMinor))
    ) {
      return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
    }
    readable.push({ expectedAmountMinor: row.expectedAmountMinor, actualAmountMinor });
  }
  const totalMinor = readable.reduce((sum, row) => sum + row.expectedAmountMinor, 0);
  const remainingMinor = readable.reduce(
    (sum, row) => sum + Math.max(0, row.expectedAmountMinor - (row.actualAmountMinor ?? 0)),
    0
  );
  if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(remainingMinor)) {
    return { totalMinor: null, remainingMinor: null, reason: "UNSAFE_AMOUNT" };
  }
  return { totalMinor, remainingMinor, reason: null };
}

export function dealerBorneLinesMixed(
  fees: ReadonlyArray<Pick<Doc<"financeDealFees">, "paidBy" | "currency" | "voidedAt">>,
  dealCurrency: string
): boolean {
  return fees.some(
    (fee) =>
      fee.voidedAt === undefined &&
      (fee.paidBy === "DEALER" || fee.paidBy === "EMPLOYEE") &&
      fee.currency !== dealCurrency
  );
}

function routeSpecificProfit(args: {
  app: Doc<"financeApplications">;
  consigned: boolean | null;
  money: OverviewMoney;
  /** The vehicle's WHOLE book value (no cutoff), or why it cannot be stated. */
  fullCostBasis: VehicleCostBasis | null;
  expectedExpensesMinor?: number;
  /** F-PNTR-1: the execution-fee operand, the same one the cockpit's SOURCED figure uses. */
  executionFee: ExecutionFeeHeadline | null;
  /**
   * The cockpit's own "fully settled" — money settled AND every cost line
   * carrying a CHECKED actual — as `buildCockpitMoney` classifies a
   * consignment figure. A STOCK figure is called actual on the same terms.
   */
  fullySettled: boolean;
  /** A dealer-borne line in another currency: the expense operand is partial, so no figure is stated. */
  expensesMixed: boolean;
  /** A live line's amount is not a safe non-negative integer, or the lines overflow: the expense operand is corrupt. */
  expensesUnreadable: boolean;
}): ManagementProfit | AccountingProfit {
  const { app, money } = args;
  // Refused before either route: both derive against `actualExpensesMinor`,
  // and on a mixed deal that figure is missing a cost the dealership bore.
  // A profit computed over a partial cost is an overstatement with a reason
  // nobody would see; this one names it. An unreadable line is the same
  // refusal for the other failure: the cockpit's total was accumulated
  // unchecked, and NaN slips past the consignment builder's `< 0` guard.
  if (args.expensesMixed) return { available: false, reason: "ExpensesMixedDenomination" };
  if (args.expensesUnreadable) return { available: false, reason: "ExpensesUnreadable" };
  if (args.consigned === null) return money.profit;
  if (args.consigned) {
    return money.profit;
  }

  const vehicleCostMinor =
    args.fullCostBasis !== null && args.fullCostBasis.available && !args.fullCostBasis.consigned
      ? args.fullCostBasis.totalBeforeDealMinor
      : undefined;
  // Cancellation first, as the derivers themselves order it: a cancelled
  // deal has no profit whatever its inputs look like. Then the gap
  // contribution, composed at the shared boundary with each component
  // validated BEFORE the addition — added inline, a corrupt pair cancelled
  // into a safe operand.
  // A cancelled LINKED SALE cancels the deal too: `sales.update` reverses the
  // journal and the supplier claim while the finance application keeps its own
  // status (often CLOSED), so `app.status` alone let this branch state an
  // estimate for a deal whose books were reversed. The cockpit already resolved
  // that from the sale (`money.profit`), so it is honoured here rather than
  // re-read (SCRUM-446).
  const dealCancelled =
    app.status === "CANCELLED" ||
    (!money.profit.available && money.profit.reason === "DealCancelled");
  if (dealCancelled) return { available: false, reason: "DealCancelled" };
  const customerGapToDealer = composeCustomerGapToDealer(app);
  if (!customerGapToDealer.readable) return { available: false, reason: "CorruptInput" };
  return deriveStockManagementProfit({
    dealCancelled,
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    vehicleCostMinor,
    dealerContributionMinor: app.dealerContributionMinor,
    customerDirectToDealerMinor: customerGapToDealer.amountMinor,
    actualExpensesMinor: money.expenses.actualTotalMinor,
    expectedExpensesMinor: args.expectedExpensesMinor,
    executionFee: args.executionFee,
    currency: money.currency,
    fullySettled: args.fullySettled,
  });
}
function recordedExpenseReason(mixed: boolean, unreadable: boolean): RecordedCostsReason | null {
  if (mixed) return "MIXED_DENOMINATION";
  return unreadable ? "UNSAFE_AMOUNT" : null;
}

function feeEvidenceReason(unreadable: boolean, mixed: boolean): RecordedCostsReason | null {
  if (unreadable) return "UNSAFE_AMOUNT";
  return mixed ? "MIXED_DENOMINATION" : null;
}

function boundExecutionActual(
  position: ReturnType<typeof executionFeePosition>,
  frozenEstimatedFees: number | undefined,
  fees: Doc<"financeDealFees">[],
  currency: string
): number {
  if (!position.applies) return frozenExecutionFeeActualMinor(fees, currency);
  if (position.bound === null) return 0;
  return frozenEstimatedFees ?? 0;
}

/** Pure extraction of the financed deal page's figure derivation (SCRUM-928). */
export function deriveFinancedOverviewFigures(args: {
  app: Doc<"financeApplications">;
  money: OverviewMoney;
  consigned: boolean | null;
  moneySettled: boolean;
  fees: Doc<"financeDealFees">[];
  commissions: ProfitCommissions;
  preparation: DealerPreparationExpenses | null;
  fullCostBasis: VehicleCostBasis | null;
  mayReadCost: boolean;
}): { summary: DealFinancialSummary; profitBeforeCommissions: DealFinancialSummary["profit"] } {
  const { app, money, consigned, moneySettled, fees, commissions, preparation, fullCostBasis, mayReadCost } = args;
  // The readable-total contract over EVERY live line: a NaN, fractional,
  // negative or unsafe amount, or lines that overflow, make the cockpit's
  // unchecked total a non-figure. It is then served nowhere — not as the
  // checklist's actual, not as the recorded outlay, not inside a profit.
  const expensesUnreadable = unreadableFeeAmounts(fees) !== null;
  const expected = deriveExpectedFees({
    snapshot: app.companyRuleSnapshot,
    fees,
    currency: money.currency,
    actualTotalMinor: expensesUnreadable ? null : money.expenses.actualTotalMinor,
  });
  
  /**
   * "Fully settled" on the cockpit's own terms, so a STOCK headline is
   * called ACTUAL exactly when a consignment one would be. Money settled
   * is the SETTLEMENT stage, which the cockpit derives from
   * `settlementFacts.moneySettled`; the expense half is FULL
   * reconciliation in the closure's own sense: `summarizeFees.fullyReconciled`
   * (at least one live line, none awaiting an actual, none awaiting a
   * checked reconciliation), every live line in the deal's currency, and
   * — per `settlementDeductions` — no configured fee position still
   * without a recorded actual. A deal with no cost lines at all, or with a
   * configured fee nobody has recorded, has not finished its costs and is
   * never called ACTUAL. RECORDED and RECONCILED are different claims.
   */

  const sameCurrencyFees = fees.filter((fee) => fee.currency === money.currency);
  const feeSummary = summarizeFees(sameCurrencyFees);
  // F-PNTR-1: the single execution-fee position, bound by line id — the
  // same verdict the cockpit and the finalization gate read.
  const executionFee = executionFeePosition(app, fees, money.currency);
  const expensesFullyReconciled =
    sameCurrencyFees.length === fees.length &&
    feeSummary.fullyReconciled &&
    unrecordedConfiguredFeePositions(app.companyRuleSnapshot, fees).length === 0 &&
    !executionFeeUnrecorded(executionFee);
  const fullySettled = moneySettled && expensesFullyReconciled;
  // Every live line, template or unplanned: a dealer-borne one in another
  // currency withholds the recorded, committed and expected outlay and the
  // profit built on them, with the reason — never a partial JOD total.
  const expensesMixed = dealerBorneLinesMixed(fees, money.currency);
  const expensesReason = recordedExpenseReason(expensesMixed, expensesUnreadable);
  // The estimate's evidence is EVERY live line, whoever pays it: the
  // financier's withholdings are settlement-deducted fees of any payer.
  // The same two verdicts, unreadable first (a corrupt amount is not a
  // figure in any currency), then denomination across all live lines.
  const feeEvidence: DealFinancialSummaryInputs["feeEvidence"] = {
    reason: feeEvidenceReason(expensesUnreadable, sameCurrencyFees.length !== fees.length),
  };
  const frozenEstimatedFees =
    app.estimatedDealerBorneExpensesMinor ??
    (app.companyRuleSnapshot?.adminFees !== undefined
      ? frozenMajorAmountToMinorOrUnreadable(
          app.companyRuleSnapshot.adminFees,
          money.currency
        )
      : undefined);
  const feeHeadline = executionFeeHeadline(executionFee);
  // Codex F2: when the frozen aggregate disagrees with the fee, or which
  // cost is the fee is ambiguous, the outlay built on that aggregate is
  // withheld with the estimate — neither the whole aggregate as remaining
  // nor 0 once the fee is linked while the difference is still
  // unclassified. Otherwise a readable frozen aggregate states the outlay
  // even when an individual fee amount is unreadable.
  const expectedDealerBorne: DealFinancialSummaryInputs["expectedDealerBorne"] =
    executionFee.applies && (executionFee.aggregateConflict || executionFee.ambiguous)
    ? { totalMinor: null, remainingMinor: null, reason: "EXECUTION_FEE_UNCLASSIFIED" }
    : dealerBorneExpected(
    expected.source,
    expected.rows,
    money.currency,
    expensesMixed,
    frozenEstimatedFees,
    // With a position, only the BOUND line retires the expectation (an
    // explicit 0 included); an unbound finance-company fee no longer
    // consumes it by type and payer (c22119 Q2/Q4).
    boundExecutionActual(executionFee, frozenEstimatedFees, fees, money.currency)
  );
  const management = mayReadCost ? deriveDealManagementCosts({
    showroomExpenses: preparation ?? { available: false }, commissions,
    profit: routeSpecificProfit({
      app, consigned, money, fullCostBasis,
      expectedExpensesMinor: expectedDealerBorne.totalMinor ?? undefined,
      executionFee: feeHeadline, fullySettled, expensesMixed,
      expensesUnreadable: expensesUnreadable ||
        (frozenEstimatedFees !== undefined && expectedDealerBorne.reason === "UNSAFE_AMOUNT"),
    }),
  }) : {
    profit: { available: false as const, reason: "CostAccessRequired" as const },
    profitBeforeCommissions: { available: false as const, reason: "CostAccessRequired" as const },
  };
  const summary = deriveDealFinancialSummary({
    currency: money.currency,
    routeKnown: money.routeKnown,
    settlesDirectToSupplier: money.settlesDirectToSupplier,
    parties: money.parties,
    expenses:
      expensesReason !== null
        ? { actualTotalMinor: null, awaitingActuals: money.expenses.awaitingActuals, reason: expensesReason }
        : { ...money.expenses, reason: null },
    profit: management.profit,
    vehicleConsigned: consigned,
    app: {
      ...app,
      dealerContributionSettlement:
        app.dealerContributionSettlement ?? app.companyRuleSnapshot?.dealerContributionSettlement,
    },
    expectedDealerBorne,
    feeEvidence,
  });
  return { summary, profitBeforeCommissions: management.profitBeforeCommissions };
}
