import type { Doc, Id } from "../_generated/dataModel";
import { openingDatabase, type OpeningReadCtx } from "./openingSourceIdentity";
import { denominationOf } from "./money";
import { inTurn } from "./transactionReadHeadroom";

type Opening = Doc<"openingBalanceDrafts">;
type Journal = Doc<"journalEntries">;

/** Optional accounting for readers with their own reserved document/range budget. */
type ProofBudget = { range: () => void; documents: (count: number) => void };
async function proofJournal(ctx: OpeningReadCtx, id: Id<"journalEntries">, budget?: ProofBudget) {
  budget?.range();
  const row = await openingDatabase(ctx).get(id);
  budget?.documents(1);
  return row;
}
async function proofLines(ctx: OpeningReadCtx, id: Id<"journalEntries">, count: number, budget?: ProofBudget) {
  budget?.range();
  const rows = await openingDatabase(ctx).query("journalLines")
    .withIndex("by_journal_entry", q => q.eq("journalEntryId", id)).take(count);
  budget?.documents(rows.length);
  return rows;
}

function validOriginal(draft: Opening, journal: Journal | null): journal is Journal {
  return journal !== null && journal.orgId === draft.orgId && journal._id === draft.journalEntryId &&
    journal.sourceType === "cutover" && journal.sourceId === String(draft.orgId) &&
    journal.category === "OPENING_BALANCE" && journal.currency === draft.currency &&
    journal.accountingDate === draft.asOfDate && journal.periodId !== undefined;
}

/** The draft is a claim; compare it to the actual posted journal before an
 * unwind or an admission exception. No historical line is edited or removed. */
export async function openingJournalLines(ctx: OpeningReadCtx, draft: Opening, journal: Journal, budget?: ProofBudget) {
  if (!validOriginal(draft, journal) || draft.lines.length < 2 || draft.lines.length > 200) return null;
  const denomination = denominationOf(draft.currency);
  if (!denomination) return null;
  const lines = await proofLines(ctx, journal._id, draft.lines.length + 1, budget);
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
export async function verifiedOpeningVoidPair(ctx: OpeningReadCtx, draft: Opening, budget?: ProofBudget): Promise<{
  originalId: Id<"journalEntries">; reversalId: Id<"journalEntries">;
} | null> {
  const request = draft.voidRequest;
  if (draft.status !== "VOIDED" || !request?.approvedBy || request.requestedBy === request.approvedBy ||
      !request.approvedAt || !request.reversalJournalEntryId || !draft.journalEntryId) return null;
  const original = await proofJournal(ctx, draft.journalEntryId, budget);
  const reversal = await proofJournal(ctx, request.reversalJournalEntryId, budget);
  if (!validOriginal(draft, original) || original.status !== "REVERSED" ||
      original.reversedByJournalEntryId !== reversal?._id || !reversal ||
      reversal.orgId !== draft.orgId || reversal.status !== "POSTED" || reversal.category !== "REVERSAL" ||
      reversal.sourceType !== "openingBalanceVoid" || reversal.sourceId !== String(draft._id) ||
      reversal.reversalOfJournalEntryId !== original._id || reversal.periodId !== original.periodId ||
      reversal.currency !== draft.currency || reversal.accountingDate !== draft.asOfDate ||
      reversal.postedBy !== request.approvedBy) return null;
  const lines = await openingJournalLines(ctx, draft, original, budget);
  if (!lines) return null;
  const opposite = await proofLines(ctx, reversal._id, lines.length + 1, budget);
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

/** Complete bounded inventory. A malformed pair or overflow never grants an
 * exception. Guarded reconciliation contexts charge every proof read too. */
export async function verifiedOpeningVoidJournalIds(ctx: OpeningReadCtx, orgId: Id<"organizations">,
  budget?: ProofBudget): Promise<Set<Id<"journalEntries">> | null> {
  budget?.range();
  const voided = await openingDatabase(ctx).query("openingBalanceDrafts").withIndex("by_org_status", q =>
    q.eq("orgId", orgId).eq("status", "VOIDED")).take(101);
  budget?.documents(voided.length);
  if (voided.length > 100) return null;
  const allowed = new Set<Id<"journalEntries">>();
  let complete = true;
  await inTurn(voided, async draft => {
    if (!complete) return;
    const pair = await verifiedOpeningVoidPair(ctx, draft, budget);
    if (pair) { allowed.add(pair.originalId); allowed.add(pair.reversalId); }
    else complete = false;
  });
  return complete ? allowed : null;
}

/** Org-wide, across periods. Incomplete histories are activity, never empty. */
export async function openingLedgerHasActivity(ctx: OpeningReadCtx, orgId: Id<"organizations">,
  currentOpeningId?: Id<"journalEntries">): Promise<boolean> {
  const allowed = await verifiedOpeningVoidJournalIds(ctx, orgId);
  if (!allowed) return true;
  if (currentOpeningId) allowed.add(currentOpeningId);
  let activity = false;
  await inTurn(["POSTED", "REVERSED"] as const, async status => {
    const entries = await openingDatabase(ctx).query("journalEntries").withIndex("by_org_status", q =>
      q.eq("orgId", orgId).eq("status", status)).take(allowed.size + 1);
    if (entries.some(entry => !allowed.has(entry._id))) activity = true;
  });
  return activity;
}
