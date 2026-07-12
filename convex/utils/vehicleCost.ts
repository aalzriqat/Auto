import { Doc } from "../_generated/dataModel";
import { QueryCtx, MutationCtx } from "../_generated/server";

/**
 * Expense categories that represent getting a specific vehicle ready for
 * sale (reconditioning). These capitalize into Vehicle Inventory instead of
 * hitting the P&L immediately — mirrors IAS 2's "costs to bring inventory to
 * its present location and condition." Selling costs (MARKETING, FEES, etc.)
 * are excluded even when linked to a vehicle: those are expensed as incurred.
 */
export const CAPITALIZABLE_EXPENSE_CATEGORIES = new Set([
  "REPAIR",
  "MAINTENANCE",
  "DETAILING",
  "TRANSPORT",
]);

/**
 * The single authoritative "book value" of a vehicle: what should be debited
 * to Vehicle Inventory over its life, and therefore what COGS should equal
 * when it sells. Used by both the GL (SALE_COMPLETED costMinor, commission
 * gross-profit basis) and the operational reports, so all three can no longer
 * disagree about a vehicle's cost the way they did before this existed.
 *
 * Sourced/drop-ship vehicles never sit in physical inventory — their cost is
 * just sourceCost, with no landed costs or capitalized expenses possible.
 */
export async function computeVehicleCapitalizedCost(
  ctx: QueryCtx | MutationCtx,
  vehicle: Doc<"vehicles">
): Promise<number> {
  if (vehicle.sourceType === "SOURCED") {
    return vehicle.sourceCost ?? 0;
  }

  const base = vehicle.purchasePrice ?? 0;
  const landed = vehicle.landedCostTotal ?? 0;

  const expenses = await ctx.db
    .query("expenses")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", vehicle.orgId).eq("vehicleId", vehicle._id))
    .collect();
  // Reads the decision recordPaidExpenseSideEffects recorded at posting time
  // (accountingTreatment/capitalizedAmount), not a fresh category/status
  // inference — a post-sale repair is permanently PERIOD_EXPENSE even if this
  // runs long after the sale, and capitalizedAmount already excludes VAT so it
  // matches exactly what was debited to Vehicle Inventory in the GL.
  const capitalizedExpenses = expenses
    .filter((e) => !e.isDeleted && e.accountingTreatment === "CAPITALIZED_INVENTORY")
    .reduce((sum, e) => sum + (e.capitalizedAmount ?? 0), 0);

  return base + landed + capitalizedExpenses;
}
