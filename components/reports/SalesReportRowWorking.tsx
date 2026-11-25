"use client";

import { profitLineLabelKey } from "@/components/applications/cockpit/DealProfitPresentation";

/** The row fields the working reads. Every one is served by the backend; none is computed here. */
export interface WorkingRow {
  currency: string;
  netProfit?: number | null;
  commissionsTotal?: number | null;
  netProfitAfterCommissions?: number | null;
  profitLines?: ReadonlyArray<{ key: string; sign: number; amount: number }> | null;
  profitClassification?: string | null;
}

type Props = Readonly<{
  sale: WorkingRow;
  rowMoney: (amount: number | null, currency: string) => string;
  t: (key: string) => string;
}>;

/**
 * The working behind one report row: the deal page's own signed lines, then the served profit before commissions,
 * then (for a caller who may read commissions) the served commission and net after commissions. Nothing is added up
 * here; a row without a served working (an older server, or an unknown profit) offers none.
 */
export function SalesReportRowWorking({ sale, rowMoney, t }: Props) {
  const lines = sale.profitLines ?? [];
  if (lines.length === 0 || sale.netProfit == null) return null;
  const signed = (sign: number, amount: number) => `${sign < 0 ? "− " : ""}${rowMoney(amount, sale.currency)}`;
  return (
    <details className="group text-sm">
      <summary className="min-h-9 cursor-pointer list-none text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        {t("ReportShowWorking")}
      </summary>
      <dl className="max-w-xl space-y-1.5 pb-2 pt-1">
        {lines.map((line) => (
          <div key={line.key} className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t(profitLineLabelKey(line.key))}</dt>
            <dd dir="ltr">{signed(line.sign, line.amount)}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 border-t pt-1.5 font-medium">
          <dt>{t("ProfitBeforeCommissionsSubtotal")}</dt>
          <dd dir="ltr">{rowMoney(sale.netProfit, sale.currency)}</dd>
        </div>
        {sale.commissionsTotal != null && (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t("DealCommissionsTotal")}</dt>
            <dd dir="ltr">{signed(-1, sale.commissionsTotal)}</dd>
          </div>
        )}
        {sale.netProfitAfterCommissions != null && (
          <div className="flex items-center justify-between gap-4 font-medium">
            <dt>{t("ReportNetAfterCommissions")}</dt>
            <dd dir="ltr">{rowMoney(sale.netProfitAfterCommissions, sale.currency)}</dd>
          </div>
        )}
      </dl>
      {sale.profitClassification === "ESTIMATED_AWAITING_SETTLEMENT" && (
        <p className="pb-2 text-xs text-muted-foreground">{t("ReportEstimateNote")}</p>
      )}
    </details>
  );
}
