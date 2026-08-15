import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

async function setupLedgerOrg() {
  const t = convexTestWithComponents(schema, MODULES);
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

  /**
   * Cashbook rows are created by the domain workflows that own them (a sale, an
   * expense, a collection, a deposit, a work order), never by a public mutation
   * — SCRUM-53 removed `transactions.add` for exactly that reason. These tests
   * insert the row the same way those modules do.
   */
  async function recordCashbookRow(
    fields: Partial<Doc<"transactions">> & Pick<Doc<"transactions">, "type" | "amount" | "date" | "category" | "description">
  ) {
    return await t.run((ctx) => ctx.db.insert("transactions", { orgId, ...fields }));
  }

  return { t, orgId, userId, customerId, vehicleId, asManager, recordCashbookRow };
}

describe("transactions ledger", () => {
  test("list_enriches_vehicle_context", async () => {
    const { orgId, vehicleId, asManager, recordCashbookRow } = await setupLedgerOrg();

    const transactionId = await recordCashbookRow({
      type: "IN",
      amount: 750,
      date: Date.now(),
      category: "DEPOSIT",
      description: "Deposit held for walk-in customer",
      vehicleId,
    });

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

  test("a soft-deleted row stays on record but leaves the list", async () => {
    // Soft-deleted by the domain workflow that owns the row (SCRUM-53 removed
    // the public edit/delete mutations), so this asserts what `list` does with
    // the result: the row is hidden from the cashbook view while remaining in
    // the table for audit.
    const { t, orgId, vehicleId, asManager, recordCashbookRow } = await setupLedgerOrg();
    const transactionId = await recordCashbookRow({
      type: "OUT",
      amount: 400,
      date: Date.now(),
      category: "EXPENSE",
      description: "Initial expense",
      vehicleId,
    });

    await t.run((ctx) =>
      ctx.db.patch(transactionId, {
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: "ledger_manager",
      })
    );

    const page = await asManager.query(api.transactions.list, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page).toHaveLength(0);

    await t.run(async (ctx) => {
      const transaction = await ctx.db.get(transactionId);
      expect(transaction).toMatchObject({
        amount: 400,
        description: "Initial expense",
        isDeleted: true,
        deletedBy: "ledger_manager",
      });
      expect(transaction?.deletedAt).toBeTypeOf("number");
    });
  });

  test("list_applies_date_window_when_both_bounds_are_present", async () => {
    const { orgId, asManager, recordCashbookRow } = await setupLedgerOrg();
    const olderDate = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const currentDate = Date.now();

    await recordCashbookRow({
      type: "IN",
      amount: 100,
      date: olderDate,
      category: "OTHER",
      description: "Outside reporting window",
    });
    const currentTransactionId = await recordCashbookRow({
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

  test("list_never_returns_another_organizations_cashbook", async () => {
    // The cross-org tests that used to sit here exercised `update`/`remove`,
    // which SCRUM-53 removed. The tenancy concern they encoded still applies to
    // the surface that survived, so it is asserted there instead of dropped.
    const { t, orgId, asManager, recordCashbookRow } = await setupLedgerOrg();

    await recordCashbookRow({
      type: "IN",
      amount: 300,
      date: Date.now(),
      category: "OTHER",
      description: "Our own counter cash",
    });

    const otherTransactionId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", {
        name: "Other Transaction Dealer",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("transactions", {
        orgId: otherOrgId,
        type: "IN",
        amount: 100,
        date: Date.now(),
        category: "OTHER",
        description: "Other org transaction",
      });
    });

    const page = await asManager.query(api.transactions.list, {
      orgId,
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(page.page.map((row) => row._id)).not.toContain(otherTransactionId);
    expect(page.page).toHaveLength(1);
    expect(page.page[0].description).toBe("Our own counter cash");
  });
});
