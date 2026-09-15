import { format } from "date-fns";
import type { Id } from "@/convex/_generated/dataModel";
import { dateInputToUtcMs, dateInputEndToUtcMs } from "@/lib/dateInput";

export type Translate = (key: string) => string;

export type PeriodStatus = "FUTURE" | "OPEN" | "CLOSING" | "CLOSED" | "LOCKED";

export type PeriodSummary = {
  _id: Id<"accountingPeriods">;
  fiscalYear: number;
  periodNumber: number;
  startDate: number;
  endDate: number;
  status: PeriodStatus;
};

export type PendingEventSummary = {
  _id: Id<"pendingAccountingEvents">;
  kind: "POST" | "REVERSE";
  eventType?: string;
  sourceType: string;
  sourceId: string;
  accountingDate: number;
  attempts: number;
  createdAt: number;
  reason?: string;
};

export type PeriodFormState = {
  fiscalYear: string;
  periodNumber: string;
  startDate: string;
  endDate: string;
  openImmediately: boolean;
};

export function defaultPeriodForm(): PeriodFormState {
  const year = new Date().getFullYear();
  return {
    fiscalYear: String(year),
    periodNumber: "1",
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    openImmediately: true,
  };
}

// UTC boundaries (lib/dateInput.ts). These bound accounting PERIODS and
// financial-report ranges, so a local-time parse would have set a Jordan user's
// "2026-01-01" period to start on 2025-12-31 21:00Z — the previous fiscal year.
export function dateInputToStartOfDayMs(value: string): number {
  return dateInputToUtcMs(value);
}

export function dateInputToEndOfDayMs(value: string): number {
  return dateInputEndToUtcMs(value);
}

export function formatAccountingDate(value: number): string {
  return format(new Date(value), "MMM d, yyyy");
}

export function periodLabel(period: PeriodSummary): string {
  return `${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`;
}

export function periodStatusClassName(status: PeriodStatus): string {
  if (status === "OPEN") return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (status === "FUTURE") return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300";
  if (status === "CLOSED") return "border-border bg-muted text-muted-foreground";
  if (status === "LOCKED") return "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";
  return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
}
