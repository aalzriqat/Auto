/**
 * The invariant reports.ts claims in its own header — "it can never diverge
 * from the GL" — asserted directly, by running the operational Expenses Report
 * and the ledger-backed income statement over the SAME window and demanding the
 * same number.
 *
 * Reversal is the case that used to break it. `expenses.reverseExpense` posts
 * its offsetting entry at `Date.now()` (a later month) and soft-deletes the
 * expense, so the ledger keeps the original month's expense and credits a later
 * one. The operational report, filtering isDeleted (and, for prepaids, keeping
 * only status POSTED recognition events), instead restated the original month to
 * zero retroactively — silently disagreeing with the income statement for a
 * month that may already be closed.
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { hookPrepaidExpenseWrittenOff } from "./accounting/workflowHooks";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

const OWNER_PERMS = [
  "view:finance", "manage:finance", "view:reports",
  "view:expenses", "create:expenses", "edit:expenses", "delete:expenses",
  "view:vehicles",
];

/** JOD is a 3-decimal currency: 100 JOD == 100_000 minor units. */
const JOD_SCALE = 1000;

/**
 * `openPeriod: false` seeds a dealer with a chart but no open accounting
 * period, which is what makes postOrEnqueue park an expense in the outbox
 * instead of posting it — the "paid but never reached the ledger" state.
 */
async function seedDealer(tag: string, opts: { openPeriod?: boolean } = {}) {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Parity ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}@example.com`, name: "Owner" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: OWNER_PERMS, isSystemOwnerRole: true })
  );
  const userId = await t.run((ctx) =>
    ctx.db.query("users").filter((q) => q.eq(q.field("clerkId"), `${tag}_owner`)).first().then((u) => u!._id)
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const asOwner = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

  if (opts.openPeriod !== false) {
    const fiscalYear = new Date().getUTCFullYear();
    await asOwner.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear, periodNumber: 1,
    });
    const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
    await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }

  return { t, orgId, userId, asOwner };
}

type Ctx = Awaited<ReturnType<typeof seedDealer>>;

/**
 * The whole point: operational report total == ledger income-statement expense
 * total, for the same window. Returns the (agreed) figure in major units.
 */
async function assertParity(ctx: Ctx, from: number, to: number, expected: number, label: string) {
  const operational = await ctx.asOwner.query(api.reports.getExpensesReport, {
    orgId: ctx.orgId, startDate: from, endDate: to,
  });
  const ledger = await ctx.asOwner.query(api.accountingReports.incomeStatement, {
    orgId: ctx.orgId, fromDate: from, toDate: to,
  });
  const ledgerMajor = ledger.totalExpenses / JOD_SCALE;
  expect(operational.totalExpenses, `${label}: operational report`).toBeCloseTo(expected, 6);
  expect(ledgerMajor, `${label}: ledger income statement`).toBeCloseTo(expected, 6);
  return ledgerMajor;
}

// `reverseExpense` always dates its reversal at Date.now(), so the reversal
// lands in the current real-world month. Anchoring the fixtures to January of
// the current year keeps "the month it posted" and "the month it was reversed"
// distinct for any run outside January, which is the whole scenario under test.
const YEAR = new Date().getUTCFullYear();
const NOW_MONTH = new Date().getUTCMonth();
const JAN_START = Date.UTC(YEAR, 0, 1);
const JAN_END = Date.UTC(YEAR, 0, 31, 23, 59, 59, 999);
const REVERSAL_MONTH_START = Date.UTC(YEAR, NOW_MONTH, 1);
const REVERSAL_MONTH_END = Date.UTC(YEAR, NOW_MONTH + 1, 0, 23, 59, 59, 999);
const YEAR_START = Date.UTC(YEAR, 0, 1);
const YEAR_END = Date.UTC(YEAR, 11, 31, 23, 59, 59, 999);
const MAR_START = Date.UTC(YEAR, 2, 1);
const MAR_END = Date.UTC(YEAR, 2, 31, 23, 59, 59, 999);
const JUN_START = Date.UTC(YEAR, 5, 1);
const JUN_END = Date.UTC(YEAR, 5, 30, 23, 59, 59, 999);

const runsInJanuary = NOW_MONTH === 0;

// Parity is the invariant; this is the escape hatch for when it legitimately
// can't hold. An expense whose debit is still queued IS operationally real and
// must report — but the ledger doesn't have it, so the two numbers differ by
// exactly that much, and the report has to say so rather than present one total
// and let the accountant discover the gap by reconciling by hand.
describe("operational Expenses Report — posted vs pending vs failed", () => {
  test("a paid expense whose debit never posted is reported as pending, not as posted", async () => {
    const ctx = await seedDealer("split-pending", { openPeriod: false });
    await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Office supplies", amount: 500, date: Date.UTC(YEAR, 0, 10),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });

    const report = await ctx.asOwner.query(api.reports.getExpensesReport, {
      orgId: ctx.orgId, startDate: JAN_START, endDate: JAN_END,
    });
    const ledger = await ctx.asOwner.query(api.accountingReports.incomeStatement, {
      orgId: ctx.orgId, fromDate: JAN_START, toDate: JAN_END,
    });

    // The operational total is unchanged — this report has always meant "what
    // happened", and that's still 500.
    expect(report.totalExpenses).toBeCloseTo(500, 6);
    // …but none of it is in the ledger, and the split says which.
    expect(report.totalPosted).toBeCloseTo(0, 6);
    expect(report.totalPending).toBeCloseTo(500, 6);
    expect(report.totalFailed).toBeCloseTo(0, 6);
    expect(ledger.totalExpenses / JOD_SCALE).toBeCloseTo(0, 6);
    // The gap between the two reports is exactly the unposted column.
    expect(report.totalExpenses - report.totalPosted).toBeCloseTo(report.totalPending + report.totalFailed, 6);

    expect(report.expenses[0].glState).toBe("PENDING");
    expect(report.expenses[0].pendingAmount).toBeCloseTo(500, 6);
    expect(report.expenses[0].postedAmount).toBeCloseTo(0, 6);
  });

  test("a dead-lettered debit is reported as failed, not merely pending", async () => {
    // Pending resolves itself when a period opens; failed needs a human. A
    // report that merges them hides the one that needs attention.
    const ctx = await seedDealer("split-failed", { openPeriod: false });
    await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Office supplies", amount: 500, date: Date.UTC(YEAR, 0, 10),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });
    await ctx.t.run(async (c) => {
      const entry = await c.db.query("pendingAccountingEvents").filter((q) => q.eq(q.field("orgId"), ctx.orgId)).first();
      await c.db.patch(entry!._id, { status: "FAILED", lastError: "dead-lettered" });
    });

    const report = await ctx.asOwner.query(api.reports.getExpensesReport, {
      orgId: ctx.orgId, startDate: JAN_START, endDate: JAN_END,
    });

    expect(report.totalPending).toBeCloseTo(0, 6);
    expect(report.totalFailed).toBeCloseTo(500, 6);
    expect(report.expenses[0].glState).toBe("FAILED");
  });

  test("an expense that really did post is reported as posted, and agrees with the ledger", async () => {
    // The split must not turn into a blanket "nothing is posted" caveat.
    const ctx = await seedDealer("split-posted");
    await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Office supplies", amount: 500, date: Date.UTC(YEAR, 0, 10),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });

    const report = await ctx.asOwner.query(api.reports.getExpensesReport, {
      orgId: ctx.orgId, startDate: JAN_START, endDate: JAN_END,
    });

    expect(report.totalPosted).toBeCloseTo(500, 6);
    expect(report.totalCapitalized).toBeCloseTo(0, 6);
    expect(report.totalPending).toBeCloseTo(0, 6);
    expect(report.totalFailed).toBeCloseTo(0, 6);
    expect(report.hasUnpostedEntries).toBe(false);
    expect(report.expenses[0].glState).toBe("POSTED");
    await assertParity(ctx, JAN_START, JAN_END, 500, "posted expense");
  });

  test("a capitalized vehicle cost is NOT counted as posted-to-P&L, and the report doesn't claim it agrees", async () => {
    // The dangerous false assurance: the repair reached the ledger, but as an
    // asset (Vehicle Inventory), so the Income Statement is 0 while the naive
    // report would show it fully posted and print "reports agree".
    const ctx = await seedDealer("split-capitalized");
    const vehicleId = await ctx.t.run((c) =>
      c.db.insert("vehicles", {
        orgId: ctx.orgId, vin: "CAPVIN1", make: "Toyota", model: "Camry", year: 2025,
        mileage: 0, color: "White", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 40000, sellingPrice: 45000, status: "AVAILABLE",
      })
    );
    await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Engine repair", amount: 500, date: Date.UTC(YEAR, 0, 10),
      category: "REPAIR", status: "PAID", paymentMethod: "CASH", vehicleId,
    });

    const report = await ctx.asOwner.query(api.reports.getExpensesReport, {
      orgId: ctx.orgId, startDate: JAN_START, endDate: JAN_END,
    });
    const ledger = await ctx.asOwner.query(api.accountingReports.incomeStatement, {
      orgId: ctx.orgId, fromDate: JAN_START, toDate: JAN_END,
    });

    // Operationally the money was spent; on the P&L it's nowhere.
    expect(report.totalExpenses).toBeCloseTo(500, 6);
    expect(report.totalCapitalized).toBeCloseTo(500, 6);
    expect(report.totalPosted).toBeCloseTo(0, 6);
    expect(ledger.totalExpenses / JOD_SCALE).toBeCloseTo(0, 6);
    // The P&L bucket is what may equal the Income Statement — and it does (both 0).
    expect(report.totalPosted).toBeCloseTo(ledger.totalExpenses / JOD_SCALE, 6);
    // Not pending/failed — it really posted, just to an asset.
    expect(report.hasUnpostedEntries).toBe(false);
    expect(report.expenses[0].glState).toBe("CAPITALIZED");
  });

  test("offsetting queued entries net to zero but still count as unresolved", async () => {
    // A queued amortization and a queued reversal of it cancel in money terms.
    // If the all-clear rode on the signed net it would flip green with two
    // entries outstanding — so it rides on the entry COUNT instead.
    const ctx = await seedDealer("split-offsetting");
    const expenseId = await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Insurance", amount: 1200, date: Date.UTC(YEAR, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await ctx.t.run((c) =>
      c.db.query("prepaidExpenseSchedules").withIndex("by_expense", (q) => q.eq("expenseId", expenseId)).first()
    );
    const amortEventId = await ctx.t.run((c) =>
      c.db.insert("accountingEvents", {
        orgId: ctx.orgId, eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules",
        sourceId: `prepaid_amort_${schedule!._id}_${YEAR}-01`, eventVersion: 1,
        idempotencyKey: `amort_${schedule!._id}_${YEAR}-01`, occurredAt: JAN_START, accountingDate: JAN_START,
        currency: "JOD", payloadHash: "t", status: "PENDING", createdBy: ctx.userId, createdAt: Date.now(),
        payload: { scheduleId: schedule!._id.toString(), amountMinor: 100_000, yearMonth: `${YEAR}-01` },
      })
    );
    // The queued amortization (+100) and a queued reversal of it (−100).
    await ctx.t.run((c) =>
      c.db.insert("pendingAccountingEvents", {
        orgId: ctx.orgId, kind: "POST", status: "PENDING", attempts: 0,
        idempotencyKey: `amort_pending_${schedule!._id}`,
        eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules",
        sourceId: `prepaid_amort_${schedule!._id}_${YEAR}-01`, eventVersion: 1,
        accountingDate: JAN_START, occurredAt: JAN_START, currency: "JOD", actorId: ctx.userId, createdAt: Date.now(),
        reason: "queued", payload: { scheduleId: schedule!._id.toString(), amountMinor: 100_000, yearMonth: `${YEAR}-01` },
      })
    );
    await ctx.t.run((c) =>
      c.db.insert("pendingAccountingEvents", {
        orgId: ctx.orgId, kind: "REVERSE", status: "PENDING", attempts: 0,
        idempotencyKey: `amort_reverse_${schedule!._id}`,
        sourceType: "prepaidExpenseSchedules", sourceId: `prepaid_amort_${schedule!._id}_${YEAR}-01`,
        eventVersion: 1, accountingDate: JAN_START, occurredAt: JAN_START, currency: "JOD",
        actorId: ctx.userId, createdAt: Date.now(), reason: "queued reversal",
        originalEventId: amortEventId, payload: {},
      })
    );

    const report = await ctx.asOwner.query(api.reports.getExpensesReport, {
      orgId: ctx.orgId, startDate: JAN_START, endDate: JAN_END,
    });

    // Net pending is zero…
    expect(report.totalPending).toBeCloseTo(0, 6);
    // …but two entries are outstanding, so the all-clear must NOT fire.
    expect(report.pendingEntryCount).toBe(2);
    expect(report.hasUnpostedEntries).toBe(true);
  });

  test("a prepaid schedule with one month posted and the next queued reports as MIXED, split across both columns", async () => {
    // The case only a per-event split can represent: the schedule's own months
    // are what posted or didn't, independent of the debit that opened it.
    const ctx = await seedDealer("split-mixed");
    const expenseId = await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Insurance", amount: 1200, date: Date.UTC(YEAR, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await ctx.t.run((c) =>
      c.db.query("prepaidExpenseSchedules").withIndex("by_expense", (q) => q.eq("expenseId", expenseId)).first()
    );
    // January recognizes and posts (the year's period is open).
    await ctx.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
      orgId: ctx.orgId, scheduleId: schedule!._id, yearMonth: `${YEAR}-01`,
      occurredAt: Date.UTC(YEAR, 0, 31), systemActorId: ctx.userId,
    });
    // February recognizes but its posting is parked, as if the period had closed.
    await ctx.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
      orgId: ctx.orgId, scheduleId: schedule!._id, yearMonth: `${YEAR}-02`,
      occurredAt: Date.UTC(YEAR, 1, 28), systemActorId: ctx.userId,
    });
    await ctx.t.run(async (c) => {
      const feb = await c.db
        .query("accountingEvents")
        .filter((q) => q.eq(q.field("eventType"), "PREPAID_EXPENSE_AMORTIZED"))
        .collect()
        .then((rows) => rows.find((r) => (r.payload as { yearMonth?: string })?.yearMonth === `${YEAR}-02`));
      // Re-park February as a queued outbox row: the shape a month recognized
      // behind a closed period actually has.
      await c.db.delete(feb!._id);
      await c.db.insert("pendingAccountingEvents", {
        orgId: ctx.orgId, kind: "POST", status: "PENDING", attempts: 0,
        idempotencyKey: `prepaid_amort_${schedule!._id}_${YEAR}-02`,
        eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules",
        sourceId: `prepaid_amort_${schedule!._id}_${YEAR}-02`, eventVersion: 1,
        accountingDate: Date.UTC(YEAR, 1, 28), occurredAt: Date.UTC(YEAR, 1, 28),
        currency: "JOD", actorId: ctx.userId, createdAt: Date.now(), reason: "period closed",
        payload: {
          scheduleId: schedule!._id.toString(), amountMinor: 100_000, currency: "JOD",
          yearMonth: `${YEAR}-02`, expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE",
        },
      });
    });

    const report = await ctx.asOwner.query(api.reports.getExpensesReport, {
      orgId: ctx.orgId, startDate: JAN_START, endDate: Date.UTC(YEAR, 1, 28, 23, 59, 59, 999),
    });

    expect(report.totalExpenses).toBeCloseTo(200, 6);
    expect(report.totalPosted).toBeCloseTo(100, 6);
    expect(report.totalPending).toBeCloseTo(100, 6);
    const row = report.expenses.find((e) => e._id === expenseId)!;
    expect(row.glState).toBe("MIXED");
    expect(row.postedAmount).toBeCloseTo(100, 6);
    expect(row.pendingAmount).toBeCloseTo(100, 6);
  });
});

describe("operational Expenses Report vs ledger income statement — parity across reversals", () => {
  test("an ordinary expense reversed in a later month keeps reporting in the month it posted", async () => {
    const ctx = await seedDealer("ord");
    const expenseId = await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Office supplies", amount: 500, date: Date.UTC(YEAR, 0, 10),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });

    await assertParity(ctx, JAN_START, JAN_END, 500, "January before reversal");

    await ctx.asOwner.mutation(api.expenses.reverseExpense, {
      orgId: ctx.orgId, expenseId, reason: "Duplicate entry",
    });

    // The reversal does NOT reach back and erase January.
    await assertParity(ctx, JAN_START, JAN_END, 500, "January after reversal");

    if (!runsInJanuary) {
      // The credit lands in the month the reversal is dated, as its own event.
      await assertParity(ctx, REVERSAL_MONTH_START, REVERSAL_MONTH_END, -500, "reversal month");
    }

    // Across both months it nets to zero — the reversal cancels the expense in
    // total, just never retroactively.
    await assertParity(ctx, YEAR_START, YEAR_END, 0, "full year");
  });

  test("a prepaid expense reversed after amortizing keeps each posted month intact", async () => {
    const ctx = await seedDealer("prepaid");
    const expenseId = await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Insurance", amount: 1200, date: Date.UTC(YEAR, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await ctx.t.run((c) =>
      c.db.query("prepaidExpenseSchedules").withIndex("by_expense", (q) => q.eq("expenseId", expenseId)).first()
    );
    await ctx.t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
      orgId: ctx.orgId, scheduleId: schedule!._id, yearMonth: `${YEAR}-01`,
      occurredAt: Date.UTC(YEAR, 0, 15), systemActorId: ctx.userId,
    });

    // 1/12 of 1200 recognized in January.
    await assertParity(ctx, JAN_START, JAN_END, 100, "January before reversal");

    await ctx.asOwner.mutation(api.expenses.reverseExpense, {
      orgId: ctx.orgId, expenseId, reason: "Policy cancelled",
    });

    await assertParity(ctx, JAN_START, JAN_END, 100, "January after reversal");

    if (!runsInJanuary) {
      await assertParity(ctx, REVERSAL_MONTH_START, REVERSAL_MONTH_END, -100, "reversal month");
    }

    await assertParity(ctx, YEAR_START, YEAR_END, 0, "full year");
  });

  test("an expense deleted before it ever posted stays invisible to both", async () => {
    const ctx = await seedDealer("unposted");
    const expenseId = await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Draft entry", amount: 300, date: Date.UTC(YEAR, 0, 12),
      category: "OTHER", status: "PENDING", paymentMethod: "CASH",
    });
    await ctx.asOwner.mutation(api.expenses.remove, { orgId: ctx.orgId, expenseId });

    // No reversedAt, no GL footprint — the isDeleted filter still applies.
    await assertParity(ctx, JAN_START, JAN_END, 0, "January");
  });

  test("reversing a paid expense that only ever queued leaves both at zero", async () => {
    // Paid with no open period: postOrEnqueue parks EXPENSE_POSTED in the
    // outbox, so the ledger never sees it.
    const ctx = await seedDealer("queued", { openPeriod: false });
    const expenseId = await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Fuel", amount: 500, date: Date.UTC(YEAR, 0, 10),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });

    const queued = await ctx.t.run((c) =>
      c.db.query("pendingAccountingEvents").filter((q) => q.eq(q.field("orgId"), ctx.orgId)).collect()
    );
    expect(queued.map((q) => q.idempotencyKey), "expense should be queued, not posted")
      .toContain(`expense_posted_${expenseId}`);

    await ctx.asOwner.mutation(api.expenses.reverseExpense, {
      orgId: ctx.orgId, expenseId, reason: "Entered in error",
    });

    // Reversal cancelled the queued post, so nothing ever hit the ledger. The
    // operational report must not invent an expense in January and a credit in
    // the reversal month for a GL that holds neither.
    await assertParity(ctx, JAN_START, JAN_END, 0, "January after reversing a queued expense");
    if (!runsInJanuary) {
      await assertParity(ctx, REVERSAL_MONTH_START, REVERSAL_MONTH_END, 0, "reversal month");
    }
    await assertParity(ctx, YEAR_START, YEAR_END, 0, "full year");

    const reversed = await ctx.t.run((c) => c.db.get(expenseId));
    expect(reversed?.reversedAt, "a cancelled queued post is not a ledger reversal").toBeUndefined();
  });

  // "EXPENSE_POSTED never posted" does NOT imply "this expense left no mark on
  // the P&L", so reversedAt can't be decided on EXPENSE_POSTED alone.
  //
  // correctSchedule now refuses to post a refund or write-off while the source
  // expense is still queued, because that credit would have no matching debit
  // (see requireSourceExpensePostedForGlCorrection). It carried no such guard
  // before, so schedules already in the wild can hold a POSTED write-off
  // against an expense whose EXPENSE_POSTED never landed — postability is
  // judged per event date, and an expense dated in a month that never opens
  // stays queued indefinitely. Reversal still has to account for that history,
  // so this reconstructs it through the same posting hook correctSchedule uses
  // rather than through the now-guarded public mutation.
  test("a queued prepaid whose write-off posted keeps the write-off's month", async () => {
    const ctx = await seedDealer("queued-writeoff", { openPeriod: false });
    const expenseId = await ctx.asOwner.mutation(api.expenses.create, {
      orgId: ctx.orgId, title: "Insurance", amount: 1200, date: Date.UTC(YEAR, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });

    // Opens February–December only. January never gets a period, so the
    // EXPENSE_POSTED dated Jan 1 can never drain — not even via the drain that
    // opening a period schedules, which is what makes this deterministic.
    await ctx.asOwner.mutation(api.accountingPeriods.create, {
      orgId: ctx.orgId, startDate: Date.UTC(YEAR, 1, 1), endDate: YEAR_END, fiscalYear: YEAR, periodNumber: 1,
    });
    const period = (await ctx.asOwner.query(api.accountingPeriods.list, { orgId: ctx.orgId }))[0];
    await ctx.asOwner.mutation(api.accountingPeriods.open, { orgId: ctx.orgId, periodId: period._id });

    const schedule = await ctx.t.run((c) =>
      c.db.query("prepaidExpenseSchedules").withIndex("by_expense", (q) => q.eq("expenseId", expenseId)).first()
    );

    // Legacy state: a write-off posted in March against a still-queued expense.
    await ctx.t.run(async (c) => {
      const correctionId = await c.db.insert("prepaidScheduleCorrections", {
        orgId: ctx.orgId, scheduleId: schedule!._id, refundMinor: 0,
        writeOffMinor: 300 * JOD_SCALE, previousTermMonths: 12, newTermMonths: 12,
        reason: "Unused balance written off (pre-guard)", actorId: ctx.userId,
        createdAt: Date.UTC(YEAR, 2, 20),
      });
      await hookPrepaidExpenseWrittenOff(c, {
        orgId: ctx.orgId, scheduleId: schedule!._id, correctionId,
        amountMinor: 300 * JOD_SCALE, currency: "JOD",
        expenseSystemKey: schedule!.expenseSystemKey, actorId: ctx.userId,
        occurredAt: Date.UTC(YEAR, 2, 20),
      });
    });

    const queuedPost = await ctx.t.run((c) =>
      c.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", (q) =>
        q.eq("orgId", ctx.orgId).eq("idempotencyKey", `expense_posted_${expenseId}`)
      ).first()
    );
    expect(queuedPost, "EXPENSE_POSTED must still be queued for this to be the case under test").not.toBeNull();

    // Real ledger history in March, despite EXPENSE_POSTED never posting.
    await assertParity(ctx, MAR_START, MAR_END, 300, "March before reversal");

    // The reversal is dated by wall-clock `now`, so pin it to June. Restored in
    // `finally` — nothing here resets mocks automatically, so letting a failed
    // assertion escape with Date.now still stubbed would strand every later test
    // in this file in June and bury the real failure under the fallout.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(YEAR, 5, 15));
    try {
      await ctx.asOwner.mutation(api.expenses.reverseExpense, {
        orgId: ctx.orgId, expenseId, reason: "Policy cancelled",
      });
    } finally {
      clock.mockRestore();
    }

    // Cancelling the queued EXPENSE_POSTED must not erase the write-off that
    // really did post: March keeps it, the credit lands in the reversal month.
    await assertParity(ctx, MAR_START, MAR_END, 300, "March after reversal");
    await assertParity(ctx, JUN_START, JUN_END, -300, "reversal month");
    await assertParity(ctx, JAN_START, JAN_END, 0, "January never posted");
    await assertParity(ctx, YEAR_START, YEAR_END, 0, "full year");
  });
});
