/**
 * SCRUM-265: a Collections figure built from a capped backend read is never shown as exact.
 * The backend reports `incomplete`; the screen must say so next to the number, and say nothing
 * when the read was complete. Real CollectionsTab, stubbed Convex results.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: () => true }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) => `${n} JOD`,
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("@/components/accounting/collections/CashDrawerPanel", () => ({ CashDrawerPanel: () => null }));
vi.mock("@/components/accounting/collections/PaymentLinksPanel", () => ({ PaymentLinksPanel: () => null }));
vi.mock("@/components/accounting/collections/InstallmentCalendar", () => ({ InstallmentCalendar: () => null }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      return stubs.queryResults.get(getFunctionName(reference));
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }),
    useMutation: () => vi.fn().mockResolvedValue(null),
  };
});

import { CollectionsTab } from "./CollectionsTab";

const summary = (incomplete: Record<string, boolean>) => ({
  totalOutstanding: 10, overdueOutstanding: 1, dueToday: 2, collectedToday: 3, upcomingChequeTotal: 4,
  incomplete,
});

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
});

describe("Collections incomplete totals", () => {
  test("marks only the summary figures whose read was capped", () => {
    stubs.queryResults.set(
      "collections:summary",
      summary({ receivables: true, collectedToday: false, upcomingCheques: false }),
    );
    render(<CollectionsTab />);
    // Outstanding, overdue and due today all come from the receivables read.
    expect(screen.getAllByText("CollectionMetricIncomplete")).toHaveLength(3);
    expect(screen.queryByText("CollectionMetricIncompleteNet")).toBeNull();
  });

  test("the collected-today figure nets refunds, so its capped tile is partial and never an at-least claim", () => {
    stubs.queryResults.set(
      "collections:summary",
      summary({ receivables: false, collectedToday: true, upcomingCheques: false }),
    );
    render(<CollectionsTab />);
    expect(screen.getAllByText("CollectionMetricIncompleteNet")).toHaveLength(1);
    expect(screen.queryByText("CollectionMetricIncomplete")).toBeNull();
  });

  test("says nothing when every read was complete, and for a backend that does not report it", () => {
    stubs.queryResults.set(
      "collections:summary",
      summary({ receivables: false, collectedToday: false, upcomingCheques: false }),
    );
    const { unmount } = render(<CollectionsTab />);
    expect(screen.queryByText("CollectionMetricIncomplete")).toBeNull();
    unmount();

    stubs.queryResults.set("collections:summary", {
      totalOutstanding: 10, overdueOutstanding: 1, dueToday: 2, collectedToday: 3, upcomingChequeTotal: 4,
    });
    render(<CollectionsTab />);
    expect(screen.queryByText("CollectionMetricIncomplete")).toBeNull();
  });

  test("the reports tab warns under each report that stopped at its cap", async () => {
    stubs.queryResults.set("collections:summary", summary({ receivables: false, collectedToday: false, upcomingCheques: false }));
    stubs.queryResults.set("collections:dailyCollectionList", { total: 5, totalsByMethod: { CASH: 5 }, rows: [], incomplete: true });
    stubs.queryResults.set("collections:upcomingChequeReport", { total: 0, rows: [], incomplete: true });
    stubs.queryResults.set("collections:agingReport", {
      current: { count: 0, amount: 0 }, days1To30: { count: 0, amount: 0 }, days31To60: { count: 0, amount: 0 },
      days61To90: { count: 0, amount: 0 }, over90: { count: 0, amount: 0 }, incomplete: true,
    });
    render(<CollectionsTab />);
    const tab = screen.getByRole("tab", { name: "Reports" });
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
    fireEvent.focus(tab);
    // Cheques and aging cannot be negative, so they keep the lower-bound wording; the daily
    // collections report subtracts refunds, so it gets the neutral partial wording.
    const lowerBound = await screen.findAllByText("CollectionReportIncomplete", undefined, { timeout: 3000 });
    expect(lowerBound).toHaveLength(2);
    const net = await screen.findAllByText("CollectionReportIncompleteNet", undefined, { timeout: 3000 });
    expect(net).toHaveLength(1);
    for (const notice of [...lowerBound, ...net]) expect(notice.getAttribute("role")).toBe("alert");
  });
});
