/**
 * Synthetic public-handler replay of the guide's stock, bank, and cash sequence.
 * The balancing credit is test data only; it classifies no real opening difference.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { resetOrgToCompletion } from "../test-utils/orgResetFixtures";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

// The rate-limit component is absent from convex-test. This test measures
// financial handler effects only; production rate limiting is out of scope.
vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Synthetic Cutover Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "stock_cash_bank_owner", email: "stock-cash-bank@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner", isSystemOwnerRole: true,
      permissions: ["manage:finance", "view:finance", "create:vehicles", "edit:vehicles", "view:vehicles", "view:cost_price", "view:reports", "create:sales", "view:sales", "create:expenses", "edit:expenses"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const owner = t.withIdentity({ subject: "stock_cash_bank_owner", clerkId: "stock_cash_bank_owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year, periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const accountId = (systemKey: string) => {
    const account = accounts.find((row) => row.systemKey === systemKey);
    if (!account) throw new Error(`Missing synthetic fixture account ${systemKey}`);
    return account._id;
  };
  return { t, orgId, userId, owner, accountId };
}

describe("guide-required opening stock, bank, and cash replay", () => {
  test("an import without command identity cannot certify an opening inventory line", async () => {
    const { t, orgId, owner, accountId } = await seed();
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", vehicles: [{
        vin: "UNTRACKEDSTOCK001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK",
      }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    await expect(owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 8_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "stock-1",
        accountId: accountId("VEHICLE_INVENTORY"), vehicleId: listed.page[0]._id, amountMinor: 8_000_000 }],
    })).rejects.toThrow(/tracked opening import|proven owned vehicle/i);
    expect(await t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).length)).toBe(0);
  });

  test("tracked opening stock resists a stripped marker and a pre-parent sale", async () => {
    const { t, orgId, userId, owner, accountId } = await seed();
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" })
    );
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "stock-marker-check",
      vehicles: [{ rowId: 1, vin: "MARKERSTOCK00001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK" }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    await expect(owner.mutation(api.sales.create, {
      orgId, idempotencyKey: "sale-before-opening-parent", vehicleId,
      customerId, salespersonId: userId, salePrice: 15_000, saleDate: Date.now(), status: "COMPLETED",
    })).rejects.toThrow(/Opening stock cannot change or sell before/i);
    await expect(owner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Synthetic prep", amount: 100, paymentMethod: "CASH" }],
    })).rejects.toThrow(/Opening stock cannot change or sell before/i);
    await t.run((ctx) => ctx.db.patch(vehicleId, { openingStockImportId: undefined }));
    await expect(owner.mutation(api.vehicles.update, {
      orgId, vehicleId, purchasePrice: 9_000, purchasePaymentMethod: "CASH",
    })).rejects.toThrow(/Opening stock import proof is unavailable/i);
    await expect(owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 8_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "stock-1",
        accountId: accountId("VEHICLE_INVENTORY"), vehicleId, amountMinor: 8_000_000 }],
    })).rejects.toThrow(/cost, ownership or posting proof conflicts/i);
    expect(await t.run(async (ctx) => ({
      entries: (await ctx.db.query("journalEntries").collect()).length,
      events: (await ctx.db.query("accountingEvents").collect()).length,
      transactions: (await ctx.db.query("transactions").collect()).length,
    }))).toEqual({ entries: 0, events: 0, transactions: 0 });
  });

  test("tracked opening stock is unavailable to both dry and write inventory backfill", async () => {
    const { t, orgId, owner } = await seed();
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "stock-backfill-check",
      vehicles: [{ rowId: 1, vin: "BACKFILLSTOCK001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK" }],
    });
    const dry = await owner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: true, limit: 10,
    });
    const write = await owner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false, limit: 10,
    });
    expect(dry.results).toMatchObject([{ action: "NEEDS_REVIEW", reason: "opening_stock_bound_to_cutover" }]);
    expect(write.results).toMatchObject([{ action: "NEEDS_REVIEW", reason: "opening_stock_bound_to_cutover" }]);
    expect(await t.run(async (ctx) => ({
      entries: (await ctx.db.query("journalEntries").collect()).length,
      events: (await ctx.db.query("accountingEvents").collect()).length,
      transactions: (await ctx.db.query("transactions").collect()).length,
    }))).toEqual({ entries: 0, events: 0, transactions: 0 });
  });

  test("an owned opening cohort cannot be reclassified as consignment before posting", async () => {
    const { t, orgId, owner, accountId } = await seed();
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "stock-source-check",
      vehicles: [{ rowId: 1, vin: "SOURCETAMPER00001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK" }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    await expect(owner.mutation(api.vehicles.update, {
      orgId, vehicleId, sourceType: "SOURCED", sourcedFromName: "Synthetic Supplier", sourceCost: 8_000,
    })).rejects.toThrow(/Opening stock cannot change or sell before/i);
    await t.run((ctx) => ctx.db.patch(vehicleId, { sourceType: "SOURCED" }));
    await expect(owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 8_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "stock-1",
        accountId: accountId("VEHICLE_INVENTORY"), vehicleId, amountMinor: 8_000_000 }],
    })).rejects.toThrow(/cost, ownership or posting proof conflicts|imported opening car/i);
  });

  test("immutable import cost refuses a matching tampered allocation and journal", async () => {
    const { t, orgId, owner, accountId } = await seed();
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "stock-cost-tamper",
      vehicles: [{ rowId: 1, vin: "COSTTAMPERSTOCK1", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK" }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    await t.run((ctx) => ctx.db.patch(vehicleId, { purchasePrice: 9_000 }));
    expect(await owner.query(api.accountingCutover.listOpeningStockChoices, { orgId }))
      .toMatchObject([{ vehicleId, available: false, amountMinor: null }]);
    await expect(owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 9_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 9_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "tampered-stock-1",
        accountId: accountId("VEHICLE_INVENTORY"), vehicleId, amountMinor: 9_000_000 }],
    })).rejects.toThrow(/immutable import cost|posting proof conflicts/i);
    expect(await t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).length)).toBe(0);
  });

  test("financial reset leaves old opening stock unavailable instead of reusing its parent", async () => {
    const { t, orgId, userId, owner, accountId } = await seed();
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" })
    );
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "stock-reset-check",
      vehicles: [{ rowId: 1, vin: "RESETSTOCK000001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK" }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 8_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "stock-1",
        accountId: accountId("VEHICLE_INVENTORY"), vehicleId, amountMinor: 8_000_000 }],
    });
    await t.run((ctx) => ctx.db.patch(orgId, { suspended: true }));
    await resetOrgToCompletion(t, orgId, 50);
    await t.run((ctx) => ctx.db.patch(orgId, { suspended: false }));
    const readback = await owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId });
    expect(readback).toMatchObject({ journalStatus: "MISSING", rows: [{ kind: "VEHICLE_INVENTORY", recordAvailable: false }] });
    expect(await owner.query(api.accountingCutover.listOpeningStockChoices, { orgId }))
      .toMatchObject([{ vehicleId, available: false, amountMinor: null }]);
    await expect(owner.mutation(api.sales.create, {
      orgId, idempotencyKey: "sale-after-opening-reset", vehicleId, customerId, salespersonId: userId,
      salePrice: 15_000, saleDate: Date.now(), status: "COMPLETED",
    })).rejects.toThrow(/predates a financial reset/i);
    await owner.mutation(api.chartOfAccounts.initialize, { orgId });
    const replacementAccounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
    const replacement = (systemKey: string) => {
      const account = replacementAccounts.find((row) => row.systemKey === systemKey);
      if (!account) throw new Error(`Missing replacement synthetic account ${systemKey}`);
      return account._id;
    };
    await expect(owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [
        { accountId: replacement("VEHICLE_INVENTORY"), debitMinor: 8_000_000, creditMinor: 0 },
        { accountId: replacement("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "reset-stock-1",
        accountId: replacement("VEHICLE_INVENTORY"), vehicleId, amountMinor: 8_000_000 }],
    })).rejects.toThrow(/cost, ownership or posting proof conflicts|financial reset/i);
    expect(await t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).length)).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("vehicles").collect()).length)).toBe(1);
  });

  test("a reversed opening journal claim cannot leave inventory available to sale or readback", async () => {
    const { t, orgId, userId, owner, accountId } = await seed();
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" })
    );
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "stock-reversal-check",
      vehicles: [{ rowId: 1, vin: "REVERSEDSTOCK001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK" }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 8_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "reversed-stock-1",
        accountId: accountId("VEHICLE_INVENTORY"), vehicleId, amountMinor: 8_000_000 }],
    });
    await t.run(async (ctx) => {
      const journal = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!journal) throw new Error("Missing synthetic opening journal");
      await ctx.db.patch(journal._id, { status: "REVERSED" });
    });
    const readback = await owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId });
    expect(readback).toMatchObject({ journalStatus: "REVERSED", rows: [{ kind: "VEHICLE_INVENTORY", recordAvailable: false }] });
    await expect(owner.mutation(api.sales.create, {
      orgId, idempotencyKey: "sale-after-opening-reversal-claim", vehicleId, customerId, salespersonId: userId,
      salePrice: 15_000, saleDate: Date.now(), status: "COMPLETED",
    })).rejects.toThrow(/journal proof is unavailable/i);
  });

  test("capitalizable expense waits for stock basis, then posts and reverses without changing original import cost", async () => {
    const { t, orgId, userId, owner, accountId } = await seed();
    const asOfDate = Date.now();
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" })
    );
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "stock-repair-check",
      vehicles: [{ rowId: 1, vin: "REPAIRSTOCK00001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK" }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    const expense = { orgId, vehicleId, title: "Synthetic repair", amount: 100,
      date: asOfDate, category: "REPAIR" as const, status: "PAID" as const, paymentMethod: "CASH" as const };
    await expect(owner.mutation(api.expenses.create, {
      ...expense, idempotencyKey: "preparent-repair",
    })).rejects.toThrow(/Opening stock cannot change or sell before/i);
    const pendingExpenseId = await owner.mutation(api.expenses.create, {
      ...expense, status: "PENDING", idempotencyKey: "preparent-pending-repair",
    });
    await expect(owner.mutation(api.expenses.update, {
      orgId, expenseId: pendingExpenseId, status: "PAID", paymentMethod: "CASH",
    })).rejects.toThrow(/Opening stock cannot change or sell before/i);
    expect(await t.run(async (ctx) => ({
      pending: (await ctx.db.get(pendingExpenseId))?.status,
      transactions: (await ctx.db.query("transactions").collect()).length,
      events: (await ctx.db.query("accountingEvents").collect()).length,
    }))).toEqual({ pending: "PENDING", transactions: 0, events: 0 });
    await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate,
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 8_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY", rowKey: "repair-stock-1",
        accountId: accountId("VEHICLE_INVENTORY"), vehicleId, amountMinor: 8_000_000 }],
    });
    const expenseId = await owner.mutation(api.expenses.create, {
      ...expense, idempotencyKey: "postparent-repair",
    });
    expect(await owner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId }))
      .toMatchObject({ isReconciled: true, byCurrency: { JOD: { glBalanceMinor: 8_100_000,
        subledgerBalanceMinor: 8_100_000 } } });
    expect(await owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId }))
      .toMatchObject({ rows: [{ kind: "VEHICLE_INVENTORY", recordAvailable: true }] });
    await expect(owner.mutation(api.sales.create, {
      orgId, idempotencyKey: "sale-before-stock-basis-after-repair", vehicleId, customerId,
      salespersonId: userId, salePrice: 15_000, saleDate: asOfDate - 1, status: "COMPLETED",
    })).rejects.toThrow(/before its opening inventory basis date/i);
    await owner.mutation(api.expenses.reverseExpense, { orgId, expenseId, reason: "Synthetic reversal" });
    expect(await owner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId }))
      .toMatchObject({ isReconciled: true, byCurrency: { JOD: { glBalanceMinor: 8_000_000,
        subledgerBalanceMinor: 8_000_000 } } });
    expect(await owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId }))
      .toMatchObject({ rows: [{ kind: "VEHICLE_INVENTORY", recordAvailable: true }] });
  });
  test("a direct cash sale without collected consideration is already refused before opening stock is posted", async () => {
    const { t, orgId, userId, owner } = await seed();
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" })
    );
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{
        vin: "CUTOVERSALE000001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK",
      }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    let refusalMessage = "";
    try {
      await owner.mutation(api.sales.create, {
        orgId, idempotencyKey: "opening-unposted-sale", vehicleId, customerId, salespersonId: userId,
        salePrice: 15_000, saleDate: Date.now(), status: "COMPLETED",
      });
    } catch (error) {
      refusalMessage = String(error);
    }
    const effects = await t.run(async (ctx) => ({
      sales: (await ctx.db.query("sales").collect()).length,
      events: (await ctx.db.query("accountingEvents").collect()).length,
      entries: (await ctx.db.query("journalEntries").collect()).length,
    }));
    expect(effects).toEqual({ sales: 0, events: 0, entries: 0 });
    expect(refusalMessage).toMatch(/CASH_SALE_BALANCE_UNPAID_REFUSED/);
  });

  test("editing an imported opening car before its parent cannot originate a new purchase", async () => {
    const { t, orgId, owner } = await seed();
    await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "opening-cost-edit",
      vehicles: [{
        rowId: 1,
        vin: "CUTOVEREDIT000001", make: "Example", model: "Stock", year: 2024,
        color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 15_000, purchasePrice: 8_000, sourceType: "STOCK",
      }],
    });
    const listed = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 10 },
    });
    const vehicleId = listed.page[0]._id;
    let refusalMessage = "";
    try {
      await owner.mutation(api.vehicles.update, {
        orgId, vehicleId, purchasePrice: 9_000, purchasePaymentMethod: "CASH",
      });
    } catch (error) {
      refusalMessage = String(error);
    }
    const financialWrites = await t.run(async (ctx) => ({
      events: (await ctx.db.query("accountingEvents").collect()).length,
      entries: (await ctx.db.query("journalEntries").collect()).length,
      transactions: (await ctx.db.query("transactions").collect()).length,
    }));
    expect(financialWrites).toEqual({ events: 0, entries: 0, transactions: 0 });
    expect(refusalMessage).toMatch(/opening stock|opening balance/i);
  });

  test("two physical banks and cash drawer read back the posted opening without extra cash activity", async () => {
    const { t, orgId, owner, accountId } = await seed();
    const asOfDate = Date.now();
    const bankA = await owner.mutation(api.bankAccounts.create, {
      orgId, name: "Synthetic Bank A", currency: "JOD", openingBalanceMinor: 4_000_000,
      openingBalanceDate: asOfDate, isReconciliationTarget: true,
    });
    const bankB = await owner.mutation(api.bankAccounts.create, {
      orgId, name: "Synthetic Bank B", currency: "JOD", openingBalanceMinor: 3_000_000,
      openingBalanceDate: asOfDate,
    });
    await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate,
      lines: [
        { accountId: accountId("BANK_ACCOUNT"), debitMinor: 4_000_000, creditMinor: 0, bankAccountId: bankA },
        { accountId: accountId("BANK_ACCOUNT"), debitMinor: 3_000_000, creditMinor: 0, bankAccountId: bankB },
        { accountId: accountId("CASH_ON_HAND"), debitMinor: 1_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 8_000_000 },
      ],
    });

    const banks = await owner.query(api.bankAccounts.list, { orgId });
    expect(banks.map((bank) => [bank._id, bank.openingBalanceMinor]).sort()).toEqual(
      [[bankA, 4_000_000], [bankB, 3_000_000]].sort()
    );
    expect(await owner.query(api.bankAccounts.getBookBalance, { orgId })).toMatchObject({
      status: "OK", bankAccountId: bankA, balanceMinor: 4_000_000, unattributedLineCount: 0,
    });
    await owner.mutation(api.bankAccounts.setReconciliationTarget, { orgId, bankAccountId: bankB });
    expect(await owner.query(api.bankAccounts.getBookBalance, { orgId })).toMatchObject({
      status: "OK", bankAccountId: bankB, balanceMinor: 3_000_000, unattributedLineCount: 0,
    });

    const sessionId = await owner.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 1_000_000 });
    expect(await owner.query(api.cashDrawer.list, { orgId })).toMatchObject([
      { _id: sessionId, status: "OPEN", openingFloatMinor: 1_000_000 },
    ]);
    const trialBalance = await owner.query(api.accountingReports.trialBalance, { orgId });
    expect(trialBalance.rows.find((row) => row.accountId === accountId("CASH_ON_HAND"))?.netMinor).toBe(1_000_000);
    expect(trialBalance.isBalanced).toBe(true);
    expect(await t.run(async (ctx) => ({
      entries: (await ctx.db.query("journalEntries").collect()).length,
      transactions: (await ctx.db.query("transactions").collect()).length,
      movements: (await ctx.db.query("cashMovements").collect()).length,
    }))).toEqual({ entries: 1, transactions: 0, movements: 0 });
  });

  test("itemized stock and physical cash/banks reconcile to one posted opening without new purchase or receipt", async () => {
    const { t, orgId, owner, accountId } = await seed();
    const asOfDate = Date.now();
    const stockRows = [
      { rowId: 1, vin: "CUTOVERSTOCK00001", purchasePrice: 8_000 },
      { rowId: 2, vin: "CUTOVERSTOCK00002", purchasePrice: 9_000 },
      { rowId: 3, vin: "CUTOVERSTOCK00003", purchasePrice: 10_000 },
    ].map((row) => ({
      ...row, make: "Example", model: "Stock", year: 2024, color: "Blue",
      fuelType: "Petrol", transmission: "Automatic", sellingPrice: 15_000, sourceType: "STOCK",
    }));

    const firstImport = await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "opening-stock-and-cash", vehicles: stockRows,
    });
    expect(firstImport).toMatchObject({ inserted: 3, skipped: 0 });
    expect(await owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", importId: "opening-stock-and-cash", vehicles: stockRows,
    })).toMatchObject({ inserted: 0, skipped: 3 });

    const stock = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 20 },
    });
    const allocatedStock = stock.page.map((vehicle, index) => ({
      kind: "VEHICLE_INVENTORY" as const, rowKey: `stock-${index + 1}`,
      accountId: accountId("VEHICLE_INVENTORY"), vehicleId: vehicle._id,
      amountMinor: (vehicle.purchasePrice ?? 0) * 1_000,
    }));

    const bankA = await owner.mutation(api.bankAccounts.create, {
      orgId, name: "Synthetic Bank A", currency: "JOD", openingBalanceMinor: 4_000_000,
      openingBalanceDate: asOfDate, isReconciliationTarget: true,
    });
    const bankB = await owner.mutation(api.bankAccounts.create, {
      orgId, name: "Synthetic Bank B", currency: "JOD", openingBalanceMinor: 3_000_000,
      openingBalanceDate: asOfDate,
    });

    const beforePost = await t.run(async (ctx) => ({
      entries: (await ctx.db.query("journalEntries").collect()).length,
      transactions: (await ctx.db.query("transactions").collect()).length,
      events: (await ctx.db.query("accountingEvents").collect()).length,
    }));
    expect(beforePost).toEqual({ entries: 0, transactions: 0, events: 0 });

    await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId, expectedCurrency: "JOD", asOfDate, allocations: allocatedStock,
      lines: [
        { accountId: accountId("VEHICLE_INVENTORY"), debitMinor: 27_000_000, creditMinor: 0 },
        { accountId: accountId("BANK_ACCOUNT"), debitMinor: 4_000_000, creditMinor: 0, bankAccountId: bankA },
        { accountId: accountId("BANK_ACCOUNT"), debitMinor: 3_000_000, creditMinor: 0, bankAccountId: bankB },
        { accountId: accountId("CASH_ON_HAND"), debitMinor: 1_000_000, creditMinor: 0 },
        { accountId: accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 35_000_000 },
      ],
    });

    const vehicles = await owner.query(api.vehicles.list, {
      orgId, status: "AVAILABLE", paginationOpts: { cursor: null, numItems: 20 },
    });
    expect(vehicles.page).toHaveLength(3);
    expect(vehicles.page.reduce((sum, car) => sum + (car.purchasePrice ?? 0), 0)).toBe(27_000);
    const inventory = await owner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId });
    expect(inventory.isReconciled).toBe(true);
    expect(inventory.byCurrency.JOD).toMatchObject({ glBalanceMinor: 27_000_000, subledgerBalanceMinor: 27_000_000 });

    const registeredBanks = await owner.query(api.bankAccounts.list, { orgId });
    expect(registeredBanks.map((bank) => [bank._id, bank.openingBalanceMinor]).sort()).toEqual(
      [[bankA, 4_000_000], [bankB, 3_000_000]].sort()
    );
    expect(await owner.query(api.bankAccounts.getBookBalance, { orgId })).toMatchObject({
      status: "OK", bankAccountId: bankA, balanceMinor: 4_000_000, unattributedLineCount: 0,
    });
    await owner.mutation(api.bankAccounts.setReconciliationTarget, { orgId, bankAccountId: bankB });
    expect(await owner.query(api.bankAccounts.getBookBalance, { orgId })).toMatchObject({
      status: "OK", bankAccountId: bankB, balanceMinor: 3_000_000, unattributedLineCount: 0,
    });

    const sessionId = await owner.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 1_000_000 });
    expect(await owner.query(api.cashDrawer.list, { orgId })).toMatchObject([
      { _id: sessionId, status: "OPEN", openingFloatMinor: 1_000_000 },
    ]);
    const trialBalance = await owner.query(api.accountingReports.trialBalance, { orgId });
    const cash = trialBalance.rows.find((row) => row.accountId === accountId("CASH_ON_HAND"));
    expect(cash?.netMinor).toBe(1_000_000);
    expect(trialBalance.isBalanced).toBe(true);

    const afterReadback = await t.run(async (ctx) => ({
      entries: (await ctx.db.query("journalEntries").collect()).length,
      transactions: (await ctx.db.query("transactions").collect()).length,
      events: (await ctx.db.query("accountingEvents").collect()).length,
      movements: (await ctx.db.query("cashMovements").collect()).length,
    }));
    expect(afterReadback).toEqual({ entries: 1, transactions: 0, events: 0, movements: 0 });
  });
});
