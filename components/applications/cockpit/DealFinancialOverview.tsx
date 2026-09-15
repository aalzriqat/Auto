"use client";

import type { api } from "@/convex/_generated/api";

/** The overview payload exactly as `dealOverview.financedDealOverview` serves it. */
export type FinancedDealOverviewData = NonNullable<
  (typeof api.dealOverview.financedDealOverview)["_returnType"]
>;
export type FinancialSummaryData = NonNullable<FinancedDealOverviewData["financialSummary"]>;
export type VehicleCostBasisData = NonNullable<FinancedDealOverviewData["vehicleCostBasis"]>;
export type DealerPreparationData = NonNullable<FinancedDealOverviewData["dealerPreparation"]>;

type Formatter = (minor: number, currency: string) => string;
type T = (key: string) => string;

/**
 * One overview fact as a ROW: the label at the start with its one quiet note
 * beneath, the served figure at the end, LTR-isolated and tabular. A row
 * rather than a tile because the money column is a third of the screen and a
 * two-column tile grid wrapped every Arabic label under its own figure. A
 * `null` figure is a dash with the reason under the label — never a zero.
 */
function Fact({
  label,
  value,
  note,
  emphasis,
  testId,
}: Readonly<{
  label: string;
  /** Already formatted; `null` renders a dash and the note says why. */
  value: string | null;
  note?: string;
  emphasis?: boolean;
  testId: string;
}>) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5" data-testid={testId}>
      <dt className={`min-w-0 text-sm ${emphasis ? "font-medium" : "text-muted-foreground"}`}>
        {label}
        {note && <span className="block text-xs font-normal text-muted-foreground">{note}</span>}
      </dt>
      <dd className="shrink-0 whitespace-nowrap">
        {value === null ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <bdi dir="ltr" className={`tabular-nums ${emphasis ? "text-base font-semibold" : "text-sm font-medium"}`}>
            {value}
          </bdi>
        )}
      </dd>
    </div>
  );
}

const BASIS_KEY: Record<NonNullable<FinancialSummaryData["customerSalePrice"]>["basis"], string> = {
  LEGAL_INVOICE: "OverviewBasisLegalInvoice",
  TARGET_SELLING_AMOUNT: "OverviewBasisTargetSelling",
  SUBMITTED_QUOTATION: "OverviewBasisSubmittedQuotation",
};

/**
 * The eight facts an operator asks of a financed deal, from the server's
 * overview — each read, none computed here. Rendered as a definition list
 * with hairline dividers rather than a grid of identical tiles, inside the
 * money card the screen already has, so the summary reads as one column of
 * figures with the profit headline above it.
 */
export function DealFinancialOverview({
  summary,
  money,
  t,
}: Readonly<{ summary: FinancialSummaryData; money: Formatter; t: T }>) {
  const cur = summary.currency;
  const m = (minor: number | null): string | null => (minor === null ? null : money(minor, cur));

  /**
   * The financier's remaining balance as its own fact, on its own authority:
   * the receivable's outstanding once one exists, the frozen economics'
   * expected remittance before that, or the reason there is none. It does not
   * depend on the funded portion being recorded — that is a different field
   * and only THAT row says "not recorded" when it is missing.
   */
  const balance = ((): { value: string | null; note: string } => {
    const o = summary.financier.outstanding;
    switch (o.state) {
      case "OUTSTANDING":
        return { value: money(o.amountMinor, cur), note: t("OverviewFinancierOutstanding") };
      case "COLLECTED":
        return { value: money(o.amountMinor, cur), note: t("OverviewFinancierCollected") };
      case "ESTIMATED_PRE_RECEIVABLE":
        return {
          value: money(o.amountMinor, cur),
          note: `${t("OverviewFinancierEstimated")} · ${t("OverviewFinancierEstimatedBasis")}`,
        };
      case "NONE_DIRECT_ROUTE":
        return { value: null, note: t("OverviewFinancierDirectRoute") };
      case "NOT_YET_RECEIVABLE":
        return { value: null, note: t("OverviewFinancierNotYetReceivable") };
      case "UNKNOWN":
        return { value: null, note: t("OverviewFinancierUnknown") };
    }
  })();

  const supplier = summary.supplier;
  const supplierValue =
    supplier.consigned === false ? money(0, cur) : supplier.amountMinor === null ? null : money(supplier.amountMinor, cur);
  const supplierNote = ((): string => {
    if (supplier.consigned === false) return t("OverviewSupplierOwned");
    const route =
      supplier.route === "DIRECT_TO_SUPPLIER"
        ? t("OverviewRouteDirect")
        : supplier.route === "THROUGH_DEALERSHIP"
          ? t("OverviewRouteThroughDealership")
          : null;
    const direction = {
      DEALERSHIP_OWES: t("OverviewSupplierOwedByDealership"),
      OWED_TO_DEALERSHIP: t("OverviewSupplierOwedToDealership"),
      SETTLED: t("OverviewSupplierSettled"),
      NOT_INVOLVED: t("OverviewSupplierSettled"),
      UNKNOWN: t("OverviewSupplierUnknown"),
    }[supplier.direction];
    return route && supplier.direction !== "UNKNOWN" ? `${direction} · ${route}` : direction;
  })();

  const outlay = summary.dealerOutlay;
  // A foreign-denominated dealer-borne line, or one whose amount cannot be
  // read, withholds the figure with its reason; otherwise the note counts
  // lines still without an actual.
  const recordedUnknownNote =
    outlay.recordedCostsReason === "UNSAFE_AMOUNT"
      ? t("OverviewCostsUnreadable")
      : t("OverviewCostsMixedDenomination");
  const recordedNote =
    outlay.recordedCostsMinor === null
      ? recordedUnknownNote
      : outlay.awaitingActuals > 0
        ? `${outlay.awaitingActuals} ${t("OverviewCostsAwaiting")}`
        : undefined;
  // Both operands known and still no sum: the addition left the safe range.
  const aggregateNote = outlay.aggregateReason === "UNSAFE_AMOUNT" ? t("OverviewAggregateUnreadable") : null;
  // Why the expected side is unknown, when it is: no policy is the common
  // case, but a foreign-currency actual or an unsafe figure withholds it too,
  // and each is a different sentence.
  const expectedUnknownNote = {
    NO_POLICY: t("OverviewNoPolicy"),
    MIXED_DENOMINATION: t("OverviewExpectedMixedDenomination"),
    UNSAFE_AMOUNT: t("OverviewExpectedUnreadable"),
  }[outlay.expectedCostsReason ?? "NO_POLICY"];

  return (
    <section aria-labelledby="deal-overview-heading" data-testid="deal-financial-overview">
      <h3 id="deal-overview-heading" className="text-xs font-normal text-muted-foreground">
        {t("OverviewHeading")}
      </h3>
      <dl className="divide-y divide-border">
        <Fact
          testId="overview-sale-price"
          label={t("OverviewCustomerSalePrice")}
          value={m(summary.customerSalePrice?.amountMinor ?? null)}
          note={summary.customerSalePrice ? t(BASIS_KEY[summary.customerSalePrice.basis]) : t("NotRecorded")}
        />
        <Fact
          testId="overview-approved-purchase"
          label={t("OverviewApprovedPurchase")}
          value={m(summary.approvedPurchaseAmountMinor)}
          note={summary.approvedPurchaseAmountMinor === null ? t("NotRecorded") : undefined}
        />
        <Fact
          testId="overview-customer-paid"
          label={t("OverviewCustomerPaid")}
          value={m(summary.customerPaidToDealer?.totalMinor ?? null)}
          note={summary.customerPaidToDealer ? t("OverviewCustomerPaidNote") : t("OverviewCustomerPaidUnknown")}
        />
        {summary.customerGapCashPlannedMinor !== null && (
          <Fact
            testId="overview-gap-cash-planned"
            label={t("OverviewGapCashPlanned")}
            value={m(summary.customerGapCashPlannedMinor)}
            note={t("OverviewGapCashPlannedNote")}
          />
        )}
        <Fact
          testId="overview-first-payment"
          label={t("OverviewCustomerFirstPayment")}
          value={m(summary.customerFirstPaymentMinor)}
          note={summary.customerFirstPaymentMinor === null ? t("NotRecorded") : undefined}
        />
        <Fact
          testId="overview-financier"
          label={t("OverviewFinancierFunds")}
          value={m(summary.financier.fundedPortionMinor)}
          note={summary.financier.fundedPortionMinor === null ? t("NotRecorded") : undefined}
        />
        <Fact
          testId="overview-financier-balance"
          label={t("OverviewFinancierBalance")}
          value={balance.value}
          note={balance.note}
        />
        <Fact
          testId="overview-dealer-contribution"
          label={t("OverviewDealerContribution")}
          value={m(outlay.plannedContributionMinor)}
          note={outlay.plannedContributionMinor === null ? t("NotRecorded") : t("OverviewDealerContributionNote")}
        />
        <Fact
          testId="overview-costs"
          label={t("OverviewCostsToDate")}
          value={m(outlay.recordedCostsMinor)}
          note={recordedNote}
        />
        <Fact
          testId="overview-known-committed"
          label={t("OverviewKnownCommitted")}
          value={m(outlay.knownCommittedMinor)}
          note={
            outlay.knownCommittedMinor !== null
              ? t("OverviewKnownCommittedNote")
              : outlay.recordedCostsMinor === null
                ? recordedUnknownNote
                : (aggregateNote ?? t("OverviewDealerPaidUnknown"))
          }
        />
        <Fact
          testId="overview-expected-remaining"
          label={t("OverviewCostsExpectedRemaining")}
          value={m(outlay.expectedCostsRemainingMinor)}
          note={outlay.expectedCostsRemainingMinor === null ? expectedUnknownNote : undefined}
        />
        <Fact
          testId="overview-dealer-paid"
          label={t("OverviewDealerPaidTotal")}
          value={m(outlay.totalExpectedMinor)}
          note={
            outlay.totalExpectedMinor !== null
              ? t("OverviewDealerPaidNote")
              : outlay.recordedCostsMinor === null
                ? recordedUnknownNote
                : outlay.knownCommittedMinor === null
                  ? (aggregateNote ?? t("OverviewDealerPaidUnknown"))
                  : outlay.expectedCostsRemainingMinor === null
                    ? expectedUnknownNote
                    : (aggregateNote ?? expectedUnknownNote)
          }
          emphasis
        />
        <Fact testId="overview-supplier" label={t("OverviewSupplierDue")} value={supplierValue} note={supplierNote} />
        <Fact
          testId="overview-net-profit"
          label={t("OverviewNetProfit")}
          value={summary.profit.available ? money(summary.profit.amountMinor, cur) : null}
          note={summary.profit.available ? undefined : t("ProfitNotCalculable")}
          emphasis
        />
      </dl>
    </section>
  );
}

/**
 * What the vehicle cost the dealership BEFORE this deal — itemized, with the
 * rule that decides what counts stated beside it, and what was seen but not
 * counted said out loud rather than silently dropped.
 */
export function VehicleCostBasisSection({
  basis,
  money,
  formatDate,
  t,
}: Readonly<{ basis: VehicleCostBasisData; money: Formatter; formatDate: (ms: number) => string; t: T }>) {
  if (!basis.available) {
    const reasonKey = {
      NO_COST_RECORDED: "CostBasisNoCost",
      MIXED_DENOMINATION: "CostBasisMixedDenomination",
      UNREADABLE_AMOUNT: "CostBasisUnreadable",
      TOO_MANY_ROWS: "CostBasisTooManyRows",
      AMBIGUOUS_OWNERSHIP_HISTORY: "CostBasisPreparationAmbiguous",
    }[basis.reason];
    return (
      <section aria-labelledby="deal-cost-basis-heading" data-testid="deal-cost-basis">
        <h3 id="deal-cost-basis-heading" className="text-xs font-normal text-muted-foreground">
          {t("CostBasisHeading")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t(reasonKey)}</p>
      </section>
    );
  }
  const cur = basis.currency;
  const excluded = [
    [basis.excluded.pendingCount, "CostBasisExcludedPending"],
    [basis.excluded.reversedCount, "CostBasisExcludedReversed"],
    [basis.excluded.periodExpenseCount, "CostBasisExcludedPeriod"],
    [basis.excluded.afterCutoffCount, "CostBasisExcludedAfter"],
  ] as const;
  const excludedText = excluded
    .filter(([count]) => count > 0)
    .map(([count, key]) => `${count} ${t(key)}`)
    .join(" · ");

  return (
    <section aria-labelledby="deal-cost-basis-heading" data-testid="deal-cost-basis" className="space-y-1">
      <h3 id="deal-cost-basis-heading" className="text-xs font-normal text-muted-foreground">
        {t("CostBasisHeading")}
      </h3>
      <dl className="divide-y divide-border text-sm">
        <div className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="min-w-0 text-muted-foreground">
            {basis.consigned ? t("CostBasisBaseConsigned") : t("CostBasisBase")}
          </dt>
          <dd className="shrink-0 whitespace-nowrap">
            <bdi dir="ltr" className="tabular-nums">{money(basis.baseMinor, cur)}</bdi>
          </dd>
        </div>
        {basis.landedCostMinor !== null && basis.landedCostMinor > 0 && (
          <div className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className="text-muted-foreground">{t("CostBasisLanded")}</dt>
            <dd className="shrink-0 whitespace-nowrap">
              <bdi dir="ltr" className="tabular-nums">{money(basis.landedCostMinor, cur)}</bdi>
            </dd>
          </div>
        )}
        <div className="py-1.5">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t("CostBasisExpenses")}</dt>
            <dd className="shrink-0 whitespace-nowrap">
              <bdi dir="ltr" className="tabular-nums">{money(basis.eligibleExpensesMinor, cur)}</bdi>
            </dd>
          </div>
          {basis.lineDetail === "WITHHELD" ? (
            <p className="text-xs text-muted-foreground" data-testid="deal-cost-basis-lines-withheld">
              {t("CostBasisLinesWithheld")}
            </p>
          ) : basis.expenses.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("CostBasisNoExpenses")}</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {basis.expenses.map((row) => (
                <li key={row.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <bdi>{row.title}</bdi> · <bdi dir="ltr">{formatDate(row.date)}</bdi>
                  </span>
                  <bdi dir="ltr" className="tabular-nums">{money(row.capitalizedMinor, cur)}</bdi>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-4 py-1.5 font-medium" data-testid="deal-cost-basis-total">
          <dt>{t("CostBasisTotal")}</dt>
          <dd className="shrink-0 whitespace-nowrap">
            <bdi dir="ltr" className="tabular-nums">{money(basis.totalBeforeDealMinor, cur)}</bdi>
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">{t("CostBasisRule")}</p>
      {excludedText && (
        <p className="text-xs text-muted-foreground" data-testid="deal-cost-basis-excluded">
          {t("CostBasisExcluded")}: {excludedText}
        </p>
      )}
    </section>
  );
}

/**
 * SOURCED only: what the dealership spent preparing the SUPPLIER's car before
 * the deal — beside the supplier's cost, never added to it, subtracted once
 * from the headline. Withheld with its reason when the evidence cannot be
 * stated; never a zero standing in for "unknown".
 */
export function DealerPreparationSection({
  preparation,
  money,
  formatDate,
  t,
}: Readonly<{ preparation: DealerPreparationData; money: Formatter; formatDate: (ms: number) => string; t: T }>) {
  if (!preparation.available) {
    const reasonKey = {
      MIXED_DENOMINATION: "CostBasisMixedDenomination",
      UNREADABLE_AMOUNT: "CostBasisUnreadable",
      TOO_MANY_ROWS: "CostBasisTooManyRows",
      AMBIGUOUS_OWNERSHIP_HISTORY: "CostBasisPreparationAmbiguous",
    }[preparation.reason];
    return (
      <section aria-labelledby="deal-preparation-heading" data-testid="deal-preparation">
        <h3 id="deal-preparation-heading" className="text-xs font-normal text-muted-foreground">
          {t("CostBasisPreparation")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t(reasonKey)}</p>
      </section>
    );
  }
  const cur = preparation.currency;
  return (
    <section aria-labelledby="deal-preparation-heading" data-testid="deal-preparation" className="space-y-1">
      <div className="flex items-baseline justify-between gap-4">
        <h3 id="deal-preparation-heading" className="text-xs font-normal text-muted-foreground">
          {t("CostBasisPreparation")}
        </h3>
        <bdi dir="ltr" className="shrink-0 whitespace-nowrap text-sm font-medium tabular-nums" data-testid="deal-preparation-total">
          {money(preparation.totalMinor, cur)}
        </bdi>
      </div>
      {preparation.lineDetail === "WITHHELD" ? (
        <p className="text-xs text-muted-foreground" data-testid="deal-preparation-lines-withheld">
          {t("CostBasisLinesWithheld")}
        </p>
      ) : preparation.expenses.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("CostBasisPreparationNone")}</p>
      ) : (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {preparation.expenses.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                <bdi>{row.title}</bdi> · <bdi dir="ltr">{formatDate(row.date)}</bdi>
              </span>
              <bdi dir="ltr" className="shrink-0 whitespace-nowrap tabular-nums">{money(row.netMinor, cur)}</bdi>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t("CostBasisPreparationNote")}</p>
    </section>
  );
}
