import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Mock the rate limiter so we don't need to register the Convex component
vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

describe("Sales Mutations", () => {
  test("Creating a sale marks the vehicle as SOLD and creates a ledger transaction", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

    // Provide a mocked getValidatedEnv implementation or mocked ENV since auth/env hooks might run
    // convex-test handles auth simulation differently. Let's just run it as an admin.
    
    // Seed Org
    const orgId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", { 
        name: "Test Dealer", 
        createdAt: Date.now() 
      });
    });

    // Seed User
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        clerkId: "user_213",
        email: "test@example.com",
        name: "Test User",
      });
    });

    // Seed Role
    const roleId = await t.run(async (ctx) => {
      return await ctx.db.insert("roles", {
        orgId,
        name: "Admin",
        permissions: [
          "create:sales",
          "view:sales",
          "edit:sales",
          "delete:sales",
          "create:vehicles",
          "view:vehicles",
          "edit:vehicles"
        ],
      });
    });

    // Seed Membership
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        orgId,
        userId,
        roleId,
      });
    });

    // Mock Authentication
    const asAdmin = t.withIdentity({ subject: "user_213", clerkId: "user_213" });

    // Seed Vehicle
    const vehicleId = await t.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A000000",
        make: "Honda",
        model: "Accord",
        year: 2020,
        color: "Black",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 50000,
        sellingPrice: 15000,
        status: "AVAILABLE",
      });
    });

    // Seed Customer
    const customerId = await t.run(async (ctx) => {
      return await ctx.db.insert("customers", {
        orgId,
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
      });
    });

    // Act: Create Sale
    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    expect(saleId).toBeDefined();

    // Assert side effects
    await t.run(async (ctx) => {
      // Vehicle should be SOLD
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOLD");

      // Transaction should be recorded
      const tx = await ctx.db.query("transactions")
        .withIndex("by_org", q => q.eq("orgId", orgId))
        .first();
      expect(tx).toBeDefined();
      expect(tx?.amount).toBe(15000);
      expect(tx?.category).toBe("VEHICLE_SALE");
      expect(tx?.type).toBe("IN");
    });
  });

  test("Creating a sale from a quote closes the quote's exact lead as WON", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_quote_1", email: "quote@example.com", name: "Quote User" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "Admin",
        permissions: [
          "create:sales",
          "view:sales",
          "edit:sales",
          "create:vehicles",
          "view:vehicles",
          "edit:vehicles",
        ],
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const asAdmin = t.withIdentity({ subject: "user_quote_1", clerkId: "user_quote_1" });

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A111111",
        make: "Honda",
        model: "Civic",
        year: 2021,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 10000,
        sellingPrice: 12000,
        status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Jane", lastName: "Smith" })
    );

    // A second, unrelated open lead for the same customer+vehicle pair — the
    // exact leadId match should close ONLY the lead the quote came from,
    // unlike the old fuzzy customerId+vehicleId match which would close both.
    const otherLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, vehicleId, source: "Walk-in", stage: "NEW" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, vehicleId, source: "Walk-in", stage: "NEGOTIATION" })
    );

    const quoteId = await asAdmin.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      leadId,
      vehiclePrice: 12000,
      downPayment: 2000,
      termMonths: 0,
    });

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 12000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      quoteId,
    });

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.quoteId).toBe(quoteId);
      expect(sale?.leadId).toBe(leadId);

      const closedLead = await ctx.db.get(leadId);
      expect(closedLead?.stage).toBe("WON");

      const untouchedLead = await ctx.db.get(otherLeadId);
      expect(untouchedLead?.stage).toBe("NEW");
    });
  });
});
