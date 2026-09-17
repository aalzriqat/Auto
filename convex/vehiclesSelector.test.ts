import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = ["view:vehicles"];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_v1", email: "v@test.com", name: "Vehicle User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_v1" });
  return { t, orgId, otherOrgId, userId, asUser };
}

describe("vehicles.selectorOptions", () => {
  test("discovers a vehicle outside the recent window (>200) and past large inventory through server-backed search", async () => {
    const { t, orgId, asUser } = await setup();

    await t.run(async (ctx) => {
      // Insert needle first (oldest vehicle)
      await ctx.db.insert("vehicles", {
        orgId,
        year: 2021,
        make: "Porsche",
        model: "TaycanRareEdition",
        vin: "WP0AA2Y12MSA99999",
        status: "AVAILABLE",
        mileage: 15000,
        color: "White",
        fuelType: "Electric",
        transmission: "Automatic",
        sellingPrice: 85000,
      });

      // Insert 250 newer vehicles to push the needle past the RECENT_VEHICLE_SEARCH_WINDOW (200)
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("vehicles", {
          orgId,
          year: 2020,
          make: "Toyota",
          model: `Corolla${i}`,
          vin: `JT2AA2Y12MSA00${i}`.padEnd(17, "0"),
          status: "AVAILABLE",
          mileage: 50000,
          color: "Silver",
          fuelType: "Gasoline",
          transmission: "Automatic",
          sellingPrice: 18000,
        });
      }
    });

    // Searching for the rare model must find it via server-backed search
    const results = await asUser.query(api.vehicles.selectorOptions, {
      orgId,
      search: "TaycanRareEdition",
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      year: 2021,
      make: "Porsche",
      model: "TaycanRareEdition",
      vin: "WP0AA2Y12MSA99999",
    });
  });

  test("searches by vin and model, excludes soft-deleted vehicles, and enforces tenant isolation", async () => {
    const { t, orgId, otherOrgId, asUser } = await setup();

    await t.run(async (ctx) => {
      // Active matching vehicle in org
      await ctx.db.insert("vehicles", {
        orgId,
        year: 2022,
        make: "BMW",
        model: "M4",
        vin: "WBS43AZ04NFP11111",
        status: "AVAILABLE",
        mileage: 20000,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Manual",
        sellingPrice: 70000,
      });

      // Deleted matching vehicle in org
      await ctx.db.insert("vehicles", {
        orgId,
        year: 2022,
        make: "BMW",
        model: "M4-Deleted",
        vin: "WBS43AZ04NFP22222",
        status: "AVAILABLE",
        mileage: 20000,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Manual",
        sellingPrice: 70000,
        isDeleted: true,
      });

      // Matching vehicle in another org
      await ctx.db.insert("vehicles", {
        orgId: otherOrgId,
        year: 2022,
        make: "BMW",
        model: "M4-OtherOrg",
        vin: "WBS43AZ04NFP33333",
        status: "AVAILABLE",
        mileage: 20000,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Manual",
        sellingPrice: 70000,
      });
    });

    // Search by model
    const modelResults = await asUser.query(api.vehicles.selectorOptions, {
      orgId,
      search: "M4",
    });
    expect(modelResults).toHaveLength(1);
    expect(modelResults[0].model).toBe("M4");

    // Search by VIN
    const vinResults = await asUser.query(api.vehicles.selectorOptions, {
      orgId,
      search: "NFP11111",
    });
    expect(vinResults).toHaveLength(1);
    expect(vinResults[0].vin).toBe("WBS43AZ04NFP11111");
  });
});
