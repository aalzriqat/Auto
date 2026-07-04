import { FinancialReportBadge, ReportMetric, TrialBalanceRowsTable, type CurrencyTotal, type ReportMoneyFormatter, type TrialBalanceRow } from "./FinancialReportShared";

type TrialBalanceReportData = {
  rows: TrialBalanceRow[];
  totalsByCurrency: CurrencyTotal[];
  isBalanced: boolean;
};

export function TrialBalanceReport({
  report,
  locale,
  t,
  formatMoney,
}: Readonly<{
  report: TrialBalanceReportData | undefined;
  locale: string;
  t: (key: string) => string;
  formatMoney: ReportMoneyFormatter;
}>) {
  if (report === undefined) return <p className="p-8 text-center text-slate-500">{t("Loading")}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-base font-semibold text-slate-900">{t("TrialBalance")}</h3>
        <FinancialReportBadge
          isBalanced={report.isBalanced}
          balancedLabel={t("JournalBalanced")}
          unbalancedLabel={t("JournalOutOfBalance")}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {report.totalsByCurrency.map((total) => (
          <ReportMetric
            key={total.currency}
            label={total.currency}
            value={`${formatMoney(total.totalDebits ?? 0, total.currency)} / ${formatMoney(total.totalCredits ?? 0, total.currency)}`}
            tone={total.isBalanced ? "success" : "danger"}
          />
        ))}
      </div>

      <TrialBalanceRowsTable
        rows={report.rows}
        locale={locale}
        emptyLabel={t("NoGLRowsFound")}
        t={t}
        formatMoney={formatMoney}
      />
    </div>
  );
}
