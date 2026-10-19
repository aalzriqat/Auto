import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { MAX_SUMMARY_MONTHS, toThousandths } from "./utils/dashboardExpenseSummary";

/**
 * SCRUM-807: the expense month summary must give the dashboard exactly what the
 * capped raw reader gives, for every window it serves, before and after every
 * kind of expense write — and must lift the 5,000-row cap for whole days.
 *
 * The raw reference is the same deployment with the summary BLOCKED, which
 * makes `dashboard.stats` fall back to the raw reader on identical data.
 */
// The Convex runtime runs in UTC and the raw reader's labels use local time, so
// pin it: on a developer laptop the near-midnight rows below would otherwise
// compare a local-day raw label with a UTC-day summary label.
process.env.TZ = "UTC";
const DAY_MS = 24 * 60 * 60 * 1000;
// Deliberately not a midnight, so every rolling cutoff falls inside a day.
const NOW = Date.UTC(2026, 6, 15, 13, 37, 11, 123);
const PERMISSIONS = ["view:customers", "view:vehicles", "view:users", "view:sales", "view:expenses"];
const RANGES = ["DAY", "MONTH", "YEAR", "ALL_TIME"] as const;

const begin = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, { generation: number }>(
  "dashboardExpenseSummary:begin",
);
const block = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }>("dashboardExpenseSummary:blockForImport");
const buildPage = makeFunctionReference<"mutation", { orgId: Id<"organizations">; generation: number }>(
  "dashboardExpenseSummary:buildPage",
);

afterEach(() => {
  vi.useRealTimers();
});

type ExpenseInput = Omit<Doc<"expenses">, "_id" | "_creationTime" | "orgId">;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const { orgId, identity } = await seedOrgWithMember(t, {
    clerkId: "user_summary",
    permissions: PERMISSIONS,
    orgName: "Summary Dealer",
    roleName: "ADMIN",
    memberName: "Summary User",
  });
  const otherOrg = await t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: NOW }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "LCOC76CA9R4800777", make: "BYD", model: "QIN L", year: 2024, mileage: 1,
      color: "White", fuelType: "Hybrid", transmission: "Automatic", purchasePrice: 10, sellingPrice: 20,
      status: "AVAILABLE",
    })
  );
  const add = (rows: ExpenseInput[], org: Id<"organizations"> = orgId) =>
    t.run(async (ctx) => {
      const ids: Id<"expenses">[] = [];
      for (const row of rows) ids.push(await ctx.db.insert("expenses", { orgId: org, ...row }));
      return ids;
    });
  const stats = async () => {
    const out: Record<string, unknown> = {};
    for (const timeRange of RANGES) {
      const r = await identity.query(api.dashboard.stats, { orgId, timeRange });
      out[timeRange] = { trend: r.salesTrend, previous: r.previousPeriod, truncated: r.truncated };
    }
    return out;
  };
  const drain = () => t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const state = () =>
    t.run((ctx) =>
      ctx.db.query("dashboardExpenseSummaryState").withIndex("by_org_generation", (q) => q.eq("orgId", orgId))
        .order("desc").first()
    );
  /** The capped raw reader's answer on the same data, then a fresh READY build. */
  const rawThenRebuild = async () => {
    await t.mutation(block, { orgId });
    const raw = await stats();
    await t.mutation(begin, { orgId });
    await drain();
    return raw;
  };
  /** Guards against a vacuous parity check: the READY months must be readable. */
  const expectSummaryServes = async () => {
    const latest = await state();
    expect(latest?.phase).toBe("READY");
    const months = await t.run((ctx) =>
      ctx.db.query("dashboardExpenseMonths").withIndex("by_org_generation_month", (q) =>
        q.eq("orgId", orgId).eq("generation", latest!.generation)).collect()
    );
    expect(months.length).toBeGreaterThan(0);
    expect(months.every((m) => m.unrepresentable === 0 && !m.overflowed)).toBe(true);
  };
  return { t, orgId, otherOrg, vehicleId, identity, add, stats, drain, state, rawThenRebuild, expectSummaryServes };
}

const base = { title: "Expense", category: "MARKETING" as const, status: "PAID" as const };

/** Every predicate and edge the dashboard distinguishes. */
function mixedRows(vehicleId: Id<"vehicles">): ExpenseInput[] {
  return [
    { ...base, amount: 12.345, date: NOW - 2 * DAY_MS },
    { ...base, amount: 0, date: NOW - 3 * DAY_MS }, // zero still creates a label
    { ...base, amount: 0.1, date: NOW - 3 * DAY_MS },
    { ...base, amount: 0.2, date: NOW - 3 * DAY_MS }, // 0.1 + 0.2 must be 0.3
    { ...base, amount: 7, date: NOW - 4 * DAY_MS, costBearer: "SUPPLIER" }, // cash out only
    { ...base, amount: 9, date: NOW - 5 * DAY_MS, status: "PENDING" }, // not cash out
    { ...base, amount: 4, date: NOW - 6 * DAY_MS }, // legacy status missing = PAID
    { ...base, amount: 50, date: NOW - 6 * DAY_MS, vehicleId, accountingTreatment: "CAPITALIZED_INVENTORY" },
    { ...base, amount: 3, date: NOW - 6 * DAY_MS, vehicleId }, // vehicle cost expensed: general
    { ...base, amount: 99, date: NOW - 7 * DAY_MS, isDeleted: true },
    { ...base, amount: 98, date: NOW - 7 * DAY_MS, reversedAt: NOW - DAY_MS },
    { ...base, amount: 5, date: NOW - 7 * DAY_MS, isDeleted: false }, // restored row is live
    // Either side of the MONTH, YEAR and previous-MONTH cutoffs, inside the cutoff's day.
    { ...base, amount: 1.5, date: NOW - 30 * DAY_MS + 1 },
    { ...base, amount: 2.5, date: NOW - 30 * DAY_MS - 1 },
    { ...base, amount: 3.5, date: NOW - 60 * DAY_MS + 1 },
    { ...base, amount: 4.5, date: NOW - 60 * DAY_MS - 1 },
    { ...base, amount: 6.25, date: NOW - 365 * DAY_MS + 1 },
    { ...base, amount: 6.75, date: NOW - 365 * DAY_MS - 1 },
    { ...base, amount: 11, date: NOW - 400 * DAY_MS },
    // Future rows: one lands on today's MONTH label a year ahead, one in a later year.
    { ...base, amount: 8, date: NOW + 365 * DAY_MS },
    { ...base, amount: 13, date: NOW + 3 * 365 * DAY_MS + 40 * DAY_MS },
    { ...base, amount: 2, date: NOW + 2 * 60 * 60 * 1000 }, // later today
    // Either side of a UTC midnight: labels follow the UTC day, whatever TZ runs the test.
    { ...base, amount: 0.5, date: Date.UTC(2026, 6, 9) - 1 },
    { ...base, amount: 0.75, date: Date.UTC(2026, 6, 9) },
  ];
}

describe("dashboard expense month summary", () => {
  test("a READY summary gives exactly the raw reader's figures for every range", async () => {
    const s = await setup();
    await s.add(mixedRows(s.vehicleId));
    const raw = await s.stats();
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    await s.expectSummaryServes();
    expect(await s.stats()).toEqual(raw);
    // And the exact decimal survives: 0.1 + 0.2 on one day is 0.3, not 0.30000000000000004.
    const month = await s.identity.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "MONTH" });
    expect(month.salesTrend.some((p) => p.Expenses === 0.3)).toBe(true);
  });

  test("every kind of write keeps a READY summary equal to the raw reader", async () => {
    const s = await setup();
    const ids = await s.add(mixedRows(s.vehicleId));
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(ids[0], { amount: 20.5 }); // amount
      await ctx.db.patch(ids[2], { date: NOW - 45 * DAY_MS }); // moves day and month
      await ctx.db.patch(ids[3], { isDeleted: true }); // delete
      await ctx.db.patch(ids[9], { isDeleted: false }); // restore
      await ctx.db.patch(ids[6], { reversedAt: NOW }); // reversal
      await ctx.db.patch(ids[5], { status: "PAID" }); // becomes cash out
      await ctx.db.patch(ids[4], { costBearer: "SHOWROOM" }); // bearer change
      await ctx.db.patch(ids[7], { accountingTreatment: "PERIOD_EXPENSE" }); // treatment change
      await ctx.db.patch(ids[8], { orgId: s.otherOrg }); // org move out
      await ctx.db.patch(ids[1], { title: "Renamed" }); // irrelevant edit
      await ctx.db.delete(ids[12]); // hard delete
      await ctx.db.insert("expenses", { orgId: s.orgId, ...base, amount: 17, date: NOW - 10 * DAY_MS }); // create
    });
    await s.expectSummaryServes();
    const ready = await s.stats();
    expect(await s.rawThenRebuild()).toEqual(ready);
    expect(await s.stats()).toEqual(ready);
  });

  test("writes during a build converge: each row is counted exactly once", async () => {
    const s = await setup();
    const rows = Array.from({ length: 150 }, (_, i) => ({ ...base, amount: (i % 7) + 0.25, date: NOW - (1 + (i % 50)) * DAY_MS }));
    const ids = await s.add(rows);
    const { generation } = await s.t.mutation(begin, { orgId: s.orgId });
    await s.t.mutation(buildPage, { orgId: s.orgId, generation }); // first 64 counted
    expect((await s.state())?.phase).toBe("BUILDING");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(ids[3], { amount: 40 }); // already counted
      await ctx.db.patch(ids[100], { amount: 41 }); // not reached yet
      await ctx.db.patch(ids[5], { isDeleted: true }); // counted, now removed
      await ctx.db.patch(ids[120], { date: NOW - 70 * DAY_MS }); // not reached, moved
      await ctx.db.insert("expenses", { orgId: s.orgId, ...base, amount: 2, date: NOW - DAY_MS }); // new
    });
    await s.drain();
    await s.expectSummaryServes();
    const ready = await s.stats();
    expect(await s.rawThenRebuild()).toEqual(ready);
  });

  test("an org move in either direction is counted once by each org's own generation", async () => {
    const s = await setup();
    const [moving] = await s.add([{ ...base, amount: 6, date: NOW - 3 * DAY_MS }], s.otherOrg);
    await s.add([{ ...base, amount: 1, date: NOW - 3 * DAY_MS }]);
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    await s.t.run((ctx) => ctx.db.patch(moving, { orgId: s.orgId })); // moves in
    await s.expectSummaryServes();
    const ready = await s.stats();
    expect(await s.rawThenRebuild()).toEqual(ready);
  });

  test("whole days are not capped: 5,001 expenses on one past day are exact", async () => {
    const s = await setup();
    // Seeded raw for speed; the build counts them.
    await s.t.runUnwrapped(async (ctx) => {
      for (let i = 0; i < 5001; i++) {
        await ctx.db.insert("expenses", { orgId: s.orgId, ...base, amount: 1, date: NOW - 3 * DAY_MS });
      }
    });
    const before = await s.identity.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "MONTH" });
    expect(before.truncated.expenses).toBe(true);
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    const after = await s.identity.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "MONTH" });
    expect(after.truncated.expenses).toBe(false);
    expect(after.salesTrend.map((p) => p.Expenses)).toEqual([5001]);
    // DAY is still the raw reader and does not include that day.
    const day = await s.identity.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "DAY" });
    expect(day.truncated.expenses).toBe(false);
  }, 60_000);

  test("an amount change on a row with no stored figure still moves the overflow bound", async () => {
    const s = await setup();
    const [id] = await s.add([{ ...base, amount: 10, date: NOW - 3 * DAY_MS, status: "PENDING", costBearer: "SUPPLIER" }]);
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    await s.t.run((ctx) => ctx.db.patch(id, { amount: 25 }));
    const months = await s.t.run((ctx) => ctx.db.query("dashboardExpenseMonths").collect());
    expect(months.map((m) => m.absTotal)).toEqual([25000]);
  });

  test("an amount the summary cannot hold exactly falls back to the raw reader", async () => {
    const s = await setup();
    await s.add([
      { ...base, amount: 1.0005, date: NOW - 3 * DAY_MS },
      { ...base, amount: 2, date: NOW - 4 * DAY_MS },
    ]);
    const raw = await s.stats();
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    expect(await s.stats()).toEqual(raw);
    expect(toThousandths(1.0005)).toBeNull();
    expect(toThousandths(1.005)).toBe(1005);
    expect(toThousandths(Number.NaN)).toBeNull();
  });

  test("dates the calendar cannot place fall back to the raw reader in every window that holds them", async () => {
    // Date.UTC reads years 0-99 as 1900-1999, so build each date with setUTCFullYear.
    const at = (year: number, monthIndex: number, day: number) =>
      new Date(0).setUTCFullYear(year, monthIndex, day) + 12 * 60 * 60 * 1000;
    const s = await setup();
    await s.add([
      { ...base, amount: 2, date: NOW - 3 * DAY_MS },
      { ...base, amount: 5, date: at(20260, 6, 9) }, // a year typo: open-ended MONTH and YEAR hold it
      { ...base, amount: 7, date: at(50, 2, 1) }, // a two-digit year: only ALL_TIME holds it
      { ...base, amount: 9, date: at(99, 2, 1) },
    ]);
    const raw = await s.stats();
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    expect(await s.stats()).toEqual(raw);
  });

  test.each([1e16, Number.POSITIVE_INFINITY, -1e16, Number.NEGATIVE_INFINITY, Number.NaN])(
    "a stored date past the Date range (%s) falls back to the raw reader wherever it is held",
    async (date) => {
      const s = await setup();
      await s.add([
        { ...base, amount: 2, date: NOW - 3 * DAY_MS },
        { ...base, amount: 11, date },
      ]);
      const raw = await s.stats();
      await s.t.mutation(begin, { orgId: s.orgId });
      await s.drain();
      expect(await s.stats()).toEqual(raw);
    },
  );

  test("a year from 100 on is placed on its own calendar month", async () => {
    const s = await setup();
    await s.add([
      { ...base, amount: 2, date: NOW - 3 * DAY_MS },
      { ...base, amount: 7, date: new Date(0).setUTCFullYear(100, 2, 1) },
    ]);
    const raw = await s.stats();
    await s.t.mutation(begin, { orgId: s.orgId });
    await s.drain();
    await s.expectSummaryServes();
    expect(await s.stats()).toEqual(raw);
  });

  test("BUILDING and BLOCKED generations are never read, and a newer generation stops an older chain", async () => {
    const s = await setup();
    await s.add([{ ...base, amount: 3, date: NOW - 3 * DAY_MS }]);
    const first = await s.t.mutation(begin, { orgId: s.orgId });
    const second = await s.t.mutation(begin, { orgId: s.orgId });
    expect(second.generation).toBe(first.generation + 1);
    await s.t.mutation(buildPage, { orgId: s.orgId, generation: first.generation }); // stale: no-op
    const months = await s.t.run((ctx) => ctx.db.query("dashboardExpenseMonths").collect());
    expect(months.every((m) => m.generation !== first.generation)).toBe(true);
    await s.drain();
    const ready = await s.stats();
    await s.t.mutation(block, { orgId: s.orgId });
    expect(await s.stats()).toEqual(ready);
    expect(MAX_SUMMARY_MONTHS).toBe(600);
  });
});
