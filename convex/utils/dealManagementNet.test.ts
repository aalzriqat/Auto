import { expect, test } from "vitest";
import { withDealManagementCosts } from "./dealManagementNet";
import type { AccountingProfit } from "./financingEconomics";

const margin = (amountMinor: number): AccountingProfit => ({
  available: true, basis: "ACCOUNTING_RESULT", currency: "JOD", amountMinor,
  lines: [], reconcilesToLedger: true,
});

test("a frozen cash margin without a readable price breakdown remains a labelled signed operand", () => {
  const net = withDealManagementCosts({
    profit: margin(-100), showroomExpenses: { available: true, totalMinor: 10 },
    commissions: { available: true, totalMinor: 20 },
  });
  expect(net).toMatchObject({ available: true, basis: "MANAGEMENT_NET", amountMinor: -130 });
  if (!net.available) throw new Error("Expected loss");
  expect(net.lines).toEqual([
    { key: "ACCOUNTING_MARGIN", sign: -1, amountMinor: 100 },
    { key: "PREPARATION_EXPENSES", sign: -1, amountMinor: 10 },
    { key: "COMMISSIONS", sign: -1, amountMinor: 20 },
  ]);
});

test.each([
  [-Number.MAX_SAFE_INTEGER, 1, 0],
  [100, -1, 0],
  [100, 0, Number.NaN],
])("unreadable management operands or an overflowing loss refuse (%s, %s, %s)", (base, expenses, commissions) => {
  expect(withDealManagementCosts({
    profit: margin(base), showroomExpenses: { available: true, totalMinor: expenses },
    commissions: { available: true, totalMinor: commissions },
  })).toEqual({ available: false, reason: "CorruptInput" });
});

test("a cancelled deal remains unavailable even if its costs are also unavailable", () => {
  expect(withDealManagementCosts({
    profit: { available: false, reason: "DealCancelled" }, showroomExpenses: { available: false },
    commissions: { available: false, reason: "CommissionsUnreadable" },
  })).toEqual({ available: false, reason: "DealCancelled" });
});
