import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { dealCommissionTotals } from "../dealCommissions";
import { MAX_DEAL_COMMISSION_LINES, parseCommissionAmountMinor } from "./dealCommissionLines";
import { boundedLineRowsForSale, MAX_DEAL_COMMISSION_LINE_ROWS } from "./dealCommissionLineReads";
import type { ProfitCommissions } from "./dealManagementNet";
import { deriveDealerPreparationExpenses, deriveVehicleCostBasis, MAX_COST_BASIS_EXPENSES } from "./vehicleCostBasis";
import { denominationOf } from "./money";

function readableSaleCommission(sale: Doc<"sales">, currency: string): boolean {
  const denomination = denominationOf(currency);
  if (denomination === null || sale.commissionAmount == null) return false;
  return sale.commissionAmount === 0 || parseCommissionAmountMinor(sale.commissionAmount, denomination.scale).ok;
}

/** A cap refuses a profit instead of throwing and blanking the deal screen. */
export async function loadProfitCommissions(ctx: QueryCtx, args: {
  orgId: Id<"organizations">;
  saleId: Id<"sales"> | null;
  currency: string;
  mayReadCommissions: boolean;
}): Promise<ProfitCommissions> {
  if (!args.mayReadCommissions) return { available: false, reason: "CommissionAccessRequired" };
  // Before a sale exists there are no registered sale-keyed lines. This is an estimate, not final pay.
  if (args.saleId === null) return { available: true, totalMinor: 0 };
  const saleId = args.saleId;
  const sale = await ctx.db.get(saleId);
  if (!sale || sale.orgId !== args.orgId || sale.isDeleted) return { available: false, reason: "CommissionsUnreadable" };
  if (sale.commissionAmount == null) return { available: false, reason: "CommissionsPending" };
  if (!readableSaleCommission(sale, args.currency)) return { available: false, reason: "CommissionsUnreadable" };
  const rows = await boundedLineRowsForSale(ctx, args.orgId, saleId);
  const active = rows.filter((row) => row.removedAt === undefined);
  if (rows.length > MAX_DEAL_COMMISSION_LINE_ROWS || active.length > MAX_DEAL_COMMISSION_LINES) {
    return { available: false, reason: "CommissionsUnreadable" };
  }
  const totals = dealCommissionTotals(sale, active, args.currency);
  if (totals.salePending || totals.totalMinor === null) return { available: false, reason: "CommissionsUnreadable" };
  return { available: true, totalMinor: totals.totalMinor };
}

/**
 * Work orders have carried expenseId since their first writer (02f20d103).
 * Its accounting hook posts a plain EXPENSE_POSTED, never inventory capitalization.
 * Use the tenant/vehicle link as provenance; a title is not evidence. Bound
 * both reads and leave unknown rows unreadable if provenance is truncated.
 */
export async function loadVehicleProfitExpenses(ctx: QueryCtx, vehicle: Doc<"vehicles">): Promise<Doc<"expenses">[]> {
  const expenses = await ctx.db.query("expenses")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", vehicle.orgId).eq("vehicleId", vehicle._id))
    .take(MAX_COST_BASIS_EXPENSES + 1);
  if (expenses.length > MAX_COST_BASIS_EXPENSES || !expenses.some((row) =>
    row.accountingTreatment === undefined && row.status === "PAID" && !row.isDeleted && row.reversedAt === undefined
  )) return expenses;
  const workOrders = await ctx.db.query("workOrders")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", vehicle.orgId).eq("vehicleId", vehicle._id))
    .take(MAX_COST_BASIS_EXPENSES + 1);
  if (workOrders.length > MAX_COST_BASIS_EXPENSES) return expenses;
  const workOrderAmounts = new Map(workOrders.map((row) => [row.expenseId, row.totalCost]));
  return expenses.map((row) => row.accountingTreatment === undefined && row.category === "REPAIR" &&
    row.isPrepaid !== true && row.capitalizedAmount === undefined && workOrderAmounts.get(row._id) === row.amount
    ? { ...row, accountingTreatment: "PERIOD_EXPENSE" as const }
    : row);
}

export async function loadShowroomExpenses(ctx: QueryCtx, args: {
  vehicle: Doc<"vehicles"> | null;
  currency: string;
  orgCurrency: string;
}) {
  const { vehicle } = args;
  if (!vehicle || vehicle.isDeleted) return { available: false as const };
  const expenses = await loadVehicleProfitExpenses(ctx, vehicle);
  if (vehicle.sourceType !== "SOURCED") {
    const basis = deriveVehicleCostBasis({
      vehicle, expenses, cutoffCreationTime: null, dealCurrency: args.currency, orgCurrency: args.orgCurrency,
    });
    if (!basis.available) return { available: false as const };
  }
  return deriveDealerPreparationExpenses({
    expenses, cutoffCreationTime: null, dealCurrency: args.currency, orgCurrency: args.orgCurrency,
    consigned: vehicle.sourceType === "SOURCED",
  });
}
