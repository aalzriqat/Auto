import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

/**
 * SCRUM-264: Collections business-day boundaries must follow the organization's
 * time zone, not the Convex runtime's (UTC) day.
 * SCRUM-265: a Collections report that stops at a row cap must say so.
 *
 * Expected values are written out as literals from the calendar, not computed by
 * the code under test. Jordan has been on permanent UTC+3 since October 2022, so
 * 2026-10-30T22:00Z is 01:00 on 2026-10-31 in Amman.
 */

type TestConvex = ReturnType<typeof convexTestWithComponents>;

afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: TestConvex, timezone?: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Org Day Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "org_day_user", email: "orgday@example.com", name: "Org Day User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Finance Manager", permissions: ["view:finance", "manage:finance"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser" })
  );
  if (timezone !== undefined) {
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JD",
        timezone,
        enabledPaymentTypes: ["CASH"],
      })
    );
  }
  return {
    orgId,
    userId,
    customerId,
    asFinance: t.withIdentity({ subject: "org_day_user", clerkId: "org_day_user" }),
  };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function insertPayments(
  t: TestConvex,
  base: Seed,
  rows: Array<{ at: number; amount: number } & Partial<Doc<"collectionPayments">>>,
) {
  await t.run(async (ctx) => {
    for (const { at, amount, ...over } of rows) {
      await ctx.db.insert("collectionPayments", {
        orgId: base.orgId,
        customerId: base.customerId,
        cashierId: base.userId,
        direction: "IN",
        method: "CASH",
        amount,
        paymentDate: at,
        status: "POSTED",
        createdAt: at,
        ...over,
      });
    }
  });
}

async function insertReceivables(
  t: TestConvex,
  base: Seed,
  count: number,
  over: { dueDate: number; amount?: number; status?: Doc<"receivables">["status"] },
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      const amount = over.amount ?? 1;
      await ctx.db.insert("receivables", {
        orgId: base.orgId,
        customerId: base.customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: `Receivable ${i}`,
        originalAmount: amount,
        outstandingAmount: amount,
        dueDate: over.dueDate,
        status: over.status ?? "OPEN",
        createdBy: base.userId,
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
}

async function insertCheques(t: TestConvex, base: Seed, count: number, chequeDate: number, prefix: string) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      await ctx.db.insert("postDatedCheques", {
        orgId: base.orgId,
        customerId: base.customerId,
        bank: "Cap Bank",
        chequeNumber: `${prefix}-${i}`,
        chequeDate,
        amount: 1,
        status: "HELD",
        createdBy: base.userId,
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
}

// A calendar date travels as its UTC midnight: this is what dateInputToUtcMs sends from the UI.
const calendarKey = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

describe("SCRUM-264 Collections day boundaries follow the organization time zone", () => {
  test("a payment at 01:00 Amman time belongs to the Jordan day, not the UTC day", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(t, s, [
      { at: Date.parse("2026-10-30T20:59:59Z"), amount: 5 }, // 23:59:59 on 30 Oct in Amman
      { at: Date.parse("2026-10-30T22:00:00Z"), amount: 10 }, // 01:00 on 31 Oct in Amman
      { at: Date.parse("2026-10-31T21:00:00Z"), amount: 7 }, // 00:00 on 1 Nov in Amman
    ]);

    const oct31 = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(oct31.total).toBe(10);
    expect(oct31.rows).toHaveLength(1);

    const oct30 = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 30),
    });
    expect(oct30.total).toBe(5);

    const nov1 = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 11, 1),
    });
    expect(nov1.total).toBe(7);
  });

  test("an organization without a saved time zone uses the Asia/Amman default", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    await insertPayments(t, s, [{ at: Date.parse("2026-10-30T22:00:00Z"), amount: 10 }]);

    const oct31 = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(oct31.total).toBe(10);
  });

  test("an unreadable saved time zone falls back to the default instead of failing the report", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Not/AZone");
    await insertPayments(t, s, [{ at: Date.parse("2026-10-30T22:00:00Z"), amount: 10 }]);

    const oct31 = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(oct31.total).toBe(10);
  });

  test("the cashier reconciliation reads the same org day and keeps the date key stable", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(t, s, [
      { at: Date.parse("2026-10-30T20:59:59Z"), amount: 5 },
      { at: Date.parse("2026-10-30T22:00:00Z"), amount: 10 },
    ]);

    const draft = await s.asFinance.query(api.collections.getReconciliationDraft, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(draft).toMatchObject({ complete: true, expectedCash: 10, paymentCount: 1 });
    // The returned and stored date key stays the UTC-midnight calendar key older rows already use.
    expect(draft.businessDate).toBe(calendarKey(2026, 10, 31));

    const reconciliationId = await s.asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
      countedCash: 10,
      idempotencyKey: "org-day-recon-oct31",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.get(reconciliationId);
      expect(row).toMatchObject({ businessDate: calendarKey(2026, 10, 31), expectedCash: 10, difference: 0 });
      // The 30 Oct payment is still unreconciled and stays available for its own day.
      const all = await ctx.db.query("collectionPayments").collect();
      const open = all.filter((payment) => payment.reconciliationId === undefined);
      expect(open.map((payment) => payment.amount)).toEqual([5]);
    });
  });

  test("summary counts today's collections and dues on the org day, not the UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-30T22:30:00Z")); // 01:30 on 31 Oct in Amman
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(t, s, [
      { at: Date.parse("2026-10-30T20:59:59Z"), amount: 5 }, // yesterday in Amman
      { at: Date.parse("2026-10-30T22:00:00Z"), amount: 10 }, // today in Amman
    ]);
    await insertReceivables(t, s, 1, { dueDate: calendarKey(2026, 10, 31), amount: 40 });
    await insertReceivables(t, s, 1, { dueDate: calendarKey(2026, 10, 30), amount: 3 });

    const summary = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.collectedToday).toBe(10);
    expect(summary.dueToday).toBe(40);
  });

  test("a 25-hour fall-back day in New York keeps its last hour", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: Date.parse("2026-11-01T03:59:59Z"), amount: 1 }, // 23:59:59 on 31 Oct (EDT)
      { at: Date.parse("2026-11-01T04:00:00Z"), amount: 2 }, // 00:00 on 1 Nov (EDT)
      { at: Date.parse("2026-11-02T04:59:59Z"), amount: 4 }, // 23:59:59 on 1 Nov (EST)
      { at: Date.parse("2026-11-02T05:00:00Z"), amount: 8 }, // 00:00 on 2 Nov (EST)
    ]);
    const day = (month: number, d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, {
        orgId: s.orgId,
        businessDate: calendarKey(2026, month, d),
      });
    expect((await day(10, 31)).total).toBe(1);
    expect((await day(11, 1)).total).toBe(6);
    expect((await day(11, 2)).total).toBe(8);
  });

  test("a 23-hour spring-forward day in New York starts and ends on the local clock", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: Date.parse("2026-03-08T04:59:59Z"), amount: 1 }, // 23:59:59 on 7 Mar (EST)
      { at: Date.parse("2026-03-08T05:00:00Z"), amount: 2 }, // 00:00 on 8 Mar (EST)
      { at: Date.parse("2026-03-09T03:59:59Z"), amount: 4 }, // 23:59:59 on 8 Mar (EDT)
      { at: Date.parse("2026-03-09T04:00:00Z"), amount: 8 }, // 00:00 on 9 Mar (EDT)
    ]);
    const day = (d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, {
        orgId: s.orgId,
        businessDate: calendarKey(2026, 3, d),
      });
    expect((await day(7)).total).toBe(1);
    expect((await day(8)).total).toBe(6);
    expect((await day(9)).total).toBe(8);
  });

  test("the result does not depend on the runtime time zone", async () => {
    const original = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const s = await seed(t, "Asia/Amman");
      await insertPayments(t, s, [
        { at: Date.parse("2026-10-30T20:59:59Z"), amount: 5 },
        { at: Date.parse("2026-10-30T22:00:00Z"), amount: 10 },
      ]);
      const oct31 = await s.asFinance.query(api.collections.dailyCollectionList, {
        orgId: s.orgId,
        businessDate: calendarKey(2026, 10, 31),
      });
      expect(oct31.total).toBe(10);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("SCRUM-265 capped Collections reports say when they are incomplete", () => {
  const DAY = Date.parse("2026-10-30T22:00:00Z"); // 31 Oct in Amman

  test("dailyCollectionList reports a complete day exactly at the cap and an incomplete one above it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(t, s, Array.from({ length: 500 }, () => ({ at: DAY, amount: 1 })));

    const atCap = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(atCap.incomplete).toBe(false);
    expect(atCap.rows).toHaveLength(500);
    expect(atCap.total).toBe(500);

    await insertPayments(t, s, [{ at: DAY, amount: 1 }]);
    const overCap = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(overCap.incomplete).toBe(true);
    expect(overCap.rows).toHaveLength(500);
  });

  test("summary flags a receivables total built from a capped prefix", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-31T09:00:00Z"));
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertReceivables(t, s, 500, { dueDate: calendarKey(2026, 11, 20) });
    const atCap = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(atCap.totalOutstanding).toBe(500);
    expect(atCap.incomplete).toEqual({ receivables: false, collectedToday: false, upcomingCheques: false });

    await insertReceivables(t, s, 1, { dueDate: calendarKey(2026, 11, 20) });
    const overCap = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(overCap.incomplete.receivables).toBe(true);
    expect(overCap.incomplete.collectedToday).toBe(false);
  });

  test("summary flags a collected-today total built from a capped prefix", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-31T09:00:00Z"));
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(
      t,
      s,
      Array.from({ length: 501 }, () => ({ at: Date.parse("2026-10-31T06:00:00Z"), amount: 1 })),
    );
    const summary = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.incomplete.collectedToday).toBe(true);
  });

  test("summary flags the upcoming-cheque total when the week holds more than the read budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-31T09:00:00Z"));
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertCheques(t, s, 200, Date.parse("2026-11-02T00:00:00Z"), "CAP");
    const atCap = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(atCap.upcomingChequeCount).toBe(200);
    expect(atCap.incomplete.upcomingCheques).toBe(false);

    await insertCheques(t, s, 1, Date.parse("2026-11-02T00:00:00Z"), "CAPX");
    const overCap = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(overCap.incomplete.upcomingCheques).toBe(true);
  });

  test("upcomingChequeReport flags a capped window", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertCheques(t, s, 501, calendarKey(2026, 11, 2), "RPT");
    const report = await s.asFinance.query(api.collections.upcomingChequeReport, {
      orgId: s.orgId,
      startDate: calendarKey(2026, 11, 1),
      endDate: calendarKey(2026, 11, 7),
    });
    expect(report.incomplete).toBe(true);
    expect(report.rows).toHaveLength(500);
  });

  test("agingReport flags a status whose receivables exceed the read budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-31T09:00:00Z"));
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertReceivables(t, s, 500, { dueDate: calendarKey(2026, 9, 1), status: "OVERDUE" });
    const atCap = await s.asFinance.query(api.collections.agingReport, { orgId: s.orgId });
    expect(atCap.incomplete).toBe(false);
    expect(atCap.days31To60.count).toBe(500);

    await insertReceivables(t, s, 1, { dueDate: calendarKey(2026, 9, 1), status: "OVERDUE" });
    const overCap = await s.asFinance.query(api.collections.agingReport, { orgId: s.orgId });
    expect(overCap.incomplete).toBe(true);
  });
});
