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
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { postAccountingEvent } from "./accounting/postingEngine";
import { IMPORT_BULK_MAX_POSTING_ROWS } from "./vehicles";
import { PURCHASE_IMPORT_MAX_ROWS } from "./utils/importLimits";

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
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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

/** Sale cancellation requires an approver distinct from the sale's own salesperson. */
async function addCancellationApprover(t: Ctx["t"], orgId: Id<"organizations">, tag: string) {
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_approver`,
      email: `${tag}.approver@example.com`,
      name: `${tag} Approver`,
    })
  );
  const approverRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: `${tag} Manager`,
      permissions: ["view:sales", "edit:sales", "approve:requests"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId: approverRoleId }));
  return t.withIdentity({ subject: `${tag}_approver`, clerkId: `${tag}_approver` });
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

describe("Dealer fees post to the GL", () => {
  test("dealer fees inflate the AR debit and credit Dealer Fee Income", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fee_a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, dealerFees: 300, saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const { lines } = await linesForEvent(t, orgId, "sales", saleId, "SALE_COMPLETED");
    const ar = await accountBySystemKey(t, orgId, "ACCOUNTS_RECEIVABLE_CUSTOMERS");
    const feeIncome = await accountBySystemKey(t, orgId, "DEALER_FEE_INCOME");
    expect(lines.find((l) => l.accountId === ar._id)?.debitMinor).toBe(15_300_000);
    expect(lines.find((l) => l.accountId === feeIncome._id)?.creditMinor).toBe(300_000);

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    const receivable = await t.run((ctx) => ctx.db.get(sale!.canonicalReceivableDocumentId!));
    expect(receivable?.originalAmountMinor).toBe(15_300_000);

    const recon = await asOwner.query(api.accountingReports.subledgerReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
  });

  test("a sale with no dealer fees has no Dealer Fee Income line", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fee_b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const { lines } = await linesForEvent(t, orgId, "sales", saleId, "SALE_COMPLETED");
    const feeIncome = await accountBySystemKey(t, orgId, "DEALER_FEE_INCOME");
    expect(lines.some((l) => l.accountId === feeIncome._id)).toBe(false);
  });
});

describe("A cancelled sale's receivable stops counting as AR — but only from its cancellation date onward", () => {
  test("historical AR aging as of a date BEFORE cancellation still counts the receivable as outstanding", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ar_cancel_hist");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const saleDate = Date.UTC(2025, 3, 1);
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate, status: "COMPLETED",
    });

    // sales.update's cancellation path always dates the reversal at
    // Date.now() (real cancellation is never backdated), so cancelling here
    // happens "in the future" relative to saleDate — an asOfDate of saleDate
    // itself is therefore guaranteed to be before cancellation.
    const asApprover = await addCancellationApprover(t, orgId, "ar_cancel_hist");
    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const historicalAging = await asOwner.query(api.accountingReports.arAging, { orgId, asOfDate: saleDate });
    expect(historicalAging.currencies).toEqual(["JOD"]);
    expect(historicalAging.byCurrency.JOD.totalOutstandingMinor).toBe(15_000_000);

    const historicalRecon = await asOwner.query(api.accountingReports.subledgerReconciliation, {
      orgId, toDate: saleDate,
    });
    expect(historicalRecon.byCurrency.JOD.subledgerOutstandingMinor).toBe(15_000_000);

    // Current-state reports (asOfDate defaults to now, i.e. after
    // cancellation) must exclude it entirely — matching the GL side, which
    // hookSaleCancelled already zeroed via a reversal journal.
    const currentAging = await asOwner.query(api.accountingReports.arAging, { orgId });
    expect(currentAging.currencies).toHaveLength(0);
    const currentRecon = await asOwner.query(api.accountingReports.subledgerReconciliation, { orgId });
    expect(currentRecon.isReconciled).toBe(true);
  });

  test("a cancelled receivable reads as zero balance and rejects a new payment allocation", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ar_cancel_balance");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    const receivableId = sale!.canonicalReceivableDocumentId!;

    const asApprover = await addCancellationApprover(t, orgId, "ar_cancel_balance");
    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const receivable = await t.run((ctx) => ctx.db.get(receivableId));
    expect(receivable?.status).toBe("CANCELLED");
    expect(receivable?.cancelledAt).toBeTruthy();
    // Cancelled by the approver identity (not userId/the salesperson) —
    // sales.update requires a different actor from the sale's own salesperson.
    expect(receivable?.cancelledBy).toBeTruthy();
    expect(receivable?.cancelledBy).not.toBe(userId);
    expect(receivable?.cancellationReason).toBe("Sale cancelled");

    const balance = await asOwner.query(api.subledger.getReceivableBalance, { orgId, receivableDocumentId: receivableId });
    expect(balance?.outstandingMinor).toBe(0);

    // A stray payment must never be allocatable to a dead receivable, even
    // though nothing else about it (e.g. its originalAmountMinor) changed.
    const strayPaymentId = await t.run((ctx) =>
      ctx.db.insert("canonicalPayments", {
        orgId, direction: "IN", payerType: "CUSTOMER", customerId,
        method: "CASH", amountMinor: 5_000_000, currency: "JOD", scale: 3,
        idempotencyKey: "stray-payment-1", status: "SETTLED",
        createdBy: userId, createdAt: Date.now(),
      })
    );
    await expect(
      asOwner.mutation(internal.subledger.allocate, {
        orgId, paymentId: strayPaymentId, receivableDocumentId: receivableId, amountMinor: 1_000_000,
      })
    ).rejects.toThrow(/exceeds receivable outstanding balance/);
  });
});

describe("Trade-in vehicles net against the sale's AR", () => {
  test("a trade-in vehicle capitalizes into inventory and reduces AR by its value", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000001AX", status: "AVAILABLE",
    });

    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const { lines } = await linesForEvent(t, orgId, "vehicles", tradeInVehicleId, "TRADE_IN_ACCEPTED");
    const inventory = await accountBySystemKey(t, orgId, "VEHICLE_INVENTORY");
    const ar = await accountBySystemKey(t, orgId, "ACCOUNTS_RECEIVABLE_CUSTOMERS");
    expect(lines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(4_000_000);
    expect(lines.find((l) => l.accountId === ar._id)?.creditMinor).toBe(4_000_000);

    const tradeInVehicle = await t.run((ctx) => ctx.db.get(tradeInVehicleId));
    expect(tradeInVehicle?.purchasePrice).toBe(4000);

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    const receivableBalance = await asOwner.query(api.subledger.getReceivableBalance, {
      orgId, receivableDocumentId: sale!.canonicalReceivableDocumentId!,
    });
    // 15000 sale price minus the 4000 trade-in allocation.
    expect(receivableBalance?.outstandingMinor).toBe(11_000_000);

    const recon = await asOwner.query(api.accountingReports.subledgerReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
  });

  test("rejects a trade-in vehicle that's already capitalized (has a purchase price)", async () => {
    const { asOwner, orgId, customerId, userId } = await seedDealer("ti_b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000002AX", purchasePrice: 2000, purchasePaymentMethod: "CASH",
    });

    await expect(
      asOwner.mutation(api.sales.create, {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
        saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
      })
    ).rejects.toThrow(/already has a purchase price/i);
  });

  test("rejects a vehicle traded in against its own sale", async () => {
    const { asOwner, orgId, customerId, userId } = await seedDealer("ti_self");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await expect(
      asOwner.mutation(api.sales.create, {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15000, tradeInVehicleId: vehicleId, tradeInValue: 4000,
        saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
      })
    ).rejects.toThrow(/cannot be traded in against its own sale/i);
  });

  test("rejects a SOLD trade-in vehicle", async () => {
    const { t, asOwner, orgId, customerId, userId } = await seedDealer("ti_sold");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000003AX", status: "AVAILABLE",
    });
    // status is workflow-controlled (only completing a sale can set SOLD) —
    // patch directly to set up the pre-existing state this check guards against.
    await t.run((ctx) => ctx.db.patch(tradeInVehicleId, { status: "SOLD" }));

    await expect(
      asOwner.mutation(api.sales.create, {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
        saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
      })
    ).rejects.toThrow(/cannot be accepted as a trade-in/i);
  });

  test("rejects a SOURCED trade-in vehicle (its cost basis would never be established)", async () => {
    const { asOwner, orgId, customerId, userId } = await seedDealer("ti_sourced");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000004AX", status: "SOURCING", sourceType: "SOURCED",
      sourcedFromName: "Test Supplier Dealer", sourceCost: 3000,
    });

    await expect(
      asOwner.mutation(api.sales.create, {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
        saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
      })
    ).rejects.toThrow(/sourced\/drop-ship vehicle/i);
  });

  test("cancelling a completed sale with a trade-in fully reverses it", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_cancel");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000005AX", status: "AVAILABLE",
    });

    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const asApprover = await addCancellationApprover(t, orgId, "ti_cancel");
    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const event = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
        q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", tradeInVehicleId)
      ).filter((q) => q.eq(q.field("eventType"), "TRADE_IN_ACCEPTED")).first()
    );
    expect(event?.status).toBe("REVERSED");
    expect(event?.reversedByEventId).toBeTruthy();

    const tradeInVehicle = await t.run((ctx) => ctx.db.get(tradeInVehicleId));
    expect(tradeInVehicle?.purchasePrice).toBeUndefined();

    const payment = await t.run((ctx) =>
      ctx.db.query("canonicalPayments").withIndex("by_org_idempotency", (q) =>
        q.eq("orgId", orgId).eq("idempotencyKey", `trade_in_payment_${saleId}`)
      ).unique()
    );
    expect(payment?.status).toBe("VOIDED");

    // A cancelled receivable must not reappear as outstanding — cancelledAt
    // (set alongside status: "CANCELLED") lets both reports exclude it for
    // any asOfDate on/after cancellation, matching the GL side which
    // hookSaleCancelled already zeroed out via a reversal journal.
    const recon = await asOwner.query(api.accountingReports.subledgerReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
    const aging = await asOwner.query(api.accountingReports.arAging, { orgId });
    expect(aging.currencies).toHaveLength(0);

    // The trade-in vehicle was AVAILABLE and had no subsequent activity, so
    // the reversal pulls it out of sellable inventory pending a human
    // re-establishing a real cost basis, rather than leaving it AVAILABLE
    // with a wiped (zero) purchasePrice.
    expect(tradeInVehicle?.status).toBe("IN_INSPECTION");
  });

  test("reversing a second trade-in of the same vehicle (on a later sale) doesn't collide with the first reversal's key", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_reuse");
    const vehicleA = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000006AX", purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const vehicleB = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000007AX", purchasePrice: 12000, purchasePaymentMethod: "CASH",
    });
    const reusedVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000008AX", status: "AVAILABLE",
    });
    const asApprover = await addCancellationApprover(t, orgId, "ti_reuse");

    // First trade-in: sell vehicleA, trade in reusedVehicleId, then cancel.
    const saleA = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId: vehicleA, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId: reusedVehicleId, tradeInValue: 4000,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });
    await asApprover.mutation(api.sales.update, { orgId, saleId: saleA, status: "CANCELLED" });
    const reusedVehicleAfterFirstCancel = await t.run((ctx) => ctx.db.get(reusedVehicleId));
    expect(reusedVehicleAfterFirstCancel?.purchasePrice).toBeUndefined();

    // Second trade-in: the same vehicle, now clear of a purchase price, is
    // traded in again on a different sale — then that one is cancelled too.
    const saleB = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId: vehicleB, customerId, salespersonId: userId,
      salePrice: 18000, tradeInVehicleId: reusedVehicleId, tradeInValue: 5000,
      saleDate: Date.UTC(2025, 4, 1), status: "COMPLETED",
    });
    await asApprover.mutation(api.sales.update, { orgId, saleId: saleB, status: "CANCELLED" });

    const secondEvent = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
        q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", reusedVehicleId)
      ).filter((q) => q.eq(q.field("eventType"), "TRADE_IN_ACCEPTED")).collect()
    );
    // Both this vehicle's TRADE_IN_ACCEPTED events (one per sale) must have
    // actually been reversed — a vehicle-only reversal key would let the
    // second one silently short-circuit as "already reversed".
    expect(secondEvent).toHaveLength(2);
    expect(secondEvent.every((e) => e.status === "REVERSED")).toBe(true);
  });

  test("cancelling a sale that stores a tradeInVehicleId but no positive tradeInValue never touches that vehicle", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_novalue");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    // A genuinely, separately-acquired vehicle with its own legitimate cost basis.
    const otherVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000009AX", purchasePrice: 7000, purchasePaymentMethod: "CASH",
    });

    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId: otherVehicleId, // no tradeInValue
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const asApprover = await addCancellationApprover(t, orgId, "ti_novalue");
    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    // otherVehicleId's real purchasePrice must survive — completion never
    // actually ran the trade-in branch for it (no positive tradeInValue), so
    // cancellation must not treat it as a trade-in to undo.
    const otherVehicle = await t.run((ctx) => ctx.db.get(otherVehicleId));
    expect(otherVehicle?.purchasePrice).toBe(7000);
  });

  test("refuses to auto-cancel a trade-in that has already been resold", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_resold");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000010AX", status: "AVAILABLE",
    });
    const saleA = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    // The traded-in vehicle is now real inventory (purchasePrice = 4000) —
    // resell it on a second, unrelated sale.
    const otherCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Sam", lastName: "Buyer", email: "sam@example.com" })
    );
    await asOwner.mutation(api.sales.create, {
      orgId, vehicleId: tradeInVehicleId, customerId: otherCustomerId, salespersonId: userId,
      salePrice: 6000, saleDate: Date.UTC(2025, 4, 1), status: "COMPLETED",
    });

    const asApprover = await addCancellationApprover(t, orgId, "ti_resold");
    await expect(
      asApprover.mutation(api.sales.update, { orgId, saleId: saleA, status: "CANCELLED" })
    ).rejects.toThrow(/already been resold/i);

    // Nothing about the original sale/receivable should have been touched —
    // the whole mutation must roll back atomically on the guard's throw.
    const sale = await t.run((ctx) => ctx.db.get(saleA));
    expect(sale?.status).toBe("COMPLETED");
  });

  test("refuses to auto-cancel a trade-in that's currently reserved", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_reserved");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000011AX", status: "AVAILABLE",
    });
    const saleA = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    // Simulates a deposit/reservation hold placed on the traded-in vehicle
    // after it became inventory — the exact vehicle-status transition
    // holdVehicleForDeposit/syncVehicleHoldStatus would make.
    await t.run((ctx) => ctx.db.patch(tradeInVehicleId, { status: "RESERVED" }));

    const asApprover = await addCancellationApprover(t, orgId, "ti_reserved");
    await expect(
      asApprover.mutation(api.sales.update, { orgId, saleId: saleA, status: "CANCELLED" })
    ).rejects.toThrow(/currently reserved/i);
  });

  test("refuses to auto-cancel a trade-in that has received landed costs since acceptance", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_landed");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000012AX", status: "AVAILABLE",
    });
    const saleA = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    await asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId, vehicleId: tradeInVehicleId,
      items: [{ label: "Reconditioning", amount: 250, paymentMethod: "CASH" }],
    });

    const asApprover = await addCancellationApprover(t, orgId, "ti_landed");
    await expect(
      asApprover.mutation(api.sales.update, { orgId, saleId: saleA, status: "CANCELLED" })
    ).rejects.toThrow(/received landed costs/i);
  });

  test("refuses to auto-cancel a trade-in that has capitalized repair costs since acceptance", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("ti_repair");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const tradeInVehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "TRD3N9AN0000013AX", status: "AVAILABLE",
    });
    const saleA = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, tradeInVehicleId, tradeInValue: 4000,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    // Mirrors what recordPaidExpenseSideEffects would have stamped on a real
    // capitalized repair — inserted directly since exercising the full
    // expense-posting pipeline is already covered elsewhere and isn't what
    // this guard test is about.
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId, vehicleId: tradeInVehicleId, title: "Brake job", amount: 150,
        date: Date.UTC(2025, 3, 10), category: "REPAIR", status: "PAID",
        accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 150,
      })
    );

    const asApprover = await addCancellationApprover(t, orgId, "ti_repair");
    await expect(
      asApprover.mutation(api.sales.update, { orgId, saleId: saleA, status: "CANCELLED" })
    ).rejects.toThrow(/capitalized repair/i);
  });
});

describe("Resold warranty/GAP products defer the dealer's margin", () => {
  test("premium inflates AR, cost credits the payable, margin is deferred", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fi_a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000,
      warrantySold: 500, warrantyCost: 300, warrantyTermMonths: 10,
      gapSold: 200, gapCost: 120, gapTermMonths: 12,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const { lines } = await linesForEvent(t, orgId, "sales", saleId, "SALE_COMPLETED");
    const ar = await accountBySystemKey(t, orgId, "ACCOUNTS_RECEIVABLE_CUSTOMERS");
    const payable = await accountBySystemKey(t, orgId, "WARRANTY_GAP_PAYABLE");
    const deferred = await accountBySystemKey(t, orgId, "DEFERRED_FI_COMMISSION");
    const sumCredit = (accountId: string) =>
      lines.filter((l) => l.accountId === accountId).reduce((s, l) => s + l.creditMinor, 0);
    // AR = 15000 sale + 500 warranty + 200 gap = 15700.
    expect(lines.find((l) => l.accountId === ar._id)?.debitMinor).toBe(15_700_000);
    // Payable = 300 (warranty cost) + 120 (gap cost) = 420, across two separate lines.
    expect(sumCredit(payable._id)).toBe(420_000);
    // Deferred = (500-300) + (200-120) = 200 + 80 = 280, across two separate lines.
    expect(sumCredit(deferred._id)).toBe(280_000);

    const deferrals = await t.run((ctx) =>
      ctx.db.query("dealerProductDeferrals").withIndex("by_sale", (q) => q.eq("saleId", saleId)).collect()
    );
    expect(deferrals).toHaveLength(2);
    const warranty = deferrals.find((d) => d.productType === "WARRANTY")!;
    const gap = deferrals.find((d) => d.productType === "GAP")!;
    expect(warranty.totalMarginMinor).toBe(200_000);
    expect(warranty.termMonths).toBe(10);
    expect(warranty.status).toBe("ACTIVE");
    expect(gap.totalMarginMinor).toBe(80_000);
    expect(gap.termMonths).toBe(12);

    const recon = await asOwner.query(api.accountingReports.subledgerReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
  });

  test("requires a term when a warranty premium is charged", async () => {
    const { asOwner, orgId, customerId, userId } = await seedDealer("fi_b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    await expect(
      asOwner.mutation(api.sales.create, {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15000, warrantySold: 500, warrantyCost: 300,
        saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
      })
    ).rejects.toThrow(/warranty term.*required/i);
  });

  test("a zero-margin product (cost equals sold) creates no deferral", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fi_c");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, warrantySold: 500, warrantyCost: 500, warrantyTermMonths: 12,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const deferrals = await t.run((ctx) =>
      ctx.db.query("dealerProductDeferrals").withIndex("by_sale", (q) => q.eq("saleId", saleId)).collect()
    );
    expect(deferrals).toHaveLength(0);

    const { lines } = await linesForEvent(t, orgId, "sales", saleId, "SALE_COMPLETED");
    const deferred = await accountBySystemKey(t, orgId, "DEFERRED_FI_COMMISSION");
    expect(lines.some((l) => l.accountId === deferred._id)).toBe(false);
  });

  test("cancelling a sale cancels its never-recognized deferral", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fi_cancel_a");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, warrantySold: 500, warrantyCost: 300, warrantyTermMonths: 10,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    const asApprover = await addCancellationApprover(t, orgId, "fi_cancel_a");
    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const deferral = await t.run((ctx) =>
      ctx.db.query("dealerProductDeferrals").withIndex("by_sale", (q) => q.eq("saleId", saleId)).first()
    );
    expect(deferral?.status).toBe("CANCELLED");
  });

  test("cancelling a sale claws back F&I revenue already recognized for its deferral", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fi_cancel_b");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, warrantySold: 500, warrantyCost: 300, warrantyTermMonths: 10,
      saleDate: Date.now(), status: "COMPLETED",
    });

    // Recognize one month before the sale is cancelled.
    await t.action(internal.crons.triggerFiCommissionRecognition, {});
    const deferralBefore = await t.run((ctx) =>
      ctx.db.query("dealerProductDeferrals").withIndex("by_sale", (q) => q.eq("saleId", saleId)).first()
    );
    expect(deferralBefore?.recognizedMinor).toBeGreaterThan(0);

    const recognizedEvents = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "FI_COMMISSION_RECOGNIZED")).collect()
    );
    expect(recognizedEvents).toHaveLength(1);

    const asApprover = await addCancellationApprover(t, orgId, "fi_cancel_b");
    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const reversedEvent = await t.run((ctx) => ctx.db.get(recognizedEvents[0]._id));
    expect(reversedEvent?.status).toBe("REVERSED");

    const deferralAfter = await t.run((ctx) => ctx.db.get(deferralBefore!._id));
    expect(deferralAfter?.status).toBe("CANCELLED");

    // The monthly cron must never touch it again.
    const summary: string = await t.action(internal.crons.triggerFiCommissionRecognition, {});
    expect(summary).toMatch(/posted 0\/0/i);
  });

  test("cancelling a sale also drops a FAILED (not just PENDING) queued recognition post for its deferral", async () => {
    const { t, orgId, asOwner, customerId, userId, userId: actorId } = await seedDealer("fi_cancel_failed");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    const saleId = await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, warrantySold: 500, warrantyCost: 300, warrantyTermMonths: 10,
      saleDate: Date.now(), status: "COMPLETED",
    });
    const deferral = await t.run((ctx) =>
      ctx.db.query("dealerProductDeferrals").withIndex("by_sale", (q) => q.eq("saleId", saleId)).first()
    );

    // Simulates a monthly recognition attempt that failed 10 times (moved
    // out of auto-retry into FAILED, per accountingOutbox.ts's MAX_ATTEMPTS)
    // and is still sitting in the outbox, unposted, when the sale gets
    // cancelled — the exact scenario a finance user could later retry.
    const pendingId = await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId,
        kind: "POST",
        status: "FAILED",
        idempotencyKey: `fi_commission_${deferral!._id}_2025-01`,
        accountingDate: Date.UTC(2025, 0, 31),
        actorId,
        attempts: 10,
        lastError: "no open period",
        createdAt: Date.now(),
        sourceType: "dealerProductDeferrals",
        sourceId: deferral!._id.toString(),
        eventType: "FI_COMMISSION_RECOGNIZED",
        eventVersion: 1,
        currency: "JOD",
        occurredAt: Date.UTC(2025, 0, 31),
        payload: { deferralId: deferral!._id.toString(), amountMinor: 20_000, currency: "JOD" },
      })
    );

    const asApprover = await addCancellationApprover(t, orgId, "fi_cancel_failed");
    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    // Must be gone, not just left FAILED — a finance user resetting a FAILED
    // entry back to PENDING and retrying it must not be able to post revenue
    // for a deferral whose sale was already cancelled.
    const stillThere = await t.run((ctx) => ctx.db.get(pendingId));
    expect(stillThere).toBeNull();
  });
});

describe("Monthly F&I commission recognition cron", () => {
  test("recognizes one month of deferred margin, end to end, without double-posting", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fi_cron");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, warrantySold: 500, warrantyCost: 300, warrantyTermMonths: 10,
      saleDate: Date.now(), status: "COMPLETED",
    });

    const summary: string = await t.action(internal.crons.triggerFiCommissionRecognition, {});
    expect(summary).toMatch(/posted 1\/1/i);

    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "FI_COMMISSION_RECOGNIZED")).collect()
    );
    expect(events).toHaveLength(1);
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", events[0].journalEntryId!)).collect()
    );
    const deferred = await accountBySystemKey(t, orgId, "DEFERRED_FI_COMMISSION");
    const revenue = await accountBySystemKey(t, orgId, "FI_COMMISSION_REVENUE");
    // Margin = 500-300 = 200, over 10 months = floor(200_000/10) = 20_000/month.
    expect(lines.find((l) => l.accountId === deferred._id)?.debitMinor).toBe(20_000);
    expect(lines.find((l) => l.accountId === revenue._id)?.creditMinor).toBe(20_000);

    const deferral = await t.run((ctx) => ctx.db.query("dealerProductDeferrals").withIndex("by_org", (q) => q.eq("orgId", orgId)).first());
    expect(deferral?.recognizedMinor).toBe(20_000);
    expect(deferral?.status).toBe("ACTIVE");

    // Running the cron again in the same calendar month must not double-post.
    const secondSummary: string = await t.action(internal.crons.triggerFiCommissionRecognition, {});
    expect(secondSummary).toMatch(/posted 0\/1/i);
    expect(
      await t.run((ctx) =>
        ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId))
          .filter((q) => q.eq(q.field("eventType"), "FI_COMMISSION_RECOGNIZED")).collect()
      )
    ).toHaveLength(1);
  });

  test("a margin that doesn't divide evenly finishes in exactly termMonths, not termMonths+1", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fi_ceil");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    // Margin = 500-400 = 100 (minor units, JOD scale 3 -> 100 already in whole
    // units here since warrantySold/Cost are decimal JOD; use whole-JOD amounts
    // that convert to a minor-unit margin not evenly divisible by 3).
    await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, warrantySold: 0.100, warrantyCost: 0, warrantyTermMonths: 3,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });
    const deferral = await t.run((ctx) =>
      ctx.db.query("dealerProductDeferrals").withIndex("by_org", (q) => q.eq("orgId", orgId)).first()
    );
    expect(deferral?.totalMarginMinor).toBe(100); // 100 minor units, not divisible by 3

    const recognize = (yearMonth: string) =>
      t.mutation(internal.dealerProductDeferrals.recognizeDeferredCommissionForMonth, {
        orgId, deferralId: deferral!._id, yearMonth, occurredAt: Date.now(), systemActorId: userId,
      });

    const m1 = await recognize("2025-01");
    const m2 = await recognize("2025-02");
    const m3 = await recognize("2025-03");
    expect(m1.posted && m2.posted && m3.posted).toBe(true);
    expect((m1.amountMinor ?? 0) + (m2.amountMinor ?? 0) + (m3.amountMinor ?? 0)).toBe(100);

    const after = await t.run((ctx) => ctx.db.get(deferral!._id));
    expect(after?.status).toBe("FULLY_RECOGNIZED");
    expect(after?.recognizedMinor).toBe(100);

    // A 4th month must find nothing left to recognize — the deferral finished
    // in exactly 3 months, never needing a 4th.
    const m4 = await recognize("2025-04");
    expect(m4.posted).toBe(false);
    expect(m4.reason).toBe("not_active"); // already FULLY_RECOGNIZED after month 3
  });

  test("rejects an out-of-order (earlier) yearMonth", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("fi_order");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    await asOwner.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, warrantySold: 500, warrantyCost: 300, warrantyTermMonths: 10,
      saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });
    const deferral = await t.run((ctx) =>
      ctx.db.query("dealerProductDeferrals").withIndex("by_org", (q) => q.eq("orgId", orgId)).first()
    );

    const recognize = (yearMonth: string) =>
      t.mutation(internal.dealerProductDeferrals.recognizeDeferredCommissionForMonth, {
        orgId, deferralId: deferral!._id, yearMonth, occurredAt: Date.now(), systemActorId: userId,
      });

    await recognize("2025-08");
    const earlier = await recognize("2025-07");
    expect(earlier.posted).toBe(false);
    expect(earlier.reason).toBe("not_after_last_recognized_month");

    const after = await t.run((ctx) => ctx.db.get(deferral!._id));
    // Only the 2025-08 month's amount was ever recognized.
    expect(after?.recognizedMinor).toBe(20_000);
  });
});

describe("vehicleInventoryReconciliation", () => {
  test("an owned in-stock vehicle reconciles Vehicle Inventory GL against capitalized cost", async () => {
    const { orgId, asOwner } = await seedDealer("recon_a");
    await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    const recon = await asOwner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId });
    expect(recon.currencies).toEqual(["JOD"]);
    expect(recon.byCurrency.JOD.glBalanceMinor).toBe(10_000_000);
    expect(recon.byCurrency.JOD.subledgerBalanceMinor).toBe(10_000_000);
    expect(recon.isReconciled).toBe(true);
  });

  test("a sourced/drop-ship vehicle is excluded from both sides", async () => {
    const { orgId, asOwner } = await seedDealer("recon_b");
    await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "SRC3D9AN0000099AX", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 9000,
    });

    const recon = await asOwner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId });
    expect(recon.currencies).toEqual([]);
  });

  test("a sold vehicle no longer counts toward the subledger side", async () => {
    const { t, orgId, asOwner } = await seedDealer("recon_c");
    const vehicleId = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "SOLD" }));

    const recon = await asOwner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId });
    // The GL side isn't relieved by this direct status patch (a real sale
    // would post COST_OF_VEHICLES_SOLD/inventory-relief) — this asserts only
    // that the subledger side correctly drops a SOLD vehicle from its sum,
    // which is what surfaces as a discrepancy for the accountant to review.
    expect(recon.byCurrency.JOD.subledgerBalanceMinor).toBe(0);
    expect(recon.byCurrency.JOD.glBalanceMinor).toBe(10_000_000);
    expect(recon.isReconciled).toBe(false);
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
    const marketingExpense = await accountBySystemKey(t, orgId, "MARKETING_EXPENSE");

    const { lines: repairLines } = await linesForEvent(t, orgId, "expenses", repairExpenseId, "EXPENSE_POSTED");
    expect(repairLines.find((l) => l.accountId === inventory._id)?.debitMinor).toBe(400_000);
    expect(repairLines.some((l) => l.accountId === generalExpense._id)).toBe(false);

    // MARKETING routes to its own dedicated expense account, not Vehicle
    // Inventory — vehicle-linked or not, marketing spend is never inventoriable.
    const { lines: marketingLines } = await linesForEvent(t, orgId, "expenses", marketingExpenseId, "EXPENSE_POSTED");
    expect(marketingLines.find((l) => l.accountId === marketingExpense._id)?.debitMinor).toBe(100_000);
    expect(marketingLines.some((l) => l.accountId === inventory._id)).toBe(false);
    expect(marketingLines.some((l) => l.accountId === generalExpense._id)).toBe(false);
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

    const vehicleId2 = await asOwner.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, vin: "1HGCM82633A000002", purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    await asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId, vehicleId: vehicleId2, newCost: 9700, reason: "Supplier invoice was entered with the wrong total",
      correctionType: "SUPPLIER_INVOICE_ERROR",
    });
    const event2 = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleCostCorrections")).collect()
    ).then((events) => events.find((e) => e.sourceId !== event!.sourceId));
    const lines2 = await t.run((ctx) => ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event2!.journalEntryId!)).collect());
    expect(lines2.find((l) => l.accountId === ap._id)?.debitMinor).toBe(300_000);
    expect(lines2.find((l) => l.accountId === inventory._id)?.creditMinor).toBe(300_000);
    expect(lines2.some((l) => l.accountId === retainedEarnings._id)).toBe(false);
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

// ─── SCRUM-59 ─────────────────────────────────────────────────────────────────

/** Net GL balance (debits − credits) of a system account, in minor units. */
async function glBalanceMinor(t: Ctx["t"], orgId: Id<"organizations">, systemKey: string) {
  const account = await accountBySystemKey(t, orgId, systemKey);
  const lines = await t.run((ctx) =>
    ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
  return lines
    .filter((l) => l.accountId === account._id)
    .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
}

const baseImportRow = {
  make: "Kia", model: "Sportage", year: 2023, color: "Silver",
  fuelType: "Petrol", transmission: "Automatic", sellingPrice: 15000,
};

async function vehicleByVin(t: Ctx["t"], orgId: Id<"organizations">, vin: string) {
  return t.run((ctx) =>
    ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", orgId).eq("vin", vin)).unique()
  );
}

describe("SCRUM-59 — a CSV import must not create inventory the GL never saw", () => {
  test("PURCHASE capitalizes every imported row, so selling one cannot drive Vehicle Inventory negative", async () => {
    const { t, orgId, asOwner, customerId, userId } = await seedDealer("s59a");

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId,
      acquisitionPosting: "PURCHASE", importId: "imp-1",
      purchasePaymentMethod: "CASH",
      vehicles: [
        { rowId: 1, ...baseImportRow, vin: "IMPORTGL0000001AA", purchasePrice: 10000 },
        { rowId: 2, ...baseImportRow, vin: "IMPORTGL0000002BB", purchasePrice: 10000 },
      ],
    });

    // Both cars are on the books before anything is sold.
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(20_000_000); // JOD scale 3
    expect(await glBalanceMinor(t, orgId, "CASH_ON_HAND")).toBe(-20_000_000);

    const sold = await vehicleByVin(t, orgId, "IMPORTGL0000001AA");
    await asOwner.mutation(api.sales.create, {
      orgId, vehicleId: sold!._id, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.UTC(2025, 3, 1), status: "COMPLETED",
    });

    // Before the fix this was −10,000,000: the sale credited Vehicle Inventory
    // for a car the import never debited. The remaining car's cost is what is
    // left, not a negative asset.
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);

    const recon = await asOwner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
  });

  test("OPENING_STOCK posts nothing — the opening balance is that stock's GL entry", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59b");

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId,
      acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ ...baseImportRow, vin: "IMPORTOB0000001AA", purchasePrice: 10000 }],
    });

    const vehicle = await vehicleByVin(t, orgId, "IMPORTOB0000001AA");
    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicle!._id.toString())
        )
        .first()
    );
    expect(event).toBeNull();
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
    // Nor a legacy cash transaction — no money moved for stock already owned.
    const txns = await t.run((ctx) =>
      ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(txns).toHaveLength(0);
  });

  test("PURCHASE refuses an import that does not say how it was paid for", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59c");

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId,
        acquisitionPosting: "PURCHASE", importId: "imp-2",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTNOPM000001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/Payment method is required/);

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
  });

  test("ON_ACCOUNT without a supplier fails the whole file before any row is written", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59d");

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId,
        acquisitionPosting: "PURCHASE", importId: "imp-3",
        purchasePaymentMethod: "ON_ACCOUNT",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTOA00000001A", purchasePrice: 10000, sourcedFromName: "Gulf Motors" },
          { rowId: 2, ...baseImportRow, vin: "IMPORTOA00000002B", purchasePrice: 10000 },
        ],
      })
    ).rejects.toThrow(/supplier name is required/i);

    // Not even the valid first row — a file that cannot post correctly must not
    // half-import.
    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
  });

  test("ON_ACCOUNT credits AP-Suppliers and creates the supplier payable instead of paying cash", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59e");

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId,
      acquisitionPosting: "PURCHASE", importId: "imp-4",
      purchasePaymentMethod: "ON_ACCOUNT",
      vehicles: [
        { rowId: 1, ...baseImportRow, vin: "IMPORTOA00000003C", purchasePrice: 10000, sourcedFromName: "Gulf Motors" },
      ],
    });

    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);
    expect(await glBalanceMinor(t, orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(-10_000_000);
    expect(await glBalanceMinor(t, orgId, "CASH_ON_HAND")).toBe(0);

    const payables = await t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(payables).toHaveLength(1);
    expect(payables[0].sourcedFromName).toBe("Gulf Motors");
    expect(payables[0].amountDue).toBe(10000);
  });

  test("a SOURCED row never capitalizes into inventory, even under PURCHASE", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59f");

    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId,
      acquisitionPosting: "PURCHASE", importId: "imp-5",
      purchasePaymentMethod: "CASH",
      vehicles: [
        { rowId: 1,
          ...baseImportRow, vin: "IMPORTSRC0000001A", sourceType: "SOURCED",
          sourcedFromName: "Other Dealer", sourceCost: 9000,
        },
      ],
    });

    // Both balances are also 0 when the row was never created at all, and a
    // SOURCED row missing its supplier name or cost IS skipped a few lines
    // later in importBulk. Without this the test passes on a regression that
    // silently drops the row it claims to be about.
    expect(result.inserted).toBe(1);
    const sourced = await vehicleByVin(t, orgId, "IMPORTSRC0000001A");
    expect(sourced).not.toBeNull();
    expect(sourced!.sourceType).toBe("SOURCED");

    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
    expect(await glBalanceMinor(t, orgId, "CASH_ON_HAND")).toBe(0);
  });

  test("PURCHASE refuses a row with no real VIN, so a retry cannot capitalize it twice", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59h");

    // A placeholder VIN gets a fresh random value on every import, so the
    // by-VIN dedup below can never match it — re-submitting the same file would
    // insert a second vehicle AND post a second acquisition for a car already
    // on the books. vehicles.create refuses a non-sourced vehicle with no VIN
    // for the same reason; PURCHASE-mode import now applies the same rule.
    for (const vin of ["", "xxxxxxxxxxxxxxxxx", "N/A"]) {
      await expect(
        asOwner.mutation(api.vehicles.importBulk, {
          orgId,
          acquisitionPosting: "PURCHASE", importId: "imp-6",
          purchasePaymentMethod: "CASH",
          vehicles: [{ rowId: 1, ...baseImportRow, vin, purchasePrice: 10000 }],
        })
      ).rejects.toThrow(/VIN/i);
    }

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
  });

  test("PURCHASE refuses a VIN-less row of ANY shape, because an acquisition needs durable vehicle identity", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59m");

    // A sourced row and a cost-less owned row post nothing TODAY, so an earlier
    // version of this guard let them through. Both are still inserted, both get
    // a fresh random placeholder VIN, and both therefore duplicate on a retry —
    // and a duplicate is not inert: converting each SOURCED row to STOCK with a
    // purchase price later posts its own VEHICLE_ACQUIRED, capitalizing one
    // physical car twice. `hasVehicleAcquisitionAccountingExposure` guards per
    // vehicleId and cannot know two rows are one car.
    for (const row of [
      { rowId: 1, ...baseImportRow, vin: "", sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 },
      { rowId: 1, ...baseImportRow, vin: "N/A", purchasePrice: 0 },
      { rowId: 1, ...baseImportRow, vin: "xxxxxxxxxxxxxxxxx" },
    ]) {
      await expect(
        asOwner.mutation(api.vehicles.importBulk, {
          orgId, acquisitionPosting: "PURCHASE", importId: "imp-7", purchasePaymentMethod: "CASH", vehicles: [row],
        })
      ).rejects.toThrow(/VIN/i);
    }

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
  });

  test("PURCHASE refuses a VIN that is not plain alphanumeric, so exact dedup IS canonical dedup", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59n");

    // A real VIN is 17 alphanumeric characters; a dash or space in one is a
    // formatting artifact, and the product treats `1HGCM826-33A000001` and
    // `1HGCM82633A000001` as two different cars everywhere (SCRUM-94). That is
    // pre-existing and codebase-wide, but it must not be reachable through the
    // path that posts: refusing anything outside [A-Z0-9] here means every VIN
    // this mode accepts already equals its own canonical form, so the exact
    // by_org_vin match below is a canonical match among them.
    for (const vin of ["1HGCM826-33A000001", "1HGCM8263 3A000001", "1HGCM8263.3A00001"]) {
      await expect(
        asOwner.mutation(api.vehicles.importBulk, {
          orgId,
          acquisitionPosting: "PURCHASE", importId: "imp-8",
          purchasePaymentMethod: "CASH",
          vehicles: [{ rowId: 1, ...baseImportRow, vin, purchasePrice: 10000 }],
        })
      ).rejects.toThrow(/letters and numbers|VIN/i);
    }

    const entries = await t.run((ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(entries).toHaveLength(0);
    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
  });

  test("OPENING_STOCK accepts a punctuated VIN — it posts nothing, and refusing it would block a migration", async () => {
    const { orgId, asOwner } = await seedDealer("s59o");

    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId,
      acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ ...baseImportRow, vin: "1HGCM826-33A000001", purchasePrice: 10000 }],
    });

    expect(result.inserted).toBe(1);
  });

  test("OPENING_STOCK still accepts VIN-less rows — nothing posts, so nothing can double-post", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59i");

    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId,
      acquisitionPosting: "OPENING_STOCK",
      vehicles: [
        { ...baseImportRow, vin: "xxxxxxxxxxxxxxxxx", purchasePrice: 10000 },
        { ...baseImportRow, vin: "N/A", purchasePrice: 10000 },
      ],
    });

    expect(result.inserted).toBe(2);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
  });

  // The next two tests exist to keep one call ATOMIC, not to check the status
  // rule itself.
  //
  // A dealer's export routinely lists already-sold stock alongside available
  // stock, and `assertDirectVehicleCreateStatus` is applied per row inside the
  // insert loop — so row 2 can throw after row 1 has already been inserted and
  // posted. Nothing survives that today because `importBulk` is a single Convex
  // transaction with no `ctx.runMutation` sub-transactions, and a throw rolls
  // the whole call back.
  //
  // That guarantee is load-bearing now that a row also writes journal entries,
  // and it is exactly what a future change would break: SCRUM-92 contemplates
  // resumable server-side batches to raise the 25-row posting cap, and the
  // established pattern for that in this codebase
  // (`backfillVehicleInventoryOpeningBalances`) is per-item `ctx.runMutation`,
  // which commits each item independently. Doing that here without re-checking
  // every row up front would leave a half-posted import behind.
  test("a workflow-controlled status in a later row leaves nothing written", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59k");

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId,
        acquisitionPosting: "PURCHASE", importId: "imp-9",
        purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTSTATUS00001", purchasePrice: 10000 },
          { rowId: 2, ...baseImportRow, vin: "IMPORTSTATUS00002", purchasePrice: 10000, status: "SOLD" },
        ],
      })
    ).rejects.toThrow(/sale/i);

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(lines).toHaveLength(0);
  });

  test("an unrecognized status in a later row leaves nothing written, in either mode", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59l");

    for (const acquisitionPosting of ["OPENING_STOCK", "PURCHASE"] as const) {
      await expect(
        asOwner.mutation(api.vehicles.importBulk, {
          orgId,
          acquisitionPosting,
          ...(acquisitionPosting === "PURCHASE"
            ? { purchasePaymentMethod: "CASH" as const, importId: "imp-status" }
            : {}),
          vehicles: [
            { rowId: 1, ...baseImportRow, vin: "IMPORTSTATUS00003", purchasePrice: 10000 },
            { rowId: 2, ...baseImportRow, vin: "IMPORTSTATUS00004", purchasePrice: 10000, status: "IN STOCK" },
          ],
        })
      ).rejects.toThrow(/status/i);
    }

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
  });

  test("a PURCHASE batch is capped well below the insert-only ceiling", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59j");
    const rows = Array.from({ length: 26 }, (_, i) => ({
      rowId: i + 1,
      ...baseImportRow,
      vin: `IMPORTCAP${String(i).padStart(8, "0")}`,
      purchasePrice: 1000,
    }));

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-10", purchasePaymentMethod: "CASH", vehicles: rows,
      })
    ).rejects.toThrow(/Import too large/);

    // Refused BEFORE ANY WRITE, across every table the posting path touches.
    // A PURCHASE import is one transaction, so "too large" must mean nothing
    // happened — not that some prefix of the file landed.
    const countAll = async (table: string): Promise<number> => {
      const rows = await t.run(async (ctx) => (ctx.db.query(table as any) as any).collect());
      return (rows as unknown[]).length;
    };
    expect(await countAll("vehicles")).toBe(0);
    expect(await countAll("transactions")).toBe(0);
    expect(await countAll("accountingEvents")).toBe(0);
    expect(await countAll("journalEntries")).toBe(0);
    expect(await countAll("journalLines")).toBe(0);
    expect(await countAll("vehicleSupplierPayables")).toBe(0);

    // The same 26 rows are fine when nothing posts.
    const ok = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK", vehicles: rows,
    });
    expect(ok.inserted).toBe(26);
  });

  test("re-sending the same import does not capitalize the same VIN twice", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59g");
    const rows = [{ rowId: 1, ...baseImportRow, vin: "IMPORTDUP00000001", purchasePrice: 10000 }];

    // The SAME import, sent twice — a network retry, or an operator who did not
    // see the first response. This, and only this, is a provable retry.
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-dup-1", purchasePaymentMethod: "CASH", vehicles: rows,
    });
    const second = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-dup-1", purchasePaymentMethod: "CASH", vehicles: rows,
    });

    expect(second.inserted).toBe(0);
    expect(second.alreadyRecorded).toBe(1);
    // ...and NOT via the generic counter, which a purchase import never uses.
    expect(second.skipped).toBe(0);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);
    // The legacy cash transaction is not idempotent the way the GL event is, so
    // a re-import must not reach it at all.
    const txns = await t.run((ctx) =>
      ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("category"), "VEHICLE_PURCHASE")).collect()
    );
    expect(txns).toHaveLength(1);
  });
  // ─────────────────────────────────────────────────────────────────────────
  // The retry PAIR. These two are deliberately adjacent: they present the
  // import with the SAME shape — an exact VIN that already exists — and require
  // OPPOSITE answers. One is a genuine retry and must be idempotent; the other
  // is an unproven basis and must refuse. A guard that gets either alone right
  // while collapsing them into one behaviour is the defect.
  // ─────────────────────────────────────────────────────────────────────────

  test("an OPENING_STOCK vehicle re-presented as a PURCHASE is REFUSED, never silently skipped", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59amb");

    // Cutover. The car is stock the dealer already owns, so nothing posts — its
    // cost sits in the organization's opening balance, not in a per-vehicle
    // acquisition event.
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId,
      acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTAMB0000001A", purchasePrice: 10000 }],
    });
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);

    // The same VIN now arrives as a purchase. Skipping it silently leaves a car
    // that can be SOLD, crediting Vehicle Inventory against a debit that was
    // never posted. Posting it would capitalize stock the opening balance
    // already covers. Neither is inferable from this row, so it refuses.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId,
        acquisitionPosting: "PURCHASE", importId: "imp-11",
        purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTAMB0000001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/no recorded purchase/i);

    // Refused for the stated reason AND atomically: a null-dereference would
    // also "throw" while proving nothing, so the world delta is pinned too.
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(1);
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(lines).toHaveLength(0);
  });

  test("a SOURCED or cost-less row that already exists is still an ordinary duplicate, not a refusal", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59amb2");

    // The ambiguity only exists for a row that would CAPITALIZE. These post
    // nothing either way, so refusing them would break the retry contract —
    // which depends on re-presenting rows that never posted.
    const rows = [
      {
        rowId: 1, ...baseImportRow, vin: "IMPORTDUP0000001A", sourceType: "SOURCED",
        sourcedFromName: "Other Dealer", sourceCost: 9000,
      },
      { rowId: 2, ...baseImportRow, vin: "IMPORTDUP0000002B" },
    ];

    const first = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-12", purchasePaymentMethod: "CASH", vehicles: rows,
    });
    expect(first.inserted).toBe(2);

    const second = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-12", purchasePaymentMethod: "CASH", vehicles: rows,
    });
    expect(second.inserted).toBe(0);
    expect(second.alreadyRecorded).toBe(2);
    expect(second.skipped).toBe(0);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
  });

  test("a NEW import overlapping cars already bought is REFUSED — matching facts are not proof of a retry", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59retry");

    // A first purchase commits. PURCHASE is one transaction per file, so this is
    // a separate, completed import — not a chunk of a larger one.
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-rty-1", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTRTY000001A", purchasePrice: 10000 }],
    });
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);

    // A second import fails on its second row. It is atomic, so it leaves
    // nothing — but the first import stays committed, which is the state the
    // operator's corrected re-import meets.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-rty-2", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTRTY000002B", purchasePrice: 7000 },
          { rowId: 2, ...baseImportRow, vin: "IMPORTRTY000003C", purchasePrice: 7000, status: "SOLD" },
        ],
      })
    ).rejects.toThrow(/sale/i);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);

    // ⚠️ THE RECOVERY STORY, RESTATED. An earlier version of this test asserted
    // the combined file would skip the car already bought and import the rest.
    // It cannot, and the reason is the whole point of the redesign: this is a
    // DIFFERENT import operation, and the only thing linking its first row to
    // the earlier purchase is that their details match. Two identical cars
    // produce exactly that, so accepting it as a retry would silently discard a
    // vehicle the dealer bought. It refuses and says which rows to remove.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-rty-3", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTRTY000001A", purchasePrice: 10000 },
          { rowId: 2, ...baseImportRow, vin: "IMPORTRTY000002B", purchasePrice: 7000 },
          { rowId: 3, ...baseImportRow, vin: "IMPORTRTY000003C", purchasePrice: 7000 },
        ],
      })
    ).rejects.toThrow(/already recorded under the same VIN/);
    // Atomic: the two new cars did not land either.
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);

    // Removing the row already bought is what the message asks for, and it works.
    const fixed = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-rty-4", purchasePaymentMethod: "CASH",
      vehicles: [
        { rowId: 2, ...baseImportRow, vin: "IMPORTRTY000002B", purchasePrice: 7000 },
        { rowId: 3, ...baseImportRow, vin: "IMPORTRTY000003C", purchasePrice: 7000 },
      ],
    });
    expect(fixed.inserted).toBe(2);

    // 10,000 + 7,000 + 7,000 — each car once. A repost would read 34,000,000.
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(24_000_000);
    const txns = await t.run((ctx) =>
      ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("category"), "VEHICLE_PURCHASE")).collect()
    );
    expect(txns).toHaveLength(3);
  });
  // ─────────────────────────────────────────────────────────────────────────
  // Round 2. Each of these failed against the previous head — the guards above
  // were incomplete in five separate ways, three of them introduced by the
  // round-1 fix itself.
  // ─────────────────────────────────────────────────────────────────────────

  test("two rows in ONE file sharing a VIN are refused, not collapsed into one car", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59batch");

    // A REAL, repeated VIN — deliberately not a filler word. `UNK` and
    // `UNKNOWN` are now normalized as "no VIN" and refused by name before this
    // guard is reached, so testing it with one of those would leave the
    // duplicate check itself uncovered while looking covered. The per-row dedup
    // reads this mutation's own writes, so without a batch check the second car
    // is silently "skipped" — two cars bought, one vehicle, ONE acquisition.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-15", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTBATCH0001A", purchasePrice: 10000 },
          { rowId: 2, ...baseImportRow, vin: "IMPORTBATCH0001A", purchasePrice: 7000, model: "Seltos" },
        ],
      })
    ).rejects.toThrow(/repeat a VIN already used earlier/i);

    // ...and a filler word in both cells is refused too, by NAME rather than as
    // a collision — the clearer failure, and the one an operator can act on.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-15b", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "UNK", purchasePrice: 10000 },
          { rowId: 2, ...baseImportRow, vin: "UNK", purchasePrice: 7000, model: "Seltos" },
        ],
      })
    ).rejects.toThrow(/VIN is required for every vehicle/);

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
  });

  test("a negative purchase cost is refused before any write", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59neg");

    // assertFiniteNumber rejects NaN and Infinity but not sign, and
    // wouldCapitalize tests `> 0` — so a negative price slipped past BOTH and the
    // row was inserted with no acquisition journal at all: exactly the
    // uncapitalized-inventory shape SCRUM-59 exists to prevent.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-16", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTNEG0000001A", purchasePrice: -10000 }],
      })
    ).rejects.toThrow(/cannot cost less than nothing/i);

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
  });

  test("a REVERSED acquisition does not count as proof the car is capitalized", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59rev");

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-17", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTREV0000001A", purchasePrice: 10000 }],
    });
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);

    // The acquisition is reversed, so the car is NOT capitalized any more.
    const event = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      return rows.find((r) => r.eventType === "VEHICLE_ACQUIRED")!;
    });
    await t.run((ctx) => ctx.db.patch(event._id, { status: "REVERSED" as const }));

    // The shared exposure helper ignores status, so it still answers "yes" here.
    // Taking that as proof silently skips the row and the car stays uncapitalized
    // forever. The guard must use POSTED evidence only, and therefore refuse.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-18", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTREV0000001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/no recorded purchase/i);
  });
  test("exactly 25 PURCHASE rows succeeds — the cap is inclusive", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59max");

    const rows = Array.from({ length: 25 }, (_, i) => ({
      rowId: i + 1,
      ...baseImportRow,
      vin: `IMPORTMAX${String(i).padStart(8, "0")}`,
      purchasePrice: 1000,
    }));

    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-19", purchasePaymentMethod: "CASH", vehicles: rows,
    });

    expect(result.inserted).toBe(25);
    // Every one of them capitalized, in a single transaction.
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(25_000_000);
    expect(await glBalanceMinor(t, orgId, "CASH_ON_HAND")).toBe(-25_000_000);
  });

  test("a duplicate VIN at the FIRST and LAST row of a full file refuses atomically", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59dup25");

    // The pair is deliberately as far apart as the file allows. Under the old
    // chunked protocol these two rows landed in DIFFERENT transactions, so no
    // single call ever saw both and the second car was silently skipped. One
    // transaction is what makes this detectable at all.
    const rows = Array.from({ length: 25 }, (_, i) => ({
      rowId: i + 1,
      ...baseImportRow,
      vin: `IMPORTDUP${String(i).padStart(8, "0")}`,
      purchasePrice: 1000,
    }));
    rows[24].vin = rows[0].vin;

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-fill-1", purchasePaymentMethod: "CASH", vehicles: rows,
      })
    ).rejects.toThrow(/repeat a VIN already used earlier/i);

    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(0);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
  });

  test("an OWNED ON_ACCOUNT row reaches AP-Suppliers and creates the supplier payable", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59e2e");

    // The OWNED half of the ON_ACCOUNT path: a STOCK row carrying a supplier.
    //
    // ⚠️ This is the server end of a two-part chain, and the seam between them
    // is where the defect actually lived — `deriveVehicleRow` discarded
    // `sourcedFromName` for every non-SOURCED row, so no spreadsheet could ever
    // produce the row below, while every server test hand-built it and passed.
    // The client end is pinned in components/vehicles/vehicleImportRow.test.ts
    // ("keeps the supplier on an OWNED row"), which asserts derivation emits
    // exactly this shape: sourceType not SOURCED, sourcedFromName present,
    // sourceCost undefined. Importing the dialog here instead would drag a .tsx
    // module into convex/tsconfig and break the convex-backend gate.
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-fill-2", purchasePaymentMethod: "ON_ACCOUNT",
      vehicles: [{ rowId: 1,
        ...baseImportRow, vin: "IMPORTE2E0000001A",
        purchasePrice: 10000, sourcedFromName: "Atiwi Motors",
      }],
    });

    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(10_000_000);
    expect(await glBalanceMinor(t, orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(-10_000_000);
    // Owed, not paid — no cash moved.
    expect(await glBalanceMinor(t, orgId, "CASH_ON_HAND")).toBe(0);

    const payables = await t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(payables).toHaveLength(1);
    expect(payables[0].sourcedFromName).toBe("Atiwi Motors");
  });


  test("the server cap IS the shared cap, so client and server cannot drift", () => {
    // The client reads PURCHASE_IMPORT_MAX_ROWS too (pinned in
    // components/vehicles/vehicleImportRow.test.ts). One constant, both ends
    // asserted — rather than the same literal written twice, which would not
    // fail if one side changed.
    expect(IMPORT_BULK_MAX_POSTING_ROWS).toBe(PURCHASE_IMPORT_MAX_ROWS);
  });

  // ── The lenient-skip class ────────────────────────────────────────────────
  //
  // `importBulk` counted three completely different outcomes into one `skipped`
  // number and the UI rendered all of them as "skipped N duplicates":
  //
  //   - an exact VIN already on record        (benign: nothing to do)
  //   - a SOURCED row with no supplier/cost   (the car was NOT recorded)
  //   - a second car sharing a filler VIN     (the car was NOT recorded)
  //
  // That was survivable while an import posted nothing. Once PURCHASE
  // capitalizes, the last two mean a vehicle the dealership genuinely bought has
  // no vehicle row, no VEHICLE_ACQUIRED event and no payment — announced to the
  // operator as a duplicate, which is the one word that stops anyone looking.
  //
  // For PURCHASE there are now exactly two outcomes: recorded, or PROVEN to be
  // already recorded. Everything else throws before the first write.

  /** Every table a PURCHASE import writes to. Used to assert a true zero delta. */
  async function worldDelta(t: Ctx["t"], orgId: Id<"organizations">) {
    const count = async (
      table: "vehicles" | "transactions" | "accountingEvents" | "vehicleSupplierPayables"
        | "journalEntries" | "journalLines" | "financeCompanies" | "vehicleValuations"
    ) => (await t.run((ctx) => ctx.db.query(table).withIndex("by_org", (q) => q.eq("orgId", orgId)).collect())).length;
    // Command evidence is on its own index and is part of "nothing happened":
    // proof of an import that did not run is exactly what suppresses its retry.
    const evidence = await t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId)).collect()
    );
    return {
      vehicles: await count("vehicles"),
      transactions: await count("transactions"),
      events: await count("accountingEvents"),
      payables: await count("vehicleSupplierPayables"),
      journals: await count("journalEntries"),
      journalLines: await count("journalLines"),
      // ⚠️ These two were missing while the docstring claimed the helper covered
      // every table a purchase import writes to. It did not, and a retry that
      // created a finance company went unnoticed because of it.
      companies: await count("financeCompanies"),
      valuations: await count("vehicleValuations"),
      evidence: evidence.length,
      inventoryMinor: await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY"),
    };
  }

  const NOTHING_HAPPENED = {
    vehicles: 0, transactions: 0, events: 0, payables: 0,
    journals: 0, journalLines: 0, companies: 0, valuations: 0,
    evidence: 0, inventoryMinor: 0,
  };

  /** One CASH-purchased Kia Sportage 2023, imported and capitalized. */
  /**
   * One CASH-purchased Kia Sportage 2023, and the identity of the import that
   * bought it — which is the ONLY thing a later call can use to prove it is
   * retrying that same purchase rather than recording a second car.
   */
  async function seedPurchased(suffix: string, vin: string, cost = 10000) {
    const ctx = await seedDealer(suffix);
    const importId = `seed-${suffix}`;
    await ctx.asOwner.mutation(api.vehicles.importBulk, {
      orgId: ctx.orgId, acquisitionPosting: "PURCHASE", importId, purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, vin, purchasePrice: cost }],
    });
    return { ...ctx, importId };
  }

  test("a DIFFERENT car sharing a VIN across two imports is REFUSED, not silently dropped", async () => {
    // Two operators copying the same VIN cell down on two different days is
    // ordinary, not adversarial. A real VIN is used here rather than a filler
    // word so that this exercises the CONTRADICTION path — filler words are now
    // refused earlier, by name.
    const { t, orgId, asOwner } = await seedDealer("s59xcall");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-21", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, make: "Toyota", model: "Corolla", vin: "IMPORTXCALL0001A", purchasePrice: 8000 }],
    });
    const before = await worldDelta(t, orgId);

    // A genuinely different car, in a separate file. Before the fix this
    // returned inserted=0 skipped=1 and the Honda vanished: no vehicle, no
    // VEHICLE_ACQUIRED, no cash paid, reported as "skipped 1 duplicates".
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-22", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, make: "Honda", model: "Civic", vin: "IMPORTXCALL0001A", purchasePrice: 12000 }],
      })
    ).rejects.toThrow(/recorded as Toyota Corolla, this file says Honda Civic/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  // ⚠️ The filler-VIN case above changes make AND model at once, so it cannot
  // tell which half of the predicate refused it. Each field gets a fixture that
  // ONLY it can refuse — otherwise a neighbouring conjunct makes an uncovered
  // one look covered, which is exactly how a money guard on this branch reached
  // four review rounds with one half never exercised.

  test("an existing VIN whose MAKE alone disagrees is refused", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59mk");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-23", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, make: "Kia", model: "Sportage", vin: "IMPORTMAKE00001A", purchasePrice: 10000 }],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-24", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, make: "Hyundai", model: "Sportage", vin: "IMPORTMAKE00001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/recorded as Kia Sportage, this file says Hyundai Sportage/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("an existing VIN whose MODEL alone disagrees is refused", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59md");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-25", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, make: "Kia", model: "Sportage", vin: "IMPORTMODEL0001A", purchasePrice: 10000 }],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-26", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, make: "Kia", model: "Sorento", vin: "IMPORTMODEL0001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/recorded as Kia Sportage, this file says Kia Sorento/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  // The other failure direction matters too: a contradiction check that fires on
  // "kia " vs "Kia" refuses every legitimate retry from a spreadsheet that was
  // re-saved, and an operator who cannot retry stops trusting the import.
  test("a retry differing only in CASE and PADDING is still a retry", async () => {
    const { t, orgId, asOwner, importId } = await seedPurchased("s59case", "IMPORTCASE00001A", 10000);
    const before = await worldDelta(t, orgId);

    // Same import, same row — re-sent with the make and model typed differently.
    // The fingerprint is case- and padding-insensitive on those, so this is
    // still the same requested operation and not a conflict.
    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId, purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, make: "  kia ", model: "SPORTAGE", vin: "IMPORTCASE00001A", purchasePrice: 10000 }],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, skipped: 0 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("FAIL CLOSED: an acquisition recorded in another CURRENCY is refused", async () => {
    const { t, orgId, asOwner } = await seedPurchased("s59cur", "IMPORTCUR000001A", 10000);
    const vehicle = await vehicleByVin(t, orgId, "IMPORTCUR000001A");
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicle!._id.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
        .unique();
      await ctx.db.patch(event!._id, {
        payload: { ...(event!.payload as Record<string, unknown>), currency: "USD" },
      });
    });
    const before = await worldDelta(t, orgId);

    // 10000 USD and 10000 JOD are not the same purchase, and comparing the
    // MINOR-UNIT amounts alone would call them equal only by coincidence of
    // scale. The currency is checked in its own right.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-28", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTCUR000001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/recorded in USD, this import is in JOD/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("FAIL CLOSED: proven exposure that cannot state a PAYMENT METHOD is refused", async () => {
    const { t, orgId, asOwner } = await seedPurchased("s59nopm", "IMPORTNOPM00001A", 10000);
    const vehicle = await vehicleByVin(t, orgId, "IMPORTNOPM00001A");
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicle!._id.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
        .unique();
      const { paymentMethod: _dropped, ...rest } = event!.payload as Record<string, unknown>;
      await ctx.db.patch(event!._id, { payload: rest });
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-29", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTNOPM00001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/does not state a payment method/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("an existing VIN whose YEAR disagrees is refused too — same rule, the other field", async () => {
    const { t, orgId, asOwner } = await seedPurchased("s59yr", "IMPORTYEAR00001A");
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-30", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, year: 2024, vin: "IMPORTYEAR00001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/recorded as a 2023, this file says 2024/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("same car, DIFFERENT COST is refused — a retry cannot change what was posted", async () => {
    // Vehicle facts agree, so a make/model/year check alone would call this a
    // retry and skip it: the operator's corrected price would never reach the
    // books and they would be told it was a duplicate. The posted event is what
    // proves the economic command, and it disagrees.
    const { t, orgId, asOwner } = await seedPurchased("s59cost", "IMPORTCOST00001A", 10000);
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-31", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTCOST00001A", purchasePrice: 12000 }],
      })
    ).rejects.toThrow(/recorded at 10000, this file says 12000/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("same car and cost, DIFFERENT PAYMENT METHOD is refused", async () => {
    const { t, orgId, asOwner } = await seedPurchased("s59pm", "IMPORTPM00000001", 10000);
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-32", purchasePaymentMethod: "BANK_TRANSFER",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTPM00000001", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/recorded as paid by CASH, this import says BANK_TRANSFER/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("an identical re-import is an idempotent retry, reported as alreadyRecorded and NOT as skipped", async () => {
    const { t, orgId, asOwner, importId } = await seedPurchased("s59retry", "IMPORTRETRY0001A", 10000);
    const before = await worldDelta(t, orgId);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId, purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTRETRY0001A", purchasePrice: 10000 }],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, skipped: 0 });
    // Nothing posted a second time — same car, same books.
    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("ON_ACCOUNT: a retry naming a DIFFERENT supplier is refused", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59supp");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-34", purchasePaymentMethod: "ON_ACCOUNT",
      vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTSUPP00001A", purchasePrice: 10000, sourcedFromName: "Gulf Motors" }],
    });
    const before = await worldDelta(t, orgId);

    // Everything the GL event knows agrees — cost, currency, ON_ACCOUNT. Only
    // the payable knows WHO is owed, so that is where the disagreement is.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-35", purchasePaymentMethod: "ON_ACCOUNT",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTSUPP00001A", purchasePrice: 10000, sourcedFromName: "Delta Auto" }],
      })
    ).rejects.toThrow(/owed to Gulf Motors, this file says Delta Auto/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("ON_ACCOUNT: a retry naming the SAME supplier is a retry, and creates no second payable", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59supp2");
    const row = { rowId: 1, ...baseImportRow, vin: "IMPORTSUPP00002B", purchasePrice: 10000, sourcedFromName: "Gulf Motors" };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-36", purchasePaymentMethod: "ON_ACCOUNT", vehicles: [row],
    });
    const before = await worldDelta(t, orgId);
    expect(before.payables).toBe(1);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-36", purchasePaymentMethod: "ON_ACCOUNT", vehicles: [row],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, skipped: 0 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("a SOURCED row with no supplier refuses the whole PURCHASE file instead of being dropped as a 'duplicate'", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59srcskip");

    // The row loop's own guard would skip this row and increment `skipped`,
    // committing the first car and reporting the second as a duplicate — a car
    // bought on supplier credit with nothing recorded anywhere.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-38", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTSRC00001AA", purchasePrice: 10000 },
          { rowId: 2, ...baseImportRow, vin: "IMPORTSRC00002BB", sourceType: "SOURCED", sourceCost: 9000 },
        ],
      })
    ).rejects.toThrow(/missing a supplier or a cost/);

    expect(await worldDelta(t, orgId)).toEqual(NOTHING_HAPPENED);
  });

  test("a SOURCED row with a supplier but NO COST refuses the file as well", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59srccost");

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-39", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTSRC00003CC", sourceType: "SOURCED", sourcedFromName: "Gulf Motors" },
        ],
      })
    ).rejects.toThrow(/missing a supplier or a cost/);

    expect((await worldDelta(t, orgId)).vehicles).toBe(0);
  });

  test("OPENING_STOCK keeps its lenient behaviour — it posts nothing, so nothing financial is lost", async () => {
    // Deliberately NOT changed. The refusals above exist because a dropped row
    // means a lost acquisition; an opening-stock import records no purchase at
    // all, so a skipped row costs the books nothing and forcing the whole file
    // to fail would be a regression for cutover migrations.
    const { t, orgId, asOwner } = await seedDealer("s59oslenient");

    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [
        { ...baseImportRow, vin: "IMPORTOSL00001AA", purchasePrice: 10000 },
        { ...baseImportRow, vin: "IMPORTOSL00002BB", sourceType: "SOURCED", sourceCost: 9000 },
      ],
    });

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
    // ...and it never claims the generic skip was a proven retry.
    expect(result.alreadyRecorded).toBe(0);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
  });

  test("FAIL CLOSED: proven exposure whose payload cannot state a cost is refused, not treated as agreement", async () => {
    // A POSTED VEHICLE_ACQUIRED proves the car is capitalized. It does not
    // prove it was capitalized at THIS price. "Cannot tell" must never take the
    // permissive branch on a path that decides whether to post money.
    const { t, orgId, asOwner } = await seedPurchased("s59blind", "IMPORTBLIND0001A", 10000);
    const vehicle = await vehicleByVin(t, orgId, "IMPORTBLIND0001A");
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicle!._id.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
        .unique();
      const { costMinor: _dropped, ...rest } = event!.payload as Record<string, unknown>;
      await ctx.db.patch(event!._id, { payload: rest });
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-40", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTBLIND0001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/does not state a cost/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  test("evidence still QUEUED in the outbox counts, and its missing currency is named rather than printed as 'undefined'", async () => {
    // Two gaps closed at once, both surfaced by a surviving mutant rather than
    // by review:
    //
    //  1. provenAcquisitionEvidence has a second branch — a durable outbox row
    //     that WILL post but has not yet — and nothing exercised it. A vehicle
    //     whose acquisition is queued is exposed just as surely as one already
    //     posted, and treating it as unproven would send a duplicate.
    //  2. `pendingAccountingEvents.currency` is OPTIONAL, so evidence with no
    //     currency at all is reachable. Deleting the explicit guard still
    //     refused — `undefined !== "JOD"` — but told the operator the purchase
    //     was "recorded in undefined". The refusal was never at risk; the
    //     sentence was.
    const { t, orgId, asOwner, userId } = await seedDealer("s59queued");

    // A vehicle that posts nothing on the way in, so the ONLY evidence is the
    // outbox row inserted below.
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ ...baseImportRow, vin: "IMPORTQUEUE0001A", purchasePrice: 10000 }],
    });
    const vehicle = await vehicleByVin(t, orgId, "IMPORTQUEUE0001A");
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId,
        kind: "POST",
        status: "PENDING",
        idempotencyKey: `vehicle_acquired_${vehicle!._id}`,
        accountingDate: Date.now(),
        actorId: userId,
        attempts: 0,
        createdAt: Date.now(),
        eventType: "VEHICLE_ACQUIRED",
        sourceType: "vehicles",
        sourceId: vehicle!._id.toString(),
        payload: { vehicleId: vehicle!._id.toString() },
      })
    );
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-41", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTQUEUE0001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/does not state a currency/);

    // Specifically NOT the unproven-basis message: the queued row IS proof of
    // exposure. Reaching that branch would mean the outbox was ignored.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-42", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTQUEUE0001A", purchasePrice: 10000 }],
      })
    ).rejects.not.toThrow(/no recorded purchase/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  test("a DEAD-LETTERED outbox row is not proof of anything, and the car is not skipped on it", async () => {
    // Surfaced by a surviving mutant: widening the outbox filter from PENDING to
    // any POST row passed every test. It should not have.
    //
    // A PENDING row will post. A FAILED row has been dead-lettered and never
    // will. Accepting the second as proof of exposure is precisely the SCRUM-59
    // shape arriving by a new route: the car is skipped as "already recorded",
    // nothing ever debits Vehicle Inventory, and a later sale credits an asset
    // that was never capitalized. This is the outbox-branch twin of the
    // REVERSED-event case already covered on the posted branch.
    const { t, orgId, asOwner, userId } = await seedDealer("s59deadletter");

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ ...baseImportRow, vin: "IMPORTDEAD00001A", purchasePrice: 10000 }],
    });
    const vehicle = await vehicleByVin(t, orgId, "IMPORTDEAD00001A");
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId,
        kind: "POST",
        status: "FAILED",
        idempotencyKey: `vehicle_acquired_${vehicle!._id}`,
        accountingDate: Date.now(),
        actorId: userId,
        attempts: 5,
        lastError: "dead-lettered",
        createdAt: Date.now(),
        eventType: "VEHICLE_ACQUIRED",
        sourceType: "vehicles",
        sourceId: vehicle!._id.toString(),
        currency: "JOD",
        // A payload that would AGREE on every field, so the only thing standing
        // between this car and a silent skip is the status filter itself.
        payload: {
          vehicleId: vehicle!._id.toString(),
          costMinor: 10_000_000,
          currency: "JOD",
          paymentMethod: "CASH",
        },
      })
    );
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-43", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTDEAD00001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/no recorded purchase/);

    // It fails CLOSED — a human reconciles the basis. It does not quietly post
    // (which could double-count opening stock) and does not quietly skip.
    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  test("a SOURCED row re-presenting an existing owned STOCK vehicle is refused, not certified", async () => {
    // The row posts nothing either way, which is why an earlier revision let it
    // take an early exit before any proof ran. But it is still REPORTED as
    // "already recorded with matching purchase evidence", and that sentence
    // must not be said about terms nobody compared. STOCK and SOURCED are
    // different ownership, a different counterparty, and a different
    // principal-versus-agent basis at sale time.
    const { t, orgId, asOwner } = await seedPurchased("s59crosssrc", "CROSSSOURCE0001A", 10000);
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-44", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1,
          ...baseImportRow, vin: "CROSSSOURCE0001A", sourceType: "SOURCED",
          sourcedFromName: "Some Other Dealer", sourceCost: 4000,
        }],
      })
    ).rejects.toThrow(/recorded as owned stock, this file says sourced from a supplier/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("the reverse — owned stock re-presenting an existing SOURCED vehicle — is refused too", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59crosssrc2");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-45", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1,
        ...baseImportRow, vin: "CROSSSOURCE0002B", sourceType: "SOURCED",
        sourcedFromName: "Other Dealer", sourceCost: 9000,
      }],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-46", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "CROSSSOURCE0002B", purchasePrice: 9000 }],
      })
    ).rejects.toThrow(/recorded as sourced from a supplier, this file says owned stock/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("two SOURCED rows agreeing on the car but NOT on the supplier are refused", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59srcsupp");
    const base = {
      ...baseImportRow, vin: "CROSSSOURCE0003C", sourceType: "SOURCED", sourceCost: 9000,
    };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-47", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...base, sourcedFromName: "Other Dealer" }],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-48", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...base, sourcedFromName: "A Completely Different Dealer" }],
      })
    ).rejects.toThrow(/sourced from Other Dealer, this file says A Completely Different Dealer/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("two SOURCED rows agreeing on the supplier but NOT on the cost are refused", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59srccost2");
    const base = {
      ...baseImportRow, vin: "CROSSSOURCE0004D", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer",
    };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-49", purchasePaymentMethod: "CASH",
      vehicles: [{ rowId: 1, ...base, sourceCost: 9000 }],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "imp-50", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...base, sourceCost: 7500 }],
      })
    ).rejects.toThrow(/supplier cost of 9000, this file says 7500/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("an unchanged SOURCED row is still an ordinary proven retry", async () => {
    // The other failure direction: the checks above must not refuse a genuine
    // re-import of a file whose sourced rows never changed.
    const { t, orgId, asOwner } = await seedDealer("s59srcretry");
    const row = {
      rowId: 1, ...baseImportRow, vin: "CROSSSOURCE0005E", sourceType: "SOURCED",
      sourcedFromName: "Other Dealer", sourceCost: 9000,
    };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-51", purchasePaymentMethod: "CASH", vehicles: [row],
    });
    const before = await worldDelta(t, orgId);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "imp-51", purchasePaymentMethod: "CASH", vehicles: [row],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, skipped: 0 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  // ── Durable per-row idempotency ───────────────────────────────────────────
  //
  // `alreadyRecorded` means ONE thing: durable evidence exists that this exact
  // import operation already ran. It does NOT mean "something in the database
  // looks like this row". Those are different claims, and the difference is a
  // car.
  //
  // Two genuinely separate vehicles can agree on every fact a spreadsheet
  // carries — same model, same price, same day, same filler text in the VIN
  // column. Fact equality therefore cannot distinguish a retry from a second
  // purchase, and the earlier design that tried to silently discarded the
  // second car and its capitalization while reporting success.

  /**
   * ⚠️ TWO CARS CANNOT SHARE A VIN STRING, so the reported scenario cannot end
   * with two stored vehicles both reading "UNKNOWN".
   *
   * `by_org_vin` is read with `.unique()` in several places, and a second row
   * under the same VIN would make every later lookup for that org throw — an
   * org-wide breakage strictly worse than the defect being fixed. So the
   * property asserted here is the one that actually matters: THE SECOND CAR IS
   * NEVER SILENTLY SUPPRESSED. It is refused, by name, with a message saying
   * what to do; and once the VINs are real, both cars import and both
   * capitalize.
   */
  test("two IDENTICAL cars under a filler VIN are REFUSED, never silently collapsed into one", async () => {
    // THE REPRODUCTION. Same model, same 10,000 price, both rows carrying
    // "UNKNOWN" because the VINs were not to hand — an ordinary fleet purchase.
    // Every fact agrees, which is exactly why nothing but row identity could
    // ever tell them apart. Previously the second was reported as an
    // already-recorded retry and vanished along with its 10,000.
    const { t, orgId, asOwner } = await seedDealer("s59fleet");
    const car = { ...baseImportRow, make: "Kia", model: "Sportage", year: 2023, vin: "UNKNOWN", purchasePrice: 10000 };

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "fleet-1", purchasePaymentMethod: "CASH",
        vehicles: [{ ...car, rowId: 1 }, { ...car, rowId: 2 }],
      })
    ).rejects.toThrow(/VIN is required for every vehicle/);
    expect(await worldDelta(t, orgId)).toEqual(NOTHING_HAPPENED);

    // ...and the SAME two cars, once their real VINs are supplied, both land and
    // both capitalize. Nothing about them being identical suppresses either one.
    const fixed = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "fleet-1", purchasePaymentMethod: "CASH",
      vehicles: [
        { ...car, rowId: 1, vin: "IMPORTFLEET0001A" },
        { ...car, rowId: 2, vin: "IMPORTFLEET0002B" },
      ],
    });
    expect(fixed).toMatchObject({ inserted: 2, alreadyRecorded: 0, skipped: 0 });
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(20_000_000);
    expect(await glBalanceMinor(t, orgId, "CASH_ON_HAND")).toBe(-20_000_000);
  });

  test("the SECOND of two identical cars in a LATER import is refused, not reported as already recorded", async () => {
    // The cross-import half of the same defect, and the one the 25-row cap makes
    // routine: a fleet larger than one file arrives as several imports. The
    // second car agrees with the first on every recorded fact, so only the
    // absence of evidence for THIS row can save it — and it does.
    const { t, orgId, asOwner } = await seedDealer("s59fleet2");
    const car = { ...baseImportRow, make: "Kia", model: "Sportage", year: 2023, purchasePrice: 10000 };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "fleet-2", purchasePaymentMethod: "CASH",
      vehicles: [{ ...car, rowId: 1, vin: "IMPORTFLEET0003C" }],
    });
    const before = await worldDelta(t, orgId);

    // A different row of the same import, identical in every fact, re-using the
    // first car's VIN because the operator copied the cell down.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "fleet-2", purchasePaymentMethod: "CASH",
        vehicles: [{ ...car, rowId: 2, vin: "IMPORTFLEET0003C" }],
      })
    ).rejects.toThrow(/already recorded under the same VIN/);
    expect(await worldDelta(t, orgId)).toEqual(before);

    // Whereas re-sending ROW 1 — the same row of the same import — is a proven
    // retry and moves nothing.
    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "fleet-2", purchasePaymentMethod: "CASH",
      vehicles: [{ ...car, rowId: 1, vin: "IMPORTFLEET0003C" }],
    });
    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, skipped: 0 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("the SAME key with different facts is a hard conflict, never a retry and never an update", async () => {
    // Four separate materially-different facts, each on its own dealer so the
    // conflict is the only thing under test. Resolving any of these in either
    // direction loses something: accepting the old outcome discards the change,
    // applying the new one rewrites a posted purchase.
    const car = { ...baseImportRow, vin: "IMPORTIDEM00001A", purchasePrice: 10000, rowId: 1 };
    const variants: Array<[string, Record<string, unknown>, "CASH" | "BANK_TRANSFER" | "ON_ACCOUNT"]> = [
      ["cost", { purchasePrice: 12000 }, "CASH"],
      ["payment method", {}, "BANK_TRANSFER"],
      ["ownership", { sourceType: "SOURCED", sourcedFromName: "Other Dealer", sourceCost: 9000 }, "CASH"],
      ["supplier", { sourcedFromName: "Someone Else" }, "CASH"],
    ];

    for (const [label, change, method] of variants) {
      const { t, orgId, asOwner } = await seedDealer(`s59idem-${label.replace(/\s/g, "")}`);
      await asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "conflict-1", purchasePaymentMethod: "CASH",
        vehicles: [car],
      });
      const before = await worldDelta(t, orgId);

      await expect(
        asOwner.mutation(api.vehicles.importBulk, {
          orgId, acquisitionPosting: "PURCHASE", importId: "conflict-1", purchasePaymentMethod: method,
          vehicles: [{ ...car, ...change }],
        })
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

      expect(await worldDelta(t, orgId)).toEqual(before);
    }
  });

  test("an identical VIN and identical facts under a DIFFERENT key is never a proven retry", async () => {
    // The distinction the whole redesign turns on. Everything about this row
    // matches what is already recorded — and that is precisely why it cannot be
    // waved through, because a second identical car matches just as well.
    const { t, orgId, asOwner } = await seedDealer("s59newkey");
    const car = { ...baseImportRow, vin: "IMPORTNEWKEY0001", purchasePrice: 10000, rowId: 1 };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "key-a", purchasePaymentMethod: "CASH", vehicles: [car],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "key-b", purchasePaymentMethod: "CASH", vehicles: [car],
      })
    ).rejects.toThrow(/already recorded under the same VIN/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("re-sending a FULL 25-row import proves every row independently, with no accounting duplicates", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59full25");
    const rows = Array.from({ length: 25 }, (_, i) => ({
      rowId: i + 1,
      ...baseImportRow,
      vin: `IMPORTFULL${String(i).padStart(7, "0")}`,
      purchasePrice: 1000,
    }));

    const first = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "full-25", purchasePaymentMethod: "CASH", vehicles: rows,
    });
    expect(first.inserted).toBe(25);
    const before = await worldDelta(t, orgId);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "full-25", purchasePaymentMethod: "CASH", vehicles: rows,
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 25, skipped: 0 });
    expect(await worldDelta(t, orgId)).toEqual(before);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(25_000_000);
  });

  test("a 26-row file is refused and leaves NO evidence, so the 25+1 split still imports both parts", async () => {
    // The cap is the reason a fleet purchase spans several imports at all, so
    // the boundary has to be clean in both directions: a refused oversize file
    // must not leave proof that suppresses the rows when they are re-sent.
    const { t, orgId, asOwner } = await seedDealer("s59boundary");
    const rows = Array.from({ length: 26 }, (_, i) => ({
      rowId: i + 1,
      ...baseImportRow,
      vin: `IMPORTEDGE${String(i).padStart(7, "0")}`,
      purchasePrice: 1000,
    }));

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "edge-1", purchasePaymentMethod: "CASH", vehicles: rows,
      })
    ).rejects.toThrow(/Import too large/);
    expect(await worldDelta(t, orgId)).toEqual(NOTHING_HAPPENED);

    // Split, keeping the ORIGINAL row numbers — which is what makes the halves
    // two parts of one file rather than two unrelated imports.
    const head = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "edge-1", purchasePaymentMethod: "CASH",
      vehicles: rows.slice(0, 25),
    });
    const tail = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "edge-1", purchasePaymentMethod: "CASH",
      vehicles: rows.slice(25),
    });

    expect(head.inserted).toBe(25);
    expect(tail.inserted).toBe(1);
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(26_000_000);

    // And re-sending either half is still a proven retry, not a second purchase.
    const replay = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "edge-1", purchasePaymentMethod: "CASH",
      vehicles: rows.slice(25),
    });
    expect(replay).toMatchObject({ inserted: 0, alreadyRecorded: 1 });
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(26_000_000);
  });

  test("ATOMICITY: a file that fails partway leaves no evidence able to suppress its own retry", async () => {
    // The inverse defect, and the reason the evidence is written inline with the
    // acquisition rather than before it or afterwards. If proof of row 1 could
    // outlive a failure in row 2, the corrected re-import would skip row 1 as
    // "already recorded" and its purchase would never reach the ledger at all.
    const { t, orgId, asOwner } = await seedDealer("s59atomic");
    const good = { rowId: 1, ...baseImportRow, vin: "IMPORTATOM00001A", purchasePrice: 10000 };
    const bad = { rowId: 2, ...baseImportRow, vin: "IMPORTATOM00002B", purchasePrice: 7000, status: "SOLD" };

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "atomic-1", purchasePaymentMethod: "CASH",
        vehicles: [good, bad],
      })
    ).rejects.toThrow(/sale/i);

    // Nothing at all — including no idempotency record for the row that "ran".
    const evidence = await t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(evidence).toHaveLength(0);

    // The corrected re-import records BOTH cars. If row 1's proof had survived
    // the rollback, it would be skipped here and 10,000 would never post.
    const fixed = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "atomic-1", purchasePaymentMethod: "CASH",
      vehicles: [good, { ...bad, status: undefined }],
    });
    expect(fixed).toMatchObject({ inserted: 2, alreadyRecorded: 0 });
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(17_000_000);
  });

  test("a purchase import that cannot identify itself is refused outright", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59noident");

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "IMPORTNOID00001A", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/did not identify itself/);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "no-rows", purchasePaymentMethod: "CASH",
        vehicles: [{ ...baseImportRow, vin: "IMPORTNOID00002B", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/carry no row number/);

    // Two rows claiming to be the same row would share one evidence record, so
    // the second would read as a retry of the first — the same silent loss,
    // arriving through the key instead of through the VIN.
    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "dup-rows", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "IMPORTNOID00003C", purchasePrice: 10000 },
          { rowId: 1, ...baseImportRow, vin: "IMPORTNOID00004D", purchasePrice: 10000 },
        ],
      })
    ).rejects.toThrow(/repeat a row number/);

    expect((await worldDelta(t, orgId)).vehicles).toBe(0);
  });

  test("OPENING_STOCK needs no identity at all — it posts nothing to be idempotent about", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59osident");
    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ ...baseImportRow, vin: "IMPORTOSID00001A", purchasePrice: 10000 }],
    });
    expect(result.inserted).toBe(1);
    const evidence = await t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(evidence).toHaveLength(0);
  });
  test("a proven retry is recognised even after the vehicle's VIN was corrected", async () => {
    // Proof of execution belongs to the ROW, not to anything currently in the
    // database. An earlier revision consulted it only inside the VIN lookup, so
    // an ordinary correction through the edit screen made the proof invisible:
    // reproduced at inserted=1, vehicles=2, inventory=20,000,000 and TWO
    // evidence rows under one key — double inventory and cash, plus an evidence
    // table that then throws on every `.unique()` read of that key.
    const { t, orgId, asOwner } = await seedDealer("faVinEdit");
    const row = { rowId: 1, ...baseImportRow, vin: "1HGCM82633A00777", purchasePrice: 10000 };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "fa-1", purchasePaymentMethod: "CASH", vehicles: [row],
    });
    const vehicle = await vehicleByVin(t, orgId, "1HGCM82633A00777");
    await asOwner.mutation(api.vehicles.update, {
      orgId, vehicleId: vehicle!._id, vin: "1HGCM82633A00888",
    });
    const before = await worldDelta(t, orgId);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "fa-1", purchasePaymentMethod: "CASH", vehicles: [row],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, skipped: 0 });
    expect(await worldDelta(t, orgId)).toEqual(before);
    // Exactly one evidence row. A second under the same key would make every
    // later `findCommandUnit` read of it throw.
    const evidence = await t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(evidence).toHaveLength(1);
  });

  test("the SAME key with a changed NON-FINANCIAL field is a conflict too", async () => {
    // A proven retry does no work at all, so a field missing from the
    // fingerprint is a field the operator can change and have silently
    // discarded — no write, no error, a response identical to a real retry.
    // Every one of these is persisted on the vehicle.
    const base = {
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A00999", purchasePrice: 10000,
    };
    const variants: Array<[string, Record<string, unknown>]> = [
      ["selling price", { sellingPrice: 19999 }],
      ["status", { status: "SOURCING" }],
      ["mileage", { mileage: 54321 }],
      ["colour", { color: "Midnight Blue" }],
      ["fuel type", { fuelType: "Diesel" }],
      ["transmission", { transmission: "Manual" }],
      ["notes", { notes: "roof rack included" }],
      ["valuations", { valuations: [{ companyName: "Orange Finance", valuationAmount: 12500 }] }],
    ];

    for (const [label, change] of variants) {
      const { t, orgId, asOwner } = await seedDealer(`s59fp-${label.replace(/\s/g, "")}`);
      await asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "fp-1", purchasePaymentMethod: "CASH",
        vehicles: [base],
      });
      const before = await worldDelta(t, orgId);

      await expect(
        asOwner.mutation(api.vehicles.importBulk, {
          orgId, acquisitionPosting: "PURCHASE", importId: "fp-1", purchasePaymentMethod: "CASH",
          vehicles: [{ ...base, ...change }],
        })
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

      expect(await worldDelta(t, orgId)).toEqual(before);
    }
  });

  test("re-ordering the same valuation columns is NOT a conflict", async () => {
    // The other failure direction. Column order is not a fact about the car, and
    // a fingerprint that reacted to it would refuse ordinary retries.
    const { t, orgId, asOwner } = await seedDealer("s59fporder");
    const valuations = [
      { companyName: "Orange Finance", valuationAmount: 12500 },
      { companyName: "Blue Finance", valuationAmount: 11000 },
    ];
    const base = { rowId: 1, ...baseImportRow, vin: "1HGCM82633A01111", purchasePrice: 10000 };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "fp-order", purchasePaymentMethod: "CASH",
      vehicles: [{ ...base, valuations }],
    });
    const before = await worldDelta(t, orgId);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "fp-order", purchasePaymentMethod: "CASH",
      vehicles: [{ ...base, valuations: [...valuations].reverse() }],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  // ── Durable physical-vehicle identity ─────────────────────────────────────
  //
  // TWO IDENTITIES, deliberately separate:
  //
  //   (importId, rowId)  COMMAND identity — proves this exact row of this exact
  //                      import already ran. Owns replay safety. Needs no VIN.
  //   a real VIN         VEHICLE identity — the only thing that correlates one
  //                      physical car ACROSS independent acquisition commands.
  //
  // A generated placeholder is unique to the insertion, so it provides the
  // second not at all. The same car uploaded tomorrow under a new importId
  // would become a second vehicle and a second acquisition — and row evidence
  // cannot stop that, because the second import IS a different command.

  test("a placeholder VIN in a PURCHASE import is refused atomically, with no evidence written", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59durable1");

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "durable-1", purchasePaymentMethod: "CASH",
        vehicles: [{ rowId: 1, ...baseImportRow, vin: "UNKNOWN", purchasePrice: 10000 }],
      })
    ).rejects.toThrow(/VIN is required for every vehicle/);

    // Nothing anywhere — including no command evidence. Proof of an import that
    // did not run is exactly what would suppress the corrected retry.
    expect(await worldDelta(t, orgId)).toEqual(NOTHING_HAPPENED);
  });

  test("TWO placeholder rows refuse atomically too — not one accepted and one dropped", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59durable2");
    const car = { ...baseImportRow, make: "Kia", model: "Sportage", year: 2023, purchasePrice: 10000 };

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "durable-2", purchasePaymentMethod: "CASH",
        vehicles: [
          { ...car, rowId: 1, vin: "UNKNOWN" },
          { ...car, rowId: 2, vin: "UNK" },
        ],
      })
    ).rejects.toThrow(/VIN is required for every vehicle/);

    expect(await worldDelta(t, orgId)).toEqual(NOTHING_HAPPENED);
  });

  test("a placeholder mixed into an otherwise valid file refuses the WHOLE file", async () => {
    const { t, orgId, asOwner } = await seedDealer("s59durable3");

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "durable-3", purchasePaymentMethod: "CASH",
        vehicles: [
          { rowId: 1, ...baseImportRow, vin: "1HGCM82633A02222", purchasePrice: 10000 },
          { rowId: 2, ...baseImportRow, vin: "N/A", purchasePrice: 7000 },
        ],
      })
    ).rejects.toThrow(/VIN is required for every vehicle/);

    expect(await worldDelta(t, orgId)).toEqual(NOTHING_HAPPENED);
  });

  test("OPENING_STOCK still accepts placeholders and still gives each row its own vehicle", async () => {
    // Unchanged on purpose. That path posts no acquisition money, so a
    // placeholder costs the books nothing — the lack of durable identity only
    // becomes a financial-integrity problem where an acquisition is recorded.
    const { t, orgId, asOwner } = await seedDealer("s59durable4");
    const car = { ...baseImportRow, make: "Kia", model: "Sportage", year: 2023, purchasePrice: 10000 };

    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ ...car, vin: "UNKNOWN" }, { ...car, vin: "UNK" }, { ...car, vin: "N/A" }],
    });

    expect(result.inserted).toBe(3);
    const vehicles = await t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehicles).toHaveLength(3);
    // Each got its own generated identifier rather than colliding on the filler.
    expect(new Set(vehicles.map((v) => v.vin)).size).toBe(3);
    // No money, and therefore no identity problem to solve.
    expect(await glBalanceMinor(t, orgId, "VEHICLE_INVENTORY")).toBe(0);
  });

  test("same-import replay safety comes from (importId, rowId), NOT from the VIN", async () => {
    // The two identities pulling in opposite directions, on purpose. The VIN
    // stored for this car is CHANGED between the original call and its retry —
    // so if replay safety were VIN-based it would fail here. It is not: the row
    // is recognised by its command identity alone.
    //
    // Read together with the placeholder refusals above, this is the whole
    // contract: command identity owns replay, VIN owns the physical car across
    // independent commands, and neither substitutes for the other.
    const { t, orgId, asOwner } = await seedDealer("s59durable5");
    const row = { rowId: 1, ...baseImportRow, vin: "1HGCM82633A03333", purchasePrice: 10000 };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "durable-5", purchasePaymentMethod: "CASH", vehicles: [row],
    });
    const vehicle = await vehicleByVin(t, orgId, "1HGCM82633A03333");
    await asOwner.mutation(api.vehicles.update, {
      orgId, vehicleId: vehicle!._id, vin: "1HGCM82633A04444",
    });
    const before = await worldDelta(t, orgId);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "durable-5", purchasePaymentMethod: "CASH", vehicles: [row],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, skipped: 0 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  test("a proven retry creates NOTHING — including the finance companies its valuations name", async () => {
    // The company-resolution loop runs before the row loop, so it used to reach
    // proven-retry rows too. Harmless while the company still exists under the
    // name the spreadsheet used; NOT harmless once somebody renames it in
    // Settings, because the lookup then misses and the retry recreates an inert
    // duplicate — while reporting alreadyRecorded, i.e. while claiming it did
    // nothing. Reproduced before the fix:
    //
    //   again={alreadyRecorded:1, companiesCreated:1}
    //   companies = "Orange Finance PLC" | "Orange Finance"
    //
    // One reviewer traced this path and concluded it was safe, reasoning that
    // the company would already exist. It does — under a name nobody has
    // touched. The rename is what breaks the reasoning, and only execution
    // showed it.
    const { t, orgId, asOwner } = await seedDealer("r8c2");
    const row = {
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A05555", purchasePrice: 10000,
      valuations: [{ companyName: "Orange Finance", valuationAmount: 12500 }],
    };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r8-c2", purchasePaymentMethod: "CASH", vehicles: [row],
    });
    const companies = await t.run((ctx) =>
      ctx.db.query("financeCompanies").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(companies).toHaveLength(1);
    // An ordinary settings edit, between the original call and its retry.
    await t.run((ctx) => ctx.db.patch(companies[0]._id, { name: "Orange Finance PLC" }));
    const before = await worldDelta(t, orgId);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r8-c2", purchasePaymentMethod: "CASH", vehicles: [row],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, companiesCreated: 0 });
    // A no-op that creates a row is not a no-op. worldDelta now counts finance
    // companies and valuations for exactly this reason.
    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("the SAME key with a company name differing only in CASE is a conflict", async () => {
    // Company matching is case-SENSITIVE (`companyIdByName` keys on the trimmed
    // name), so "orange finance" would create a second company. A fingerprint
    // that lowercased made the two hash equal and let the change through as a
    // proven retry — the hash agreeing where the writes would not.
    const { t, orgId, asOwner } = await seedDealer("r8c3a");
    const row = {
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A06666", purchasePrice: 10000,
      valuations: [{ companyName: "Orange Finance", valuationAmount: 12500 }],
    };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r8-c3a", purchasePaymentMethod: "CASH", vehicles: [row],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "r8-c3a", purchasePaymentMethod: "CASH",
        vehicles: [{ ...row, valuations: [{ companyName: "orange finance", valuationAmount: 12500 }] }],
      })
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("the SAME key with duplicate-company valuations REVERSED is a conflict", async () => {
    // Two valuations naming one company are applied in order and the last wins,
    // so reversing them persists a different amount. An order-blind sort hashed
    // them equal. Re-ordering DIFFERENT companies is still not a conflict —
    // covered by "re-ordering the same valuation columns is NOT a conflict".
    const { t, orgId, asOwner } = await seedDealer("r8c3b");
    const row = {
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A07777", purchasePrice: 10000,
      valuations: [
        { companyName: "Orange Finance", valuationAmount: 100 },
        { companyName: "Orange Finance", valuationAmount: 200 },
      ],
    };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r8-c3b", purchasePaymentMethod: "CASH", vehicles: [row],
    });
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "r8-c3b", purchasePaymentMethod: "CASH",
        vehicles: [{ ...row, valuations: [...row.valuations].reverse() }],
      })
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  test("changing a SUPERSEDED duplicate valuation is NOT a conflict — it changes nothing stored", async () => {
    // Surfaced by a surviving mutant: flipping the fingerprint from last-wins to
    // first-wins passed every test, because a REVERSED pair conflicts under both
    // rules. Only a change to the valuation that never reaches storage tells
    // them apart.
    //
    // Storage applies duplicates in order and the last one wins, so [100, 200]
    // and [300, 200] both persist 200. The fingerprint is a statement about what
    // gets WRITTEN, so these are the same request and must not conflict —
    // first-wins would refuse a retry whose outcome is identical.
    const { t, orgId, asOwner } = await seedDealer("r8c3c");
    const row = {
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A08888", purchasePrice: 10000,
      valuations: [
        { companyName: "Orange Finance", valuationAmount: 100 },
        { companyName: "Orange Finance", valuationAmount: 200 },
      ],
    };
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r8-c3c", purchasePaymentMethod: "CASH", vehicles: [row],
    });
    const before = await worldDelta(t, orgId);
    // The surviving 200 is what was stored; confirm that before relying on it.
    const stored = await t.run((ctx) =>
      ctx.db.query("vehicleValuations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].valuationAmount).toBe(200);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r8-c3c", purchasePaymentMethod: "CASH",
      vehicles: [{
        ...row,
        valuations: [
          { companyName: "Orange Finance", valuationAmount: 300 },
          { companyName: "Orange Finance", valuationAmount: 200 },
        ],
      }],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  test("a valuation storage would SKIP cannot hide a changed amount", async () => {
    // Both seats converged on this independently. Storage drops a non-positive
    // valuation before reading or writing anything, so it cannot overwrite what
    // an earlier positive entry for the same company already stored:
    //
    //   [100, 0] persists 100        [300, 0] persists 300
    //
    // An earlier canonicalization let the trailing entry win regardless, so both
    // collapsed to 0 and hashed EQUAL — and the retry's changed valuation was
    // discarded in silence. Not reachable through the import dialog, which
    // filters non-positive cells during derivation, but importBulk is a public
    // mutation and its own validator permits them.
    const { t, orgId, asOwner } = await seedDealer("r9skip");
    const base = { rowId: 1, ...baseImportRow, vin: "1HGCM82633A09999", purchasePrice: 10000 };
    const withTrailingZero = (surviving: number) => ({
      ...base,
      valuations: [
        { companyName: "Orange Finance", valuationAmount: surviving },
        { companyName: "Orange Finance", valuationAmount: 0 },
      ],
    });

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r9-skip", purchasePaymentMethod: "CASH",
      vehicles: [withTrailingZero(100)],
    });
    // The zero was skipped, so 100 is what is on record — the premise the
    // conflict below depends on.
    const stored = await t.run((ctx) =>
      ctx.db.query("vehicleValuations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].valuationAmount).toBe(100);
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "r9-skip", purchasePaymentMethod: "CASH",
        vehicles: [withTrailingZero(300)],
      })
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("...and a row whose ONLY valuation is skipped differs from one that stored a figure", async () => {
    // The other shape of the same collision: an entry storage never writes must
    // not make a row look like one that wrote something.
    const { t, orgId, asOwner } = await seedDealer("r9skip2");
    const base = { rowId: 1, ...baseImportRow, vin: "1HGCM82633A10101", purchasePrice: 10000 };

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r9-skip2", purchasePaymentMethod: "CASH",
      vehicles: [{
        ...base,
        valuations: [
          { companyName: "Orange Finance", valuationAmount: 100 },
          { companyName: "Orange Finance", valuationAmount: -1 },
        ],
      }],
    });
    const before = await worldDelta(t, orgId);
    expect(before.valuations).toBe(1);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "r9-skip2", purchasePaymentMethod: "CASH",
        vehicles: [{ ...base, valuations: [{ companyName: "Orange Finance", valuationAmount: -1 }] }],
      })
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  test("a company NAME that equals another company's ID does not collide with it", async () => {
    // Raised by one seat as a TWO-company/ONE-key collision — the mirror of
    // SCRUM-173's same-company/two-key one. Keying on the raw value put ids and
    // names in a single namespace, so these two entries collapsed to one key
    // while storage wrote TWO valuations: company <id>, and a company lazily
    // created under that literal name. Changing the id-side amount then left
    // the hash unchanged and the change was discarded as a proven retry.
    const { t, orgId, asOwner } = await seedDealer("r10ns");
    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId, name: "Orange Finance", profitRate: 0, maxTermMonths: 84,
        gracePeriodMonths: 0, isActive: false,
      })
    );
    const row = (idSideAmount: number) => ({
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A11111", purchasePrice: 10000,
      valuations: [
        { companyId, valuationAmount: idSideAmount },
        // A name that is literally the other company's id string.
        { companyName: companyId as unknown as string, valuationAmount: 200 },
      ],
    });

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r10-ns", purchasePaymentMethod: "CASH",
      vehicles: [row(100)],
    });
    // Storage really did treat them as two companies — the premise of the
    // conflict below, asserted rather than assumed.
    const stored = await t.run((ctx) =>
      ctx.db.query("vehicleValuations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(stored).toHaveLength(2);
    const before = await worldDelta(t, orgId);

    await expect(
      asOwner.mutation(api.vehicles.importBulk, {
        orgId, acquisitionPosting: "PURCHASE", importId: "r10-ns", purchasePaymentMethod: "CASH",
        vehicles: [row(300)],
      })
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("a valuation with no usable company at all is skipped by the fingerprint too", async () => {
    // The companion gap the other seat found: storage drops an entry whose
    // company cannot be resolved, so the fingerprint must drop it as well.
    // Only ever over-rejects if it disagrees — a false conflict rather than a
    // silent discard — but a rule that mirrors storage needs no such caveat.
    const { t, orgId, asOwner } = await seedDealer("r10noco");
    const base = { rowId: 1, ...baseImportRow, vin: "1HGCM82633A12121", purchasePrice: 10000 };

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r10-noco", purchasePaymentMethod: "CASH",
      vehicles: [{ ...base, valuations: [{ companyName: "   ", valuationAmount: 500 }] }],
    });
    const before = await worldDelta(t, orgId);
    expect(before.valuations).toBe(0);
    expect(before.companies).toBe(0);

    // A different unusable amount for the same unusable company is still the
    // same request, because storage writes nothing either way.
    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r10-noco", purchasePaymentMethod: "CASH",
      vehicles: [{ ...base, valuations: [{ companyName: "   ", valuationAmount: 900 }] }],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1 });
    expect(await worldDelta(t, orgId)).toEqual(before);
  });
  // ── The company-creation side effect ──────────────────────────────────────
  //
  // The writer skips a non-positive valuation, and so does the retry
  // fingerprint. The creation loop did not, so a named zero-valued entry still
  // created an inert company — a real side effect outside everything the proof
  // describes. `{A, 0}`, `{B, 0}` and no valuation at all were ONE command to
  // the fingerprint and THREE different outcomes in the database.
  //
  // Fixed at the creation loop, NOT in the fingerprint: the fingerprint already
  // mirrors the valuation storage rule correctly, and it had been through five
  // consecutive rounds of fix-induced defects. This is a bounded alignment of a
  // separate pre-write loop, not another identity rule.

  test("a ZERO-valued named valuation creates no company in a PURCHASE import", async () => {
    const { t, orgId, asOwner } = await seedDealer("r11zero");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r11-zero", purchasePaymentMethod: "CASH",
      vehicles: [{
        rowId: 1, ...baseImportRow, vin: "1HGCM82633A13131", purchasePrice: 10000,
        valuations: [{ companyName: "Orange Finance", valuationAmount: 0 }],
      }],
    });

    const delta = await worldDelta(t, orgId);
    expect(delta.companies).toBe(0);
    expect(delta.valuations).toBe(0);
  });

  test("a NEGATIVE named valuation creates no company either", async () => {
    const { t, orgId, asOwner } = await seedDealer("r11neg");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r11-neg", purchasePaymentMethod: "CASH",
      vehicles: [{
        rowId: 1, ...baseImportRow, vin: "1HGCM82633A14141", purchasePrice: 10000,
        valuations: [{ companyName: "Orange Finance", valuationAmount: -250 }],
      }],
    });

    const delta = await worldDelta(t, orgId);
    expect(delta.companies).toBe(0);
    expect(delta.valuations).toBe(0);
  });

  test("a retry naming a DIFFERENT company at zero is a true no-op, not a discarded creation", async () => {
    // THE REPORTED CASE. Both submissions hash identically — correctly, now
    // that neither writes anything. Before the guard the first created company
    // "Orange Finance", the retry was accepted as proven, and "Blue Finance"
    // was silently never created: one command to the proof, two outcomes in the
    // database.
    const { t, orgId, asOwner } = await seedDealer("r11diff");
    const row = (companyName: string) => ({
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A15151", purchasePrice: 10000,
      valuations: [{ companyName, valuationAmount: 0 }],
    });

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r11-diff", purchasePaymentMethod: "CASH",
      vehicles: [row("Orange Finance")],
    });
    const before = await worldDelta(t, orgId);
    expect(before.companies).toBe(0);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r11-diff", purchasePaymentMethod: "CASH",
      vehicles: [row("Blue Finance")],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1, companiesCreated: 0 });
    // The proof and the database now agree that nothing happened, in both calls.
    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("POSITIVE CONTROL: a real valuation still creates its company and its row", async () => {
    // The guard must not have closed the ordinary path.
    const { t, orgId, asOwner } = await seedDealer("r11pos");
    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r11-pos", purchasePaymentMethod: "CASH",
      vehicles: [{
        rowId: 1, ...baseImportRow, vin: "1HGCM82633A16161", purchasePrice: 10000,
        valuations: [{ companyName: "Orange Finance", valuationAmount: 12500 }],
      }],
    });

    expect(result.companiesCreated).toBe(1);
    const delta = await worldDelta(t, orgId);
    expect(delta.companies).toBe(1);
    expect(delta.valuations).toBe(1);
  });

  test("OPENING_STOCK is UNCHANGED — a zero-valued column still creates its company", async () => {
    // Scoped to PURCHASE on purpose. Only that mode has an idempotency proof to
    // disagree with, and a cutover migration must not change shape because of a
    // rule written for a different mode.
    const { t, orgId, asOwner } = await seedDealer("r11os");
    const result = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{
        ...baseImportRow, vin: "1HGCM82633A17171", purchasePrice: 10000,
        valuations: [{ companyName: "Orange Finance", valuationAmount: 0 }],
      }],
    });

    expect(result.companiesCreated).toBe(1);
    expect((await worldDelta(t, orgId)).companies).toBe(1);
  });
  // ── A blank company name resolves to NOTHING ──────────────────────────────
  //
  // `finance.createCompany` stores `name` untrimmed, so a company literally
  // named "   " can exist, and it is indexed under the EMPTY key. A valuation
  // naming no company then attached itself to that one via
  // `companyIdByName.get("")` — a write the retry fingerprint does not describe,
  // because it excludes entries with no usable company. So a re-sent row that
  // changed it hashed identically and the change was discarded.
  //
  // The fix removes only the AMBIGUOUS name-only lookup. An explicit companyId
  // still resolves, so an existing malformed company stays referenceable.

  /** A finance company whose stored name is whitespace — legal today. */
  async function seedBlankNamedCompany(t: Ctx["t"], orgId: Id<"organizations">) {
    return t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId, name: "   ", profitRate: 0, maxTermMonths: 84,
        gracePeriodMonths: 0, isActive: false,
      })
    );
  }

  test("a blank-named valuation writes NOTHING, even when a blank-named company exists", async () => {
    const { t, orgId, asOwner } = await seedDealer("r12blank");
    await seedBlankNamedCompany(t, orgId);

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r12-blank", purchasePaymentMethod: "CASH",
      vehicles: [{
        rowId: 1, ...baseImportRow, vin: "1HGCM82633A18181", purchasePrice: 10000,
        valuations: [{ companyName: "   ", valuationAmount: 5000 }],
      }],
    });

    // Positive amount, and still not stored — the name resolves to nothing.
    expect((await worldDelta(t, orgId)).valuations).toBe(0);
  });

  test("...and re-sending it with a CHANGED amount is a true no-op, not a discarded write", async () => {
    // Before the guard the first call stored 5000 against the blank-named
    // company, the retry hashed identically because the fingerprint excludes
    // the entry, and 9000 was silently dropped.
    const { t, orgId, asOwner } = await seedDealer("r12blank2");
    await seedBlankNamedCompany(t, orgId);
    const row = (amount: number) => ({
      rowId: 1, ...baseImportRow, vin: "1HGCM82633A19191", purchasePrice: 10000,
      valuations: [{ companyName: "   ", valuationAmount: amount }],
    });

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r12-blank2", purchasePaymentMethod: "CASH",
      vehicles: [row(5000)],
    });
    const before = await worldDelta(t, orgId);
    expect(before.valuations).toBe(0);

    const again = await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r12-blank2", purchasePaymentMethod: "CASH",
      vehicles: [row(9000)],
    });

    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 1 });
    // The proof and the database agree that nothing happened, both times.
    expect(await worldDelta(t, orgId)).toEqual(before);
  });

  test("an EXPLICIT companyId for that same malformed company still works", async () => {
    // The guard closes an ambiguous lookup; it must not orphan existing data.
    const { t, orgId, asOwner } = await seedDealer("r12byid");
    const companyId = await seedBlankNamedCompany(t, orgId);

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r12-byid", purchasePaymentMethod: "CASH",
      vehicles: [{
        rowId: 1, ...baseImportRow, vin: "1HGCM82633A20202", purchasePrice: 10000,
        valuations: [{ companyId, valuationAmount: 5000 }],
      }],
    });

    const stored = await t.run((ctx) =>
      ctx.db.query("vehicleValuations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].companyId).toBe(companyId);
    expect(stored[0].valuationAmount).toBe(5000);
  });

  test("POSITIVE CONTROL: an ordinary named valuation is untouched by the guard", async () => {
    const { t, orgId, asOwner } = await seedDealer("r12ok");
    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "PURCHASE", importId: "r12-ok", purchasePaymentMethod: "CASH",
      vehicles: [{
        rowId: 1, ...baseImportRow, vin: "1HGCM82633A21212", purchasePrice: 10000,
        valuations: [{ companyName: "Orange Finance", valuationAmount: 12500 }],
      }],
    });

    const delta = await worldDelta(t, orgId);
    expect(delta.companies).toBe(1);
    expect(delta.valuations).toBe(1);
  });

  test("OPENING_STOCK is UNCHANGED — a blank-named valuation still resolves there", async () => {
    // Pinned deliberately. Only PURCHASE has an idempotency proof for a write
    // to disagree with, and a cutover migration must not change shape because
    // of a rule written for a different mode.
    const { t, orgId, asOwner } = await seedDealer("r12os");
    const companyId = await seedBlankNamedCompany(t, orgId);

    await asOwner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{
        ...baseImportRow, vin: "1HGCM82633A22222", purchasePrice: 10000,
        valuations: [{ companyName: "   ", valuationAmount: 5000 }],
      }],
    });

    const stored = await t.run((ctx) =>
      ctx.db.query("vehicleValuations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].companyId).toBe(companyId);
  });
});
