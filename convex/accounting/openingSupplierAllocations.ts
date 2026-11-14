import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { snapshotSupplier } from "../utils/supplierRegistry";
import { fromMinorUnits } from "../utils/money";
import type { OpeningAllocationPlan } from "./openingAllocations";

type Allocation = NonNullable<Doc<"openingBalanceDrafts">["allocations"]>[number];
type SupplierAllocation = Extract<Allocation, { kind: "SUPPLIER_RECOVERABLE" | "SUPPLIER_PAYABLE" | "OTHER_PAYABLE" }>;
type SupplierResult = Extract<NonNullable<Doc<"openingBalanceDrafts">["allocationResults"]>[number], { kind: SupplierAllocation["kind"] }>;

/** Direct awaited resolution keeps the opening contract provenance visible.
 * All three snapshot fields come from one supplier read; client labels lose. */
export async function resolveOpeningSuppliers(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, allocations: readonly Allocation[]): Promise<Allocation[]> {
  if (allocations.length > 100) throw new ConvexError("An opening can contain at most 100 allocations.");
  const rows: Allocation[] = [];
  try {
    for (const row of allocations) {
      if (row.kind === "SUPPLIER_RECOVERABLE" || row.kind === "SUPPLIER_PAYABLE" ||
          row.kind === "OTHER_PAYABLE" && row.supplierId !== undefined) {
        const supplier = await snapshotSupplier(ctx, orgId, row.supplierId);
        rows.push({ ...row, supplierId: supplier.supplierId, counterpartyName: supplier.name, supplierSnapshotVersion: supplier.version });
      } else if (row.kind === "OTHER_PAYABLE") {
        rows.push({ ...row, supplierSnapshotVersion: undefined });
      } else rows.push(row);
    }
    return rows;
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    console.error(error);
    throw new ConvexError("An unexpected error occurred. Please try again later.");
  }
}

/** Only the validated opening plan reaches this writer, within the original
 * posting transaction. These balances create no second economic event. */
export async function materializeOpeningSupplier(ctx: MutationCtx,
  { plan, draftId, actorId, row, now }: {
    plan: OpeningAllocationPlan; draftId: Id<"openingBalanceDrafts">;
    actorId: Id<"users">; row: SupplierAllocation; now: number;
  }): Promise<SupplierResult> {
  const common = { origin: "OPENING" as const, orgId: plan.orgId, openingBalanceDraftId: draftId,
    openingRowKey: row.rowKey, title: row.title.trim(), sourcedFromName: row.counterpartyName.trim(),
    supplierId: row.supplierId, supplierSnapshotVersion: row.supplierSnapshotVersion,
    currency: plan.currency, createdBy: actorId, createdAt: now, updatedAt: now };
  if (row.kind === "SUPPLIER_RECOVERABLE") {
    const recoveryId = await ctx.db.insert("supplierCostRecoveries", { ...common, purpose: row.purpose,
      amountDueMinor: row.amountMinor, amountRecoveredMinor: 0, receiptSeq: 0, status: "OPEN" });
    return { kind: row.kind, rowKey: row.rowKey, recoveryId };
  }
  const payableId = await ctx.db.insert("vehicleSupplierPayables", { ...common, openingKind: row.kind,
    amountDue: fromMinorUnits(row.amountMinor, plan.currency), amountPaid: 0, paymentSeq: 0, status: "PENDING" });
  return { kind: row.kind, rowKey: row.rowKey, payableId };
}
