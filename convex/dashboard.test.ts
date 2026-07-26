import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const PERMISSIONS = ["view:customers", "view:vehicles", "view:users", "view:sales"];

async function setup(permissions = PERMISSIONS) {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_d1", email: "d@test.com", name: "Dashboard User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_d1" });
  return { t, orgId, asUser };
}

describe("dashboard.dataQualityStats", () => {
  test("counts customers missing phone/email and vehicles with a VIN checksum warning", async () => {
    const { t, orgId, asUser } = await setup();

    await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "No", lastName: "Phone", email: "a@test.com" })
    );
    await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "No", lastName: "Email", phone: "+962790000001" })
    );
    await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Complete",
        lastName: "Customer",
        phone: "+962790000002",
        email: "b@test.com",
      })
    );

    // A real, checksum-valid VIN (passes ISO 3779) vs. a VIN that fails it.
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A004352",
        make: "Honda",
        model: "Accord",
        year: 2020,
        mileage: 10000,
        color: "Black",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 15000,
        status: "AVAILABLE",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "NONNAVINNOCHECKSUM",
        make: "Toyota",
        model: "Camry",
        year: 2019,
        mileage: 20000,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 14000,
        status: "AVAILABLE",
      })
    );

    const result = await asUser.query(api.dashboard.dataQualityStats, { orgId });

    expect(result.customersMissingPhone).toBe(1);
    expect(result.customersMissingEmail).toBe(1);
    expect(result.vehiclesWithVinWarning).toBe(1);
  });
});

describe("dashboard.stats", () => {
  test("counts visible sales and sale volume in the overview", async () => {
    const { t, orgId, asUser } = await setup();
    const saleDate = Date.UTC(2026, 5, 29);

    const userId = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first()
        .then((membership) => membership!.userId)
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "LCOC76CA9R4807882",
        make: "BYD",
        model: "QIN L",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Hybrid",
        transmission: "Automatic",
        purchasePrice: 16000,
        sellingPrice: 19600,
        status: "SOLD",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Sara", lastName: "Haddad" })
    );
    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 19600,
        saleDate,
        status: "COMPLETED",
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(result.salesThisMonth).toBe(1);
    expect(result.salesVolumeThisMonth).toBe(19600);
    expect(result.salesTrend.some((point) => point.Revenue === 19600)).toBe(true);
  });

  test("excludes PENDING and CANCELLED sales from counts and volume", async () => {
    const { t, orgId, asUser } = await setup();
    const saleDate = Date.UTC(2026, 5, 29);

    const userId = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first()
        .then((membership) => membership!.userId)
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "LCOC76CA9R4807883",
        make: "BYD",
        model: "Seal",
        year: 2024,
        mileage: 0,
        color: "Blue",
        fuelType: "Electric",
        transmission: "Automatic",
        sellingPrice: 25000,
        status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer" })
    );

    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 25000,
        saleDate,
        status: "PENDING",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 25000,
        saleDate,
        status: "CANCELLED",
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(result.salesThisMonth).toBe(0);
    expect(result.salesVolumeThisMonth).toBe(0);
  });

  test("falls back to vehicle sale transactions when sale rows are unavailable", async () => {
    const { t, orgId, asUser } = await setup();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 19600,
        date: Date.UTC(2026, 5, 29),
        category: "VEHICLE_SALE",
        description: "Sale of vehicle 2024 BYD QIN L (VIN: LCOC76CA9R4807882)",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 99999,
        date: Date.UTC(2026, 5, 29),
        category: "VEHICLE_SALE",
        description: "Deleted sale transaction",
        isDeleted: true,
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(result.salesThisMonth).toBe(1);
    expect(result.salesVolumeThisMonth).toBe(19600);
  });

  test("filters sensitive dashboard metrics by caller permissions", async () => {
    const { t, orgId, asUser } = await setup(["view:vehicles"]);
    const userId = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first()
        .then((membership) => membership!.userId)
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A004352",
        make: "Honda",
        model: "Accord",
        year: 2020,
        mileage: 10000,
        color: "Black",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 15000,
        status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Private", lastName: "Buyer" })
    );
    await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, source: "Walk-in", stage: "NEW" })
    );
    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 19600,
        saleDate: Date.UTC(2026, 5, 29),
        status: "COMPLETED",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId,
        vehicleId,
        title: "Private repair",
        amount: 500,
        date: Date.UTC(2026, 5, 29),
        category: "MAINTENANCE",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("tasks", {
        orgId,
        title: "Sensitive task",
        description: "Do the thing",
        assignedTo: userId,
        status: "PENDING",
        dueDate: Date.now() + 86_400_000,
        priority: "MEDIUM",
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(result.totalVehicles).toBe(1);
    expect(result.availableVehicles).toBe(1);
    expect(result.activeLeads).toBe(0);
    expect(result.salesThisMonth).toBe(0);
    expect(result.salesVolumeThisMonth).toBe(0);
    expect(result.salesTrend).toEqual([]);
    expect(result.teamMembers).toBe(0);
    expect(result.taskStats).toEqual({ total: 0, pending: 0, completed: 0, overdue: 0 });
    expect(result.teamTasks).toEqual([]);
    expect(result.topPerformer).toBeNull();
  });
});

describe("dashboard.todayForRole", () => {
  const FINANCE_PERMISSIONS = ["view:finance"];

  async function seedCustomerAndVehicle(t: Awaited<ReturnType<typeof convexTest>>, orgId: string) {
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Sara", lastName: "Haddad" })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A004352",
        make: "Honda",
        model: "Accord",
        year: 2020,
        mileage: 10000,
        color: "Black",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 15000,
        status: "AVAILABLE",
      })
    );
    return { customerId, vehicleId };
  }

  test("aggregates collections due today, cheques due this week, and overdue receivables", async () => {
    const { t, orgId, asUser } = await setup(FINANCE_PERMISSIONS);
    const { customerId } = await seedCustomerAndVehicle(t, orgId);
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const createdBy = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first()
        .then((membership) => membership!.userId)
    );

    // Due today, open — should count.
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Installment 1",
        originalAmount: 500,
        outstandingAmount: 500,
        dueDate: todayStart + 60 * 60 * 1000,
        status: "OPEN",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    // Overdue (due yesterday, still open) — should count as overdue, not due-today.
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Installment 0",
        originalAmount: 300,
        outstandingAmount: 300,
        dueDate: todayStart - 24 * 60 * 60 * 1000,
        status: "OVERDUE",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    // Already paid, due today — must be excluded from both buckets.
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Installment paid",
        originalAmount: 200,
        outstandingAmount: 0,
        dueDate: todayStart + 60 * 60 * 1000,
        status: "PAID",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    // Held cheque due in 3 days — should count.
    await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: "1001",
        chequeDate: now + 3 * 24 * 60 * 60 * 1000,
        amount: 1200,
        status: "HELD",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    // Cleared cheque due in 3 days — must be excluded.
    await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: "1002",
        chequeDate: now + 3 * 24 * 60 * 60 * 1000,
        amount: 900,
        status: "CLEARED",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    const result = await asUser.query(api.dashboard.todayForRole, { orgId });

    expect(result.collectionsDueToday).toEqual({ count: 1, amount: 500 });
    expect(result.overdueReceivables).toEqual({ count: 1, amount: 300 });
    expect(result.chequesDueThisWeek).toEqual({ count: 1, amount: 1200 });
    expect(result.truncated).toBe(false);
  });

  test("rejects callers without view:finance permission", async () => {
    const { orgId, asUser } = await setup(["view:vehicles"]);

    await expect(asUser.query(api.dashboard.todayForRole, { orgId })).rejects.toThrow();
  });

  test("includes a cheque due today, stored as UTC midnight of the due date rather than an offset from now", async () => {
    const { t, orgId, asUser } = await setup(FINANCE_PERMISSIONS);
    const { customerId } = await seedCustomerAndVehicle(t, orgId);
    const now = Date.now();
    const createdBy = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first()
        .then((membership) => membership!.userId)
    );

    // Real accounting-date convention (lib/dateInput.ts's dateInputToUtcMs): a
    // cheque due "today" is stored as UTC midnight of today's calendar date,
    // not an offset from the current instant. `.gte("chequeDate", now)` would
    // wrongly exclude this row for essentially the entire day, since
    // chequeDate (today's midnight) is less than `now` (the current instant)
    // except right at midnight itself.
    const today = new Date();
    const chequeDateToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());

    await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: "2001",
        chequeDate: chequeDateToday,
        amount: 750,
        status: "HELD",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    const result = await asUser.query(api.dashboard.todayForRole, { orgId });

    expect(result.chequesDueThisWeek).toEqual({ count: 1, amount: 750 });
  });
});
