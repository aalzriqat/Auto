import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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

describe("getInventoryReport — investment valuation", () => {
  test("landed costs add to the purchase price instead of replacing it", async () => {
    const { t, orgId, asUser } = await setup();

    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN-LANDED-1",
        make: "Toyota",
        model: "Corolla",
        year: 2022,
        mileage: 30_000,
        color: "Silver",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 24_000,
        purchasePrice: 20_000,
        landedCostTotal: 500, // shipping + customs, additive to purchasePrice
        status: "AVAILABLE",
      })
    );

    const report = await asUser.query(api.reports.getInventoryReport, { orgId });

    // 20,000 purchase + 500 landed. Reading landedCostTotal as a fallback for
    // purchasePrice reported 500 and silently dropped the whole 20,000.
    expect(report.totalValue).toBe(20_500);
    expect(report.vehicles[0].totalInvestment).toBe(20_500);
  });

  test("deleted and reversed expenses are excluded from inventory investment", async () => {
    const { t, orgId, asUser } = await setup();

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN-LANDED-2",
        make: "Kia",
        model: "Rio",
        year: 2021,
        mileage: 40_000,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 12_000,
        purchasePrice: 10_000,
        status: "AVAILABLE",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, vehicleId, title: "Deleted repair", amount: 900,
        date: Date.now(), category: "REPAIR", isDeleted: true,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, vehicleId, title: "Reversed repair", amount: 700,
        date: Date.now(), category: "REPAIR", reversedAt: Date.now(),
      })
    );

    const report = await asUser.query(api.reports.getInventoryReport, { orgId });

    expect(report.vehicles[0].totalExpenses).toBe(0);
    expect(report.totalValue).toBe(10_000);
    // The point of this test is the investment figure, which is what feeds
    // margin — asserting only totalExpenses left the capitalized-cost path
    // itself unchecked. 10,000 purchase and nothing else: both the deleted and
    // the reversed expense must be absent, not merely absent from totalExpenses.
    expect(report.vehicles[0].totalInvestment).toBe(10_000);
  });
});

describe("reports range guard", () => {
  test("rejects a range longer than the interactive limit", async () => {
    const { orgId, asUser } = await setup();
    const endDate = Date.UTC(2026, 0, 1);
    const startDate = endDate - 400 * 24 * 60 * 60 * 1000;

    await expect(
      asUser.query(api.reports.getSalesAndProfitReport, { orgId, startDate, endDate })
    ).rejects.toThrow(/limited to 366 days/i);

    await expect(
      asUser.query(api.reports.getSalespersonPerformance, { orgId, startDate, endDate })
    ).rejects.toThrow(/limited to 366 days/i);
  });

  test("rejects a start date after the end date", async () => {
    const { orgId, asUser } = await setup();
    const startDate = Date.UTC(2026, 5, 1);
    const endDate = Date.UTC(2026, 0, 1);

    await expect(
      asUser.query(api.reports.getSalesAndProfitReport, { orgId, startDate, endDate })
    ).rejects.toThrow(/must not be after the end date/i);
  });

  test("accepts a range at the limit", async () => {
    const { orgId, asUser } = await setup();
    const endDate = Date.UTC(2026, 0, 1);
    const startDate = endDate - 366 * 24 * 60 * 60 * 1000;

    const report = await asUser.query(api.reports.getSalesAndProfitReport, {
      orgId,
      startDate,
      endDate,
    });
    expect(report).toBeTruthy();
  });
});
