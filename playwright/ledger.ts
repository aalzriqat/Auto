import { expect } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

/**
 * Reads the general ledger the way an accountant would — through the public
 * trial balance and journal queries — so a browser scenario can prove what a
 * deal actually POSTED, not only what the screen showed (SCRUM-595).
 *
 * The expected figures are never computed here. Every expectation is a
 * hand-written minor-unit literal in the spec, derived in a comment from the
 * owner rulings (SCRUM-486 OR-1..OR-5, c21360). Nothing from convex/utils money
 * code is imported, so a wrong production formula cannot certify itself
 * (SCRUM-486 A10).
 *
 * The delta is org-wide on purpose: a posting that lands on an account nobody
 * expected is exactly the defect a per-deal filter would hide. That makes the
 * scenarios serial — run them with one worker on a deployment nothing else is
 * writing to.
 */

type Side = { dr: number; cr: number };
export type LedgerSnapshot = {
  byCode: Map<string, Side>;
  entryIds: Set<string>;
  eventIds: Set<string>;
};
export type ExpectedLedgerDelta = Record<string, Partial<Side>>;

async function allJournalEntryIds(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page: { page: Array<{ _id: string }>; isDone: boolean; continueCursor: string } =
      await client.query(api.accountingLedger.listJournalEntries, {
      orgId,
      paginationOpts: { numItems: 200, cursor },
    });
    for (const entry of page.page) ids.add(entry._id);
    if (page.isDone) return ids;
    cursor = page.continueCursor;
  }
}

async function allEventIds(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
): Promise<Map<string, { status: string; eventType: string }>> {
  const events = await client.query(api.accountingLedger.listAccountingEvents, {
    orgId,
    limit: 200,
  });
  return new Map(
    (events as Array<{ _id: string; status: string; eventType: string }>).map((e) => [
      e._id,
      { status: e.status, eventType: e.eventType },
    ]),
  );
}

export async function snapshotLedger(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
): Promise<LedgerSnapshot> {
  const tb = await client.query(api.accountingReports.trialBalance, { orgId });
  const byCode = new Map<string, Side>();
  for (const row of tb.rows) {
    const side = byCode.get(row.code) ?? { dr: 0, cr: 0 };
    side.dr += row.debitMinor;
    side.cr += row.creditMinor;
    byCode.set(row.code, side);
  }
  return {
    byCode,
    entryIds: await allJournalEntryIds(client, orgId),
    eventIds: new Set((await allEventIds(client, orgId)).keys()),
  };
}

export type LedgerDelta = {
  /** Gross debit and credit movement per account code since the snapshot. */
  byCode: Record<string, Side>;
  newEntries: Array<{ id: string; memo: string; debit: number; credit: number }>;
  /** New events that did not post: queued, failed or skipped. */
  unposted: Array<{ id: string; status: string; eventType: string }>;
};

export async function ledgerDelta(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
  before: LedgerSnapshot,
): Promise<LedgerDelta> {
  const after = await snapshotLedger(client, orgId);
  const byCode: Record<string, Side> = {};
  for (const code of new Set([...before.byCode.keys(), ...after.byCode.keys()])) {
    const a = after.byCode.get(code) ?? { dr: 0, cr: 0 };
    const b = before.byCode.get(code) ?? { dr: 0, cr: 0 };
    if (a.dr !== b.dr || a.cr !== b.cr) byCode[code] = { dr: a.dr - b.dr, cr: a.cr - b.cr };
  }

  const newEntries: LedgerDelta["newEntries"] = [];
  for (const id of after.entryIds) {
    if (before.entryIds.has(id)) continue;
    const detail = await client.query(api.accountingLedger.getJournalEntry, {
      orgId,
      journalEntryId: id as Id<"journalEntries">,
    });
    if (!detail) continue;
    newEntries.push({
      id,
      memo: (detail.entry as { memo?: string }).memo ?? "",
      debit: detail.lines.reduce((sum, l) => sum + l.debitMinor, 0),
      credit: detail.lines.reduce((sum, l) => sum + l.creditMinor, 0),
    });
  }

  const events = await allEventIds(client, orgId);
  const unposted: LedgerDelta["unposted"] = [];
  for (const [id, e] of events) {
    if (before.eventIds.has(id)) continue;
    if (e.status !== "POSTED" && e.status !== "REVERSED") unposted.push({ id, ...e });
  }
  return { byCode, newEntries, unposted };
}

/**
 * The ledger moved by exactly `expected` — no account more, none less — every
 * new journal entry balances, and nothing was left queued or failed.
 */
export function expectLedgerDelta(delta: LedgerDelta, expected: ExpectedLedgerDelta): void {
  for (const entry of delta.newEntries) {
    expect(entry.debit, `journal entry ${entry.id} (${entry.memo}) must balance`).toBe(entry.credit);
  }
  expect(delta.unposted, "every accounting event the deal raised must have posted").toEqual([]);

  const normalized: Record<string, Side> = {};
  for (const [code, side] of Object.entries(expected)) {
    const dr = side.dr ?? 0;
    const cr = side.cr ?? 0;
    if (dr !== 0 || cr !== 0) normalized[code] = { dr, cr };
  }
  expect(delta.byCode).toEqual(normalized);
}

/**
 * The ledger month containing `at` is OPEN, and anything queued while it was
 * not has drained.
 *
 * Without an open period every posting parks in the outbox
 * (`postOrEnqueue`): the deal still closes, and the ledger shows nothing. A
 * dealership opens its months from the accounting workspace; a fresh
 * deployment has only the months somebody opened, so the scenarios open the
 * one they post into — the same public mutation that workspace calls.
 */
export async function ensureLedgerMonthOpen(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
  at: Date = new Date(),
): Promise<void> {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const periods = (await client.query(api.accountingPeriods.list, { orgId })) as Array<{
    _id: Id<"accountingPeriods">;
    fiscalYear: number;
    periodNumber: number;
    status: string;
  }>;
  const period = periods.find((p) => p.fiscalYear === year && p.periodNumber === month + 1);
  if (!period) {
    await client.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: year,
      periodNumber: month + 1,
      startDate: Date.UTC(year, month, 1),
      endDate: Date.UTC(year, month + 1, 1) - 1,
      openImmediately: true,
    });
  } else if (period.status !== "OPEN") {
    await client.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }
  await drainOutbox(client, orgId);
}

/** Re-drives the outbox and waits until nothing is left PENDING. */
export async function drainOutbox(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
): Promise<void> {
  await client.mutation(api.accountingOutbox.redrive, { orgId });
  await expect
    .poll(
      async () =>
        ((await client.query(api.accountingOutbox.listPending, {
          orgId,
          status: "PENDING",
          limit: 200,
        })) as unknown[]).length,
      { timeout: 60_000, message: "the accounting outbox must drain" },
    )
    .toBe(0);
}

/** Major units → JOD minor units (three decimals), for writing literals legibly. */
export const jod = (major: number): number => Math.round(major * 1000);
