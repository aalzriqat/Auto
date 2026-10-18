import type { Change } from "convex-helpers/server/triggers";
import { makeFunctionReference } from "convex/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const eligibilityPage = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }>(
  "journalReportEligibility:backfillPage",
);

export function isPostedParent(parent: Doc<"journalEntries"> | null): boolean {
  return parent !== null && (parent.status === "POSTED" || parent.status === "REVERSED");
}

/** Reset even an in-progress traversal: an earlier page may now be stale. */
export async function invalidateJournalEligibility(ctx: MutationCtx, orgIds: readonly Id<"organizations">[]): Promise<void> {
  const states = await Promise.all([...new Set(orgIds)].map(orgId =>
    ctx.db.query("journalReportEligibility").withIndex("by_org", q => q.eq("orgId", orgId)).unique()));
  // Invalidate BOTH sides before a failure-prone scheduler call. A caught
  // scheduling failure must never leave the second org's certificate READY.
  for (const state of states) {
    if (state && state.phase !== "BLOCKED") await ctx.db.patch(state._id, { phase: "BUILDING", cursor: null });
  }
  for (const state of states) {
    if (state?.phase === "READY") await ctx.scheduler.runAfter(0, eligibilityPage, { orgId: state.orgId });
  }
}

export async function synchronizeJournalLineEligibility(
  ctx: MutationCtx,
  change: Change<DataModel, "journalLines">,
): Promise<void> {
  if (!change.newDoc) return; // Deleting a line removes it from the index atomically.
  const line = change.newDoc;
  try {
    const parent = await ctx.db.get("journalEntries", line.journalEntryId);
    const reportPosted = parent?.orgId === line.orgId && isPostedParent(parent);
    if (line.reportPosted !== reportPosted) {
      await ctx.db.patch(line._id, { reportPosted });
    }
  } catch (error) {
    // A caller may catch a trigger error. Never leave an old READY certificate
    // authorizing a flag that this source write failed to maintain.
    await invalidateJournalEligibility(ctx, [line.orgId, ...(change.oldDoc ? [change.oldDoc.orgId] : [])]);
    throw error;
  }
}

export async function invalidateJournalParentEligibility(
  ctx: MutationCtx,
  change: Change<DataModel, "journalEntries">,
): Promise<void> {
  // New server-issued IDs cannot have earlier linked lines. New lines compute
  // eligibility themselves. Bulk platform imports need invalidate/rebuild.
  if (!change.oldDoc) return;
  if (change.newDoc?.orgId === change.oldDoc.orgId &&
      isPostedParent(change.newDoc) === isPostedParent(change.oldDoc)) return;
  // No unbounded child cascade. All previously eligible lines belong to the
  // old org; newly eligible lines can only belong to the new org.
  await invalidateJournalEligibility(ctx, [change.oldDoc.orgId, ...(change.newDoc ? [change.newDoc.orgId] : [])]);
}
