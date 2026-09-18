"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter, useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { scaleForCurrency, supportedCurrencyScale } from "./AccountingTabShared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { dateInputToUtcMs, dateInputEndToUtcMs, todayDateInput, daysFromTodayDateInput } from "@/lib/dateInput";

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
  const formatInCurrency = useCurrencyFormatterInCurrency();

  const [activeLedgerView, setActiveLedgerView] = useState<"gl" | "register">("gl");
  const [selectedEntryId, setSelectedEntryId] = useState<Id<"journalEntries"> | null>(null);

  const [startDateStr, setStartDateStr] = useState(() => daysFromTodayDateInput(-30));
  const [endDateStr, setEndDateStr] = useState(() => todayDateInput());
  const [filterActive, setFilterActive] = useState(false);

  // UTC boundaries, matching how transactions are dated — see lib/dateInput.ts.
  const startDate = filterActive ? dateInputToUtcMs(startDateStr) : undefined;
  const endDate = filterActive ? dateInputEndToUtcMs(endDateStr) : undefined;

  // AF-318-01 — accounting-period and account filters for the General
  // Ledger, both narrowing the SAME server-side indexed query
  // (accountingLedger.listJournalEntries) rather than fetching everything and
  // filtering in the browser.
  const [glPeriodId, setGlPeriodId] = useState<Id<"accountingPeriods"> | "ALL">("ALL");
  const [glAccountId, setGlAccountId] = useState<Id<"chartOfAccounts"> | "ALL">("ALL");

  const periods = useQuery(
    api.accountingPeriods.list,
    activeOrgId && activeLedgerView === "gl" ? { orgId: activeOrgId } : "skip"
  );
  const sortedPeriods = [...(periods ?? [])].sort((a, b) => b.startDate - a.startDate);

  const accounts = useQuery(
    api.chartOfAccounts.list,
    activeOrgId && activeLedgerView === "gl" ? { orgId: activeOrgId } : "skip"
  );
  const accountsById = new Map((accounts ?? []).map((a) => [a._id as string, a]));
  const sortedAccounts = [...(accounts ?? [])].sort((a, b) => a.code.localeCompare(b.code));

  // AF-318-01 — real cursor pagination (`usePaginatedQuery`), not a fixed
  // `limit: 100` that silently made every entry past the 100th unreachable.
  // The first page stays bounded; "Load more" below reaches the rest.
  const {
    results: journalEntries,
    status: journalStatus,
    loadMore: loadMoreJournalEntries,
  } = usePaginatedQuery(
    api.accountingLedger.listJournalEntries,
    activeOrgId && activeLedgerView === "gl"
      ? {
          orgId: activeOrgId,
          ...(glPeriodId !== "ALL" ? { periodId: glPeriodId } : {}),
          ...(glAccountId !== "ALL" ? { accountId: glAccountId } : {}),
        }
      : "skip",
    { initialNumItems: 50 }
  );

  const entryDetails = useQuery(
    api.accountingLedger.getJournalEntry,
    activeOrgId && selectedEntryId ? { orgId: activeOrgId, journalEntryId: selectedEntryId } : "skip"
  );

  const { results: transactions, status, loadMore } = usePaginatedQuery(
    api.transactions.list,
    activeOrgId && activeLedgerView === "register"
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {activeLedgerView === "gl" ? t("GeneralLedger" as any) : t("TransactionRegister" as any)}
          </h2>
          <p className="text-sm text-muted-foreground">
            {activeLedgerView === "gl" ? t("JournalEntries" as any) : t("TransactionRegisterDesc" as any)}
          </p>
        </div>
        <div className="flex items-center rounded-lg border bg-muted/30 p-1 self-start sm:self-auto">
          <Button
            size="sm"
            variant={activeLedgerView === "gl" ? "secondary" : "ghost"}
            className="h-7 text-xs"
            onClick={() => setActiveLedgerView("gl")}
          >
            {t("GeneralLedger" as any)}
          </Button>
          <Button
            size="sm"
            variant={activeLedgerView === "register" ? "secondary" : "ghost"}
            className="h-7 text-xs"
            onClick={() => setActiveLedgerView("register")}
          >
            {t("TransactionRegister" as any)}
          </Button>
        </div>
      </div>

      {activeLedgerView === "gl" ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t("FilterByPeriod" as any)}</label>
              <Select
                value={glPeriodId === "ALL" ? "ALL" : String(glPeriodId)}
                onValueChange={(v) => setGlPeriodId(v === "ALL" ? "ALL" : (v as Id<"accountingPeriods">))}
              >
                <SelectTrigger className="h-8 w-56 text-sm" data-testid="gl-period-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="ALL">{t("AllPeriods" as any)}</SelectItem>
                  {sortedPeriods.map((p) => (
                    <SelectItem key={p._id} value={p._id}>
                      {p.fiscalYear}-P{p.periodNumber}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t("FilterByAccount" as any)}</label>
              <Select
                value={glAccountId === "ALL" ? "ALL" : String(glAccountId)}
                onValueChange={(v) => setGlAccountId(v === "ALL" ? "ALL" : (v as Id<"chartOfAccounts">))}
              >
                <SelectTrigger className="h-8 w-64 text-sm" data-testid="gl-account-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="ALL">{t("AllAccounts" as any)}</SelectItem>
                  {sortedAccounts.map((a) => (
                    <SelectItem key={a._id} value={a._id}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-md border border-border overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>{t("Date" as any)}</TableHead>
                  <TableHead>{t("TypeLabel" as any)}</TableHead>
                  <TableHead>{t("Memo" as any)}</TableHead>
                  <TableHead>{t("Source" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {journalStatus === "LoadingFirstPage" ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      {t("Loading" as any)}
                    </TableCell>
                  </TableRow>
                ) : journalEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      {t("NoJournalEntriesFound" as any)}
                    </TableCell>
                  </TableRow>
                ) : (
                  journalEntries.map((entry) => (
                    <TableRow key={entry._id} data-testid="journal-entry-row" data-entry-id={entry._id} data-memo={entry.memo}>
                      <TableCell className="font-medium whitespace-nowrap" data-testid="journal-entry-date">
                        {new Date(entry.accountingDate).toLocaleDateString(localeCode)}
                      </TableCell>
                      <TableCell className="font-mono text-xs font-semibold" data-testid="journal-entry-number">
                        {entry.journalNumber}
                      </TableCell>
                      <TableCell className="max-w-[320px] truncate" title={entry.memo} data-testid="journal-entry-memo">
                        {entry.memo || "-"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {entry.sourceType}: {entry.sourceId}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" data-testid="journal-entry-status">{entry.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="view-entry-lines-btn"
                          onClick={() => setSelectedEntryId(entry._id)}
                        >
                          {t("ViewLines" as any)}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {journalStatus === "CanLoadMore" && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                data-testid="gl-load-more-btn"
                onClick={() => loadMoreJournalEntries(50)}
              >
                {t("LoadMoreEntries" as any)}
              </Button>
            </div>
          )}
          {journalStatus === "LoadingMore" && (
            <div className="flex justify-center text-xs text-muted-foreground py-1">{t("Loading" as any)}</div>
          )}
          {journalStatus === "Exhausted" && journalEntries.length > 0 && (
            <p className="text-center text-xs text-muted-foreground" data-testid="gl-all-loaded">
              {t("AllJournalEntriesLoaded" as any)}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t("StartDate" as any)}</label>
              <Input type="date" value={startDateStr} onChange={(e) => setStartDateStr(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t("EndDate" as any)}</label>
              <Input type="date" value={endDateStr} onChange={(e) => setEndDateStr(e.target.value)} className="h-8 text-sm" />
            </div>
            <Button size="sm" variant={filterActive ? "default" : "outline"} onClick={() => setFilterActive(!filterActive)}>
              {filterActive ? t("ClearFilter" as any) : t("ApplyFilter" as any)}
            </Button>
          </div>

          <div className="flex gap-4 text-sm">
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">{t("TxIn" as any)}: {formatCurrency(totalIn)}</span>
            <span className="font-semibold text-rose-600 dark:text-rose-400">{t("TxOut" as any)}: {formatCurrency(totalOut)}</span>
            <span className="text-muted-foreground font-semibold">{t("TxNet" as any)}: {formatCurrency(totalIn - totalOut)}</span>
          </div>

          <div className="rounded-md border border-border overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
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
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">{t("Loading" as any)}</TableCell>
                  </TableRow>
                ) : transactions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">{t("NoTransactionsFound" as any)}</TableCell>
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
                            className={tx.type === "IN" ? "bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-950/50 dark:text-green-200 dark:hover:bg-green-950/50" : ""}
                          >
                            {transactionTypeLabel(tx.type)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="bg-muted/50 text-muted-foreground">
                            {transactionCategoryLabel(tx.category)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate" title={description}>
                          {description}
                        </TableCell>
                        <TableCell className={`text-right font-semibold ${tx.type === "IN" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
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
        </>
      )}

      <Dialog open={!!selectedEntryId} onOpenChange={(open) => !open && setSelectedEntryId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("JournalLines" as any)} {entryDetails?.entry?.journalNumber ? `(${entryDetails.entry.journalNumber})` : ""}
            </DialogTitle>
            <DialogDescription className="space-y-1">
              <span className="block" data-testid="dialog-entry-memo">{entryDetails?.entry?.memo || ""}</span>
              {entryDetails?.period && (
                <span className="block text-xs font-mono text-muted-foreground" data-testid="dialog-entry-period">
                  Period: {entryDetails.period.fiscalYear}-P{entryDetails.period.periodNumber} ({new Date(entryDetails.period.startDate).toLocaleDateString(localeCode)} – {new Date(entryDetails.period.endDate).toLocaleDateString(localeCode)})
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>{t("Account" as any)}</TableHead>
                  <TableHead>{t("DescriptionLabel" as any)}</TableHead>
                  <TableHead className="text-right">{t("Debit" as any)}</TableHead>
                  <TableHead className="text-right">{t("Credit" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!entryDetails?.lines ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">
                      {t("Loading" as any)}
                    </TableCell>
                  </TableRow>
                ) : (
                  entryDetails.lines.map((line) => {
                    const effectiveCurrency = line.currency || entryDetails.entry?.currency;
                    const effectiveScale =
                      line.scale !== undefined
                        ? line.scale
                        : effectiveCurrency
                          ? supportedCurrencyScale(effectiveCurrency)
                          : null;
                    const lineFactor = effectiveScale !== null ? Math.pow(10, effectiveScale) : null;
                    const account = accountsById.get(line.accountId as string);

                    const formatLineAmount = (minor: number) => {
                      if (minor <= 0) return "-";
                      if (effectiveCurrency && effectiveScale !== null && lineFactor !== null) {
                        return formatInCurrency(minor / lineFactor, effectiveCurrency, effectiveScale);
                      }
                      return `[Unverified Scale: ${minor} minor]`;
                    };

                    return (
                      <TableRow key={line._id} data-testid="journal-line-row">
                        <TableCell className="text-xs" data-testid="line-account">
                          {account ? (
                            <span>
                              <span className="font-mono font-medium">{account.code}</span>{" "}
                              <span className="text-muted-foreground">({account.name})</span>
                            </span>
                          ) : (
                            <span className="font-mono text-muted-foreground">{line.accountId}</span>
                          )}
                        </TableCell>
                        <TableCell data-testid="line-description">{line.description || "-"}</TableCell>
                        <TableCell className="text-right font-medium text-emerald-600 dark:text-emerald-400" data-testid="line-debit">
                          {formatLineAmount(line.debitMinor)}
                        </TableCell>
                        <TableCell className="text-right font-medium text-rose-600 dark:text-rose-400" data-testid="line-credit">
                          {formatLineAmount(line.creditMinor)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedEntryId(null)}>
              {t("Cancel" as any)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
