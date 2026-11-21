import type { ComponentProps } from "react";
import { AlertTriangle, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { DealActualExpenses, DealMoneyPanel } from "./DealMoneyPanel";
import type { DealCockpitData } from "./DealStagePresentation";
import type { HeadlineProfit } from "./DealProfitPresentation";
import type { HandoverEvidence } from "./ConfirmHandoverDialog";

type MoneyPanelProps = ComponentProps<typeof DealMoneyPanel>;

export function DealMoneyRecord({
  deal,
  denominationUnusable,
  handoverEvidence,
  hasHandoverCosts,
  money,
  summaryMoney,
  overview,
  onSettleSupplier,
  supplierGuidance,
  renderCommissions,
  t,
}: Pick<MoneyPanelProps, "money" | "overview" | "renderCommissions" | "t"> &
  Readonly<{
    deal: Pick<DealCockpitData, "money" | "customerInvoiceState" | "applicationId" | "dealKind">;
    denominationUnusable: boolean;
    handoverEvidence: HandoverEvidence | null | undefined;
    hasHandoverCosts: boolean;
    summaryMoney: MoneyPanelProps["summary"]["moneyIn"];
    onSettleSupplier: (() => void) | undefined;
    supplierGuidance: string | undefined;
  }>) {
  // An older backend's accounting margin is not a management net headline.
  const cashHeadline: HeadlineProfit = deal.money && "managementNetProfit" in deal.money
    ? deal.money.managementNetProfit
    : { available: false, reason: "ManagementNetUnavailable" };

  return (
    <div data-testid="deal-money" className="space-y-6">
      {/* --- money ---------------------------------------------------- */}
      {/* Withheld before anything is spelled, because a figure in an
          unverifiable denomination is worse than no figure: the operator
          cannot tell it is wrong. Placed ahead of the permission case so a
          caller who CAN see the money is told why it is absent, rather than
          being shown amounts scaled by a guess. */}
      {denominationUnusable ? (
        <Card className="border-destructive/40">
          <CardContent className="space-y-2 py-8 text-sm">
            <p className="font-medium text-destructive">{t("EconomicsCurrencyUnusable")}</p>
            <p className="text-muted-foreground">{t("EconomicsCurrencyUnusableHint")}</p>
          </CardContent>
        </Card>
      ) : deal.money === null ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" />
            {t("MoneyPanelHidden")}
            {/* SCRUM-571 (D-48): the QUALITATIVE state only. The amount is
                finance-tier and was never sent to this caller. */}
            {deal.customerInvoiceState === "OPEN" && (
              <span data-testid="deal-customer-invoice-state">
                {" · "}
                {t("CustomerInvoiceStateOpen")}
              </span>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {!deal.money.routeKnown && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("RouteUnknownWarning")}</span>
            </div>
          )}

          {/* The six facts and, under them, the parties — ABSENT when
              there is nobody to list. An OWNED cash sale has no third
              party at all, so the row would be a heading over nothing.
              The appraisal gap is gated on the DATA rather than on
              `dealKind`, because a financed SALE opened on the sale-keyed
              route is `dealKind: "FINANCED"` and still has no appraisal
              payload. */}
          <DealMoneyPanel
            money={money}
            profit={deal.applicationId === null ? cashHeadline : deal.money.profit}
            summary={{
              applicationId: deal.applicationId,
              evidence: handoverEvidence ?? undefined,
              moneyIn: summaryMoney,
            }}
            overview={overview}
            parties={
              deal.money.parties.length > 0 || deal.applicationId !== null
                ? {
                    items: deal.money.parties,
                    appraisalGap:
                      deal.applicationId !== null
                        ? {
                            amountMinor: deal.money.shortfall?.totalMinor,
                            unavailable: deal.money.shortfall?.method === "UNAVAILABLE",
                          }
                        : null,
                    onSettleSupplier,
                    supplierGuidance,
                  }
                : null
            }
            customerInvoice={deal.money.customerInvoice}
            renderCommissions={renderCommissions}
            t={t}
          />

          {/* --- actual expenses -------------------------------------- */}
          {/* ABSENT on a CASH deal with no fee records, rather than a card
              reading "expenses: 0" on every cash deal forever. A cash sale's
              costs are already inside the vehicle's capitalized cost and
              therefore already inside the margin above — listing them again
              here would show the owner a cost subtracted twice.

              Gated on the deal KIND, not merely on emptiness. A financed
              deal keeps the card unconditionally because that is how the
              shipped screen behaves: its expenses are real pending actuals
              an operator is waiting on, so "none recorded yet" is
              information rather than noise. Hiding it on emptiness alone
              silently changed a production screen from inside a PR whose
              scope excludes touching it. */}
          {!hasHandoverCosts && (deal.dealKind === "FINANCED" ||
            deal.money.expenses.lines.length > 0 ||
            deal.money.expenses.actualTotalMinor !== 0) && (
            <DealActualExpenses expenses={deal.money.expenses} money={money} t={t} />
          )}
        </>
      )}
    </div>
  );
}
