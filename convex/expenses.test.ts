import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
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

  test("creates PENDING expense without cash transaction or accounting event", async () => {
    const { t, orgId, asUser } = await setup();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Vendor invoice awaiting payment",
      amount: 750,
      date: Date.now(),
      category: "OFFICE",
      status: "PENDING",
    });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.status).toBe("PENDING");

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("expenseId"), expenseId))
        .first();
      expect(tx).toBeNull();

      const pendingPost = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `expense_posted_${expenseId}`)
        )
        .first();
      expect(pendingPost).toBeNull();
    });
  });
});

describe("expenses.update", () => {
  test("marking a PENDING expense PAID records the cash transaction and accounting event", async () => {
    const { t, orgId, asUser } = await setup();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Pending utility bill",
      amount: 300,
      date: Date.now(),
      category: "UTILITIES",
      status: "PENDING",
    });

    await asUser.mutation(api.expenses.update, {
      orgId,
      expenseId,
      status: "PAID",
    });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.status).toBe("PAID");

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("expenseId"), expenseId))
        .first();
      expect(tx?.type).toBe("OUT");
      expect(tx?.amount).toBe(300);
      expect(tx?.category).toBe("EXPENSE");

      const pendingPost = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `expense_posted_${expenseId}`)
        )
        .first();
      expect(pendingPost?.eventType).toBe("EXPENSE_POSTED");
    });
  });

  test("rejects accounting field changes after an expense is posted", async () => {
    const { t, orgId, asUser } = await setup();

    const originalDate = Date.now();
    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Utility Bill",
      amount: 300,
      date: originalDate,
      category: "OTHER",
    });

    const newDate = Date.now() + 1000;
    await expect(
      asUser.mutation(api.expenses.update, {
        orgId,
        expenseId,
        amount: 450,
        date: newDate,
      })
    ).rejects.toThrow(/posted expenses are locked/i);

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.amount).toBe(300);
      expect(expense?.date).toBe(originalDate);

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("expenseId"), expenseId))
        .first();
      expect(tx?.amount).toBe(300);
      expect(tx?.date).toBe(originalDate);
    });
  });
});

describe("expenses.remove", () => {
  test("rejects deletion after an expense is posted", async () => {
    const { t, orgId, asUser } = await setup();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Delete Me",
      amount: 200,
      date: Date.now(),
      category: "OTHER",
    });

    await expect(asUser.mutation(api.expenses.remove, { orgId, expenseId })).rejects.toThrow(
      /posted expenses cannot be deleted/i
    );

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.isDeleted).not.toBe(true);
    });
  });

  test("leaves the linked transaction row active when deletion is rejected", async () => {
    const { t, orgId, asUser } = await setup();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Remove With TX",
      amount: 100,
      date: Date.now(),
      category: "OTHER",
    });

    await expect(asUser.mutation(api.expenses.remove, { orgId, expenseId })).rejects.toThrow();

    await t.run(async (ctx) => {
      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("expenseId"), expenseId))
        .first();
      expect(tx?.isDeleted).not.toBe(true);
    });
  });
});

describe("expenses.reverseExpense", () => {
  // No chart of accounts initialized — a "PAID" expense's posting is queued
  // in pendingAccountingEvents rather than actually landing in the ledger.
  async function setupPendingOnly() {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Pending Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "rev_user", email: "rev@test.com", name: "Finance User" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Finance", permissions: [...PERMISSIONS, "manage:finance"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const asUser = t.withIdentity({ subject: "rev_user" });
    return { t, orgId, asUser };
  }

  // Full chart of accounts + open period — a "PAID" expense actually posts
  // a real journal entry.
  async function setupFullyPosted() {
    const { t, orgId, asUser } = await setupPendingOnly();
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    const now = Date.now();
    const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    const monthEnd = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: new Date(now).getFullYear(),
      periodNumber: new Date(now).getMonth() + 1,
      startDate: monthStart,
      endDate: monthEnd,
      openImmediately: true,
    });
    return { t, orgId, asUser };
  }

  test("cancels a queued (not yet actually posted) expense post and removes the expense", async () => {
    const { t, orgId, asUser } = await setupPendingOnly();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "No chart yet",
      amount: 50,
      date: Date.now(),
      category: "OTHER",
    });

    await asUser.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Test cleanup" });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.isDeleted).toBe(true);

      const pendingPost = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `expense_posted_${expenseId}`)
        )
        .first();
      expect(pendingPost).toBeNull();
    });
  });

  test("reverses a fully posted expense with a real offsetting journal entry", async () => {
    const { t, orgId, asUser } = await setupFullyPosted();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Fully posted",
      amount: 75,
      date: Date.now(),
      category: "OTHER",
    });

    await asUser.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Test cleanup" });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.isDeleted).toBe(true);

      const originalEvent = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first();
      expect(originalEvent?.status).toBe("REVERSED");

      const reversalEvent = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "JOURNAL_REVERSAL"))
        .first();
      expect(reversalEvent?.status).toBe("POSTED");
      expect(reversalEvent?.journalEntryId).toBeDefined();
    });
  });

  test("requires a non-empty reason", async () => {
    const { orgId, asUser } = await setupPendingOnly();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "No reason given",
      amount: 20,
      date: Date.now(),
      category: "OTHER",
    });

    await expect(
      asUser.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "   " })
    ).rejects.toThrow(/reason is required/i);
  });

  test("a user without manage:finance cannot reverse an expense", async () => {
    const { t, orgId, asUser: asFinanceUser } = await setupPendingOnly();

    const expenseId = await asFinanceUser.mutation(api.expenses.create, {
      orgId,
      title: "Restricted",
      amount: 20,
      date: Date.now(),
      category: "OTHER",
    });

    // A second member of the same org with only base expense permissions, no manage:finance.
    const salesUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "sales_no_finance", email: "sales@test.com", name: "Sales User" })
    );
    const salesRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Sales", permissions: PERMISSIONS })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesUserId, roleId: salesRoleId }));
    const asSales = t.withIdentity({ subject: "sales_no_finance" });

    await expect(
      asSales.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Trying anyway" })
    ).rejects.toThrow();
  });
});
