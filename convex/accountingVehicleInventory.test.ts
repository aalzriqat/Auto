/**
 * Tests for the five accounting-readiness fixes:
 *  1. Vehicle acquisition capitalizes into Vehicle Inventory (VEHICLE_ACQUIRED).
 *  2. Landed costs post their delta to Vehicle Inventory as they're edited.
 *  3. Vehicle-prep expenses (REPAIR/MAINTENANCE/DETAILING/TRANSPORT) capitalize
 *     into inventory instead of GENERAL_EXPENSE while the vehicle is in stock.
 *  4. COGS (SALE_COMPLETED) and commission gross profit share one cost basis
 *     (computeVehicleCapitalizedCost) instead of three different figures.
 *  5. Manually created receivables originate a real DR AR / CR Other Income entry.
 * Plus the opening-balance backfill migration for pre-existing inventory.
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

const PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "view:vehicles",
  "create:expenses", "edit:expenses", "view:expenses",
  "create:sales", "view:sales", "view:commissions", "manage:commissions",
  "view:finance", "manage:finance", "view:reports",
];

async function seedDealer(suffix: string) {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Inventory Dealer ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${suffix}`, email: `${suffix}@example.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId, commissionRate: 10 }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Jane", lastName: "Doe", email: `${suffix}.cust@example.com` })
  );

  const asOwner = t.withIdentity({ subject: `owner_${suffix}`, clerkId: `owner_${suffix}` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  // Wide enough to cover both explicit historical dates used in these tests
  // (2025) and Date.now() (used by hooks with no caller-supplied date, e.g.
  // vehicle acquisition and landed-cost edits).
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
    fiscalYear: 2025, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, roleId, asOwner, customerId };
}

type Ctx = Awaited<ReturnType<typeof seedDealer>>;

async function accountBySystemKey(t: Ctx["t"], orgId: Id<"organizations">, systemKey: string) {
  const account = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
  if (!account) throw new Error(`System account ${systemKey} not found`);
  return account;
}

async function linesForEvent(
  t: Ctx["t"],
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string,
  eventType: string
) {
  const event = await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId))
      .filter((q) => q.eq(q.field("eventType"), eventType))
      .first()
  );
  expect(event).not.toBeNull();
  expect(event!.status).toBe("POSTED");
  const entry = await t.run((ctx) => ctx.db.get(event!.journalEntryId!));
  const lines = await t.run((ctx) =>
    ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry!._id)).collect()
  );
  return { event: event!, entry: entry!, lines };
}

const baseVehicle = {
  vin: "1HGCM82633A000001",
  make: "Honda",
  model: "Accord",
  year: 2020,
  mileage: 10000,
  color: "White",
  fuelType: "Gasoline",
  transmission: "Automatic",
  sellingPrice: 20000,
  status: "AVAILABLE" as const,
  sourceType: "STOCK" as const,
};

describe("Fix #1 — vehicle acquisition capitalizes into Vehicle Inventory", () => {
  test("owned-stock purchase debits Vehicle Inventory and credits cash", async () => {
    const { t, orgId, asOwner } = await seedDealer("f1a");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_ACQUIRED");

    const invLine = lines.find((l) => l.accountId === inventory._id)!;
    const cashLine = lines.find((l) => l.accountId === cash._id)!;
    expect(invLine.debitMinor).toBe(10_000_000); // JOD scale 3
    expect(cashLine.creditMinor).toBe(10_000_000);

    const legacyTx = await t.run((ctx) =>
      ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).filter((q) => q.eq(q.field("category"), "VEHICLE_PURCHASE")).first()
    );
    expect(legacyTx?.amount).toBe(10000);
    expect(legacyTx?.type).toBe("OUT");
  });

  test("sourced/drop-ship vehicles never capitalize into inventory", async () => {
    const { t, orgId, asOwner } = await seedDealer("f1b");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "SRC3D9AN0000001AX", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 9000,
    });

    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .first()
    );
    expect(event).toBeNull();
  });

  test("purchasePrice is locked once acquisition has posted", async () => {
    const { orgId, asOwner } = await seedDealer("f1c");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
    });

    await expect(
      asOwner.mutation(api.vehicles.update, { orgId, vehicleId, purchasePrice: 12000, sourceType: "STOCK" })
    ).rejects.toThrow(/already been posted/);
  });
});

describe("Fix #2 — landed costs post their delta to Vehicle Inventory", () => {
  test("increasing landed costs debits inventory; decreasing them reverses the delta", async () => {
    const { t, orgId, asOwner } = await seedDealer("f2a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
    });

    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Transport", amount: 300 }, { label: "Detailing", amount: 200 }],
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const events1 = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts"))
        .collect()
    );
    expect(events1).toHaveLength(1);
    const lines1 = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", events1[0].journalEntryId!)).collect()
    );
    expect(lines1.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(500_000);

    // Edit down to 150 total — delta is -350, should reverse (credit inventory).
    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Transport", amount: 150 }],
    });

    const events2 = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts"))
        .collect()
    );
    expect(events2).toHaveLength(2);
    const secondEvent = events2.find((e) => e._id !== events1[0]._id)!;
    const lines2 = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", secondEvent.journalEntryId!)).collect()
    );
    expect(lines2.find((l) => l.accountId === inventory._id)?.creditMinor).toBe(350_000);
  });

  test("blocked once the vehicle is sold", async () => {
    const { t, orgId, asOwner } = await seedDealer("f2b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
    });
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "SOLD" }));

    await expect(
      asOwner.mutation(api.vehicles.upsertLandedCosts, { orgId, vehicleId, items: [{ label: "Late fee", amount: 50 }] })
    ).rejects.toThrow(/already been relieved/);
  });
});

describe("Fix #3 — vehicle-prep expenses capitalize into inventory", () => {
  test("REPAIR expense on an in-stock vehicle capitalizes; MARKETING does not", async () => {
    const { t, orgId, asOwner } = await seedDealer("f3a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
    });

    const repairExpenseId = await asOwner.mutation(api.expenses.create, {
      orgId, vehicleId, title: "Brake repair", amount: 400, date: Date.UTC(2025, 2, 1),
      category: "REPAIR", status: "PAID",
    });
    const marketingExpenseId = await asOwner.mutation(api.expenses.create, {
      orgId, vehicleId, title: "Listing boost", amount: 100, date: Date.UTC(2025, 2, 1),
      category: "MARKETING", status: "PAID",
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const generalExpense = await accountBySystemKey(t, orgId, "GENERAL_EXPENSE");

    const { lines: repairLines } = await linesForEvent(t, orgId, "expenses", repairExpenseId, "EXPENSE_POSTED");
    expect(repairLines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(400_000);
    expect(repairLines.some((l) => l.accountId === generalExpense._id)).toBe(false);

    const { lines: marketingLines } = await linesForEvent(t, orgId, "expenses", marketingExpenseId, "EXPENSE_POSTED");
    expect(marketingLines.find((l) => l.accountId === generalExpense._id)?.debitMinor).toBe(100_000);
    expect(marketingLines.some((l) => l.accountId === inventory._id)).toBe(false);
  });

  test("REPAIR expense on an already-sold vehicle falls back to GENERAL_EXPENSE", async () => {
    const { t, orgId, asOwner } = await seedDealer("f3b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
    });
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "SOLD" }));

    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, vehicleId, title: "Warranty repair after sale", amount: 150, date: Date.UTC(2025, 3, 1),
      category: "REPAIR", status: "PAID",
    });

    const generalExpense = await accountBySystemKey(t, orgId, "GENERAL_EXPENSE");
    const { lines } = await linesForEvent(t, orgId, "expenses", expenseId, "EXPENSE_POSTED");
    expect(lines.find((l) => l.accountId === generalExpense._id)?.debitMinor).toBe(150_000);
  });
});

describe("Fix #4 — one authoritative cost basis for COGS and commission", () => {
  test("COGS at sale equals purchase price + landed costs + capitalized expenses", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("f4a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
    });
    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Transport", amount: 300 }],
    });
    await asOwner.mutation(api.expenses.create, {
      orgId, vehicleId, title: "Detailing", amount: 200, date: Date.UTC(2025, 2, 1),
      category: "DETAILING", status: "PAID",
    });
    // Non-capitalizable — must NOT be part of COGS.
    await asOwner.mutation(api.expenses.create, {
      orgId, vehicleId, title: "Listing ad", amount: 999, date: Date.UTC(2025, 2, 1),
      category: "MARKETING", status: "PAID",
    });

    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    // Expected cost basis: 10000 + 300 + 200 = 10500 (marketing's 999 excluded).
    const { lines } = await linesForEvent(t, orgId, "sales", saleId, "SALE_COMPLETED");
    const cogs = await accountBySystemKey(t, orgId, "COST_OF_VEHICLES_SOLD");
    expect(lines.find((l) => l.accountId === cogs._id)?.debitMinor).toBe(10_500_000);

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    // Commission: 10% of (15000 - 10500) = 450.
    expect(sale?.commissionAmount).toBe(450);
  });
});

describe("Fix #5 — manual receivables originate a real GL entry", () => {
  test("createReceivable posts DR AR / CR Other Income", async () => {
    const { t, orgId, asOwner, customerId } = await seedDealer("f5a");

    const receivableId = await asOwner.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "OTHER", title: "Damage claim", amount: 250,
      dueDate: Date.UTC(2025, 4, 1),
    });

    const ar = await accountBySystemKey(t, orgId, "ACCOUNTS_RECEIVABLE_CUSTOMERS");
    const otherIncome = await accountBySystemKey(t, orgId, "MISCELLANEOUS_INCOME");
    const { lines } = await linesForEvent(t, orgId, "receivables", receivableId, "RECEIVABLE_CREATED");
    expect(lines.find((l) => l.accountId === ar._id)?.debitMinor).toBe(250_000);
    expect(lines.find((l) => l.accountId === otherIncome._id)?.creditMinor).toBe(250_000);
  });
});

describe("Opening-balance backfill for pre-existing inventory", () => {
  test("posts DR Vehicle Inventory / CR Retained Earnings for a vehicle that predates this fix", async () => {
    const { t, orgId, asOwner } = await seedDealer("bf1");

    // Simulate a vehicle that already existed before inventory capitalization
    // shipped: inserted directly, bypassing vehicles.create, so it has no
    // VEHICLE_ACQUIRED event — exactly the production gap being backfilled.
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "PREEXISTING0000001", make: "Toyota", model: "Camry", year: 2019,
        mileage: 40000, color: "Silver", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE", sourceType: "STOCK",
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false,
    });
    expect(result.posted).toBe(1);

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const retainedEarnings = await accountBySystemKey(t, orgId, "RETAINED_EARNINGS");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_INVENTORY_OPENING_BALANCE");
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(8_000_000);
    expect(lines.find((l) => l.accountId === retainedEarnings._id)?.creditMinor).toBe(8_000_000);

    // Re-running is a no-op (idempotent skip).
    const second = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false,
    });
    expect(second.posted).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test("skips already-sold vehicles", async () => {
    const { t, orgId, asOwner } = await seedDealer("bf2");
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "SOLDPREEXIST00001", make: "Toyota", model: "Corolla", year: 2018,
        mileage: 60000, color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 7000, sellingPrice: 10000, status: "SOLD", sourceType: "STOCK",
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false,
    });
    expect(result.posted).toBe(0);
  });
});
