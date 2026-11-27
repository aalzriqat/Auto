import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import {
  allTables, AMOUNTS, CASH, EXP, OCT_20, seedWorld as seedWorldWith, type World,
} from "../test-utils/scrum987Fixture";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { PreviewPurgeResult } from "./purgeTestRecords";
import type { ApprovedException } from "./utils/purgeManifestLedger";

/**
 * SCRUM-1023 Phase 1 - the READ-ONLY dry run. Nothing here may write; each
 * refusal test asserts the EXACT set of refusal codes so it can only pass for
 * the reason it names.
 *
 * The world is the SCRUM-987 fixture: real cancelled finance deals whose custody
 * cash and fee were posted and never reversed. That is production deal 6's shape
 * (owner ruling 2026-11-27: a test entry, its balance change approved).
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });

type Manifest = Extract<PreviewPurgeResult, { success: true }>["manifest"];

async function accountId(w: World, systemKey: string): Promise<Id<"chartOfAccounts">> {
  const row = await w.t.run((ctx) =>
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", w.orgId).eq("systemKey", systemKey)).first());
  if (!row) throw new Error(`no account ${systemKey}`);
  return row._id;
}

async function preview(
  w: World,
  roots: { saleIds?: string[]; applicationIds?: string[]; expenseIds?: string[]; transferEventIds?: string[] },
  approvedExceptions: ApprovedException[] = [],
): Promise<Manifest> {
  const res = await w.t.query(internal.purgeTestRecords.previewPurge, {
    orgId: w.orgId,
    saleIds: roots.saleIds ?? [],
    applicationIds: roots.applicationIds ?? [],
    expenseIds: roots.expenseIds ?? [],
    transferEventIds: roots.transferEventIds ?? [],
    approvedExceptions,
  }) as PreviewPurgeResult;
  if (!res.success) throw new Error(`preview failed: ${res.error}`);
  return res.manifest;
}

const codes = (m: Manifest): string[] => [...new Set(m.refusals.map((r) => r.code))].sort((a, b) => a.localeCompare(b));

/** The owner-approved balance change of deal D-000012: custody cash left cash, the fee hit expense; custody nets to zero. */
async function approvedFor(w: World, rootId: string, amount: number): Promise<ApprovedException> {
  return {
    rootId,
    accountDeltas: [
      { accountId: await accountId(w, CASH), currency: "JOD", netMinor: -amount },
      { accountId: await accountId(w, EXP), currency: "JOD", netMinor: amount },
    ],
  };
}

async function openOctober(w: World): Promise<void> {
  await w.t.run((ctx) => ctx.db.patch(w.octPeriodId, { status: "OPEN" }));
}

describe("previewPurge - unreversed test deal with an owner-approved balance change", () => {
  test("an APPROVED exception passes, is itemized per account, and lists exactly the deal's ledger rows", async () => {
    const w = await seedWorld("approved");
    await openOctober(w);
    const app = w.targets[0].applicationId;
    const m = await preview(w, { applicationIds: [app] }, [await approvedFor(w, app, AMOUNTS[0])]);
    expect(m.refusals).toEqual([]);
    expect(m.ok).toBe(true);
    expect(m.exceptionItems.map((i) => [i.accountCode.split(" ")[0], i.expectedNetMinor, i.actualNetMinor, i.matches]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([["1100", -AMOUNTS[0], -AMOUNTS[0], true], ["6860", AMOUNTS[0], AMOUNTS[0], true]]);
    expect(m.countsByTable.accountingEvents).toBe(2);
    expect(m.countsByTable.journalEntries).toBe(2);
    expect(m.countsByTable.journalLines).toBe(4);
    expect(m.countsByTable.financeApplications).toBe(1);
    // The custody clearing account moves in and out inside the purge set: zero net, not an exception.
    expect(m.accountNet.filter((r) => r.netMinor !== 0)).toHaveLength(2);
    expect(m.snapshotAdjustments.length).toBeGreaterThanOrEqual(3);
    for (const s of m.snapshotAdjustments) {
      expect(s.snapshotDebitMinor).toBeGreaterThanOrEqual(s.debitMinor);
      expect(s.snapshotCreditMinor).toBeGreaterThanOrEqual(s.creditMinor);
    }
  });

  test("the same purge WITHOUT an approved exception refuses: unreversed events, unpaired journals and a non-zero net", async () => {
    const w = await seedWorld("unapproved");
    await openOctober(w);
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] });
    expect(m.ok).toBe(false);
    // All three are consequences of the one fact: money moved and was never reversed.
    expect(codes(m)).toEqual(["JOURNAL_NOT_PAIRED", "NONZERO_NET", "UNREVERSED_EVENT"]);
    expect(m.exceptionItems).toEqual([]);
  });

  test("an approved amount that does not match the purged lines refuses with EXCEPTION_MISMATCH only", async () => {
    const w = await seedWorld("mismatch");
    await openOctober(w);
    const app = w.targets[0].applicationId;
    const m = await preview(w, { applicationIds: [app] }, [await approvedFor(w, app, AMOUNTS[0] - 1)]);
    expect(codes(m)).toEqual(["EXCEPTION_MISMATCH"]);
    expect(m.exceptionItems.every((i) => !i.matches)).toBe(true);
  });

  test("an exception that covers only one of the two moved accounts leaves the other non-zero: NONZERO_NET only", async () => {
    const w = await seedWorld("partial");
    await openOctober(w);
    const app = w.targets[0].applicationId;
    const full = await approvedFor(w, app, AMOUNTS[0]);
    const m = await preview(w, { applicationIds: [app] }, [{ rootId: app, accountDeltas: [full.accountDeltas[0]] }]);
    expect(codes(m)).toEqual(["NONZERO_NET"]);
  });

  test("an exception naming a root that is not in the purge set refuses with EXCEPTION_ROOT_NOT_IN_PURGE", async () => {
    const w = await seedWorld("foreign-root");
    await openOctober(w);
    const [d12, d15] = [w.targets[0].applicationId, w.targets[1].applicationId];
    const m = await preview(w, { applicationIds: [d12] }, [
      await approvedFor(w, d12, AMOUNTS[0]),
      { rootId: d15, accountDeltas: [] },
    ]);
    expect(codes(m)).toEqual(["EXCEPTION_ROOT_NOT_IN_PURGE"]);
  });
});

describe("previewPurge - refusals", () => {
  test("a CLOSED period refuses with CLOSED_PERIOD only", async () => {
    const w = await seedWorld("closed"); // the fixture closes October behind the postings
    const app = w.targets[0].applicationId;
    const m = await preview(w, { applicationIds: [app] }, [await approvedFor(w, app, AMOUNTS[0])]);
    expect(codes(m)).toEqual(["CLOSED_PERIOD"]);
    expect(m.closedPeriodHits).toEqual([w.octPeriodId]);
  });

  test("a running snapshot smaller than the removal refuses with SNAPSHOT_UNDERFLOW only", async () => {
    const w = await seedWorld("underflow");
    await openOctober(w);
    await w.t.run(async (ctx) => {
      const snaps = await ctx.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", w.orgId).eq("periodId", w.octPeriodId)).collect();
      for (const s of snaps) await ctx.db.patch(s._id, { runningDebitMinor: 0, runningCreditMinor: 0 });
    });
    const app = w.targets[0].applicationId;
    const m = await preview(w, { applicationIds: [app] }, [await approvedFor(w, app, AMOUNTS[0])]);
    expect(codes(m)).toEqual(["SNAPSHOT_UNDERFLOW"]);
  });

  test("a surviving row that mentions a purged id refuses with SURVIVING_REFERENCE only, naming the table", async () => {
    const w = await seedWorld("survivor");
    await openOctober(w);
    const app = w.targets[0].applicationId;
    await w.t.run((ctx) => ctx.db.insert("tasks", {
      orgId: w.orgId, assignedTo: w.actorId, title: "follow up", description: `see application ${app}`, dueDate: 1, status: "PENDING",
    }));
    const m = await preview(w, { applicationIds: [app] }, [await approvedFor(w, app, AMOUNTS[0])]);
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => [s.table, s.count])).toEqual([["tasks", 1]]);
  });

  test("a live (non-cancelled) application is refused as a root: ROOT_NOT_ELIGIBLE only", async () => {
    const w = await seedWorld("live-root");
    const live = await w.t.run(async (ctx) => {
      const base = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("financeApplications", {
        orgId: w.orgId, quoteId: base.quoteId, customerId: base.customerId, vehicleId: base.vehicleId,
        salespersonId: w.actorId, status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    const m = await preview(w, { applicationIds: [live] });
    expect(codes(m)).toEqual(["ROOT_NOT_ELIGIBLE"]);
  });

  test("a sale that is cancelled but not deleted, a live expense, and a non-transfer event are all refused as roots", async () => {
    const w = await seedWorld("bad-roots");
    const saleId = await w.t.run(async (ctx) => {
      const base = (await ctx.db.get(w.targets[2].applicationId as Id<"financeApplications">))!;
      return base.finalizedSaleId!;
    });
    const expenseId = await w.t.run((ctx) => ctx.db.insert("expenses", { orgId: w.orgId, title: "live", amount: 1, date: 1, category: "OTHER" as const }));
    const event = (await w.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).first()))!;
    const m = await preview(w, { saleIds: [saleId], expenseIds: [expenseId], transferEventIds: [event._id] });
    expect(codes(m)).toEqual(["ROOT_NOT_ELIGIBLE"]);
    expect(m.refusals.map((r) => r.table).sort((a, b) => a.localeCompare(b))).toEqual(["accountingEvents", "expenses", "sales"]);
  });

  test("an id that is not a row of this organization is ROOT_NOT_FOUND, and no roots at all is NO_ROOTS", async () => {
    const w = await seedWorld("missing-root");
    const m1 = await preview(w, { applicationIds: ["not-an-id"] });
    expect(codes(m1)).toEqual(["ROOT_NOT_FOUND"]);
    const m2 = await preview(w, {});
    expect(codes(m2)).toEqual(["NO_ROOTS"]);
  });
});

describe("previewPurge - what it must leave alone and what it must not write", () => {
  test("a real deposit that only references the customer, quote and vehicle survives untouched and is not a surviving reference", async () => {
    const w = await seedWorld("deposit");
    await openOctober(w);
    const app = w.targets[0].applicationId;
    const depositId = await w.t.run(async (ctx) => {
      const base = (await ctx.db.get(app as Id<"financeApplications">))!;
      return ctx.db.insert("deposits", {
        orgId: w.orgId, customerId: base.customerId, vehicleId: base.vehicleId, quoteId: base.quoteId, amount: 50, amountMinor: 50_000,
        currency: "JOD", status: "REFUNDED", holdActive: false, refundedAmountMinor: 50_000, releasedAmountMinor: 50_000, releaseCount: 1,
        createdBy: w.actorId, createdAt: Date.now(),
      });
    });
    const m = await preview(w, { applicationIds: [app] }, [await approvedFor(w, app, AMOUNTS[0])]);
    expect(m.ok).toBe(true);
    expect(m.idsByTable.deposits).toBeUndefined();
    expect(Object.values(m.idsByTable).flat()).not.toContain(depositId);
    expect(m.idsByTable.customers).toBeUndefined();
    expect(m.idsByTable.quotes).toBeUndefined();
    expect(m.idsByTable.vehicles).toBeUndefined();
  });

  test("another deal's rows and the audit logs are never in the purge set; audit rows are only counted", async () => {
    const w = await seedWorld("others");
    await openOctober(w);
    const [d12, d15] = [w.targets[0], w.targets[1]];
    const m = await preview(w, { applicationIds: [d12.applicationId] }, [await approvedFor(w, d12.applicationId, AMOUNTS[0])]);
    expect(m.ok).toBe(true);
    const all = new Set(Object.values(m.idsByTable).flat());
    expect(all.has(d15.applicationId)).toBe(false);
    expect(all.has(d15.custodyId)).toBe(false);
    expect(all.has(d12.custodyId)).toBe(true);
    expect(m.idsByTable.financialAuditLog).toBeUndefined();
    expect(m.idsByTable.adminAuditLog).toBeUndefined();
  });

  test("the dry run writes nothing, on success and on refusal", async () => {
    const w = await seedWorld("readonly");
    await openOctober(w);
    const app = w.targets[0].applicationId;
    const before = await dbSnapshot(w.t, allTables);
    await preview(w, { applicationIds: [app] }, [await approvedFor(w, app, AMOUNTS[0])]);
    await preview(w, { applicationIds: [app] });
    expect(await dbSnapshot(w.t, allTables)).toEqual(before);
  });
});
