import type { ReactNode } from "react";
import { Receipt, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DealFinancialOverview,
  DealerPreparationSection,
  VehicleCostBasisSection,
  type FinancedDealOverviewData,
} from "./DealFinancialOverview";
import { Money, MoneyFact } from "./DealMoneyDisplay";
import {
  DealSummaryFacts,
  ProfitBreakdown,
  ProfitHeadline,
  type HeadlineProfit,
  type SummaryEvidence,
} from "./DealProfitPresentation";
import type { DealCockpitData } from "./DealStagePresentation";

const PARTY_LABEL: Record<string, string> = {
  CUSTOMER: "PartyCustomer",
  SUPPLIER: "PartySupplier",
  FINANCIER: "PartyFinancier",
};

const POSITION_LABEL: Record<string, string> = {
  DEALERSHIP_HOLDS: "PositionDealershipHolds",
  DEALERSHIP_OWES: "PositionDealershipOwes",
  OWED_TO_DEALERSHIP: "PositionOwedToDealership",
  SETTLED: "PositionSettled",
  NOT_INVOLVED: "PositionNotInvolved",
  UNKNOWN: "PositionUnknown",
};

/** What the money card hands the commissions row: the headline profit and its own formatter. */
export type DealCommissionsSlot = (args: {
  profitMinor: number | null;
  money: (minor: number) => string;
  t: (key: string) => string;
}) => ReactNode;

type DealMoney = NonNullable<DealCockpitData["money"]>;

const PARTY_FACT_LABEL: Record<string, string> = {
  CUSTOMER: "FactCustomer",
  FINANCIER: "FactFinancier",
  SUPPLIER: "FactSupplier",
};

/**
 * One tile per party the server names, with the supplier's settlement action
 * beside the claim it settles. `onSettleSupplier` is present only when the
 * SERVER would accept the command from this caller. `supplierGuidance` takes
 * the action's place when the server has said WHY it would not — a disputed
 * claim is still owed, and the tile must say what to do about it rather than
 * offer a button whose submit is refused.
 */
function DealPartyFacts({
  parties,
  onSettleSupplier,
  supplierGuidance,
  money,
  t,
}: Readonly<{
  parties: DealMoney["parties"];
  onSettleSupplier: (() => void) | undefined;
  supplierGuidance: string | undefined;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
      {parties.map((party) => {
        const positioned =
          party.position !== "NOT_INVOLVED" && party.position !== "UNKNOWN";
        let settlement: ReactNode;
        if (party.party === "SUPPLIER") {
          if (onSettleSupplier) {
            settlement = (
              <Button size="sm" className="h-9" onClick={onSettleSupplier}>
                {t("SettleSupplierAction")}
              </Button>
            );
          } else if (supplierGuidance) {
            settlement = (
              <p role="status" className="text-xs text-muted-foreground">
                {supplierGuidance}
              </p>
            );
          }
        }

        return (
          <MoneyFact
            key={party.party}
            label={t(
              PARTY_FACT_LABEL[party.party] ??
                PARTY_LABEL[party.party] ??
                party.party,
            )}
            value={
              positioned && party.amountMinor !== null
                ? money(party.amountMinor)
                : null
            }
            unavailableKey={
              party.amountMinor === null ? "CostAmountWithheld" : "NotRecorded"
            }
            note={
              <>
                <span>
                  {t(POSITION_LABEL[party.position] ?? party.position)}
                </span>
                {party.name && (
                  <>
                    {" · "}
                    <bdi>{party.name}</bdi>
                  </>
                )}
                {party.reference && (
                  <>
                    {" · "}
                    <bdi>{party.reference}</bdi>
                  </>
                )}
              </>
            }
            action={settlement}
            t={t}
          />
        );
      })}
    </div>
  );
}

/** The note under the invoice balance: an OPEN invoice is owed, a CLOSED one is settled; unproven states say nothing. */
const INVOICE_NOTE_KEY: Record<string, string | undefined> = {
  OPEN: POSITION_LABEL.OWED_TO_DEALERSHIP,
  CLOSED: POSITION_LABEL.SETTLED,
};

/**
 * SCRUM-571 (D-48): what the customer still owes on the deal's invoice, as its own
 * tile and NOT a party row. The CUSTOMER party row states the held deposit; this
 * is the invoice debt the settlement stage is waiting on, so the two never share
 * a figure. Served, not derived: the state and the amount come from the same
 * server read the stage was judged on. Nothing is shown before an invoice exists
 * (`NONE`), and an unproven invoice states no amount rather than a zero.
 */
function CustomerInvoiceFact({
  invoice,
  money,
  t,
}: Readonly<{
  /** Optional at runtime: a payload from a backend that predates the field renders no tile. */
  invoice: DealMoney["customerInvoice"] | undefined;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  if (!invoice || invoice.state === "NONE") return null;
  const noteKey = INVOICE_NOTE_KEY[invoice.state];
  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2"
      data-testid="deal-customer-invoice"
    >
      <MoneyFact
        label={t("CustomerInvoiceBalance")}
        value={
          invoice.outstandingMinor !== null
            ? money(invoice.outstandingMinor)
            : null
        }
        unavailableKey="CustomerInvoiceUnproven"
        note={noteKey ? t(noteKey) : undefined}
        t={t}
      />
    </div>
  );
}

/**
 * Only where an APPLICATION exists. `فرق تخمين` is the difference between the
 * finance company's appraisal and the price — a cash deal has no appraisal, so
 * "no appraisal gap" would be answering a question nobody asked. The caller
 * decides presence; this only spells the served figure.
 */
function AppraisalGapNote({
  amountMinor,
  unavailable,
  money,
  t,
}: Readonly<{
  amountMinor: number | undefined;
  /** The shortfall could not be measured: say so, never "None" (SCRUM-766). */
  unavailable: boolean;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  let value: ReactNode = t("NoAppraisalGap");
  if (unavailable) value = t("AppraisalGapUnavailable");
  else if (amountMinor !== undefined && amountMinor > 0)
    value = <Money>{money(amountMinor)}</Money>;
  return (
    <p className="text-xs text-muted-foreground">
      {t("AppraisalGapLabel")}: {value}
    </p>
  );
}

/**
 * The money card: headline, the served deal facts, the parties and the working,
 * each its own component above. This only composes them in reading order.
 */
export function DealMoneyPanel({
  money,
  profit,
  summary,
  parties,
  overview,
  customerInvoice,
  renderCommissions,
  t,
}: Readonly<{
  money: (minor: number) => string;
  /** The employee commissions row, supplied by the container that holds the permissions. */
  renderCommissions?: DealCommissionsSlot;
  profit: HeadlineProfit;
  summary: SummaryEvidence;
  /**
   * The server's overview, rendered between the headline and the served
   * lines when present. Financed deals only; a cash deal has no overview and
   * the panel is unchanged without one.
   */
  overview?: {
    data: FinancedDealOverviewData | null | undefined;
    loading: boolean;
    moneyIn: (minor: number, currency: string) => string;
    formatDate: (ms: number) => string;
  };
  /**
   * The party row, or `null` when there is nobody to list — an OWNED cash sale
   * has no third party at all, so the row would be a heading over nothing.
   * `appraisalGap` is `null` on a deal with no application, which has no
   * appraisal to have a gap in.
   */
  parties: Readonly<{
    items: DealMoney["parties"];
    appraisalGap: Readonly<{
      amountMinor: number | undefined;
      unavailable: boolean;
    }> | null;
    onSettleSupplier: (() => void) | undefined;
    supplierGuidance: string | undefined;
  }> | null;
  /** The customer's invoice debt (SCRUM-571 D-48), separate from the deposit on the party row. */
  customerInvoice: DealMoney["customerInvoice"];
  t: (key: string) => string;
}>) {
  /**
   * ONE profit authority per screen.
   *
   * On a financed deal the overview read model serves the route-aware
   * headline (consignment economics less preparation spend on a SOURCED car;
   * cost-basis economics on the dealership's own STOCK), derived on the
   * server from the same snapshot as every other overview figure. The
   * cockpit's own `money.profit` is the consignment-only derivation, which on
   * a STOCK deal reads "no supplier settlement" — so painting it as the
   * headline beside the overview's figure put two contradictory profits on one
   * card. Here the overview's profit drives the headline, the fact tiles and
   * the breakdown alike, and while the overview is still loading nothing is
   * painted from the legacy figure in its place. A cash deal has no overview
   * and reads the separate management net the sale cockpit serves.
   */
  let canonicalProfit: HeadlineProfit | "LOADING" | "WITHHELD" = profit;
  if (overview) {
    canonicalProfit = overview.loading
      ? "LOADING"
      : (overview.data?.financialSummary?.profit ?? "WITHHELD");
  }

  let headline: ReactNode;
  if (canonicalProfit === "LOADING") {
    headline = (
      <div className="space-y-2" data-testid="deal-financial-overview-loading">
        <p className="text-sm text-muted-foreground">
          {t("NetDealershipProfit")}
        </p>
        <Skeleton className="h-9 w-40" />
        <p className="text-xs text-muted-foreground">{t("OverviewLoading")}</p>
      </div>
    );
  } else if (canonicalProfit === "WITHHELD") {
    // The legacy consignment figure cannot fill in for an unreadable overview.
    // It uses a different derivation and would contradict the server's refusal.
    headline = (
      <div className="space-y-1" data-testid="deal-financial-overview-withheld">
        <p className="text-sm text-muted-foreground">
          {t("NetDealershipProfit")}
        </p>
        <p className="text-2xl font-semibold text-muted-foreground">
          {t("ProfitNotCalculable")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("ProfitOverviewWithheld")}
        </p>
      </div>
    );
  } else {
    headline = <ProfitHeadline profit={canonicalProfit} money={money} t={t} />;
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          {t("FinancialSummaryHeading")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {headline}
        {renderCommissions?.({
          profitMinor:
            typeof canonicalProfit !== "string" &&
            canonicalProfit.available &&
            canonicalProfit.lines.some((line) => line.key === "COMMISSIONS")
              ? canonicalProfit.amountMinor
              : null,
          money,
          t,
        })}
        {overview && !overview.loading && overview.data?.financialSummary && (
          <DealFinancialOverview
            summary={overview.data.financialSummary}
            money={overview.moneyIn}
            t={t}
          />
        )}
        {/* One fact per served line of the deal itself, then one per party the server names. */}
        {typeof canonicalProfit !== "string" &&
          !overview?.data?.financialSummary && (
            <DealSummaryFacts
              profit={canonicalProfit}
              summary={summary}
              money={money}
              t={t}
            />
          )}
        {parties && (
          <div className="space-y-2">
            <h3 className="text-xs font-normal text-muted-foreground">
              {t("DealPartiesHeading")}
            </h3>
            <DealPartyFacts
              parties={parties.items}
              onSettleSupplier={parties.onSettleSupplier}
              supplierGuidance={parties.supplierGuidance}
              money={money}
              t={t}
            />
            {parties.appraisalGap && (
              <AppraisalGapNote
                amountMinor={parties.appraisalGap.amountMinor}
                unavailable={parties.appraisalGap.unavailable}
                money={money}
                t={t}
              />
            )}
          </div>
        )}
        <CustomerInvoiceFact invoice={customerInvoice} money={money} t={t} />
        {typeof canonicalProfit !== "string" && (
          <ProfitBreakdown profit={canonicalProfit} money={money} t={t} />
        )}
        {overview?.data?.vehicleCostBasis && (
          <VehicleCostBasisSection
            basis={overview.data.vehicleCostBasis}
            money={overview.moneyIn}
            formatDate={overview.formatDate}
            t={t}
          />
        )}
        {overview?.data?.dealerPreparation && (
          <DealerPreparationSection
            preparation={overview.data.dealerPreparation}
            money={overview.moneyIn}
            formatDate={overview.formatDate}
            t={t}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function DealActualExpenses({
  expenses,
  money,
  t,
}: Readonly<{
  expenses: DealMoney["expenses"];
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4 shrink-0 text-money-out" aria-hidden />
          {t("ActualExpensesHeading")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {expenses.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("NoExpensesRecorded")}
          </p>
        ) : (
          expenses.lines.map((fee) => (
            <div
              key={fee.id}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <span className="text-muted-foreground">
                <bdi>{fee.description || fee.feeType}</bdi>
              </span>
              <span>
                {fee.actualAmountMinor === undefined ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Money>{money(fee.actualAmountMinor)}</Money>
                )}
              </span>
            </div>
          ))
        )}
        <Separator />
        <div className="flex items-center justify-between gap-4 font-medium">
          <span>{t("ActualExpensesHeading")}</span>
          <Money>{money(expenses.actualTotalMinor)}</Money>
        </div>
        {expenses.awaitingActuals > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <bdi>{expenses.awaitingActuals}</bdi> {t("ExpensesAwaitingActuals")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
