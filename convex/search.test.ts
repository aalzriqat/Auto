import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { FunctionReference } from "convex/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type GlobalSearchResults = {
  vehicles: Array<{
    id: Id<"vehicles">;
    make: string;
    model: string;
    vin: string;
    year: number;
    status: string;
  }>;
  customers: Array<{
    id: Id<"customers">;
    firstName: string;
    lastName: string;
    phone?: string;
    email?: string;
  }>;
  leads: Array<{
    id: Id<"leads">;
    stage: string;
    customerId: Id<"customers">;
    customerName: string;
  }>;
};

const globalSearchQuery = (api as unknown as {
  search: {
    globalSearch: FunctionReference<
      "query",
      "public",
      { orgId: Id<"organizations">; query: string },
      GlobalSearchResults
    >;
  };
}).search.globalSearch;

async function setup() {
  const t = convexTest(schema, modules);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_search", email: "search@test.com", name: "Search User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: ["view:vehicles", "view:customers", "view:leads"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_search" });
  return { t, orgId, userId, asUser };
}

const baseVehicle = {
  vin: "1HGCM82633A000001",
  make: "Honda",
  model: "Accord",
  year: 2020,
  mileage: 10000,
  color: "White",
  fuelType: "Gasoline",
  transmission: "Automatic",
  sellingPrice: 20000,
  status: "AVAILABLE" as const,
};

describe("search.globalSearch", () => {
  test("returns empty results for blank/short query", async () => {
    const { orgId, asUser } = await setup();

    await expect(asUser.query(globalSearchQuery, { orgId, query: "" })).resolves.toEqual({
      vehicles: [],
      customers: [],
      leads: [],
    });
    await expect(asUser.query(globalSearchQuery, { orgId, query: "h" })).resolves.toEqual({
      vehicles: [],
      customers: [],
      leads: [],
    });
  });

  test("finds vehicle by make after inserting a vehicle", async () => {
    const { t, orgId, asUser } = await setup();
    await t.run((ctx) => ctx.db.insert("vehicles", { orgId, ...baseVehicle }));

    const results = await asUser.query(globalSearchQuery, { orgId, query: "Honda" });

    expect(results.vehicles).toHaveLength(1);
    expect(results.vehicles[0]).toMatchObject({
      make: "Honda",
      model: "Accord",
      vin: "1HGCM82633A000001",
      year: 2020,
      status: "AVAILABLE",
    });
  });

  test("finds customer by firstName", async () => {
    const { t, orgId, asUser } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Jane",
        lastName: "Smith",
        phone: "+1234567890",
        email: "jane@example.com",
      })
    );

    const results = await asUser.query(globalSearchQuery, { orgId, query: "Jane" });

    expect(results.customers).toHaveLength(1);
    expect(results.customers[0]).toMatchObject({
      firstName: "Jane",
      lastName: "Smith",
      phone: "+1234567890",
      email: "jane@example.com",
    });
  });

  test("keeps vehicle search isolated by orgId", async () => {
    const { t, orgId, asUser } = await setup();
    const orgIdB = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );

    await t.run((ctx) => ctx.db.insert("vehicles", { orgId, ...baseVehicle, vin: "1HGCM82633A100001" }));
    await t.run((ctx) => ctx.db.insert("vehicles", { orgId: orgIdB, ...baseVehicle, vin: "1HGCM82633A200001" }));

    const results = await asUser.query(globalSearchQuery, { orgId, query: "Honda" });

    expect(results.vehicles).toHaveLength(1);
    expect(results.vehicles[0].vin).toBe("1HGCM82633A100001");
  });
});
