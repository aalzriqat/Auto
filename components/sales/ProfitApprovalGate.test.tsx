/**
 * SCRUM-260, Sol 6 on 87ed0791f:
 * - While the inputs that decide whether the verdict applies are still loading,
 *   the hook is inactive and used to report "not blocked", so an open finalize
 *   dialog could flicker its confirm enabled. `loading` must hold it blocked.
 * - The manager's approval card formatted each request's stored amounts in the
 *   org's CURRENT currency. `profitApprovalRequests` is not a currency-lock row,
 *   so a pending request can outlive a currency change; its amounts must be
 *   labelled in the currency it was raised in.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

const stubs = vi.hoisted(() => ({
  queryResult: undefined as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: () => stubs.queryResult,
  useMutation: () => async () => null,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "USD",
    symbol: "$",
    displayLabel: "USD",
    format: (n: number) => `${n} USD`,
    formatCompact: (n: number) => `${n} USD`,
  }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useProfitApproval } from "./ProfitApprovalNotice";
import ApprovalsPage from "../../app/(dashboard)/[orgId]/approvals/page";

afterEach(() => {
  cleanup();
  stubs.queryResult = undefined;
});

describe("useProfitApproval while its inputs load", () => {
  test("an inactive hook whose inputs are still loading reports blocked", () => {
    const { result } = renderHook(() =>
      useProfitApproval({ orgId: undefined, vehicleId: undefined, salePrice: 0, enabled: false, loading: true })
    );
    expect(result.current.blocked).toBe(true);
  });

  test("an inactive hook whose inputs have resolved is not blocked", () => {
    const { result } = renderHook(() =>
      useProfitApproval({ orgId: undefined, vehicleId: undefined, salePrice: 0, enabled: false, loading: false })
    );
    expect(result.current.blocked).toBe(false);
  });
});

describe("the approval card's currency", () => {
  test("a request raised in another currency is labelled in that currency", () => {
    stubs.queryResult = [
      {
        _id: "req1" as Id<"profitApprovalRequests">,
        _creationTime: 0,
        orgId: "org1",
        status: "PENDING",
        requestedProfit: 150,
        minimumProfit: 500,
        salePrice: 10150,
        listPrice: 10000,
        currency: "JOD",
        salespersonName: "ليث العمري",
        vehicleMakeModel: "Volkswagen e-Golf 2020",
        vehicleVin: "WVWZZZAUZLW901234",
      },
    ];

    render(<ApprovalsPage />);

    expect(screen.getByText("10,150 JOD")).toBeTruthy();
    expect(screen.getByText("10,000 JOD")).toBeTruthy();
    expect(screen.getByText("150 JOD")).toBeTruthy();
    expect(screen.queryByText("10150 USD")).toBeNull();
  });
});
