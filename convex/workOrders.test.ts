import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "edit:vehicles", "view:vehicles", "view:users",
  "create:expenses", "edit:expenses", "view:expenses",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "WO Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_wo1", email: "wo@test.com", name: "WO User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "WOVEHICLE001",
      make: "Toyota",
      model: "Land Cruiser",
      year: 2023,
      mileage: 0,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 80000,
      status: "AVAILABLE",
    })
  );
  const asUser = t.withIdentity({ subject: "user_wo1" });
  return { t, orgId, userId, vehicleId, asUser };
}

describe("workOrders.create", () => {
  test("creates an OPEN work order without expense", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();

    const woId = await asUser.mutation(api.workOrders.create, {
      orgId,
      vehicleId,
      title: "Oil Change",
      status: "OPEN",
      tasks: [{ id: "t1", description: "Change oil", partsCost: 0, laborCost: 50, completed: false }],
    });

    await t.run(async (ctx) => {
      const wo = await ctx.db.get(woId);
      expect(wo?.status).toBe("OPEN");
      expect(wo?.expenseId).toBeUndefined();

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(tx).toBeNull();
    });
  });

  test("creates COMPLETED work order with linked expense and transaction", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();

    const woId = await asUser.mutation(api.workOrders.create, {
      orgId,
      vehicleId,
      title: "Full Service",
      status: "COMPLETED",
      tasks: [
        { id: "t1", description: "Parts", partsCost: 200, laborCost: 0, completed: true },
        { id: "t2", description: "Labor", partsCost: 0, laborCost: 150, completed: true },
      ],
    });

    await t.run(async (ctx) => {
      const wo = await ctx.db.get(woId);
      expect(wo?.status).toBe("COMPLETED");
      expect(wo?.expenseId).toBeDefined();

      const expense = await ctx.db.get(wo!.expenseId!);
      expect(expense?.amount).toBe(350);
      expect(expense?.category).toBe("REPAIR");

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("expenseId"), wo!.expenseId))
        .first();
      expect(tx?.type).toBe("OUT");
      expect(tx?.amount).toBe(350);
    });
  });
});

describe("workOrders.update", () => {
  test("syncs expense and transaction when cost changes on a COMPLETED work order", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();

    const woId = await asUser.mutation(api.workOrders.create, {
      orgId,
      vehicleId,
      title: "Brake Job",
      status: "COMPLETED",
      tasks: [{ id: "t1", description: "Brakes", partsCost: 100, laborCost: 100, completed: true }],
    });

    const wo = await t.run((ctx) => ctx.db.get(woId));
    const expenseId = wo!.expenseId!;

    await asUser.mutation(api.workOrders.update, {
      orgId,
      workOrderId: woId,
      title: "Brake Job",
      status: "COMPLETED",
      tasks: [{ id: "t1", description: "Brakes + pads", partsCost: 150, laborCost: 120, completed: true }],
    });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.amount).toBe(270);

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("expenseId"), expenseId))
        .first();
      expect(tx?.amount).toBe(270);
    });
  });
});
