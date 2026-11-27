import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AMOUNTS, CASH, EXP, OCT_20, seedWorld as seedWorldWith, type World } from "../test-utils/scrum987Fixture";
import {
  approvedFor as approvedForDeal, cloneEntry, codes, dealEvents, linkAsPair, openOctober, preview, reverseDeal, reverseEvent,
} from "../test-utils/purgePreview";
import type { Doc, Id } from "./_generated/dataModel";
import { PURGE_ORG_INDEX, PURGE_ROOT_SURVIVOR_INDEX } from "./utils/purgeImpactMap";
import { buildPurgeManifest } from "./utils/purgeManifest";

/**
 * SCRUM-1023 Phase 1, PR #908 round 1 - exceptions pinned to exact ids, bounds that stop, forward links, field
 * clears, storage files and the root kinds other than a finance application.
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});
const approvedFor = (w: World, index: number, amount: number) => approvedForDeal(w, index, amount, CASH, EXP);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });

async function unreversedWorld(suffix: string) {
  const w = await seedWorld(suffix);
  await openOctober(w);
  return { w, app: w.targets[0].applicationId };
}

describe("round 1 / R3 - an exception is exact event and journal ids plus a per-period expected net", () => {
  test("two offsetting unreversed events tied to the exception root, NOT named by it, still refuse", async () => {
    const { w, app } = await unreversedWorld("offsetting");
    const events = await dealEvents(w, 0);
    // The approval is written down BEFORE the twins exist: it names the deal's own events, and the twins are not among them.
    const exception = await approvedFor(w, 0, AMOUNTS[0]);
    await cloneEntry(w, events[0]._id, "twin-a", false, { ref: app });
    await cloneEntry(w, events[0]._id, "twin-b", true, { ref: app });
    const m = await preview(w, { applicationIds: [app] }, [exception]);
    // The pair nets to zero, so only the pairing rule can catch it: neither event is reversed and neither is named.
    expect(codes(m)).toEqual(["JOURNAL_NOT_PAIRED", "UNREVERSED_EVENT"]);
  });

  test("the same exception without the offsetting pair passes (the twin)", async () => {
    const { w, app } = await unreversedWorld("exact");
    const m = await preview(w, { applicationIds: [app] }, [await approvedFor(w, 0, AMOUNTS[0])]);
    expect(m.refusals).toEqual([]);
    expect(m.exceptionItems.every((i) => i.matches)).toBe(true);
    expect(m.exceptionItems.map((i) => i.periodId)).toEqual([w.octPeriodId, w.octPeriodId]);
  });

  test("an expected net recorded against the wrong period refuses: that period's real net is unapproved", async () => {
    const { w, app } = await unreversedWorld("wrong-period");
    const ex = await approvedFor(w, 0, AMOUNTS[0]);
    const m = await preview(w, { applicationIds: [app] }, [{ ...ex, expectedNets: ex.expectedNets.map((n) => ({ ...n, periodId: w.novPeriodId })) }]);
    expect(codes(m)).toEqual(["EXCEPTION_MISMATCH", "NONZERO_NET"]);
  });

  test("two roots cannot share or offset an exception: each one's net is compared with its OWN named journals", async () => {
    const { w } = await unreversedWorld("swap");
    const [a, b] = [await approvedFor(w, 0, AMOUNTS[0]), await approvedFor(w, 1, AMOUNTS[1])];
    const swapped = [{ ...a, expectedNets: b.expectedNets }, { ...b, expectedNets: a.expectedNets }];
    // The two expectations add up to exactly the real totals, so a total-only comparison would pass.
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId, w.targets[1].applicationId] }, swapped);
    expect(codes(m)).toEqual(["EXCEPTION_MISMATCH"]);
    const honest = await preview(w, { applicationIds: [w.targets[0].applicationId, w.targets[1].applicationId] }, [a, b]);
    expect(honest.refusals).toEqual([]);
  });

  test("an exception that names an event outside the purge set refuses with EXCEPTION_ROOT_NOT_IN_PURGE", async () => {
    const { w, app } = await unreversedWorld("foreign-event");
    const ex = await approvedFor(w, 0, AMOUNTS[0]);
    const other = (await dealEvents(w, 1))[0];
    const m = await preview(w, { applicationIds: [app] }, [{ ...ex, eventIds: [...ex.eventIds, other._id] }]);
    expect(codes(m)).toEqual(["EXCEPTION_ROOT_NOT_IN_PURGE"]);
  });
});

describe("round 1 / R6 - the scan stops when the budget is spent and says so", () => {
  const run = (w: World, app: string, limits: { perTableCap: number; totalDocs: number; totalRanges: number }) =>
    w.t.run((ctx) => buildPurgeManifest(ctx, w.orgId, { saleIds: [], applicationIds: [app], expenseIds: [], transferEventIds: [] }, [], [], [], limits));

  test("a document budget that is too small ends the scan with OVER_BOUND and never reads past it", async () => {
    const { w, app } = await unreversedWorld("doc-budget");
    const m = await run(w, app, { perTableCap: 6000, totalDocs: 30, totalRanges: 4000 });
    expect(m.refusals.map((r) => r.code)).toContain("OVER_BOUND");
    expect(m.totals.docsRead).toBeLessThanOrEqual(30);
  });

  test("a range budget that is too small ends the scan with OVER_BOUND and counts every get and query", async () => {
    const { w, app } = await unreversedWorld("range-budget");
    const m = await run(w, app, { perTableCap: 6000, totalDocs: 24_000, totalRanges: 6 });
    expect(m.refusals.map((r) => r.code)).toContain("OVER_BOUND");
    expect(m.totals.rangesRead).toBeLessThanOrEqual(6);
  });

  test("the default budget reads each purged event and journal from the scan, not again with db.get", async () => {
    const w = await seedWorld("reuse");
    await reverseDeal(w, 0);
    const m = await run(w, w.targets[0].applicationId, { perTableCap: 6000, totalDocs: 24_000, totalRanges: 4000 });
    expect(m.ok).toBe(true);
    const scannedTables = Object.keys(PURGE_ORG_INDEX).length + Object.keys(PURGE_ROOT_SURVIVOR_INDEX).length;
    const periods = new Set(m.accountNet.map((r) => r.periodId)).size;
    // Exactly: one root get, one query per scanned table, the organization get, a lines query per journal, one get per
    // period and one snapshot query per (period, account), plus the one query for admin audit rows that carry no organization
    // (phase 1b). A per-event or per-journal db.get adds at least one more.
    expect(m.totals.rangesRead).toBe(1 + scannedTables + 1 + 1 + m.totals.journals + periods + m.snapshotAdjustments.length);
  });
});

describe("round 1 / R7 - a commercial deal only the purged roots point at goes with them", () => {
  const dealRow = (w: World) => w.t.run((ctx) => ctx.db.insert("commercialDeals", { orgId: w.orgId, createdBy: w.actorId, kind: "DETACHED" }));

  test("a deal referenced only by the purged application joins the manifest", async () => {
    const w = await seedWorld("deal-only");
    await reverseDeal(w, 0);
    const deal = await dealRow(w);
    await w.t.run((ctx) => ctx.db.patch(w.targets[0].applicationId as Id<"financeApplications">, { dealId: deal }));
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] });
    expect(m.ok).toBe(true);
    expect(m.idsByTable.commercialDeals).toEqual([deal]);
  });

  test("the same deal also referenced by a live application stays, and that is not a refusal", async () => {
    const w = await seedWorld("deal-shared");
    await reverseDeal(w, 0);
    const deal = await dealRow(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.targets[0].applicationId as Id<"financeApplications">, { dealId: deal });
      await ctx.db.patch(w.targets[1].applicationId as Id<"financeApplications">, { dealId: deal });
    });
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] });
    expect(m.ok).toBe(true);
    expect(m.idsByTable.commercialDeals).toBeUndefined();
  });
});

describe("round 1 / R8 - a kept row tied to the purge by one link field is a field clear, not a refusal", () => {
  async function saleWorld(suffix: string) {
    const w = await seedWorld(suffix);
    const app = (await w.t.run((ctx) => ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">)))!;
    const saleId = await w.t.run((ctx) => ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 10_500,
      saleDate: Date.now(), status: "CANCELLED", isDeleted: true,
    } as never));
    return { w, app, saleId };
  }
  const deposit = (w: World, app: Doc<"financeApplications">, status: "REFUNDED" | "APPLIED", saleId: Id<"sales">) =>
    w.t.run((ctx) => ctx.db.insert("deposits", {
      orgId: w.orgId, customerId: app.customerId, vehicleId: app.vehicleId, quoteId: app.quoteId, amount: 50, amountMinor: 50_000, currency: "JOD",
      status, holdActive: false, refundedAmountMinor: 0, releasedAmountMinor: 0, releaseCount: 0, resolutionSaleId: saleId,
      createdBy: w.actorId, createdAt: 1,
    } as never));

  // A REFUNDED deposit's resolutionSaleId clear needs the owner's exact id: see purgeTestRecords.scrum1023.round2.test.ts.
  test("an APPLIED deposit would be left without its owning sale, so it refuses instead", async () => {
    const { w, app, saleId } = await saleWorld("apply-deposit");
    await deposit(w, app, "APPLIED", saleId);
    const m = await preview(w, { saleIds: [saleId] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.fieldClears).toEqual([]);
  });

  test("a SOLD vehicle keeps soldBySaleId (its return to the lot needs it), an AVAILABLE one is cleared", async () => {
    const { w, app, saleId } = await saleWorld("clear-vehicle");
    await w.t.run((ctx) => ctx.db.patch(app.vehicleId, { status: "SOLD", soldBySaleId: saleId }));
    const sold = await preview(w, { saleIds: [saleId] });
    expect(codes(sold)).toEqual(["SURVIVING_REFERENCE"]);
    await w.t.run((ctx) => ctx.db.patch(app.vehicleId, { status: "AVAILABLE" }));
    const free = await preview(w, { saleIds: [saleId] });
    expect(free.refusals).toEqual([]);
    expect(free.fieldClears).toEqual([{ table: "vehicles", id: app.vehicleId, field: "soldBySaleId", guardField: "status", guardValue: "AVAILABLE" }]);
  });

  test("a commitment root consumed by the purged sale leaves with it (phase 1c, owner ruling 2026-11-27)", async () => {
    const { w, app, saleId } = await saleWorld("consumed-root");
    await w.t.run((ctx) => ctx.db.insert("commitmentRoots", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, status: "CONSUMED", openedAt: 1, openedBy: w.actorId, consumedBySaleId: saleId,
    }));
    const m = await preview(w, { saleIds: [saleId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.commitmentRoots).toHaveLength(1);
  });

  test("an approved id on a consumed commitment root changes nothing: it leaves anyway, and a field-clear approval for it is stale", async () => {
    const { w, app, saleId } = await saleWorld("consumed-root-approved");
    const rootId = await w.t.run((ctx) => ctx.db.insert("commitmentRoots", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, status: "CONSUMED", openedAt: 1, openedBy: w.actorId, consumedBySaleId: saleId,
    }));
    const m = await preview(w, { saleIds: [saleId] }, [], [rootId], [rootId]);
    expect(codes(m)).toEqual(["APPROVED_ROW_NOT_IN_PURGE"]);
    expect(m.idsByTable.commitmentRoots).toEqual([rootId]);
  });

  test("a payroll item that lists a purged sale stays a refusal (the owner has not decided)", async () => {
    const { w, saleId } = await saleWorld("payroll");
    const run = await w.t.run((ctx) => ctx.db.insert("payrollRuns", { orgId: w.orgId, periodYear: 2026, periodMonth: 10, currency: "JOD", status: "DRAFT", totalGrossMinor: 0, totalNetMinor: 0, createdBy: w.actorId, createdAt: 1, updatedAt: 1 } as never));
    await w.t.run((ctx) => ctx.db.insert("payrollItems", {
      orgId: w.orgId, runId: run, userId: w.actorId, baseSalaryMinor: 0, commissionMinor: 0, otherEarningsMinor: 0, advanceDeductionMinor: 0,
      otherDeductionMinor: 0, grossMinor: 0, netMinor: 0, currency: "JOD", commissionSaleIds: [saleId], createdAt: 1,
    } as never));
    const m = await preview(w, { saleIds: [saleId] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => s.table)).toEqual(["payrollItems"]);
  });
});

describe("round 1 / R9 - storage files of purged rows, and the other root kinds", () => {
  test("the storage files of purged rows are listed so Phase 2 can delete them", async () => {
    const w = await seedWorld("storage");
    await reverseDeal(w, 0);
    const storageId = await w.t.run((ctx) => ctx.storage.store(new Blob(["receipt"])));
    await w.t.run((ctx) => ctx.db.patch(w.targets[0].feeId as Id<"financeDealFees">, { documentStorageIds: [storageId] }));
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] });
    expect(m.ok).toBe(true);
    expect(m.storageIds).toEqual([{ table: "financeDealFees", id: w.targets[0].feeId, storageId }]);
  });

  async function reversedClone(w: World, ref: Record<string, unknown>, key: string) {
    const original = (await dealEvents(w, 2))[0];
    const clone = await cloneEntry(w, original._id, key, false, ref);
    const reversal = await reverseEvent(w, clone.eventId, `rev-${key}`);
    return { original: clone.eventId, reversal };
  }

  test("a deleted and cancelled sale root with a complete reversed pair passes", async () => {
    const w = await seedWorld("sale-root");
    await openOctober(w);
    const saleId = await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("sales", { orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1, status: "CANCELLED", isDeleted: true } as never);
    });
    const { reversal } = await reversedClone(w, { saleId }, "sale-pair");
    const m = await preview(w, { saleIds: [saleId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.sales).toEqual([saleId]);
    expect(m.idsByTable.accountingEvents).toContain(reversal._id);
  });

  test("a deleted expense root with a complete reversed pair passes", async () => {
    const w = await seedWorld("expense-root");
    await openOctober(w);
    const expenseId = await w.t.run((ctx) => ctx.db.insert("expenses", { orgId: w.orgId, title: "t", amount: 1, date: 1, category: "OTHER", isDeleted: true } as never));
    await reversedClone(w, { expenseId }, "expense-pair");
    const m = await preview(w, { expenseIds: [expenseId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.expenses).toEqual([expenseId]);
  });

  test("a REVERSED treasury transfer root with its reversal passes", async () => {
    const w = await seedWorld("transfer-root");
    await openOctober(w);
    const base = (await dealEvents(w, 2))[0];
    const original = await cloneEntry(w, base._id, "transfer-out", false, {}, "TREASURY_TRANSFER");
    const reversal = await cloneEntry(w, base._id, "transfer-back", true, {});
    await linkAsPair(w, original, reversal);
    const m = await preview(w, { transferEventIds: [original.eventId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.accountingEvents).toEqual([original.eventId, reversal.eventId].sort((a, b) => a.localeCompare(b)));
  });

  test("a real root id of ANOTHER organization is ROOT_NOT_FOUND, never read", async () => {
    const w = await seedWorld("other-org");
    const foreign = await w.t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Other", createdAt: 1 });
      const base = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("financeApplications", {
        orgId: otherOrg, quoteId: base.quoteId, customerId: base.customerId, vehicleId: base.vehicleId, salespersonId: w.actorId,
        status: "CANCELLED", createdAt: 1, updatedAt: 1,
      });
    });
    const m = await preview(w, { applicationIds: [foreign] });
    expect(codes(m)).toEqual(["ROOT_NOT_FOUND"]);
    expect(m.idsByTable).toEqual({});
  });
});

describe("round 1 / R9 - refusals with real pairs present, each differing from the passing twin in one fact", () => {
  test("two journals of a reversed pair with no accounting period are PERIOD_UNKNOWN only", async () => {
    const w = await seedWorld("period-unknown");
    const { originals } = await reverseDeal(w, 0);
    await w.t.run(async (ctx) => {
      const journalIds = new Set(originals.map((e) => e.journalEntryId));
      const all = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect();
      for (const j of all) {
        const mine = journalIds.has(j._id) || (j.reversalOfJournalEntryId && journalIds.has(j.reversalOfJournalEntryId));
        if (mine) await ctx.db.patch(j._id, { periodId: undefined });
      }
    });
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] });
    expect(codes(m)).toEqual(["PERIOD_UNKNOWN"]);
  });

  test("an original whose reversal event is left out of the purge set is INCOMPLETE_REVERSAL_PAIR only", async () => {
    const w = await seedWorld("incomplete-pair");
    const { reversals } = await reverseDeal(w, 0);
    await w.t.run((ctx) => ctx.db.patch(reversals[0]._id, { reversalOfEventId: undefined, journalEntryId: undefined, payload: {} }));
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] });
    expect(codes(m)).toEqual(["INCOMPLETE_REVERSAL_PAIR"]);
  });

  test("a journal that is neither reversed nor a reversal, beside real pairs, is JOURNAL_NOT_PAIRED (with its unreversed event)", async () => {
    const w = await seedWorld("lone-journal");
    await reverseDeal(w, 0);
    const events = await dealEvents(w, 0);
    const lone = await cloneEntry(w, events[0]._id, "lone", false, { ref: w.targets[0].applicationId });
    await cloneEntry(w, events[0]._id, "lone-inverse", true, { ref: w.targets[0].applicationId });
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] });
    expect(codes(m)).toEqual(["JOURNAL_NOT_PAIRED", "UNREVERSED_EVENT"]);
    expect(lone.journalId).toBeTruthy();
  });
});
