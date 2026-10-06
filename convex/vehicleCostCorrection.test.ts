/**
 * SCRUM-650 — a posted vehicle acquisition cost changes only together with its
 * Vehicle Inventory GL balance and the account the acquisition credited, through
 * one audited correction that posts NOW.
 *
 * Each refusal asserts the machine code AND that nothing moved (no event, no
 * correction row, purchasePrice and payable untouched).
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { costCorrectionCounterKey } from "./vehicles";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

const OWNER_PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "view:vehicles",
  "create:expenses", "edit:expenses", "view:expenses",
  "view:finance", "manage:finance", "view:reports",
];

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

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Cost Correction Dealer ${suffix}`, createdAt: Date.now() })
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
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: OWNER_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId, commissionRate: 10 }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const asOwner = t.withIdentity({ subject: `owner_${suffix}`, clerkId: `owner_${suffix}` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
    fiscalYear: 2025, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { t, orgId, userId, asOwner, periodId: period._id };
}

type Dealer = Awaited<ReturnType<typeof seedDealer>>;

async function balanceMinor(t: Dealer["t"], orgId: Id<"organizations">, systemKey: string): Promise<number> {
  const account = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
  const lines = await t.run((ctx) =>
    ctx.db
      .query("journalLines")
      .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("accountId", account!._id))
      .collect()
  );
  return lines.reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return error.data as { code?: string; message?: string };
    throw error;
  }
  return undefined;
}

async function snapshot(t: Dealer["t"], orgId: Id<"organizations">, vehicleId: Id<"vehicles">) {
  return t.run(async (ctx) => ({
    purchasePrice: (await ctx.db.get(vehicleId))?.purchasePrice,
    corrections: (await ctx.db.query("vehicleCostCorrections").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    pending: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").collect()).map((p) => ({
      id: p._id, amountDue: p.amountDue, status: p.status, amountPaid: p.amountPaid,
    })),
  }));
}

async function createCashVehicle(d: Dealer, price = 12500, method: "CASH" | "BANK_TRANSFER" = "CASH") {
  return d.asOwner.mutation(api.vehicles.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: d.orgId, ...baseVehicle, purchasePrice: price, purchasePaymentMethod: method,
  });
}

async function createOnAccountVehicle(d: Dealer, price = 12500) {
  return d.asOwner.mutation(api.vehicles.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: d.orgId, ...baseVehicle, purchasePrice: price,
    purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierName: "Credit Supplier Co",
  });
}

async function payableOf(t: Dealer["t"], vehicleId: Id<"vehicles">) {
  return t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).first()
  );
}

/**
 * SCRUM-725: a prior-period restatement describes a purchase booked in a period
 * that is already shut. Moves the car's posted acquisition into a CLOSED 2019
 * period (the open 2020-2035 period the correction itself posts into is left as
 * it was), which is the only situation the restatement type is offered for.
 */
async function bookAcquisitionInClosedPeriod(d: Dealer, vehicleId: Id<"vehicles">) {
  await d.t.run(async (ctx) => {
    const existing = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_startDate", (q) => q.eq("orgId", d.orgId).eq("startDate", Date.UTC(2019, 0, 1)))
      .first();
    if (!existing) {
      await ctx.db.insert("accountingPeriods", {
        orgId: d.orgId, startDate: Date.UTC(2019, 0, 1), endDate: Date.UTC(2019, 11, 31, 23, 59, 59, 999),
        fiscalYear: 2019, periodNumber: 1, status: "CLOSED", createdAt: Date.now(),
      });
    }
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", d.orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString()))
      .collect();
    for (const event of events) {
      if (event.eventType === "VEHICLE_ACQUIRED") await ctx.db.patch(event._id, { accountingDate: Date.UTC(2019, 5, 15) });
    }
  });
}

describe("SCRUM-650 correctAcquisitionCost — cash acquisition", () => {
  test("1. CASH_REFUND with the original method lowers cost, inventory and returns the cash", async () => {
    const d = await seedDealer("c1");
    const vehicleId = await createCashVehicle(d, 12500, "CASH");
    const inventoryBefore = await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY");
    const cashBefore = await balanceMinor(d.t, d.orgId, "CASH_ON_HAND");

    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Recorded payment was wrong",
      correctionType: "CASH_REFUND", paymentMethod: "CASH",
    });

    const vehicle = await d.t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.purchasePrice).toBe(9800);
    expect(inventoryBefore - (await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY"))).toBe(2_700_000);
    expect((await balanceMinor(d.t, d.orgId, "CASH_ON_HAND")) - cashBefore).toBe(2_700_000);
    const rows = await d.t.run((ctx) =>
      ctx.db.query("vehicleCostCorrections").withIndex("by_org_vehicle", (q) => q.eq("orgId", d.orgId).eq("vehicleId", vehicleId)).collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ previousCost: 12500, newCost: 9800, correctionType: "CASH_REFUND" });
  });

  test("2. SUPPLIER_INVOICE_ERROR and VENDOR_CREDIT on a cash car are refused TYPE_NOT_ALLOWED and nothing changes", async () => {
    const d = await seedDealer("c2");
    const vehicleId = await createCashVehicle(d);
    const before = await snapshot(d.t, d.orgId, vehicleId);

    for (const correctionType of ["SUPPLIER_INVOICE_ERROR", "VENDOR_CREDIT"] as const) {
      const data = await refusalOf(
        d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
          orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType,
        })
      );
      expect(data?.code).toBe("COST_CORRECTION_TYPE_NOT_ALLOWED");
    }
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("CASH_REFUND without a payment method is refused PAYMENT_METHOD_REQUIRED", async () => {
    const d = await seedDealer("c2b");
    const vehicleId = await createCashVehicle(d);
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "CASH_REFUND",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_PAYMENT_METHOD_REQUIRED");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("input refusals carry their codes (reason, amount)", async () => {
    const d = await seedDealer("c2c");
    const vehicleId = await createCashVehicle(d);
    const call = (args: { newCost: number; reason: string }) =>
      refusalOf(
        d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
          orgId: d.orgId, vehicleId, correctionType: "PRIOR_PERIOD_RESTATEMENT", ...args,
        })
      );
    expect((await call({ newCost: 9000, reason: "   " }))?.code).toBe("COST_CORRECTION_REASON_REQUIRED");
    expect((await call({ newCost: -1, reason: "x" }))?.code).toBe("COST_CORRECTION_INVALID_AMOUNT");
    expect((await call({ newCost: Number.NaN, reason: "x" }))?.code).toBe("COST_CORRECTION_INVALID_AMOUNT");
  });

  test("9. a retry of the same correction is refused NO_CHANGE and posts nothing more", async () => {
    const d = await seedDealer("c9");
    const vehicleId = await createCashVehicle(d);
    const args = {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong",
      correctionType: "CASH_REFUND" as const, paymentMethod: "CASH" as const,
    };
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, args);
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(d.asOwner.mutation(api.vehicles.correctAcquisitionCost, args));
    expect(data?.code).toBe("COST_CORRECTION_NO_CHANGE");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });
});

describe("SCRUM-650 correctAcquisitionCost — ON_ACCOUNT acquisition", () => {
  test("3. SUPPLIER_INVOICE_ERROR rewrites the payable, lowers AP and inventory, and markPaid nets AP to zero", async () => {
    const d = await seedDealer("a3");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const apBefore = await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS");
    const inventoryBefore = await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY");

    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Supplier invoice was wrong",
      correctionType: "SUPPLIER_INVOICE_ERROR",
    });

    const payable = await payableOf(d.t, vehicleId);
    expect(payable?.amountDue).toBe(9800);
    expect(apBefore - (await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS"))).toBe(-2_700_000);
    expect(inventoryBefore - (await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY"))).toBe(2_700_000);
    // AP is a credit-normal account: the credit balance (negative net) shrank by 2,700.
    expect(await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(-9_800_000);

    await d.asOwner.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, payableId: payable!._id, paymentMethod: "BANK_TRANSFER",
    });
    expect(await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(0);
  });

  test("10. an upward correction raises the payable's amountDue", async () => {
    const d = await seedDealer("a10");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 13000, reason: "Invoice total was understated",
      correctionType: "SUPPLIER_INVOICE_ERROR",
    });
    expect((await payableOf(d.t, vehicleId))?.amountDue).toBe(13000);
    expect(await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(-13_000_000);
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(13000);
  });

  test("4. a partly paid payable refuses AP types with PAYABLE_NOT_ADJUSTABLE and nothing changes", async () => {
    const d = await seedDealer("a4");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const payable = await payableOf(d.t, vehicleId);
    await d.asOwner.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, payableId: payable!._id, amount: 1000, paymentMethod: "BANK_TRANSFER",
    });
    const before = await snapshot(d.t, d.orgId, vehicleId);

    for (const correctionType of ["SUPPLIER_INVOICE_ERROR", "VENDOR_CREDIT"] as const) {
      const data = await refusalOf(
        d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
          orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType,
        })
      );
      expect(data?.code).toBe("COST_CORRECTION_PAYABLE_NOT_ADJUSTABLE");
    }
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("an AP correction to zero is refused INVALID_AMOUNT", async () => {
    const d = await seedDealer("a4b");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 0, reason: "wrong", correctionType: "VENDOR_CREDIT",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_INVALID_AMOUNT");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("a payable whose amount drifted from the capitalized cost refuses AP types", async () => {
    const d = await seedDealer("a4c");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const payable = await payableOf(d.t, vehicleId);
    await d.t.run((ctx) => ctx.db.patch(payable!._id, { amountDue: 12000 }));
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "SUPPLIER_INVOICE_ERROR",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_PAYABLE_NOT_ADJUSTABLE");
  });

  test("5. CASH_REFUND on an unpaid ON_ACCOUNT car is refused TYPE_NOT_ALLOWED", async () => {
    const d = await seedDealer("a5");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong",
        correctionType: "CASH_REFUND", paymentMethod: "CASH",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_TYPE_NOT_ALLOWED");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("CASH_REFUND on a PAID ON_ACCOUNT car is allowed and leaves the payable alone", async () => {
    const d = await seedDealer("a5b");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const payable = await payableOf(d.t, vehicleId);
    await d.asOwner.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, payableId: payable!._id, paymentMethod: "BANK_TRANSFER",
    });
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Supplier refunded the difference",
      correctionType: "CASH_REFUND", paymentMethod: "BANK_TRANSFER",
    });
    expect((await payableOf(d.t, vehicleId))?.amountDue).toBe(12500);
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(9800);
  });
});

describe("SCRUM-650 correctAcquisitionCost — preconditions", () => {
  test("6. a pending-only acquisition is refused NOT_POSTED and the context reports PENDING_POST", async () => {
    const d = await seedDealer("p6");
    await d.t.run((ctx) => ctx.db.patch(d.periodId, { status: "CLOSED" }));
    const vehicleId = await createCashVehicle(d);
    const events = await d.t.run((ctx) => ctx.db.query("accountingEvents").collect());
    expect(events.filter((e) => e.eventType === "VEHICLE_ACQUIRED" && e.status === "POSTED")).toHaveLength(0);
    const queued = await d.t.run((ctx) =>
      ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", (q) => q.eq("orgId", d.orgId).eq("idempotencyKey", `vehicle_acquired_${vehicleId}`)).collect()
    );
    expect(queued).toHaveLength(1);

    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_NOT_POSTED");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);

    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context).toMatchObject({ blockedReason: "PENDING_POST", allowedTypes: [] });
  });

  test("7a. a closed period refuses NOT_POSTABLE_NOW: nothing queued, nothing patched", async () => {
    const d = await seedDealer("p7a");
    const vehicleId = await createCashVehicle(d);
    await d.t.run((ctx) => ctx.db.patch(d.periodId, { status: "CLOSED" }));
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_NOT_POSTABLE_NOW");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("7b. an unmapped counter-account refuses NOT_POSTABLE_NOW: nothing queued, nothing patched", async () => {
    const d = await seedDealer("p7b");
    const vehicleId = await createCashVehicle(d);
    await bookAcquisitionInClosedPeriod(d, vehicleId);
    const retained = await d.t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", d.orgId).eq("systemKey", "RETAINED_EARNINGS")).unique()
    );
    await d.t.run((ctx) => ctx.db.patch(retained!._id, { active: false }));
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_NOT_POSTABLE_NOW");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("sold and sourced vehicles are refused with their own codes", async () => {
    const d = await seedDealer("p7c");
    const soldId = await createCashVehicle(d);
    await d.t.run((ctx) => ctx.db.patch(soldId, { status: "SOLD" }));
    const sourcedId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, vin: "1HGCM82633A000002", sourceType: "SOURCED", sourcedFromName: "Supplier Dealer", sourceCost: 9000,
    });
    const call = (vehicleId: Id<"vehicles">) =>
      refusalOf(
        d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
          orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
        })
      );
    expect((await call(soldId))?.code).toBe("COST_CORRECTION_SOLD");
    expect((await call(sourcedId))?.code).toBe("COST_CORRECTION_SOURCED");
  });

  test("8. a user without MANAGE_FINANCE is refused by the mutation and the query; a wrong org is refused", async () => {
    const d = await seedDealer("p8");
    const vehicleId = await createCashVehicle(d);
    const clerkUserId = await d.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "viewer_p8", email: "viewer.p8@example.com", name: "Viewer" })
    );
    const roleId = await d.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: d.orgId, name: "Viewer", permissions: ["view:vehicles", "edit:vehicles", "view:finance"] })
    );
    await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId: clerkUserId, roleId }));
    const asViewer = d.t.withIdentity({ subject: "viewer_p8", clerkId: "viewer_p8" });
    const before = await snapshot(d.t, d.orgId, vehicleId);

    await expect(
      asViewer.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    ).rejects.toThrow();
    await expect(
      asViewer.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId })
    ).rejects.toThrow();
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);

    // Another dealership's owner, aiming at this dealership's org, and at its own org with this car.
    const otherOrgId = await d.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    await d.t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: otherOrgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const foreignUserId = await d.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "owner_p8other", email: "p8other@example.com", name: "Other Owner" })
    );
    const foreignRoleId = await d.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "Owner", permissions: OWNER_PERMISSIONS, isSystemOwnerRole: true })
    );
    await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: foreignUserId, roleId: foreignRoleId }));
    const foreignOwner = d.t.withIdentity({ subject: "owner_p8other", clerkId: "owner_p8other" });
    // Aimed at this dealership's org: refused by tenancy.
    await expect(
      foreignOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    ).rejects.toThrow();
    // Aimed at its own org with this dealership's car: refused as not found.
    const data = await refusalOf(
      foreignOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: otherOrgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    );
    expect(data?.code).toBe("VEHICLE_NOT_FOUND");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });
});

describe("SCRUM-650 getAcquisitionCostCorrectionContext", () => {
  test("reports the matrix, the payable and the history for an ON_ACCOUNT car", async () => {
    const d = await seedDealer("q1");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    let context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context).toMatchObject({
      blockedReason: null, currentCost: 12500, currency: "JOD",
      originalPaymentMethod: "ON_ACCOUNT",
      payable: { status: "PENDING", amountDue: 12500, amountPaid: 0 },
      // SCRUM-725: the purchase is in an OPEN period, so no restatement is offered.
      allowedTypes: ["SUPPLIER_INVOICE_ERROR", "VENDOR_CREDIT"],
      corrections: [],
    });
    await bookAcquisitionInClosedPeriod(d, vehicleId);
    context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.allowedTypes).toEqual(["SUPPLIER_INVOICE_ERROR", "VENDOR_CREDIT", "PRIOR_PERIOD_RESTATEMENT"]);
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Supplier invoice was wrong",
      correctionType: "SUPPLIER_INVOICE_ERROR",
    });
    context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.currentCost).toBe(9800);
    expect(context.corrections).toHaveLength(1);
    expect(context.corrections[0]).toMatchObject({ previousCost: 12500, newCost: 9800, correctionType: "SUPPLIER_INVOICE_ERROR" });
  });

  test("a cash car allows only refund and restatement; a car with no posted acquisition is NOT_POSTED", async () => {
    const d = await seedDealer("q2");
    const vehicleId = await createCashVehicle(d);
    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context).toMatchObject({
      blockedReason: null, originalPaymentMethod: "CASH", payable: null,
      // SCRUM-725: restatement only once the purchase's period is closed.
      allowedTypes: ["CASH_REFUND"],
    });
    await bookAcquisitionInClosedPeriod(d, vehicleId);
    expect(
      (await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId })).allowedTypes
    ).toEqual(["CASH_REFUND", "PRIOR_PERIOD_RESTATEMENT"]);
    const noCostId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, vin: "1HGCM82633A000003",
    });
    const blocked = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId: noCostId });
    expect(blocked).toMatchObject({ blockedReason: "NOT_POSTED" });
  });

  test("a legacy PAID payable with no amountPaid reports the full amount as paid (CodeRabbit #446)", async () => {
    const d = await seedDealer("q3");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    await d.t.run(async (ctx) => {
      const payable = await ctx.db.query("vehicleSupplierPayables").first();
      await ctx.db.patch(payable!._id, { status: "PAID", amountPaid: undefined });
    });
    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.payable).toEqual({ status: "PAID", amountDue: 12500, amountPaid: 12500 });
  });
});

describe("SCRUM-650 the purchase-cost lock", () => {
  test("11. vehicles.update on a posted cost refuses with code VEHICLE_COST_POSTED", async () => {
    const d = await seedDealer("l11");
    const vehicleId = await createCashVehicle(d);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, purchasePrice: 9000 })
    );
    expect(data?.code).toBe("VEHICLE_COST_POSTED");
    expect(data?.message).toMatch(/Correct purchase cost/);
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(12500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCRUM-650 batch 2: review fixes
// ─────────────────────────────────────────────────────────────────────────────

async function memberFromTemplate(d: Dealer, templateName: string, suffix: string) {
  const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === templateName);
  if (!template) throw new Error(`no role template ${templateName}`);
  const userId = await d.t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `tpl_${suffix}`, email: `tpl.${suffix}@example.com`, name: templateName })
  );
  const roleId = await d.t.run((ctx) =>
    ctx.db.insert("roles", { orgId: d.orgId, name: `${templateName} ${suffix}`, permissions: [...template.permissions] })
  );
  await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId, roleId }));
  return d.t.withIdentity({ subject: `tpl_${suffix}`, clerkId: `tpl_${suffix}` });
}

const RESTATE = { reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT" as const };

describe("SCRUM-650 batch 2 A1: the cost-visibility gate", () => {
  test("the default ACCOUNTANT template (MANAGE_FINANCE, no VIEW_COST_PRICE) is refused by the query and the mutation; SENIOR_ACCOUNTANT is allowed", async () => {
    const d = await seedDealer("b1");
    const vehicleId = await createCashVehicle(d);
    await bookAcquisitionInClosedPeriod(d, vehicleId);
    const asAccountant = await memberFromTemplate(d, "ACCOUNTANT", "b1acc");
    const asSenior = await memberFromTemplate(d, "SENIOR_ACCOUNTANT", "b1sen");
    const before = await snapshot(d.t, d.orgId, vehicleId);

    await expect(
      asAccountant.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId })
    ).rejects.toThrow();
    await expect(
      asAccountant.mutation(api.vehicles.correctAcquisitionCost, { orgId: d.orgId, vehicleId, newCost: 9800, ...RESTATE })
    ).rejects.toThrow();
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);

    const context = await asSenior.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.currentCost).toBe(12500);
    await asSenior.mutation(api.vehicles.correctAcquisitionCost, { orgId: d.orgId, vehicleId, newCost: 9800, ...RESTATE });
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(9800);
  });
});

describe("SCRUM-650 batch 2 A2: payable eligibility is derived from the money", () => {
  test("a payable that was disputed and un-disputed is still correctable, and AP, payable and inventory move together", async () => {
    const d = await seedDealer("b2");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const payable = await payableOf(d.t, vehicleId);
    await d.asOwner.mutation(api.sourcingPayables.setDisputed, { orgId: d.orgId, payableId: payable!._id, disputed: true, reason: "Invoice total in question" });
    await d.asOwner.mutation(api.sourcingPayables.setDisputed, { orgId: d.orgId, payableId: payable!._id, disputed: false });
    const inventoryBefore = await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY");

    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Supplier invoice was wrong", correctionType: "SUPPLIER_INVOICE_ERROR",
    });

    expect((await payableOf(d.t, vehicleId))?.amountDue).toBe(9800);
    expect(await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(-9_800_000);
    expect(inventoryBefore - (await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY"))).toBe(2_700_000);
    await d.asOwner.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, payableId: payable!._id, paymentMethod: "BANK_TRANSFER",
    });
    expect(await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(0);
  });

  test("control: while the payable is DISPUTED the correction is refused PAYABLE_NOT_ADJUSTABLE and nothing changes", async () => {
    const d = await seedDealer("b2c");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const payable = await payableOf(d.t, vehicleId);
    await d.asOwner.mutation(api.sourcingPayables.setDisputed, { orgId: d.orgId, payableId: payable!._id, disputed: true, reason: "Invoice total in question" });
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "SUPPLIER_INVOICE_ERROR",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_PAYABLE_NOT_ADJUSTABLE");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });
});

describe("SCRUM-650 batch 2 A3: only representable amounts", () => {
  test("9800.0004 JOD is refused INVALID_AMOUNT and nothing changes; 9800.001 succeeds", async () => {
    const d = await seedDealer("b3");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const journalsBefore = (await d.t.run((ctx) => ctx.db.query("journalEntries").collect())).length;
    const transactionsBefore = (await d.t.run((ctx) => ctx.db.query("transactions").collect())).length;

    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800.0004, reason: "wrong", correctionType: "SUPPLIER_INVOICE_ERROR",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_INVALID_AMOUNT");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
    expect((await d.t.run((ctx) => ctx.db.query("journalEntries").collect())).length).toBe(journalsBefore);
    expect((await d.t.run((ctx) => ctx.db.query("transactions").collect())).length).toBe(transactionsBefore);

    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800.001, reason: "fine", correctionType: "SUPPLIER_INVOICE_ERROR",
    });
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(9800.001);
  });
});

describe("SCRUM-650 batch 2 A4: the cashbook projection of a cash correction", () => {
  const ALL_TIME = { startDate: 0, endDate: Date.UTC(2100, 0, 1) };
  const listAll = (d: Dealer) =>
    d.asOwner.query(api.transactions.list, { orgId: d.orgId, paginationOpts: { numItems: 100, cursor: null } });

  test("cash 12,500 refunded to 9,800: the original OUT stays, an IN 2,700 is added, and P&L cost is 9,800", async () => {
    const d = await seedDealer("b4a");
    const vehicleId = await createCashVehicle(d, 12500, "CASH");
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Supplier refunded", correctionType: "CASH_REFUND", paymentMethod: "CASH",
    });
    const rows = (await listAll(d)).page.filter((r) => r.category === "VEHICLE_PURCHASE");
    expect(rows.map((r) => [r.type, r.amount]).sort()).toEqual([["IN", 2700], ["OUT", 12500]]);
    const refund = rows.find((r) => r.type === "IN");
    expect(refund?.vehicleId).toBe(vehicleId);
    expect(refund?.description).toMatch(/correction/i);
    const pnl = await d.asOwner.query(api.reports.getProfitAndLoss, { orgId: d.orgId, ...ALL_TIME });
    expect(pnl.costOfGoodsSold).toBe(9800);
    expect(pnl.totalRevenue).toBe(0);
  });

  test("an upward cash correction adds an OUT row for the extra amount", async () => {
    const d = await seedDealer("b4b");
    const vehicleId = await createCashVehicle(d, 12500, "CASH");
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 13000, reason: "Paid the balance", correctionType: "CASH_REFUND", paymentMethod: "CASH",
    });
    const rows = (await listAll(d)).page.filter((r) => r.category === "VEHICLE_PURCHASE");
    expect(rows.map((r) => [r.type, r.amount]).sort()).toEqual([["OUT", 12500], ["OUT", 500]]);
    const pnl = await d.asOwner.query(api.reports.getProfitAndLoss, { orgId: d.orgId, ...ALL_TIME });
    expect(pnl.costOfGoodsSold).toBe(13000);
  });

  test("batch 3 C1: a refund on a PAID on-account car posts the GL but no cashbook row, and P&L cost is never negative", async () => {
    const d = await seedDealer("b3c1");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const payable = await payableOf(d.t, vehicleId);
    await d.asOwner.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, payableId: payable!._id, paymentMethod: "BANK_TRANSFER",
    });
    const rowsBefore = (await listAll(d)).page;
    const inventoryBefore = await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY");
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Supplier refunded", correctionType: "CASH_REFUND", paymentMethod: "BANK_TRANSFER",
    });
    // GL posted in full, vehicle cost moved.
    expect(await balanceMinor(d.t, d.orgId, "VEHICLE_INVENTORY")).toBe(inventoryBefore - 2700 * 1000);
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(9800);
    // The cashbook never projected this car's acquisition or its payment, so it gains no row now.
    const rowsAfter = (await listAll(d)).page;
    expect(rowsAfter.map((r) => r._id).sort()).toEqual(rowsBefore.map((r) => r._id).sort());
    expect(rowsAfter.filter((r) => r.category === "VEHICLE_PURCHASE" && r.type === "IN")).toHaveLength(0);
    const pnl = await d.asOwner.query(api.reports.getProfitAndLoss, { orgId: d.orgId, ...ALL_TIME });
    expect(pnl.costOfGoodsSold).toBeGreaterThanOrEqual(0);
  });

  test("batch 3 C2: the cashbook description carries the method, vehicle and VIN but neither cost amount", async () => {
    const d = await seedDealer("b3c2");
    const vehicleId = await createCashVehicle(d, 12500, "CASH");
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "Supplier refunded", correctionType: "CASH_REFUND", paymentMethod: "CASH",
    });
    const refund = (await listAll(d)).page.find((r) => r.category === "VEHICLE_PURCHASE" && r.type === "IN");
    expect(refund?.description).toMatch(/^Purchase cost correction \(CASH\) for vehicle 2020 Honda Accord \(VIN: 1HGCM82633A000001\)$/);
    expect(refund?.description).not.toContain("12500");
    expect(refund?.description).not.toContain("9800");
  });

  test("AP and restatement corrections add no cashbook row", async () => {
    const d = await seedDealer("b4c");
    const onAccountId = await createOnAccountVehicle(d, 12500);
    const cashId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, vin: "1HGCM82633A000009",
      purchasePrice: 8000, purchasePaymentMethod: "CASH",
    });
    await bookAcquisitionInClosedPeriod(d, cashId);
    const countRows = async () => (await d.t.run((ctx) => ctx.db.query("transactions").collect())).length;
    const before = await countRows();
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId: onAccountId, newCost: 9800, reason: "invoice", correctionType: "SUPPLIER_INVOICE_ERROR",
    });
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId: cashId, newCost: 7000, ...RESTATE,
    });
    expect(await countRows()).toBe(before);
  });
});

describe("SCRUM-650 batch 2 A6: equal-value submits on a posted car", () => {
  test("an unrelated edit that echoes the stored price still saves, but a sourceCost key is refused (why the dialog strips both)", async () => {
    const d = await seedDealer("b6");
    const vehicleId = await createCashVehicle(d);
    await d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, color: "Red", purchasePrice: 12500 });
    const after = await d.t.run((ctx) => ctx.db.get(vehicleId));
    expect(after?.color).toBe("Red");
    expect(after?.purchasePrice).toBe(12500);

    // A changed price on a posted car is refused by the cost lock.
    const locked = await refusalOf(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, color: "Blue", purchasePrice: 13000 })
    );
    expect(locked?.code).toBe("VEHICLE_COST_POSTED");
    // SCRUM-717: a sourceCost key on an owned car is refused earlier still, by the
    // ownership-shape guard (an owned car never carries a supplier cost).
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, color: "Blue", sourceCost: 0 })
    );
    expect(data?.code).toBe("VEHICLE_STOCK_CARRIES_SOURCING");
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.color).toBe("Red");
  });

  test("getPurchaseCostLockState is true once the acquisition posted, false before, and needs no cost permission", async () => {
    const d = await seedDealer("b6q");
    const postedId = await createCashVehicle(d);
    const unpostedId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, vin: "1HGCM82633A000010",
    });
    expect(await d.asOwner.query(api.vehicles.getPurchaseCostLockState, { orgId: d.orgId, vehicleId: postedId })).toEqual({ locked: true });
    expect(await d.asOwner.query(api.vehicles.getPurchaseCostLockState, { orgId: d.orgId, vehicleId: unpostedId })).toEqual({ locked: false });
  });
});

describe("SCRUM-650 batch 2 A7: a failed acquisition post is reported as POST_FAILED", () => {
  test("a FAILED outbox row gives blockedReason POST_FAILED, not NOT_POSTED", async () => {
    const d = await seedDealer("b7");
    await d.t.run((ctx) => ctx.db.patch(d.periodId, { status: "CLOSED" }));
    const vehicleId = await createCashVehicle(d);
    const queued = await d.t.run((ctx) =>
      ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", (q) => q.eq("orgId", d.orgId).eq("idempotencyKey", `vehicle_acquired_${vehicleId}`)).first()
    );
    await d.t.run((ctx) => ctx.db.patch(queued!._id, { status: "FAILED" }));
    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context).toMatchObject({ blockedReason: "POST_FAILED", allowedTypes: [] });
  });
});

describe("SCRUM-650 batch 2 A9/A10: audit fields and the legacy method guard", () => {
  test("A9: an ON_ACCOUNT correction records the payable and its previous amountDue", async () => {
    const d = await seedDealer("b9");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const payable = await payableOf(d.t, vehicleId);
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "invoice", correctionType: "SUPPLIER_INVOICE_ERROR",
    });
    const row = await d.t.run((ctx) => ctx.db.query("vehicleCostCorrections").first());
    expect(row).toMatchObject({ payableId: payable!._id, previousAmountDue: 12500 });
  });

  test("A10: a legacy event with no payment method plus an acquisition payable is treated as ON_ACCOUNT", async () => {
    const d = await seedDealer("b10");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const event = await d.t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org_source", (q) => q.eq("orgId", d.orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString())).first()
    );
    const { paymentMethod: _gone, ...legacyPayload } = event!.payload as Record<string, unknown>;
    await d.t.run((ctx) => ctx.db.patch(event!._id, { payload: legacyPayload }));
    const before = await snapshot(d.t, d.orgId, vehicleId);

    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "CASH_REFUND", paymentMethod: "CASH",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_TYPE_NOT_ALLOWED");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);

    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.originalPaymentMethod).toBe("ON_ACCOUNT");
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 9800, reason: "invoice", correctionType: "SUPPLIER_INVOICE_ERROR",
    });
    expect((await payableOf(d.t, vehicleId))?.amountDue).toBe(9800);
  });
});

describe("SCRUM-650 batch 2 extras", () => {
  test("two acquisition payables refuse AP types: the row to adjust is ambiguous", async () => {
    const d = await seedDealer("bx1");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    const first = await payableOf(d.t, vehicleId);
    await d.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = first!;
      await ctx.db.insert("vehicleSupplierPayables", copy);
    });
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost: 9800, reason: "wrong", correctionType: "SUPPLIER_INVOICE_ERROR",
      })
    );
    expect(data?.code).toBe("COST_CORRECTION_PAYABLE_NOT_ADJUSTABLE");
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
  });

  test("VENDOR_CREDIT upward raises the payable and AP together", async () => {
    const d = await seedDealer("bx2");
    const vehicleId = await createOnAccountVehicle(d, 12500);
    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId, newCost: 13000, reason: "credit note reversed", correctionType: "VENDOR_CREDIT",
    });
    expect((await payableOf(d.t, vehicleId))?.amountDue).toBe(13000);
    expect(await balanceMinor(d.t, d.orgId, "ACCOUNTS_PAYABLE_SUPPLIERS")).toBe(-13_000_000);
  });
});

describe("SCRUM-725: a prior-period restatement only for a purchase in a closed period", () => {
  test("an OPEN-period purchase: the type is not offered and the server refuses it with its own code, writing nothing", async () => {
    const d = await seedDealer("r725a");
    const vehicleId = await createCashVehicle(d);
    const before = await snapshot(d.t, d.orgId, vehicleId);
    const journalsBefore = (await d.t.run((ctx) => ctx.db.query("journalEntries").collect())).length;

    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.allowedTypes).not.toContain("PRIOR_PERIOD_RESTATEMENT");

    // A client that sends it anyway is refused, with the specific code (not TYPE_NOT_ALLOWED).
    const data = await refusalOf(
      d.asOwner.mutation(api.vehicles.correctAcquisitionCost, { orgId: d.orgId, vehicleId, newCost: 9800, ...RESTATE })
    );
    expect(data?.code).toBe("COST_CORRECTION_RESTATEMENT_PERIOD_OPEN");
    expect(data?.message).toMatch(/closed accounting period/);
    expect(await snapshot(d.t, d.orgId, vehicleId)).toEqual(before);
    expect((await d.t.run((ctx) => ctx.db.query("journalEntries").collect())).length).toBe(journalsBefore);
  });

  test("a CLOSED-period purchase: the type is offered and accepted, posting one retained-earnings correction", async () => {
    const d = await seedDealer("r725b");
    const vehicleId = await createCashVehicle(d);
    await bookAcquisitionInClosedPeriod(d, vehicleId);

    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.allowedTypes).toContain("PRIOR_PERIOD_RESTATEMENT");

    await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, { orgId: d.orgId, vehicleId, newCost: 9800, ...RESTATE });
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(9800);
    const entries = await d.t.run((ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).collect()
    );
    expect(entries.filter((e) => e.sourceType === "vehicleCostCorrections")).toHaveLength(1);
  });

  test("a LOCKED period counts as closed", async () => {
    const d = await seedDealer("r725c");
    const vehicleId = await createCashVehicle(d);
    await bookAcquisitionInClosedPeriod(d, vehicleId);
    await d.t.run(async (ctx) => {
      const period = await ctx.db
        .query("accountingPeriods")
        .withIndex("by_org_startDate", (q) => q.eq("orgId", d.orgId).eq("startDate", Date.UTC(2019, 0, 1)))
        .first();
      await ctx.db.patch(period!._id, { status: "LOCKED" });
    });
    const context = await d.asOwner.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: d.orgId, vehicleId });
    expect(context.allowedTypes).toContain("PRIOR_PERIOD_RESTATEMENT");
  });
});

describe("SCRUM-650 batch 2 A12: the counter-account mirror matches what the ledger posts", () => {
  type Case = { original: "CASH" | "BANK_TRANSFER" | "ON_ACCOUNT" | "PAID_ON_ACCOUNT"; type: "CASH_REFUND" | "SUPPLIER_INVOICE_ERROR" | "VENDOR_CREDIT" | "PRIOR_PERIOD_RESTATEMENT"; method?: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD" };
  const cases: Case[] = [];
  for (const original of ["CASH", "BANK_TRANSFER"] as const) {
    for (const method of ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"] as const) cases.push({ original, type: "CASH_REFUND", method });
    cases.push({ original, type: "PRIOR_PERIOD_RESTATEMENT" });
  }
  cases.push({ original: "ON_ACCOUNT", type: "SUPPLIER_INVOICE_ERROR" }, { original: "ON_ACCOUNT", type: "VENDOR_CREDIT" }, { original: "ON_ACCOUNT", type: "PRIOR_PERIOD_RESTATEMENT" });
  for (const method of ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"] as const) cases.push({ original: "PAID_ON_ACCOUNT", type: "CASH_REFUND", method });

  test.each(cases)("%j posts its counter line to the predicted account", async (c) => {
    const d = await seedDealer(`a12_${c.original}_${c.type}_${c.method ?? "x"}`);
    let vehicleId: Id<"vehicles">;
    if (c.original === "CASH" || c.original === "BANK_TRANSFER") vehicleId = await createCashVehicle(d, 12500, c.original);
    else {
      vehicleId = await createOnAccountVehicle(d, 12500);
      if (c.original === "PAID_ON_ACCOUNT") {
        const payable = await payableOf(d.t, vehicleId);
        await d.asOwner.mutation(api.sourcingPayables.markPaid, {
          idempotencyKey: crypto.randomUUID(), orgId: d.orgId, payableId: payable!._id, paymentMethod: "BANK_TRANSFER",
        });
      }
    }
    // SCRUM-725: the restatement is only accepted for a purchase in a closed period.
    if (c.type === "PRIOR_PERIOD_RESTATEMENT") await bookAcquisitionInClosedPeriod(d, vehicleId);
    // Both directions: down, then up.
    for (const newCost of [9800, 11000]) {
      await d.asOwner.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: d.orgId, vehicleId, newCost, reason: "parity", correctionType: c.type,
        ...(c.method ? { paymentMethod: c.method } : {}),
      });
    }
    const predicted = costCorrectionCounterKey(c.type, c.method);
    const entries = await d.t.run((ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).collect()
    );
    const corrections = entries.filter((e) => e.sourceType === "vehicleCostCorrections");
    expect(corrections).toHaveLength(2);
    for (const entry of corrections) {
      const lines = await d.t.run((ctx) =>
        ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect()
      );
      const keys = await Promise.all(lines.map(async (l) => (await d.t.run((ctx) => ctx.db.get(l.accountId)))?.systemKey));
      expect(keys.sort()).toEqual(["VEHICLE_INVENTORY", predicted].sort());
    }
  });
});