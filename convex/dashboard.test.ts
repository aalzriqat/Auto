import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const PERMISSIONS = ["view:customers", "view:vehicles", "view:users"];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_d1", email: "d@test.com", name: "Dashboard User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
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
});
