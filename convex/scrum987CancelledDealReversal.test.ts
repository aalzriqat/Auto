import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import {
  allTables, apply, args, CASH, CLEARING, eventsOf, EXP, net, NOV_23, nz, OCT_16, OCT_20, plan, reportNet,
  seedWorld as seedWorldWith, snapshotNet, TOTAL, wrappedRun, type World,
} from "../test-utils/scrum987Fixture";
import type { Id } from "./_generated/dataModel";
import { hookCustodyCashReversed } from "./accounting/workflowHooks";
import { recomputeCustodyTotals } from "./utils/financeDealCosts/custodyLedger";
import { custodyEntryPostKey } from "./utils/custodySourceLedger";
import { syncCustodyPayable } from "./utils/financeDealCosts/custodyPosting";
import { applyCorrection, runScrum987 } from "./scrum987CancelledDealReversal";
import { planCorrection } from "./utils/scrum987Inspection";
import { SCRUM987_EXPECTED_UTC_MONTH, SCRUM987_REASON } from "./utils/scrum987Targets";
/**
 * SCRUM-987 slice 1 (1 of 2) — the reversal through the system paths: ledger, ordering, read-back, the production
 * trigger wrapper and the rehearse/apply mode. Refusals, actor and the allow-list are in the sibling file.
 */

const MODULES = {
  ...import.meta.glob("./**/*.*s"),
  // Test-only registration of an internalMutation built by the PRODUCTION builder (convex/functions.ts).
  "./__scrum987WrappedHarness.ts": () => import("../test-utils/scrum987WrappedHarness"),
};
const seedWorld = (suffix: string, opts: { legacyOccurredAt?: boolean } = {}) => seedWorldWith(MODULES, suffix, opts);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => {
  vi.useRealTimers();
});
describe("happy path: three cancelled deals are reversed through the system paths", () => {
  test("every original event is REVERSED by one POSTED mirrored reversal in November; October is untouched", async () => {
    const w = await seedWorld("happy");
    const octBefore = await net(w, w.octPeriodId);
    const octSnapBefore = await snapshotNet(w, w.octPeriodId);
    // Precondition: the books carry the wrong money.
    expect(nz(await net(w), EXP)).toBe(TOTAL);
    expect(nz(await net(w), CASH)).toBe(-TOTAL);

    const result = await apply(w);
    expect(result.alreadyApplied).toBe(false);
    expect(result.targets).toHaveLength(3);

    // Per-account net over ALL periods is zero for the three accounts.
    const all = await net(w);
    expect([nz(all, EXP), nz(all, CLEARING), nz(all, CASH)]).toEqual([0, 0, 0]);
    // The November period carries exactly the correction: 6860 -X, 1100 +X, 1250 net 0.
    const nov = await net(w, w.novPeriodId);
    expect([nz(nov, EXP), nz(nov, CASH), nz(nov, CLEARING)]).toEqual([-TOTAL, TOTAL, 0]);
    // The closed October period is unchanged — lines and running snapshots.
    expect(await net(w, w.octPeriodId)).toEqual(octBefore);
    expect(await snapshotNet(w, w.octPeriodId)).toEqual(octSnapBefore);
    // The November snapshot reflects the reversal.
    const novSnap = await snapshotNet(w, w.novPeriodId);
    expect([nz(novSnap, EXP), nz(novSnap, CASH), nz(novSnap, CLEARING)]).toEqual([-TOTAL, TOTAL, 0]);

    const events = await eventsOf(w);
    const forward = events.filter((e) => e.eventType === "CUSTODY_FEE_PAID" || e.eventType === "CUSTODY_CASH_ISSUED");
    expect(forward).toHaveLength(6);
    expect(forward.every((e) => e.status === "REVERSED")).toBe(true);
    const reversals = events.filter((e) => e.eventType === "JOURNAL_REVERSAL");
    expect(reversals).toHaveLength(6);
    expect(reversals.every((e) => e.status === "POSTED" && e.accountingDate === NOV_23 && forward.some((f) => f.reversedByEventId === e._id))).toBe(true);
    // F2: no payable reclassification was ever created.
    expect(events.filter((e) => e.eventType === "CUSTODY_PAYABLE_RECLASSIFIED")).toEqual([]);
    expect(await w.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).toEqual([]);
  });

  test("rows: fees voided with the ruling, custody RECONCILED with sign-off untouched, economics untouched, audit row per target", async () => {
    const w = await seedWorld("rows");
    const before = await w.t.run(async (ctx) => ({
      apps: await Promise.all(w.targets.map((t) => ctx.db.get(t.applicationId as Id<"financeApplications">))),
      custody: await Promise.all(w.targets.map((t) => ctx.db.get(t.custodyId as Id<"financeDealCustody">))),
    }));
    await apply(w);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 3; i += 1) {
        const t = w.targets[i];
        const fee = (await ctx.db.get(t.feeId as Id<"financeDealFees">))!;
        expect(fee.voidedAt).toBe(NOV_23);
        expect(fee.voidedBy).toBe(w.actorId);
        expect(fee.voidReason).toContain("SCRUM-987 owner ruling 2026-11-23");
        expect(fee.custodyPosted).toBeUndefined();
        const custody = (await ctx.db.get(t.custodyId as Id<"financeDealCustody">))!;
        const b = before.custody[i]!;
        expect([custody.status, custody.reconciledAt, custody.reconciledBy, custody.reconciliationNotes]).toEqual([
          b.status, b.reconciledAt, b.reconciledBy, b.reconciliationNotes,
        ]);
        expect([custody.issuedMinor, custody.returnedMinor, custody.reimbursedMinor]).toEqual([0, 0, 0]);
        expect(custody.payableReclassIssued ?? []).toEqual([]);
        expect(await ctx.db.get(t.applicationId as Id<"financeApplications">)).toEqual(before.apps[i]);
        const log = await ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custody._id)).collect();
        const reversal = log.find((e) => e.kind === "REVERSAL")!;
        expect(reversal).toMatchObject({ reversesEntryId: t.entryId, amountMinor: t.amountMinor, note: SCRUM987_REASON });
      }
      const audit = (await ctx.db.query("adminAuditLog").collect()).filter((a) => a.action === "SCRUM-987_CANCELLED_DEAL_REVERSAL");
      expect(audit).toHaveLength(3);
      const reverseAudit = (await ctx.db.query("financialAuditLog").collect()).filter((a) => a.actionType === "REVERSE_EVENT");
      expect(reverseAudit.every((a) => a.description.includes(SCRUM987_REASON))).toBe(true);
    });
  });

  test("legacy custodyPosted without occurredAt reverses the same way", async () => {
    const w = await seedWorld("legacy", { legacyOccurredAt: true });
    await apply(w);
    const nov = await net(w, w.novPeriodId);
    expect([nz(nov, EXP), nz(nov, CASH), nz(nov, CLEARING)]).toEqual([-TOTAL, TOTAL, 0]);
  });

  test("a second run is alreadyApplied and writes nothing", async () => {
    const w = await seedWorld("again");
    await apply(w);
    const snapshot = await dbSnapshot(w.t, allTables);
    const again = await apply(w);
    expect(again).toEqual({ alreadyApplied: true, targets: [] });
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
    expect((await plan(w)).kind).toBe("ALREADY_APPLIED");
  });
});

describe("through the production trigger wrapper (L2)", () => {
  const OCT_31 = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
  const NOV_30 = Date.UTC(2026, 10, 30, 23, 59, 59, 999);

  test("the same correction through the wrapped db shows in the GL report read: November -X / +X / 0, October unchanged", async () => {
    const w = await seedWorld("wrapped");
    // Prod shape: none of these applications carries a cash-closeout declaration.
    expect(await w.t.run(async (ctx) => (await Promise.all(w.targets.map((t) => ctx.db.get(t.applicationId as Id<"financeApplications">)))).some((a) => a?.cashNoCostCloseout !== undefined))).toBe(false);
    const octBefore = await reportNet(w, OCT_31);
    expect([nz(octBefore, EXP), nz(octBefore, CASH), nz(octBefore, CLEARING)]).toEqual([TOTAL, -TOTAL, 0]);

    const result = await wrappedRun(w);
    expect(result.alreadyApplied).toBe(false);

    expect(await reportNet(w, OCT_31)).toEqual(octBefore);
    const novEnd = await reportNet(w, NOV_30);
    expect([nz(novEnd, EXP), nz(novEnd, CASH), nz(novEnd, CLEARING)]).toEqual([0, 0, 0]);
    // November's own movement is cumulative(Nov 30) - cumulative(Oct 31).
    expect([nz(novEnd, EXP) - nz(octBefore, EXP), nz(novEnd, CASH) - nz(octBefore, CASH), nz(novEnd, CLEARING) - nz(octBefore, CLEARING)])
      .toEqual([-TOTAL, TOTAL, 0]);
  });

  test("a cash-closeout declaration would be invalidated by the real triggers, so the read-back refuses and rolls back", async () => {
    const w = await seedWorld("declared");
    await w.t.run((ctx) => ctx.db.patch(w.targets[0].applicationId as Id<"financeApplications">, {
      cashNoCostCloseout: { version: 1, declaredBy: w.actorId, declaredAt: OCT_16 },
    }));
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(wrappedRun(w)).rejects.toThrow(/application document .* changed/);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });
});

describe("runScrum987 mode handling (L3)", () => {
  const runArgs = (w: World, mode: "rehearse" | "apply") => ({
    actorId: w.actorId, mode, orgId: w.orgId as string, targets: w.targets, now: Date.now(), expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH,
  });

  test("rehearse throws SCRUM987_REHEARSAL_ROLLED_BACK carrying the result and leaves the database unchanged", async () => {
    const w = await seedWorld("run-rehearse");
    const snapshot = await dbSnapshot(w.t, allTables);
    let thrown: unknown;
    await w.t.run((ctx) => runScrum987(ctx, runArgs(w, "rehearse"))).catch((e: unknown) => { thrown = e; });
    const data = (thrown as { data?: { code?: string; result?: { alreadyApplied?: boolean; targets?: unknown[] } } }).data;
    expect(data?.code).toBe("SCRUM987_REHEARSAL_ROLLED_BACK");
    expect(data?.result?.alreadyApplied).toBe(false);
    expect(data?.result?.targets).toHaveLength(3);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });

  test("rehearse through the production builder: the registered mutation rolls back for real", async () => {
    const w = await seedWorld("run-rehearse-real");
    const snapshot = await dbSnapshot(w.t, allTables);
    let thrown: unknown;
    await wrappedRun(w, "rehearse").catch((e: unknown) => { thrown = e; });
    expect((thrown as { data?: { code?: string } }).data?.code).toBe("SCRUM987_REHEARSAL_ROLLED_BACK");
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });

  test("apply commits", async () => {
    const w = await seedWorld("run-apply");
    const result = await w.t.run((ctx) => runScrum987(ctx, runArgs(w, "apply")));
    expect(result.alreadyApplied).toBe(false);
    const all = await net(w);
    expect([nz(all, EXP), nz(all, CLEARING), nz(all, CASH)]).toEqual([0, 0, 0]);
    expect((await w.t.run((ctx) => ctx.db.query("financeDealCustodyEntries").collect())).filter((e) => e.kind === "REVERSAL")).toHaveLength(3);
  });
});

describe("ordering and read-back are load-bearing", () => {
  test("reversing the issuance BEFORE the fee posts a payable reclassification (so the order is required)", async () => {
    const w = await seedWorld("order");
    const t = w.targets[0];
    // The wrong order, written by hand with the very same internals.
    await w.t.run(async (ctx) => {
      const custodyId = t.custodyId as Id<"financeDealCustody">;
      const entryId = t.entryId as Id<"financeDealCustodyEntries">;
      const reversalEntryId = await ctx.db.insert("financeDealCustodyEntries", {
        orgId: w.orgId, custodyId, kind: "REVERSAL", reversesEntryId: entryId, amountMinor: t.amountMinor, note: "wrong order",
        occurredAt: Date.now(), recordedBy: w.actorId, recordedAt: Date.now(),
      });
      await recomputeCustodyTotals(ctx, custodyId);
      await hookCustodyCashReversed(ctx, { orgId: w.orgId, entryId, kind: "ISSUED", reversalEntryId, reason: "x", actorId: w.actorId, reversalDate: Date.now() });
      await syncCustodyPayable(ctx, custodyId, w.actorId, Date.now(), [{ must: "OFF_BOOKS", idempotencyKey: custodyEntryPostKey(entryId) }]);
    });
    const reclass = (await eventsOf(w)).filter((e) => e.eventType === "CUSTODY_PAYABLE_RECLASSIFIED");
    expect(reclass.length).toBeGreaterThan(0);
    // The shipped order never produces one (asserted in the happy path as well).
    const w2 = await seedWorld("order2");
    await apply(w2);
    expect((await eventsOf(w2)).filter((e) => e.eventType === "CUSTODY_PAYABLE_RECLASSIFIED")).toEqual([]);
  });

  test("a closed November is refused at the plan, before any write", async () => {
    const w = await seedWorld("readback");
    await w.t.run((ctx) => ctx.db.patch(w.novPeriodId, { status: "CLOSED" }));
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(apply(w)).rejects.toThrow(/no OPEN accounting period/);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });

  test("F1 read-back: if the hooks return DEFERRED while the planner saw an open period, the call throws and rolls back", async () => {
    const w = await seedWorld("readback2");
    const snapshot = await dbSnapshot(w.t, allTables);
    // The planner passes with the period open; the reversal hooks then find it closed.
    const stale = Date.now();
    await expect(
      w.t.run(async (ctx) => {
        const planned = await planCorrection(ctx, args(w, { now: stale }));
        expect(planned.kind).toBe("READY");
        // A deferred reversal: queue-and-return instead of posting.
        await ctx.db.patch(w.novPeriodId, { status: "CLOSED" });
        return await applyCorrectionSkippingPlan(ctx, w);
      })
    ).rejects.toThrow(/read-back failed/);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });
});

/** Runs the executor's writes against a period that closed after planning — the read-back must refuse. */
async function applyCorrectionSkippingPlan(ctx: Parameters<typeof applyCorrection>[0], w: World) {
  // `applyCorrection` plans first; with November closed it would refuse at the plan. To reach the
  // read-back we re-open the period for the plan only, via a one-shot `getOpenPeriodForDate` window:
  await ctx.db.patch(w.novPeriodId, { status: "OPEN" });
  const original = ctx.db.patch.bind(ctx.db);
  let closedAfterPlan = false;
  (ctx.db as unknown as { patch: typeof ctx.db.patch }).patch = (async (...a: unknown[]) => {
    if (!closedAfterPlan) {
      closedAfterPlan = true;
      await (original as (...x: unknown[]) => Promise<void>)(w.novPeriodId, { status: "CLOSED" });
    }
    return await (original as (...x: unknown[]) => Promise<void>)(...a);
  }) as never;
  return await applyCorrection(ctx, args(w));
}
