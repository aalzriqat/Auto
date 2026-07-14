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

  test("a compatible unmapped account on the reserved code is adopted, not duplicated, and its posting-safety flags are normalized (Fix #10)", async () => {
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

    // And the close actually succeeds without an override.
    await asOwner.mutation(api.accountingPeriods.close, { orgId, periodId: period._id });
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
