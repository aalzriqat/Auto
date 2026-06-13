import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

const PERMISSIONS = [
  "create:expenses", "edit:expenses", "delete:expenses",
  "view:expenses", "view:vehicles", "view:users",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_e1", email: "e@test.com", name: "Expense User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_e1" });
  return { t, orgId, userId, asUser };
}

describe("expenses.create", () => {
  test("creates an expense and posts a ledger transaction", async () => {
    const { t, orgId, asUser } = await setup();
    const expenseDate = Date.now();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Office Rent",
      amount: 5000,
      date: expenseDate,
      category: "OTHER",
    });

    expect(expenseId).toBeDefined();

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.amount).toBe(5000);
      expect(expense?.title).toBe("Office Rent");
      expect(expense?.status).toBe("PAID");

      // Side effect: an OUT transaction should be created
      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(tx?.type).toBe("OUT");
      expect(tx?.amount).toBe(5000);
      expect(tx?.category).toBe("EXPENSE");
      expect(tx?.expenseId).toBe(expenseId);
    });
  });

  test("rejects unauthenticated requests", async () => {
    const { t, orgId } = await setup();

    await expect(
      t.mutation(api.expenses.create, {
        orgId,
        title: "Test",
        amount: 100,
        date: Date.now(),
        category: "OTHER",
      })
    ).rejects.toThrow();
  });

  test("rejects vehicle that does not belong to the org", async () => {
    const { t, orgId, asUser } = await setup();

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const foreignVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: orgId2,
        vin: "FOREIGNVIN456",
        make: "BMW",
        model: "X5",
        year: 2022,
        mileage: 5000,
        color: "Black",
        fuelType: "Diesel",
        transmission: "Automatic",
        sellingPrice: 60000,
        status: "AVAILABLE",
      })
    );

    await expect(
      asUser.mutation(api.expenses.create, {
        orgId,
        vehicleId: foreignVehicleId,
        title: "Repair",
        amount: 500,
        date: Date.now(),
        category: "MAINTENANCE",
      })
    ).rejects.toThrow(/vehicle not found/i);
  });

  test("creates expense linked to a vehicle", async () => {
    const { t, orgId, asUser } = await setup();

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "TESTVEHICLE123",
        make: "Toyota",
        model: "Camry",
        year: 2021,
        mileage: 20000,
        color: "Silver",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 25000,
        status: "AVAILABLE",
      })
    );

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      vehicleId,
      title: "Oil Change",
      amount: 150,
      date: Date.now(),
      category: "MAINTENANCE",
    });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.vehicleId).toBe(vehicleId);

      // Transaction should also reference the vehicle
      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(tx?.vehicleId).toBe(vehicleId);
    });
  });
});

describe("expenses.remove", () => {
  test("soft deletes an expense", async () => {
    const { t, orgId, asUser } = await setup();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Delete Me",
      amount: 200,
      date: Date.now(),
      category: "OTHER",
    });

    await asUser.mutation(api.expenses.remove, { orgId, expenseId });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.isDeleted).toBe(true);
    });
  });
});
