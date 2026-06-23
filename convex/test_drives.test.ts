import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:sales",
  "create:vehicles",
  "view:vehicles",
  "edit:vehicles",
  "create:leads",
  "edit:leads",
  "view:leads",
  "view:customers",
  "view:users",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_td1", email: "td@test.com", name: "TD User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_td1", clerkId: "user_td1" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A555555",
      make: "Nissan",
      model: "Altima",
      year: 2023,
      color: "Black",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 2000,
      sellingPrice: 17000,
      status: "AVAILABLE",
    })
  );
  const otherVehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A666666",
      make: "Nissan",
      model: "Sentra",
      year: 2023,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 14000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Huda", lastName: "Mansour" })
  );

  return { t, orgId, userId, customerId, vehicleId, otherVehicleId, asUser };
}

describe("test_drives.create lead stage advance", () => {
  test("advances an open lead for the same customer+vehicle to TEST_DRIVE", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId,
      source: "Walk-in",
    });

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("TEST_DRIVE");
    });
  });

  test("advances a vehicle-agnostic open lead too", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      source: "Walk-in",
    });

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("TEST_DRIVE");
    });
  });

  test("does not touch a lead pinned to a different vehicle", async () => {
    const { t, orgId, userId, customerId, vehicleId, otherVehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId: otherVehicleId,
      source: "Walk-in",
    });

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("NEW");
    });
  });

  test("does not move a lead backward or touch WON/LOST leads", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const negotiatingLeadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId,
      source: "Walk-in",
    });
    await t.run((ctx) => ctx.db.patch(negotiatingLeadId, { stage: "NEGOTIATION" }));

    const customer2Id = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Samer", lastName: "Odeh" })
    );
    const lostLeadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId: customer2Id,
      vehicleId,
      source: "Walk-in",
    });
    await t.run((ctx) => ctx.db.patch(lostLeadId, { stage: "LOST" }));

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });
    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId: customer2Id,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const negotiating = await ctx.db.get(negotiatingLeadId);
      expect(negotiating?.stage).toBe("NEGOTIATION");

      const lost = await ctx.db.get(lostLeadId);
      expect(lost?.stage).toBe("LOST");
    });
  });
});
