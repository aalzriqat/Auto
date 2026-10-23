/**
 * Phase 41 tests — supplier payable settlement VAT reclassification.
 *
 * markPaid always debits/credits ACCOUNTS_PAYABLE_SUPPLIERS and cash/bank in
 * full (the liability was originally booked at the full gross amount back at
 * SALE_COMPLETED, so netting it here would leave a residual balance). When a
 * VAT portion is supplied, it's reclassified out of COST_OF_VEHICLES_SOLD
 * into VAT_RECEIVABLE as a separate, self-balancing pair.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

test("a non-finance manager cannot read sourcing financial queues", async () => {
  const { t, orgId, asOwner } = await seedDealerWithPayable();
  const template = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "MANAGER");
  if (!template) throw new Error("Missing actual manager template");
  expect(template.permissions).not.toContain("view:finance");
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkId: "sourcing-manager", email: "manager@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: template.name, permissions: template.permissions });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
  });
  const manager = t.withIdentity({ subject: "sourcing-manager" });
  // Positive controls prove the queries and fixture work. The negative checks
  // require the structured authorization refusal, never any rejected request.
  expect(await asOwner.query(api.sourcingPayables.list, { orgId })).toHaveLength(1);
  expect(await asOwner.query(api.sourcingPayables.listPipeline, { orgId })).toEqual([]);
  expect(await asOwner.query(api.supplierCostRecoveries.list, { orgId })).toEqual({ complete: true, items: [] });
  await expect(manager.query(api.sourcingPayables.list, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await expect(manager.query(api.sourcingPayables.listPipeline, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await expect(manager.query(api.supplierCostRecoveries.list, { orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

async function seedDealerWithPayable(amountDue = 5000) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase41 Sourcing Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p41s_owner", email: "p41sowner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const asOwner = t.withIdentity({ subject: "p41s_owner", clerkId: "p41s_owner" });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "SOURCEDVIN000001", make: "Kia", model: "Sportage", year: 2023, mileage: 0,
      color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20000, status: "SOLD",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Jane", lastName: "Doe" })
  );
  // saleId matters now: it's how markPaid tells a sale-originated payable
  // (VAT reclass hits COST_OF_VEHICLES_SOLD) apart from an acquisition-time
  // ON_ACCOUNT payable (VAT reclass hits VEHICLE_INVENTORY instead) — see
  // sourcingPayables.markPaid's costOrigin derivation.
  const saleId = await t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 20000, saleDate: Date.now(), status: "COMPLETED",
    })
  );
  const payableId = await t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId, vehicleId, saleId, sourcedFromName: "Sister Dealer Co", amountDue, currency: "JOD",
      status: "PENDING", createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const bankAccountId = await t.run((ctx) => ctx.db.insert("bankAccounts", {
    orgId, name: "Supplier Operating", currency: "JOD", openingBalanceMinor: 0,
    openingBalanceDate: Date.now(), isActive: true, isReconciliationTarget: true,
    createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
  }));

  async function accountBySystemKey(systemKey: string) {
    return await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
        .unique()
    );
  }

  return { t, orgId, asOwner, payableId, bankAccountId, accountBySystemKey };
}

describe("sourcingPayables.markPaid VAT reclassification", () => {
  test("payment bank options expose only eligible banks in the payable currency", async () => {
    const { t, orgId, asOwner, payableId, bankAccountId } = await seedDealerWithPayable(5000);
    const options = await asOwner.query(api.sourcingPayables.listPaymentBankOptions, { orgId, payableId });
    expect(options).toEqual({ banks: [{ _id: bankAccountId, name: "Supplier Operating", currency: "JOD" }], truncated: false });
    await t.run((ctx) => ctx.db.patch(bankAccountId, { isActive: false }));
    expect(await asOwner.query(api.sourcingPayables.listPaymentBankOptions, { orgId, payableId })).toEqual({ banks: [], truncated: false });
  });

  test("bank-funded full and partial supplier payments refuse missing bank before any payable or ledger write", async () => {
    const { t, orgId, asOwner, payableId } = await seedDealerWithPayable(5000);
    await expect(asOwner.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: "supplier-full-missing-bank", orgId, payableId, paymentMethod: "BANK_TRANSFER",
    })).rejects.toThrow(/Choose the bank account/i);
    await expect(asOwner.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: "supplier-partial-missing-bank", orgId, payableId, amount: 1000, paymentMethod: "CHEQUE",
    })).rejects.toThrow(/Choose the bank account/i);
    expect((await t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PENDING");
    const events = await t.run((ctx) => ctx.db.query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString()))
      .collect());
    expect(events.filter((event) => event.eventType === "SUPPLIER_PAYMENT_SETTLED")).toHaveLength(0);
  });

  test("supplier payment refuses an inactive or wrong-currency bank and a bank on cash", async () => {
    const { t, orgId, asOwner, payableId, bankAccountId } = await seedDealerWithPayable(5000);
    await t.run((ctx) => ctx.db.patch(bankAccountId, { isActive: false }));
    await expect(asOwner.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: "supplier-inactive-bank", orgId, payableId, paymentMethod: "CARD", bankAccountId,
    })).rejects.toThrow(/inactive/i);
    await t.run((ctx) => ctx.db.patch(bankAccountId, { isActive: true, currency: "USD" }));
    await expect(asOwner.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: "supplier-wrong-currency", orgId, payableId, amount: 1000, paymentMethod: "CHEQUE", bankAccountId,
    })).rejects.toThrow(/denominated in USD/i);
    await expect(asOwner.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: "supplier-cash-with-bank", orgId, payableId, paymentMethod: "CASH", bankAccountId,
    })).rejects.toThrow(/only valid for a bank-funded/i);
    expect((await t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PENDING");
  });

  test("partial bank payment retains its bank and the retry identity binds that bank", async () => {
    const { t, orgId, asOwner, payableId, bankAccountId } = await seedDealerWithPayable(5000);
    const args = { idempotencyKey: "supplier-partial-bank-1", orgId, payableId, amount: 1000, paymentMethod: "CARD" as const, bankAccountId };
    await asOwner.mutation(api.sourcingPayables.recordPartialPayment, args);
    await asOwner.mutation(api.sourcingPayables.recordPartialPayment, args);
    expect((await t.run((ctx) => ctx.db.get(payableId)))?.amountPaid).toBe(1000);
    const event = await t.run((ctx) => ctx.db.query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString()))
      .filter((q) => q.eq(q.field("eventType"), "SUPPLIER_PAYMENT_SETTLED"))
      .first());
    const lines = await t.run((ctx) => ctx.db.query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect());
    expect(lines.find((line) => line.bankAccountId === bankAccountId)?.creditMinor).toBe(1_000_000);
  });
  test("without a VAT amount, settles AP and cash for the full amount with no VAT line", async () => {
    const { t, orgId, asOwner, payableId, bankAccountId, accountBySystemKey } = await seedDealerWithPayable(5000);

    await asOwner.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER", bankAccountId });

    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "SUPPLIER_PAYMENT_SETTLED"))
        .first()
    );
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect()
    );
    expect(lines).toHaveLength(2);

    const ap = await accountBySystemKey("ACCOUNTS_PAYABLE_SUPPLIERS");
    const bank = await accountBySystemKey("BANK_ACCOUNT");
    expect(lines.find((l) => l.accountId === ap!._id)?.debitMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.creditMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.bankAccountId).toBe(bankAccountId);
  });

  test("with a VAT amount, AP and cash still settle in full, plus a self-balancing VAT reclass pair", async () => {
    const { t, orgId, asOwner, payableId, bankAccountId, accountBySystemKey } = await seedDealerWithPayable(5000);

    await asOwner.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(),
      orgId, payableId, paymentMethod: "BANK_TRANSFER", bankAccountId, taxAmount: 500,
    });

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.taxAmount).toBe(500);

    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "SUPPLIER_PAYMENT_SETTLED"))
        .first()
    );
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect()
    );
    expect(lines).toHaveLength(4);

    const totalDebit = lines.reduce((s, l) => s + l.debitMinor, 0);
    const totalCredit = lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(totalDebit).toBe(totalCredit);

    const ap = await accountBySystemKey("ACCOUNTS_PAYABLE_SUPPLIERS");
    const bank = await accountBySystemKey("BANK_ACCOUNT");
    const vat = await accountBySystemKey("VAT_RECEIVABLE");
    const cogs = await accountBySystemKey("COST_OF_VEHICLES_SOLD");

    // AP + cash settle for the FULL gross amount — not netted by the VAT portion.
    expect(lines.find((l) => l.accountId === ap!._id)?.debitMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.creditMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.bankAccountId).toBe(bankAccountId);
    // VAT reclass is a separate, self-balancing pair.
    expect(lines.find((l) => l.accountId === vat!._id)?.debitMinor).toBe(500_000);
    expect(lines.find((l) => l.accountId === cogs!._id)?.creditMinor).toBe(500_000);
  });

  test("rejects a VAT amount greater than the amount due", async () => {
    const { orgId, asOwner, payableId } = await seedDealerWithPayable(1000);

    await expect(
      asOwner.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(),
        orgId, payableId, paymentMethod: "CASH", taxAmount: 2000,
      })
    ).rejects.toThrow(/cannot exceed/i);
  });
});
