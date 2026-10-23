/**
 * SCRUM-444 F3: the Approvals page serves two queues to two roles. An
 * accountant holds `confirm:finance_disbursement` but not `approve:requests`, so
 * the profit-approval query (which the server refuses them) must not be asked —
 * a refused query throws into render, and they saw an error page instead of the
 * deposit queue they came for.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

const stubs = vi.hoisted(() => ({
  queryArgs: new Map<string, unknown>(),
  queryOptions: new Map<string, unknown>(),
  queryResults: new Map<string, unknown>(),
  permissions: [] as string[],
  firstPageLoading: { results: [], status: "LoadingFirstPage", loadMore: () => undefined },
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      if (args === "skip") return undefined;
      if (name === "memberships:getMyMembership") return { permissions: stubs.permissions, isSystemOwnerRole: false };
      // The server refuses the profit-approval queue to anyone without the
      // permission; model that so an unguarded call fails the way production did.
      if (name === "approvals:listPendingApprovals" && !stubs.permissions.includes("approve:requests")) {
        throw new Error("Forbidden: approve:requests");
      }
      if (name === "retainedCreditRefunds:listRetainedCreditRefundRequests") {
        // The finance listing: a default MANAGER holds no view:finance, so it must never be asked of them.
        throw new Error("Forbidden: view:finance");
      }
      const value = stubs.queryResults.get(name);
      return typeof value === "function" ? (value as (a: unknown) => unknown)(args) : value;
    },
    // The refund approval queue is cursor-paged; its stub is the hook's own result shape.
    usePaginatedQuery: (reference: never, args: unknown, options: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      stubs.queryOptions.set(name, options);
      if (args === "skip") return stubs.firstPageLoading;
      if (!stubs.permissions.includes("approve:requests")) throw new Error("Forbidden: approve:requests");
      const value = stubs.queryResults.get(name);
      if (typeof value === "function") return (value as (a: unknown) => unknown)(args);
      return value ?? stubs.firstPageLoading;
    },
    useMutation: () => async () => null,
  };
});
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD", format: (n: number) => String(n) }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: (permission: string) => stubs.permissions.includes(permission) }),
}));

import ApprovalsPage from "./page";

const permissionsOf = (role: string) => [
  ...DEFAULT_ROLE_TEMPLATES.find((template) => template.name === role)!.permissions,
];
const row = {
  _id: "req1", quoteId: "q1", amount: 1500, currency: "JOD", note: null, requestedAt: 1,
  requestedByName: "Sam", customerName: "Dana Doe", vehicleLabel: "2022 Toyota Camry",
};

afterEach(() => {
  cleanup();
  stubs.queryArgs.clear();
  stubs.queryOptions.clear();
  stubs.queryResults.clear();
});

describe("ApprovalsPage", () => {
  test("an ACCOUNTANT reaches the deposit queue and never asks for profit approvals", () => {
    stubs.permissions = permissionsOf("ACCOUNTANT");
    expect(stubs.permissions).not.toContain("approve:requests");
    stubs.queryResults.set("depositRequests:listPending", [row]);

    render(<ApprovalsPage />);

    expect(screen.getByTestId("pending-deposit-requests")).toBeTruthy();
    expect(stubs.queryArgs.get("approvals:listPendingApprovals")).toBe("skip");
    expect(screen.queryByText("NoPendingApprovals")).toBeNull();
  });

  test("a profit approver still gets the approvals list, and no deposit queue", () => {
    stubs.permissions = ["approve:requests"];
    stubs.queryResults.set("approvals:listPendingApprovals", []);
    render(<ApprovalsPage />);
    expect(screen.getByText("NoPendingApprovals")).toBeTruthy();
    expect(stubs.queryArgs.get("depositRequests:listPending")).toBe("skip");
  });
});

describe("ApprovalsPage: customer-credit refund approval queue (SCRUM-831)", () => {
  const QUEUE = "retainedCreditRefunds:listRetainedCreditRefundApprovalQueue";
  const refund = {
    _id: "r1", amountMinor: 1200, currency: "JOD", method: "BANK_TRANSFER", reason: "Customer asked for money back",
    createdAt: Date.UTC(2026, 9, 12), requestedByMe: false, requestedByName: "Dana", customerName: "Layla Haddad",
    sourceChequeLabel: "Arab Bank #004512", originatingSaleStatus: "CANCELLED",
  };

  test("the default MANAGER (approve:requests, no view:finance) is shown the queue and never asks the finance listing", () => {
    stubs.permissions = permissionsOf("MANAGER");
    expect(stubs.permissions).toContain("approve:requests");
    expect(stubs.permissions).not.toContain("view:finance");
    stubs.queryResults.set(QUEUE, { results: [{ ...refund, payoutAvailable: true }], status: "Exhausted", loadMore: () => undefined });
    stubs.queryResults.set("approvals:listPendingApprovals", []);

    render(<ApprovalsPage />);

    expect(stubs.queryArgs.get(QUEUE)).toEqual({ orgId: "org1" });
    expect(stubs.queryOptions.get(QUEUE)).toEqual({ initialNumItems: 25 });
    expect(stubs.queryArgs.has("retainedCreditRefunds:listRetainedCreditRefundRequests")).toBe(false);
    expect(screen.getByTestId("refund-approval-queue")).toBeTruthy();
    expect(screen.getAllByTestId("refund-approval-row")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
    // Execute and cancel belong to the Accounting queue, not here.
    expect(screen.queryByRole("button", { name: "RetainedCreditExecute" })).toBeNull();
    expect(screen.queryByRole("button", { name: "RetainedCreditRefundCancel" })).toBeNull();
  });

  test("the default ACCOUNTANT (no approve:requests) never asks the queue and sees no section", () => {
    stubs.permissions = permissionsOf("ACCOUNTANT");
    render(<ApprovalsPage />);
    // Not mounted at all, so the narrow read is never even asked of them.
    expect(stubs.queryArgs.has(QUEUE)).toBe(false);
    expect(screen.queryByTestId("refund-approval-queue")).toBeNull();
    expect(screen.queryByTestId("refund-approval-loading")).toBeNull();
  });

  test("a refused queue read degrades to its own alert instead of taking the page down", () => {
    stubs.permissions = ["approve:requests"];
    stubs.queryResults.set("approvals:listPendingApprovals", []);
    const original = console.error;
    console.error = () => undefined;
    try {
      stubs.queryResults.set(QUEUE, () => { throw new Error("backend refused"); });
      render(<ApprovalsPage />);
    } finally {
      console.error = original;
    }
    expect(screen.getByRole("alert").textContent).toBe("RetainedCreditRefundsLoadFailed");
    // The rest of the page is unaffected.
    expect(screen.getByText("NoPendingApprovals")).toBeTruthy();
  });
});
