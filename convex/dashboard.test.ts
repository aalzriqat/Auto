import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

/**
 * The Y/M/D `at` (a UTC ms instant) reads as in `timeZone`, expressed with
 * this repo's "a calendar date IS its UTC midnight" convention (see
 * lib/dateInput.ts's `dateInputToUtcMs`) — the same math `todayForRole`
 * itself uses, kept independent here so tests don't depend on the test
 * runner's own OS timezone.
 */
function startOfDayInTimeZone(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const lookup = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(lookup.year), Number(lookup.month) - 1, Number(lookup.day));
}

const PERMISSIONS = ["view:customers", "view:vehicles", "view:users", "view:sales"];

async function setup(permissions = PERMISSIONS) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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

  async function seedCustomerAndVehicle(t: Awaited<ReturnType<typeof convexTestWithComponents>>, orgId: string) {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  test("aggregates collections due today, cheques due this week, and overdue receivables", async () => {
    const { t, orgId, asUser } = await setup(FINANCE_PERMISSIONS);
    const { customerId } = await seedCustomerAndVehicle(t, orgId);
    const now = Date.now();
    // No orgSettings row exists for this org, so `todayForRole` falls back to
    // Asia/Amman — compute the expected boundary the same way, independent of
    // whatever timezone the test runner's OS happens to be in.
    const todayStart = startOfDayInTimeZone("Asia/Amman", now);
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
    // except right at midnight itself. No orgSettings row exists here, so
    // "today" is Asia/Amman's calendar day (the fallback), not the test
    // runner's own OS timezone.
    const chequeDateToday = startOfDayInTimeZone("Asia/Amman", now);

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

  test("buckets a receivable due 'today' by Asia/Amman's calendar even when the UTC calendar date is still a day behind (near-midnight boundary)", async () => {
    const { t, orgId, asUser } = await setup(FINANCE_PERMISSIONS);
    const { customerId } = await seedCustomerAndVehicle(t, orgId);

    // 2026-03-31 22:00 UTC = 2026-04-01 01:00 in Asia/Amman (UTC+3, no DST) —
    // Amman's calendar day is already the 1st while UTC's is still the 31st.
    // No orgSettings row exists for this org, so Asia/Amman is the fallback.
    const now = Date.UTC(2026, 2, 31, 22, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    const createdBy = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first()
        .then((membership) => membership!.userId)
    );

    // Due "today" by Amman's calendar (April 1st, stored as its UTC midnight
    // per the storage convention) — must be bucketed as due-today, NOT
    // excluded, even though the UTC calendar date at this instant is still
    // March 31st.
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Due today in Amman",
        originalAmount: 400,
        outstandingAmount: 400,
        dueDate: Date.UTC(2026, 3, 1),
        status: "OPEN",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    // Due "yesterday" by Amman's calendar (March 31st) — must land in
    // overdueReceivables, not collectionsDueToday.
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Overdue in Amman",
        originalAmount: 250,
        outstandingAmount: 250,
        dueDate: Date.UTC(2026, 2, 31),
        status: "OPEN",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    const result = await asUser.query(api.dashboard.todayForRole, { orgId });

    expect(result.collectionsDueToday).toEqual({ count: 1, amount: 400 });
    expect(result.overdueReceivables).toEqual({ count: 1, amount: 250 });
  });

  test("uses the org's configured timezone instead of the Asia/Amman fallback", async () => {
    const { t, orgId, asUser } = await setup(FINANCE_PERMISSIONS);
    const { customerId } = await seedCustomerAndVehicle(t, orgId);

    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH", "INSTALLMENT"],
        timezone: "America/Los_Angeles",
      })
    );

    // 2026-01-15 04:00 UTC = 2026-01-15 07:00 in Asia/Amman (already the
    // 15th) but 2026-01-14 20:00 in America/Los_Angeles, PST in January
    // (still the 14th) — the two zones disagree on what "today" is.
    const now = Date.UTC(2026, 0, 15, 4, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    const createdBy = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first()
        .then((membership) => membership!.userId)
    );

    // Due on the 14th — "today" per the org's configured Los Angeles
    // timezone, but "yesterday" per the Asia/Amman fallback. If the org's
    // configured timezone were ignored, this would wrongly land in
    // overdueReceivables instead.
    await t.run((ctx) =>
      ctx.db.insert("receivables", {
        orgId,
        customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Due today in Los Angeles",
        originalAmount: 600,
        outstandingAmount: 600,
        dueDate: Date.UTC(2026, 0, 14),
        status: "OPEN",
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
    );

    const result = await asUser.query(api.dashboard.todayForRole, { orgId });

    expect(result.collectionsDueToday).toEqual({ count: 1, amount: 600 });
    expect(result.overdueReceivables).toEqual({ count: 0, amount: 0 });
  });

  test("returns the org's configured currency, defaulting to JOD when orgSettings has none set", async () => {
    const { orgId, asUser } = await setup(FINANCE_PERMISSIONS);

    const result = await asUser.query(api.dashboard.todayForRole, { orgId });

    expect(result.currency).toBe("JOD");
  });

  test("returns the org's configured currency rather than hardcoding JOD", async () => {
    const { t, orgId, asUser } = await setup(FINANCE_PERMISSIONS);

    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "AED",
        currencySymbol: "د.إ",
        enabledPaymentTypes: ["CASH", "INSTALLMENT"],
      })
    );

    const result = await asUser.query(api.dashboard.todayForRole, { orgId });

    expect(result.currency).toBe("AED");
  });
});

/**
 * The dashboard's profit line used to derive a vehicle's cost by hand, and it
 * disagreed with the GL and with every report in four separate ways. All four
 * pushed reported profit in the *optimistic* direction, which is the direction
 * nobody questions.
 */
describe("dashboard.stats profit uses the authoritative cost basis", () => {
  const PROFIT_PERMISSIONS = [
    "view:customers",
    "view:vehicles",
    "view:users",
    "view:sales",
    "view:expenses",
  ];

  const SALE_DATE = Date.UTC(2026, 5, 29);

  async function seedSale(
    t: any,
    orgId: any,
    vehicle: Record<string, unknown>,
    salePrice: number
  ) {
    const userId = await t.run((ctx: any) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
        .first()
        .then((membership: any) => membership!.userId)
    );
    const vehicleId = await t.run((ctx: any) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "LCOC76CA9R4807883",
        make: "BYD",
        model: "QIN L",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Hybrid",
        transmission: "Automatic",
        sellingPrice: salePrice,
        status: "SOLD",
        ...vehicle,
      })
    );
    const customerId = await t.run((ctx: any) =>
      ctx.db.insert("customers", { orgId, firstName: "Sara", lastName: "Haddad" })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice,
        saleDate: SALE_DATE,
        status: "COMPLETED",
      })
    );
    return { vehicleId, userId };
  }

  function profitOf(result: any): number {
    return result.salesTrend.reduce((sum: number, point: any) => sum + point.Profit, 0);
  }

  test("a soft-deleted expense stops counting against profit", async () => {
    const { t, orgId, asUser } = await setup(PROFIT_PERMISSIONS);
    const { vehicleId } = await seedSale(t, orgId, { purchasePrice: 16000 }, 19600);

    await t.run((ctx: any) =>
      ctx.db.insert("expenses", {
        orgId,
        vehicleId,
        title: "Detailing, entered twice by mistake",
        amount: 1000,
        date: SALE_DATE,
        category: "DETAILING",
        status: "PAID",
        isDeleted: true,
        deletedAt: Date.now(),
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    // 19,600 minus 16,000. The deleted 1,000 is gone from both figures; before
    // the fix it sat in the dashboard's costs forever while the reports it
    // summarizes already showed the corrected number.
    expect(profitOf(result)).toBe(3600);
    expect(result.salesTrend.reduce((s: number, p: any) => s + p.Expenses, 0)).toBe(0);
  });

  test("a SOURCED vehicle's sale contributes profit off sourceCost", async () => {
    const { t, orgId, asUser } = await setup(PROFIT_PERMISSIONS);
    // No purchasePrice at all: the shape of a sourced row written before
    // `create` began mirroring sourceCost into purchasePrice.
    await seedSale(
      t,
      orgId,
      { sourceType: "SOURCED", sourceCost: 18000, sourcedFromName: "Al-Safeer" },
      21000
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    // The old `purchasePrice !== undefined` gate skipped this sale entirely, so
    // a real 3,000 margin was reported as no margin at all.
    expect(profitOf(result)).toBe(3000);
  });

  test("landed costs are part of the cost basis, not a replacement for it", async () => {
    const { t, orgId, asUser } = await setup(PROFIT_PERMISSIONS);
    await seedSale(t, orgId, { purchasePrice: 16000, landedCostTotal: 1200 }, 19600);

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    // 19,600 minus (16,000 + 1,200). The old inline derivation ignored
    // landedCostTotal outright and reported 3,600.
    expect(profitOf(result)).toBe(2400);
  });

  test("a capitalized expense is charged to the vehicle once, not twice", async () => {
    const { t, orgId, asUser } = await setup(PROFIT_PERMISSIONS);
    const { vehicleId } = await seedSale(t, orgId, { purchasePrice: 16000 }, 19600);

    // Capitalized into Vehicle Inventory at posting time, so it is already
    // inside computeVehicleCapitalizedCost. Deducting it again as a period
    // expense, which is what a naive fix does, would report 2,200.
    await t.run((ctx: any) =>
      ctx.db.insert("expenses", {
        orgId,
        vehicleId,
        title: "Engine mount",
        amount: 700,
        date: SALE_DATE,
        category: "REPAIR",
        status: "PAID",
        accountingTreatment: "CAPITALIZED_INVENTORY",
        capitalizedAmount: 700,
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(profitOf(result)).toBe(2900);
  });

  test("a vehicle-linked expense that was NOT capitalized still reduces profit", async () => {
    const { t, orgId, asUser } = await setup(PROFIT_PERMISSIONS);
    const { vehicleId } = await seedSale(t, orgId, { purchasePrice: 16000 }, 19600);

    // Marketing spend on a specific car is expensed as incurred, never
    // capitalized. It is outside the cost basis, so it has to be deducted as a
    // period expense or it silently stops counting at all.
    await t.run((ctx: any) =>
      ctx.db.insert("expenses", {
        orgId,
        vehicleId,
        title: "Instagram boost for this car",
        amount: 300,
        date: SALE_DATE,
        category: "MARKETING",
        status: "PAID",
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(profitOf(result)).toBe(3300);
  });
});

describe("dashboard.stats previous-period totals", () => {
  const FULL_PERMISSIONS = [
    "view:customers",
    "view:vehicles",
    "view:users",
    "view:sales",
    "view:expenses",
  ];
  const SALES_ONLY_PERMISSIONS = ["view:customers", "view:vehicles", "view:users", "view:sales"];

  const DAY_MS = 24 * 60 * 60 * 1000;
  // Mid-month, so a 100-day lookback stays well clear of any calendar edge.
  // Nothing here depends on the date itself, only on distances from "now":
  // MONTH is the last 30 days, and the previous window is the 30 before those.
  const NOW = Date.UTC(2026, 6, 15);

  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeNow() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  }

  async function seedSaleAt(
    t: any,
    orgId: any,
    options: { daysAgo: number; salePrice: number; purchasePrice: number; vin: string },
  ) {
    const salespersonId = await t.run((ctx: any) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
        .first()
        .then((membership: any) => membership!.userId)
    );
    const vehicleId = await t.run((ctx: any) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: options.vin,
        make: "BYD",
        model: "QIN L",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Hybrid",
        transmission: "Automatic",
        purchasePrice: options.purchasePrice,
        sellingPrice: options.salePrice,
        status: "SOLD",
      })
    );
    const customerId = await t.run((ctx: any) =>
      ctx.db.insert("customers", { orgId, firstName: "Sara", lastName: "Haddad" })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId,
        salePrice: options.salePrice,
        saleDate: NOW - options.daysAgo * DAY_MS,
        status: "COMPLETED",
      })
    );
    return vehicleId;
  }

  function seedExpenseAt(
    t: any,
    orgId: any,
    options: { daysAgo: number; amount: number; vehicleId?: any; capitalized?: boolean },
  ) {
    return t.run((ctx: any) =>
      ctx.db.insert("expenses", {
        orgId,
        ...(options.vehicleId ? { vehicleId: options.vehicleId } : {}),
        title: "Seeded expense",
        amount: options.amount,
        date: NOW - options.daysAgo * DAY_MS,
        category: options.capitalized ? "REPAIR" : "MARKETING",
        status: "PAID",
        ...(options.capitalized
          ? { accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: options.amount }
          : {}),
      })
    );
  }

  function seedSaleTransactionAt(t: any, orgId: any, daysAgo: number, amount: number) {
    return t.run((ctx: any) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount,
        date: NOW - daysAgo * DAY_MS,
        category: "VEHICLE_SALE",
        description: "Seeded vehicle sale",
      })
    );
  }

  test("keeps the two windows apart instead of folding the older one into the current total", async () => {
    const { t, orgId, asUser } = await setup(FULL_PERMISSIONS);
    freezeNow();

    await seedSaleAt(t, orgId, { daysAgo: 5, salePrice: 20_000, purchasePrice: 15_000, vin: "LCOC76CA9R4800001" });
    await seedSaleAt(t, orgId, { daysAgo: 40, salePrice: 30_000, purchasePrice: 22_000, vin: "LCOC76CA9R4800002" });
    // Older than both windows — outside the comparison entirely.
    await seedSaleAt(t, orgId, { daysAgo: 100, salePrice: 99_000, purchasePrice: 50_000, vin: "LCOC76CA9R4800003" });

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    // Reaching back for the previous window by widening the CURRENT scan and
    // forgetting to partition it reports 50,000 here — a silent regression in a
    // number the dashboard already ships.
    expect(result.salesVolumeThisMonth).toBe(20_000);
    // 30,000 on its own: not 129,000 (no lower bound on the previous read) and
    // not 50,000 (no upper bound, so the current window leaks into its own past).
    expect(result.previousPeriod?.sales).toBe(30_000);
  });

  test("omits previousPeriod entirely for ALL_TIME, which has no period before it", async () => {
    const { t, orgId, asUser } = await setup(FULL_PERMISSIONS);
    freezeNow();
    await seedSaleAt(t, orgId, { daysAgo: 40, salePrice: 30_000, purchasePrice: 22_000, vin: "LCOC76CA9R4800004" });

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(result.previousPeriod).toBeUndefined();
  });

  test("counts previous-window expenses on the same rules as the current total", async () => {
    const { t, orgId, asUser } = await setup(FULL_PERMISSIONS);
    freezeNow();

    await seedExpenseAt(t, orgId, { daysAgo: 5, amount: 1_500 });
    await seedExpenseAt(t, orgId, { daysAgo: 40, amount: 900 });
    await seedExpenseAt(t, orgId, { daysAgo: 45, amount: 700 });
    await seedExpenseAt(t, orgId, { daysAgo: 100, amount: 5_000 });

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    // The current figure, which the client sums off the trend, is unchanged.
    expect(result.salesTrend.reduce((sum: number, point: any) => sum + point.Expenses, 0)).toBe(1_500);
    expect(result.previousPeriod?.expenses).toBe(1_600);
  });

  test("computes previous-window profit off the same capitalized cost basis as the current one", async () => {
    const { t, orgId, asUser } = await setup(FULL_PERMISSIONS);
    freezeNow();

    // A current-period sale, so the previous window is costed off sale rows
    // rather than the transaction fallback.
    await seedSaleAt(t, orgId, { daysAgo: 5, salePrice: 20_000, purchasePrice: 15_000, vin: "LCOC76CA9R4800005" });
    const previousVehicleId = await seedSaleAt(t, orgId, {
      daysAgo: 40,
      salePrice: 30_000,
      purchasePrice: 22_000,
      vin: "LCOC76CA9R4800006",
    });
    // Capitalized into the vehicle at posting time: part of its cost basis, and
    // therefore not also a period expense.
    await seedExpenseAt(t, orgId, {
      daysAgo: 40,
      amount: 1_000,
      vehicleId: previousVehicleId,
      capitalized: true,
    });
    // Operating spend in the same window: a period expense, deducted.
    await seedExpenseAt(t, orgId, { daysAgo: 40, amount: 700 });

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    // (30,000 − (22,000 + 1,000)) − 700. Charging the capitalized 1,000 twice
    // gives 5,300; leaving it out of the cost basis gives 7,300.
    expect(result.previousPeriod?.netProfit).toBe(6_300);
    // Total expenses is every expense in the window, capitalized ones included —
    // it answers a different question than the profit deduction above.
    expect(result.previousPeriod?.expenses).toBe(1_700);
  });

  test("compares transactions against transactions when the org has no sale rows", async () => {
    const { t, orgId, asUser } = await setup(FULL_PERMISSIONS);
    freezeNow();

    await seedSaleTransactionAt(t, orgId, 5, 20_000);
    await seedSaleTransactionAt(t, orgId, 40, 12_000);
    await seedSaleTransactionAt(t, orgId, 100, 88_000);

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    expect(result.salesVolumeThisMonth).toBe(20_000);
    expect(result.previousPeriod?.sales).toBe(12_000);
  });

  test("withholds the previous totals for figures the caller cannot see today", async () => {
    const { t, orgId, asUser } = await setup(SALES_ONLY_PERMISSIONS);
    freezeNow();

    await seedSaleAt(t, orgId, { daysAgo: 5, salePrice: 20_000, purchasePrice: 15_000, vin: "LCOC76CA9R4800007" });
    await seedSaleAt(t, orgId, { daysAgo: 40, salePrice: 30_000, purchasePrice: 22_000, vin: "LCOC76CA9R4800008" });
    await seedExpenseAt(t, orgId, { daysAgo: 40, amount: 700 });

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    expect(result.previousPeriod?.sales).toBe(30_000);
    // No view:expenses / view:reports / view:finance, so neither the current
    // cost figures nor their history are readable.
    expect(result.previousPeriod?.expenses).toBeUndefined();
    expect(result.previousPeriod?.netProfit).toBeUndefined();
  });
});
