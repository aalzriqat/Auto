import { loadOpeningSourceIdentity } from "./openingSourceIdentity";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireOwnedRow } from "./tenancy";
import { orgResetState } from "./orgResetGeneration";

/** The management artifact is supported by the actual immutable posted opening, not its label. */
export async function requireManagementOpening(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">,
  openingDraftId: Id<"openingBalanceDrafts">, currency: string) {
  const org = await ctx.db.get(orgId);
  const reset = orgResetState(org);
  if (reset.inProgress) throw new ConvexError("Complete the financial reset before preparing a management schedule.");
  const parent = await requireOwnedRow(ctx, orgId, "openingBalanceDrafts", openingDraftId, "Opening balance unavailable.");
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  if (parent.status !== "POSTED" || source.status !== "AVAILABLE" || source.parent._id !== parent._id ||
      parent.currency !== currency || !parent.journalEntryId || !Number.isSafeInteger(parent.asOfDate)) {
    throw new ConvexError("The posted opening basis is unavailable for this management schedule.");
  }
  const journal = await ctx.db.get(parent.journalEntryId);
  if (!journal || journal.orgId !== orgId || journal.status !== "POSTED" || journal.sourceType !== "cutover" ||
      journal.category !== "OPENING_BALANCE" || journal.sourceId !== String(orgId) ||
      journal.accountingDate !== parent.asOfDate || journal.currency !== currency) {
    throw new ConvexError("The posted opening basis is unavailable for this management schedule.");
  }
  const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) =>
    q.eq("journalEntryId", journal._id)).take(parent.lines.length + 1);
  if (lines.length !== parent.lines.length || new Set(lines.map((line) => line.lineNumber)).size !== lines.length ||
      !lines.every((line) => {
        const original = parent.lines[line.lineNumber - 1];
        return original && line.orgId === orgId && line.currency === currency && line.accountingDate === parent.asOfDate &&
          line.accountId === original.accountId && line.debitMinor === original.debitMinor &&
          line.creditMinor === original.creditMinor && line.bankAccountId === original.bankAccountId &&
          line.description === original.description;
      })) throw new ConvexError("The posted opening basis is unavailable for this management schedule.");
  return { parent, resetGeneration: reset.generation };
}