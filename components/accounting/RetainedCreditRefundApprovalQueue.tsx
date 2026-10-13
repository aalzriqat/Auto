"use client";

import { useId, useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getCodedErrorMessage } from "@/lib/errors";
import { formatMoneyDisplay, moneyDisplayScale } from "@/lib/moneyDisplay";
import { Button } from "@/components/ui/button";

/**
 * SCRUM-831: the approver's queue of customer-credit refund requests (SCRUM-724),
 * mounted on the Approvals page for `approve:requests`. A default MANAGER holds
 * that permission but not `view:finance`, so this reads the narrow approval list,
 * never the finance one. It offers approve and reject only: recording the payout
 * and cancelling stay in the Accounting queue. The server owns every rule,
 * including that the requester cannot decide their own request; the row only
 * avoids offering what would be refused. The list is cursor-paged, so a queue longer
 * than one page is reached with "Load more" rather than silently cut off; a failed
 * read throws to the page's error boundary.
 */
const PAGE_SIZE = 25;

export function RetainedCreditRefundApprovalQueue({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const { t, locale } = useLanguage();
  const command = useCommandIdentity();
  const { results: requests, status, loadMore } = usePaginatedQuery(
    api.retainedCreditRefunds.listRetainedCreditRefundApprovalQueue,
    { orgId },
    { initialNumItems: PAGE_SIZE },
  );
  const respond = useMutation(api.retainedCreditRefunds.respondToRetainedCreditRefund);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pausedNoteId = useId();

  if (status === "LoadingFirstPage") {
    return (
      <output aria-busy="true" data-testid="refund-approval-loading"
        className="flex items-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t("RefundApprovalQueueLoading")}
      </output>
    );
  }

  // Reported on every row by the server; one dark row means the pilot switch is on.
  const payoutAvailable = requests.every((row) => row.payoutAvailable);
  const dateFormat = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    dateStyle: "medium", numberingSystem: "latn",
  });

  async function onDecide(requestId: Id<"retainedCreditRefundRequests">, decision: "APPROVED" | "REJECTED") {
    if (busyId || (decision === "APPROVED" && !payoutAvailable)) return;
    setBusyId(requestId);
    const intent = `retained-refund-decide:${requestId}:${decision}`;
    try {
      await respond({ orgId, requestId, status: decision, idempotencyKey: command.for(intent) });
      command.retire(intent);
      toast.success(t(decision === "APPROVED" ? "RetainedCreditRefundApproved" : "RetainedCreditRefundRejected"));
    } catch (error) {
      // A coded refusal in the user's language, else the queue's own message: never server English.
      toast.error(getCodedErrorMessage(error, t) ?? t("RetainedCreditRefundActionFailed"));
    } finally { setBusyId(null); }
  }

  return (
    <section className="space-y-3 rounded-lg border border-amber-500/40 p-4"
      aria-label={t("RefundApprovalQueueTitle")} data-testid="refund-approval-queue">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("RefundApprovalQueueTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("RefundApprovalQueueDesc")}</p>
      </div>
      {requests.length > 0 && !payoutAvailable && (
        <p id={pausedNoteId} role="note" data-testid="refund-approval-paused"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {t("RefundApprovalPaused")}
        </p>
      )}
      {requests.length === 0 ? (
        // A page can come back short of its size before the end; only the end proves "empty".
        status === "Exhausted" && (
          <p className="text-sm text-muted-foreground" data-testid="refund-approval-empty">
            {t("RefundApprovalQueueEmpty")}
          </p>
        )
      ) : (
        <ul className="divide-y">
          {requests.map((row) => (
            <li key={row._id} data-testid="refund-approval-row"
              className="flex flex-col gap-3 py-3 text-sm sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold tabular-nums">
                    {formatMoneyDisplay(row.amountMinor / 10 ** moneyDisplayScale(row.currency), row.currency, locale)}
                  </span>
                  <span className="font-medium">{row.customerName ?? "-"}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(row.method === "CASH" ? "MethodCash" : "MethodBankTransfer")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {row.sourceChequeLabel && <>
                    {t("RetainedCreditFromCheque")} <bdi dir="ltr">{row.sourceChequeLabel}</bdi>
                    {row.originatingSaleStatus === "CANCELLED" && <> · {t("RetainedCreditSaleCancelled")}</>}
                    {" · "}
                  </>}
                  {t("RefundApprovalRequestedBy")} {row.requestedByName ?? "-"}{" "}
                  {t("RefundApprovalRequestedOn")} {dateFormat.format(new Date(row.createdAt))}
                </p>
                <p className="break-words" dir="auto">
                  <span className="text-xs text-muted-foreground">{t("RetainedCreditRefundReason")}: </span>
                  <bdi>{row.reason}</bdi>
                </p>
              </div>
              {row.requestedByMe ? (
                <p className="text-xs text-muted-foreground sm:max-w-56" data-testid="refund-approval-own-request">
                  {t("RefundApprovalOwnRequest")}
                </p>
              ) : (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" className="flex-1 sm:flex-none"
                    disabled={!!busyId || !payoutAvailable}
                    aria-describedby={payoutAvailable ? undefined : pausedNoteId}
                    onClick={() => onDecide(row._id, "APPROVED")}>{t("Approve")}</Button>
                  <Button size="sm" variant="outline" className="flex-1 sm:flex-none"
                    disabled={!!busyId}
                    onClick={() => onDecide(row._id, "REJECTED")}>{t("Reject")}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {status !== "Exhausted" && (
        <Button type="button" size="sm" variant="outline" data-testid="refund-approval-load-more"
          disabled={status === "LoadingMore"} aria-busy={status === "LoadingMore"}
          onClick={() => loadMore(PAGE_SIZE)}>
          {status === "LoadingMore" && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {t(status === "LoadingMore" ? "RefundApprovalLoadingMore" : "RefundApprovalLoadMore")}
        </Button>
      )}
    </section>
  );
}
