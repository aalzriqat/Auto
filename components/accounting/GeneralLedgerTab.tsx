"use client";

import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const defaultEnd = new Date();
const defaultStart = new Date();
defaultStart.setDate(defaultStart.getDate() - 30);

type LedgerTransaction = {
  _id: string;
  type: "IN" | "OUT";
  amount: number;
  date: number;
  category: string;
  description: string;
  vehicleLabel?: string;
  customerName?: string;
  quoteReference?: string;
  reservationReference?: string;
};

function translatedKey(t: (key: string) => string, key: string, fallback: string): string {
  const translated = t(key);
  return translated === key ? fallback : translated;
}

function legacyArabicDescription(transaction: LedgerTransaction): string | null {
  const saleMatch = transaction.description.match(/^Sale of vehicle (.+?)(?: \(VIN: (.+)\))?$/);
  if (saleMatch) {
    const vin = saleMatch[2] ? ` (رقم الهيكل: ${saleMatch[2]})` : "";
    return `بيع مركبة ${saleMatch[1]}${vin}`;
  }

  const oldDepositMatch = transaction.description.match(/^Deposit held for quote (.+)$/i);
  if (oldDepositMatch) return `عربون محجوز للعرض ${oldDepositMatch[1]}`;

  const depositMatch = transaction.description.match(/^Deposit\s+—\s+(.+)\s+\((.+)\)$/);
  if (depositMatch) return `عربون - ${depositMatch[1]} - ${depositMatch[2]}`;

  const refundMatch = transaction.description.match(/^Deposit refunded\s+—\s+(.+)\s+\((.+)\)$/);
  if (refundMatch) return `استرداد عربون - ${refundMatch[1]} - ${refundMatch[2]}`;

  const expenseMatch = transaction.description.match(/^Expense:\s+(.+)\s+\((.+)\)$/);
  if (expenseMatch) return `مصروف: ${expenseMatch[1]} (${expenseMatch[2]})`;

  return null;
}

function isArabicLedgerDescription(description: string): boolean {
  return /^(بيع مركبة|عربون|استرداد عربون|مصروف:)/.test(description);
}

function depositPrefix(type: "IN" | "OUT", locale: string): string {
  if (locale === "ar") return type === "OUT" ? "استرداد عربون" : "عربون";
  return type === "OUT" ? "Deposit refund" : "Deposit";
}

function saleVinFromDescription(description: string): string | null {
  return description.match(/\(VIN:\s*([^)]+)\)/i)?.[1]?.trim() ?? null;
}

function localizedDetails(transaction: LedgerTransaction, locale: string): string[] {
  if (locale === "ar") {
    return [
      transaction.quoteReference ? `العرض ${transaction.quoteReference}` : null,
      transaction.reservationReference ? `الحجز ${transaction.reservationReference}` : null,
      transaction.vehicleLabel,
      transaction.customerName ? `العميل ${transaction.customerName}` : null,
    ].filter((detail): detail is string => Boolean(detail));
  }

  return [
    transaction.quoteReference ? `Quote ${transaction.quoteReference}` : null,
    transaction.reservationReference ? `Reservation ${transaction.reservationReference}` : null,
    transaction.vehicleLabel,
    transaction.customerName ? `Customer ${transaction.customerName}` : null,
  ].filter((detail): detail is string => Boolean(detail));
}

function enrichedDescription(transaction: LedgerTransaction, locale: string): string | null {
  const details = localizedDetails(transaction, locale);
  if (transaction.category === "DEPOSIT" && details.length > 0) {
    return `${depositPrefix(transaction.type, locale)} - ${details.join(" - ")}`;
  }
  if (transaction.category === "VEHICLE_SALE" && transaction.vehicleLabel) {
    const vin = saleVinFromDescription(transaction.description);
    if (locale === "ar") {
      const customer = transaction.customerName ? ` للعميل ${transaction.customerName}` : "";
      const vinText = vin ? ` (رقم الهيكل: ${vin})` : "";
      return `بيع مركبة ${transaction.vehicleLabel}${customer}${vinText}`;
    }

    const customer = transaction.customerName ? ` to ${transaction.customerName}` : "";
    const vinText = vin ? ` (VIN: ${vin})` : "";
    return `Sale of vehicle ${transaction.vehicleLabel}${customer}${vinText}`;
  }
  return null;
}

export function GeneralLedgerTab() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const formatCurrency = useCurrencyFormatter();

  const [startDateStr, setStartDateStr] = useState(defaultStart.toISOString().split("T")[0]);
  const [endDateStr, setEndDateStr] = useState(defaultEnd.toISOString().split("T")[0]);
  const [filterActive, setFilterActive] = useState(false);

  const startDate = filterActive ? new Date(startDateStr).setHours(0, 0, 0, 0) : undefined;
  const endDate = filterActive ? new Date(endDateStr).setHours(23, 59, 59, 999) : undefined;

  const { results: transactions, status, loadMore } = usePaginatedQuery(
    api.transactions.list,
    activeOrgId
      ? { orgId: activeOrgId, startDate, endDate }
      : "skip",
    { initialNumItems: 100 }
  );

  const totalIn = transactions?.filter((t) => t.type === "IN").reduce((s, t) => s + t.amount, 0) ?? 0;
  const totalOut = transactions?.filter((t) => t.type === "OUT").reduce((s, t) => s + t.amount, 0) ?? 0;
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";

  function transactionTypeLabel(type: "IN" | "OUT"): string {
    return type === "IN" ? t("TxIn") : t("TxOut");
  }

  function transactionCategoryLabel(category: string): string {
    const fallback = category.replace(/_/g, " ");
    return translatedKey(t, `TransactionCategory_${category}`, fallback);
  }

  function transactionDescription(transaction: LedgerTransaction): string {
    const structuredDescription = enrichedDescription(transaction, locale);
    if (structuredDescription) return structuredDescription;
    if (locale !== "ar") return transaction.description;
    if (isArabicLedgerDescription(transaction.description)) return transaction.description;
    return legacyArabicDescription(transaction) ??
      transaction.description;
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{t("TransactionRegister" as any)}</h2>
        <p className="text-sm text-slate-500">{t("TransactionRegisterDesc" as any)}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">{t("StartDate" as any)}</label>
          <Input type="date" value={startDateStr} onChange={(e) => setStartDateStr(e.target.value)} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">{t("EndDate" as any)}</label>
          <Input type="date" value={endDateStr} onChange={(e) => setEndDateStr(e.target.value)} className="h-8 text-sm" />
        </div>
        <Button size="sm" variant={filterActive ? "default" : "outline"} onClick={() => setFilterActive(!filterActive)}>
          {filterActive ? t("ClearFilter" as any) : t("ApplyFilter" as any)}
        </Button>
      </div>

      <div className="flex gap-4 text-sm">
        <span className="text-emerald-600 font-semibold">{t("TxIn" as any)}: {formatCurrency(totalIn)}</span>
        <span className="text-rose-600 font-semibold">{t("TxOut" as any)}: {formatCurrency(totalOut)}</span>
        <span className="text-slate-600 font-semibold">{t("TxNet" as any)}: {formatCurrency(totalIn - totalOut)}</span>
      </div>

      <div className="rounded-md border border-slate-200 overflow-x-auto">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("Date" as any)}</TableHead>
              <TableHead>{t("TypeLabel" as any)}</TableHead>
              <TableHead>{t("Category" as any)}</TableHead>
              <TableHead>{t("DescriptionLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("Amount" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!transactions ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">{t("Loading" as any)}</TableCell>
              </TableRow>
            ) : transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">{t("NoTransactionsFound" as any)}</TableCell>
              </TableRow>
            ) : (
              transactions.map((tx) => {
                const description = transactionDescription(tx);
                return (
                  <TableRow key={tx._id}>
                    <TableCell className="font-medium">{new Date(tx.date).toLocaleDateString(localeCode)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={tx.type === "IN" ? "default" : "destructive"}
                        className={tx.type === "IN" ? "bg-green-100 text-green-800 hover:bg-green-100" : ""}
                      >
                        {transactionTypeLabel(tx.type)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-slate-50 text-slate-600">
                        {transactionCategoryLabel(tx.category)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate" title={description}>
                      {description}
                    </TableCell>
                    <TableCell className={`text-right font-semibold ${tx.type === "IN" ? "text-emerald-600" : "text-rose-600"}`}>
                      {tx.type === "IN" ? "+" : "-"}{formatCurrency(tx.amount)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {status === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => loadMore(100)}>{t("LoadMore" as any)}</Button>
        </div>
      )}
    </div>
  );
}
