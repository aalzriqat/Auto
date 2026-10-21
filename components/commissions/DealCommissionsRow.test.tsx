import { afterEach, describe, expect, test, vi, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

const useQueryMock = vi.fn();
vi.mock("convex/react", () => ({ useQuery: (...args: unknown[]) => useQueryMock(...args) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: (p: string) => permissions.includes(p) }),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { DealCommissionsRow } from "./DealCommissionsRow";

let permissions: string[] = ["view:commissions"];
const t = (key: string) => key;
const money = (minor: number) => `${(minor / 1000).toFixed(3)} JOD`;
const orgId = "org1" as never;
const saleId = "sale1" as never;

const view = (over: Record<string, unknown> = {}) => ({
  currency: "JOD",
  saleStatus: "COMPLETED",
  salesperson: { employeeId: "u1", employeeName: "Sam", amountMinor: 50_000 },
  salePending: false,
  lines: [
    { id: "l1", kind: "PURCHASE", employeeId: "u2", employeeName: "Buyer", amountMinor: 50_000, currency: "JOD", note: null },
    { id: "l2", kind: "EXECUTION", employeeId: "u3", employeeName: "Exec", amountMinor: 25_000, currency: "JOD", note: null },
  ],
  totalMinor: 125_000,
  canManage: true,
  writesEnabled: true,
  ...over,
});

// vitest runs without globals, so RTL does not auto-unmount between tests;
// without this the DOM leaks and getByText finds duplicates under shuffle.
afterEach(cleanup);

beforeEach(() => {
  permissions = ["view:commissions"];
  useQueryMock.mockReset();
});

describe("DealCommissionsRow", () => {
  test("shows the total collapsed, the breakdown on demand, and profit less commissions", () => {
    useQueryMock.mockReturnValue(view());
    render(<DealCommissionsRow orgId={orgId} saleId={saleId} profitMinor={1_000_000} money={money} t={t} />);
    expect(screen.getByText("125.000 JOD")).toBeTruthy();
    expect(screen.getByText("875.000 JOD")).toBeTruthy();
    expect(screen.queryByText("DealCommissionKindPURCHASE")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("DealCommissionKindPURCHASE")).toBeTruthy();
    expect(screen.getByText("DealCommissionKindEXECUTION")).toBeTruthy();
  });

  test("an unknown profit gives no net figure", () => {
    useQueryMock.mockReturnValue(view());
    render(<DealCommissionsRow orgId={orgId} saleId={saleId} profitMinor={null} money={money} t={t} />);
    expect(screen.getByText("DealCommissionsNetUnavailable")).toBeTruthy();
  });

  test("an undecided salesperson commission is flagged as incomplete", () => {
    useQueryMock.mockReturnValue(view({ salePending: true, salesperson: { employeeId: "u1", employeeName: "Sam", amountMinor: null } }));
    render(<DealCommissionsRow orgId={orgId} saleId={saleId} profitMinor={1_000_000} money={money} t={t} />);
    expect(screen.getByText("DealCommissionsPendingSale")).toBeTruthy();
    // Unknown is not zero: no net figure while the salesperson's commission is undecided.
    expect(screen.getByText("DealCommissionsNetPending")).toBeTruthy();
  });

  test("a caller without view:commissions sees nothing and runs no query", () => {
    permissions = [];
    useQueryMock.mockReturnValue(undefined);
    const { container } = render(<DealCommissionsRow orgId={orgId} saleId={saleId} profitMinor={1} money={money} t={t} />);
    expect(container.innerHTML).toBe("");
    expect(useQueryMock.mock.calls[0][1]).toBe("skip");
  });
});
