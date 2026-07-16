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
