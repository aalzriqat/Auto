import { NetRowsTable, ReportMetric, type CurrencyTotal, type ReportMoneyFormatter, type ReportRow } from "./FinancialReportShared";

type IncomeStatementReportData = {
  revenueRows: ReportRow[];
  cogsRows: ReportRow[];
  expenseRows: ReportRow[];
  otherIncomeRows: ReportRow[];
  otherExpenseRows: ReportRow[];
  totalsByCurrency: Array<CurrencyTotal & {
    totalRevenue: number;
    totalCogs: number;
    grossProfit: number;
    totalExpenses: number;
    totalOtherIncome: number;
    totalOtherExpenses: number;
    netIncome: number;
  }>;
};

function StatementSection({
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
      <NetRowsTable
        rows={rows}
        locale={locale}
        emptyLabel={t("NoGLRowsFound")}
        t={t}
        formatMoney={formatMoney}
      />
    </div>
  );
}

export function IncomeStatementReport({
  report,
  locale,
  t,
  formatMoney,
}: Readonly<{
  report: IncomeStatementReportData | undefined;
  locale: string;
  t: (key: string) => string;
  formatMoney: ReportMoneyFormatter;
}>) {
  if (report === undefined) return <p className="p-8 text-center text-slate-500">{t("Loading")}</p>;

  return (
    <div className="space-y-5">
      <h3 className="text-base font-semibold text-slate-900">{t("IncomeStatement")}</h3>
      <div className="grid gap-3 md:grid-cols-3">
        {report.totalsByCurrency.map((total) => (
          <ReportMetric
            key={total.currency}
            label={`${t("NetIncome")} (${total.currency})`}
            value={formatMoney(total.netIncome, total.currency)}
            tone={total.netIncome >= 0 ? "success" : "danger"}
          />
        ))}
      </div>

      <StatementSection title={t("Revenue")} rows={report.revenueRows} locale={locale} t={t} formatMoney={formatMoney} />
      <StatementSection title={t("COGS")} rows={report.cogsRows} locale={locale} t={t} formatMoney={formatMoney} />
      <StatementSection title={t("Expenses")} rows={report.expenseRows} locale={locale} t={t} formatMoney={formatMoney} />
      <StatementSection title={t("OtherIncome")} rows={report.otherIncomeRows} locale={locale} t={t} formatMoney={formatMoney} />
      <StatementSection title={t("OtherExpenses")} rows={report.otherExpenseRows} locale={locale} t={t} formatMoney={formatMoney} />
    </div>
  );
}
