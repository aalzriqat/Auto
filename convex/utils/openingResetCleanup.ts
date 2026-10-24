import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { orgResetState } from "./orgResetGeneration";

type OpeningCleanupSource = NonNullable<Doc<"organizations">["openingCleanupReferenceScan"]>["source"];
const cleanupPending = { deleted: 0, remaining: 1 };

/** Runtime-owned optional reference cleared atomically before its target is deleted. */
export const OPENING_ATOMIC_REFERENCE_CLEARS = [
  "openingCommissionLiabilities.paidPayrollItemId->payrollItems",
  "openingBalanceDrafts.allocationResults[].openingCommissionLiabilityId->openingCommissionLiabilities",
  "openingBalanceDrafts.allocationResults[].recoveryId->supplierCostRecoveries",
  "organizations.openingCleanupReferenceScan.source.id->openingCommissionLiabilities",
  "organizations.openingCleanupReferenceScan.source.id->supplierCostRecoveries",
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
  if (drafts.length > 100) return clearLargeOpeningPayablesBatch(ctx, orgId, limit, dryRun);
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

/** Discovery and reference scans occupy separate invocations: at most one pagination per mutation. */
async function clearLargeOpeningPayablesBatch(ctx: MutationCtx, orgId: Id<"organizations">,
  limit: number, dryRun: boolean) {
  // A dry run cannot persist a continuation. Report a partial scope, never an empty inventory.
  if (dryRun) return cleanupPending;
  const org = await requireSuspendedCleanupOrg(ctx, orgId);
  const generation = orgResetState(org).generation;
  const stored = org.openingCleanupPayableScan;
  const state = stored?.resetGeneration === generation ? stored : undefined;
  if (state?.pendingPayableIds.length) {
    const result = await clearOpeningPayable(ctx, orgId, state.pendingPayableIds[0], limit, 0, false);
    if (result.remaining === 0) await ctx.db.patch(orgId, {
      openingCleanupPayableScan: { ...state, pendingPayableIds: state.pendingPayableIds.slice(1) },
    });
    return { deleted: result.deleted, remaining: 1 };
  }
  if (!state || (state.pendingDraftIds.length === 0 && !state.complete)) {
    // Leave scan headroom so a normal full page does not hit the row-read cap.
    const page = await ctx.db.query("openingBalanceDrafts").withIndex("by_org", q => q.eq("orgId", orgId))
      .paginate({ cursor: state?.cursor ?? null, numItems: 50, maximumRowsRead: 100, maximumBytesRead: 512_000 });
    if (page.pageStatus === "SplitRequired") {
      console.error("OPENING_CLEANUP_SPLIT_REQUIRED_DISCOVERY");
      throw new ConvexError("Opening cleanup could not be verified. Please contact support.");
    }
    await ctx.db.patch(orgId, { openingCleanupPayableScan: { resetGeneration: generation,
      cursor: page.continueCursor, complete: page.isDone, pendingDraftIds: page.page.map(draft => draft._id), pendingPayableIds: [] } });
    return cleanupPending;
  }
  for (const [index, draftId] of state.pendingDraftIds.entries()) {
    const draft = await ctx.db.get(draftId);
    if (draft && draft.orgId !== orgId) throw new ConvexError("Opening payable cleanup requires review.");
    const ids = [...openingPayableIds(draft ? [draft] : [])];
    if (ids.length > 0) {
      await ctx.db.patch(orgId, { openingCleanupPayableScan: { ...state,
        pendingDraftIds: state.pendingDraftIds.slice(index + 1), pendingPayableIds: ids } });
      return cleanupPending;
    }
  }
  await ctx.db.patch(orgId, { openingCleanupPayableScan: { ...state, pendingDraftIds: [] } });
  return { deleted: 0, remaining: state.complete ? 0 : 1 };
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
    if (!await clearNewOpeningResultReference(ctx, orgId, { table: "vehicleSupplierPayables", id: row._id })) return cleanupPending;
    await ctx.db.delete(row._id);
  }
  return { deleted: 1, remaining: dryRun ? 1 : 0 };
}

/** Destructive reset exception only: invalidate new source proof, never change historical economics. */
export async function clearNewOpeningResultReference(
  ctx: MutationCtx, orgId: Id<"organizations">,
  source: OpeningCleanupSource
) {
  const target = await ctx.db.get(source.id);
  if (!target || target.orgId !== orgId) throw new ConvexError("Opening source cleanup requires review.");
  const org = await ctx.db.get(orgId);
  const generation = orgResetState(org).generation;
  const stored = org?.openingCleanupReferenceScan;
  const state = stored?.resetGeneration === generation && stored.source.table === source.table &&
    stored.source.id === source.id ? stored : undefined;
  if (state) {
    await requireSuspendedCleanupOrg(ctx, orgId);
    if (state.complete) {
      await ctx.db.patch(orgId, { openingCleanupReferenceScan: undefined });
      return true;
    }
    const page = await ctx.db.query("openingBalanceDrafts").withIndex("by_org", q => q.eq("orgId", orgId))
      .paginate({ cursor: state.cursor, numItems: 50, maximumRowsRead: 100, maximumBytesRead: 512_000 });
    if (page.pageStatus === "SplitRequired") {
      console.error("OPENING_CLEANUP_SPLIT_REQUIRED_REFERENCE");
      throw new ConvexError("Opening cleanup could not be verified. Please contact support.");
    }
    await removeOpeningReferences(ctx, page.page, source);
    await ctx.db.patch(orgId, { openingCleanupReferenceScan: { ...state, cursor: page.continueCursor, complete: page.isDone } });
    // Even the final page yields, so a caller cannot start another pagination in this invocation.
    return false;
  }
  const drafts = await ctx.db.query("openingBalanceDrafts")
    .withIndex("by_org", q => q.eq("orgId", orgId)).take(101);
  if (drafts.length > 100) {
    await requireSuspendedCleanupOrg(ctx, orgId);
    await ctx.db.patch(orgId, { openingCleanupReferenceScan: { resetGeneration: generation, source, cursor: null, complete: false } });
    return false;
  }
  await removeOpeningReferences(ctx, drafts, source);
  return true;
}

async function requireSuspendedCleanupOrg(ctx: MutationCtx, orgId: Id<"organizations">) {
  const org = await ctx.db.get(orgId);
  if (!org?.suspended) throw new ConvexError("Opening cleanup requires a suspended organization.");
  return org;
}

async function removeOpeningReferences(ctx: MutationCtx, drafts: readonly Doc<"openingBalanceDrafts">[], source: OpeningCleanupSource) {
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
