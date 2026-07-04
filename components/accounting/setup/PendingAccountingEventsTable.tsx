import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountingEmptyRow, AccountingTableFrame } from "../AccountingTabShared";
import type { PendingEventSummary, Translate } from "./types";
import { formatAccountingDate } from "./types";

type PendingAccountingEventsTableProps = {
  events: readonly PendingEventSummary[];
  hasMore: boolean;
  t: Translate;
};

function eventLabel(event: PendingEventSummary): string {
  return event.eventType ?? event.kind;
}

export function PendingAccountingEventsTable({
  events,
  hasMore,
  t,
}: Readonly<PendingAccountingEventsTableProps>) {
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-slate-900">{t("PendingAccountingEvents")}</h3>
      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("Event")}</TableHead>
              <TableHead>{t("Source")}</TableHead>
              <TableHead>{t("AccountingDate")}</TableHead>
              <TableHead>{t("Attempts")}</TableHead>
              <TableHead>{t("Reason")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <AccountingEmptyRow colSpan={5} label={t("NoPendingAccountingEvents")} />
            ) : (
              events.map((event) => (
                <TableRow key={event._id}>
                  <TableCell className="font-medium">{eventLabel(event)}</TableCell>
                  <TableCell>
                    {event.sourceType}: {event.sourceId}
                  </TableCell>
                  <TableCell>{formatAccountingDate(event.accountingDate)}</TableCell>
                  <TableCell>{event.attempts}</TableCell>
                  <TableCell className="max-w-[360px] truncate" title={event.reason}>
                    {event.reason ?? t("PendingAccountingEvent")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>
      {hasMore && <p className="text-xs text-slate-500">{t("MorePendingAccountingEvents")}</p>}
    </div>
  );
}
