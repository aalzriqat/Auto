import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountingEmptyRow, AccountingTableFrame, scaleForCurrency } from "../AccountingTabShared";

export type ReportMoneyFormatter = (amountMinor: number, currency: string) => string;

export type ReportRow = {
  accountId: string;
  code: string;
  name: string;
  nameAr?: string;
  netMinor: number;
  currency: string;
};

export type TrialBalanceRow = ReportRow & {
  debitMinor: number;
  creditMinor: number;
};

export type CurrencyTotal = {
  currency: string;
  totalDebits?: number;
  totalCredits?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  totalEquity?: number;
  netIncome?: number;
  netIncomeMinor?: number;
  isBalanced?: boolean;
};

export function formatMinorAmount(amountMinor: number, currency: string, locale: string): string {
  const scale = scaleForCurrency(currency);
  const amount = amountMinor / Math.pow(10, scale);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

export function accountDisplayName(row: ReportRow, locale: string): string {
  if (locale === "ar" && row.nameAr) return row.nameAr;
  return row.name;
}

export function FinancialReportBadge({
  isBalanced,
  balancedLabel,
  unbalancedLabel,
}: Readonly<{
  isBalanced: boolean;
  balancedLabel: string;
  unbalancedLabel: string;
}>) {
  return (
    <Badge
      variant="outline"
      className={isBalanced ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}
    >
      {isBalanced ? balancedLabel : unbalancedLabel}
    </Badge>
  );
}

export function ReportMetric({
  label,
  value,
  tone = "default",
}: Readonly<{
  label: string;
  value: string;
  tone?: "default" | "success" | "danger";
}>) {
  const toneClass = tone === "success"
    ? "text-emerald-700"
    : tone === "danger"
      ? "text-rose-700"
      : "text-slate-900";
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-base font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

export function TrialBalanceRowsTable({
  rows,
  locale,
  emptyLabel,
  t,
  formatMoney,
}: Readonly<{
  rows: readonly TrialBalanceRow[];
  locale: string;
  emptyLabel: string;
  t: (key: string) => string;
  formatMoney: ReportMoneyFormatter;
}>) {
  return (
    <AccountingTableFrame>
      <Table>
        <TableHeader className="bg-slate-50">
          <TableRow>
            <TableHead>{t("Account")}</TableHead>
            <TableHead className="text-right">{t("Debit")}</TableHead>
            <TableHead className="text-right">{t("Credit")}</TableHead>
            <TableHead className="text-right">{t("Net")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <AccountingEmptyRow colSpan={4} label={emptyLabel} />
          ) : (
            rows.map((row) => (
              <TableRow key={`${row.accountId}-${row.currency}`}>
                <TableCell>
                  <div className="font-medium">{row.code} - {accountDisplayName(row, locale)}</div>
                  <div className="text-xs text-slate-500">{row.currency}</div>
                </TableCell>
                <TableCell className="text-right">{formatMoney(row.debitMinor, row.currency)}</TableCell>
                <TableCell className="text-right">{formatMoney(row.creditMinor, row.currency)}</TableCell>
                <TableCell className="text-right font-semibold">{formatMoney(row.netMinor, row.currency)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AccountingTableFrame>
  );
}

export function NetRowsTable({
  rows,
  locale,
  emptyLabel,
  t,
  formatMoney,
}: Readonly<{
  rows: readonly ReportRow[];
  locale: string;
  emptyLabel: string;
  t: (key: string) => string;
  formatMoney: ReportMoneyFormatter;
}>) {
  return (
    <AccountingTableFrame>
      <Table>
        <TableHeader className="bg-slate-50">
          <TableRow>
            <TableHead>{t("Account")}</TableHead>
            <TableHead className="text-right">{t("Amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <AccountingEmptyRow colSpan={2} label={emptyLabel} />
          ) : (
            rows.map((row) => (
              <TableRow key={`${row.accountId}-${row.currency}`}>
                <TableCell>
                  <div className="font-medium">{row.code} - {accountDisplayName(row, locale)}</div>
                  <div className="text-xs text-slate-500">{row.currency}</div>
                </TableCell>
                <TableCell className="text-right font-semibold">{formatMoney(row.netMinor, row.currency)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </AccountingTableFrame>
  );
}
