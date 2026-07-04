import { FinancialReportBadge, NetRowsTable, ReportMetric, type CurrencyTotal, type ReportMoneyFormatter, type ReportRow } from "./FinancialReportShared";

type BalanceSheetReportData = {
  assetRows: ReportRow[];
  liabilityRows: ReportRow[];
  equityRows: ReportRow[];
  totalsByCurrency: Array<CurrencyTotal & {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    netIncomeMinor: number;
    isBalanced: boolean;
  }>;
  isBalanced: boolean;
};

function BalanceSection({
  title,
  rows,
  locale,
  t,
  formatMoney,
}: Readonly<{
  title: string;
  rows: readonly ReportRow[];
  locale: string;
  t: (key: string) => string;
  formatMoney: ReportMoneyFormatter;
}>) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
      <NetRowsTable rows={rows} locale={locale} emptyLabel={t("NoGLRowsFound")} t={t} formatMoney={formatMoney} />
    </div>
  );
}

export function BalanceSheetReport({
  report,
  locale,
  t,
  formatMoney,
}: Readonly<{
  report: BalanceSheetReportData | undefined;
  locale: string;
  t: (key: string) => string;
  formatMoney: ReportMoneyFormatter;
}>) {
  if (report === undefined) return <p className="p-8 text-center text-slate-500">{t("Loading")}</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-base font-semibold text-slate-900">{t("BalanceSheet")}</h3>
        <FinancialReportBadge
          isBalanced={report.isBalanced}
          balancedLabel={t("Balanced")}
          unbalancedLabel={t("Unbalanced")}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {report.totalsByCurrency.map((total) => (
          <div key={total.currency} className="contents">
            <ReportMetric
              label={`${t("Assets")} (${total.currency})`}
              value={formatMoney(total.totalAssets, total.currency)}
            />
            <ReportMetric
              label={`${t("Liabilities")} (${total.currency})`}
              value={formatMoney(total.totalLiabilities, total.currency)}
            />
            <ReportMetric
              label={`${t("Equity")} (${total.currency})`}
              value={formatMoney(total.totalEquity, total.currency)}
            />
            <ReportMetric
              label={`${t("NetIncome")} (${total.currency})`}
              value={formatMoney(total.netIncomeMinor, total.currency)}
              tone={total.isBalanced ? "success" : "danger"}
            />
          </div>
        ))}
      </div>

      <BalanceSection title={t("Assets")} rows={report.assetRows} locale={locale} t={t} formatMoney={formatMoney} />
      <BalanceSection title={t("Liabilities")} rows={report.liabilityRows} locale={locale} t={t} formatMoney={formatMoney} />
      <BalanceSection title={t("Equity")} rows={report.equityRows} locale={locale} t={t} formatMoney={formatMoney} />
    </div>
  );
}
