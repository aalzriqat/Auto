// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { ReconciliationPanel } from "./ReconciliationPanel";

const { recovery, role } = vi.hoisted(() => ({ recovery: vi.fn(), role: { canApprove: true } }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip") return undefined;
    switch (getFunctionName(reference)) {
      case "bankReconciliation:suggestMatches": return [];
      case "bankReconciliation:listStatementLines": return [{
        _id: "return-line", statementDate: 0, amountMinor: 1234, description: "Verified bank credit",
        openingDepositRefundReturnEventId: "return-event",
      }];
      case "openingRefundReturns:archivedRefundRecovery": return recovery(args);
      default: return undefined;
    }
  },
}));
vi.mock("@/components/providers/LanguageProvider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isOwner: false, hasPermission: () => role.canApprove }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (amount: number) => String(amount),
  useCurrencyFormatterInCurrency: () => (amount: number, currency: string) => `${currency} ${amount}`,
}));

afterEach(() => {
  cleanup();
  recovery.mockReset();
  role.canApprove = true;
});

function showMatchedReturns() {
  render(<ReconciliationPanel orgId={"dealer" as Id<"organizations">} bankAccountId={"bank" as Id<"bankAccounts">}
    currency="JOD" canManageFinance />);
  fireEvent.click(screen.getByRole("button", { name: "MatchedLines" }));
}

test("opens the existing refund form for the archived deposit identified by a matched bank return", () => {
  recovery.mockReturnValue({ depositId: "returned-deposit", currency: "JOD", amountMinor: 1234, reserved: false });
  showMatchedReturns();
  expect(recovery).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Unmatch" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "OpeningRefundArchivedRecovery" }));
  expect(recovery).toHaveBeenCalledWith({ orgId: "dealer", statementLineId: "return-line" });
  expect(screen.getByRole("dialog").textContent).toContain("JOD 1.234");
});

test("hides the recovery action and makes no lookup when the viewer lacks refund approval", () => {
  role.canApprove = false;
  showMatchedReturns();
  expect(screen.queryByRole("button", { name: "OpeningRefundArchivedRecovery" })).toBeNull();
  expect(recovery).not.toHaveBeenCalled();
});
