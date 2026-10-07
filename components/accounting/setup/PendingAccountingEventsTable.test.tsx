import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { PendingAccountingEventsTable } from "./PendingAccountingEventsTable";
import type { PendingEventSummary } from "./types";

afterEach(cleanup);

const event = (id: string, status: string, attempts: number, retryable?: boolean): PendingEventSummary => ({
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
  retryable,
});

const t = (key: string) => key;

function renderTable(events: PendingEventSummary[], onRetry = vi.fn()) {
  render(
    <PendingAccountingEventsTable events={events} hasMore={false} canManageFinance t={t as never} onRetry={onRetry} />
  );
  return onRetry;
}

describe("SCRUM-226 — Retry is offered only on retryable FAILED rows", () => {
  test("FAILED gets a Retry button; PENDING with attempts>0 does not", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRetry = renderTable([event("dead", "FAILED", 10, true), event("flaky", "PENDING", 3)]);

    const buttons = screen.getAllByRole("button", { name: /RetryEvent/ });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText("EVT_dead")).toBeTruthy();
    expect(screen.getByText("EVT_flaky")).toBeTruthy();
    fireEvent.click(buttons[0]);
    expect(onRetry).toHaveBeenCalledWith("dead");
  });

  test("a FAILED row the server says is not retryable (retired posting) has no Retry button", () => {
    renderTable([event("retired", "FAILED", 10, false)]);

    expect(screen.getByText("EVT_retired")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /RetryEvent/ })).toHaveLength(0);
  });

  test("SCRUM-226-1: Load more is shown only while more FAILED rows can be paged in", () => {
    const onLoadMoreFailed = vi.fn();
    const { rerender } = render(
      <PendingAccountingEventsTable
        events={[event("dead", "FAILED", 10, true)]}
        hasMore={false}
        canManageFinance
        t={t as never}
        onRetry={vi.fn()}
        onLoadMoreFailed={onLoadMoreFailed}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /LoadMore/ }));
    expect(onLoadMoreFailed).toHaveBeenCalledTimes(1);

    rerender(
      <PendingAccountingEventsTable
        events={[event("dead", "FAILED", 10, true)]}
        hasMore={false}
        canManageFinance
        t={t as never}
        onRetry={vi.fn()}
        onLoadMoreFailed={onLoadMoreFailed}
        loadingMoreFailed
      />
    );
    expect((screen.getByRole("button", { name: /LoadMore/ }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <PendingAccountingEventsTable events={[event("dead", "FAILED", 10, true)]} hasMore={false} canManageFinance t={t as never} onRetry={vi.fn()} />
    );
    expect(screen.queryByRole("button", { name: /LoadMore/ })).toBeNull();
  });

  test("FAILED and PENDING rows are visibly labelled differently", () => {
    renderTable([event("dead", "FAILED", 10, true), event("flaky", "PENDING", 3)]);

    expect(screen.getByText("AccountingEventStatusFailed")).toBeTruthy();
    expect(screen.getByText("AccountingEventStatusPending")).toBeTruthy();
  });
});
