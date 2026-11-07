import type { AccountingProfit, DealProfit, ManagementProfit } from "./financingEconomics";
import { isMinorAmount } from "./financingEconomics";
import type { DealerPreparationExpenses } from "./vehicleCostBasis";

export type ProfitCommissions =
  | { available: true; totalMinor: number }
  | { available: false; reason: "CommissionAccessRequired" | "CommissionsPending" | "CommissionsUnreadable" | "CommissionsReadBoundExceeded" };

type ManagementCostInputs = {
  profit: ManagementProfit | AccountingProfit;
  showroomExpenses: { available: true; totalMinor: number } | {
    available: false;
    reason?: Exclude<DealerPreparationExpenses, { available: true }>["reason"] | "VehicleCostBasisUnreadable";
  };
  commissions: ProfitCommissions;
};

/** Both report figures come from the deal page's signed operands. */
export function deriveDealManagementCosts(args: ManagementCostInputs): {
  profitBeforeCommissions: DealProfit;
  profit: DealProfit;
} {
  const profitBeforeCommissions = beforeCommissionCosts(args);
  const { profit, commissions } = args;
  if (!profit.available) return { profitBeforeCommissions, profit };
  if (!commissions.available) return { profitBeforeCommissions, profit: { available: false, reason: commissions.reason } };
  if (!profitBeforeCommissions.available) return { profitBeforeCommissions, profit: profitBeforeCommissions };
  const amountMinor = profitBeforeCommissions.amountMinor - commissions.totalMinor;
  if (!isMinorAmount(commissions.totalMinor) || !Number.isSafeInteger(amountMinor)) {
    return { profitBeforeCommissions, profit: { available: false, reason: "CorruptInput" } };
  }
  const commissionLine = { key: "COMMISSIONS" as const, sign: -1 as const, amountMinor: commissions.totalMinor };
  if (profitBeforeCommissions.basis === "MANAGEMENT_ESTIMATE") {
    return { profitBeforeCommissions, profit: { ...profitBeforeCommissions, amountMinor,
      lines: [...profitBeforeCommissions.lines, commissionLine] } };
  }
  return { profitBeforeCommissions, profit: { ...profitBeforeCommissions, amountMinor,
    lines: [...profitBeforeCommissions.lines, commissionLine] } };
}

/** Preserve the deal page's existing headline and refusal precedence. */
export function withDealManagementCosts(args: ManagementCostInputs): DealProfit {
  return deriveDealManagementCosts(args).profit;
}

type ManagementNetProfit = Exclude<DealProfit, { basis: "ACCOUNTING_RESULT" }>;

function beforeCommissionCosts(args: ManagementCostInputs): ManagementNetProfit {
  const { profit, showroomExpenses } = args;
  if (!profit.available) return profit;
  if (!showroomExpenses.available) return {
    available: false,
    reason: showroomExpenses.reason === "VehicleCostBasisUnreadable" ? "VehicleCostBasisUnreadable" : "PreparationExpensesUnreadable",
  };
  if (!isMinorAmount(showroomExpenses.totalMinor)) {
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
