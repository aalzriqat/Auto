/**
 * Phase 4 integration tests: verifies that domain mutations (deposits, sales,
 * collections, expenses) automatically emit accounting events when a chart of
 * accounts and an open accounting period are configured.
 *
 * All hooks are no-ops when no chart/period exists, so existing tests are unaffected.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedPhase4Dealer() {
  const t = convexTest(schema, MODULE_GLOB);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase 4 Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p4_user", email: "p4@example.com", name: "P4 User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: [
        "view:sales", "manage:finance", "view:finance", "manage:vehicles",
        "create:expenses", "view:expenses", "approve:requests",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD",
      enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "P4", lastName: "Customer" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, make: "Toyota", model: "Camry", year: 2023, vin: "P4VIN001",
      status: "AVAILABLE", purchasePrice: 15000, sellingPrice: 20000,
      mileage: 0, color: "White", fuelType: "Petrol", transmission: "Automatic",
      isDeleted: false, createdAt: Date.now(),
    })
  );
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, vehicleId, customerId, vehiclePrice: 20000, downPayment: 0, termMonths: 0,
      status: "DRAFT", createdBy: userId, createdAt: Date.now(),
    })
  );

  const asUser = t.withIdentity({ subject: "p4_user", clerkId: "p4_user" });

  // Initialize chart of accounts + open period
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.now() - 30 * 86400_000,
    endDate: Date.now() + 30 * 86400_000,
    fiscalYear: 2026,
    periodNumber: 1,
  });
  await asUser.mutation(api.accountingPeriods.open, {
    orgId,
    periodId: (await asUser.query(api.accountingPeriods.list, { orgId }))[0]._id,
  });

  return { t, orgId, userId, customerId, vehicleId, quoteId, asUser };
}

async function seedWithoutPeriod() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "NoPeriod Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "np_user", email: "np@example.com", name: "NP User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:sales", "manage:finance", "view:finance", "create:expenses", "view:expenses"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "np_user", clerkId: "np_user" });
  return { t, orgId, userId, asUser };
}

describe("Phase 4 — hooks emit events when chart + period configured", () => {
  test("expense creation emits EXPENSE_POSTED accounting event", async () => {
    const { orgId, asUser } = await seedPhase4Dealer();
    const now = Date.now();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Office Supplies",
      amount: 100,
      date: now,
      category: "OFFICE",
      status: "PAID",
    });

    const events = await asUser.query(api.accountingLedger.listAccountingEvents, {
      orgId,
      sourceType: "expenses",
      sourceId: expenseId.toString(),
    });

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("EXPENSE_POSTED");
    expect(events[0].status).toBe("POSTED");
  });

  test("expense event produces balanced journal entry", async () => {
    const { orgId, asUser } = await seedPhase4Dealer();
    const now = Date.now();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Marketing Banner",
      amount: 250,
      date: now,
      category: "MARKETING",
      status: "PAID",
    });

    const events = await asUser.query(api.accountingLedger.listAccountingEvents, {
      orgId, sourceType: "expenses", sourceId: expenseId.toString(),
    });
    expect(events).toHaveLength(1);

    const je = await asUser.query(api.accountingLedger.getJournalEntry, {
      orgId,
      journalEntryId: events[0].journalEntryId!,
    });
    expect(je).not.toBeNull();

    const totalDebits = je!.lines.reduce((s, l) => s + l.debitMinor, 0);
    const totalCredits = je!.lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(totalDebits).toBe(totalCredits);
    expect(totalDebits).toBeGreaterThan(0);
  });
});

describe("Phase 4 — hooks are no-ops without accounting period", () => {
  test("expense creation succeeds even without a period (backward-compatible)", async () => {
    const { orgId, asUser } = await seedWithoutPeriod();

    const expenseId = await asUser.mutation(api.expenses.create, {
      orgId,
      title: "Legacy Expense",
      amount: 50,
      date: Date.now(),
      category: "OTHER",
      status: "PAID",
    });

    expect(expenseId).toBeTruthy();

    const events = await asUser.query(api.accountingLedger.listAccountingEvents, {
      orgId, sourceType: "expenses", sourceId: expenseId.toString(),
    });
    expect(events).toHaveLength(0);
  });
});
