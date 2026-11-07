import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { denominationOf } from "./money";
import { inTurn } from "./transactionReadHeadroom";

type Opening = Doc<"openingBalanceDrafts">;
type Journal = Doc<"journalEntries">;

function validOriginal(draft: Opening, journal: Journal | null): journal is Journal {
  return journal !== null && journal.orgId === draft.orgId && journal._id === draft.journalEntryId &&
    journal.sourceType === "cutover" && journal.sourceId === String(draft.orgId) &&
    journal.category === "OPENING_BALANCE" && journal.currency === draft.currency &&
    journal.accountingDate === draft.asOfDate && journal.periodId !== undefined;
}

/** The draft is a claim; compare it to the actual posted journal before an
 * unwind or an admission exception. No historical line is edited or removed. */
export async function openingJournalLines(ctx: QueryCtx, draft: Opening, journal: Journal) {
  if (!validOriginal(draft, journal) || draft.lines.length < 2 || draft.lines.length > 200) return null;
  const denomination = denominationOf(draft.currency);
  if (!denomination) return null;
  const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", journal._id))
    .take(draft.lines.length + 1);
  if (lines.length !== draft.lines.length || new Set(lines.map(line => line.lineNumber)).size !== lines.length) return null;
  if (!lines.every(line => {
    const entered = draft.lines[line.lineNumber - 1];
    return entered !== undefined && line.orgId === draft.orgId && line.currency === draft.currency &&
      line.scale === denomination.scale && line.accountingDate === draft.asOfDate &&
      line.accountId === entered.accountId && line.bankAccountId === entered.bankAccountId &&
      line.debitMinor === entered.debitMinor && line.creditMinor === entered.creditMinor &&
      Number.isSafeInteger(line.debitMinor) && Number.isSafeInteger(line.creditMinor) &&
      line.debitMinor >= 0 && line.creditMinor >= 0 && !(line.debitMinor > 0 && line.creditMinor > 0);
  })) return null;
  const debit = lines.reduce((sum, line) => sum + BigInt(line.debitMinor), 0n);
  const credit = lines.reduce((sum, line) => sum + BigInt(line.creditMinor), 0n);
  return debit > 0n && debit === credit && debit <= BigInt(Number.MAX_SAFE_INTEGER) ? lines : null;
}

/** A status or a category is never enough to excuse ledger history. */
export async function verifiedOpeningVoidPair(ctx: QueryCtx, draft: Opening): Promise<{
  originalId: Id<"journalEntries">; reversalId: Id<"journalEntries">;
} | null> {
  const request = draft.voidRequest;
  if (draft.status !== "VOIDED" || !request?.approvedBy || request.requestedBy === request.approvedBy ||
      !request.approvedAt || !request.reversalJournalEntryId || !draft.journalEntryId) return null;
  const original = await ctx.db.get(draft.journalEntryId);
  const reversal = await ctx.db.get(request.reversalJournalEntryId);
  if (!validOriginal(draft, original) || original.status !== "REVERSED" ||
      original.reversedByJournalEntryId !== reversal?._id || !reversal ||
      reversal.orgId !== draft.orgId || reversal.status !== "POSTED" || reversal.category !== "REVERSAL" ||
      reversal.sourceType !== "openingBalanceVoid" || reversal.sourceId !== String(draft._id) ||
      reversal.reversalOfJournalEntryId !== original._id || reversal.periodId !== original.periodId ||
      reversal.currency !== draft.currency || reversal.accountingDate !== draft.asOfDate ||
      reversal.postedBy !== request.approvedBy) return null;
  const lines = await openingJournalLines(ctx, draft, original);
  if (!lines) return null;
  const opposite = await ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", reversal._id))
    .take(lines.length + 1);
  const byNumber = new Map(lines.map(line => [line.lineNumber, line]));
  if (opposite.length !== lines.length || new Set(opposite.map(line => line.lineNumber)).size !== lines.length ||
      !opposite.every(line => {
        const before = byNumber.get(line.lineNumber);
        return before !== undefined && line.orgId === draft.orgId && line.accountId === before.accountId &&
          line.currency === before.currency && line.scale === before.scale && line.bankAccountId === before.bankAccountId &&
          line.accountingDate === before.accountingDate && line.debitMinor === before.creditMinor && line.creditMinor === before.debitMinor;
      })) return null;
  return { originalId: original._id, reversalId: reversal._id };
}

/** Org-wide, across periods. Incomplete histories are activity, never an empty
 * ledger. The only exception is the exact journal pair of a governed void. */
export async function openingLedgerHasActivity(ctx: QueryCtx, orgId: Id<"organizations">,
  currentOpeningId?: Id<"journalEntries">): Promise<boolean> {
  const voided = await ctx.db.query("openingBalanceDrafts").withIndex("by_org_status", q =>
    q.eq("orgId", orgId).eq("status", "VOIDED")).take(101);
  if (voided.length > 100) return true;
  const allowed = new Set<Id<"journalEntries">>();
  if (currentOpeningId) allowed.add(currentOpeningId);
  await inTurn(voided, async draft => {
    const pair = await verifiedOpeningVoidPair(ctx, draft);
    if (pair) { allowed.add(pair.originalId); allowed.add(pair.reversalId); }
  });
  let activity = false;
  await inTurn(["POSTED", "REVERSED"] as const, async status => {
    const entries = await ctx.db.query("journalEntries").withIndex("by_org_status", q =>
      q.eq("orgId", orgId).eq("status", status)).take(allowed.size + 1);
    if (entries.some(entry => !allowed.has(entry._id))) activity = true;
  });
  return activity;
}
