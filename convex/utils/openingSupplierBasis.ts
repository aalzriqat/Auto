import { toMinorUnits } from "./money";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import {
  requireOpeningSettlementBasis,
  type OpeningSettlementReader,
} from "./openingSettlementBasis";
const refuse = () =>
  new ConvexError(
    "The opening obligation cannot be verified. Ask finance to review it before settlement.",
  );
type Ctx = QueryCtx | MutationCtx;
/** The result rows of every POSTED opening draft; refuses when there are too many to read in full. */
async function postedOpeningResults(ctx: Ctx, orgId: Id<"organizations">) {
  const drafts = await ctx.db
    .query("openingBalanceDrafts")
    .withIndex("by_org_status", (q) =>
      q.eq("orgId", orgId).eq("status", "POSTED"),
    )
    .take(101);
  if (drafts.length > 100) throw refuse();
  return drafts.flatMap((draft) => draft.allocationResults ?? []);
}
/**
 * Every recovery id that a POSTED opening draft claims as its own result, with how many times, from
 * one read of the drafts. A caller that checks many native recoveries uses this instead of a draft
 * scan per row (parentReference); a native recovery that appears here, or appears twice, is a
 * contradiction. Throws the same refusal as parentReference when the drafts cannot be read in full.
 */
export async function openingRecoveryReferenceCounts(
  ctx: Ctx,
  orgId: Id<"organizations">,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const row of await postedOpeningResults(ctx, orgId)) {
    if ("recoveryId" in row) counts.set(row.recoveryId, (counts.get(row.recoveryId) ?? 0) + 1);
  }
  return counts;
}
async function parentReference(
  ctx: Ctx,
  orgId: Id<"organizations">,
  id: string,
  family: "recovery" | "payable",
) {
  const references = (await postedOpeningResults(ctx, orgId))
    .filter((row) =>
      family === "recovery"
        ? "recoveryId" in row && row.recoveryId === id
        : "payableId" in row && row.payableId === id,
    );
  if (references.length > 1) throw refuse();
  return references[0];
}
export async function openingRecoveryBasis(
  ctx: Ctx,
  orgId: Id<"organizations">,
  row: Doc<"supplierCostRecoveries">,
  reader?: OpeningSettlementReader,
) {
  const reference = await parentReference(ctx, orgId, row._id, "recovery");
  if (row.origin !== "OPENING") {
    if (reference) throw refuse();
    return null;
  }
  if (
    !Number.isSafeInteger(row.amountRecoveredMinor) ||
    row.amountRecoveredMinor < 0 ||
    row.amountRecoveredMinor > row.amountDueMinor ||
    !Number.isSafeInteger(row.receiptSeq) ||
    row.receiptSeq < 0 ||
    row.receiptSeq > 100
  )
    throw refuse();
  const basis = await requireOpeningSettlementBasis(
    ctx,
    orgId,
    { draftId: row.openingBalanceDraftId, rowKey: row.openingRowKey },
    "SUPPLIER_RECOVERABLE",
    reader,
  );
  if (
    basis.kind !== "AVAILABLE" ||
    basis.allocation.kind !== "SUPPLIER_RECOVERABLE" ||
    basis.result.kind !== "SUPPLIER_RECOVERABLE" ||
    basis.result.recoveryId !== row._id ||
    row.orgId !== orgId ||
    row.amountDueMinor !== basis.amountMinor ||
    row.currency !== basis.currency ||
    row.title !== basis.allocation.title.trim() ||
    row.sourcedFromName !== basis.allocation.counterpartyName.trim() ||
    row.purpose !== basis.allocation.purpose
  )
    throw refuse();
  return basis;
}
export async function openingPayableBasis(
  ctx: Ctx,
  orgId: Id<"organizations">,
  row: Doc<"vehicleSupplierPayables">,
  reader?: OpeningSettlementReader,
) {
  const reference = await parentReference(ctx, orgId, row._id, "payable");
  if (row.origin !== "OPENING") {
    if (reference) throw refuse();
    return null;
  }
  const basis = await requireOpeningSettlementBasis(
    ctx,
    orgId,
    { draftId: row.openingBalanceDraftId, rowKey: row.openingRowKey },
    row.openingKind,
    reader,
  );
  if (
    basis.kind !== "AVAILABLE" ||
    (basis.allocation.kind !== "SUPPLIER_PAYABLE" &&
      basis.allocation.kind !== "OTHER_PAYABLE") ||
    (basis.result.kind !== "SUPPLIER_PAYABLE" &&
      basis.result.kind !== "OTHER_PAYABLE") ||
    basis.result.payableId !== row._id ||
    row.orgId !== orgId ||
    row.currency !== basis.currency ||
    row.title !== basis.allocation.title.trim() ||
    row.sourcedFromName !== basis.allocation.counterpartyName.trim()
  )
    throw refuse();
  if (
    !Number.isFinite(row.amountDue) ||
    !Number.isFinite(row.amountPaid ?? 0) ||
    row.amountDue <= 0 ||
    (row.amountPaid ?? 0) < 0 ||
    (row.amountPaid ?? 0) > row.amountDue
  )
    throw refuse();
  const scale = toMinorUnits(row.amountDue, row.currency);
  if (scale !== basis.amountMinor) throw refuse();
  return basis;
}
