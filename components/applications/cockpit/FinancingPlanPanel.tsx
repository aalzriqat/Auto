"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff } from "lucide-react";

/**
 * The CUSTOMER'S financing plan, as the quote recorded it.
 *
 * Every figure here is what the customer agreed to pay and over how long. None
 * of it is what the finance company remits to the dealership or what the
 * dealership earns — those are the deal's ECONOMICS and live in the money
 * panel — and the two are never derived from each other here: a plan figure is
 * shown when the quote carries it and is otherwise marked unavailable, never
 * computed from the others (SCRUM-215 P4 information parity, c19345/c19384).
 *
 * `currency` is the deal's own pinned denomination; when the row predates the
 * pin, the org currency it was built in. Majors, formatted as the quote stored
 * them.
 */
export type FinancingPlanFacts = {
  /** The financier's display name, or null on an internal plan with none. */
  financierName: string | null;
  currency: string;
  vehiclePrice: number | undefined;
  downPayment: number | undefined;
  termMonths: number | undefined;
  monthlyInstallment: number | undefined;
  totalFinancedAmount: number | undefined;
  /**
   * The customer's national identifier exactly as the same `applications.get`
   * query already serves it to this caller — no wider access is granted here.
   * `null` when the customer has none recorded.
   */
  nationalId: string | null;
};

/** "••••1234": everything but the last four masked, as an LTR run. */
function maskIdentifier(value: string): string {
  const visible = value.slice(-4);
  return `${"•".repeat(Math.max(0, value.length - visible.length))}${visible}`;
}

export function FinancingPlanPanel({
  plan,
  formatMajor,
  t,
}: Readonly<{
  plan: FinancingPlanFacts;
  /** Spells a major amount in the plan's currency. */
  formatMajor: (major: number, currency: string) => string;
  t: (key: string) => string;
}>) {
  const [identifierShown, setIdentifierShown] = useState(false);

  const money = (value: number | undefined) =>
    value === undefined ? (
      <span className="text-muted-foreground">{t("FactUnavailable")}</span>
    ) : (
      <bdi className="tabular-nums" dir="ltr">
        {formatMajor(value, plan.currency)}
      </bdi>
    );

  return (
    <Card data-testid="deal-financing-plan">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("FinancingPlanHeading")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("FinancingPlanNote")}</p>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {plan.financierName && (
            <>
              <dt className="text-muted-foreground">{t("FinancingProvider")}</dt>
              <dd className="text-end font-medium">
                <bdi>{plan.financierName}</bdi>
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("CustomerPrice")}</dt>
          <dd className="text-end font-medium">{money(plan.vehiclePrice)}</dd>
          <dt className="text-muted-foreground">{t("DownPaymentLabel")}</dt>
          <dd className="text-end font-medium">{money(plan.downPayment)}</dd>
          <dt className="text-muted-foreground">{t("FinancedAmountLabel")}</dt>
          <dd className="text-end font-medium">{money(plan.totalFinancedAmount)}</dd>
          <dt className="text-muted-foreground">{t("TermLabel")}</dt>
          <dd className="text-end font-medium">
            {plan.termMonths === undefined ? (
              <span className="text-muted-foreground">{t("FactUnavailable")}</span>
            ) : (
              <>
                <bdi className="tabular-nums" dir="ltr">
                  {plan.termMonths}
                </bdi>{" "}
                {t("MonthsUnit")}
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">{t("InstallmentLabel")}</dt>
          <dd className="text-end font-semibold">{money(plan.monthlyInstallment)}</dd>
          {plan.nationalId && (
            <>
              <dt className="text-muted-foreground">{t("NationalIdLabel")}</dt>
              <dd className="flex items-center justify-end gap-1.5 font-medium">
                <bdi className="tabular-nums" dir="ltr" data-testid="deal-financing-plan-national-id">
                  {identifierShown ? plan.nationalId : maskIdentifier(plan.nationalId)}
                </bdi>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-pressed={identifierShown}
                  aria-label={t(identifierShown ? "HideNationalId" : "ShowNationalId")}
                  onClick={() => setIdentifierShown((shown) => !shown)}
                >
                  {identifierShown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
