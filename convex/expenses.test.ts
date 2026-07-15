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

describe("Phase 2 — amortization start date can't predate the expense's month", () => {
  test("create rejects a start date in an earlier calendar month than the expense", async () => {
    const { orgId, asUser } = await setup();
    await expect(
      asUser.mutation(api.expenses.create, {
        orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 2, 1), // March 2026
        category: "FEES", isPrepaid: true, amortizationMonths: 12,
        amortizationStartDate: Date.UTC(2026, 1, 15), // February — before March
      })
    ).rejects.toThrow(/cannot be earlier/i);
  });

  test("create accepts a start date earlier in the SAME calendar month as the expense (month-level, not day-level)", async () => {
    const { orgId, asUser } = await setup();
    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 2, 20),
      category: "FEES", isPrepaid: true, amortizationMonths: 12,
      amortizationStartDate: Date.UTC(2026, 2, 1), // same month, earlier day — allowed
    });
    expect(expenseId).toBeDefined();
  });

  test("create accepts a start date after the expense's month (coverage begins later)", async () => {
    const { orgId, asUser } = await setup();
    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 2, 1),
      category: "FEES", isPrepaid: true, amortizationMonths: 12,
      amortizationStartDate: Date.UTC(2026, 4, 1), // May — allowed
    });
    expect(expenseId).toBeDefined();
  });

  test("update rejects a start date earlier than the (unchanged) expense's month", async () => {
    const { orgId, asUser } = await setup();
    // PENDING so the update isn't blocked by the separate "posted expenses are
    // locked" guard, which would otherwise fire first and mask this check.
    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 2, 1),
      category: "FEES", status: "PENDING", isPrepaid: true, amortizationMonths: 12,
    });
    await expect(
      asUser.mutation(api.expenses.update, {
        orgId, expenseId, amortizationStartDate: Date.UTC(2026, 1, 1), // February — before March
      })
    ).rejects.toThrow(/cannot be earlier/i);
  });

  test("update rejects moving the expense date later than an already-set start date", async () => {
    const { orgId, asUser } = await setup();
    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId, title: "Insurance", amount: 1200, date: Date.UTC(2026, 2, 1),
      category: "FEES", status: "PENDING", isPrepaid: true, amortizationMonths: 12,
      amortizationStartDate: Date.UTC(2026, 2, 1),
    });
    await expect(
      asUser.mutation(api.expenses.update, {
        orgId, expenseId, date: Date.UTC(2026, 3, 1), // April — now after the existing March start date
      })
    ).rejects.toThrow(/cannot be earlier/i);
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

describe("expenses VAT split (Phase 41)", () => {
  async function setupFullyPosted() {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "VAT Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "vat_user", email: "vat@test.com", name: "Finance User" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Finance", permissions: [...PERMISSIONS, "manage:finance", "view:finance"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const asUser = t.withIdentity({ subject: "vat_user" });

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

  test("an expense with a VAT amount splits the ledger into net expense + VAT receivable", async () => {
    const { t, orgId, asUser } = await setupFullyPosted();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Office rent with VAT",
      amount: 1100,
      taxAmount: 100,
      date: Date.now(),
      category: "RENT",
    });

    await t.run(async (ctx) => {
      const expense = await ctx.db.get(expenseId);
      expect(expense?.taxAmount).toBe(100);

      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first();
      expect(event?.status).toBe("POSTED");
      expect(event?.journalEntryId).toBeDefined();

      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!))
        .collect();
      const totalDebit = lines.reduce((s, l) => s + l.debitMinor, 0);
      const totalCredit = lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBe(1_100_000);

      const vatAccount = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "VAT_RECEIVABLE"))
        .unique();
      expect(vatAccount).toBeTruthy();
      const vatLine = lines.find((l) => l.accountId === vatAccount!._id);
      expect(vatLine?.debitMinor).toBe(100_000);
    });
  });

  test("an expense without a VAT amount posts the plain two-line entry (unchanged behavior)", async () => {
    const { t, orgId, asUser } = await setupFullyPosted();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "No VAT",
      amount: 200,
      date: Date.now(),
      category: "OFFICE",
    });

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first();
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!))
        .collect();
      expect(lines).toHaveLength(2);
    });
  });

  test("a MARKETING expense debits the dedicated Marketing Expense account, not GENERAL_EXPENSE", async () => {
    const { t, orgId, asUser } = await setupFullyPosted();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Social ad spend",
      amount: 400,
      date: Date.now(),
      category: "MARKETING",
    });

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first();
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!))
        .collect();

      const marketingAccount = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "MARKETING_EXPENSE"))
        .unique();
      const generalAccount = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "GENERAL_EXPENSE"))
        .unique();
      expect(lines.find((l) => l.accountId === marketingAccount!._id)?.debitMinor).toBe(400_000);
      expect(lines.find((l) => l.accountId === generalAccount!._id)).toBeUndefined();
    });
  });

  test("self-heals a missing category account for a chart initialized before this addition", async () => {
    const { t, orgId, asUser } = await setupFullyPosted();

    // Simulate a pre-existing org's chart that predates the dedicated
    // expense-category accounts by deleting the one this expense will need.
    await t.run(async (ctx) => {
      const rentAccount = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "RENT_EXPENSE"))
        .unique();
      await ctx.db.delete(rentAccount!._id);
    });

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Showroom rent",
      amount: 900,
      date: Date.now(),
      category: "RENT",
    });

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
        .first();
      expect(event?.status).toBe("POSTED");

      const rentAccount = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "RENT_EXPENSE"))
        .unique();
      expect(rentAccount).toBeTruthy();

      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!))
        .collect();
      expect(lines.find((l) => l.accountId === rentAccount!._id)?.debitMinor).toBe(900_000);
    });
  });
});
