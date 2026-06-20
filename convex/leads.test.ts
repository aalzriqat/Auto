import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

const PERMISSIONS = [
  "create:leads", "edit:leads", "delete:leads", "view:leads",
  "view:customers", "view:vehicles", "view:users",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_l1", email: "l@test.com", name: "Lead User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" })
  );
  const asUser = t.withIdentity({ subject: "user_l1" });
  return { t, orgId, userId, customerId, asUser };
}

describe("leads.create", () => {
  test("creates a lead defaulting to NEW stage", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      source: "Walk-in",
    });

    expect(leadId).toBeDefined();

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("NEW");
      expect(lead?.customerId).toBe(customerId);
      expect(lead?.orgId).toBe(orgId);
    });
  });

  test("rejects unauthenticated requests", async () => {
    const { t, orgId, customerId } = await setup();

    await expect(
      t.mutation(api.leads.create, { orgId, customerId, source: "Walk-in" })
    ).rejects.toThrow();
  });

  test("rejects customer from a different org", async () => {
    const { t, orgId, asUser } = await setup();

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const foreignCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: orgId2, firstName: "Foreign", lastName: "Customer" })
    );

    await expect(
      asUser.mutation(api.leads.create, {
        orgId,
        customerId: foreignCustomerId,
        source: "Walk-in",
      })
    ).rejects.toThrow(/customer not found/i);
  });

  test("rejects vehicle from a different org", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const foreignVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: orgId2,
        vin: "FOREIGNVIN123",
        make: "Ford",
        model: "F-150",
        year: 2021,
        mileage: 0,
        color: "Red",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 30000,
        status: "AVAILABLE",
      })
    );

    await expect(
      asUser.mutation(api.leads.create, {
        orgId,
        customerId,
        vehicleId: foreignVehicleId,
        source: "Online",
      })
    ).rejects.toThrow(/vehicle not found/i);
  });
});

describe("leads.update", () => {
  test("advances lead stage", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      source: "Walk-in",
    });

    await asUser.mutation(api.leads.update, {
      orgId,
      leadId,
      stage: "CONTACTED",
    });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("CONTACTED");
    });
  });
});

describe("leads.softDelete", () => {
  test("marks lead as deleted", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      source: "Referral",
    });

    await asUser.mutation(api.leads.softDelete, { orgId, leadId });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.isDeleted).toBe(true);
    });
  });
});

describe("leads.checkExistingOpenLead", () => {
  test("finds an open lead for the same customer", async () => {
    const { orgId, customerId, asUser } = await setup();

    await asUser.mutation(api.leads.create, { orgId, customerId, source: "Walk-in" });

    const result = await asUser.query(api.leads.checkExistingOpenLead, {
      orgId,
      customerId,
    });

    expect(result?.customerId).toBe(customerId);
  });

  test("ignores WON/LOST leads", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, { orgId, customerId, source: "Walk-in" });
    await t.run((ctx) => ctx.db.patch(leadId, { stage: "WON" }));

    const result = await asUser.query(api.leads.checkExistingOpenLead, {
      orgId,
      customerId,
    });

    expect(result).toBeNull();
  });

  test("excludes the lead being edited from its own check", async () => {
    const { orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, { orgId, customerId, source: "Walk-in" });

    const result = await asUser.query(api.leads.checkExistingOpenLead, {
      orgId,
      customerId,
      excludeLeadId: leadId,
    });

    expect(result).toBeNull();
  });
});

describe("leads.getLinkedSale", () => {
  test("returns null for a lead that isn't WON", async () => {
    const { orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, { orgId, customerId, source: "Walk-in" });

    const result = await asUser.query(api.leads.getLinkedSale, { orgId, leadId });
    expect(result).toBeNull();
  });

  test("finds the sale that closed a WON lead via shared customerId+vehicleId", async () => {
    const { t, orgId, userId, customerId, asUser } = await setup();

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
        status: "SOLD",
      })
    );

    const leadId = await asUser.mutation(api.leads.create, { orgId, customerId, vehicleId, source: "Walk-in" });
    await t.run((ctx) => ctx.db.patch(leadId, { stage: "WON" }));

    const saleId = await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 15000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );

    const result = await asUser.query(api.leads.getLinkedSale, { orgId, leadId });
    expect(result?._id).toBe(saleId);
  });
});
