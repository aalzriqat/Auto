/**
 * Phase 41 tests — supplier payable settlement VAT reclassification.
 *
 * markPaid always debits/credits ACCOUNTS_PAYABLE_SUPPLIERS and cash/bank in
 * full (the liability was originally booked at the full gross amount back at
 * SALE_COMPLETED, so netting it here would leave a residual balance). When a
 * VAT portion is supplied on an OWNED car's payable, it's reclassified out of
 * VEHICLE_INVENTORY (or COST_OF_VEHICLES_SOLD once the car has sold) into
 * VAT_RECEIVABLE as a separate, self-balancing pair. A consigned payable
 * refuses VAT entirely (SCRUM-781).
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

  return { t, orgId, asOwner, payableId, bankAccountId, vehicleId, accountBySystemKey };
}

describe("SCRUM-880 authoritative supplier payment", () => {
  test("list covers exactly the ordered native and opening payable schema variants", () => {
    const members = schema.tables.vehicleSupplierPayables.validator.members;
    expect(members.map(member => member.fields.origin.value)).toEqual(["NATIVE", "OPENING"]);
    expect(members.map(member => member.fields.origin.isOptional)).toEqual(["optional", "required"]);
  });

  test("unchanged legacy costs allow unrelated direct and requested vehicle edits", async () => {
    const { t, orgId, asOwner, vehicleId } = await seedDealerWithPayable();
    const { registerRateLimiter } = await import("../test-utils/convexTest");
    registerRateLimiter(t);
    await t.run(ctx => ctx.db.patch(vehicleId, {
      status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 100.0000000001,
    }));
    await asOwner.mutation(api.vehicles.update, {
      orgId, vehicleId, color: "Blue", purchasePrice: 100.0000000001,
    });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({
      color: "Blue", purchasePrice: 100.0000000001,
    });
    await t.run(ctx => ctx.db.patch(vehicleId, {
      sourceType: "SOURCED", sourcedFromName: "Legacy supplier", sourceCost: 100.0000000001,
    }));
    await asOwner.mutation(api.vehicles.update, { orgId, vehicleId, color: "Yellow", sourceCost: 100.0000000001 });
    const requestId = await asOwner.mutation(api.vehicleEdits.requestUpdate, {
      orgId, vehicleId, payload: { color: "Red", purchasePrice: 100.0000000001, sourceCost: 100.0000000001 },
    });
    // Requests written before filtering was introduced may still echo unchanged costs.
    await t.run(ctx => ctx.db.patch(requestId, { payload: { color: "Red", purchasePrice: 100.0000000001, sourceCost: 100.0000000001 } }));
    await asOwner.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({
      color: "Red", purchasePrice: 100.0000000001,
    });
    await expect(asOwner.mutation(api.vehicles.update, {
      orgId, vehicleId, color: "Green", purchasePrice: 101.0000000001,
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
    await expect(asOwner.mutation(api.vehicleEdits.requestUpdate, {
      orgId, vehicleId, payload: { color: "Green", purchasePrice: 101.0000000001 },
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
    const staleRequestId = await asOwner.mutation(api.vehicleEdits.requestUpdate, {
      orgId, vehicleId, payload: { color: "Green", purchasePrice: 100.0000000001 },
    });
    await t.run(ctx => ctx.db.patch(staleRequestId, { payload: { color: "Green", purchasePrice: 100.0000000001 } }));
    await t.run(ctx => ctx.db.patch(vehicleId, { purchasePrice: 100 }));
    await expect(asOwner.mutation(api.vehicleEdits.resolve, {
      orgId, requestId: staleRequestId, status: "APPROVED",
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
    expect((await t.run(ctx => ctx.db.get(staleRequestId)))?.status).toBe("PENDING");
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({ color: "Red", purchasePrice: 100 });
  });

  test("SCRUM-880: purchase cost writers refuse excess precision", async () => {
    const { t, orgId, asOwner, vehicleId } = await seedDealerWithPayable();
    const { registerRateLimiter } = await import("../test-utils/convexTest");
    registerRateLimiter(t);
    const { supplierIdFor } = await import("../test-utils/supplierFixture");
    const supplierId = await supplierIdFor(t, orgId, "Precision Supplier");
    const payload = {
      vin: "1HGCM82633A000881", make: "Toyota", model: "Camry", year: 2024,
      mileage: 0, color: "White", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 200, sourceType: "STOCK" as const, purchasePrice: 128.0005,
      purchasePaymentMethod: "ON_ACCOUNT" as const, purchaseSupplierId: supplierId,
    };
    await t.run(ctx => ctx.db.patch(vehicleId, { status: "AVAILABLE", sourceType: "STOCK" }));
    const requests = await t.run(async ctx => {
      const vehicle = await ctx.db.get(vehicleId);
      if (!vehicle) throw new Error("Missing test vehicle");
      const user = await ctx.db.query("users").withIndex("by_clerkId", q => q.eq("clerkId", "p41s_owner")).unique();
      if (!user) throw new Error("Missing owner");
      const ids = [];
      for (const type of ["CREATE", "UPDATE"] as const) {
        ids.push(await ctx.db.insert("vehicleEdits", { orgId, vehicleId, requestedBy: user._id,
          type, payload, status: "PENDING", createdAt: Date.now() }));
      }
      return ids;
    });
    const attempts = [
      () => asOwner.mutation(api.vehicles.update, { orgId, vehicleId, purchasePrice: 128.0005 }),
      () => asOwner.mutation(api.vehicleEdits.requestCreate, { orgId, payload }),
      () => asOwner.mutation(api.vehicleEdits.requestUpdate, { orgId, vehicleId, payload: { purchasePrice: 128.0005 } }),
      () => asOwner.mutation(api.vehicles.createSourced, { orgId, make: "Toyota", model: "Camry", year: 2024,
        mileage: 0, color: "White", fuelType: "Gasoline", transmission: "Automatic",
        sellingPrice: 200, sourceCost: 128.0005, sourcedSupplierId: supplierId }),
      () => asOwner.mutation(api.vehicles.importBulk, { orgId, acquisitionPosting: "OPENING_STOCK", vehicles: [{
        vin: payload.vin, make: payload.make, model: payload.model, year: payload.year,
        color: payload.color, fuelType: payload.fuelType, transmission: payload.transmission,
        sellingPrice: payload.sellingPrice, sourceType: "STOCK", purchasePrice: 128.0005,
      }] }),
      ...requests.map(requestId => () => asOwner.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" })),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
    }
    for (const requestId of requests) {
      expect((await t.run(ctx => ctx.db.get(requestId)))?.status).toBe("PENDING");
    }
    expect(await t.run(ctx => ctx.db.query("accountingEvents").collect())).toEqual([]);
  });

  test("new fractional instalments stay canonical before the final payment", async () => {
    const { t, orgId, asOwner, payableId } = await seedDealerWithPayable(5);
    for (let index = 0; index < 3; index += 1) {
      await asOwner.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId, payableId, amount: 1.48, idempotencyKey: `880-instalment-${index}`,
      });
    }
    expect((await t.run(ctx => ctx.db.get(payableId)))?.amountPaid).toBe(4.44);
    expect((await asOwner.query(api.sourcingPayables.list, { orgId }))[0].settlementAmountMinor).toBe(560);
    await asOwner.mutation(api.sourcingPayables.markPaid, { orgId, payableId, expectedSettlementAmountMinor: 560, idempotencyKey: "880-final" });
    expect((await t.run(ctx => ctx.db.get(payableId)))?.status).toBe("PAID");
  });

  test("SCRUM-880: display and cash posting agree for JOD USD and partial balances", async () => {
    for (const { currency, due, paid, expected } of [
    { currency: "JOD", due: 128.001, paid: 0, expected: 128001 },
    { currency: "USD", due: 128.01, paid: 0, expected: 12801 },
    { currency: "JOD", due: 128.001, paid: 28.001, expected: 100000 },
    { currency: "JOD", due: 9007199254740.99, paid: 0.001, expected: 9007199254740989 },
    ]) {
    const { t, orgId, asOwner, payableId, accountBySystemKey } = await seedDealerWithPayable(due);
    await t.run(ctx => ctx.db.patch(payableId, {
      currency, amountPaid: paid, status: paid > 0 ? "PARTIALLY_PAID" : "PENDING",
    }));
    const offered = (await asOwner.query(api.sourcingPayables.list, { orgId })).find(p => p._id === payableId);
    expect(offered?.settlementAmountMinor).toBe(expected);
    await asOwner.mutation(api.sourcingPayables.markPaid, {
      orgId, payableId, paymentMethod: "CASH", idempotencyKey: "880-payment",
    });
    const cash = await accountBySystemKey("CASH_ON_HAND");
    const credit = await t.run(async ctx => {
      const event = await ctx.db.query("accountingEvents")
        .withIndex("by_org_source", q => q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId))
        .unique();
      if (!event?.journalEntryId) throw new Error("Payment did not post a journal");
      const lines = await ctx.db.query("journalLines")
        .withIndex("by_journal_entry", q => q.eq("journalEntryId", event.journalEntryId!)).collect();
      return lines.find(line => line.accountId === cash?._id)?.creditMinor;
    });
    expect(credit).toBe(expected);
    expect(credit).toBe(offered?.settlementAmountMinor);
    }
  });

  test("stale displayed settlement is refused before money moves", async () => {
    const { t, orgId, asOwner, payableId } = await seedDealerWithPayable(128.001);
    await t.run(ctx => ctx.db.patch(payableId, { amountPaid: 28.001, status: "PARTIALLY_PAID" }));
    await expect(asOwner.mutation(api.sourcingPayables.markPaid, {
      orgId, payableId, expectedSettlementAmountMinor: 128001, idempotencyKey: "880-stale",
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_PAYMENT_CHANGED" } });
    expect(await t.run(ctx => ctx.db.query("accountingEvents").collect())).toEqual([]);
  });

  test("legacy excess precision in amountPaid is refused, including accumulated residue", async () => {
    const { t, orgId, asOwner, payableId } = await seedDealerWithPayable(5);
    await t.run(ctx => ctx.db.patch(payableId, { amountPaid: 1.48 + 1.48 + 1.48, status: "PARTIALLY_PAID" }));
    await expect(asOwner.mutation(api.sourcingPayables.markPaid, {
      orgId, payableId, idempotencyKey: "880-legacy-paid",
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
  });

  test("SCRUM-880: legacy JOD and USD excess precision refuses payment atomically", async () => {
    for (const { currency, amount } of [
    { currency: "JOD", amount: 128.0005 },
    { currency: "USD", amount: 128.001 },
    ]) {
    const { t, orgId, asOwner, payableId } = await seedDealerWithPayable(amount);
    await t.run(ctx => ctx.db.patch(payableId, { currency }));
    const before = await t.run(ctx => ctx.db.get(payableId));
    const offered = (await asOwner.query(api.sourcingPayables.list, { orgId })).find(p => p._id === payableId);
    expect(offered?.settlementAmountMinor).toBeNull();
    await expect(asOwner.mutation(api.sourcingPayables.markPaid, {
      orgId, payableId, paymentMethod: "CASH", idempotencyKey: "880-refusal",
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
    await expect(asOwner.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId, payableId, amount: 1, paymentMethod: "CASH", idempotencyKey: "880-partial-refusal",
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
    expect(await t.run(ctx => ctx.db.get(payableId))).toEqual(before);
    expect(await t.run(ctx => ctx.db.query("accountingEvents").collect())).toEqual([]);
    }
  });

  test("SCRUM-880: new JOD and USD purchases refuse excess precision before acquisition", async () => {
    for (const { currency, amount } of [
    { currency: "JOD", amount: 128.0005 },
    { currency: "USD", amount: 128.001 },
    ]) {
    const { t, orgId, asOwner } = await seedDealerWithPayable();
    const { registerRateLimiter } = await import("../test-utils/convexTest");
    registerRateLimiter(t);
    await t.run(async ctx => {
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", q => q.eq("orgId", orgId)).unique();
      if (!settings) throw new Error("Missing settings");
      await ctx.db.patch(settings._id, { currency });
    });
    const { supplierIdFor } = await import("../test-utils/supplierFixture");
    const purchaseSupplierId = await supplierIdFor(t, orgId, "Precision Supplier");
    await expect(asOwner.mutation(api.vehicles.create, {
      orgId, vin: "1HGCM82633A000880", make: "Toyota", model: "Camry", year: 2024,
      mileage: 0, color: "White", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 20000, status: "AVAILABLE", sourceType: "STOCK", purchasePrice: amount,
      purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierId, idempotencyKey: "880-create",
    })).rejects.toMatchObject({ data: { code: "SUPPLIER_AMOUNT_PRECISION" } });
    expect(await t.run(ctx => ctx.db.query("vehicles").withIndex("by_org_vin", q => q.eq("orgId", orgId).eq("vin", "1HGCM82633A000880")).unique())).toBeNull();
    expect(await t.run(ctx => ctx.db.query("accountingEvents").collect())).toEqual([]);
    }
  });
});

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

  test("a consigned (sale-linked) payable refuses a VAT amount and stays unpaid (SCRUM-781)", async () => {
    // The default fixture is the production shape of a consigned payable: written at sale time,
    // carrying the saleId. Owner ruling SCRUM-773 c22401 — no reclaimable VAT on it. This test used to
    // assert Dr VAT_RECEIVABLE / Cr COST_OF_VEHICLES_SOLD on this very fixture, which encoded the defect.
    const { t, orgId, asOwner, payableId, bankAccountId } = await seedDealerWithPayable(5000);

    await expect(
      asOwner.mutation(api.sourcingPayables.markPaid, {
        idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER", bankAccountId, taxAmount: 500,
      })
    ).rejects.toThrow(/consigned.*gross amount.*VAT/i);

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("PENDING");
    expect(payable?.taxAmount).toBeUndefined();
  });

  test("with a VAT amount on an owned ON_ACCOUNT payable, AP and cash still settle in full, plus a self-balancing VAT reclass pair", async () => {
    const { t, orgId, asOwner, payableId, bankAccountId, vehicleId, accountBySystemKey } = await seedDealerWithPayable(5000);
    // The shape postVehicleAcquisitionIfOwned writes for an owned car bought on account: no sale,
    // dealer-owned stock, not yet sold, so the cost still sits in Vehicle Inventory.
    await t.run(async (ctx) => {
      await ctx.db.patch(payableId, { saleId: undefined });
      await ctx.db.patch(vehicleId, { status: "AVAILABLE", sourceType: "STOCK" });
    });

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
    const inventory = await accountBySystemKey("VEHICLE_INVENTORY");
    const cogs = await accountBySystemKey("COST_OF_VEHICLES_SOLD");

    // AP + cash settle for the FULL gross amount — not netted by the VAT portion.
    expect(lines.find((l) => l.accountId === ap!._id)?.debitMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.creditMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.bankAccountId).toBe(bankAccountId);
    // VAT reclass is a separate, self-balancing pair.
    expect(lines.find((l) => l.accountId === vat!._id)?.debitMinor).toBe(500_000);
    expect(lines.find((l) => l.accountId === inventory!._id)?.creditMinor).toBe(500_000);
    expect(lines.some((l) => l.accountId === cogs!._id)).toBe(false);
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
