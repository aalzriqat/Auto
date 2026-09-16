"use client";

import Link from "next/link";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AccountingEmptyRow,
  AccountingTableFrame,
  LoadingAccountingState,
} from "./AccountingTabShared";

const STATUS_CLASS: Record<string, string> = {
  OPEN: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  PARTIALLY_PAID: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  PAID: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  WRITTEN_OFF: "border-border bg-muted text-muted-foreground",
  CANCELLED: "border-border bg-muted text-muted-foreground",
  REVERSED: "border-border bg-muted text-muted-foreground",
};

function formatMinor(amountMinor: number, currency: string, scale: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(amountMinor / Math.pow(10, scale));
}

/**
 * Authoritative finance-company receivables work queue.
 *
 * The retired `claims` table used to be mounted here with New / Settle /
 * Reject controls even though every writer deliberately refuses. This view is
 * read-only because collection and settlement belong to the originating deal;
 * its action opens that deal instead of creating a second financial authority.
 */
export function ClaimsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission } = usePermissions();
  const canViewDeals = hasPermission(PERMISSIONS.VIEW_SALES);
  const { results: receivables, status, loadMore } = usePaginatedQuery(
    api.claims.paginateFinanceCompanyReceivables,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 75 }
  );

  if (!activeOrgId) return null;
  if (status === "LoadingFirstPage") {
    return <LoadingAccountingState label={t("LoadingClaims" as any)} />;
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t("FinanceCompanyReceivables" as any)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("FinanceCompanyReceivablesDesc" as any)}
        </p>
      </div>

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("DocumentNumber" as any)}</TableHead>
              <TableHead>{t("FinancingEntity" as any)}</TableHead>
              <TableHead>{t("BuyerName" as any)}</TableHead>
              <TableHead>{t("DueDate" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-right">{t("OriginalAmount" as any)}</TableHead>
              <TableHead className="text-right">{t("CollectionOutstanding" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receivables.length === 0 ? (
              <AccountingEmptyRow colSpan={8} label={t("NoClaimsFound" as any)} />
            ) : (
              receivables.map((row) => (
                <TableRow key={row.receivableDocumentId}>
                  <TableCell className="font-medium">{row.documentNumber}</TableCell>
                  <TableCell>{row.financingEntity ?? "—"}</TableCell>
                  <TableCell>{row.buyerName ?? "—"}</TableCell>
                  <TableCell>{new Date(row.dueDate).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={STATUS_CLASS[row.status] ?? STATUS_CLASS.CANCELLED}>
                      {row.status.replaceAll("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMinor(row.originalAmountMinor, row.currency, row.scale)}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatMinor(row.outstandingMinor, row.currency, row.scale)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canViewDeals && row.applicationId ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/${activeOrgId}/applications/${row.applicationId}/deal`}>
                          {t("OpenDeal" as any)}
                        </Link>
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>
      {status === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={() => loadMore(75)}>
            {t("LoadMore" as any)}
          </Button>
        </div>
      )}
    </div>
  );
}
