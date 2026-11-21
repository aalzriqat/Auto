import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { FinancialSummaryData } from "./DealFinancialOverview";
import { Money, MoneyFact } from "./DealMoneyDisplay";

export type HeadlineProfit = FinancialSummaryData["profit"];

const PROFIT_LINE_LABEL: Record<string, string> = {
  APPROVED_PURCHASE: "LineApprovedPurchase",
  /** PLANNED — `resolveAppraisalGap`'s allocation, never a receipt. The label says so. */
  CUSTOMER_PLANNED_TO_DEALER: "LineCustomerPlannedToDealer",
  SUPPLIER_SETTLEMENT: "LineSupplierSettlement",
  DEALER_CONTRIBUTION: "LineDealerContribution",
  ACTUAL_EXPENSES: "LineActualExpenses",
  FORECAST_EXPENSES: "LineForecastExpenses",
  PREPARATION_EXPENSES: "LinePreparationExpenses",
  COMMISSIONS: "DealCommissionsTotal",
  ACCOUNTING_MARGIN: "LineAccountingMargin",
  /** CASH only. A different derivation, so deliberately different keys. */
  SALE_PRICE: "LineSalePrice",
  VEHICLE_COST: "LineVehicleCost",
  SUPPLIER_ENTITLEMENT: "LineSupplierEntitlement",
};

function profitLineLabel(key: string, profit: HeadlineProfit): string {
  if (key === "COMMISSIONS" && profit.available && profit.basis === "MANAGEMENT_ESTIMATE") {
    return "DealCommissionsRegisteredToDate";
  }
  return PROFIT_LINE_LABEL[key] ?? key;
}

/**
 * Keyed by the reason itself rather than tested with a ternary, which had two
 * branches for what is now three reasons and would have labelled a missing
 * dealer contribution as a missing supplier settlement. Typed against the
 * union, so adding a fourth reason fails the build instead of silently
 * inheriting whichever branch happened to be the `else`.
 */
const PROFIT_BLOCKED_REASON: Record<
  "NoApprovedPurchaseAmount"
  | "NoSupplierSettlement"
  | "NoDealerContribution"
  /** STOCK only: the dealership's own car carries no cost basis to measure against. */
  | "NoVehicleCost"
  /** SOURCED only: the dealership's preparation spend on the supplier's car cannot be stated. */
  | "PreparationExpensesUnreadable"
  | "VehicleCostBasisUnreadable"
  | "CommissionsUnreadable"
  | "CommissionsReadBoundExceeded"
  | "CommissionsPending"
  | "CostAccessRequired"
  | "CommissionAccessRequired"
  | "ManagementNetUnavailable"
  /** A dealer-borne cost line is in another currency: the cost operand would be partial. */
  | "ExpensesMixedDenomination"
  /** A cost line's amount is not a safe non-negative integer, or the lines overflow: the cost operand is not a figure. */
  | "ExpensesUnreadable"
  /** F-PNTR-1: which recorded cost is the finance company's execution fee is unclear, or the frozen total disagrees with it. */
  | "ExecutionFeeUnclassified"
  | "CorruptInput"
  | "DealCancelled"
  /** CASH only: `dealershipMargin === null`, which is UNKNOWN and never zero. */
  | "UnknownMargin"
  /** CASH only: a draft has posted no journal, so nothing is postable yet. */
  | "SaleNotCompleted"
  /** Financed + DIRECT with no application: the recorded margin cannot be trusted. */
  | "FinancedDirectUnverified",
  string
> = {
  NoApprovedPurchaseAmount: "ProfitNeedsApprovedPurchase",
  NoSupplierSettlement: "ProfitNeedsSupplierSettlement",
  NoDealerContribution: "ProfitNeedsDealerContribution",
  NoVehicleCost: "ProfitNeedsVehicleCost",
  PreparationExpensesUnreadable: "ProfitPreparationUnreadable",
  VehicleCostBasisUnreadable: "ProfitVehicleCostBasisUnreadable",
  CommissionsUnreadable: "DealCommissionsUnreadable",
  CommissionsReadBoundExceeded: "ProfitCommissionsReadBoundExceeded",
  CommissionsPending: "ProfitCommissionsPending",
  CostAccessRequired: "ProfitCostAccessRequired",
  CommissionAccessRequired: "ProfitCommissionAccessRequired",
  ManagementNetUnavailable: "ProfitOverviewWithheld",
  ExpensesMixedDenomination: "ProfitExpensesMixedDenomination",
  ExpensesUnreadable: "ProfitExpensesUnreadable",
  ExecutionFeeUnclassified: "ProfitExecutionFeeUnclassified",
  CorruptInput: "ProfitInputCorrupt",
  DealCancelled: "ProfitDealCancelled",
  UnknownMargin: "ProfitUnknownMargin",
  SaleNotCompleted: "ProfitSaleNotCompleted",
  FinancedDirectUnverified: "ProfitFinancedDirectUnverified",
};

/** A recorded figure as the server projects it, with the denomination it served. */
type ServedEvidence = {
  approvedPurchaseAmountMinor: number | null;
  dealerContributionMinor: number | null;
  currency: { code: string; scale: number } | null;
};

type SummaryFact = {
  labelKey: string;
  value: string | null;
  /** What a null value means — only ever "never recorded" here. */
  unavailableKey: "NotRecorded";
};

/**
 * The non-party facts of the summary, each labelled for exactly what it is.
 * Pure: reads served facts, formats them, and never sums, re-scales, selects
 * between or substitutes them.
 *
 * AVAILABLE profit — ONE tile per line the server served, in the server's
 * order, labelled through `PROFIT_LINE_LABEL`. Nothing is chosen by basis, by
 * `dealKind`, or by what the other lines hold: a SOURCED vehicle's zero
 * VEHICLE_COST and its SUPPLIER_ENTITLEMENT both stand, because deciding that
 * one of them "explains" the margin is an economic classification, and this
 * screen is not the authority on any. An available profit whose `lines` are
 * EMPTY is a headline served without its working, which the caller says as
 * "breakdown unavailable" rather than inventing tiles reading "not recorded".
 *
 * UNAVAILABLE profit — there is no basis and no lines to read, so the fact-set
 * follows the server's own identity of the deal: `applicationId: null` is a
 * sale (cash or applicationless financed) and gets NO tiles at all, because the
 * sale read model serves no price or cost outside the profit and a "not
 * recorded" tile would contradict a row that has one; an application gets the
 * approved-purchase labels, filled ONLY from the two explicitly named
 * `handoverEvidence` fields the server already serves redacted and denominated
 * (a management figure withheld for want of the supplier settlement still has
 * them on record).
 */
function selectSummaryFacts({
  profit,
  applicationId,
  evidence,
  money,
  moneyIn,
}: Readonly<{
  profit: HeadlineProfit;
  applicationId: string | null;
  evidence: ServedEvidence | undefined;
  money: (minor: number) => string;
  moneyIn: (minor: number, currency: ServedEvidence["currency"]) => string | null;
}>): ReadonlyArray<SummaryFact> {
  if (!profit.available) {
    // A SALE whose profit the server withheld (a draft not yet completed, a
    // cancelled deal, an unreadable margin, a legacy financed-direct row it
    // refuses to vouch for). The read model serves no sale price or vehicle
    // cost OUTSIDE the profit, so there is nothing authoritative to put in a
    // tile — and a tile reading "Sale price: not recorded" over a pending sale
    // that has a price on its row is a false statement, not a cautious one.
    // No facts: the caller states that the breakdown is unavailable, and the
    // headline above already says why.
    if (applicationId === null) return [];
    const served = (minor: number | null | undefined) =>
      minor != null && evidence ? moneyIn(minor, evidence.currency) : null;
    return [
      {
        labelKey: "LineApprovedPurchase",
        value: served(evidence?.approvedPurchaseAmountMinor),
        unavailableKey: "NotRecorded",
      },
      {
        labelKey: "LineDealerContribution",
        value: served(evidence?.dealerContributionMinor),
        unavailableKey: "NotRecorded",
      },
    ];
  }

  // The served sign travels with the figure: a deduction reads as one in the
  // tile exactly as it does in the breakdown, so the tiles never show the
  // magnitude of a cost as if it were an inflow.
  return profit.lines.map((line) => ({
    labelKey: profitLineLabel(line.key, profit),
    value: signedMoney(line, money),
    unavailableKey: "NotRecorded",
  }));
}

/** One served line, spelled with the sign the server put on it. */
function signedMoney(
  line: Readonly<{ sign: number; amountMinor: number }>,
  money: (minor: number) => string
): string {
  return `${line.sign < 0 ? "− " : ""}${money(line.amountMinor)}`;
}

/**
 * The headline figure and its qualifier — the ONE branch this screen is not
 * allowed to get wrong.
 *
 * The headline is management net. Financing retains its settlement qualifier;
 * cash is a separate MANAGEMENT_NET derived from an unchanged accounting
 * margin. Neither management figure claims ledger reconciliation.
 *
 * Read off `basis` rather than from the presence of a `classification` field,
 * so the distinction is one the type system enforces: `AccountingProfit` has
 * no `classification` to read, and TypeScript refuses the access outside this
 * branch. That is what makes the two impossible to confuse rather than merely
 * unlikely to be.
 */
export function ProfitHeadline({
  profit,
  money,
  t,
}: Readonly<{
  profit: HeadlineProfit;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  const isLoss = profit.available && profit.amountMinor < 0;
  const isEstimatedLoss =
    profit.available &&
    profit.amountMinor < 0 &&
    profit.basis === "MANAGEMENT_ESTIMATE" &&
    profit.classification !== "ACTUAL_UNPOSTABLE";
  let label: string;
  if (isEstimatedLoss) {
    label = t("LossEstimated");
  } else if (isLoss) {
    label = t("LossActual");
  } else {
    label = t("NetDealershipProfit");
  }
  let amountTone = "";
  if (isLoss) {
    amountTone = "text-profit-negative font-bold";
  } else if (profit.available && profit.amountMinor > 0) {
    amountTone = "text-profit-positive";
  }

  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      {profit.available ? (
        <>
          <div className="flex flex-wrap items-baseline gap-3">
            <p className={`text-3xl font-semibold ${amountTone}`}>
              <Money>{money(profit.amountMinor)}</Money>
            </p>
            {/* The qualifier is not decoration. It renders from the same
                object as the amount, so there is no code path that shows one
                without the other.
                A cash deal gets NO badge here — not a green one saying
                "postable". The absence of a caveat is the normal case, and
                labelling it would train the eye to skip the badge that
                actually matters. */}
            {profit.basis === "MANAGEMENT_ESTIMATE" && (
              <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-400">
                {profit.classification === "ACTUAL_UNPOSTABLE"
                  ? t("ProfitActualUnpostable")
                  : t("ProfitEstimatedAwaitingSettlement")}
              </Badge>
            )}
          </div>
          {profit.basis !== "ACCOUNTING_RESULT" && (
            <p className="text-xs text-muted-foreground">{t("ManagementFigureNote")}</p>
          )}
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold text-muted-foreground">{t("ProfitNotCalculable")}</p>
          <p className="text-xs text-muted-foreground">{t(PROFIT_BLOCKED_REASON[profit.reason])}</p>
        </>
      )}
    </div>
  );
}

/** What `DealSummaryFacts` needs beyond the profit — the served evidence and its formatter. */
export type SummaryEvidence = Readonly<{
  /** The server's own identity of the deal: `null` is a sale, cash or applicationless financed. */
  applicationId: string | null;
  /**
   * The recorded approved amount and contribution as the SERVER projects them
   * (`handoverEvidence`): already redacted per caller, already denominated.
   * Read only when the profit is unavailable — a management figure withheld
   * for want of the supplier settlement still has these on record. Financed
   * cockpit payloads only; absent elsewhere.
   */
  evidence: ServedEvidence | undefined;
  /** Spells a served figure at the SERVED scale, or withholds it. */
  moneyIn: (minor: number, currency: ServedEvidence["currency"]) => string | null;
}>;

/**
 * The facts of the deal itself. Each figure is served, not derived, and each
 * label names the line it shows — see `selectSummaryFacts` for what is (and is
 * not) done to them, so "approved purchase amount" is never "deal value".
 */
export function DealSummaryFacts({
  profit,
  summary,
  money,
  t,
}: Readonly<{
  profit: HeadlineProfit;
  summary: SummaryEvidence;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  const facts = selectSummaryFacts({ profit, money, ...summary });
  if (facts.length === 0) {
    // A headline served without its working. Said once, here, rather than as
    // tiles claiming figures were never recorded.
    return <p className="text-sm text-muted-foreground">{t("ProfitBreakdownUnavailable")}</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {facts.map((fact) => (
        <MoneyFact
          key={fact.labelKey}
          label={t(fact.labelKey)}
          value={fact.value}
          unavailableKey={fact.unavailableKey}
          t={t}
        />
      ))}
    </div>
  );
}

/**
 * The working of the headline figure, collapsed. No disclosure over an empty
 * working: the tiles already say the breakdown is unavailable.
 */
export function ProfitBreakdown({
  profit,
  money,
  t,
}: Readonly<{
  profit: HeadlineProfit;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  if (!profit.available || profit.lines.length === 0) return null;
  return (
    <details className="group">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
        <span>{t("ProfitBreakdownToggle")}</span>
      </summary>
      {/* A working of one figure, kept as a single column — these lines are a
          SUM, and the order they are read in is part of the meaning. EVERY
          served line is listed, zeros included: a zero term is a fact the
          server chose to state, and dropping it would make the working look
          like it hides a term — which an earlier allowlist did, silently, for
          any key it had not heard of. */}
      <dl className="max-w-xl space-y-1.5 pt-2 text-sm">
        {profit.lines.map((line) => (
          <div key={line.key} className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t(profitLineLabel(line.key, profit))}</dt>
            <dd>
              <Money>{signedMoney(line, money)}</Money>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
