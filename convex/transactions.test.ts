import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

/**
 * `transactions` is a read-only cash-movement projection: SCRUM-53 retired the
 * generic add/update/remove doors because they changed this list without
 * changing the authoritative books. Rows here are written by the domain
 * workflow that owns the accounting event, which is what these fixtures model.
 */
const RETIRED = /view only and is not the General Ledger/i;

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

  return { t, orgId, userId, customerId, vehicleId, asManager };
}

describe("transactions ledger", () => {
  test("list_enriches_vehicle_context", async () => {
    const { t, orgId, vehicleId, asManager } = await setupLedgerOrg();
    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN" as const,
        amount: 750,
        date: Date.now(),
        category: "DEPOSIT" as const,
        description: "Deposit held for walk-in customer",
        vehicleId,
      })
    );

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

  test("a soft-deleted row is hidden from the projection but retained for audit", async () => {
    const { t, orgId, vehicleId, asManager } = await setupLedgerOrg();
    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "OUT" as const,
        amount: 425,
        date: Date.now(),
        category: "EXPENSE" as const,
        description: "Voided expense",
        vehicleId,
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
        amount: 425,
        description: "Voided expense",
        isDeleted: true,
        deletedBy: "ledger_manager",
      });
      expect(transaction?.deletedAt).toBeTypeOf("number");
    });
  });
  test("list_applies_date_window_when_both_bounds_are_present", async () => {
    const { t, orgId, asManager } = await setupLedgerOrg();
    const olderDate = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const currentDate = Date.now();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN" as const,
        amount: 100,
        date: olderDate,
        category: "OTHER" as const,
        description: "Outside reporting window",
      })
    );
    const currentTransactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN" as const,
        amount: 200,
        date: currentDate,
        category: "OTHER" as const,
        description: "Inside reporting window",
      })
    );

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

  test("the write doors refuse even when the arguments cross an organization", async () => {
    // These three doors used to carry their own cross-org checks on
    // vehicleId, expenseId and transactionId. SCRUM-53 retired the doors
    // outright, so those checks no longer exist and could not be reached if
    // they did. What must still hold is the property they existed to protect:
    // nothing another organization owns can be reached through this surface.
    const { t, orgId, asManager } = await setupLedgerOrg();
    const foreign = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", {
        name: "Other Ledger Dealer",
        createdAt: Date.now(),
      });
      const vehicleId = await ctx.db.insert("vehicles", {
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
      const expenseId = await ctx.db.insert("expenses", {
        orgId: otherOrgId,
        title: "Other org expense",
        amount: 200,
        date: Date.now(),
        category: "OTHER",
      });
      const transactionId = await ctx.db.insert("transactions", {
        orgId: otherOrgId,
        type: "IN" as const,
        amount: 100,
        date: Date.now(),
        category: "OTHER" as const,
        description: "Other org transaction",
      });
      return { vehicleId, expenseId, transactionId };
    });

    await expect(
      asManager.mutation(api.transactions.add, {
        orgId,
        type: "OUT",
        amount: 500,
        date: Date.now(),
        category: "VEHICLE_PURCHASE",
        description: "Wrong org vehicle",
        vehicleId: foreign.vehicleId,
      })
    ).rejects.toThrow(RETIRED);

    await expect(
      asManager.mutation(api.transactions.add, {
        orgId,
        type: "OUT",
        amount: 200,
        date: Date.now(),
        category: "EXPENSE",
        description: "Wrong org expense",
        expenseId: foreign.expenseId,
      })
    ).rejects.toThrow(RETIRED);

    await expect(
      asManager.mutation(api.transactions.update, {
        orgId,
        transactionId: foreign.transactionId,
        amount: 125,
      })
    ).rejects.toThrow(RETIRED);

    await expect(
      asManager.mutation(api.transactions.remove, {
        orgId,
        transactionId: foreign.transactionId,
      })
    ).rejects.toThrow(RETIRED);

    // Nothing was created here, and the other organization's row is untouched.
    const rows = await t.run((ctx) => ctx.db.query("transactions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(foreign.transactionId);
    expect(rows[0].isDeleted).toBeUndefined();
  });
});
