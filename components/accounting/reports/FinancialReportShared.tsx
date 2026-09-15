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

/**
 * Takes the two fields it actually reads rather than a whole `ReportRow`, so
 * anything carrying an account's names can localize it the same way — the
 * opening-balance picker passes raw `chartOfAccounts` docs, which have no
 * `netMinor` or `currency` to offer.
 */
export function accountDisplayName(
  row: { name: string; nameAr?: string },
  locale: string,
): string {
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
      className={isBalanced
        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"}
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
    ? "text-emerald-700 dark:text-emerald-300"
    : tone === "danger"
      ? "text-rose-700 dark:text-rose-300"
      : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
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
        <TableHeader className="bg-muted/50">
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
                  <div className="text-xs text-muted-foreground">{row.currency}</div>
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
        <TableHeader className="bg-muted/50">
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
                  <div className="text-xs text-muted-foreground">{row.currency}</div>
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
