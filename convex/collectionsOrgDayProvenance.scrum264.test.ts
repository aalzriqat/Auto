import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * SCRUM-264 review round 2 (PR #741, Seat 2 findings 1 and 2).
 *
 * `collectionPayments.paymentDate` holds a CALENDAR KEY (UTC midnight of a picked date) from the
 * Record Payment form, and an EVENT INSTANT from every system writer (cheque clearing, refund approval,
 * payment links, deposit receipts and refunds). The two are told apart by what the WRITER stored on the
 * row, never by the shape of the number alone:
 *   - `chequeId` is set only by clearCheque (collections.ts clearCheque)        -> instant
 *   - a value that is not a UTC midnight cannot be a key                         -> instant
 *   - a UTC midnight whose `createdAt` differs is a form key (createdAt = write) -> key
 *   - a UTC midnight equal to `createdAt`: system writers store one clock reading in both fields, so it
 *     is an instant - except an OUT/REFUND row, which the sale-completion deposit refund also writes
 *     with the sale's date key. That one cannot be placed in a zone west of UTC: it is left out and the
 *     report says so.
 *
 * Expected values are written out from the calendar, never computed by the code under test.
 */

type TestConvex = ReturnType<typeof convexTestWithComponents>;

afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: TestConvex, timezone: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Provenance Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "provenance_user", email: "provenance@example.com", name: "Provenance User" })
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
    asFinance: t.withIdentity({ subject: "provenance_user", clerkId: "provenance_user" }),
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

async function insertCheque(t: TestConvex, base: Seed): Promise<Id<"postDatedCheques">> {
  return await t.run((ctx) =>
    ctx.db.insert("postDatedCheques", {
      orgId: base.orgId,
      customerId: base.customerId,
      bank: "Provenance Bank",
      chequeNumber: "CLEARED-1",
      chequeDate: Date.UTC(2026, 9, 1),
      amount: 2,
      status: "CLEARED",
      createdBy: base.userId,
      createdAt: 1,
      updatedAt: 1,
    })
  );
}

const key = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

describe("SCRUM-264 Seat 2 finding 1: an event instant at 00:00:00.000Z is not a calendar key", () => {
  // 2026-11-01T00:00:00.000Z is 20:00 on 31 Oct in New York (EDT, UTC-4). The writers below store the
  // instant the event happened, so every one of them belongs to 31 Oct.
  const midnightInstant = Date.parse("2026-11-01T00:00:00.000Z");

  test("a receipt, a cleared cheque and a cash refund stamped at that instant are on 31 Oct, not 1 Nov", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    const chequeId = await insertCheque(t, s);
    await insertPayments(t, s, [
      // deposit receipt / payment link: createdAt is the same clock reading
      { at: midnightInstant, amount: 1 },
      // clearCheque: chequeId is set, createdAt is its own Date.now()
      { at: midnightInstant, amount: 2, method: "CHEQUE", chequeId, createdAt: midnightInstant + 5 },
      // refund approval paid in cash
      { at: midnightInstant, amount: 4, direction: "OUT", method: "CASH" },
    ]);
    const day = (month: number, d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, { orgId: s.orgId, businessDate: key(2026, month, d) });
    const oct31 = await day(10, 31);
    expect(oct31.rows).toHaveLength(3);
    expect(oct31.total).toBe(1 + 2 - 4);
    expect(oct31.incomplete).toBe(false);
    const nov1 = await day(11, 1);
    expect(nov1.rows).toHaveLength(0);
    expect(nov1.total).toBe(0);
  });

  test("summary: collected today follows the same provenance (20:30 on 31 Oct in New York)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-01T00:30:00.000Z"));
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: midnightInstant, amount: 8 },
      { at: key(2026, 11, 1), amount: 100, createdAt: Date.parse("2026-10-31T13:00:00.000Z") }, // form key for 1 Nov
    ]);
    const summary = await s.asFinance.query(api.collections.summary, { orgId: s.orgId });
    expect(summary.collectedToday).toBe(8);
    expect(summary.incomplete.collectedToday).toBe(false);
  });

  test("the cashier reconciliation files the instant on 31 Oct and the form key on 1 Nov", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: midnightInstant, amount: 8 },
      { at: key(2026, 11, 1), amount: 100, createdAt: Date.parse("2026-10-31T13:00:00.000Z") },
    ]);
    const oct31 = await s.asFinance.query(api.collections.getReconciliationDraft, {
      orgId: s.orgId,
      businessDate: key(2026, 10, 31),
    });
    expect(oct31).toMatchObject({ complete: true, expectedCash: 8, paymentCount: 1 });
    const nov1 = await s.asFinance.query(api.collections.getReconciliationDraft, {
      orgId: s.orgId,
      businessDate: key(2026, 11, 1),
    });
    expect(nov1).toMatchObject({ complete: true, expectedCash: 100, paymentCount: 1 });
  });

  test("a form-entered key keeps its own date because the form stamps createdAt at write time", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: key(2026, 10, 31), amount: 10, createdAt: Date.parse("2026-10-31T15:00:00.000Z") },
      { at: key(2026, 11, 1), amount: 100, createdAt: Date.parse("2026-11-01T15:00:00.000Z") },
    ]);
    const day = (month: number, d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, { orgId: s.orgId, businessDate: key(2026, month, d) });
    expect((await day(10, 31)).total).toBe(10);
    expect((await day(11, 1)).total).toBe(100);
  });
});

describe("SCRUM-264 Seat 2 finding 1: a value that stored facts cannot place is left out and reported", () => {
  // OUT/REFUND with createdAt === paymentDate === a UTC midnight is written by the sale-completion
  // deposit refund with the SALE'S DATE KEY (utils/depositHelpers.ts releaseHeldDeposit, called from
  // utils/saleCompletion.ts with occurredAt: saleDate), and no stored field says whether a given row is
  // that key or a real event at 00:00:00.000Z. West of UTC the two readings are different days.
  const ambiguous = Date.parse("2026-11-01T00:00:00.000Z");

  test("west of UTC it is on neither day and both reports say they are incomplete", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [
      { at: ambiguous, amount: 50, direction: "OUT", method: "REFUND" },
      { at: Date.parse("2026-10-31T16:00:00.000Z"), amount: 3 },
      { at: Date.parse("2026-11-01T16:00:00.000Z"), amount: 5 },
    ]);
    const day = (month: number, d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, { orgId: s.orgId, businessDate: key(2026, month, d) });
    const oct31 = await day(10, 31);
    expect(oct31.total).toBe(3);
    expect(oct31.incomplete).toBe(true);
    expect(oct31.paymentDateUncertain).toBe(true);
    const nov1 = await day(11, 1);
    expect(nov1.total).toBe(5);
    expect(nov1.incomplete).toBe(true);
    expect(nov1.paymentDateUncertain).toBe(true);
    // A day it cannot touch stays exact.
    const oct30 = await day(10, 30);
    expect(oct30.incomplete).toBe(false);
    expect(oct30.paymentDateUncertain).toBe(false);
  });

  test("the reconciliation refuses both days and names the reason, and nothing is attached", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [{ at: ambiguous, amount: 50, direction: "OUT", method: "REFUND" }]);
    for (const [month, d] of [[10, 31], [11, 1]] as const) {
      const draft = await s.asFinance.query(api.collections.getReconciliationDraft, {
        orgId: s.orgId,
        businessDate: key(2026, month, d),
      });
      expect(draft).toMatchObject({ complete: false, reason: "DATE_UNCERTAIN", expectedCash: null, paymentCount: null });
    }
    await expect(
      s.asFinance.mutation(api.collections.submitCashierReconciliation, {
        orgId: s.orgId,
        businessDate: key(2026, 10, 31),
        countedCash: 0,
        idempotencyKey: "uncertain-recon",
      })
    ).rejects.toThrow(/cannot be placed on one day/i);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("cashierReconciliations").collect()).toHaveLength(0);
      const rows = await ctx.db.query("collectionPayments").collect();
      expect(rows.every((row) => row.reconciliationId === undefined)).toBe(true);
    });
  });

  test("east of UTC both readings are the same day, so Amman files it with no warning", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Asia/Amman");
    await insertPayments(t, s, [{ at: ambiguous, amount: 50, direction: "OUT", method: "REFUND" }]); // 03:00 on 1 Nov
    const day = (month: number, d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, { orgId: s.orgId, businessDate: key(2026, month, d) });
    const nov1 = await day(11, 1);
    expect(nov1.total).toBe(-50);
    expect(nov1.incomplete).toBe(false);
    expect(nov1.paymentDateUncertain).toBe(false);
    expect((await day(10, 31)).total).toBe(0);
  });

  test("an OUT/REFUND row at a non-midnight instant is certain, whatever its createdAt", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    await insertPayments(t, s, [{ at: Date.parse("2026-11-01T00:00:00.001Z"), amount: 6, direction: "OUT", method: "REFUND" }]);
    const oct31 = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: key(2026, 10, 31),
    });
    expect(oct31.total).toBe(-6);
    expect(oct31.paymentDateUncertain).toBe(false);
  });

  test("a read that ends on rows of another date is flagged incomplete, never silently complete", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "America/New_York");
    // 500 payments on 1 Nov plus the 2 Nov form key, which sits inside 1 Nov's span (00:00Z 2 Nov is
    // 19:00 on 1 Nov EST). The read budget is 501 rows, so it ends before it can prove the day complete.
    await insertPayments(t, s, [
      ...Array.from({ length: 500 }, () => ({ at: Date.parse("2026-11-01T12:00:00.000Z"), amount: 1 })),
      { at: key(2026, 11, 2), amount: 7, createdAt: Date.parse("2026-11-01T09:00:00.000Z") },
    ]);
    const nov1 = await s.asFinance.query(api.collections.dailyCollectionList, {
      orgId: s.orgId,
      businessDate: key(2026, 11, 1),
    });
    expect(nov1.rows).toHaveLength(500);
    expect(nov1.total).toBe(500);
    expect(nov1.incomplete).toBe(true);
    expect(nov1.paymentDateUncertain).toBe(false);
  });
});

describe("SCRUM-264 Seat 2 finding 2: a skipped calendar date does not break the day before it", () => {
  // Pacific/Apia crossed the date line at the end of 2011-12-29 (UTC-10): the next local date was
  // 2011-12-31 (UTC+14). 2011-12-30 never existed on an Apia wall clock.
  test("2011-12-29 in Apia reports its full 24 hours instead of throwing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Pacific/Apia");
    await insertPayments(t, s, [
      { at: Date.parse("2011-12-29T10:00:00.000Z"), amount: 1 }, // 00:00 on 29 Dec (UTC-10)
      { at: Date.parse("2011-12-30T09:59:59.999Z"), amount: 2 }, // 23:59:59.999 on 29 Dec
      { at: Date.parse("2011-12-30T10:00:00.000Z"), amount: 4 }, // 00:00 on 31 Dec (UTC+14)
    ]);
    const day = (d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, { orgId: s.orgId, businessDate: key(2011, 12, d) });
    const dec29 = await day(29);
    expect(dec29.total).toBe(3);
    expect(dec29.rows).toHaveLength(2);
    expect((await day(31)).total).toBe(4);
  });

  test("the skipped date itself has no instants but still owns the form keys that name it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t, "Pacific/Apia");
    await insertPayments(t, s, [
      { at: key(2011, 12, 30), amount: 9, createdAt: Date.parse("2011-12-30T12:00:00.000Z") },
      { at: Date.parse("2011-12-30T09:30:00.000Z"), amount: 2 }, // 23:30 on 29 Dec
    ]);
    const day = (d: number) =>
      s.asFinance.query(api.collections.dailyCollectionList, { orgId: s.orgId, businessDate: key(2011, 12, d) });
    const dec30 = await day(30);
    expect(dec30.total).toBe(9);
    expect(dec30.rows).toHaveLength(1);
    expect((await day(29)).total).toBe(2);
  });
});
