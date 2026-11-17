"use client";

import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { CashNoCostAction } from "./CashNoCostCloseout";

const PAGE_SIZE = 10;

export function CashNoCostApprovalQueue({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const { t } = useLanguage();
  const { results, status, loadMore } = usePaginatedQuery(
    api.cashDealCloseout.listPendingNoCostConfirmations, { orgId }, { initialNumItems: PAGE_SIZE },
  );
  if (status === "LoadingFirstPage") {
    return <output aria-busy="true">{t("CashNoCostQueueLoading")}</output>;
  }
  return (
    <section aria-label={t("CashNoCostQueueTitle")} className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">{t("CashNoCostQueueTitle")}</h3>
      {results.length === 0 && status === "Exhausted" && (
        <p className="text-sm text-muted-foreground">{t("CashNoCostQueueEmpty")}</p>
      )}
      <ul className="space-y-3">
        {results.map((row) => (
          <li key={row.applicationId} className="min-w-0 space-y-2">
            <bdi dir="ltr" className="font-medium">{row.dealReference}</bdi>
            <CashNoCostAction orgId={orgId} applicationId={row.applicationId} t={t}
              closeout={{ state: "AWAITING_APPROVAL", canDeclare: false, confirmVersion: row.confirmVersion }} />
          </li>
        ))}
      </ul>
      {status !== "Exhausted" && (
        <Button type="button" size="sm" variant="outline" disabled={status === "LoadingMore"}
          aria-busy={status === "LoadingMore"} onClick={() => loadMore(PAGE_SIZE)}>
          {t(status === "LoadingMore" ? "CashNoCostQueueLoading" : "RefundApprovalLoadMore")}
        </Button>
      )}
    </section>
  );
}
