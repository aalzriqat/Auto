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
import { postAccountingEvent } from "./accounting/postingEngine";

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
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
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
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await expect(
      asOwner.mutation(api.vehicles.update, { orgId, vehicleId, purchasePrice: 12000, sourceType: "STOCK" })
    ).rejects.toThrow(/already been posted/);
  });
});

describe("Fix #11 — flipping a SOURCED vehicle to owned stock capitalizes it", () => {
  test("SOURCED→STOCK via update() debits Vehicle Inventory using the mirrored sourceCost", async () => {
    const { t, orgId, asOwner } = await seedDealer("f11a");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "SRC3D9AN0000011AX", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 9000,
    });

    // Never capitalized while SOURCED.
    const eventBeforeFlip = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .first()
    );
    expect(eventBeforeFlip).toBeNull();

    await asOwner.mutation(api.vehicles.update, {
      orgId, vehicleId, sourceType: "STOCK", purchasePaymentMethod: "CASH",
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_ACQUIRED");
    const invLine = lines.find((l) => l.accountId === inventory._id)!;
    const cashLine = lines.find((l) => l.accountId === cash._id)!;
    expect(invLine.debitMinor).toBe(9_000_000); // sourceCost mirrored into purchasePrice at creation
    expect(cashLine.creditMinor).toBe(9_000_000);

    const legacyTx = await t.run((ctx) =>
      ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).filter((q) => q.eq(q.field("category"), "VEHICLE_PURCHASE")).first()
    );
    expect(legacyTx?.amount).toBe(9000);

    // A second no-op update (no sourceType/purchasePrice change) must not re-post.
    await asOwner.mutation(api.vehicles.update, { orgId, vehicleId, notes: "inspected" });
    const eventsAfterNoOp = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .collect()
    );
    expect(eventsAfterNoOp).toHaveLength(1);
  });

  test("SOURCED→STOCK via update() requires an explicit payment method", async () => {
    const { orgId, asOwner } = await seedDealer("f11b");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "SRC3D9AN0000012AX", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 9000,
    });

    await expect(
      asOwner.mutation(api.vehicles.update, { orgId, vehicleId, sourceType: "STOCK" })
    ).rejects.toThrow(/[Pp]ayment method is required/);
  });

  test("a STOCK vehicle created without a purchase price capitalizes once one is set via update()", async () => {
    const { t, orgId, asOwner } = await seedDealer("f11c");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "STK3D9AN0000013AX",
    });

    let event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .first()
    );
    expect(event).toBeNull();

    await asOwner.mutation(api.vehicles.update, {
      orgId, vehicleId, purchasePrice: 7500, purchasePaymentMethod: "BANK_TRANSFER",
    });

    event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
        .first()
    );
    expect(event).not.toBeNull();
    expect(event!.status).toBe("POSTED");
  });
});

describe("Fix #13 — ON_ACCOUNT credit purchases for owned vehicles", () => {
  test("create() with ON_ACCOUNT debits Vehicle Inventory and credits AP-Suppliers, no cash transaction row", async () => {
    const { t, orgId, asOwner } = await seedDealer("f13a");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
      purchasePaymentMethod: "ON_ACCOUNT", sourcedFromName: "Credit Supplier Co",
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const ap = await accountBySystemKey(t, orgId, "ACCOUNTS_PAYABLE_SUPPLIERS");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_ACQUIRED");
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(10_000_000);
    expect(lines.find((l) => l.accountId === ap._id)?.creditMinor).toBe(10_000_000);

    const payable = await t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).first()
    );
    expect(payable?.vehicleId).toBe(vehicleId);
    expect(payable?.saleId).toBeUndefined();
    expect(payable?.amountDue).toBe(10000);
    expect(payable?.sourcedFromName).toBe("Credit Supplier Co");
    expect(payable?.status).toBe("PENDING");

    // No cash actually moved — the legacy transactions table shouldn't record one.
    const legacyTx = await t.run((ctx) =>
      ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).filter((q) => q.eq(q.field("category"), "VEHICLE_PURCHASE")).first()
    );
    expect(legacyTx).toBeNull();
  });

  test("create() with ON_ACCOUNT requires a supplier name", async () => {
    const { orgId, asOwner } = await seedDealer("f13b");
    await expect(
      asOwner.mutation(api.vehicles.create, {
        orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "ON_ACCOUNT",
      })
    ).rejects.toThrow(/supplier name/i);
  });

  test("settling the payable via sourcingPayables.markPaid clears AP against Bank and reclassifies VAT out of Vehicle Inventory, not COGS", async () => {
    const { t, orgId, asOwner } = await seedDealer("f13c");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000,
      purchasePaymentMethod: "ON_ACCOUNT", sourcedFromName: "Credit Supplier Co",
    });
    const payable = await t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).first()
    );

    await asOwner.mutation(api.sourcingPayables.markPaid, {
      orgId, payableId: payable!._id, paymentMethod: "BANK_TRANSFER", taxAmount: 500,
    });

    const ap = await accountBySystemKey(t, orgId, "ACCOUNTS_PAYABLE_SUPPLIERS");
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const vat = await accountBySystemKey(t, orgId, "VAT_RECEIVABLE");
    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const { lines } = await linesForEvent(t, orgId, "vehicleSupplierPayables", payable!._id, "SUPPLIER_PAYMENT_SETTLED");

    expect(lines.find((l) => l.accountId === ap._id)?.debitMinor).toBe(10_000_000);
    expect(lines.find((l) => l.accountId === bank._id)?.creditMinor).toBe(10_000_000);
    // VAT reclass hits Vehicle Inventory (this payable originated at
    // acquisition, not a sale) — not Cost of Vehicles Sold.
    expect(lines.find((l) => l.accountId === vat._id)?.debitMinor).toBe(500_000);
    expect(lines.find((l) => l.accountId === inventory._id)?.creditMinor).toBe(500_000);
  });

  test("update() flipping SOURCED to STOCK with ON_ACCOUNT creates the payable at flip time", async () => {
    const { t, orgId, asOwner } = await seedDealer("f13d");

    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "SRC3D9AN0000013FD", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 9000,
    });

    await asOwner.mutation(api.vehicles.update, {
      orgId, vehicleId, sourceType: "STOCK",
      purchasePaymentMethod: "ON_ACCOUNT", sourcedFromName: "Credit Supplier Co",
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const ap = await accountBySystemKey(t, orgId, "ACCOUNTS_PAYABLE_SUPPLIERS");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_ACQUIRED");
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(9_000_000);
    expect(lines.find((l) => l.accountId === ap._id)?.creditMinor).toBe(9_000_000);

    const payable = await t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).first()
    );
    expect(payable?.sourcedFromName).toBe("Credit Supplier Co");
  });
});

describe("Fix #2 — landed costs post their delta to Vehicle Inventory", () => {
  test("increasing landed costs debits inventory; decreasing them reverses the delta", async () => {
    const { t, orgId, asOwner } = await seedDealer("f2a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [
        { label: "Transport", amount: 300, paymentMethod: "CASH" },
        { label: "Detailing", amount: 200, paymentMethod: "CASH" },
      ],
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
      orgId, vehicleId, items: [{ label: "Transport", amount: 150, paymentMethod: "CASH" }],
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

  test("Fix #14 — removing an item reverses against the account IT was paid from, not another item's account", async () => {
    const { t, orgId, asOwner } = await seedDealer("f2c");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [
        { label: "Transport", amount: 300, paymentMethod: "BANK_TRANSFER" },
        { label: "Detailing", amount: 200, paymentMethod: "CASH" },
      ],
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const firstEvent = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts")).first()
    );
    const firstLines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", firstEvent!.journalEntryId!)).collect()
    );
    expect(firstLines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(500_000);
    expect(firstLines.find((l) => l.accountId === bank._id)?.creditMinor).toBe(300_000);
    expect(firstLines.find((l) => l.accountId === cash._id)?.creditMinor).toBe(200_000);

    // Remove the BANK_TRANSFER item entirely — the reversal must hit Bank
    // Account specifically, even though the only item left is CASH-paid.
    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Detailing", amount: 200, paymentMethod: "CASH" }],
    });

    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts")).collect()
    );
    const secondEvent = events.find((e) => e._id !== firstEvent!._id)!;
    const secondLines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", secondEvent.journalEntryId!)).collect()
    );
    expect(secondLines.find((l) => l.accountId === bank._id)?.debitMinor).toBe(300_000);
    expect(secondLines.find((l) => l.accountId === inventory._id)?.creditMinor).toBe(300_000);
    // Cash must NOT be touched by this reversal — the item paid from it never changed.
    expect(secondLines.some((l) => l.accountId === cash._id)).toBe(false);
  });

  test("Fix #14 — reclassifying an item to a different account posts even when the net total is unchanged", async () => {
    const { t, orgId, asOwner } = await seedDealer("f2d");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Transport", amount: 300, paymentMethod: "CASH" }],
    });
    const firstEvent = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts")).first()
    );

    // Same amount, different account — net total delta is zero, but this is
    // a real reclassification the GL must reflect.
    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Transport", amount: 300, paymentMethod: "BANK_TRANSFER" }],
    });

    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts")).collect()
    );
    expect(events).toHaveLength(2);
    const secondEvent = events.find((e) => e._id !== firstEvent!._id)!;
    const reclassLines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", secondEvent.journalEntryId!)).collect()
    );
    expect(reclassLines.find((l) => l.accountId === cash._id)?.debitMinor).toBe(300_000);
    expect(reclassLines.find((l) => l.accountId === bank._id)?.creditMinor).toBe(300_000);
  });

  test("requires an explicit payment method per item on a non-SOURCED vehicle", async () => {
    const { orgId, asOwner } = await seedDealer("f2e");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await expect(
      asOwner.mutation(api.vehicles.upsertLandedCosts, {
        orgId, vehicleId, items: [{ label: "Transport", amount: 300 }],
      })
    ).rejects.toThrow(/[Pp]ayment method is required/);
  });

  test("blocked once the vehicle is sold", async () => {
    const { t, orgId, asOwner } = await seedDealer("f2b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
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
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
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
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
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
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Transport", amount: 300, paymentMethod: "CASH" }],
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
      dueDate: Date.UTC(2025, 4, 1), creditSystemKey: "MISCELLANEOUS_INCOME",
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

  test("cursor-based pagination reaches vehicles beyond the first page instead of re-scanning it forever", async () => {
    const { t, orgId, asOwner } = await seedDealer("bf9a");

    const vehicleId1 = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "PAGE0000000000001", make: "Toyota", model: "Camry", year: 2019,
        mileage: 1000, color: "White", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 5000, sellingPrice: 8000, status: "AVAILABLE", sourceType: "STOCK",
      })
    );
    const vehicleId2 = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "PAGE0000000000002", make: "Honda", model: "Civic", year: 2020,
        mileage: 2000, color: "Black", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 6000, sellingPrice: 9000, status: "AVAILABLE", sourceType: "STOCK",
      })
    );

    const first = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false, limit: 1,
    });
    expect(first.posted).toBe(1);
    expect(first.isDone).toBe(false);
    expect(first.nextCursor).toBeTruthy();

    // Re-running with limit: 1 and NO cursor is the pre-fix bug: it would
    // always re-scan the same first vehicle and could never reach the second.
    const second = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false, limit: 1, cursor: first.nextCursor,
    });
    expect(second.posted).toBe(1);
    expect(second.isDone).toBe(true);

    const events = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", "VEHICLE_INVENTORY_OPENING_BALANCE"))
        .collect()
    );
    const postedVehicleIds = new Set(events.map((e) => e.sourceId));
    expect(postedVehicleIds.has(vehicleId1)).toBe(true);
    expect(postedVehicleIds.has(vehicleId2)).toBe(true);
  });

  test("a vehicle whose reclassification fails rolls back its own opening-balance post instead of leaking partial state", async () => {
    const { t, orgId, asOwner, userId } = await seedDealer("bf10a");

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "ATOMIC0000000001", make: "Toyota", model: "Camry", year: 2019,
        mileage: 40000, color: "Silver", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE", sourceType: "STOCK",
      })
    );
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, vehicleId, title: "Old repair", amount: 300, date: Date.UTC(2025, 1, 1),
        category: "REPAIR", status: "PAID",
      })
    );
    await t.run((ctx) =>
      postAccountingEvent(ctx, {
        orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
        eventVersion: 1, accountingDate: Date.UTC(2025, 1, 1), occurredAt: Date.UTC(2025, 1, 1),
        currency: "JOD", idempotencyKey: `expense_posted_${expenseId}`,
        payload: { expenseId: expenseId.toString(), amountMinor: 300_000, currency: "JOD", category: "REPAIR", paymentMethod: "CASH" },
        actorId: userId,
      })
    );

    // Force the reclassification step (which runs AFTER the base opening-balance
    // post inside the same per-vehicle sub-transaction) to throw, by planting a
    // REVERSED event under the idempotency key hookVehiclePrepExpenseReclassified
    // will use — postAccountingEvent's own idempotency check throws on that.
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId, eventType: "VEHICLE_PREP_EXPENSE_RECLASSIFIED", sourceType: "expenses",
        sourceId: expenseId.toString(), eventVersion: 1,
        idempotencyKey: `vehicle_prep_expense_reclassified_${expenseId}`,
        occurredAt: Date.now(), accountingDate: Date.now(), currency: "JOD", payload: {},
        status: "REVERSED", createdBy: userId, createdAt: Date.now(),
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false,
    });
    expect(result.failed).toBe(1);
    expect(result.results[0].action).toBe("FAILED");

    // The base VEHICLE_INVENTORY_OPENING_BALANCE post from the same failed
    // sub-transaction must have rolled back too — not left sitting in the GL
    // with no valid companion reclassification, and not silently marked
    // already_posted with no journal entry on a future retry.
    const openingEvent = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .first()
    );
    expect(openingEvent).toBeNull();
  });
});

describe("Review issue #1 — payment method required whenever a purchase price is entered", () => {
  test("rejects a purchase price with no payment method", async () => {
    const { orgId, asOwner } = await seedDealer("ri1a");
    await expect(
      asOwner.mutation(api.vehicles.create, { orgId, ...baseVehicle, purchasePrice: 10000 })
    ).rejects.toThrow(/Payment method is required/);
  });

  test("sourced vehicles never require a payment method (never capitalize into inventory)", async () => {
    const { orgId, asOwner } = await seedDealer("ri1b");
    await expect(
      asOwner.mutation(api.vehicles.create, {
        orgId, ...baseVehicle, vin: "SRC3D9AN0000002BY", sourceType: "SOURCED",
        sourcedFromName: "Other Dealer", sourceCost: 9000,
      })
    ).resolves.toBeDefined();
  });

  test("the approval-request flow closes the same gap: rejects a purchase price with no payment method", async () => {
    const { orgId, asOwner } = await seedDealer("ri1c");
    await expect(
      asOwner.mutation(api.vehicleEdits.requestCreate, {
        orgId,
        payload: { ...baseVehicle, purchasePrice: 10000 },
      })
    ).rejects.toThrow(/Payment method is required/);
  });

  test("an approved creation request posts VEHICLE_ACQUIRED using the requested payment method", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri1d");
    const requestId = await asOwner.mutation(api.vehicleEdits.requestCreate, {
      orgId,
      payload: { ...baseVehicle, purchasePrice: 6000, purchasePaymentMethod: "BANK_TRANSFER" },
    });
    await asOwner.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });

    const vehicle = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", orgId).eq("vin", baseVehicle.vin)).unique()
    );
    expect(vehicle).not.toBeNull();
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicle!._id, "VEHICLE_ACQUIRED");
    expect(lines.find((l) => l.accountId === bank._id)?.creditMinor).toBe(6_000_000);
  });

  test("an approved creation request with ON_ACCOUNT credits AP-Suppliers and creates the payable", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri1e");
    const requestId = await asOwner.mutation(api.vehicleEdits.requestCreate, {
      orgId,
      payload: {
        ...baseVehicle, vin: "ONACCT0000000001", purchasePrice: 7000,
        purchasePaymentMethod: "ON_ACCOUNT", sourcedFromName: "Approval Flow Supplier",
      },
    });
    await asOwner.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });

    const vehicle = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", orgId).eq("vin", "ONACCT0000000001")).unique()
    );
    expect(vehicle).not.toBeNull();
    const ap = await accountBySystemKey(t, orgId, "ACCOUNTS_PAYABLE_SUPPLIERS");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicle!._id, "VEHICLE_ACQUIRED");
    expect(lines.find((l) => l.accountId === ap._id)?.creditMinor).toBe(7_000_000);

    const payable = await t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicle!._id)).first()
    );
    expect(payable?.sourcedFromName).toBe("Approval Flow Supplier");
  });

  test("an approved UPDATE request flipping SOURCED to STOCK posts VEHICLE_ACQUIRED (previously a silent gap)", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri1f");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "SRC3D9AN0000001FG", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 8500,
    });

    // Never capitalized while SOURCED.
    const eventBeforeFlip = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .first()
    );
    expect(eventBeforeFlip).toBeNull();

    const requestId = await asOwner.mutation(api.vehicleEdits.requestUpdate, {
      orgId, vehicleId,
      payload: { sourceType: "STOCK", purchasePaymentMethod: "CASH" },
    });
    await asOwner.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_ACQUIRED");
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(8_500_000);
    expect(lines.find((l) => l.accountId === cash._id)?.creditMinor).toBe(8_500_000);
  });

  test("requestUpdate rejects a SOURCED-to-STOCK flip with no payment method", async () => {
    const { orgId, asOwner } = await seedDealer("ri1g");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "SRC3D9AN0000001GH", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 8500,
    });

    await expect(
      asOwner.mutation(api.vehicleEdits.requestUpdate, {
        orgId, vehicleId, payload: { sourceType: "STOCK" },
      })
    ).rejects.toThrow(/[Pp]ayment method is required/);
  });
});

describe("Review issue #2 — outbound cheque purchases credit Bank Account, not Cheques in Hand", () => {
  test("vehicle acquisition by cheque credits Bank Account", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri2a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CHEQUE",
    });

    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const chequesInHand = await accountBySystemKey(t, orgId, "CHEQUES_IN_HAND");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_ACQUIRED");
    expect(lines.find((l) => l.accountId === bank._id)?.creditMinor).toBe(10_000_000);
    expect(lines.some((l) => l.accountId === chequesInHand._id)).toBe(false);
  });

  test("landed costs paid by cheque credit Bank Account", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri2b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId, items: [{ label: "Transport", amount: 300, paymentMethod: "CHEQUE" }],
    });

    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const chequesInHand = await accountBySystemKey(t, orgId, "CHEQUES_IN_HAND");
    // The edit token (Date.now()) in the sourceId isn't known to the test, so
    // fetch the sole event by sourceType instead of guessing the exact id.
    const event = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts")).first()
    );
    expect(event).not.toBeNull();
    const entry = await t.run((ctx) => ctx.db.get(event!.journalEntryId!));
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry!._id)).collect()
    );
    expect(lines.find((l) => l.accountId === bank._id)?.creditMinor).toBe(300_000);
    expect(lines.some((l) => l.accountId === chequesInHand._id)).toBe(false);
  });
});

describe("Review issue #3 — capitalized VAT-inclusive expenses exclude the recoverable tax from inventory", () => {
  test("a repair invoice with input VAT capitalizes only the net amount", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ri3a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, vehicleId, title: "Repair with VAT", amount: 116, taxAmount: 16,
      date: Date.UTC(2025, 2, 1), category: "REPAIR", status: "PAID",
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const vatReceivable = await accountBySystemKey(t, orgId, "VAT_RECEIVABLE");
    const { lines } = await linesForEvent(t, orgId, "expenses", expenseId, "EXPENSE_POSTED");
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(100_000);
    expect(lines.find((l) => l.accountId === vatReceivable._id)?.debitMinor).toBe(16_000);

    const expense = await t.run((ctx) => ctx.db.get(expenseId));
    expect(expense?.accountingTreatment).toBe("CAPITALIZED_INVENTORY");
    expect(expense?.capitalizedAmount).toBe(100);

    // The cost basis used for COGS/commission must match the 100 actually
    // capitalized, not the 116 gross invoice amount — otherwise the sale
    // would relieve inventory by more than was ever debited to it.
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });
    const cogs = await accountBySystemKey(t, orgId, "COST_OF_VEHICLES_SOLD");
    const { lines: saleLines } = await linesForEvent(t, orgId, "sales", saleId, "SALE_COMPLETED");
    expect(saleLines.find((l) => l.accountId === cogs._id)?.debitMinor).toBe(10_100_000);
  });
});

describe("Review issue #4 — a post-sale repair can never retroactively join the vehicle's cost basis", () => {
  test("a repair expensed after sale doesn't change the sale's already-posted COGS or a later profit report", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ri4a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const cogs = await accountBySystemKey(t, orgId, "COST_OF_VEHICLES_SOLD");
    const { lines: saleLinesBefore } = await linesForEvent(t, orgId, "sales", saleId, "SALE_COMPLETED");
    expect(saleLinesBefore.find((l) => l.accountId === cogs._id)?.debitMinor).toBe(10_000_000);

    // A warranty repair after the sale — correctly a period expense, not inventory.
    const expenseId = await asOwner.mutation(api.expenses.create, {
      orgId, vehicleId, title: "Warranty repair after sale", amount: 400,
      date: Date.UTC(2025, 4, 1), category: "REPAIR", status: "PAID",
    });
    const expense = await t.run((ctx) => ctx.db.get(expenseId));
    expect(expense?.accountingTreatment).toBe("PERIOD_EXPENSE");
    expect(expense?.capitalizedAmount).toBeUndefined();

    // Re-running the same report query the profit report uses must still
    // return the original cost basis — the post-sale repair must never leak in.
    const report = await asOwner.query(api.reports.getSalesAndProfitReport, {
      orgId, startDate: Date.UTC(2025, 0, 1), endDate: Date.UTC(2025, 11, 31),
    });
    const saleRow = report.sales.find((s) => s.vehicleId === vehicleId);
    expect(saleRow?.totalCost).toBe(10000);
  });
});

describe("Review issue #5 — vehicle acquisition cost correction", () => {
  test("corrects the vehicle's cost record and posts a signed inventory adjustment", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri5a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId, vehicleId, newCost: 12000, reason: "Original invoice was mis-entered",
      correctionType: "PRIOR_PERIOD_RESTATEMENT",
    });

    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.purchasePrice).toBe(12000);

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const retainedEarnings = await accountBySystemKey(t, orgId, "RETAINED_EARNINGS");
    const event = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleCostCorrections")).first()
    );
    expect(event).not.toBeNull();
    const entry = await t.run((ctx) => ctx.db.get(event!.journalEntryId!));
    const lines = await t.run((ctx) => ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry!._id)).collect());
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(2_000_000);
    expect(lines.find((l) => l.accountId === retainedEarnings._id)?.creditMinor).toBe(2_000_000);

    const correction = await t.run((ctx) =>
      ctx.db.query("vehicleCostCorrections").withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId)).unique()
    );
    expect(correction?.previousCost).toBe(10000);
    expect(correction?.newCost).toBe(12000);
    expect(correction?.reason).toBe("Original invoice was mis-entered");
    expect(correction?.correctionType).toBe("PRIOR_PERIOD_RESTATEMENT");
  });

  test("rejects a correction before the acquisition cost has ever posted", async () => {
    const { orgId, asOwner } = await seedDealer("ri5b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId, vehicleId, newCost: 5000, reason: "test", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    ).rejects.toThrow(/hasn't posted/);
  });

  test("SUPPLIER_INVOICE_ERROR and VENDOR_CREDIT route through AP-Suppliers instead of Retained Earnings", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri5c");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId, vehicleId, newCost: 9500, reason: "Vendor issued a credit for a shipping error",
      correctionType: "VENDOR_CREDIT",
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const ap = await accountBySystemKey(t, orgId, "ACCOUNTS_PAYABLE_SUPPLIERS");
    const retainedEarnings = await accountBySystemKey(t, orgId, "RETAINED_EARNINGS");
    const event = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleCostCorrections")).first()
    );
    const lines = await t.run((ctx) => ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect());
    expect(lines.find((l) => l.accountId === ap._id)?.debitMinor).toBe(500_000);
    expect(lines.find((l) => l.accountId === inventory._id)?.creditMinor).toBe(500_000);
    expect(lines.some((l) => l.accountId === retainedEarnings._id)).toBe(false);
  });

  test("CASH_REFUND routes through the selected cash/bank account and requires a payment method", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri5d");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await expect(
      asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId, vehicleId, newCost: 9000, reason: "Supplier refunded the overcharge", correctionType: "CASH_REFUND",
      })
    ).rejects.toThrow(/payment method is required/i);

    await asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId, vehicleId, newCost: 9000, reason: "Supplier refunded the overcharge",
      correctionType: "CASH_REFUND", paymentMethod: "BANK_TRANSFER",
    });

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const event = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleCostCorrections")).first()
    );
    const lines = await t.run((ctx) => ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect());
    expect(lines.find((l) => l.accountId === bank._id)?.debitMinor).toBe(1_000_000);
    expect(lines.find((l) => l.accountId === inventory._id)?.creditMinor).toBe(1_000_000);
  });
});

describe("Review issue #6 — opening-balance backfill avoids double-counting historically-expensed prep costs", () => {
  test("reclassifies a prep expense already posted to GENERAL_EXPENSE instead of also crediting Retained Earnings for it", async () => {
    const { t, orgId, asOwner, userId } = await seedDealer("ri6a");

    // A vehicle that predates inventory capitalization entirely: no VEHICLE_ACQUIRED event.
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "LEGACYVEHICLE0001", make: "Toyota", model: "Camry", year: 2019,
        mileage: 40000, color: "Silver", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE", sourceType: "STOCK",
      })
    );
    // A repair expense that predates the accountingTreatment field entirely
    // (inserted directly, bypassing expenses.create) and was already posted
    // historically to GENERAL_EXPENSE, before capitalization existed.
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, vehicleId, title: "Old repair", amount: 300, date: Date.UTC(2025, 1, 1),
        category: "REPAIR", status: "PAID",
      })
    );
    await t.run((ctx) =>
      postAccountingEvent(ctx, {
        orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
        eventVersion: 1, accountingDate: Date.UTC(2025, 1, 1), occurredAt: Date.UTC(2025, 1, 1),
        currency: "JOD", idempotencyKey: `expense_posted_${expenseId}`,
        payload: { expenseId: expenseId.toString(), amountMinor: 300_000, currency: "JOD", category: "REPAIR", paymentMethod: "CASH" },
        actorId: userId,
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false,
    });
    expect(result.posted).toBe(1);

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const retainedEarnings = await accountBySystemKey(t, orgId, "RETAINED_EARNINGS");
    const generalExpense = await accountBySystemKey(t, orgId, "GENERAL_EXPENSE");

    // Base opening balance is ONLY the purchase price (8000) — the 300 repair
    // is NOT folded in here, since it already has a real historical GL entry.
    const { lines: openingLines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_INVENTORY_OPENING_BALANCE");
    expect(openingLines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(8_000_000);
    expect(openingLines.find((l) => l.accountId === retainedEarnings._id)?.creditMinor).toBe(8_000_000);

    // The repair is reclassified via its own entry, out of General Expense.
    const { lines: reclassLines } = await linesForEvent(t, orgId, "expenses", expenseId, "VEHICLE_PREP_EXPENSE_RECLASSIFIED");
    expect(reclassLines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(300_000);
    expect(reclassLines.find((l) => l.accountId === generalExpense._id)?.creditMinor).toBe(300_000);

    const expense = await t.run((ctx) => ctx.db.get(expenseId));
    expect(expense?.accountingTreatment).toBe("CAPITALIZED_INVENTORY");
    expect(expense?.capitalizedAmount).toBe(300);
  });

  test("folds a capitalizable expense that never touched the GL straight into the base opening balance", async () => {
    const { t, orgId, asOwner } = await seedDealer("ri6b");
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "LEGACYVEHICLE0002", make: "Toyota", model: "Yaris", year: 2020,
        mileage: 20000, color: "Red", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 6000, sellingPrice: 9000, status: "AVAILABLE", sourceType: "STOCK",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, vehicleId, title: "Never posted detailing", amount: 150, date: Date.UTC(2025, 1, 1),
        category: "DETAILING", status: "PAID",
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId, dryRun: false,
    });
    expect(result.posted).toBe(1);

    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const { lines } = await linesForEvent(t, orgId, "vehicles", vehicleId, "VEHICLE_INVENTORY_OPENING_BALANCE");
    // 6000 (purchase price) + 150 (never-posted detailing) folded together.
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(6_150_000);
  });
});

describe("Review issue #7 — manual receivables don't default to income", () => {
  test("rejects an ambiguous source type with no explicit credit account", async () => {
    const { orgId, asOwner, customerId } = await seedDealer("ri7a");
    await expect(
      asOwner.mutation(api.collections.createReceivable, {
        orgId, customerId, sourceType: "INTERNAL_INSTALLMENT", title: "Ambiguous", amount: 500,
        dueDate: Date.UTC(2025, 4, 1),
      })
    ).rejects.toThrow(/credit account isn't obvious/);
  });

  test("derives Customer Deposits Liability automatically for a deposit-like source type", async () => {
    const { t, orgId, asOwner, customerId } = await seedDealer("ri7b");
    const receivableId = await asOwner.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "CUSTOMER_DEPOSIT", title: "Deposit hold", amount: 400,
      dueDate: Date.UTC(2025, 4, 1),
    });

    const ar = await accountBySystemKey(t, orgId, "ACCOUNTS_RECEIVABLE_CUSTOMERS");
    const depositsLiability = await accountBySystemKey(t, orgId, "CUSTOMER_DEPOSITS_LIABILITY");
    const { lines } = await linesForEvent(t, orgId, "receivables", receivableId, "RECEIVABLE_CREATED");
    expect(lines.find((l) => l.accountId === ar._id)?.debitMinor).toBe(400_000);
    expect(lines.find((l) => l.accountId === depositsLiability._id)?.creditMinor).toBe(400_000);
  });

  test("an explicit creditSystemKey overrides the default for OTHER", async () => {
    const { t, orgId, asOwner, customerId } = await seedDealer("ri7c");
    const receivableId = await asOwner.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "OTHER", title: "Cost reimbursement", amount: 120,
      dueDate: Date.UTC(2025, 4, 1), creditSystemKey: "GENERAL_EXPENSE",
    });

    const generalExpense = await accountBySystemKey(t, orgId, "GENERAL_EXPENSE");
    const { lines } = await linesForEvent(t, orgId, "receivables", receivableId, "RECEIVABLE_CREATED");
    expect(lines.find((l) => l.accountId === generalExpense._id)?.creditMinor).toBe(120_000);
  });
});
