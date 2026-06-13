declare global {
  interface ImportMeta {
    glob: any;
  }
}
import { describe, it, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { ConvexError } from "convex/values";

describe("Approvals Permissions", () => {
  it("rejects unauthenticated requests", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Test Org",
        createdAt: Date.now(),
      });
    });

    const vehicleId = await t.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId,
        make: "Toyota",
        model: "Camry",
        status: "AVAILABLE",
        vin: "FAKEVIN123",
        year: 2020,
        mileage: 10000,
        color: "Black",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 20000,
      });
    });

    // Attempting to request approval without auth should throw
    await expect(
      t.mutation(api.approvals.requestProfitApproval, {
        orgId,
        vehicleId,
        requestedProfit: 1000,
        minimumProfit: 500,
      })
    ).rejects.toThrow("Unauthenticated");
  });

  it("rejects user in Org A from approving requests in Org B", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    
    // Create Org A and Org B
    const orgAId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Org A",
        createdAt: Date.now(),
      });
    });
    
    const orgBId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Org B",
        createdAt: Date.now(),
      });
    });

    // Create a user who is ONLY in Org A
    const asUserA = t.withIdentity({ subject: "user_A" });
    const userAId = await asUserA.run(async (ctx) => {
      return await ctx.db.insert("users", {
        clerkId: "user_A",
        email: "a@test.com",
        name: "User A",
      });
    });

    const roleAId = await asUserA.run(async (ctx) => {
      return await ctx.db.insert("roles", {
        orgId: orgAId,
        name: "SALES",
        permissions: ["view:vehicles"],
      });
    });

    await asUserA.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        orgId: orgAId,
        userId: userAId,
        roleId: roleAId,
      });
    });

    const vehicleInOrgB = await asUserA.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId: orgBId,
        make: "Honda",
        model: "Civic",
        status: "AVAILABLE",
        vin: "FAKEVIN456",
        year: 2021,
        mileage: 5000,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 22000,
      });
    });

    // User A tries to request profit approval for Org B's vehicle
    await expect(
      asUserA.mutation(api.approvals.requestProfitApproval, {
        orgId: orgBId,
        vehicleId: vehicleInOrgB,
        requestedProfit: 1000,
        minimumProfit: 500,
      })
    ).rejects.toThrow("Unauthorized: You are not a member of this organization.");
  });

  it("rejects users without MANAGE_SETTINGS from responding to approvals", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Test Org",
        createdAt: Date.now(),
      });
    });

    const asSalesperson = t.withIdentity({ subject: "salesperson" });
    const userId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("users", {
        clerkId: "salesperson",
        email: "sales@test.com",
        name: "Sales Person",
      });
    });

    const salesRoleId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("roles", {
        orgId,
        name: "SALES",
        permissions: ["view:vehicles"],
      });
    });

    await asSalesperson.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        orgId,
        userId,
        roleId: salesRoleId,
      });
    });

    const vehicleId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId,
        make: "Ford",
        model: "F150",
        status: "AVAILABLE",
        vin: "FAKEVIN789",
        year: 2022,
        mileage: 15000,
        color: "Red",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 35000,
      });
    });

    const requestId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("profitApprovalRequests", {
        orgId,
        vehicleId,
        requestedProfit: 1000,
        minimumProfit: 500,
        salespersonId: userId,
        status: "PENDING",
        createdAt: Date.now(),
      });
    });

    // Try to approve the request without MANAGE_SETTINGS
    await expect(
      asSalesperson.mutation(api.approvals.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Forbidden: Missing required permissions");
  });
});
