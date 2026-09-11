"use client";

import { useMemo } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { useCurrency } from "@/hooks/useCurrency";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { DealsListView } from "@/components/deals/DealsListView";
import { mergeDealRows } from "@/components/deals/dealRows";

const PAGE = 100;

/**
 * Two paginated sources, one list: financed deals from `applications.list`
 * and cash deals from `sales.list` (a sale carrying an `applicationId` is a
 * financed deal already listed by its application and is dropped in the
 * merge). Both paginate on the server; "load more" advances both, and the
 * view labels every count as a count of loaded rows while either can load
 * more.
 */
export function DealsListClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
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

  const canLoadMore = applications.status === "CanLoadMore" || sales.status === "CanLoadMore";
  const loadingMore = applications.status === "LoadingMore" || sales.status === "LoadingMore";

  return (
    <DealsListView
      rows={rows}
      loading={rows === undefined}
      canLoadMore={canLoadMore}
      loadingMore={loadingMore}
      onLoadMore={() => {
        if (applications.status === "CanLoadMore") applications.loadMore(PAGE);
        if (sales.status === "CanLoadMore") sales.loadMore(PAGE);
      }}
      newDealHref={activeOrgId && hasPermission(PERMISSIONS.CREATE_SALES) ? `/${activeOrgId}/sales` : null}
      t={t}
    />
  );
}
