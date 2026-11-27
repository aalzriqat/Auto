// SCRUM-1023: shared helpers of the purge dry-run test files. They build worlds out of the SCRUM-987 fixture
// (real cancelled finance deals) and, where a test needs complete reversed pairs, reverse the deal's events
// through the REAL reversal engine (`reverseAccountingEvent`) so the pairs carry production's exact links.
import type { Doc, Id } from "../convex/_generated/dataModel";
import { internal } from "../convex/_generated/api";
import { incrementAccountSnapshot } from "../convex/accounting/accountSnapshots";
import { reverseAccountingEvent } from "../convex/accounting/reversals";
import type { PreviewPurgeResult } from "../convex/purgeTestRecords";
import type { ApprovedException } from "../convex/utils/purgeManifestLedger";
import type { World } from "./scrum987Fixture";

export type Manifest = Extract<PreviewPurgeResult, { success: true }>["manifest"];

export interface PreviewRoots { saleIds?: string[]; applicationIds?: string[]; expenseIds?: string[]; transferEventIds?: string[] }

export async function accountId(w: World, systemKey: string): Promise<Id<"chartOfAccounts">> {
  const row = await w.t.run((ctx) =>
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", w.orgId).eq("systemKey", systemKey)).first());
  if (!row) throw new Error(`no account ${systemKey}`);
  return row._id;
}

export async function previewResult(
  w: World, roots: PreviewRoots, approvedExceptions: ApprovedException[] = [], approvedLiveRowIds: string[] = [],
  approvedFieldClearIds: string[] = [],
): Promise<PreviewPurgeResult> {
  return await w.t.query(internal.purgeTestRecords.previewPurge, {
    orgId: w.orgId,
    saleIds: roots.saleIds ?? [],
    applicationIds: roots.applicationIds ?? [],
    expenseIds: roots.expenseIds ?? [],
    transferEventIds: roots.transferEventIds ?? [],
    approvedExceptions,
    ...(approvedLiveRowIds.length > 0 ? { approvedLiveRowIds } : {}),
    ...(approvedFieldClearIds.length > 0 ? { approvedFieldClearIds } : {}),
  }) as PreviewPurgeResult;
}

export async function preview(
  w: World, roots: PreviewRoots, approvedExceptions: ApprovedException[] = [], approvedLiveRowIds: string[] = [],
  approvedFieldClearIds: string[] = [],
): Promise<Manifest> {
  const res = await previewResult(w, roots, approvedExceptions, approvedLiveRowIds, approvedFieldClearIds);
  if (!res.success) throw new Error(`preview failed: ${res.error}`);
  return res.manifest;
}

export const codes = (m: Manifest): string[] => [...new Set(m.refusals.map((r) => r.code))].sort((a, b) => a.localeCompare(b));

export async function openOctober(w: World): Promise<void> {
  await w.t.run((ctx) => ctx.db.patch(w.octPeriodId, { status: "OPEN" }));
}

/** The accounting events that belong to one fixture deal (they name its application, custody, fee or entry). */
export async function dealEvents(w: World, index: number): Promise<Doc<"accountingEvents">[]> {
  const target = w.targets[index];
  const needles = [target.applicationId, target.custodyId, target.feeId, target.entryId];
  const all = await w.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect());
  return all.filter((e) => needles.some((n) => JSON.stringify(e).includes(n)));
}

/**
 * The owner-approved balance change of fixture deal `index` (production deal 6's shape: custody cash and fee never
 * reversed). It names the deal's exact events and journals and the expected net per (period, account, currency).
 */
export async function approvedFor(w: World, index: number, amount: number, cashKey: string, expenseKey: string): Promise<ApprovedException> {
  const events = await dealEvents(w, index);
  return {
    rootId: w.targets[index].applicationId,
    eventIds: events.map((e) => e._id),
    journalIds: events.flatMap((e) => (e.journalEntryId ? [e.journalEntryId] : [])),
    expectedNets: [
      { periodId: w.octPeriodId, accountId: await accountId(w, cashKey), currency: "JOD", netMinor: -amount },
      { periodId: w.octPeriodId, accountId: await accountId(w, expenseKey), currency: "JOD", netMinor: amount },
    ],
  };
}

/** Reverses one event through the real engine and returns the reversal event. */
export async function reverseEvent(w: World, eventId: Id<"accountingEvents">, key: string): Promise<Doc<"accountingEvents">> {
  const reversalId = await w.t.run(async (ctx) => {
    const res = await reverseAccountingEvent(ctx, {
      orgId: w.orgId, originalEventId: eventId, reversalDate: Date.UTC(2026, 9, 20), reason: "test reversal", actorId: w.actorId, idempotencyKey: key,
    });
    return res.reversalEventId;
  });
  const row = await w.t.run((ctx) => ctx.db.get(reversalId));
  if (!row) throw new Error("reversal event missing");
  return row;
}

/** Opens October and reverses every event of fixture deal `index`: the production shape (complete reversed pairs). */
export async function reverseDeal(w: World, index: number): Promise<{ originals: Doc<"accountingEvents">[]; reversals: Doc<"accountingEvents">[] }> {
  await openOctober(w);
  const originals = await dealEvents(w, index);
  const reversals: Doc<"accountingEvents">[] = [];
  for (const [i, e] of originals.entries()) reversals.push(await reverseEvent(w, e._id, `rev-${index}-${i}-${e._id}`));
  return { originals, reversals };
}

/** A copy of a document without the system fields, to insert a sibling row. */
export function copyOf<T extends { _id: unknown; _creationTime: number }>(doc: T): Omit<T, "_id" | "_creationTime"> {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
}

/**
 * Inserts a POSTED copy of an event together with a copy of its journal and lines. `invert` swaps debits and
 * credits, so (original copy + inverted copy) is a pair that offsets without any reversal link.
 */
export async function cloneEntry(
  w: World, eventId: Id<"accountingEvents">, key: string, invert: boolean, payload: Record<string, unknown>,
  eventType?: string,
): Promise<{ eventId: Id<"accountingEvents">; journalId: Id<"journalEntries"> }> {
  return await w.t.run(async (ctx) => {
    const e = await ctx.db.get(eventId);
    const j = e?.journalEntryId ? await ctx.db.get(e.journalEntryId) : null;
    if (!e || !j) throw new Error("event or journal missing");
    const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", j._id)).collect();
    // The copy names none of the original's ids (sourceId, links), only what `payload` says, so a test decides what joins it.
    const newEvent = await ctx.db.insert("accountingEvents", {
      ...copyOf(e), idempotencyKey: key, payload, sourceId: key, journalEntryId: undefined, reversedByEventId: undefined, reversalOfEventId: undefined,
      ...(eventType ? { eventType } : {}),
    });
    const newJournal = await ctx.db.insert("journalEntries", {
      ...copyOf(j), accountingEventId: newEvent, journalNumber: `JE-${key}`, sourceId: key, reversedByJournalEntryId: undefined, reversalOfJournalEntryId: undefined,
    });
    for (const l of lines) {
      await ctx.db.insert("journalLines", {
        ...copyOf(l), journalEntryId: newJournal,
        debitMinor: invert ? l.creditMinor : l.debitMinor, creditMinor: invert ? l.debitMinor : l.creditMinor,
      });
      // Like every real posting, the copy also moves the running snapshot, so the snapshot room check sees a true ledger.
      if (j.periodId) {
        await incrementAccountSnapshot(ctx, {
          orgId: w.orgId, accountId: l.accountId, currency: l.currency, periodId: j.periodId,
          debitMinor: invert ? l.creditMinor : l.debitMinor, creditMinor: invert ? l.debitMinor : l.creditMinor,
        });
      }
    }
    await ctx.db.patch(newEvent, { journalEntryId: newJournal, status: "POSTED" });
    return { eventId: newEvent, journalId: newJournal };
  });
}

/** Links two cloned entries as a complete reversed pair, exactly the links the reversal engine writes. */
export async function linkAsPair(
  w: World, original: { eventId: Id<"accountingEvents">; journalId: Id<"journalEntries"> },
  reversal: { eventId: Id<"accountingEvents">; journalId: Id<"journalEntries"> },
): Promise<void> {
  await w.t.run(async (ctx) => {
    await ctx.db.patch(original.eventId, { status: "REVERSED", reversedByEventId: reversal.eventId });
    await ctx.db.patch(reversal.eventId, { eventType: "JOURNAL_REVERSAL", reversalOfEventId: original.eventId });
    await ctx.db.patch(original.journalId, { status: "REVERSED", reversedByJournalEntryId: reversal.journalId });
    await ctx.db.patch(reversal.journalId, { category: "REVERSAL", status: "POSTED", reversalOfJournalEntryId: original.journalId });
  });
}
