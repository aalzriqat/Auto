"use client";

import { useCallback, useMemo } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { useCurrency } from "@/hooks/useCurrency";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { formatExactMinorAmount } from "@/lib/moneyDisplay";
import {
  DealRowFiguresContext,
  DealsListView,
  type DealRow,
  type RowFigures,
} from "@/components/deals/DealsListView";
import { dealsPaging, mergeDealRows } from "@/components/deals/dealRows";

const PAGE = 100;

/**
 * One row's cockpit facts (`dealListRow.figures`), subscribed only once the
 * row is near the viewport. Per row rather than batched: a change to one deal
 * re-runs that deal's read alone.
 */
function useLiveRowFigures(row: DealRow, enabled: boolean): RowFigures {
  const { activeOrgId } = useOrg();
  const deal =
    row.source.kind === "APPLICATION"
      ? { kind: "APPLICATION" as const, applicationId: row.source.id as Id<"financeApplications"> }
      : { kind: "SALE" as const, saleId: row.source.id as Id<"sales"> };
  return useQuery(api.dealListRow.figures, enabled && activeOrgId ? { orgId: activeOrgId, deal } : "skip");
}

/**
 * Two paginated sources, one list: financed deals from `applications.list`
 * and cash deals from `sales.list` (a sale carrying an `applicationId` is a
 * financed deal already listed by its application and is dropped in the
 * merge). Both paginate on the server; "load more" advances both, and the
 * view labels every count as a count of loaded rows while either can load
 * more. Each row's cockpit facts (photo, step, price, net profit) are read
 * per row by `useLiveRowFigures`.
 */
export function DealsListClient() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const { hasPermission } = usePermissions();
  const currency = useCurrency();

  const applications = usePaginatedQuery(
    api.applications.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: PAGE }
  );
  const sales = usePaginatedQuery(
    api.sales.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: PAGE }
  );

  const rows = useMemo(() => {
    if (!activeOrgId) return undefined;
    if (applications.status === "LoadingFirstPage" || sales.status === "LoadingFirstPage") return undefined;
    return mergeDealRows(applications.results, sales.results, activeOrgId, t, currency.format);
  }, [activeOrgId, applications.results, applications.status, sales.results, sales.status, t, currency]);

  const { complete, canLoadMore, loadingMore } = dealsPaging([applications.status, sales.status]);

  // The same label the list's sale prices carry, so one column never mixes "JOD" and "دينار اردني".
  const formatMinor = useCallback(
    (amountMinor: number, code: string) =>
      `${formatExactMinorAmount(amountMinor, code)} ${code === currency.code ? currency.displayLabel : code}`,
    [currency.code, currency.displayLabel]
  );

  return (
    <DealRowFiguresContext.Provider value={useLiveRowFigures}>
      <DealsListView
        rows={rows}
        loading={rows === undefined}
        canLoadMore={canLoadMore}
        loadingMore={loadingMore}
        complete={complete}
        onLoadMore={() => {
          if (applications.status === "CanLoadMore") applications.loadMore(PAGE);
          if (sales.status === "CanLoadMore") sales.loadMore(PAGE);
        }}
        newDealHref={activeOrgId && hasPermission(PERMISSIONS.CREATE_SALES) ? `/${activeOrgId}/sales` : null}
        t={t}
        locale={locale}
        formatMinor={formatMinor}
      />
    </DealRowFiguresContext.Provider>
  );
}
