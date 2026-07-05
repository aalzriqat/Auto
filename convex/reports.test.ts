import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_r1", email: "r@test.com", name: "Reports User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:reports"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_r1" });
  return { t, orgId, asUser };
}

describe("getExpensesReport — prepaid amortization", () => {
  test("a non-prepaid expense is recognized fully in the month it was paid", async () => {
    const { t, orgId, asUser } = await setup();
    const paidAt = Date.UTC(2026, 2, 10); // 2026-03-10
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId,
        title: "Office supplies",
        amount: 120,
        date: paidAt,
        category: "OFFICE",
      })
    );

    const report = await asUser.query(api.reports.getExpensesReport, {
      orgId,
      startDate: Date.UTC(2026, 2, 1),
      endDate: Date.UTC(2026, 2, 31),
    });

    expect(report.totalExpenses).toBe(120);
    expect(report.expenses[0].recognizedAmount).toBe(120);
    expect(report.expenses[0].amortization).toBeNull();
  });

  test("a 6-month prepaid rent expense is spread 1/6th per month instead of booked in full", async () => {
    const { t, orgId, asUser } = await setup();
    // Paid on 2026-01-15 for Jan–Jun (6 months), 6000 total -> 1000/month.
    const paidAt = Date.UTC(2026, 0, 15);
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId,
        title: "6-month rent prepayment",
        amount: 6000,
        date: paidAt,
        category: "PREPAID",
        isPrepaid: true,
        amortizationMonths: 6,
      })
    );

    // Pulling the P&L for March (month 3 of 6) should show only 1000, not 6000 —
    // even though the expense was paid back in January, well before this window.
    const marchReport = await asUser.query(api.reports.getExpensesReport, {
      orgId,
      startDate: Date.UTC(2026, 2, 1),
      endDate: Date.UTC(2026, 2, 31),
    });
    expect(marchReport.totalExpenses).toBe(1000);
    expect(marchReport.expenses).toHaveLength(1);
    expect(marchReport.expenses[0].recognizedAmount).toBe(1000);
    expect(marchReport.expenses[0].amortization).toMatchObject({
      monthlyAmount: 1000,
      monthsElapsed: 3,
      amortizationMonths: 6,
      recognizedToDateAmount: 3000,
      remainingAmount: 3000,
    });

    // The month it was actually paid (January) should also show only its
    // own 1/6th share, not the full 6000 lump sum.
    const januaryReport = await asUser.query(api.reports.getExpensesReport, {
      orgId,
      startDate: Date.UTC(2026, 0, 1),
      endDate: Date.UTC(2026, 0, 31),
    });
    expect(januaryReport.totalExpenses).toBe(1000);

    // A window spanning all 6 months should recognize the full amount exactly once.
    const fullYearReport = await asUser.query(api.reports.getExpensesReport, {
      orgId,
      startDate: Date.UTC(2026, 0, 1),
      endDate: Date.UTC(2026, 5, 30),
    });
    expect(fullYearReport.totalExpenses).toBe(6000);

    // A report pulled after the amortization window closes shows no more recognition.
    const laterReport = await asUser.query(api.reports.getExpensesReport, {
      orgId,
      startDate: Date.UTC(2026, 6, 1),
      endDate: Date.UTC(2026, 6, 31),
    });
    expect(laterReport.totalExpenses).toBe(0);
    expect(laterReport.expenses).toHaveLength(0);
  });

  test("soft-deleted expenses are excluded from the report", async () => {
    const { t, orgId, asUser } = await setup();
    const paidAt = Date.UTC(2026, 3, 5);
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId,
        title: "Deleted expense",
        amount: 500,
        date: paidAt,
        category: "OTHER",
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: "someone",
      })
    );

    const report = await asUser.query(api.reports.getExpensesReport, {
      orgId,
      startDate: Date.UTC(2026, 3, 1),
      endDate: Date.UTC(2026, 3, 30),
    });
    expect(report.totalExpenses).toBe(0);
    expect(report.expenses).toHaveLength(0);
  });
});
