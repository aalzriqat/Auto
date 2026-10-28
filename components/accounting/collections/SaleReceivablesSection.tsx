"use client";

import { useEffect } from "react";
import { usePaginatedQuery } from "convex/react";
import { format } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountingTableFrame } from "../AccountingTabShared";

const PAGE_SIZE = 25;

/**
 * SCRUM-56 (SCRUM-760 c23812 ruling 8): what customers still owe on sales, read from the canonical sale invoice
 * (`collections.listOpenSaleReceivables`). Read-only: no payment, cheque, reschedule or refund action is offered here,
 * because the sale invoice has no receipt door in the pilot and the legacy actions below act on the legacy table only.
 * Amounts are the server's integer minor units, shown in the invoice's own currency and scale.
 *
 * A page can hold only paid invoices, so while nothing is visible yet and more pages exist the next page is requested
 * automatically; the section renders nothing at all when the organization owes no sale balance.
 */
export function SaleReceivablesSection({ orgId, statusFilter }: Readonly<{ orgId: Id<"organizations">; statusFilter: string }>) {
  const { t } = useLanguage();
  const formatInCurrency = useCurrencyFormatterInCurrency();
  const { results, status, loadMore } = usePaginatedQuery(api.collections.listOpenSaleReceivables, { orgId }, { initialNumItems: PAGE_SIZE });

  const rows = statusFilter === "ALL"
    ? results
    : results.filter((row) => statusFilter === "OVERDUE" ? row.isOverdue : row.status === statusFilter);
  const waitingForFirstRow = status === "CanLoadMore" && results.length === 0;
  useEffect(() => {
    if (waitingForFirstRow) loadMore(PAGE_SIZE * 4);
  }, [waitingForFirstRow, loadMore]);

  if (status === "LoadingFirstPage" || waitingForFirstRow) {
    return <p className="text-sm text-muted-foreground">{t("CollectionSaleBalancesLoading" as any)}</p>;
  }
  if (rows.length === 0 && status !== "CanLoadMore" && status !== "LoadingMore") return null;

  const money = (amountMinor: number, currency: string, scale: number) => formatInCurrency(amountMinor / 10 ** scale, currency, scale);
  const statusKey = (value: string) => {
    const key = `CollectionLabel_${value}`;
    const translated = t(key as any);
    return translated === key ? value : translated;
  };

  return (
    <section className="space-y-2" aria-labelledby="sale-balances-title">
      <div>
        <h3 id="sale-balances-title" className="font-semibold text-foreground">{t("CollectionSaleBalancesTitle" as any)}</h3>
        <p className="text-sm text-muted-foreground">{t("CollectionSaleBalancesDesc" as any)}</p>
      </div>
      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("Due" as any)}</TableHead>
              <TableHead>{t("Customer" as any)}</TableHead>
              <TableHead>{t("Source" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-end">{t("Original" as any)}</TableHead>
              <TableHead className="text-end">{t("CollectionOutstanding" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.receivableDocumentId}>
                <TableCell className="font-medium">{format(new Date(row.dueDate), "MMM d, yyyy")}</TableCell>
                <TableCell>
                  <div className="font-medium">{row.customerName || t("Unknown" as any)}</div>
                  <div className="text-xs text-muted-foreground">{row.vehicleLabel || row.documentNumber}</div>
                </TableCell>
                <TableCell>{t("CollectionSaleInvoice" as any)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{statusKey(row.status)}</Badge>
                </TableCell>
                <TableCell className="text-end">{money(row.originalAmountMinor, row.currency, row.scale)}</TableCell>
                <TableCell className="text-end font-semibold">{money(row.outstandingMinor, row.currency, row.scale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AccountingTableFrame>
      {status === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMore(PAGE_SIZE)}>{t("LoadMore" as any)}</Button>
      )}
    </section>
  );
}
