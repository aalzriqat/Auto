import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

/**
 * SCRUM-807: every dated `dashboard.stats` read is hard-bounded at CAP + 1 rows.
 * Exactly CAP rows is a complete window and is published; CAP + 1 rows is an
 * unavailable window - the figures built from it are `null` with an explicit
 * truncation flag, never a zero or a total of a prefix.
 */
const CAP = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 15);
const FULL_PERMISSIONS = ["view:customers", "view:vehicles", "view:users", "view:sales", "view:expenses"];

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const { orgId, userId, identity } = await seedOrgWithMember(t, {
    clerkId: "user_cap",
    permissions: FULL_PERMISSIONS,
    orgName: "Cap Dealer",
    roleName: "ADMIN",
    memberName: "Cap User",
  });
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "LCOC76CA9R4800099",
      make: "BYD",
      model: "QIN L",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Hybrid",
      transmission: "Automatic",
      purchasePrice: 0.5,
      sellingPrice: 1,
      status: "SOLD",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Sara", lastName: "Haddad" })
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  return { t, orgId, userId, vehicleId, customerId, asUser: identity };
}

type Seed = Awaited<ReturnType<typeof setup>>;

/** `live` completed sales at 1 each, plus any `deleted` soft-deleted ones. */
async function seedSales(s: Seed, daysAgo: number, live: number, deleted = 0) {
  await s.t.run(async (ctx) => {
    for (let i = 0; i < live + deleted; i++) {
      await ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 1,
        saleDate: NOW - daysAgo * DAY_MS,
        status: "COMPLETED",
        ...(i >= live ? { isDeleted: true } : {}),
      });
    }
  });
}

/**
 * `live` expenses of 1 each (isDeleted unset), plus `restored` live ones holding
 * `isDeleted: false`, `deleted` soft-deleted and `reversed` reversed ones.
 */
async function seedExpenses(
  s: Seed,
  daysAgo: number,
  live: number,
  extras: { restored?: number; deleted?: number; reversed?: number } = {}
) {
  const base = {
    orgId: s.orgId,
    title: "Seeded expense",
    amount: 1,
    date: NOW - daysAgo * DAY_MS,
    category: "MARKETING" as const,
    status: "PAID" as const,
  };
  await s.t.run(async (ctx) => {
    for (let i = 0; i < live; i++) await ctx.db.insert("expenses", base);
    for (let i = 0; i < (extras.restored ?? 0); i++) await ctx.db.insert("expenses", { ...base, isDeleted: false });
    for (let i = 0; i < (extras.deleted ?? 0); i++) await ctx.db.insert("expenses", { ...base, isDeleted: true });
    for (let i = 0; i < (extras.reversed ?? 0); i++) {
      await ctx.db.insert("expenses", { ...base, reversedAt: NOW - DAY_MS });
    }
  });
}

/** `count` VEHICLE_SALE inflows of 1 each; `restored` stores `isDeleted: false` instead of leaving it unset. */
async function seedSaleTransactions(s: Seed, daysAgo: number, count: number, restored = false) {
  await s.t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("transactions", {
        orgId: s.orgId,
        type: "IN",
        amount: 1,
        date: NOW - daysAgo * DAY_MS,
        category: "VEHICLE_SALE",
        description: "Seeded vehicle sale",
        ...(restored ? { isDeleted: false } : {}),
      });
    }
  });
}

const monthStats = (s: Seed) => s.asUser.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "MONTH" });

describe("dashboard.stats current window sales cap", () => {
  test("exactly CAP live sales (plus a deleted one) is a complete, published window", async () => {
    const s = await setup();
    await seedSales(s, 5, CAP, 1);
    const result = await monthStats(s);
    expect(result.salesThisMonth).toBe(CAP);
    expect(result.salesVolumeThisMonth).toBe(CAP);
    expect(result.grossTransactionValueThisMonth).toBe(CAP);
    expect(result.truncated.sales).toBe(false);
    expect(result.salesTrend.map((point) => point.Revenue)).toEqual([CAP]);
  });

  test("CAP + 1 live sales is unavailable: null figures and explicit flags, not a prefix total", async () => {
    const s = await setup();
    await seedSales(s, 5, CAP + 1);
    await seedExpenses(s, 5, 3);
    await seedSales(s, 40, 2);
    await seedExpenses(s, 40, 7);
    const result = await monthStats(s);
    expect(result.salesThisMonth).toBeNull();
    expect(result.salesVolumeThisMonth).toBeNull();
    expect(result.grossTransactionValueThisMonth).toBeNull();
    expect(result.topPerformer).toBeNull();
    expect(result.truncated).toMatchObject({ sales: true, turnover: true, profit: true, topPerformer: true });
    // Expenses are a separate, intact source: still exact, but Profit needs both.
    expect(result.salesTrend).toEqual([
      { name: expect.any(String), Revenue: null, Profit: null, Expenses: 3, CashOut: 3 },
    ]);
    // A delta against an unavailable current figure is withheld, not computed.
    expect(result.previousPeriod?.sales).toBeUndefined();
    expect(result.previousPeriod?.netProfit).toBeUndefined();
    expect(result.previousPeriod?.expenses).toBe(7);
  });

  test("deleted sales never push a window over the cap", async () => {
    const s = await setup();
    await seedSales(s, 5, 10, CAP);
    const result = await monthStats(s);
    expect(result.salesThisMonth).toBe(10);
    expect(result.truncated.sales).toBe(false);
  });
});

describe("dashboard.stats current window expenses cap", () => {
  test("exactly CAP live expenses (plus deleted and reversed rows) is a complete window", async () => {
    const s = await setup();
    await seedSales(s, 5, 2);
    await seedExpenses(s, 5, CAP, { deleted: 1, reversed: 1 });
    const result = await monthStats(s);
    expect(result.truncated.expenses).toBe(false);
    expect(result.salesTrend).toHaveLength(1);
    expect(result.salesTrend[0]).toMatchObject({ Revenue: 2, Expenses: CAP, CashOut: CAP });
    expect(result.salesTrend[0].Profit).not.toBeNull();
  });

  test("CAP + 1 live expenses nulls Expenses, CashOut and Profit but keeps Revenue", async () => {
    const s = await setup();
    await seedSales(s, 5, 2);
    await seedSales(s, 40, 1);
    await seedExpenses(s, 5, CAP + 1);
    await seedExpenses(s, 40, 4);
    const result = await monthStats(s);
    expect(result.truncated).toMatchObject({ expenses: true, profit: true });
    expect(result.truncated.sales).toBe(false);
    expect(result.salesThisMonth).toBe(2);
    expect(result.salesVolumeThisMonth).toBe(2);
    expect(result.salesTrend).toEqual([
      { name: expect.any(String), Revenue: 2, Profit: null, Expenses: null, CashOut: null },
    ]);
    expect(result.previousPeriod?.sales).toBe(1);
    expect(result.previousPeriod?.expenses).toBeUndefined();
    expect(result.previousPeriod?.netProfit).toBeUndefined();
  });

  test("deleted and reversed expenses never push a window over the cap", async () => {
    const s = await setup();
    await seedExpenses(s, 5, 3, { deleted: CAP, reversed: CAP });
    const result = await monthStats(s);
    expect(result.truncated.expenses).toBe(false);
    expect(result.salesTrend[0]).toMatchObject({ Expenses: 3 });
  });

  test("ALL_TIME expenses are bounded the same way", async () => {
    const s = await setup();
    await seedSales(s, 5, 1);
    await seedExpenses(s, 5, CAP + 1);
    const result = await s.asUser.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "ALL_TIME" });
    expect(result.truncated.expenses).toBe(true);
    expect(result.salesTrend.map((point) => point.Expenses)).toEqual([null]);
  });
});

describe("dashboard.stats previous window caps", () => {
  test("exactly CAP previous sales is published, CAP + 1 is withheld", async () => {
    const exact = await setup();
    await seedSales(exact, 5, 1);
    await seedSales(exact, 40, CAP, 1);
    expect((await monthStats(exact)).previousPeriod?.sales).toBe(CAP);

    const over = await setup();
    await seedSales(over, 5, 1);
    await seedSales(over, 40, CAP + 1);
    // An over-cap window is unavailable, not empty: the ledger must not stand in for it.
    await seedSaleTransactions(over, 40, 3);
    const result = await monthStats(over);
    expect(result.previousPeriod?.sales).toBeUndefined();
    expect(result.previousPeriod?.netProfit).toBeUndefined();
    // The current window is unaffected by the previous window's overflow.
    expect(result.salesVolumeThisMonth).toBe(1);
  });

  test("exactly CAP previous expenses is published, CAP + 1 is withheld", async () => {
    const exact = await setup();
    await seedExpenses(exact, 40, CAP, { deleted: 1, reversed: 1 });
    expect((await monthStats(exact)).previousPeriod?.expenses).toBe(CAP);

    const over = await setup();
    await seedSales(over, 5, 1);
    await seedExpenses(over, 40, CAP + 1);
    const result = await monthStats(over);
    expect(result.previousPeriod?.expenses).toBeUndefined();
    expect(result.previousPeriod?.netProfit).toBeUndefined();
    expect(result.salesVolumeThisMonth).toBe(1);
  });

  test("exactly CAP previous sale transactions is published, CAP + 1 is withheld", async () => {
    const exact = await setup();
    await seedSaleTransactions(exact, 40, CAP);
    expect((await monthStats(exact)).previousPeriod?.sales).toBe(CAP);

    const over = await setup();
    await seedSaleTransactions(over, 40, CAP + 1);
    expect((await monthStats(over)).previousPeriod?.sales).toBeUndefined();
  });
});

/**
 * `isDeleted` is optional: a live row holds `undefined` or `false`. Each dated
 * read is two index ranges (one per live value) merged back together, so the
 * cap must hold across their SUM, and a legacy `false` row must still count.
 * The `false` range reads only what the `undefined` range left of the limit.
 */
describe("dashboard.stats live-row reads span both isDeleted states", () => {
  test("a restored (isDeleted: false) expense and sale transaction still count", async () => {
    const s = await setup();
    await seedSales(s, 5, 2);
    await seedExpenses(s, 5, 0, { restored: 7 });
    const result = await monthStats(s);
    expect(result.salesTrend[0]).toMatchObject({ Revenue: 2, Expenses: 7 });

    const fallback = await setup();
    await fallback.t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        orgId: fallback.orgId, type: "IN", amount: 9, date: NOW - 5 * DAY_MS,
        category: "VEHICLE_SALE", description: "Restored", isDeleted: false,
      });
    });
    expect((await monthStats(fallback)).salesVolumeThisMonth).toBe(9);
  });

  test("the cap applies to the sum of both states: CAP split across them is complete, CAP + 1 is not", async () => {
    const exact = await setup();
    await seedSales(exact, 5, 1);
    await seedExpenses(exact, 5, 3000, { restored: 2000 });
    const complete = await monthStats(exact);
    expect(complete.truncated.expenses).toBe(false);
    expect(complete.salesTrend[0].Expenses).toBe(CAP);

    const over = await setup();
    await seedSales(over, 5, 1);
    await seedExpenses(over, 5, 3000, { restored: 2001 });
    const result = await monthStats(over);
    expect(result.truncated.expenses).toBe(true);
    expect(result.salesTrend[0].Expenses).toBeNull();
  });

  test("deleted-but-unreversed expenses and other transactions never count and cannot hide live rows", async () => {
    const s = await setup();
    await seedExpenses(s, 5, 3, { deleted: 50 });
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("transactions", {
          orgId: s.orgId, type: "OUT", amount: 100, date: NOW - 5 * DAY_MS,
          category: "EXPENSE", description: "Not a sale",
        });
      }
      await ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: 5, date: NOW - 5 * DAY_MS,
        category: "VEHICLE_SALE", description: "Live sale",
      });
      await ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: 500, date: NOW - 5 * DAY_MS,
        category: "VEHICLE_SALE", description: "Deleted sale", isDeleted: true,
      });
    });
    const result = await monthStats(s);
    expect(result.salesVolumeThisMonth).toBe(5);
    expect(result.salesTrend[0]).toMatchObject({ Expenses: 3 });
  });

  // convex-test enforces no read limit and reports no read count, so these
  // tests prove financial output only. Rows scanned / billed bytes need a
  // platform measurement (paired preview deployment), which is still required.
});

describe("dashboard.stats ALL_TIME sales cap", () => {
  const allTime = (s: Seed) => s.asUser.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "ALL_TIME" });

  async function seedExcludedSales(s: Seed, deleted: number, pending: number, cancelled: number) {
    await s.t.run(async (ctx) => {
      const base = {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
        salespersonId: s.userId, salePrice: 1000, saleDate: NOW - 5 * DAY_MS,
      };
      for (let i = 0; i < deleted; i++) await ctx.db.insert("sales", { ...base, status: "COMPLETED", isDeleted: true });
      for (let i = 0; i < pending; i++) await ctx.db.insert("sales", { ...base, status: "PENDING" });
      for (let i = 0; i < cancelled; i++) await ctx.db.insert("sales", { ...base, status: "CANCELLED" });
    });
  }

  test("deleted, pending and cancelled sales are neither counted nor able to trip the cap", async () => {
    const s = await setup();
    await seedSales(s, 5, 3);
    await seedExcludedSales(s, CAP, 20, 20);
    const result = await allTime(s);
    expect(result.salesThisMonth).toBe(3);
    expect(result.salesVolumeThisMonth).toBe(3);
    expect(result.truncated.sales).toBe(false);
  });

  test("exactly CAP live sales is exact; CAP + 1 is unavailable, not a 5000-row prefix", async () => {
    const exact = await setup();
    await seedSales(exact, 5, CAP);
    await seedExcludedSales(exact, 5, 5, 5);
    const complete = await allTime(exact);
    expect(complete.salesThisMonth).toBe(CAP);
    expect(complete.salesVolumeThisMonth).toBe(CAP);
    expect(complete.truncated.sales).toBe(false);
    expect(complete.salesTrend.map((point) => point.Revenue)).toEqual([CAP]);

    const over = await setup();
    await seedSales(over, 5, CAP + 1);
    const result = await allTime(over);
    expect(result.salesThisMonth).toBeNull();
    expect(result.salesVolumeThisMonth).toBeNull();
    expect(result.grossTransactionValueThisMonth).toBeNull();
    expect(result.topPerformer).toBeNull();
    expect(result.truncated).toMatchObject({ sales: true, turnover: true, topPerformer: true });
  });
});

describe("dashboard.stats VEHICLE_SALE ledger fallback cap", () => {
  for (const timeRange of ["MONTH", "ALL_TIME"] as const) {
    test(`${timeRange}: exactly CAP ledger rows is exact; CAP + 1 withholds every dependent figure`, async () => {
      const exact = await setup();
      await seedSaleTransactions(exact, 5, CAP);
      const complete = await exact.asUser.query(api.dashboard.stats, { orgId: exact.orgId, timeRange });
      expect(complete.salesThisMonth).toBe(CAP);
      expect(complete.salesVolumeThisMonth).toBe(CAP);
      expect(complete.grossTransactionValueThisMonth).toBe(CAP);
      expect(complete.truncated.sales).toBe(false);
      expect(complete.truncated.turnover).toBe(false);
      expect(complete.salesTrend.map((point) => point.Revenue)).toEqual([CAP]);

      const over = await setup();
      await seedSaleTransactions(over, 5, CAP + 1);
      // One expense gives the trend a bucket, so the null check below is not vacuous.
      await seedExpenses(over, 5, 1);
      const result = await over.asUser.query(api.dashboard.stats, { orgId: over.orgId, timeRange });
      expect(result.salesThisMonth).toBeNull();
      expect(result.salesVolumeThisMonth).toBeNull();
      expect(result.grossTransactionValueThisMonth).toBeNull();
      expect(result.topPerformer).toBeNull();
      expect(result.truncated).toMatchObject({ sales: true, turnover: true });
      // No chart point carries a prefix total: any bucket is explicitly null.
      expect(result.salesTrend.map((point) => point.Revenue)).toEqual([null]);
    });
  }

  test("a ledger split across isDeleted states is capped on the sum", async () => {
    const s = await setup();
    await seedSaleTransactions(s, 5, 3000);
    await seedSaleTransactions(s, 5, 2001, true);
    const result = await monthStats(s);
    expect(result.salesVolumeThisMonth).toBeNull();
    expect(result.truncated.sales).toBe(true);
  });

  test("sale rows settle the window, so an over-cap ledger is never read or reported", async () => {
    const s = await setup();
    await seedSales(s, 5, 2);
    await seedSaleTransactions(s, 5, CAP + 1);
    const result = await monthStats(s);
    expect(result.salesThisMonth).toBe(2);
    expect(result.truncated.sales).toBe(false);
  });
});
