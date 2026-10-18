import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { BankAccountsTable } from "./BankAccountsTable";

afterEach(cleanup);

const bankA = "bank-a" as Id<"bankAccounts">;
const bankB = "bank-b" as Id<"bankAccounts">;
const accounts = [
  { _id: bankA, name: "Bank A", currency: "JOD", isActive: true, isReconciliationTarget: true },
  { _id: bankB, name: "Bank B", currency: "JOD", isActive: true, isReconciliationTarget: false },
];

test("shows separate JOD book amounts for both banks, not just the reconciliation target", () => {
  render(<BankAccountsTable
    accounts={accounts}
    balances={[
      { bankAccountId: bankA, name: "Bank A", currency: "JOD", isDeleted: false, status: "OK", balanceMinor: 700_000 },
      { bankAccountId: bankB, name: "Bank B", currency: "JOD", isDeleted: false, status: "OK", balanceMinor: 300_000 },
    ]}
    locale="en"
    canManageFinance={false}
    busyAction={null}
    t={(key) => key}
    onSetReconciliationTarget={() => undefined}
    onDeactivate={() => undefined}
  />);

  const rowA = screen.getByText("Bank A").closest("tr");
  const rowB = screen.getByText("Bank B").closest("tr");
  expect(rowA).not.toBeNull();
  expect(rowB).not.toBeNull();
  expect(within(rowA!).getByText(/700\.000/)).toBeTruthy();
  expect(within(rowB!).getByText(/300\.000/)).toBeTruthy();
});

test("withholds amounts when bank activity has no physical bank identity", () => {
  render(<BankAccountsTable
    accounts={accounts}
    balances={[
      { bankAccountId: bankA, name: "Bank A", currency: "JOD", isDeleted: false, status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null },
      { bankAccountId: bankB, name: "Bank B", currency: "JOD", isDeleted: false, status: "UNATTRIBUTED_GL_ACTIVITY", balanceMinor: null },
    ]}
    locale="en"
    canManageFinance={false}
    busyAction={null}
    t={(key) => key}
    onSetReconciliationTarget={() => undefined}
    onDeactivate={() => undefined}
  />);

  expect(screen.getAllByText("BookBalanceUnavailableNoBankAttribution")).toHaveLength(2);
  expect(screen.queryByText(/700\.000/)).toBeNull();
});

test("shows a closed bank's remaining ledger money without offering another deactivation", () => {
  render(<BankAccountsTable
    accounts={[{ _id: bankB, name: "Closed Bank", currency: "JOD", isActive: false, isDeleted: true, isReconciliationTarget: false }]}
    balances={[{ bankAccountId: bankB, name: "Closed Bank", currency: "JOD", isDeleted: true, status: "OK", balanceMinor: 300_000 }]}
    locale="en"
    canManageFinance
    busyAction={null}
    t={(key) => key}
    onSetReconciliationTarget={() => undefined}
    onDeactivate={() => undefined}
  />);

  expect(screen.getByText(/300\.000/)).toBeTruthy();
  expect(screen.getByText("ClosedBankAccount")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
});
