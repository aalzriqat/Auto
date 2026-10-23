import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveSystemAccount } from "../chartOfAccounts";
import { SYSTEM_KEYS } from "./defaultChart";
import { toMinorUnits } from "./money";

type PrepaidSource =
  | { kind: "EXPENSE"; expenseId: Id<"expenses">; title: string; basisDate: number | null; taxMinor: number }
  | { kind: "OPENING"; draftId: Id<"openingBalanceDrafts">; rowKey: string; title: string; basisDate: number; taxMinor: 0 }
  | { kind: "UNAVAILABLE"; reason: string };

const unavailable = (): PrepaidSource => ({ kind: "UNAVAILABLE", reason: "The prepaid asset source cannot be verified. Ask finance to review it before using this schedule." });

function validYearMonth(value: string): boolean {
  return /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])$/.test(value);
}

function validOpeningSchedule(schedule: Extract<Doc<"prepaidExpenseSchedules">, { kind: "OPENING" }>): boolean {
  const startIndex = Number(schedule.startYearMonth.slice(0, 4)) * 12 + Number(schedule.startYearMonth.slice(5, 7)) - 1;
  return validYearMonth(schedule.startYearMonth) && Number.isSafeInteger(schedule.totalMinor) && schedule.totalMinor > 0 &&
    Number.isSafeInteger(schedule.termMonths) && schedule.termMonths > 0 &&
    Number.isSafeInteger(startIndex + schedule.termMonths - 1) && startIndex + schedule.termMonths - 1 <= 9999 * 12 + 11 &&
    Number.isSafeInteger(schedule.openingBalanceDate) && schedule.openingBalanceDate >= 0 &&
    Number.isSafeInteger(schedule.recognizedMinor) && schedule.recognizedMinor >= 0 && schedule.recognizedMinor <= schedule.totalMinor &&
    schedule.attestedUnexpiredBenefit === true && schedule.title.trim().length > 0;
}

/**
 * A schedule shape is not evidence of an asset. Resolve the immutable posted
 * source and the actual journal before recognizing, reporting or allowing a
 * credit. Inspect parent result references first so removing/replacing the
 * schedule's opening marker cannot silently turn it into an ordinary expense.
 */
export async function resolvePrepaidScheduleSource(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  scheduleId: Id<"prepaidExpenseSchedules">,
): Promise<PrepaidSource> {
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule || schedule.orgId !== orgId) return unavailable();

  const drafts = await ctx.db.query("openingBalanceDrafts")
    .withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
  const references = drafts.flatMap((draft) => (draft.allocationResults ?? [])
    .filter((row) => row.kind === "PREPAID_EXPENSE" && row.scheduleId === scheduleId)
    .map((row) => ({ draft, row })));
  if (references.length > 1) return unavailable();
  if (schedule.kind !== "OPENING") {
    if (references.length !== 0) return unavailable();
    const expense = await ctx.db.get(schedule.expenseId);
    if (!expense || expense.orgId !== orgId) return unavailable();
    const posted = await ctx.db.query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", schedule.expenseId.toString()))
      .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .take(2);
    if (posted.length > 1) return unavailable();
    return { kind: "EXPENSE", expenseId: schedule.expenseId, title: expense.title,
      basisDate: posted[0]?.accountingDate ?? null,
      taxMinor: expense.taxAmount ? toMinorUnits(expense.taxAmount, schedule.currency) : 0 };
  }

  if (!validOpeningSchedule(schedule) || references.length !== 1) return unavailable();
  const { draft, row } = references[0];
  const matchingRows = draft.allocations?.filter((allocation) => allocation.kind === "PREPAID_EXPENSE" && allocation.rowKey === row.rowKey) ?? [];
  const allocation = matchingRows[0];
  if (draft.status !== "POSTED" || draft._id !== schedule.openingBalanceDraftId || matchingRows.length !== 1 ||
      allocation?.kind !== "PREPAID_EXPENSE" || row.rowKey !== schedule.openingRowKey ||
      allocation.accountId === undefined || allocation.amountMinor !== schedule.totalMinor ||
      allocation.title.trim() !== schedule.title || allocation.startYearMonth !== schedule.startYearMonth ||
      allocation.termMonths !== schedule.termMonths || allocation.expenseSystemKey !== schedule.expenseSystemKey ||
      allocation.attestedUnexpiredBenefit !== true || draft.currency !== schedule.currency ||
      draft.asOfDate !== schedule.openingBalanceDate) return unavailable();
  const journal = draft.journalEntryId ? await ctx.db.get(draft.journalEntryId) : null;
  if (!journal || journal.orgId !== orgId || journal.status !== "POSTED" || journal.sourceType !== "cutover" ||
      journal.category !== "OPENING_BALANCE" || journal.sourceId !== String(orgId) ||
      journal.accountingDate !== draft.asOfDate || journal.currency !== schedule.currency) return unavailable();
  const accountId = await resolveSystemAccount(ctx, orgId, SYSTEM_KEYS.PREPAID_EXPENSES);
  if (allocation.accountId !== accountId) return unavailable();
  const siblings = draft.allocations?.filter((candidate) => candidate.kind === "PREPAID_EXPENSE") ?? [];
  const total = siblings.reduce((sum, candidate) => sum + candidate.amountMinor, 0);
  if (siblings.length === 0 || !Number.isSafeInteger(total) ||
      siblings.some((candidate) => candidate.accountId !== accountId || !Number.isSafeInteger(candidate.amountMinor) || candidate.amountMinor <= 0)) return unavailable();
  const lines = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).collect();
  const assetLines = lines.filter((line) => line.accountId === accountId);
  if (assetLines.length === 0 || assetLines.some((line) => line.orgId !== orgId || line.currency !== schedule.currency ||
      line.accountingDate !== draft.asOfDate || !Number.isSafeInteger(line.debitMinor) || line.debitMinor < 0 || line.creditMinor !== 0) ||
      assetLines.reduce((sum, line) => sum + line.debitMinor, 0) !== total) return unavailable();
  return { kind: "OPENING", draftId: draft._id, rowKey: row.rowKey, title: schedule.title,
    basisDate: journal.accountingDate, taxMinor: 0 };
}
