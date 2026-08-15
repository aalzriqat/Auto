"use client";

import Link from "next/link";
import { useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { format } from "date-fns";
import { ArrowLeft, ArrowRight, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AccountingEmptyRow,
  AccountingTableFrame,
  LoadingAccountingState,
} from "./AccountingTabShared";

type ReceivableStatus =
  | "OPEN"
  | "PARTIALLY_PAID"
  | "PAID"
  | "WRITTEN_OFF"
  | "CANCELLED"
  | "REVERSED";

const STATUS_BADGE_CLASS: Record<ReceivableStatus, string> = {
  OPEN: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  PARTIALLY_PAID: "bg-sky-500/10 text-sky-700 border-sky-500/20",
  PAID: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  WRITTEN_OFF: "bg-rose-500/10 text-rose-600 border-rose-500/20",
  CANCELLED: "bg-slate-500/10 text-slate-500 border-slate-500/20",
  REVERSED: "bg-slate-500/10 text-slate-500 border-slate-500/20",
};

/**
 * SCRUM-51 — finance-company receivables, read-only.
 *
 * Claims used to originate its own receivable here and settle it. Finance
 * Applications own that money, so this screen reports it and sends the
 * accountant to the deal that can act on it. There is deliberately no create
 * action: recording a financier's debt is an outcome of a deal, not a
 * bookkeeping entry.
 */
export function ClaimsTab() {
  const { activeOrgId } = useOrg();
  const { t, isRtl } = useLanguage();
  const formatIn = useCurrencyFormatterInCurrency();

  // Captured once per mount: "overdue" must not flicker between renders, and
  // reading the clock during render is not idempotent.
  const [now] = useState(() => Date.now());

  const { results: rows, status, loadMore } = usePaginatedQuery(
    api.claims.listFinanceCompanyReceivables,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 50 }
  );

  // The headline is org-wide, from its own query. Summing the loaded page
  // would label a subtotal as the total, and this list is newest-first, so the
  // oldest and most overdue balances are exactly what a page-bounded sum drops.
  const totals = useQuery(
    api.claims.financeCompanyOutstandingTotals,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  if (status === "LoadingFirstPage") {
    return <LoadingAccountingState label={t("LoadingClaims" as any)} />;
  }

  const money = (minor: number, currency: string, scale: number) =>
    formatIn(minor / Math.pow(10, scale), currency, scale);

  const outstandingEntries = totals ?? [];
  const Arrow = isRtl ? ArrowLeft : ArrowRight;

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-900">{t("FinanceCompanyAR" as any)}</h2>
        <p className="max-w-2xl text-sm text-slate-500">{t("FinanceCompanyARDesc" as any)}</p>
      </div>

      {outstandingEntries.length > 0 && (
        <div className="flex flex-wrap items-end gap-x-10 gap-y-4 border-b border-slate-200 pb-5">
          {outstandingEntries.map(({ currency, outstandingMinor, scale }) => (
            <div key={currency}>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {t("TotalOutstandingFromFinanciers" as any)}
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">
                <bdi>{money(outstandingMinor, currency, scale)}</bdi>
              </div>
            </div>
          ))}
        </div>
      )}

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("FinancingEntity" as any)}</TableHead>
              <TableHead>{t("BuyerName" as any)}</TableHead>
              <TableHead>{t("DueDate" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-end">{t("OriginalAmount" as any)}</TableHead>
              <TableHead className="text-end">{t("OutstandingAmount" as any)}</TableHead>
              <TableHead className="text-end">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <AccountingEmptyRow colSpan={7} label={t("NoFinanceCompanyAR" as any)} />
            ) : (
              rows.map((row) => {
                const isOverdue = row.outstandingMinor > 0 && row.dueDate < now;
                return (
                  <TableRow key={row.receivableDocumentId}>
                    <TableCell className="font-medium text-slate-900">
                      {row.financingEntity ?? (
                        <span className="text-slate-400">{t("UnknownFinancier" as any)}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-slate-600">{row.buyerName ?? "—"}</TableCell>
                    <TableCell className="text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        {isOverdue && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />}
                        <bdi className={isOverdue ? "font-medium text-amber-700" : undefined}>
                          {format(new Date(row.dueDate), "MMM d, yyyy")}
                        </bdi>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={STATUS_BADGE_CLASS[row.status as ReceivableStatus]}
                      >
                        {t(`ReceivableStatus_${row.status}` as any)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end tabular-nums text-slate-500">
                      <bdi>{money(row.originalAmountMinor, row.currency, row.scale)}</bdi>
                    </TableCell>
                    <TableCell className="text-end">
                      <bdi
                        className={
                          row.outstandingMinor > 0
                            ? "text-base font-semibold tabular-nums text-slate-900"
                            : "tabular-nums text-slate-400"
                        }
                      >
                        {money(row.outstandingMinor, row.currency, row.scale)}
                      </bdi>
                    </TableCell>
                    <TableCell className="text-end">
                      {activeOrgId && row.hasOwningDeal && row.applicationId ? (
                        // Deliberately the applications list with the deal
                        // deep-linked open, NOT /applications/<id>/deal: the
                        // cockpit reports the deal but does not call
                        // confirmDisbursement, so linking there would promise a
                        // settlement the destination cannot perform (SCRUM-80).
                        <Link
                          href={`/${activeOrgId}/applications?application=${row.applicationId}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-sky-700 hover:text-sky-900 hover:underline"
                        >
                          {t("OpenTheDeal" as any)}
                          <Arrow className="h-3.5 w-3.5 shrink-0" />
                        </Link>
                      ) : (
                        // Says why there is no action instead of rendering an
                        // empty cell that reads like a missing button.
                        <span className="text-xs text-slate-400">{t("NoOwningDeal" as any)}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>

      {status === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => loadMore(50)}>
            {t("LoadMore" as any)}
          </Button>
        </div>
      )}
    </div>
  );
}
