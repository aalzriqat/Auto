import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { PendingAccountingEventsTable } from "./PendingAccountingEventsTable";
import type { PendingEventSummary } from "./types";

afterEach(cleanup);

const event = (id: string, status: string, attempts: number): PendingEventSummary => ({
  _id: id as Id<"pendingAccountingEvents">,
  kind: "POST",
  status,
  eventType: `EVT_${id}`,
  sourceType: "expenses",
  sourceId: id,
  accountingDate: 1_700_000_000_000,
  attempts,
  createdAt: 1,
  reason: `reason_${id}`,
});

const t = (key: string) => key;

describe("SCRUM-226 — Retry is offered only on FAILED rows", () => {
  test("FAILED gets a Retry button; PENDING with attempts>0 does not", () => {
    const onRetry = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <PendingAccountingEventsTable
        events={[event("dead", "FAILED", 10), event("flaky", "PENDING", 3)]}
        hasMore={false}
        canManageFinance
        t={t as never}
        onRetry={onRetry}
      />
    );

    const buttons = screen.getAllByRole("button", { name: /RetryEvent/ });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText("EVT_dead")).toBeTruthy();
    expect(screen.getByText("EVT_flaky")).toBeTruthy();
    fireEvent.click(buttons[0]);
    expect(onRetry).toHaveBeenCalledWith("dead");
  });

  test("FAILED and PENDING rows are visibly labelled differently", () => {
    render(
      <PendingAccountingEventsTable
        events={[event("dead", "FAILED", 10), event("flaky", "PENDING", 3)]}
        hasMore={false}
        canManageFinance
        t={t as never}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText("AccountingEventStatusFailed")).toBeTruthy();
    expect(screen.getByText("AccountingEventStatusPending")).toBeTruthy();
  });
});
