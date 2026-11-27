import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveSystemAccount } from "../accounting/chartAccountsRead";
import { SYSTEM_KEYS } from "./defaultChart";

/**
 * SCRUM-961: the proof side of "employee advances moved out of an opening prepaid schedule". A leaf module on purpose:
 * the prepaid source resolver and the opening-advance basis both need it, and neither may import the command module.
 * Nothing here trusts a marker or a status field alone. An approved request counts only when the posted event, the
 * journal it created and its debit to Employee Advances all agree with it.
 */
export const PREPAID_RECLASS_EVENT = "PREPAID_RECLASSIFIED_TO_ADVANCES";
export const PREPAID_RECLASS_SOURCE = "openingPrepaidReclassifications";
export const PREPAID_RECLASS_VERSION = 1;
/** `.take(n)` gives no signal that more rows exist, so a bounded read that returns this many is treated as unprovable. */
export const RECLASS_READ_BOUND = 500;
export function prepaidReclassKey(reclassificationId: string): string {
  return `prepaid_reclass_${reclassificationId}`;
}

export const prepaidReclassPayload = z.object({
  reclassificationId: z.string().min(1),
  scheduleId: z.string().min(1),
  totalMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  trueUpMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expenseSystemKey: z.string().min(1),
}).strict();

type Reader = QueryCtx | MutationCtx;
type Reclass = Doc<"openingPrepaidReclassifications">;

export interface VerifiedReclass {
  row: Reclass;
  event: Doc<"accountingEvents">;
  journal: Doc<"journalEntries">;
}

/** The approved request together with its proven event and journal, or null when anything disagrees. */
export async function verifiedReclassification(ctx: Reader, orgId: Id<"organizations">, row: Reclass): Promise<VerifiedReclass | null> {
  if (row.orgId !== orgId || row.status !== "APPROVED" || !row.eventId || !row.journalEntryId || !row.advanceIds ||
      row.trueUpMinor === undefined) return null;
  const [event, journal] = await Promise.all([ctx.db.get(row.eventId), ctx.db.get(row.journalEntryId)]);
  if (!event || !journal || event.orgId !== orgId || journal.orgId !== orgId || event.status !== "POSTED" ||
      event.eventType !== PREPAID_RECLASS_EVENT || event.sourceType !== PREPAID_RECLASS_SOURCE ||
      event.sourceId !== String(row._id) || event.eventVersion !== PREPAID_RECLASS_VERSION ||
      event.idempotencyKey !== prepaidReclassKey(String(row._id)) || event.journalEntryId !== journal._id) return null;
  const payload = prepaidReclassPayload.safeParse(event.payload);
  if (!payload.success || payload.data.reclassificationId !== String(row._id) || payload.data.scheduleId !== String(row.scheduleId) ||
      payload.data.totalMinor !== row.totalMinor || payload.data.trueUpMinor !== row.trueUpMinor) return null;
  if (journal.status !== "POSTED" || journal.reversedByJournalEntryId || journal.category !== "ADJUSTMENT" ||
      journal.sourceType !== PREPAID_RECLASS_SOURCE || journal.sourceId !== String(row._id) ||
      journal.accountingEventId !== event._id) return null;
  const advanceAccount = await resolveSystemAccount(ctx, orgId, SYSTEM_KEYS.EMPLOYEE_ADVANCES);
  const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).take(RECLASS_READ_BOUND);
  if (lines.length >= RECLASS_READ_BOUND) return null;
  const debit = lines.filter((line) => line.accountId === advanceAccount).reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
  return debit === row.totalMinor ? { row, event, journal } : null;
}

/**
 * How much an approved reclassification took out of this schedule's opening allocation: 0 when none exists, the
 * proven total when exactly one does, and null when the history cannot be proven (the caller treats null as unavailable).
 */
export async function verifiedPrepaidReduction(ctx: Reader, orgId: Id<"organizations">, scheduleId: Id<"prepaidExpenseSchedules">): Promise<number | null> {
  const approved = await ctx.db.query("openingPrepaidReclassifications")
    .withIndex("by_org_schedule_status", (q) => q.eq("orgId", orgId).eq("scheduleId", scheduleId).eq("status", "APPROVED")).take(2);
  if (approved.length === 0) return 0;
  const [only] = approved;
  if (approved.length > 1 || !only || (await verifiedReclassification(ctx, orgId, only)) === null) return null;
  return only.totalMinor;
}

type ReclassAdvanceBasis = { kind: "OPENING"; basisDate: number } | { kind: "INVALID" } | { kind: "NOT_RECLASSIFIED" };

/**
 * Is this advance one that an approved reclassification created? The marker on the advance is checked against the
 * request's own `advanceIds`, in both directions, so removing the marker cannot turn it into an ordinary advance and
 * adding one cannot promote an ordinary advance.
 */
export async function reclassifiedAdvanceBasis(ctx: Reader, orgId: Id<"organizations">, advance: Doc<"employeeAdvances"> | null,
  advanceId: Id<"employeeAdvances">): Promise<ReclassAdvanceBasis> {
  const approved = await ctx.db.query("openingPrepaidReclassifications")
    .withIndex("by_org", (q) => q.eq("orgId", orgId)).take(RECLASS_READ_BOUND);
  if (approved.length >= RECLASS_READ_BOUND) return { kind: "INVALID" };
  const owner = approved.find((row) => row.advanceIds?.includes(advanceId));
  if (!advance?.prepaidReclassificationId && !owner) return { kind: "NOT_RECLASSIFIED" };
  if (!advance || !owner || advance.orgId !== orgId || advance.isDeleted || advance.prepaidReclassificationId !== owner._id) return { kind: "INVALID" };
  const proof = await verifiedReclassification(ctx, orgId, owner);
  const hasLine = owner.lines.some((candidate) => candidate.userId === advance.userId && candidate.amountMinor === advance.amountMinor);
  if (!proof || !hasLine || advance.currency !== proof.event.currency || advance.date !== proof.journal.accountingDate ||
      advance.method !== undefined || advance.bankAccountId !== undefined || !Number.isSafeInteger(advance.amountMinor) ||
      advance.amountMinor <= 0 || !Number.isSafeInteger(advance.recoveredMinor) || advance.recoveredMinor < 0 ||
      advance.recoveredMinor > advance.amountMinor) return { kind: "INVALID" };
  return { kind: "OPENING", basisDate: proof.journal.accountingDate };
}
