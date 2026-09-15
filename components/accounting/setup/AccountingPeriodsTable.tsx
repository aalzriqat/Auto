import { Loader2, Play } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountingEmptyRow, AccountingTableFrame } from "../AccountingTabShared";
import type { PeriodStatus, PeriodSummary, Translate } from "./types";
import { formatAccountingDate, periodLabel } from "./types";

type AccountingPeriodsTableProps = {
  periods: readonly PeriodSummary[];
  canManageFinance: boolean;
  /**
   * Locking is irreversible and needs the narrower reopen:accounting_periods
   * grant, so it is gated separately from the rest of the period actions —
   * a plain MANAGE_FINANCE holder sees Open and Close but not Lock. The backend
   * is still the authority; this only avoids offering an action that would fail.
   */
  canLockPeriod: boolean;
  busyAction: string | null;
  t: Translate;
  onOpen: (periodId: Id<"accountingPeriods">) => void;
  onClose: (periodId: Id<"accountingPeriods">) => void;
  onLock: (periodId: Id<"accountingPeriods">) => void;
};

function periodStatusClassName(status: PeriodStatus): string {
  if (status === "OPEN") return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (status === "FUTURE") return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300";
  if (status === "CLOSED") return "border-border bg-muted text-muted-foreground";
  if (status === "LOCKED") return "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";
  return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
}

function periodBusyAction(periodId: Id<"accountingPeriods">, action: "open" | "close" | "lock") {
  return `${action}_${periodId}`;
}

function PeriodActionButton({
  period,
  busy,
  canLockPeriod,
  t,
  onOpen,
  onClose,
  onLock,
}: Readonly<{
  period: PeriodSummary;
  busy: boolean;
  canLockPeriod: boolean;
  t: Translate;
  onOpen: () => void;
  onClose: () => void;
  onLock: () => void;
}>) {
  if (period.status === "FUTURE" || period.status === "CLOSING") {
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={onOpen}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {t("OpenPeriod")}
      </Button>
    );
  }
  if (period.status === "OPEN") {
    return (
      <Button size="sm" disabled={busy} onClick={onClose}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {t("ClosePeriod")}
      </Button>
    );
  }
  if (period.status === "CLOSED") {
    if (!canLockPeriod) return null;
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={onLock}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {t("LockPeriod")}
      </Button>
    );
  }
  return null;
}

function periodActionIsBusy(periodId: Id<"accountingPeriods">, busyAction: string | null): boolean {
  return (
    busyAction === periodBusyAction(periodId, "open") ||
    busyAction === periodBusyAction(periodId, "close") ||
    busyAction === periodBusyAction(periodId, "lock")
  );
}

export function accountingPeriodActionKey(periodId: Id<"accountingPeriods">, action: "open" | "close" | "lock") {
  return periodBusyAction(periodId, action);
}

export function AccountingPeriodsTable({
  periods,
  canManageFinance,
  canLockPeriod,
  busyAction,
  t,
  onOpen,
  onClose,
  onLock,
}: Readonly<AccountingPeriodsTableProps>) {
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-foreground">{t("AccountingPeriods")}</h3>
      <AccountingTableFrame>
        <Table className="min-w-[38rem]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("Period")}</TableHead>
              <TableHead>{t("DateRange")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead className="text-right">{t("Actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.length === 0 ? (
              <AccountingEmptyRow colSpan={4} label={t("NoAccountingPeriods")} />
            ) : (
              periods.map((period) => (
                <TableRow key={period._id}>
                  <TableCell className="font-medium whitespace-nowrap">{periodLabel(period)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatAccountingDate(period.startDate)} - {formatAccountingDate(period.endDate)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={periodStatusClassName(period.status)}>
                      {t(`PeriodStatus_${period.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {canManageFinance && (
                      <PeriodActionButton
                        period={period}
                        busy={periodActionIsBusy(period._id, busyAction)}
                        canLockPeriod={canLockPeriod}
                        t={t}
                        onOpen={() => onOpen(period._id)}
                        onClose={() => onClose(period._id)}
                        onLock={() => onLock(period._id)}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>
    </div>
  );
}
