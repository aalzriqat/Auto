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

async function setup(permissions = ["view:vehicles", "view:customers", "view:leads"]) {
  const t = convexTest(schema, modules);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_search", email: "search@test.com", name: "Search User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions })
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

async function seedSearchCorpus(t: ReturnType<typeof convexTest>, orgId: Id<"organizations">) {
  await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      ...baseVehicle,
      make: "Alpha",
      model: "Cruiser",
      vin: "ALPHA00000000001",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Alpha",
      lastName: "Buyer",
      phone: "+1234567890",
      email: "alpha@example.com",
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("leads", {
      orgId,
      customerId,
      source: "Walk-in",
      stage: "NEW",
    })
  );
}

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

  test("filters global search result domains by caller permissions", async () => {
    const vehicleOnly = await setup(["view:vehicles"]);
    await seedSearchCorpus(vehicleOnly.t, vehicleOnly.orgId);

    const vehicleResults = await vehicleOnly.asUser.query(globalSearchQuery, {
      orgId: vehicleOnly.orgId,
      query: "Alpha",
    });
    expect(vehicleResults.vehicles).toHaveLength(1);
    expect(vehicleResults.customers).toHaveLength(0);
    expect(vehicleResults.leads).toHaveLength(0);

    const customerOnly = await setup(["view:customers"]);
    await seedSearchCorpus(customerOnly.t, customerOnly.orgId);

    const customerResults = await customerOnly.asUser.query(globalSearchQuery, {
      orgId: customerOnly.orgId,
      query: "Alpha",
    });
    expect(customerResults.vehicles).toHaveLength(0);
    expect(customerResults.customers).toHaveLength(1);
    expect(customerResults.leads).toHaveLength(0);
  });

  test("does not expose customer-backed lead results without both lead and customer visibility", async () => {
    const leadOnly = await setup(["view:leads"]);
    await seedSearchCorpus(leadOnly.t, leadOnly.orgId);

    const leadOnlyResults = await leadOnly.asUser.query(globalSearchQuery, {
      orgId: leadOnly.orgId,
      query: "Alpha",
    });
    expect(leadOnlyResults).toEqual({ vehicles: [], customers: [], leads: [] });

    const leadAndCustomer = await setup(["view:leads", "view:customers"]);
    await seedSearchCorpus(leadAndCustomer.t, leadAndCustomer.orgId);

    const allowedResults = await leadAndCustomer.asUser.query(globalSearchQuery, {
      orgId: leadAndCustomer.orgId,
      query: "Alpha",
    });
    expect(allowedResults.vehicles).toHaveLength(0);
    expect(allowedResults.customers).toHaveLength(1);
    expect(allowedResults.leads).toHaveLength(1);
    expect(allowedResults.leads[0].customerName).toBe("Alpha Buyer");
  });
});
