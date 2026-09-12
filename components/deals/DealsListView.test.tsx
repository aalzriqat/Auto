// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DealsListView, type DealRow } from "./DealsListView";

const t = (key: string) => key;

function row(overrides: Partial<DealRow> = {}): DealRow {
  return {
    key: "app_1",
    href: "/org1/applications/app_1/deal",
    kind: "FINANCED",
    customerName: "Test Customer",
    vehicleDesc: "2024 Kia Sportage",
    financierLabel: "Jordan Auto Finance",
    statusLabel: "Approved",
    statusTone: "active",
    reason: "READY_FOR_HANDOVER",
    waitingOn: "DEALERSHIP",
    since: Date.UTC(2026, 8, 1),
    salespersonName: "Sales One",
    amountLabel: "15,000 JD",
    ...overrides,
  };
}

const rows: DealRow[] = [
  row(),
  row({ key: "app_2", href: "/org1/applications/app_2/deal", customerName: "Second", reason: "AWAITING_DECISION", waitingOn: "OTHERS", statusLabel: "UnderReview" }),
  row({ key: "sale_1", href: "/org1/sales/sale_1/deal", kind: "CASH", customerName: "Cash Buyer", financierLabel: null, reason: "CASH_PENDING", statusLabel: "SaleStatusPending" }),
  row({ key: "app_3", customerName: "Done", reason: null, waitingOn: "NONE", statusLabel: "Closed", statusTone: "done" }),
];

function renderList(overrides: Partial<React.ComponentProps<typeof DealsListView>> = {}) {
  return render(
    <DealsListView
      rows={rows}
      loading={false}
      canLoadMore={false}
      loadingMore={false}
      onLoadMore={vi.fn()}
      newDealHref="/org1/sales"
      t={t}
      {...overrides}
    />
  );
}

afterEach(cleanup);

describe("the Deals list is a needs-action queue first", () => {
  test("opens on the queue: only rows waiting on the dealership, grouped by reason with counts", () => {
    renderList();
    expect(screen.getByRole("tab", { name: /DealsNeedsAction/ }).getAttribute("aria-selected")).toBe("true");
    const table = screen.getByRole("table");
    expect(within(table).getByText("Test Customer")).toBeTruthy();
    expect(within(table).getByText("Cash Buyer")).toBeTruthy();
    expect(within(table).queryByText("Second")).toBeNull();
    expect(within(table).queryByText("Done")).toBeNull();
    const groups = screen.getByRole("group", { name: "DealsNeedsAction" });
    expect(within(groups).getByRole("button", { name: /ReasonReadyForHandover/ }).textContent).toContain("1");
    expect(within(groups).getByRole("button", { name: /ReasonCashPending/ }).textContent).toContain("1");
  });

  test("a reason group narrows the queue; the other views show the rest; every row links to its deal", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: /ReasonCashPending/ }));
    expect(within(screen.getByRole("table")).queryByText("Test Customer")).toBeNull();
    expect(within(screen.getByRole("table")).getByText("Cash Buyer")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /DealsWaitingOnOthers/ }));
    expect(within(screen.getByRole("table")).getByText("Second")).toBeTruthy();
    expect(within(screen.getByRole("table")).queryByText("Test Customer")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /DealsAll/ }));
    expect(screen.getAllByRole("row")).toHaveLength(5);
    expect(screen.getByRole("link", { name: "OpenDealRow: Cash Buyer" }).getAttribute("href")).toBe("/org1/sales/sale_1/deal");
    expect(screen.getByRole("link", { name: "OpenDealRow: Test Customer" }).getAttribute("href")).toBe(
      "/org1/applications/app_1/deal"
    );
  });

  test("kind chips and search filter; clearing restores", () => {
    renderList();
    fireEvent.click(screen.getByRole("tab", { name: /DealsAll/ }));
    fireEvent.click(screen.getByRole("button", { name: "DealKindCash" }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "SearchDeals" }), { target: { value: "nobody" } });
    expect(screen.getByText("NoDealsFound")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ClearFilters" }));
    expect(screen.getAllByRole("row")).toHaveLength(5);
  });

  test("counts are labelled as counts of LOADED rows whenever more can be loaded", () => {
    renderList({ canLoadMore: true });
    expect(screen.getByRole("tab", { name: /DealsAll/ }).textContent).toContain("4+");
    expect(screen.getByText(/DealsLoadedMoreAvailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "LoadMore" })).toBeTruthy();
    cleanup();
    renderList({ canLoadMore: false });
    expect(screen.getByRole("tab", { name: /DealsAll/ }).textContent).toContain("4");
    expect(screen.getByRole("tab", { name: /DealsAll/ }).textContent).not.toContain("+");
    expect(screen.getByText(/DealsLoadedAll/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "LoadMore" })).toBeNull();
  });

  test("loading, empty queue, and no create permission", () => {
    renderList({ rows: undefined, loading: true, newDealHref: null });
    expect(screen.getByText("LoadingDeals")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /NewDeal/ })).toBeNull();
    cleanup();
    renderList({ rows: [row({ reason: null, waitingOn: "NONE" })] });
    expect(screen.getByText("DealsQueueEmpty")).toBeTruthy();
  });
});
