// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ReconciliationPanel } from "./ReconciliationPanel";

const { recovery, role, statementQuery } = vi.hoisted(() => ({
  recovery: vi.fn(), role: { canApprove: true },
  statementQuery: { suggestions: [] as FunctionReturnType<typeof api.bankReconciliation.suggestMatches> | undefined },
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip") return undefined;
    switch (getFunctionName(reference)) {
      case "bankReconciliation:suggestMatches": return statementQuery.suggestions;
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
  statementQuery.suggestions = [];
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

test.each([
  [undefined, "Loading"], [[], "NoUnmatchedLines"],
] as const)("distinguishes loading and empty unmatched statements: %s", (suggestions, label) => {
  statementQuery.suggestions = suggestions === undefined ? undefined : [];
  render(<ReconciliationPanel orgId={"dealer" as Id<"organizations">} bankAccountId={"bank" as Id<"bankAccounts">}
    currency="JOD" canManageFinance />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText(label === "Loading" ? "NoUnmatchedLines" : "Loading")).toBeNull();
});

test.each([
  ["suggested", "Synthetic match"], ["ambiguous", "MultipleCandidates"], ["none", "NoCandidates"],
] as const)("preserves the %s statement candidate label", (kind, label) => {
  const journalLineId = "journal-line" as Id<"journalLines">;
  const candidate = { journalLineId, accountingDate: 0, amountMinor: 1234, memo: "Synthetic match", score: 10 };
  statementQuery.suggestions = [{
    statementLineId: "statement" as Id<"bankStatementLines">, statementDate: 0, description: "Statement", amountMinor: 1234,
    candidates: kind === "none" ? [] : [candidate], suggestedJournalLineId: kind === "suggested" ? journalLineId : undefined,
  }];
  render(<ReconciliationPanel orgId={"dealer" as Id<"organizations">} bankAccountId={"bank" as Id<"bankAccounts">}
    currency="JOD" canManageFinance />);
  expect(screen.getByText(label, { exact: kind !== "suggested" })).toBeTruthy();
});
