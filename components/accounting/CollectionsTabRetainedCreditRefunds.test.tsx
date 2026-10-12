/**
 * SCRUM-724: every step of the customer-credit refund lifecycle (request ->
 * approve -> pay out) must be reachable in Collections by an actor holding
 * exactly the backend permission that step needs, under the DEFAULT role
 * templates: ACCOUNTANT has MANAGE_FINANCE but not APPROVE_REQUESTS; MANAGER has
 * APPROVE_REQUESTS but not MANAGE_FINANCE.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  permissions: new Set<string>(),
  queryResults: new Map<string, unknown>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: (p: string) => stubs.permissions.has(p) }),
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
      const value = stubs.queryResults.get(getFunctionName(reference));
      return typeof value === "function" ? (value as (a: unknown) => unknown)(args) : value;
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }),
    useMutation: () => vi.fn(),
  };
});

import { CollectionsTab } from "./CollectionsTab";

const ACCOUNTANT = ["view:finance", "manage:finance"];
const MANAGER = ["view:finance", "approve:requests"];

const refundRow = (over: Record<string, unknown>) => ({
  _id: "r1", orgId: "org1", amountMinor: 1200, currency: "JOD", customerName: "Layla Haddad",
  sourceChequeLabel: "Arab Bank #004512", originatingSaleStatus: "CANCELLED",
  requestedByMe: false, ...over,
});

function seedRefunds(rows: Array<Record<string, unknown>>) {
  stubs.queryResults.set("collections:summary", {
    totalOutstanding: 0, overdueOutstanding: 0, dueToday: 0, collectedToday: 0, upcomingChequeTotal: 0,
  });
  stubs.queryResults.set("retainedCreditRefunds:listRetainedCreditRefundRequests",
    (args: { status?: string }) => rows.filter((row) => row.status === args.status));
}

async function openApprovals(permissions: string[]) {
  stubs.permissions = new Set(permissions);
  render(<CollectionsTab />);
  const tab = screen.getByRole("tab", { name: "Approvals" });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.focus(tab);
  await screen.findByTestId("retained-credit-refunds", undefined, { timeout: 3000 });
}

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.permissions = new Set();
});

describe("Collections, refund lifecycle reachable under default roles", () => {
  test("ACCOUNTANT-like (MANAGE_FINANCE, no APPROVE_REQUESTS) sees the APPROVED request and the payout action, no approve/reject", async () => {
    seedRefunds([refundRow({ status: "APPROVED" }), refundRow({ _id: "r2", status: "PENDING" })]);
    await openApprovals(ACCOUNTANT);
    expect(screen.getByRole("button", { name: "RetainedCreditExecute" })).toBeTruthy();
    expect(screen.getByLabelText("RetainedCreditPayoutReference")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    // The collection-approval table stays an approver-only surface.
    expect(screen.queryByText("NoPendingCollectionApprovals")).toBeNull();
  });

  test("MANAGER-like (APPROVE_REQUESTS, no MANAGE_FINANCE) can approve and reject a PENDING request but cannot pay out", async () => {
    seedRefunds([refundRow({ status: "PENDING" }), refundRow({ _id: "r2", status: "APPROVED" })]);
    await openApprovals(MANAGER);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "RetainedCreditExecute" })).toBeNull();
    expect(screen.getByText("NoPendingCollectionApprovals")).toBeTruthy();
  });

  test("a requester never sees approve/reject on their own request, even holding APPROVE_REQUESTS", async () => {
    seedRefunds([refundRow({ status: "PENDING", requestedByMe: true })]);
    await openApprovals([...ACCOUNTANT, "approve:requests"]);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  test("a view-only user gets no Approvals tab", () => {
    seedRefunds([]);
    stubs.permissions = new Set(["view:finance"]);
    render(<CollectionsTab />);
    expect(screen.queryByRole("tab", { name: "Approvals" })).toBeNull();
  });
});
