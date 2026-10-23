import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";

/** Runtime-owned optional reference cleared atomically before its target is deleted. */
export const OPENING_ATOMIC_REFERENCE_CLEARS = [
  "openingCommissionLiabilities.paidPayrollItemId->payrollItems",
  "openingBalanceDrafts.allocationResults[].openingCommissionLiabilityId->openingCommissionLiabilities",
  "openingBalanceDrafts.allocationResults[].recoveryId->supplierCostRecoveries",
] as const;

export async function clearOpeningPayrollReference(
  ctx: MutationCtx, orgId: Id<"organizations">, itemId: Id<"payrollItems">
) {
  const rows = await ctx.db.query("openingCommissionLiabilities")
    .withIndex("by_org_payroll_item", q => q.eq("orgId", orgId).eq("paidPayrollItemId", itemId)).take(101);
  if (rows.length > 100) throw new ConvexError("Opening commission cleanup requires review.");
  for (const row of rows) {
    if (row.paidPayrollItemId === itemId) {
      // paidMinor remains unchanged: losing historical payment proof must never reopen debt.
      await ctx.db.patch(row._id, { paidPayrollItemId: undefined });
    }
  }
}

/** Only immutable opening allocation results authorize this reset extension; legacy AP survives. */
export async function clearOpeningPayablesBatch(
  ctx: MutationCtx, orgId: Id<"organizations">, limit: number, dryRun: boolean
): Promise<{ deleted: number; remaining: number }> {
  const drafts = await ctx.db.query("openingBalanceDrafts")
    .withIndex("by_org", q => q.eq("orgId", orgId)).take(101);
  if (drafts.length > 100) throw new ConvexError("Opening payable cleanup requires review.");
  const ids = openingPayableIds(drafts);
  let deleted = 0;
  let remaining = 0;
  for (const id of ids) {
    const result = await clearOpeningPayable(ctx, orgId, id, limit, deleted, dryRun);
    deleted += result.deleted;
    remaining += result.remaining;
  }
  return { deleted, remaining };
}

function openingPayableIds(drafts: readonly Doc<"openingBalanceDrafts">[]) {
  const ids = new Set<Id<"vehicleSupplierPayables">>();
  for (const draft of drafts) {
    for (const result of draft.allocationResults ?? []) {
      if (result.kind === "SUPPLIER_PAYABLE" || result.kind === "OTHER_PAYABLE") ids.add(result.payableId);
    }
  }
  return ids;
}

/** Payment children drain before the source reference and parent can be deleted. */
async function clearOpeningPayable(ctx: MutationCtx, orgId: Id<"organizations">,
  id: Id<"vehicleSupplierPayables">, limit: number, used: number, dryRun: boolean) {
  const row = await ctx.db.get(id);
  if (!row) return { deleted: 0, remaining: 0 };
  if (row.orgId !== orgId) throw new ConvexError("Opening payable cleanup requires review.");
  if (used >= limit) return { deleted: 0, remaining: 1 };
  const payments = await ctx.db.query("openingPayablePayments")
    .withIndex("by_payable", q => q.eq("payableId", id)).take(limit + 1);
  let deleted = 0;
  for (const payment of payments.slice(0, limit - used)) {
    if (payment.orgId !== orgId) throw new ConvexError("Opening payable cleanup requires review.");
    if (!dryRun) await ctx.db.delete(payment._id);
    deleted += 1;
  }
  if (payments.length > 0) return { deleted, remaining: 1 };
  if (!dryRun) {
    await clearNewOpeningResultReference(ctx, orgId, { table: "vehicleSupplierPayables", id: row._id });
    await ctx.db.delete(row._id);
  }
  return { deleted: 1, remaining: dryRun ? 1 : 0 };
}

/** Destructive reset exception only: invalidate new source proof, never change historical economics. */
export async function clearNewOpeningResultReference(
  ctx: MutationCtx, orgId: Id<"organizations">,
  source: { table: "openingCommissionLiabilities"; id: Id<"openingCommissionLiabilities"> } |
    { table: "supplierCostRecoveries"; id: Id<"supplierCostRecoveries"> } |
    { table: "vehicleSupplierPayables"; id: Id<"vehicleSupplierPayables"> }
) {
  const drafts = await ctx.db.query("openingBalanceDrafts")
    .withIndex("by_org", q => q.eq("orgId", orgId)).take(101);
  if (drafts.length > 100) throw new ConvexError("Opening source cleanup requires review.");
  for (const draft of drafts) {
    const results = draft.allocationResults ?? [];
    const retained = results.filter(result => !matchesOpeningResult(result, source));
    if (retained.length !== results.length) await ctx.db.patch(draft._id, { allocationResults: retained });
  }
}

function matchesOpeningResult(result: NonNullable<Doc<"openingBalanceDrafts">["allocationResults"]>[number],
  source: Parameters<typeof clearNewOpeningResultReference>[2]) {
  if (source.table === "openingCommissionLiabilities") {
    return result.kind === "EMPLOYEE_COMMISSION" && result.openingCommissionLiabilityId === source.id;
  }
  if (source.table === "supplierCostRecoveries") {
    return result.kind === "SUPPLIER_RECOVERABLE" && result.recoveryId === source.id;
  }
  return (result.kind === "SUPPLIER_PAYABLE" || result.kind === "OTHER_PAYABLE") && result.payableId === source.id;
}
