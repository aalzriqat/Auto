/**
 * Prepaid-expense-as-asset GL lifecycle + related accounting-autonomy fixes.
 *
 * Covers:
 *  - the authoritative straight-line schedule (exact-term rounding)
 *  - initial posting DR Prepaid Expenses / CR Cash
 *  - monthly amortization DR expense / CR Prepaid Expenses (idempotent per
 *    month, strict month ordering, catch-up, full-term completion)
 *  - reversal unwinding the whole lifecycle to zero + schedule CANCELLED
 *  - operational P&L report and GL deriving from the SAME schedule
 *  - Prepaid asset vs schedule reconciliation
 *  - chart self-heal code-collision safety (Fix #4)
 *  - current-state reconciliations are close *warnings*, not blockers (Fix #1)
 *  - inactive accounts rejected for manual posting (Fix #3)
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { recognizedThroughMonthsMinor, monthAmountMinor } from "./utils/expenseAmortization";
import { computePrepaidRecognitionShortfall } from "./accountingReports";
import { toYearMonth } from "./prepaidExpenses";

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

async function seedDealer(tag = "prepaid") {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Prepaid ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}@example.com`, name: "Owner" }));
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: OWNER_PERMS, isSystemOwnerRole: true })
  );
  const userId = await t.run((ctx) =>
    ctx.db.query("users").filter((q) => q.eq(q.field("clerkId"), `${tag}_owner`)).first().then((u) => u!._id)
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );

  const asOwner = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, asOwner, period };
}

type T = Awaited<ReturnType<typeof seedDealer>>["t"];

async function accountBySystemKey(t: T, orgId: Id<"organizations">, systemKey: string) {
  return await t.run((ctx) =>
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey)).unique()
  );
}

/** Net debit-minus-credit balance across every journal line for an account (includes reversals). */
async function accountNetMinor(t: T, orgId: Id<"organizations">, systemKey: string): Promise<number> {
  const account = await accountBySystemKey(t, orgId, systemKey);
  if (!account) return 0;
  const lines = await t.run((ctx) =>
    ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
  return lines.filter((l) => l.accountId === account._id).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
}

async function scheduleForExpense(t: T, expenseId: Id<"expenses">) {
  return await t.run((ctx) =>
    ctx.db.query("prepaidExpenseSchedules").withIndex("by_expense", (q) => q.eq("expenseId", expenseId)).first()
  );
}

/** A non-owner member with MANAGE_FINANCE (Phase 6 maker-checker tests need a caller who ISN'T the org owner). */
async function addFinanceUser(t: T, orgId: Id<"organizations">, tag: string) {
  await t.run((ctx) => ctx.db.insert("users", { clerkId: tag, email: `${tag}@example.com`, name: tag }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Accountant", permissions: OWNER_PERMS })
  );
  const userId = await t.run((ctx) =>
    ctx.db.query("users").filter((q) => q.eq(q.field("clerkId"), tag)).first().then((u) => u!._id)
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { userId, asUser: t.withIdentity({ subject: tag, clerkId: tag }) };
}

// ─── Authoritative schedule math ──────────────────────────────────────────────

describe("prepaid amortization schedule (exact-term rounding)", () => {
  test("evenly divisible: each month is an equal share and the sum is exact", () => {
    const total = 1_200_000, term = 12;
    const months = Array.from({ length: term }, (_, i) => monthAmountMinor(total, term, i));
    expect(months.every((m) => m === 100_000)).toBe(true);
    expect(months.reduce((s, m) => s + m, 0)).toBe(total);
  });

  test("indivisible: earlier months ceil, final month absorbs the remainder, sum is exact", () => {
    const total = 1_000_000, term = 3; // 1,000,000 / 3 does not divide evenly
    const months = Array.from({ length: term }, (_, i) => monthAmountMinor(total, term, i));
    expect(months.reduce((s, m) => s + m, 0)).toBe(total);
    // Never needs a term+1 month: after `term` months everything is recognized.
    expect(recognizedThroughMonthsMinor(total, term, term)).toBe(total);
    expect(recognizedThroughMonthsMinor(total, term, term + 5)).toBe(total);
    expect(recognizedThroughMonthsMinor(total, term, 0)).toBe(0);
  });
});

// ─── Initial posting + schedule creation ──────────────────────────────────────

describe("prepaid expense — initial posting", () => {
  test("a prepaid expense debits Prepaid Expenses (asset), not an expense account, and opens a schedule", async () => {
    const { t, orgId, asOwner } = await seedDealer("post");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Annual insurance", amount: 1200, date: Date.UTC(2026, 0, 15),
      category: "FEES", status: "PAID", paymentMethod: "CASH",
      isPrepaid: true, amortizationMonths: 12,
    });

    // Prepaid Expenses asset debited in full; no expense account touched yet.
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(1_200_000);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "CASH_ON_HAND")).toBe(-1_200_000);

    const schedule = await scheduleForExpense(t, expenseId);
    expect(schedule).toBeTruthy();
    expect(schedule!.status).toBe("ACTIVE");
    expect(schedule!.totalMinor).toBe(1_200_000);
    expect(schedule!.termMonths).toBe(12);
    expect(schedule!.expenseSystemKey).toBe("PROFESSIONAL_FEES_EXPENSE");
    expect(schedule!.startYearMonth).toBe("2026-01");
  });

  test("VAT is split out immediately; only the net amount capitalizes to the asset and amortizes", async () => {
    const { t, orgId, asOwner } = await seedDealer("vat");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Prepaid rent w/ VAT", amount: 1200, taxAmount: 200, date: Date.UTC(2026, 0, 10),
      category: "RENT", status: "PAID", paymentMethod: "CASH",
      isPrepaid: true, amortizationMonths: 10,
    });
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(1_000_000); // net of VAT
    expect(await accountNetMinor(t, orgId, "VAT_RECEIVABLE")).toBe(200_000);
    const schedule = await scheduleForExpense(t, expenseId);
    expect(schedule!.totalMinor).toBe(1_000_000);
  });
});

// ─── Monthly amortization ─────────────────────────────────────────────────────

async function amortize(t: T, orgId: Id<"organizations">, scheduleId: Id<"prepaidExpenseSchedules">, userId: Id<"users">, yearMonth: string) {
  return await t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
    orgId, scheduleId, yearMonth, occurredAt: Date.UTC(2026, 0, 15), systemActorId: userId,
  });
}

describe("prepaid expense — monthly amortization", () => {
  test("one month releases a share from the asset to the expense account, idempotently", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("amort");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);

    const first = await amortize(t, orgId, schedule!._id, userId, "2026-01");
    expect(first.posted).toBe(true);
    expect(first.amountMinor).toBe(100_000);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(100_000);
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(1_100_000);

    // Re-running the same month is a no-op (idempotent per calendar month).
    const rerun = await amortize(t, orgId, schedule!._id, userId, "2026-01");
    expect(rerun.posted).toBe(false);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(100_000);
  });

  test("waits until the source EXPENSE_POSTED event has actually posted before recognizing", async () => {
    const { t, orgId, userId } = await seedDealer("gate");
    // A schedule whose expense has no POSTED EXPENSE_POSTED event yet (e.g. it
    // was queued because no period was open at posting time).
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
        category: "FEES", status: "PAID", isPrepaid: true, amortizationMonths: 12,
      })
    );
    const scheduleId = await t.run((ctx) =>
      ctx.db.insert("prepaidExpenseSchedules", {
        orgId, expenseId, currency: "JOD", totalMinor: 1_200_000, termMonths: 12,
        expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", startYearMonth: "2026-01",
        recognizedMinor: 0, monthsRecognized: 0, status: "ACTIVE", createdAt: Date.now(),
      })
    );
    const r = await t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
      orgId, scheduleId, yearMonth: "2026-01", occurredAt: Date.UTC(2026, 0, 15), systemActorId: userId,
    });
    expect(r.posted).toBe(false);
    expect(r.reason).toBe("source_expense_not_posted");
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
  });

  test("strict month ordering: a month at/before the last recognized one is rejected", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("order");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-03"); // catch up through March (3 months)
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(300_000);

    const earlier = await amortize(t, orgId, schedule!._id, userId, "2026-02");
    expect(earlier.posted).toBe(false);
    expect(earlier.reason).toBe("not_after_last_recognized_month");
  });

  test("runs to full term, then stops without over-recognizing; asset nets to zero", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("full");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1000, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 3, // 1000/3 indivisible
    });
    const schedule = await scheduleForExpense(t, expenseId);
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }
    const afterTerm = await amortize(t, orgId, schedule!._id, userId, "2026-04");
    expect(afterTerm.posted).toBe(false);

    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(1_000_000);
    const finalSchedule = await scheduleForExpense(t, expenseId);
    expect(finalSchedule!.status).toBe("FULLY_AMORTIZED");
    expect(finalSchedule!.recognizedMinor).toBe(1_000_000);
  });
});

// ─── Reversal ─────────────────────────────────────────────────────────────────

describe("prepaid expense — reversal unwinds the whole lifecycle", () => {
  test("reversing after partial amortization nets every account to zero and cancels the schedule", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("rev");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");
    await amortize(t, orgId, schedule!._id, userId, "2026-02");
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(200_000);

    await asOwner.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Policy cancelled, full refund" });

    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "CASH_ON_HAND")).toBe(0);
    const cancelled = await scheduleForExpense(t, expenseId);
    expect(cancelled!.status).toBe("CANCELLED");
  });

  test("reversing after a partial refund correction also unwinds the refund — no orphaned cash or negative prepaid balance", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("rev-refund");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    // Vendor refunds part of the unused balance before the expense is reversed.
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 300_000, refundPaymentMethod: "CASH",
      reason: "Partial refund ahead of cancellation",
    });

    await asOwner.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Policy cancelled" });

    // Without reversing the posted PREPAID_EXPENSE_REFUNDED event too, the
    // refund's cash-in and prepaid-credit would survive the original
    // expense's reversal: Prepaid Expenses would sit at a negative (credit)
    // balance and Cash would carry an unexplained surplus.
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "CASH_ON_HAND")).toBe(0);
  });

  test("reversing after an accelerated write-off correction also unwinds the write-off — no orphaned expense or negative prepaid balance", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("rev-writeoff");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    // Non-refundable portion of the unused balance is accelerated to expense
    // before the expense itself is reversed.
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Non-refundable portion",
    });

    await asOwner.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Policy cancelled" });

    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "CASH_ON_HAND")).toBe(0);
  });

  test("reversing after a combined VAT refund + write-off unwinds both corrections", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("rev-combined");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Prepaid rent w/ VAT", amount: 1200, taxAmount: 200, date: Date.UTC(2026, 0, 1),
      category: "RENT", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 10,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 200_000, refundTaxMinor: 40_000,
      refundPaymentMethod: "CASH", reason: "Partial refund",
    });
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 100_000, reason: "Non-refundable remainder",
    });

    await asOwner.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Lease terminated" });

    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
    expect(await accountNetMinor(t, orgId, "RENT_EXPENSE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "CASH_ON_HAND")).toBe(0);
    expect(await accountNetMinor(t, orgId, "VAT_RECEIVABLE")).toBe(0);
  });

});

// ─── Reports and GL derive from the same schedule ─────────────────────────────

describe("prepaid expense — operational report matches the GL", () => {
  test("the operational P&L recognizes exactly what the GL amortized for the month", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("report");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const report = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2026, 0, 1), endDate: Date.UTC(2026, 0, 31, 23, 59, 59, 999),
    });
    // Report recognizes 1/12 (100 JOD major) for January — the same 100,000
    // minor the GL posted to the expense account.
    expect(report.totalExpenses).toBeCloseTo(100, 6);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(100_000);
  });

  test("Fix B1 — with VAT, the report recognizes the NET monthly share (from the schedule), not gross", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("vatreport");
    // Gross 1200 incl. 200 VAT → net 1000 capitalized, amortized over 10 months.
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Prepaid rent w/ VAT", amount: 1200, taxAmount: 200, date: Date.UTC(2026, 0, 1),
      category: "RENT", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 10,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const report = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2026, 0, 1), endDate: Date.UTC(2026, 0, 31, 23, 59, 59, 999),
    });
    // Net 1000 / 10 = 100 per month — NOT gross 1200 / 10 = 120. The report and
    // the GL agree exactly because both read the net schedule row.
    expect(report.totalExpenses).toBeCloseTo(100, 6);
    expect(await accountNetMinor(t, orgId, "RENT_EXPENSE")).toBe(100_000);
  });

  test("a prepaid schedule that started before the reporting window still amortizes into it (schedule-driven, no lookback cap)", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("prior");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    for (const m of ["2026-01", "2026-02", "2026-03"]) await amortize(t, orgId, schedule!._id, userId, m);

    // Report for MARCH only — the expense's date (Jan 1) is before the window,
    // so it's found via its schedule, not a dated expense scan.
    const report = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2026, 2, 1), endDate: Date.UTC(2026, 2, 31, 23, 59, 59, 999),
    });
    expect(report.totalExpenses).toBeCloseTo(100, 6); // March's 1/12
    expect(report.expenses.some((e: { _id: Id<"expenses"> }) => e._id === expenseId)).toBe(true);
  });
});

// ─── Phase 1 — report derives from GL events, not a curve recompute ───────────

/** UTC month bounds for a "YYYY-MM" string, for report startDate/endDate. */
function monthRange(yearMonth: string): { start: number; end: number } {
  const [year, month] = yearMonth.split("-").map(Number);
  return { start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 0, 23, 59, 59, 999) };
}

describe("Phase 1 — report derives from posted/parked recognition events, never a curve recompute", () => {
  test("a write-off's accelerated expense shows up in its own correction month, never restating already-posted months", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("evt-writeoff");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }
    for (const monthIdx of [0, 1, 2]) {
      const report = await asOwner.query(api.reports.getExpensesReport, {
        orgId, startDate: Date.UTC(2026, monthIdx, 1), endDate: Date.UTC(2026, monthIdx, 28, 23, 59, 59, 999),
      });
      expect(report.totalExpenses).toBeCloseTo(100, 6);
    }

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Early cancellation, non-refundable portion",
    });

    // correctSchedule dates its GL event at real wall-clock "now" — the
    // write-off shows up there, in full, and nowhere else.
    const { start, end } = monthRange(toYearMonth(Date.now()));
    const correctionReport = await asOwner.query(api.reports.getExpensesReport, { orgId, startDate: start, endDate: end });
    expect(correctionReport.totalExpenses).toBeCloseTo(300, 6);

    // Jan-Mar still report exactly what they always did — the correction
    // never leaks backward into an already-reported month.
    for (const monthIdx of [0, 1, 2]) {
      const report = await asOwner.query(api.reports.getExpensesReport, {
        orgId, startDate: Date.UTC(2026, monthIdx, 1), endDate: Date.UTC(2026, monthIdx, 28, 23, 59, 59, 999),
      });
      expect(report.totalExpenses).toBeCloseTo(100, 6);
    }

    // Finish out the corrected schedule; a lifetime report totals exactly
    // what the GL posted (300 amortized + 300 write-off + 600 amortized) —
    // the original 1200, just reclassified in timing, never more or less.
    for (const m of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }
    const lifetimeReport = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2000, 0, 1), endDate: Date.UTC(2100, 0, 1),
    });
    expect(lifetimeReport.totalExpenses).toBeCloseTo(1200, 6);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(1_200_000);
  });

  test("a refund never appears in the P&L (cash vs asset, not an expense), and history/future months are unaffected", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("evt-refund");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 300_000, refundPaymentMethod: "CASH", reason: "Early cancellation, refunded",
    });

    const { start, end } = monthRange(toYearMonth(Date.now()));
    const correctionReport = await asOwner.query(api.reports.getExpensesReport, { orgId, startDate: start, endDate: end });
    expect(correctionReport.totalExpenses).toBe(0);

    for (const monthIdx of [0, 1, 2]) {
      const report = await asOwner.query(api.reports.getExpensesReport, {
        orgId, startDate: Date.UTC(2026, monthIdx, 1), endDate: Date.UTC(2026, monthIdx, 28, 23, 59, 59, 999),
      });
      expect(report.totalExpenses).toBeCloseTo(100, 6);
    }

    // Future recognition re-bases off what's actually left (900 over 9
    // remaining months), same as the write-off case, and reports correctly.
    const april = await amortize(t, orgId, schedule!._id, userId, "2026-04");
    expect(april.amountMinor).toBe(66_666);
    const aprilReport = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2026, 3, 1), endDate: Date.UTC(2026, 3, 30, 23, 59, 59, 999),
    });
    expect(aprilReport.totalExpenses).toBeCloseTo(66.666, 3);
  });

  test("a correction that consumes the full remainder cancels the schedule, but prior months still report with no expense-doc double count", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("evt-full-writeoff");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 1_100_000, reason: "Full write-off, contract voided",
    });
    expect((await scheduleForExpense(t, expenseId))!.status).toBe("CANCELLED");

    // January's already-posted month still reports exactly 100 — cancellation
    // stops future recognition, it doesn't erase history or fall back to the
    // raw expense-doc curve (which would show the full 1200 for January).
    const januaryReport = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2026, 0, 1), endDate: Date.UTC(2026, 0, 31, 23, 59, 59, 999),
    });
    expect(januaryReport.totalExpenses).toBeCloseTo(100, 6);

    // Lifetime total equals the GL total exactly once (no double count from
    // the CANCELLED-schedule doc fallback, no dropped write-off).
    const lifetimeReport = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2000, 0, 1), endDate: Date.UTC(2100, 0, 1),
    });
    expect(lifetimeReport.totalExpenses).toBeCloseTo(1200, 6);
  });

  test("a month parked in the outbox behind a closed period still reports in its own month", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("evt-parked");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    // Simulate February's recognition having operationally happened
    // (recognizedMinor bumped, same as amortizeScheduleForMonth) but its GL
    // posting queued behind a closed period instead of posted immediately —
    // the same outbox shape a real deferred posting produces.
    await t.run((ctx) =>
      ctx.db.patch(schedule!._id, { recognizedMinor: 200_000, monthsRecognized: 2, lastRecognizedYearMonth: "2026-02" })
    );
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING", idempotencyKey: `prepaid_amort_${schedule!._id}_2026-02`,
        accountingDate: Date.UTC(2026, 1, 28), actorId: userId, attempts: 0, createdAt: Date.now(),
        eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules",
        sourceId: `prepaid_amort_${schedule!._id}_2026-02`,
        payload: { scheduleId: schedule!._id.toString(), amountMinor: 100_000, currency: "JOD", yearMonth: "2026-02" },
      })
    );

    const report = await asOwner.query(api.reports.getExpensesReport, {
      orgId, startDate: Date.UTC(2026, 1, 1), endDate: Date.UTC(2026, 1, 28, 23, 59, 59, 999),
    });
    expect(report.totalExpenses).toBeCloseTo(100, 6);
  });
});

// ─── Reconciliation ───────────────────────────────────────────────────────────

describe("prepaid expenses reconciliation", () => {
  test("GL Prepaid asset equals the sum of ACTIVE schedules' remaining", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("recon");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const recon = await asOwner.query(api.accountingReports.prepaidExpensesReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
    expect(recon.byCurrency["JOD"].glBalanceMinor).toBe(1_100_000);
    expect(recon.byCurrency["JOD"].subledgerBalanceMinor).toBe(1_100_000);
  });
});

// ─── Fix B2/B9: unrecognized prepaid amortization blocks the period close ──────

describe("Fix B2/B9 — a period with prepaid amortization due but unrecognized cannot close", () => {
  test("a schedule the cron never advanced blocks the close, and recognizing it unblocks", async () => {
    const { t, orgId, userId, asOwner, period } = await seedDealer("shortfall");
    // Prepaid paid Jan 1, 12-month term — but the monthly cron has NOT run, so
    // nothing has been recognized. The period runs Jan–Dec, so by period end a
    // full year of amortization is DUE but zero is recognized.
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });

    const before = await asOwner.query(api.accountingPeriods.closeChecklist, { orgId, periodId: period._id });
    expect(before.canClose).toBe(false);
    expect(before.prepaidRecognitionShortfallScheduleCount).toBe(1);
    expect(before.blockers.some((b: string) => /prepaid/i.test(b))).toBe(true);

    // Recognize all 12 months, then the shortfall clears and the period closes.
    const schedule = await scheduleForExpense(t, expenseId);
    for (let m = 1; m <= 12; m++) {
      await amortize(t, orgId, schedule!._id, userId, `2026-${String(m).padStart(2, "0")}`);
    }
    const after = await asOwner.query(api.accountingPeriods.closeChecklist, { orgId, periodId: period._id });
    expect(after.prepaidRecognitionShortfallScheduleCount).toBe(0);
    expect(after.blockers.some((b: string) => /prepaid/i.test(b))).toBe(false);
  });
});

// ─── Fix B3: the monthly cron dates each missed month to its own month ────────

describe("Fix B3 — catch-up recognizes each missed month in its own month, never lumped into the present", () => {
  test("a schedule behind by several months posts one dated event per month", async () => {
    const { t, orgId, asOwner } = await seedDealer("catchup");
    const now = new Date();
    // Paid in January of the current fiscal year (the seeded open period); the
    // cron has never run, so it must catch up Jan..currentMonth.
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(now.getUTCFullYear(), 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });

    // Run the real cross-org monthly cron action (uses the current wall-clock month).
    await t.action(internal.crons.triggerPrepaidExpenseAmortization, {});

    const events = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "PREPAID_EXPENSE_AMORTIZED"))
        .collect()
    );

    const elapsedMonths = Math.min(now.getUTCMonth() + 1, 12); // Jan..currentMonth inclusive
    expect(events.length).toBe(elapsedMonths);
    // Each recognition is dated to a DISTINCT calendar month (not all lumped
    // into "now"), and none is dated in the future.
    const monthKeys = events.map((e) => {
      const d = new Date(e.occurredAt);
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    });
    expect(new Set(monthKeys).size).toBe(events.length);
    expect(Math.max(...events.map((e) => e.occurredAt))).toBeLessThanOrEqual(Date.now());
  });
});

// ─── Corrections stay consistent with future recognition ──────────────────────

describe("correctSchedule — a partial correction stays consistent with future recognition", () => {
  test("a write-off that doesn't end the schedule re-bases future months off the remaining balance, not the original curve", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("correct-writeoff");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);

    // 3 months recognized the normal way: 100/month, 300 total.
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(300_000);

    // Write off 300 (minor units: 300_000) of the unrecognized remainder
    // (900_000 - 300_000 = 600_000 left), term unchanged — the schedule
    // keeps recognizing for 9 more months.
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Early cancellation, non-refundable portion",
    });

    // A naive recompute from the ORIGINAL (now-stale) curve would give
    // floor(900_000*4/12) - floor(900_000*3/12) = 300_000 - 225_000 = 75_000
    // for month 4 — wrong, because months 1-3 were already posted at the OLD
    // 100_000/month rate and can't be restated. The correct month-4 amount
    // re-derives from what's actually left: 600_000 over 9 remaining months.
    const april = await amortize(t, orgId, schedule!._id, userId, "2026-04");
    expect(april.posted).toBe(true);
    expect(april.amountMinor).toBe(66_666); // floor(600_000 / 9)
    expect(april.amountMinor).not.toBe(75_000);

    // Run every remaining month through the schedule's original 12-month
    // term; the corrected total (900) must be recognized exactly — no more,
    // no less — regardless of the rate change partway through.
    for (const m of ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }
    const finalSchedule = await scheduleForExpense(t, expenseId);
    expect(finalSchedule!.status).toBe("FULLY_AMORTIZED");
    expect(finalSchedule!.recognizedMinor).toBe(900_000);
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
    // 300_000 recognized months 1-3 (unchanged) + 300_000 write-off (its own GL
    // line, posted immediately) + 600_000 recognized months 4-12 post-correction
    // = the full original 1_200_000 net expense, just reclassified in timing.
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(1_200_000);
  });

  test("shortening the term doesn't produce a false shortfall once caught up under the new term", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("correct-shorten");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }

    // Shorten the remaining term from 12 to 6 months — a naive "due" estimate
    // recomputed from the new term as if it applied from month 1 would say
    // floor(1_200_000*4/6) = 800_000 is due by month 4, when only 600_000
    // (300_000 already posted + the correctly re-based month-4 share) can
    // legitimately exist yet — checked at month 4 specifically (not the
    // eventual final month, where both formulas converge to the same total
    // by construction and so wouldn't distinguish the bug).
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, newTermMonths: 6, reason: "Contract shortened to 6 months",
    });
    await amortize(t, orgId, schedule!._id, userId, "2026-04");

    const shortfall = await t.run((ctx) =>
      computePrepaidRecognitionShortfall(ctx, orgId, Date.UTC(2026, 3, 30, 23, 59, 59, 999))
    );
    expect(shortfall.hasShortfall).toBe(false);
  });

  test("a term correction that leaves an unrecognized remainder with no future month is rejected", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("correct-strand");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      await amortize(t, orgId, schedule!._id, userId, m);
    }

    // 3 months recognized (300 of 1200), 900 unrecognized. Shortening the
    // term to exactly 3 (== monthsRecognized) with no refund/write-off would
    // leave that 900 permanently stuck in the Prepaid Expenses asset — there
    // would be zero future months left for amortizeScheduleForMonth to ever
    // recognize it.
    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId: schedule!._id, newTermMonths: 3, reason: "Shorten to 3 months",
      })
    ).rejects.toThrow(/no future month/i);
  });
});

describe("Phase 2 — correctSchedule term cap and idempotency", () => {
  test("rejects a corrected term above the 600-month cap (matches expense creation's own cap)", async () => {
    const { t, orgId, asOwner } = await seedDealer("correct-term-cap");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId: schedule!._id, newTermMonths: 601, reason: "Extend indefinitely",
      })
    ).rejects.toThrow(/between 1 and 600/i);
  });

  test("the same idempotency key replayed twice applies the correction exactly once", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("correct-idempotent");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const first = await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 100_000, reason: "Partial write-off", idempotencyKey: "correct-key-1",
    });
    // A retry (double-click, dropped response) replaying the same key must not
    // double-book — one correction row, one GL event, the cached result returned.
    const second = await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 100_000, reason: "Partial write-off", idempotencyKey: "correct-key-1",
    });
    expect(second).toEqual(first);

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections).toHaveLength(1);

    const writeOffEvents = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", "PREPAID_EXPENSE_WRITTEN_OFF"))
        .collect()
    );
    expect(writeOffEvents).toHaveLength(1);

    const finalSchedule = await scheduleForExpense(t, expenseId);
    expect(finalSchedule!.totalMinor).toBe(1_100_000); // 1_200_000 - 100_000, once
  });

  test("a different idempotency key applies a second, independent correction", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("correct-idempotent-diff");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 100_000, reason: "First write-off", idempotencyKey: "correct-key-a",
    });
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 100_000, reason: "Second write-off", idempotencyKey: "correct-key-b",
    });

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections).toHaveLength(2);
  });
});

describe("Phase 4 — VAT-aware refunds", () => {
  test("a refund with a VAT portion posts a balanced 3-line journal: cash debit gross, Prepaid Expenses credit net, VAT_RECEIVABLE credit tax", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("vat-refund");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Prepaid rent w/ VAT", amount: 1200, taxAmount: 200, date: Date.UTC(2026, 0, 1),
      category: "RENT", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 10,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const cashBefore = await accountNetMinor(t, orgId, "CASH_ON_HAND");
    const prepaidBefore = await accountNetMinor(t, orgId, "PREPAID_EXPENSES");
    const vatBefore = await accountNetMinor(t, orgId, "VAT_RECEIVABLE");

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 300_000, refundTaxMinor: 60_000,
      refundPaymentMethod: "CASH", reference: "CN-1001", reason: "Early cancellation, partial refund",
    });

    expect(await accountNetMinor(t, orgId, "CASH_ON_HAND")).toBe(cashBefore + 360_000); // net + tax received
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(prepaidBefore - 300_000); // net released from the asset
    expect(await accountNetMinor(t, orgId, "VAT_RECEIVABLE")).toBe(vatBefore - 60_000); // VAT reclaimed

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections[0].refundTaxMinor).toBe(60_000);
    expect(corrections[0].reference).toBe("CN-1001");
  });

  test("the VAT refund cap is enforced against the expense's original taxAmount, net of prior VAT refunds", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("vat-refund-cap");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Prepaid rent w/ VAT", amount: 1200, taxAmount: 200, date: Date.UTC(2026, 0, 1),
      category: "RENT", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 10,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    // First correction uses up 150 of the 200 total input VAT on this expense.
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 100_000, refundTaxMinor: 150_000,
      refundPaymentMethod: "CASH", reason: "First partial refund",
    });

    // A second correction asking for more than the remaining 50 is rejected.
    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId: schedule!._id, refundMinor: 50_000, refundTaxMinor: 60_000,
        refundPaymentMethod: "CASH", reason: "Second partial refund",
      })
    ).rejects.toThrow(/cannot exceed the remaining refundable input VAT/i);

    // Exactly the remaining 50 succeeds.
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 50_000, refundTaxMinor: 50_000,
      refundPaymentMethod: "CASH", reason: "Second partial refund, capped",
    });

    const remainingRefundableTaxMinor = await asOwner.query(api.prepaidExpenses.getRemainingRefundableTaxMinor, {
      orgId, scheduleId: schedule!._id,
    });
    expect(remainingRefundableTaxMinor).toBe(0);
  });

  test("a VAT refund without an accompanying net refund is rejected", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("vat-refund-orphan");
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Prepaid rent w/ VAT", amount: 1200, taxAmount: 200, date: Date.UTC(2026, 0, 1),
      category: "RENT", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 10,
    });
    const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first());
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId: schedule!._id, refundTaxMinor: 50_000, reason: "VAT only, no net",
      })
    ).rejects.toThrow(/requires a net refund amount/i);
  });

  test("a refund with no VAT posts the same two-line journal as before (byte-identical zero-tax path)", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("refund-no-vat");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 300_000, refundPaymentMethod: "CASH", reason: "Refund, no VAT involved",
    });

    expect(await accountNetMinor(t, orgId, "VAT_RECEIVABLE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(1_200_000 - 100_000 - 300_000);
  });
});

describe("Phase 6 — maker-checker write-off approval", () => {
  test("a non-owner's write-off creates a PENDING request instead of applying, and the schedule is untouched", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("mc-pending");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "mc-pending-accountant");
    const result = await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Early cancellation, non-refundable",
    });
    expect(result.status).toBe("PENDING");
    expect(result.requestId).not.toBeNull();
    expect(result.correctionId).toBeNull();

    const requests = await t.run((ctx) =>
      ctx.db.query("prepaidCorrectionRequests").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("PENDING");

    // The schedule itself is untouched — no correction row, no GL posting.
    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections).toHaveLength(0);
    const unchangedSchedule = await scheduleForExpense(t, expenseId);
    expect(unchangedSchedule!.totalMinor).toBe(1_200_000);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(100_000); // only January's amortization
  });

  test("the owner's own write-off still applies directly, without a request", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("mc-owner-direct");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const result = await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Owner-approved write-off",
    });
    expect(result.status).toBe("APPLIED");
    expect(result.correctionId).not.toBeNull();

    const requests = await t.run((ctx) =>
      ctx.db.query("prepaidCorrectionRequests").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(requests).toHaveLength(0);
  });

  test("the maker cannot approve their own request", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("mc-self-approve");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "mc-self-approve-accountant");
    const result = await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Needs approval",
    });
    const requestId = result.requestId!;

    await expect(
      asAccountant.mutation(api.prepaidExpenses.approveCorrectionRequest, { orgId, requestId })
    ).rejects.toThrow(/cannot approve your own/i);

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request!.status).toBe("PENDING");
  });

  test("a different finance manager (or the owner) can approve, applying the correction and posting the GL", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("mc-approve");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "mc-approve-accountant");
    const result = await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Early cancellation",
    });
    const requestId = result.requestId!;

    const correctionId = await asOwner.mutation(api.prepaidExpenses.approveCorrectionRequest, {
      orgId, requestId, decisionNote: "Confirmed with vendor",
    });
    expect(correctionId).toBeDefined();

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request!.status).toBe("APPROVED");
    expect(request!.decidedBy).toBe(userId);

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0].writeOffMinor).toBe(300_000);

    // The GL posted the write-off — 100 (Jan amortization) + 300 (write-off) = 400.
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(400_000);
  });

  test("a request whose remainder shrank while pending is rejected cleanly at approval time", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("mc-stale");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");
    // 1_100_000 unrecognized remainder after January.

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "mc-stale-accountant");
    const result = await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 1_000_000, reason: "Large write-off",
    });
    const requestId = result.requestId!;

    // While the write-off request is still pending, the OWNER directly
    // refunds most of the remainder — shrinking what's left below the
    // pending request's own write-off amount.
    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, refundMinor: 900_000, refundPaymentMethod: "CASH", reason: "Owner refunded most of it directly",
    });

    await expect(
      asOwner.mutation(api.prepaidExpenses.approveCorrectionRequest, { orgId, requestId })
    ).rejects.toThrow(/cannot exceed the unrecognized remainder/i);

    // The stale request is still sitting PENDING — rejected cleanly (an
    // error, not a corrupted partial application), needs a human to
    // reject/resubmit it.
    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request!.status).toBe("PENDING");
  });

  test("rejecting a request applies no schedule change", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("mc-reject");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "mc-reject-accountant");
    const result = await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Needs approval",
    });
    const requestId = result.requestId!;

    await asOwner.mutation(api.prepaidExpenses.rejectCorrectionRequest, { orgId, requestId, decisionNote: "Not warranted" });

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request!.status).toBe("REJECTED");

    const unchangedSchedule = await scheduleForExpense(t, expenseId);
    expect(unchangedSchedule!.totalMinor).toBe(1_200_000);
  });

  test("listPendingCorrectionRequests only returns PENDING requests for the org, enriched with schedule/expense details", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("mc-list");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "mc-list-accountant");
    await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Needs approval",
    });

    const pending = await asOwner.query(api.prepaidExpenses.listPendingCorrectionRequests, { orgId });
    expect(pending).toHaveLength(1);
    expect(pending[0].expenseTitle).toBe("Insurance");
    expect(pending[0].currency).toBe("JOD");
    expect(pending[0].writeOffMinor).toBe(300_000);
  });
});

describe("retryAmortizationFailure — doesn't report success when still blocked", () => {
  test("a retry that can't clear the underlying blocker throws and leaves the failure unresolved", async () => {
    const { t, orgId, asOwner } = await seedDealer("retry-blocked");
    // Same "queued behind a closed period at posting time" setup as the
    // amortization gate test: an expense with no POSTED EXPENSE_POSTED event,
    // so catchUpPrepaidSchedule's source_expense_not_posted stop condition
    // fires and the retry can't actually make progress.
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
        category: "FEES", status: "PAID", isPrepaid: true, amortizationMonths: 12,
      })
    );
    const scheduleId = await t.run((ctx) =>
      ctx.db.insert("prepaidExpenseSchedules", {
        orgId, expenseId, currency: "JOD", totalMinor: 1_200_000, termMonths: 12,
        expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", startYearMonth: "2026-01",
        recognizedMinor: 0, monthsRecognized: 0, status: "ACTIVE", createdAt: Date.now(),
      })
    );
    const failureId = await t.run((ctx) =>
      ctx.db.insert("prepaidAmortizationFailures", {
        orgId, scheduleId, yearMonth: "2026-01", errorMessage: "cron hit a transient error",
        createdAt: Date.now(),
      })
    );

    await expect(
      asOwner.mutation(api.prepaidExpenses.retryAmortizationFailure, { orgId, scheduleId })
    ).rejects.toThrow(/could not clear the blocker/i);

    const failure = await t.run((ctx) => ctx.db.get(failureId));
    expect(failure?.resolvedAt).toBeUndefined();
  });
});

describe("listSchedules — pending/failed totals only count amortization, not corrections", () => {
  test("a pending refund event is not counted as pending amortization", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("pending-filter");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    // Simulate a refund whose GL posting is still queued (e.g. no open period
    // at correction time) — same outbox shape a real correction would produce.
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING", idempotencyKey: "test-pending-refund-1",
        accountingDate: Date.UTC(2026, 1, 1), actorId: userId, attempts: 0, createdAt: Date.now(),
        eventType: "PREPAID_EXPENSE_REFUNDED", sourceType: "prepaidExpenseSchedules",
        sourceId: `prepaid_refund_test`, payload: { scheduleId: schedule!._id.toString(), amountMinor: 500_000 },
      })
    );

    const schedules = await asOwner.query(api.prepaidExpenses.listSchedules, { orgId });
    const row = schedules.find((s) => s._id === schedule!._id)!;
    expect(row.pendingMinor).toBe(0); // the pending REFUND must not inflate pending amortization
    expect(row.pendingCorrectionMinor).toBe(500_000); // but it IS visible in its own bucket
  });

  test("a failed write-off event is counted as a failed correction, not failed amortization", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("failed-correction-filter");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "FAILED", idempotencyKey: "test-failed-writeoff-1",
        accountingDate: Date.UTC(2026, 1, 1), actorId: userId, attempts: 10, createdAt: Date.now(),
        eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
        sourceId: `prepaid_writeoff_test`, payload: { scheduleId: schedule!._id.toString(), amountMinor: 300_000 },
      })
    );

    const schedules = await asOwner.query(api.prepaidExpenses.listSchedules, { orgId });
    const row = schedules.find((s) => s._id === schedule!._id)!;
    expect(row.failedMinor).toBe(0);
    expect(row.failedCorrectionMinor).toBe(300_000);
  });
});

describe("Phase 3 — runAmortizationNow isolates per-schedule failures and reports blocked schedules", () => {
  test("one schedule's posting failure doesn't roll back its own progress or block the others", async () => {
    const { t, orgId, asOwner } = await seedDealer("run-now-isolation");
    const goodExpenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Good Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const goodSchedule = await scheduleForExpense(t, goodExpenseId);

    const badExpenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Broken Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const badSchedule = await scheduleForExpense(t, badExpenseId);
    // Simulates a real posting-time failure (e.g. a since-unmapped account)
    // without mocking any internals — the account resolver throws when it
    // can't find this system key in the org's chart.
    await t.run((ctx) => ctx.db.patch(badSchedule!._id, { expenseSystemKey: "NOT_A_REAL_SYSTEM_KEY" }));

    const result = await asOwner.action(api.prepaidExpenses.runAmortizationNow, { orgId });

    expect(result.posted.some((r) => r.scheduleId === goodSchedule!._id)).toBe(true);
    expect(result.failed.some((r) => r.scheduleId === badSchedule!._id)).toBe(true);

    // The good schedule caught up through the real current month despite the
    // other schedule's failure — one mutation call per schedule means no
    // atomicity crossover between them. (Elapsed months computed from wall
    // clock, same as the Fix B3 catch-up test above — the schedule starts
    // January of the current fiscal year and runAmortizationNow catches it
    // all the way up to "now".)
    const elapsedMonths = Math.min(new Date().getUTCMonth() + 1, 12);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(elapsedMonths * 100_000);

    // The failing schedule's own mutation call threw, so its progress-bump
    // rolled back too — never left half-applied.
    const finalBadSchedule = await scheduleForExpense(t, badExpenseId);
    expect(finalBadSchedule!.recognizedMinor).toBe(0);

    // A durable failure record exists for the accountant to see/retry.
    const failures = await t.run((ctx) =>
      ctx.db.query("prepaidAmortizationFailures").withIndex("by_schedule", (q) => q.eq("scheduleId", badSchedule!._id)).collect()
    );
    expect(failures.filter((f) => f.resolvedAt === undefined)).toHaveLength(1);
  });

  test("a schedule blocked on its source expense is reported in `blocked`, not silently swallowed", async () => {
    const { t, orgId, asOwner } = await seedDealer("run-now-blocked");
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
        category: "FEES", status: "PAID", isPrepaid: true, amortizationMonths: 12,
      })
    );
    const scheduleId = await t.run((ctx) =>
      ctx.db.insert("prepaidExpenseSchedules", {
        orgId, expenseId, currency: "JOD", totalMinor: 1_200_000, termMonths: 12,
        expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", startYearMonth: "2026-01",
        recognizedMinor: 0, monthsRecognized: 0, status: "ACTIVE", createdAt: Date.now(),
      })
    );

    const result = await asOwner.action(api.prepaidExpenses.runAmortizationNow, { orgId });

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].scheduleId).toBe(scheduleId);
    expect(result.blocked[0].reason).toBe("source_expense_not_posted");
    expect(result.failed).toHaveLength(0);
  });
});

describe("Phase 3 — redriveScheduleEvents", () => {
  test("redrives only the target schedule's own queued/dead-lettered rows, resetting a dead-lettered row's attempts", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("redrive-scoped");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    // A different schedule's own stuck row must be left untouched.
    const otherExpenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Other Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const otherSchedule = await scheduleForExpense(t, otherExpenseId);
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "FAILED", idempotencyKey: "other-schedule-stuck",
        accountingDate: Date.UTC(2026, 1, 1), actorId: userId, attempts: 10, createdAt: Date.now(),
        eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules", currency: "JOD",
        sourceId: `prepaid_amort_${otherSchedule!._id}_2026-02`,
        payload: {
          scheduleId: otherSchedule!._id.toString(), amountMinor: 100_000, currency: "JOD",
          expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", yearMonth: "2026-02",
        },
      })
    );

    // The target schedule's own dead-lettered row — attempts already at the
    // retry ceiling, simulating a since-resolved blocker (e.g. the chart was
    // missing an account that's since been mapped).
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "FAILED", idempotencyKey: `prepaid_amort_${schedule!._id}_2026-02`,
        accountingDate: Date.UTC(2026, 1, 1), actorId: userId, attempts: 10, createdAt: Date.now(),
        eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules", currency: "JOD",
        sourceId: `prepaid_amort_${schedule!._id}_2026-02`,
        payload: {
          scheduleId: schedule!._id.toString(), amountMinor: 100_000, currency: "JOD",
          expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", yearMonth: "2026-02",
        },
      })
    );

    const result = await asOwner.mutation(api.prepaidExpenses.redriveScheduleEvents, {
      orgId, scheduleId: schedule!._id,
    });
    expect(result.posted).toBe(1);
    expect(result.failed).toBe(0);

    const targetRow = await t.run((ctx) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", `prepaid_amort_${schedule!._id}_2026-02`))
        .unique()
    );
    expect(targetRow!.status).toBe("POSTED");

    // The OTHER schedule's stuck row is untouched — still FAILED, attempts unchanged.
    const otherRow = await t.run((ctx) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", "other-schedule-stuck"))
        .unique()
    );
    expect(otherRow!.status).toBe("FAILED");
    expect(otherRow!.attempts).toBe(10);
  });

  test("nothing queued for a clean schedule redrives zero rows", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("redrive-clean");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const result = await asOwner.mutation(api.prepaidExpenses.redriveScheduleEvents, {
      orgId, scheduleId: schedule!._id,
    });
    expect(result).toEqual({ posted: 0, failed: 0, held: 0 });
  });
});

// ─── Fix #4: chart self-heal code-collision safety ────────────────────────────

describe("Fix #4 — chart self-heal never duplicates or hijacks a code", () => {
  test("an incompatible custom account on the reserved code blocks the posting with a clear error", async () => {
    const { t, orgId, asOwner } = await seedDealer("conflict");
    // Simulate a legacy chart: no PREPAID_EXPENSES mapping, and code 1450 taken
    // by an unrelated EXPENSE-type custom account.
    await t.run(async (ctx) => {
      const mapped = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "PREPAID_EXPENSES")).unique();
      if (mapped) await ctx.db.delete(mapped._id);
      const owner = (await ctx.db.query("users").first())!;
      await ctx.db.insert("chartOfAccounts", {
        orgId, code: "1450", name: "My custom expense", type: "EXPENSE", normalBalance: "DEBIT",
        isControlAccount: false, allowManualPosting: true, active: true,
        createdAt: Date.now(), createdBy: owner._id, updatedAt: Date.now(), updatedBy: owner._id,
      });
    });

    await expect(
      asOwner.mutation(api.expenses.create, {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
        category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
      })
    ).rejects.toThrow(/conflict/i);
  });

  test("a compatible unmapped account on the reserved code parks an adoption request instead of silently adopting (Fix #10)", async () => {
    const { t, orgId, asOwner } = await seedDealer("adopt");
    await t.run(async (ctx) => {
      const mapped = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "PREPAID_EXPENSES")).unique();
      if (mapped) await ctx.db.delete(mapped._id);
      const owner = (await ctx.db.query("users").first())!;
      // Hand-made account that is manually-postable and NOT flagged a control
      // account — the opposite of the DEFAULT_CHART PREPAID_EXPENSES shape.
      await ctx.db.insert("chartOfAccounts", {
        orgId, code: "1450", name: "Prepaids (hand-made)", type: "ASSET", normalBalance: "DEBIT",
        isControlAccount: false, allowManualPosting: true, active: true,
        createdAt: Date.now(), createdBy: owner._id, updatedAt: Date.now(), updatedBy: owner._id,
      });
    });

    // Silently adopting a shape-compatible account used to happen inline —
    // now it's an explicit decision: posting is blocked with a clear pointer
    // to Chart of Accounts > Resolve Conflicts until an owner/finance user
    // resolves the parked request (confirmSystemAccountAdoption).
    await expect(
      asOwner.mutation(api.expenses.create, {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
        category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
      })
    ).rejects.toThrow(/explicit mapping decision/i);

    const conflicts = await asOwner.query(api.chartOfAccounts.listSystemAccountAdoptionRequests, { orgId });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].systemKey).toBe("PREPAID_EXPENSES");
    expect(conflicts[0].code).toBe("1450");

    await asOwner.mutation(api.chartOfAccounts.confirmSystemAccountAdoption, {
      orgId, systemKey: "PREPAID_EXPENSES", decision: "ADOPT",
    });

    // Once resolved, the same posting succeeds and reuses the adopted account.
    await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });

    const on1450 = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_code", (q) => q.eq("orgId", orgId).eq("code", "1450")).collect()
    );
    expect(on1450).toHaveLength(1); // adopted, not duplicated
    expect(on1450[0].systemKey).toBe("PREPAID_EXPENSES");
    // Adopting the account normalizes it to the DEFAULT_CHART posting-safety
    // shape: a control account that blocks manual posting — otherwise the system
    // Prepaid Expenses account would remain manually-postable.
    expect(on1450[0].isControlAccount).toBe(true);
    expect(on1450[0].allowManualPosting).toBe(false);
    expect(on1450[0].name).toBe("Prepaids (hand-made)"); // user-chosen name kept
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(1_200_000);

    // Resolved: the conflict no longer appears (the account is now mapped).
    const conflictsAfter = await asOwner.query(api.chartOfAccounts.listSystemAccountAdoptionRequests, { orgId });
    expect(conflictsAfter).toHaveLength(0);
  });
});

// ─── Fix #1: current-state reconciliations are warnings, not blockers ─────────

describe("Fix #1 — a current-state subledger discrepancy warns but does not block close", () => {
  test("an in-stock vehicle with no acquisition GL posting is a warning; the period can still close", async () => {
    const { t, orgId, asOwner, period } = await seedDealer("warn");
    // Vehicle physically in stock with a cost (subledger) but no VEHICLE_ACQUIRED
    // GL event — Vehicle Inventory subledger ≠ GL as of "now".
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "WARNONLY000000001", make: "Toyota", model: "Camry", year: 2020,
        mileage: 100, color: "White", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE", sourceType: "STOCK",
      })
    );

    const checklist = await asOwner.query(api.accountingPeriods.closeChecklist, { orgId, periodId: period._id });
    expect(checklist.canClose).toBe(true);
    expect(checklist.blockers.some((b: string) => /Vehicle Inventory/i.test(b))).toBe(false);
    expect(checklist.warnings.some((w: string) => /Vehicle Inventory/i.test(w))).toBe(true);

    // And the close actually succeeds without an override, once every warning
    // is acknowledged (the review dialog is the only realistic caller — see
    // ClosePeriodReviewDialog.tsx — but the backend re-validates independently).
    await asOwner.mutation(api.accountingPeriods.close, {
      orgId, periodId: period._id, acknowledgedWarnings: checklist.warnings,
    });
    const closed = await asOwner.query(api.accountingPeriods.get, { orgId, periodId: period._id });
    expect(closed!.status).toBe("CLOSED");
  });
});

// ─── Fix #3: inactive accounts rejected for manual posting ────────────────────

describe("Fix #3 — inactive accounts cannot be posted to", () => {
  test("a manual journal to a deactivated custom account is rejected", async () => {
    const { orgId, asOwner } = await seedDealer("inactive");
    // A custom account that allows manual posting, then deactivated.
    const acctId = await asOwner.mutation(api.chartOfAccounts.create, {
      orgId, code: "6999", name: "Misc custom", type: "EXPENSE", normalBalance: "DEBIT", allowManualPosting: true,
    });
    await asOwner.mutation(api.chartOfAccounts.update, { orgId, accountId: acctId, active: false });

    // Cash doesn't allow manual posting, so use another manual-postable account
    // for the balancing side: General Expenses (6300).
    const genExp = await asOwner.query(api.chartOfAccounts.list, { orgId }).then((rows: any[]) =>
      rows.find((a) => a.systemKey === "GENERAL_EXPENSE")
    );

    await expect(
      asOwner.mutation(api.financialAudit.createManualJournal, {
        orgId, memo: "test", idempotencyKey: "mj-inactive-1",
        lines: [
          { accountId: acctId, debitMinor: 1000, creditMinor: 0 },
          { accountId: genExp._id, debitMinor: 0, creditMinor: 1000 },
        ],
      })
    ).rejects.toThrow(/inactive/i);
  });
});

// A refund or write-off is a pure CREDIT to the Prepaid Expenses asset (a
// refund also credits input VAT). If the EXPENSE_POSTED that should have
// debited that asset is still queued — which happens whenever the expense is
// dated in a month that never got an open period, since postability is judged
// per event date — the correction posts a credit against a balance that was
// never booked, leaving Prepaid Expenses (and input VAT) negative with no
// offsetting debit. amortizeScheduleForMonth has always refused to recognize in
// this state ("source_expense_not_posted"); corrections never had the same
// guard. The queued original does block the period close, but an unclosable
// period plus a nonsensical balance sheet is not a correct entry.
describe("prepaid corrections — refuse to post against an unbooked asset", () => {
  /** A paid prepaid expense whose EXPENSE_POSTED never posted, plus its ACTIVE schedule. */
  async function seedQueuedPrepaid(t: T, orgId: Id<"organizations">) {
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, title: "Insurance", amount: 1200, taxAmount: 200, date: Date.UTC(2026, 0, 1),
        category: "FEES", status: "PAID", isPrepaid: true, amortizationMonths: 12,
      })
    );
    const scheduleId = await t.run((ctx) =>
      ctx.db.insert("prepaidExpenseSchedules", {
        orgId, expenseId, currency: "JOD", totalMinor: 1_000_000, termMonths: 12,
        expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", startYearMonth: "2026-01",
        recognizedMinor: 0, monthsRecognized: 0, status: "ACTIVE", createdAt: Date.now(),
      })
    );
    return { expenseId, scheduleId };
  }

  const NOT_POSTED = /hasn't posted to the ledger yet/i;

  test("rejects a write-off while the source expense is still queued", async () => {
    const { t, orgId, asOwner } = await seedDealer("guard-wo");
    const { scheduleId } = await seedQueuedPrepaid(t, orgId);

    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId, writeOffMinor: 300_000, reason: "Early cancellation",
      })
    ).rejects.toThrow(NOT_POSTED);

    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
  });

  test("rejects a refund while the source expense is still queued", async () => {
    const { t, orgId, asOwner } = await seedDealer("guard-rf");
    const { scheduleId } = await seedQueuedPrepaid(t, orgId);

    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId, refundMinor: 300_000, refundPaymentMethod: "BANK_TRANSFER",
        reason: "Policy cancelled, vendor refunded",
      })
    ).rejects.toThrow(NOT_POSTED);

    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
  });

  test("rejects a VAT-bearing refund while the source expense is still queued", async () => {
    // The refund's VAT leg credits input VAT that the queued EXPENSE_POSTED
    // never debited, so it must be refused for the same reason as the net leg.
    const { t, orgId, asOwner } = await seedDealer("guard-vat");
    const { scheduleId } = await seedQueuedPrepaid(t, orgId);

    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId, refundMinor: 300_000, refundTaxMinor: 60_000,
        refundPaymentMethod: "BANK_TRANSFER", reason: "Partial refund with VAT",
      })
    ).rejects.toThrow(NOT_POSTED);

    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
  });

  test("writes no correction row and leaves the schedule untouched when refused", async () => {
    const { t, orgId, asOwner } = await seedDealer("guard-atomic");
    const { scheduleId } = await seedQueuedPrepaid(t, orgId);
    const before = await t.run((ctx) => ctx.db.get(scheduleId));

    await expect(
      asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId, writeOffMinor: 300_000, newTermMonths: 6, reason: "Early cancellation",
      })
    ).rejects.toThrow(NOT_POSTED);

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId)).collect()
    );
    expect(corrections).toHaveLength(0);
    const after = await t.run((ctx) => ctx.db.get(scheduleId));
    expect(after!.totalMinor).toBe(before!.totalMinor);
    expect(after!.termMonths).toBe(before!.termMonths);
    expect(after!.status).toBe("ACTIVE");
  });

  test("refuses at submission, so a request is never even queued for approval", async () => {
    const { t, orgId } = await seedDealer("guard-submit");
    const { scheduleId } = await seedQueuedPrepaid(t, orgId);
    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "guard-submit-accountant");

    await expect(
      asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId, writeOffMinor: 300_000, reason: "Early cancellation",
      })
    ).rejects.toThrow(NOT_POSTED);

    const requests = await t.run((ctx) =>
      ctx.db.query("prepaidCorrectionRequests").withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId)).collect()
    );
    expect(requests).toHaveLength(0);
  });

  test("re-checks at approval: a request approved after the source un-posts is refused", async () => {
    // The submission-time check can't be the only one — an approval can land
    // long after the request, and the ledger may have moved underneath it.
    const { t, orgId, userId, asOwner } = await seedDealer("guard-approve");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "guard-approve-accountant");
    const submitted = await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Early cancellation",
    });
    expect(submitted.status).toBe("PENDING");

    // The source EXPENSE_POSTED stops being POSTED between request and approval
    // (e.g. the expense itself was reversed in the meantime).
    const posted = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first()
    );
    await t.run((ctx) => ctx.db.patch(posted!._id, { status: "REVERSED" }));

    await expect(
      asOwner.mutation(api.prepaidExpenses.approveCorrectionRequest, {
        orgId, requestId: submitted.requestId!,
      })
    ).rejects.toThrow(NOT_POSTED);

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections).toHaveLength(0);
  });

  test("allows a term-only correction while the source expense is queued", async () => {
    // Reshaping future recognition posts nothing, so there's no unbooked asset
    // to credit and no reason to block the accountant.
    const { t, orgId, asOwner } = await seedDealer("guard-term");
    const { scheduleId } = await seedQueuedPrepaid(t, orgId);

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId, newTermMonths: 6, reason: "Corrected coverage period",
    });

    const after = await t.run((ctx) => ctx.db.get(scheduleId));
    expect(after!.termMonths).toBe(6);
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
  });

  test("allows the correction once the source expense has actually posted", async () => {
    const { t, orgId, userId, asOwner } = await seedDealer("guard-ok");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Early cancellation",
    });

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0].writeOffMinor).toBe(300_000);
  });
});

// "Posted" is not the same as "posted by now". EXPENSE_POSTED is dated from the
// expense's own `date` field, a correction books at wall-clock now, and nothing
// rejects a future-dated expense (validations/expenses.ts types date as a plain
// z.number()). So a prepayment dated in December, entered in July into an open
// annual period, is genuinely POSTED while its debit sits months ahead of a
// refund booked today — crediting Prepaid Expenses now leaves the asset negative
// until December, when the debit finally lands.
describe("prepaid corrections — refuse to post ahead of the original entry", () => {
  const JUL = Date.UTC(2026, 6, 15);
  const DEC = Date.UTC(2026, 11, 1);
  const NOT_YET = /recognized in the ledger on a later date/i;

  /** A prepaid expense dated in December but entered (and posted) in July. */
  async function seedFutureDatedPrepaid(t: T, orgId: Id<"organizations">, asOwner: Awaited<ReturnType<typeof seedDealer>>["asOwner"]) {
    const clock = vi.spyOn(Date, "now").mockReturnValue(JUL);
    try {
      const expenseId = await asOwner.mutation(api.expenses.create, {
        orgId, title: "Insurance (starts December)", amount: 1200, date: DEC,
        category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
      });
      const schedule = await scheduleForExpense(t, expenseId);
      return { expenseId, scheduleId: schedule!._id };
    } finally {
      clock.mockRestore();
    }
  }

  test("the future-dated expense really does post, dated in the future", async () => {
    // Guards the premise: if this ever stops posting, the tests below would pass
    // for the wrong reason (caught by the not-posted branch instead).
    const { t, orgId, asOwner } = await seedDealer("date-premise");
    const { expenseId } = await seedFutureDatedPrepaid(t, orgId, asOwner);

    const posted = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first()
    );
    expect(posted?.status).toBe("POSTED");
    expect(posted?.accountingDate).toBe(DEC);
  });

  test("rejects a refund dated before the original entry", async () => {
    const { t, orgId, asOwner } = await seedDealer("date-rf");
    const { scheduleId } = await seedFutureDatedPrepaid(t, orgId, asOwner);

    const clock = vi.spyOn(Date, "now").mockReturnValue(JUL);
    try {
      await expect(
        asOwner.mutation(api.prepaidExpenses.correctSchedule, {
          orgId, scheduleId, refundMinor: 300_000, refundPaymentMethod: "BANK_TRANSFER",
          reason: "Vendor refunded early",
        })
      ).rejects.toThrow(NOT_YET);
    } finally {
      clock.mockRestore();
    }

    // The original December debit stands; no refund credit was applied on top.
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(1_200_000);
  });

  test("rejects a write-off dated before the original entry", async () => {
    const { t, orgId, asOwner } = await seedDealer("date-wo");
    const { scheduleId } = await seedFutureDatedPrepaid(t, orgId, asOwner);

    const clock = vi.spyOn(Date, "now").mockReturnValue(JUL);
    try {
      await expect(
        asOwner.mutation(api.prepaidExpenses.correctSchedule, {
          orgId, scheduleId, writeOffMinor: 300_000, reason: "Cancelled before it started",
        })
      ).rejects.toThrow(NOT_YET);
    } finally {
      clock.mockRestore();
    }

    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(1_200_000);
  });

  test("allows a term-only correction on a future-dated expense", async () => {
    // Posts nothing, so there is no ordering to get wrong.
    const { t, orgId, asOwner } = await seedDealer("date-term");
    const { scheduleId } = await seedFutureDatedPrepaid(t, orgId, asOwner);

    const clock = vi.spyOn(Date, "now").mockReturnValue(JUL);
    try {
      await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId, newTermMonths: 6, reason: "Corrected coverage period",
      });
    } finally {
      clock.mockRestore();
    }

    const after = await t.run((ctx) => ctx.db.get(scheduleId));
    expect(after!.termMonths).toBe(6);
  });

  test("allows the refund once the original entry's date has been reached", async () => {
    const { t, orgId, asOwner } = await seedDealer("date-ok");
    const { scheduleId } = await seedFutureDatedPrepaid(t, orgId, asOwner);

    // Same correction, now booked after December rather than before it.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 11, 20));
    try {
      await asOwner.mutation(api.prepaidExpenses.correctSchedule, {
        orgId, scheduleId, refundMinor: 300_000, refundPaymentMethod: "BANK_TRANSFER",
        reason: "Vendor refunded",
      });
    } finally {
      clock.mockRestore();
    }

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId)).collect()
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0].refundMinor).toBe(300_000);
  });

  test("re-checks ordering at approval, not just at submission", async () => {
    // Submitted while the original was already posted and in the past, then the
    // schedule is re-pointed at a future-dated expense before approval. The
    // approval must vet the ordering itself rather than trust the request.
    const { t, orgId, userId, asOwner } = await seedDealer("date-approve");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await amortize(t, orgId, schedule!._id, userId, "2026-01");

    const { asUser: asAccountant } = await addFinanceUser(t, orgId, "date-approve-accountant");
    const submitted = await asAccountant.mutation(api.prepaidExpenses.correctSchedule, {
      orgId, scheduleId: schedule!._id, writeOffMinor: 300_000, reason: "Early cancellation",
    });
    expect(submitted.status).toBe("PENDING");

    // The original entry's date moves ahead of the approval.
    const posted = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first()
    );
    await t.run((ctx) => ctx.db.patch(posted!._id, { accountingDate: Date.UTC(2027, 5, 1) }));

    await expect(
      asOwner.mutation(api.prepaidExpenses.approveCorrectionRequest, {
        orgId, requestId: submitted.requestId!,
      })
    ).rejects.toThrow(NOT_YET);

    const corrections = await t.run((ctx) =>
      ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule!._id)).collect()
    );
    expect(corrections).toHaveLength(0);
  });
});

// The mutation guard can only vet what it is asked to do now. It cannot see a
// correction queued before it existed, still sitting in the outbox. Those post
// through the drain — whose trigger is "a period covering THIS entry's date
// opened", which says nothing about whether the source expense's own month is
// postable. So without a guard at the posting boundary, opening a period is
// enough to recreate the exact negative-asset state the mutation guard exists
// to prevent, with no operator action and nothing to click.
describe("prepaid corrections — the outbox refuses to post them against an unbooked asset", () => {
  /**
   * The pre-guard shape: an expense dated in a month that never opens (so its
   * EXPENSE_POSTED can never drain) whose write-off was queued anyway, dated in
   * a month that IS about to open.
   */
  async function seedLegacyQueuedCorrection(t: T, orgId: Id<"organizations">, userId: Id<"users">) {
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2025, 11, 15),
        category: "FEES", status: "PAID", isPrepaid: true, amortizationMonths: 12,
      })
    );
    const scheduleId = await t.run((ctx) =>
      ctx.db.insert("prepaidExpenseSchedules", {
        orgId, expenseId, currency: "JOD", totalMinor: 1_200_000, termMonths: 12,
        expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", startYearMonth: "2025-12",
        recognizedMinor: 0, monthsRecognized: 0, status: "ACTIVE", createdAt: Date.now(),
      })
    );
    // The asset debit, permanently queued: 2025 has no period in this org.
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING", attempts: 0,
        idempotencyKey: `expense_posted_${expenseId}`,
        eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
        eventVersion: 1, accountingDate: Date.UTC(2025, 11, 15), occurredAt: Date.UTC(2025, 11, 15),
        currency: "JOD", actorId: userId, createdAt: Date.now(),
        reason: "No chart of accounts or open period at operation time",
        payload: { expenseId: expenseId.toString(), amountMinor: 1_200_000, currency: "JOD", isPrepaid: true },
      })
    );
    // The write-off, queued before the guard existed, dated inside 2026.
    const writeOffId = await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING", attempts: 0,
        idempotencyKey: `prepaid_written_off_${scheduleId}_c1`,
        eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
        sourceId: `${scheduleId}_c1`, eventVersion: 1,
        accountingDate: Date.UTC(2026, 2, 20), occurredAt: Date.UTC(2026, 2, 20),
        currency: "JOD", actorId: userId, createdAt: Date.now(),
        reason: "No chart of accounts or open period at operation time",
        payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000, currency: "JOD", expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE" },
      })
    );
    return { expenseId, scheduleId, writeOffId };
  }

  test("an org-wide drain holds a legacy queued write-off instead of posting it", async () => {
    const { t, orgId, userId } = await seedDealer("drain-legacy");
    const { writeOffId } = await seedLegacyQueuedCorrection(t, orgId, userId);

    const result = await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    expect(result.held).toBe(1);
    expect(result.posted).toBe(0);
    // Prepaid Expenses is untouched: no credit without its debit.
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(0);
  });

  test("a held entry stays PENDING and burns no retry attempts", async () => {
    // Held is not failed. It is waiting on someone else's blocker, so counting
    // attempts would dead-letter a perfectly valid entry for no fault of its own.
    const { t, orgId, userId } = await seedDealer("drain-held-state");
    const { writeOffId } = await seedLegacyQueuedCorrection(t, orgId, userId);

    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    const row = await t.run((ctx) => ctx.db.get(writeOffId));
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
    // …and it says why, so it isn't a silent refusal on the pending list.
    expect(row!.lastError).toMatch(/has not posted to the ledger yet/i);
  });

  test("the same entry posts by itself once its source debit posts", async () => {
    // The hold must be a wait, not a dead end.
    const { t, orgId, userId } = await seedDealer("drain-unblocks");
    const { expenseId, scheduleId } = await seedLegacyQueuedCorrection(t, orgId, userId);

    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);

    // The source expense's own month finally posts.
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
        eventVersion: 1, idempotencyKey: `expense_posted_${expenseId}_manual`,
        occurredAt: Date.UTC(2025, 11, 15), accountingDate: Date.UTC(2025, 11, 15),
        currency: "JOD", payload: { expenseId: expenseId.toString() }, payloadHash: "t",
        status: "POSTED", createdBy: userId, createdAt: Date.now(),
      })
    );

    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    // Now the credit lands, with its debit already in place.
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(300_000);
  });

  test("a queued correction dated before its posted source is held too", async () => {
    // The ordering half of the same invariant, at the posting boundary.
    const { t, orgId, userId } = await seedDealer("drain-ordering");
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 11, 1),
        category: "FEES", status: "PAID", isPrepaid: true, amortizationMonths: 12,
      })
    );
    const scheduleId = await t.run((ctx) =>
      ctx.db.insert("prepaidExpenseSchedules", {
        orgId, expenseId, currency: "JOD", totalMinor: 1_200_000, termMonths: 12,
        expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", startYearMonth: "2026-12",
        recognizedMinor: 0, monthsRecognized: 0, status: "ACTIVE", createdAt: Date.now(),
      })
    );
    // Source posted, but dated December.
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
        eventVersion: 1, idempotencyKey: `expense_posted_${expenseId}`,
        occurredAt: Date.UTC(2026, 11, 1), accountingDate: Date.UTC(2026, 11, 1),
        currency: "JOD", payload: { expenseId: expenseId.toString() }, payloadHash: "t",
        status: "POSTED", createdBy: userId, createdAt: Date.now(),
      })
    );
    // Refund queued for July — five months before the debit it credits.
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING", attempts: 0,
        idempotencyKey: `prepaid_refunded_${scheduleId}_c1`,
        eventType: "PREPAID_EXPENSE_REFUNDED", sourceType: "prepaidExpenseSchedules",
        sourceId: `${scheduleId}_c1`, eventVersion: 1,
        accountingDate: Date.UTC(2026, 6, 15), occurredAt: Date.UTC(2026, 6, 15),
        currency: "JOD", actorId: userId, createdAt: Date.now(),
        reason: "No chart of accounts or open period at operation time",
        payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000, currency: "JOD", paymentMethod: "BANK_TRANSFER" },
      })
    );

    const result = await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    expect(result.held).toBe(1);
    expect(await accountNetMinor(t, orgId, "PREPAID_EXPENSES")).toBe(0);
  });

  test("a healthy queued correction still drains normally", async () => {
    // The guard must not become a blanket refusal to post corrections.
    const { t, orgId, userId, asOwner } = await seedDealer("drain-healthy");
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 0, 1),
      category: "FEES", status: "PAID", paymentMethod: "CASH", isPrepaid: true, amortizationMonths: 12,
    });
    const schedule = await scheduleForExpense(t, expenseId);
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING", attempts: 0,
        idempotencyKey: `prepaid_written_off_${schedule!._id}_c1`,
        eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
        sourceId: `${schedule!._id}_c1`, eventVersion: 1,
        accountingDate: Date.UTC(2026, 2, 20), occurredAt: Date.UTC(2026, 2, 20),
        currency: "JOD", actorId: userId, createdAt: Date.now(),
        reason: "queued",
        payload: { scheduleId: schedule!._id.toString(), amountMinor: 300_000, currency: "JOD", expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE" },
      })
    );

    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    // End state, not the drain's counters: opening a period schedules its own
    // background drain, so which call actually posts the row is a race. What
    // must hold either way is that it posted and hit the P&L.
    const row = await t.run((ctx) =>
      ctx.db.query("pendingAccountingEvents").filter((q) => q.eq(q.field("orgId"), orgId)).first()
    );
    expect(row!.status).toBe("POSTED");
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(300_000);
  });

  test("the schedule redrive button posts the source debit, not just the credits", async () => {
    // The debit is sourceType "expenses", so a schedule-scoped sweep filtering
    // on sourceType alone could never reach it — the button would hold every
    // row and report doing nothing on the schedule it was meant to unblock.
    const { t, orgId, userId, asOwner } = await seedDealer("redrive-source");
    const { scheduleId } = await seedLegacyQueuedCorrection(t, orgId, userId);
    // Give 2025 a period so the source debit is postable once it's included.
    await asOwner.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(2025, 0, 1), endDate: Date.UTC(2025, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2025, periodNumber: 2,
    });
    const periods = await asOwner.query(api.accountingPeriods.list, { orgId });
    const p2025 = periods.find((p) => p.fiscalYear === 2025)!;
    await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: p2025._id });

    await asOwner.mutation(api.prepaidExpenses.redriveScheduleEvents, { orgId, scheduleId });

    // Both rows go: the debit first, then the write-off that depends on it.
    // Asserted as end state — opening the 2025 period above schedules its own
    // drain, so which call posts them is a race; that they BOTH post is not.
    const rows = await t.run((ctx) =>
      ctx.db.query("pendingAccountingEvents").filter((q) => q.eq(q.field("orgId"), orgId)).collect()
    );
    expect(rows.every((r) => r.status === "POSTED")).toBe(true);
    expect(await accountNetMinor(t, orgId, "PROFESSIONAL_FEES_EXPENSE")).toBe(300_000);
  });
});
