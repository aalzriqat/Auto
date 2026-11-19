import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { denominationOf } from "./money";
import { openingPolicyForAccount } from "./openingAccountPolicy";

export type OpeningPrepaid = Extract<Doc<"prepaidExpenseSchedules">, { kind: "OPENING" }>;
export type OpeningPrepaidBasisChange = NonNullable<OpeningPrepaid["openingBasisChange"]>;
export const OPENING_PREPAID_ADJUSTMENT_SOURCE = "openingPrepaidBasisChange";

export function isOpeningOffset(offset: Doc<"chartOfAccounts">, schedule: OpeningPrepaid) {
  return offset.orgId === schedule.orgId && offset.active && !offset.isControlAccount && offset.type === "EQUITY" &&
    (offset.currencyRestriction === undefined || offset.currencyRestriction === schedule.currency) &&
    openingPolicyForAccount(offset, false) === "LEDGER_ONLY";
}

export function openingPrepaidDeltaLines(change: OpeningPrepaidBasisChange, reverse = false) {
  const amount = change.correctedTotalMinor - change.originalTotalMinor;
  const delta = reverse ? -amount : amount;
  const debitMinor = Math.max(0, delta);
  const creditMinor = Math.max(0, -delta);
  return [
    { lineNumber: 1, accountId: change.assetAccountId, debitMinor, creditMinor },
    { lineNumber: 2, accountId: change.offsetAccountId, debitMinor: creditMinor, creditMinor: debitMinor },
  ];
}

export function openingPrepaidAdjustments(ctx: QueryCtx, schedule: OpeningPrepaid) {
  return ctx.db.query("journalEntries").withIndex("by_org_source", q =>
    q.eq("orgId", schedule.orgId).eq("sourceType", OPENING_PREPAID_ADJUSTMENT_SOURCE)
      .eq("sourceId", String(schedule._id))).take(3);
}

async function matchesDelta(ctx: QueryCtx, journal: Doc<"journalEntries">, original: Doc<"journalEntries">,
  schedule: OpeningPrepaid, change: OpeningPrepaidBasisChange, reverse: boolean) {
  const scale = denominationOf(schedule.currency)?.scale;
  const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", q =>
    q.eq("journalEntryId", journal._id)).take(3);
  return scale !== undefined && lines.length === 2 && openingPrepaidDeltaLines(change, reverse).every(line => lines.some(row =>
    row.lineNumber === line.lineNumber && row.orgId === schedule.orgId && row.currency === schedule.currency &&
    row.accountingDate === original.accountingDate && row.scale === scale && row.accountId === line.accountId &&
    row.debitMinor === line.debitMinor && row.creditMinor === line.creditMinor && row.bankAccountId === undefined));
}

/** A revised schedule basis is valid only alongside the exact approved journal history. */
export async function verifiedOpeningPrepaidChange(
  ctx: QueryCtx,
  schedule: OpeningPrepaid,
  original: Doc<"journalEntries">,
  accountId: Id<"chartOfAccounts">,
  originalTotalMinor: number,
) {
  const change = schedule.openingBasisChange;
  const approval = change?.approval;
  if (!change || !approval || approval.by === change.requestedBy ||
      change.originalJournalId !== original._id || change.originalTotalMinor !== originalTotalMinor ||
      change.assetAccountId !== accountId || change.offsetAccountId === accountId ||
      !Number.isSafeInteger(change.correctedTotalMinor) || change.correctedTotalMinor <= 0 ||
      change.correctedTotalMinor === originalTotalMinor) return null;
  const journals = await openingPrepaidAdjustments(ctx, schedule);
  const undo = change.reversal?.approval;
  const amount = undo ? originalTotalMinor : change.correctedTotalMinor;
  if (journals.length !== (undo ? 2 : 1) || schedule.totalMinor !== amount) return null;
  const hasOriginalContext = (row: Doc<"journalEntries">) =>
    row.orgId === schedule.orgId && row.periodId === original.periodId &&
    row.accountingDate === original.accountingDate && row.currency === schedule.currency;
  const journal = journals.find(row => row._id === approval.journalId);
  if (!journal || !hasOriginalContext(journal) || journal.category !== "ADJUSTMENT" ||
      journal.status !== (undo ? "REVERSED" : "POSTED") || journal.reversedByJournalEntryId !== undo?.journalId ||
      journal.reversalOfJournalEntryId || journal.postedBy !== approval.by) return null;
  const offset = await ctx.db.get(change.offsetAccountId);
  if (offset?.orgId !== schedule.orgId || offset.type !== "EQUITY" ||
      !await matchesDelta(ctx, journal, original, schedule, change, false)) return null;
  if (undo) {
    const reversal = journals.find(row => row._id === undo.journalId);
    if (!reversal || !hasOriginalContext(reversal) || reversal.category !== "REVERSAL" || reversal.status !== "POSTED" ||
        reversal.reversalOfJournalEntryId !== journal._id || reversal.reversedByJournalEntryId ||
        undo.by === change.reversal?.requestedBy || reversal.postedBy !== undo.by ||
        !await matchesDelta(ctx, reversal, original, schedule, change, true)) return null;
  }
  return journal._id;
}
