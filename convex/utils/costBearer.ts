import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * SCRUM-389 — who bears a vehicle-linked cost.
 *
 * Dealer rulings B4/B7 (2026-09-27): only showroom-borne costs reduce showroom
 * profit; the bearer is recorded per cost and never inferred; consignment prep
 * the SUPPLIER bears is recovered from the supplier and never permanently
 * reduces showroom profit.
 *
 * An absent bearer means SHOWROOM. That is what every row written before this
 * field existed meant, so no backfill is needed and no historical figure moves.
 *
 * ⚠️ A LEAF MODULE ON PURPOSE. It is imported by the schema, by the expense
 * writers, by every profit reader and by both vehicle-edit paths. Anything it
 * imported from the application would join every one of those module graphs,
 * and a module-init cycle here passes in isolation and fails under the full
 * suite. It imports only types and `convex/values`.
 */
export type CostBearer = "SHOWROOM" | "SUPPLIER";

export const costBearerValidator = v.union(v.literal("SHOWROOM"), v.literal("SUPPLIER"));

/**
 * THE predicate every profit reader uses. A SUPPLIER-borne cost is a
 * receivable from the supplier the moment it is paid — never an expense, never
 * COGS, never deal cost — so a reader that counted it would report profit the
 * showroom did not lose. One definition, so no reader can disagree with another
 * about which rows are the showroom's.
 */
export function isShowroomBorne(row: { costBearer?: CostBearer }): boolean {
  return row.costBearer !== "SUPPLIER";
}

/**
 * A cost that left the till in the period, whoever bears it. Supplier-borne
 * costs are real cash out even though they are not profit expense, so the
 * dashboard shows them here rather than letting them vanish.
 */
export function isCashOutExpense(row: { status?: "PENDING" | "PAID" }): boolean {
  return (row.status ?? "PAID") !== "PENDING";
}

/**
 * Why a SUPPLIER bearer is not allowed on this cost, or null when it is.
 *
 * Pure, so the rule is stated once and tested without a database. The caller
 * resolves the vehicle; `vehicle === null` means missing, deleted or foreign.
 *
 * SUPPLIER requires ALL of:
 *   - a vehicle owned by this org, SOURCED, with a named supplier — a
 *     recovery claim against nobody cannot be collected;
 *   - not prepaid — a prepaid is a balance-sheet asset amortized to an expense
 *     account, and a recoverable cost is neither;
 *   - no input tax — VAT on a recoverable cost is an open dealer question, and
 *     the receivable would otherwise be booked net while the cash went out gross;
 *   - an amount exactly representable in the org currency's minor unit, so the
 *     recovery's due amount is the ledger's debit to the fils.
 */
export function supplierBearerRefusal(args: {
  orgId: Id<"organizations">;
  vehicle: Pick<Doc<"vehicles">, "orgId" | "isDeleted" | "sourceType" | "sourcedFromName"> | null;
  category: string;
  isPrepaid: boolean | undefined;
  taxAmount: number | undefined;
  amountRepresentable: boolean;
}): string | null {
  const { vehicle } = args;
  if (!vehicle || vehicle.isDeleted === true || vehicle.orgId !== args.orgId) {
    return "A supplier-borne cost must be recorded against a vehicle in this organization.";
  }
  if (vehicle.sourceType !== "SOURCED") {
    return "Only a sourced (consigned) vehicle's cost can be borne by the supplier.";
  }
  if (!vehicle.sourcedFromName?.trim()) {
    return "This sourced vehicle has no supplier name, so a supplier-borne cost could not be recovered from anyone.";
  }
  if (args.isPrepaid === true || args.category === "PREPAID") {
    return "A prepaid expense cannot be borne by the supplier.";
  }
  if (args.taxAmount !== undefined && args.taxAmount !== 0) {
    return "A supplier-borne cost cannot carry VAT.";
  }
  if (!args.amountRepresentable) {
    return "The amount is finer than the currency allows, so it cannot be recovered exactly.";
  }
  return null;
}

/** The recovery statuses that still carry an amount the supplier owes. */
export const OPEN_RECOVERY_STATUSES = ["OPEN", "PARTIALLY_RECOVERED"] as const;

/**
 * SOURCED→STOCK conversion is refused while the supplier still owes the
 * dealership for a cost it bore on this car.
 *
 * Converting would make the dealership the car's owner while its books still
 * say the supplier owes it for preparing that same car — the recovery's
 * counterparty would silently stop being the party that owns the vehicle.
 * Called by BOTH vehicle-edit paths (the direct edit and the approval of a
 * requested edit): a second door that applies what the first refuses is not a
 * workflow.
 */
export async function supplierCostRecoveryConversionRefusal(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    currentSourceType: "STOCK" | "SOURCED" | undefined;
    requestedSourceType: "STOCK" | "SOURCED" | undefined;
  }
): Promise<string | null> {
  if (args.currentSourceType !== "SOURCED") return null;
  if (args.requestedSourceType === undefined || args.requestedSourceType === "SOURCED") return null;
  // ONE open recovery is enough to refuse, so each status is probed with
  // `.first()` on its own index range — no count to bound, no prefix to be
  // wrong about.
  for (const status of OPEN_RECOVERY_STATUSES) {
    const open = await ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("status", status)
      )
      .first();
    if (open) {
      return "The supplier still owes this vehicle's supplier-borne costs. Record or reverse those recoveries before converting the vehicle to owned stock.";
    }
  }
  return null;
}
