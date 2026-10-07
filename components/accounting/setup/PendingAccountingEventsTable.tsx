import { Loader2, RotateCw } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountingEmptyRow, AccountingTableFrame } from "../AccountingTabShared";
import type { PendingEventSummary, Translate } from "./types";
import { formatAccountingDate } from "./types";

type PendingAccountingEventsTableProps = {
  events: readonly PendingEventSummary[];
  hasMore: boolean;
  canManageFinance?: boolean;
  busyAction?: string | null;
  t: Translate;
  onRetry?: (eventId: Id<"pendingAccountingEvents">) => void;
  /** Present only while more FAILED rows can be paged in. */
  onLoadMoreFailed?: () => void;
  loadingMoreFailed?: boolean;
};

function eventLabel(event: PendingEventSummary): string {
  return event.eventType ?? event.kind;
}

export function PendingAccountingEventsTable({
  events,
  hasMore,
  canManageFinance,
  busyAction,
  t,
  onRetry,
  onLoadMoreFailed,
  loadingMoreFailed,
}: Readonly<PendingAccountingEventsTableProps>) {
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-foreground">{t("PendingAccountingEvents")}</h3>
      <AccountingTableFrame>
        <Table className="min-w-[48rem]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("Event")}</TableHead>
              <TableHead>{t("Source")}</TableHead>
              <TableHead>{t("AccountingDate")}</TableHead>
              <TableHead>{t("Attempts")}</TableHead>
              <TableHead>{t("Reason")}</TableHead>
              {canManageFinance && onRetry && <TableHead className="text-right">{t("Actions")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <AccountingEmptyRow colSpan={canManageFinance && onRetry ? 6 : 5} label={t("NoPendingAccountingEvents")} />
            ) : (
              events.map((event) => {
                // Only a dead-lettered row can be retried; a PENDING row with
                // attempts is still in flight and the server refuses it. A
                // FAILED row for a retired posting is refused too, and the
                // server says so via `retryable`.
                const isFailed = event.status === "FAILED";
                const canRetry = isFailed && event.retryable === true;
                const busy = busyAction === `retry_${event._id}`;
                return (
                  <TableRow key={event._id}>
                    <TableCell className="font-medium">
                      {eventLabel(event)}{" "}
                      <Badge variant={isFailed ? "destructive" : "outline"} className="ms-1">
                        {isFailed ? t("AccountingEventStatusFailed" as any) : t("AccountingEventStatusPending" as any)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {event.sourceType}: {event.sourceId}
                    </TableCell>
                    <TableCell>{formatAccountingDate(event.accountingDate)}</TableCell>
                    <TableCell>{event.attempts}</TableCell>
                    <TableCell className="max-w-[360px] truncate" title={event.reason}>
                      {event.reason ?? t("PendingAccountingEvent")}
                    </TableCell>
                    {canManageFinance && onRetry && (
                      <TableCell className="text-right">
                        {canRetry && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(t("ConfirmRetryFailedOutbox" as any))) {
                                onRetry(event._id);
                              }
                            }}
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                            {t("RetryEvent" as any)}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>
      {onLoadMoreFailed && (
        <Button size="sm" variant="outline" disabled={loadingMoreFailed} onClick={onLoadMoreFailed}>
          {loadingMoreFailed && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("LoadMore")}
        </Button>
      )}
      {hasMore && <p className="text-xs text-muted-foreground">{t("MorePendingAccountingEvents")}</p>}
    </div>
  );
}
