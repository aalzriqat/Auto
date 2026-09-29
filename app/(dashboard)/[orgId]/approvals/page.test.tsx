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
  queryResults: new Map<string, unknown>(),
  permissions: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      if (args === "skip") return undefined;
      // The server refuses the profit-approval queue to anyone without the
      // permission; model that so an unguarded call fails the way production did.
      if (name === "approvals:listPendingApprovals" && !stubs.permissions.includes("approve:requests")) {
        throw new Error("Forbidden: approve:requests");
      }
      return stubs.queryResults.get(name);
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