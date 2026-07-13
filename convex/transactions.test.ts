import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

async function setupLedgerOrg() {
  const t = convexTest(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Ledger Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "ledger_manager",
      email: "ledger-manager@example.com",
      name: "Ledger Manager",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asManager = t.withIdentity({ subject: "ledger_manager" });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Dana",
      lastName: "Saleh",
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "LEDGERTRAN001",
      make: "Hyundai",
      model: "Tucson",
      year: 2022,
      mileage: 18_000,
      color: "Black",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 18_000,
      status: "AVAILABLE",
    })
  );

  return { t, orgId, userId, customerId, vehicleId, asManager };
}

describe("transactions ledger", () => {
  test("add_is_idempotent_and_list_enriches_vehicle_context", async () => {
    const { orgId, vehicleId, asManager } = await setupLedgerOrg();
    const date = Date.now();

    const transactionId = await asManager.mutation(api.transactions.add, {
      orgId,
      type: "IN",
      amount: 750,
      date,
      category: "DEPOSIT",
      description: "Deposit held for walk-in customer",
      vehicleId,
      idempotencyKey: "deposit-ledger-1",
    });
    const repeatedId = await asManager.mutation(api.transactions.add, {
      orgId,
      type: "IN",
      amount: 999,
      date,
      category: "DEPOSIT",
      description: "Should not create a second row",
      vehicleId,
      idempotencyKey: "deposit-ledger-1",
    });

    expect(repeatedId).toBe(transactionId);

    const page = await asManager.query(api.transactions.list, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(1);
    expect(page.page[0]).toMatchObject({
      _id: transactionId,
      amount: 750,
      vehicleLabel: "2022 Hyundai Tucson",
    });
  });

  test("update_and_remove_keep_transactions_auditable_but_hidden_from_list", async () => {
    const { t, orgId, vehicleId, asManager } = await setupLedgerOrg();
    const transactionId = await asManager.mutation(api.transactions.add, {
      orgId,
      type: "OUT",
      amount: 400,
      date: Date.now(),
      category: "EXPENSE",
      description: "Initial expense",
      vehicleId,
    });

    await asManager.mutation(api.transactions.update, {
      orgId,
      transactionId,
      amount: 425,
      description: "Updated expense",
    });
    await asManager.mutation(api.transactions.remove, { orgId, transactionId });

    const page = await asManager.query(api.transactions.list, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page).toHaveLength(0);

    await t.run(async (ctx) => {
      const transaction = await ctx.db.get(transactionId);
      expect(transaction).toMatchObject({
        amount: 425,
        description: "Updated expense",
        isDeleted: true,
        deletedBy: "ledger_manager",
      });
      expect(transaction?.deletedAt).toBeTypeOf("number");
    });
  });

  test("list_applies_date_window_when_both_bounds_are_present", async () => {
    const { orgId, asManager } = await setupLedgerOrg();
    const olderDate = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const currentDate = Date.now();

    await asManager.mutation(api.transactions.add, {
      orgId,
      type: "IN",
      amount: 100,
      date: olderDate,
      category: "OTHER",
      description: "Outside reporting window",
    });
    const currentTransactionId = await asManager.mutation(api.transactions.add, {
      orgId,
      type: "IN",
      amount: 200,
      date: currentDate,
      category: "OTHER",
      description: "Inside reporting window",
    });

    const page = await asManager.query(api.transactions.list, {
      orgId,
      startDate: currentDate - 1_000,
      endDate: currentDate + 1_000,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page.map((transaction) => transaction._id)).toEqual([currentTransactionId]);
  });

  test("list_enriches_deposit_rows_from_deposit_context", async () => {
    const { t, orgId, userId, customerId, vehicleId, asManager } = await setupLedgerOrg();
    const depositId = await t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        amount: 500,
        amountMinor: 500_000,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 500,
        date: Date.now(),
        category: "DEPOSIT",
        description: "Deposit held for sourced vehicle",
        depositId,
      })
    );

    const page = await asManager.query(api.transactions.list, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page[0]).toMatchObject({
      _id: transactionId,
      customerName: "Dana Saleh",
      vehicleLabel: "2022 Hyundai Tucson",
    });
  });

  test("list_ignores_deleted_deposit_context_but_enriches_legacy_quote_descriptions", async () => {
    const { t, orgId, userId, customerId, vehicleId, asManager } = await setupLedgerOrg();
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 18_000,
        downPayment: 1_000,
        termMonths: 36,
        status: "DRAFT",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    const deletedDepositId = await t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        amount: 500,
        amountMinor: 500_000,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        isDeleted: true,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    const deletedDepositTransactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 500,
        date: Date.now(),
        category: "DEPOSIT",
        description: "Deposit held for deleted deposit",
        depositId: deletedDepositId,
      })
    );
    const legacyQuoteTransactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 600,
        date: Date.now() + 1,
        category: "DEPOSIT",
        description: `Deposit for quote ${quoteId}`,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 700,
        date: Date.now() + 2,
        category: "DEPOSIT",
        description: "Deposit for quote not-a-valid-id",
      })
    );

    const page = await asManager.query(api.transactions.list, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    const deletedDepositRow = page.page.find((transaction) => transaction._id === deletedDepositTransactionId);
    expect(deletedDepositRow).not.toHaveProperty("customerName");
    expect(deletedDepositRow).not.toHaveProperty("vehicleLabel");

    const legacyQuoteRow = page.page.find((transaction) => transaction._id === legacyQuoteTransactionId);
    expect(legacyQuoteRow).toMatchObject({
      customerName: "Dana Saleh",
      vehicleLabel: "2022 Hyundai Tucson",
      quoteReference: quoteId.toString(),
    });
  });

  test("rejects_cross_org_vehicle_references", async () => {
    const { t, orgId, asManager } = await setupLedgerOrg();
    const otherVehicleId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Ledger Dealer", createdAt: Date.now() });
      return await ctx.db.insert("vehicles", {
        orgId: otherOrgId,
        vin: "OTHERLEDGER001",
        make: "Ford",
        model: "Escape",
        year: 2021,
        mileage: 25_000,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 15_000,
        status: "AVAILABLE",
      });
    });

    await expect(
      asManager.mutation(api.transactions.add, {
        orgId,
        type: "OUT",
        amount: 500,
        date: Date.now(),
        category: "VEHICLE_PURCHASE",
        description: "Wrong org vehicle",
        vehicleId: otherVehicleId,
      })
    ).rejects.toThrow(/vehicle not found/i);
  });

  test("rejects_cross_org_expense_references_on_add_and_update", async () => {
    const { t, orgId, vehicleId, asManager } = await setupLedgerOrg();
    const otherOrgReferences = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Expense Dealer", createdAt: Date.now() });
      const otherVehicleId = await ctx.db.insert("vehicles", {
        orgId: otherOrgId,
        vin: "OTHERLEDGER002",
        make: "Ford",
        model: "Explorer",
        year: 2020,
        mileage: 44_000,
        color: "Gray",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 16_000,
        status: "AVAILABLE",
      });
      const otherExpenseId = await ctx.db.insert("expenses", {
        orgId: otherOrgId,
        title: "Other org expense",
        amount: 200,
        date: Date.now(),
        category: "OTHER",
      });
      return { otherVehicleId, otherExpenseId };
    });

    await expect(
      asManager.mutation(api.transactions.add, {
        orgId,
        type: "OUT",
        amount: 200,
        date: Date.now(),
        category: "EXPENSE",
        description: "Wrong org expense",
        expenseId: otherOrgReferences.otherExpenseId,
      })
    ).rejects.toThrow(/expense not found/i);

    const transactionId = await asManager.mutation(api.transactions.add, {
      orgId,
      type: "OUT",
      amount: 300,
      date: Date.now(),
      category: "EXPENSE",
      description: "Local transaction",
      vehicleId,
    });

    await expect(
      asManager.mutation(api.transactions.update, {
        orgId,
        transactionId,
        vehicleId: otherOrgReferences.otherVehicleId,
      })
    ).rejects.toThrow(/vehicle not found/i);

    await expect(
      asManager.mutation(api.transactions.update, {
        orgId,
        transactionId,
        expenseId: otherOrgReferences.otherExpenseId,
      })
    ).rejects.toThrow(/expense not found/i);
  });

  test("update_and_remove_reject_transactions_from_another_organization", async () => {
    const { t, orgId, asManager } = await setupLedgerOrg();
    const otherTransactionId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Transaction Dealer", createdAt: Date.now() });
      return await ctx.db.insert("transactions", {
        orgId: otherOrgId,
        type: "IN",
        amount: 100,
        date: Date.now(),
        category: "OTHER",
        description: "Other org transaction",
      });
    });

    await expect(
      asManager.mutation(api.transactions.update, {
        orgId,
        transactionId: otherTransactionId,
        amount: 125,
      })
    ).rejects.toThrow(/transaction not found/i);

    await expect(
      asManager.mutation(api.transactions.remove, {
        orgId,
        transactionId: otherTransactionId,
      })
    ).rejects.toThrow(/transaction not found/i);
  });
});
