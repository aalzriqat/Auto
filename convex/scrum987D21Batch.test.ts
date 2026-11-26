import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import {
  allTables, apply, CASH, CLEARING, D21_AMOUNT, eventsOf, EXP, net, NOV_23, nz, OCT_20, plan,
  seedWorld as seedWorldWith, type World,
} from "../test-utils/scrum987Fixture";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SCRUM987_D21_REASON } from "./utils/scrum987Targets";
/**
 * SCRUM-987 slice 2 — D-000021, the separate owner-ruled batch (2026-11-24). Slice 1 and the d21 batch must never
 * interfere: the planner refuses a mix of corrected and uncorrected targets, so D-000021 is NOT in the slice 1 list.
 */

// The doors bind module constants for the production org and deals; swap them for this fixture through live getters.
const allowList = vi.hoisted(() => ({ org: undefined as string | undefined, slice1: undefined as unknown, d21: undefined as unknown }));
vi.mock("./utils/scrum987Targets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/scrum987Targets")>();
  return {
    ...actual,
    get SCRUM987_ORG_ID() { return allowList.org ?? actual.SCRUM987_ORG_ID; },
    get SCRUM987_TARGETS() { return (allowList.slice1 as typeof actual.SCRUM987_TARGETS | undefined) ?? actual.SCRUM987_TARGETS; },
    get SCRUM987_D21_TARGETS() { return (allowList.d21 as typeof actual.SCRUM987_D21_TARGETS | undefined) ?? actual.SCRUM987_D21_TARGETS; },
  };
});

const MODULES = {
  ...import.meta.glob("./**/*.*s"),
  "./__scrum987WrappedHarness.ts": () => import("../test-utils/scrum987WrappedHarness"),
};
const seedWorld = (suffix: string, opts: { d21?: boolean; skipSlice1?: boolean } = {}) => seedWorldWith(MODULES, suffix, { d21: true, ...opts });
const d21Args = (w: World) => ({ targets: w.d21Targets, reason: SCRUM987_D21_REASON });

const point = (w: World) => {
  allowList.org = w.orgId;
  allowList.slice1 = w.targets;
  allowList.d21 = w.d21Targets;
};
const door = (w: World, mode: "rehearse" | "apply", batch?: "slice1" | "d21") =>
  w.t.mutation(internal.scrum987CancelledDealReversal.applyScrum987, { actorId: w.actorId, confirm: "SCRUM-987", mode, ...(batch ? { batch } : {}) });
const planDoor = (w: World, batch?: "slice1" | "d21") =>
  w.t.query(internal.scrum987CancelledDealReversal.planScrum987, { actorId: w.actorId, ...(batch ? { batch } : {}) }) as Promise<{ kind: string; targets: unknown[] }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => {
  vi.useRealTimers();
  allowList.org = undefined;
  allowList.slice1 = undefined;
  allowList.d21 = undefined;
});

describe("slice 2 batch d21 (D-000021, owner ruling 2026-11-24)", () => {
  test("the reason constant carries the 2026-11-24 ruling", () => {
    expect(SCRUM987_D21_REASON).toBe("SCRUM-987 owner ruling 2026-11-24");
  });

  test("rehearse through the production door rolls back with zero writes", async () => {
    const w = await seedWorld("d21-rehearse", { skipSlice1: true });
    point(w);
    const snapshot = await dbSnapshot(w.t, allTables);
    let thrown: unknown;
    await door(w, "rehearse", "d21").catch((e: unknown) => { thrown = e; });
    const data = (thrown as { data?: { code?: string; result?: { alreadyApplied?: boolean; targets?: unknown[] } } }).data;
    expect(data?.code).toBe("SCRUM987_REHEARSAL_ROLLED_BACK");
    expect(data?.result?.targets).toHaveLength(1);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });

  test("apply voids the fee with the 11-24 reason and posts one POSTED mirrored reversal per original; GL net is exact", async () => {
    const w = await seedWorld("d21-apply", { skipSlice1: true });
    point(w);
    expect(nz(await net(w), EXP)).toBe(D21_AMOUNT);
    const result = await door(w, "apply", "d21");
    expect(result.alreadyApplied).toBe(false);
    expect(result.targets).toHaveLength(1);

    const nov = await net(w, w.novPeriodId);
    expect([nz(nov, EXP), nz(nov, CASH), nz(nov, CLEARING)]).toEqual([-D21_AMOUNT, D21_AMOUNT, 0]);
    const all = await net(w);
    expect([nz(all, EXP), nz(all, CLEARING), nz(all, CASH)]).toEqual([0, 0, 0]);

    const events = await eventsOf(w);
    const forward = events.filter((e) => e.eventType === "CUSTODY_FEE_PAID" || e.eventType === "CUSTODY_CASH_ISSUED");
    expect(forward).toHaveLength(2);
    expect(forward.every((e) => e.status === "REVERSED")).toBe(true);
    const reversals = events.filter((e) => e.eventType === "JOURNAL_REVERSAL");
    expect(reversals).toHaveLength(2);
    expect(reversals.every((e) => e.status === "POSTED" && e.accountingDate === NOV_23 && forward.some((f) => f.reversedByEventId === e._id))).toBe(true);

    await w.t.run(async (ctx) => {
      const t = w.d21Targets[0];
      const fee = (await ctx.db.get(t.feeId as Id<"financeDealFees">))!;
      expect(fee.voidReason).toContain("SCRUM-987 owner ruling 2026-11-24");
      expect(fee.voidReason).not.toContain("2026-11-23");
      const app = (await ctx.db.get(t.applicationId as Id<"financeApplications">))!;
      expect(app.vehicleHandoverAt).toBeDefined();
      const log = await ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", t.custodyId as Id<"financeDealCustody">)).collect();
      expect(log.find((e) => e.kind === "REVERSAL")?.note).toBe(SCRUM987_D21_REASON);
    });
  });

  test("a second apply is ALREADY_APPLIED and writes nothing", async () => {
    const w = await seedWorld("d21-again", { skipSlice1: true });
    point(w);
    await door(w, "apply", "d21");
    const snapshot = await dbSnapshot(w.t, allTables);
    expect(await door(w, "apply", "d21")).toEqual({ alreadyApplied: true, targets: [] });
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
    expect((await planDoor(w, "d21")).kind).toBe("ALREADY_APPLIED");
  });

  test("the 11-23 reason does not satisfy the d21 batch: a d21 target corrected under the slice 1 reason is refused, not 'applied'", async () => {
    const w = await seedWorld("d21-wrong-reason", { skipSlice1: true });
    await apply(w, { targets: w.d21Targets }); // default reason = slice 1 reason
    await expect(plan(w, d21Args(w))).rejects.toThrow(/not all in the expected original state/);
  });

  test("slice 1 already applied + d21 unapplied coexist: slice1 is ALREADY_APPLIED, d21 is READY, and the default batch is slice1", async () => {
    const w = await seedWorld("d21-coexist");
    point(w);
    await door(w, "apply", "slice1");
    expect((await planDoor(w, "slice1")).kind).toBe("ALREADY_APPLIED");
    expect((await planDoor(w)).kind).toBe("ALREADY_APPLIED");
    const d21 = await planDoor(w, "d21");
    expect(d21.kind).toBe("READY");
    expect(d21.targets).toHaveLength(1);
    // And d21 can then be applied without touching the slice 1 rows.
    const snapshotSlice1Net = await net(w);
    await door(w, "apply", "d21");
    const all = await net(w);
    expect([nz(all, EXP), nz(all, CASH), nz(all, CLEARING)]).toEqual([0, 0, 0]);
    expect(snapshotSlice1Net).not.toEqual(all);
    expect((await planDoor(w, "d21")).kind).toBe("ALREADY_APPLIED");
  });
});
