import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Mock the rate limiter so we don't need to register the Convex component
vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

describe("Sales Mutations", () => {
  test("Creating a sale marks the vehicle as SOLD and creates a ledger transaction", async () => {
    // @ts-ignore
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
});
