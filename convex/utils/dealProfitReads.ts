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

export async function loadShowroomExpenses(ctx: QueryCtx, args: {
  vehicle: Doc<"vehicles"> | null;
  currency: string;
  orgCurrency: string;
}) {
  const { vehicle } = args;
  if (!vehicle || vehicle.isDeleted) return { available: false as const };
  const expenses = await ctx.db.query("expenses")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", vehicle.orgId).eq("vehicleId", vehicle._id))
    .take(MAX_COST_BASIS_EXPENSES + 1);
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
