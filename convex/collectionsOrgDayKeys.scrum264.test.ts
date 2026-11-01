import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

/**
 * SCRUM-264 review round 1 (PR #741).
 *
 * `collectionPayments.paymentDate` is stored in TWO forms:
 *  - a CALENDAR KEY, the UTC midnight of the date the user picked (the Record Payment form sends
 *    `dateInputToMs`, `recordPayment` stores it unchanged);
 *  - an INSTANT (`Date.now()`: refund approvals, deposit refunds, cheque clearing, payment links).
 * A calendar key belongs to the organization day that carries its date, in EVERY zone. For a zone west
 * of UTC the key (00:00Z) falls on the previous local evening, so treating it as an instant moved the
 * payment to the wrong day.
 *
 * Cheque dates are calendar keys too, so "this week's cheques" must be bounded by organization calendar
 * keys, not by the instant `now` (a cheque dated today is stored at 00:00Z and is already "in the past").
 *
 * Expected values are written out from the calendar, never computed by the code under test.
 */

type TestConvex = ReturnType<typeof convexTestWithComponents>;

afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: TestConvex, timezone: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Org Day Keys Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "org_day_keys_user", email: "orgdaykeys@example.com", name: "Org Day Keys User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Finance Manager", permissions: ["view:finance", "manage:finance"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser" })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      timezone,
      enabledPaymentTypes: ["CASH"],
    })
  );
  return {
    orgId,
    userId,
    customerId,
    asFinance: t.withIdentity({ subject: "org_day_keys_user", clerkId: "org_day_keys_user" }),
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
        // The Record Payment form writes a UTC-midnight calendar key but stamps createdAt with the write
        // time, never with that midnight; every other value here is an event instant stamped alike.
        createdAt: at % (24 * 60 * 60 * 1000) === 0 ? at - 3_600_000 : at,
        ...over,
      });
    }
  });
}

async function insertCheque(t: TestConvex, base: Seed, chequeDate: number, amount: number, chequeNumber: string) {
  await t.run((ctx) =>
    ctx.db.insert("postDatedCheques", {
      orgId: base.orgId,
      customerId: base.customerId,
      bank: "Key Bank",
      chequeNumber,
      chequeDate,
      amount,
      status: "HELD",
      createdBy: base.userId,
      createdAt: 1,
      updatedAt: 1,
    })
  );
}

const calendarKey = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

describe("SCRUM-264 a calendar-key paymentDate belongs to its own date in every zone", () => {
  test("west of UTC: a payment keyed 31 Oct is on 31 Oct, not on 30 Oct", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [{ at: calendarKey(2026, 10, 31), amount: 10 }]);
    const day = (d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, {
        orgId: s.orgId,
        businessDate: calendarKey(2026, 10, d),
      });
    const oct31 = await day(31);
    expect(oct31.rows).toHaveLength(1);
    expect(oct31.total).toBe(10);
    expect((await day(30)).total).toBe(0);
  });

  test("west of UTC: a form-entered payment keyed 31 Oct is on 31 Oct, mixed with instant rows", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: calendarKey(2026, 10, 31), amount: 10 }, // form-entered, 31 Oct
      { at: Date.parse("2026-10-31T16:00:00Z"), amount: 1 }, // instant: 12:00 on 31 Oct (EDT)
      // instant refund 20:30 on 31 Oct (EDT) - after the 00:00Z that opens the 1 Nov key
      { at: Date.parse("2026-11-01T00:30:00Z"), amount: 2, direction: "OUT", method: "REFUND" },
      { at: calendarKey(2026, 11, 1), amount: 100 }, // form-entered, 1 Nov
      { at: calendarKey(2026, 10, 30), amount: 1000 }, // form-entered, 30 Oct
    ]);
    const day = (month: number, d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, {
        orgId: s.orgId,
        businessDate: calendarKey(2026, month, d),
      });
    const oct31 = await day(10, 31);
    expect(oct31.total).toBe(9); // 10 + 1 - 2
    expect(oct31.rows).toHaveLength(3);
    expect((await day(11, 1)).total).toBe(100);
    expect((await day(10, 30)).total).toBe(1000);
  });

  test("east of UTC: Amman keeps a key-dated payment on its own date and out of its neighbours", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(t, s, [
      { at: calendarKey(2026, 10, 30), amount: 1 },
      { at: calendarKey(2026, 10, 31), amount: 10 },
      { at: calendarKey(2026, 11, 1), amount: 100 },
      { at: Date.parse("2026-10-30T22:00:00Z"), amount: 1000 }, // instant: 01:00 on 31 Oct in Amman
    ]);
    const day = (month: number, d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, {
        orgId: s.orgId,
        businessDate: calendarKey(2026, month, d),
      });
    expect((await day(10, 31)).total).toBe(1010);
    expect((await day(10, 30)).total).toBe(1);
    expect((await day(11, 1)).total).toBe(100);
  });

  test("the 25-hour fall-back day in New York carries the key of its own date only", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: calendarKey(2026, 11, 1), amount: 1 }, // 00:00Z 1 Nov = 20:00 31 Oct EDT, but keyed 1 Nov
      { at: Date.parse("2026-11-01T12:00:00Z"), amount: 2 }, // 07:00 on 1 Nov (EST after the change)
      { at: calendarKey(2026, 11, 2), amount: 4 }, // 00:00Z 2 Nov = 19:00 on 1 Nov EST, but keyed 2 Nov
      { at: Date.parse("2026-11-02T04:30:00Z"), amount: 8 }, // 23:30 on 1 Nov (EST)
    ]);
    const day = (d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, {
        orgId: s.orgId,
        businessDate: calendarKey(2026, 11, d),
      });
    expect((await day(1)).total).toBe(1 + 2 + 8);
    expect((await day(2)).total).toBe(4);
  });

  test("the cashier reconciliation reads key-dated and instant rows of a west-of-UTC day alike", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: calendarKey(2026, 10, 31), amount: 10 },
      { at: Date.parse("2026-10-31T16:00:00Z"), amount: 1 },
      { at: Date.parse("2026-11-01T00:30:00Z"), amount: 2, direction: "OUT", method: "REFUND" },
      { at: calendarKey(2026, 11, 1), amount: 100 },
    ]);
    const draft = await s.asFinance.query(api.collections.getReconciliationDraft, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(draft).toMatchObject({ complete: true, expectedCash: 9, paymentCount: 3 });

    await s.asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
      countedCash: 9,
      idempotencyKey: "keys-recon-oct31",
    });
    await t.run(async (ctx) => {
      const open = (await ctx.db.query("collectionPayments").collect()).filter(
        (payment) => payment.reconciliationId === undefined,
      );
      // Only the 1 Nov key-dated payment is left for its own day.
      expect(open.map((payment) => payment.amount)).toEqual([100]);
    });
  });

  test("summary: collected today follows the organization date for key-dated payments", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 11:00 on 31 Oct in New York
    vi.setSystemTime(Date.parse("2026-10-31T15:00:00Z"));
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: calendarKey(2026, 10, 31), amount: 10 },
      { at: Date.parse("2026-10-31T13:00:00Z"), amount: 1 },
      { at: calendarKey(2026, 10, 30), amount: 1000 },
      { at: calendarKey(2026, 11, 1), amount: 100 },
    ]);
    const summary = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.collectedToday).toBe(11);

    // 23:00 on 30 Oct in New York: the 31 Oct key is not yet today.
    vi.setSystemTime(Date.parse("2026-10-31T03:00:00Z"));
    const night = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(night.collectedToday).toBe(1000);
  });
});

describe("SCRUM-264 this week's cheques are bounded by organization calendar keys", () => {
  test("a HELD cheque dated today is in the week, though its key (00:00Z) is before now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-31T09:00:00Z")); // 12:00 on 31 Oct in Amman
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertCheque(t, s, calendarKey(2026, 10, 31), 70, "TODAY");
    await insertCheque(t, s, calendarKey(2026, 11, 7), 5, "DAY7");
    await insertCheque(t, s, calendarKey(2026, 11, 8), 900, "DAY8");
    await insertCheque(t, s, calendarKey(2026, 10, 30), 900, "YESTERDAY");

    const summary = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.upcomingChequeCount).toBe(2);
    expect(summary.upcomingChequeTotal).toBe(75);
    expect(summary.incomplete.upcomingCheques).toBe(false);
  });

  test("west of UTC the week starts on the organization's own date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-31T02:00:00Z")); // 22:00 on 30 Oct in New York
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertCheque(t, s, calendarKey(2026, 10, 30), 7, "TODAY");
    await insertCheque(t, s, calendarKey(2026, 10, 29), 900, "YESTERDAY");
    await insertCheque(t, s, calendarKey(2026, 11, 6), 3, "DAY7");
    await insertCheque(t, s, calendarKey(2026, 11, 7), 900, "DAY8");

    const summary = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.upcomingChequeCount).toBe(2);
    expect(summary.upcomingChequeTotal).toBe(10);
  });
});

describe("SCRUM-265 a capped NET total can hide a refund, so it is not a lower bound", () => {
  // 500 receipts of 1, then a refund of 400 later the same day: the capped read stops at the 500
  // receipts, shows 500, and the true net is 100. The report must flag the cap AND the screen must
  // not call the figure "at least" (see CollectionsTabIncomplete.scrum265.test.tsx).
  const receiptsAt = Date.parse("2026-10-31T06:00:00Z");
  const refundAt = Date.parse("2026-10-31T08:00:00Z");

  test("summary and the daily report overstate the net and say they are incomplete", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-31T09:00:00Z"));
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(t, s, [
      ...Array.from({ length: 500 }, () => ({ at: receiptsAt, amount: 1 })),
      { at: refundAt, amount: 400, direction: "OUT" as const, method: "REFUND" as const },
    ]);
    const summary = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.collectedToday).toBe(500); // true net is 100
    expect(summary.incomplete.collectedToday).toBe(true);

    const report = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: calendarKey(2026, 10, 31),
    });
    expect(report.total).toBe(500);
    expect(report.incomplete).toBe(true);
  });
});
