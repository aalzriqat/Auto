import type { AccountingProfit, DealProfit, ManagementProfit } from "./financingEconomics";
import { isMinorAmount } from "./financingEconomics";

export type ProfitCommissions =
  | { available: true; totalMinor: number }
  | { available: false; reason: "CommissionAccessRequired" | "CommissionsUnreadable" };

/** Derive the headline from the same signed lines the screen renders. */
export function withDealManagementCosts(args: {
  profit: ManagementProfit | AccountingProfit;
  showroomExpenses: { available: true; totalMinor: number } | { available: false };
  commissions: ProfitCommissions;
}): DealProfit {
  const { profit, showroomExpenses, commissions } = args;
  if (!profit.available) return profit;
  if (!commissions.available) return { available: false, reason: commissions.reason };
  if (!showroomExpenses.available) return { available: false, reason: "PreparationExpensesUnreadable" };
  if (!isMinorAmount(showroomExpenses.totalMinor) || !isMinorAmount(commissions.totalMinor)) {
    return { available: false, reason: "CorruptInput" };
  }
  const accountingMarginLine = {
    key: "ACCOUNTING_MARGIN" as const,
    sign: profit.amountMinor < 0 ? -1 as const : 1 as const,
    amountMinor: Math.abs(profit.amountMinor),
  };
  const baseLines = profit.lines.length > 0 ? profit.lines : [accountingMarginLine];
  const deductions = [
    { key: "PREPARATION_EXPENSES" as const, sign: -1 as const, amountMinor: showroomExpenses.totalMinor },
    { key: "COMMISSIONS" as const, sign: -1 as const, amountMinor: commissions.totalMinor },
  ];
  const lines = [...baseLines, ...deductions];
  const amountMinor = lines.reduce((total, line) => total + line.sign * line.amountMinor, 0);
  if (!Number.isSafeInteger(amountMinor)) return { available: false, reason: "CorruptInput" };
  if (profit.basis === "MANAGEMENT_ESTIMATE") return { ...profit, amountMinor, lines: [...profit.lines, ...deductions] };
  const cashLines = profit.lines.length > 0 ? profit.lines : [accountingMarginLine];
  return {
    available: true, basis: "MANAGEMENT_NET", amountMinor, currency: profit.currency,
    lines: [...cashLines, ...deductions], postable: false,
  };
}
