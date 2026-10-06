/**
 * SCRUM-717 (D-45): intake ownership and source-shape authority.
 *
 * Invariant under test: a new vehicle carries an EXPLICIT ownership decision.
 *   - Consignment (SOURCED): supplier name + positive sourceCost, and NOTHING is
 *     posted at intake (no journal, no cashbook row, no payable).
 *   - Owned (STOCK): purchasePrice + a deliberate settlement. ON_ACCOUNT names its
 *     creditor in `purchaseSupplierName` (never `sourcedFromName`), and a STOCK row
 *     never gains sourcedFromName / sourceCost.
 *   - Every ownership change goes through an authorized, audited door.
 *
 * Every refusal below also asserts that NOTHING was written — a refusal that is
 * caught and returned after a write would still commit (a caught Convex error does
 * not roll back), so "rejected" alone proves too little.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { VEHICLE_SOURCE_SHAPE_MESSAGES } from "./utils/vehicleSourceShape";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

const OWNER_PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "view:vehicles", "view:cost_price",
  "create:expenses", "view:expenses", "view:finance", "manage:finance", "view:reports",
  "approve:requests",
];
// Can edit and create vehicles but holds NO finance authority.
const CLERK_PERMISSIONS = ["create:vehicles", "edit:vehicles", "view:vehicles"];

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
};

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Ownership Dealer ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${suffix}`, email: `${suffix}@example.com`, name: "Owner" })
  );
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: OWNER_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole }));
  const clerkId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `clerk_${suffix}`, email: `clerk-${suffix}@example.com`, name: "Clerk" })
  );
  const clerkRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Clerk", permissions: CLERK_PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: clerkId, roleId: clerkRole }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const asOwner = t.withIdentity({ subject: `owner_${suffix}`, clerkId: `owner_${suffix}` });
  const asClerk = t.withIdentity({ subject: `clerk_${suffix}`, clerkId: `clerk_${suffix}` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
    fiscalYear: 2025, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { t, orgId, ownerId, asOwner, asClerk };
}
type Dealer = Awaited<ReturnType<typeof seedDealer>>;

/**
 * Everything a refused ownership write must leave untouched. Each test builds its
 * own single-organization world, so a whole-table count is the org's count.
 */
async function worldCounts(d: Dealer) {
  return d.t.run(async (ctx) => ({
    vehicles: (await ctx.db.query("vehicles").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    pending: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").collect()).length,
    transactions: (await ctx.db.query("transactions").collect()).length,
    conversions: (await ctx.db.query("vehicleOwnershipConversions").collect()).length,
    edits: (await ctx.db.query("vehicleEdits").collect()).length,
  }));
}

const code = (c: keyof typeof VEHICLE_SOURCE_SHAPE_MESSAGES) => [c, VEHICLE_SOURCE_SHAPE_MESSAGES[c]] as const;

async function acquisitionEvents(d: Dealer, vehicleId: Id<"vehicles">) {
  return d.t.run(async (ctx) =>
    (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", d.orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .collect()
    ).filter((e) => e.eventType === "VEHICLE_ACQUIRED")
  );
}

async function payablesOf(d: Dealer, vehicleId: Id<"vehicles">) {
  return d.t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).collect()
  );
}

const sourcedFields = { sourceType: "SOURCED" as const, sourcedFromName: "Gulf Motors", sourceCost: 9000 };

describe("vehicles.create — an explicit ownership decision", () => {
  test("a blank source type is refused and writes nothing", async () => {
    const d = await seedDealer("c1");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, { idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle }),
      ...code("VEHICLE_SOURCE_TYPE_REQUIRED")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("an owned car cannot carry a consignment supplier or cost", async () => {
    const d = await seedDealer("c2");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
        sourcedFromName: "Gulf Motors", purchasePrice: 10000, purchasePaymentMethod: "CASH",
      }),
      ...code("VEHICLE_STOCK_CARRIES_SOURCING")
    );
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK", sourceCost: 5000,
      }),
      ...code("VEHICLE_STOCK_CARRIES_SOURCING")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("a consignment car needs a supplier name and a cost greater than zero", async () => {
    const d = await seedDealer("c3");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "SOURCED", sourceCost: 9000,
      }),
      ...code("VEHICLE_SOURCED_SUPPLIER_REQUIRED")
    );
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "SOURCED", sourcedFromName: "Gulf Motors",
      }),
      ...code("VEHICLE_SOURCED_COST_INVALID")
    );
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 0,
      }),
      ...code("VEHICLE_SOURCED_COST_INVALID")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("consignment posts no journal, no cashbook row and no payable", async () => {
    const d = await seedDealer("c4");
    const before = await worldCounts(d);
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    const after = await worldCounts(d);
    expect(after.vehicles).toBe(before.vehicles + 1);
    expect({ ...after, vehicles: 0, edits: 0 }).toEqual({ ...before, vehicles: 0, edits: 0 });
    expect(await acquisitionEvents(d, vehicleId)).toHaveLength(0);
    expect(await payablesOf(d, vehicleId)).toHaveLength(0);
  });

  test("owned ON_ACCOUNT names the creditor in purchaseSupplierName: one AP journal, payable carries the name, the vehicle row has no consignment fields", async () => {
    const d = await seedDealer("c5");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
      purchasePrice: 10000, purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierName: "Credit Supplier Co",
    });
    expect(await acquisitionEvents(d, vehicleId)).toHaveLength(1);
    const payables = await payablesOf(d, vehicleId);
    expect(payables).toHaveLength(1);
    expect(payables[0].sourcedFromName).toBe("Credit Supplier Co");
    expect(payables[0].amountDue).toBe(10000);
    const row = await d.t.run((ctx) => ctx.db.get(vehicleId));
    expect(row?.sourceType).toBe("STOCK");
    expect(row?.sourcedFromName).toBeUndefined();
    expect(row?.sourceCost).toBeUndefined();
  });

  test("owned ON_ACCOUNT without purchaseSupplierName is refused and writes nothing", async () => {
    const d = await seedDealer("c6");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
        purchasePrice: 10000, purchasePaymentMethod: "ON_ACCOUNT",
      }),
      ...code("VEHICLE_PURCHASE_SUPPLIER_REQUIRED")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("retry: creating twice with the same idempotency key yields one vehicle and one acquisition journal", async () => {
    const d = await seedDealer("c7");
    const args = {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK" as const,
      purchasePrice: 10000, purchasePaymentMethod: "CASH" as const,
    };
    const first = await d.asOwner.mutation(api.vehicles.create, args);
    const second = await d.asOwner.mutation(api.vehicles.create, args);
    expect(second).toBe(first);
    expect(await acquisitionEvents(d, first)).toHaveLength(1);
    expect((await worldCounts(d)).vehicles).toBe(1);
  });
});

describe("vehicles.createSourced", () => {
  test("refuses a missing supplier or a non-positive cost with the shared coded errors, writing nothing", async () => {
    const d = await seedDealer("s1");
    const before = await worldCounts(d);
    // createSourced has a narrower arg set than create (no status).
    const { status: _status, ...sourcedBase } = baseVehicle;
    const row = { orgId: d.orgId, ...sourcedBase };
    await expectAppError(
      d.asOwner.mutation(api.vehicles.createSourced, { ...row, sourcedFromName: "  ", sourceCost: 9000 }),
      ...code("VEHICLE_SOURCED_SUPPLIER_REQUIRED")
    );
    await expectAppError(
      d.asOwner.mutation(api.vehicles.createSourced, { ...row, sourcedFromName: "Gulf Motors", sourceCost: 0 }),
      ...code("VEHICLE_SOURCED_COST_INVALID")
    );
    expect(await worldCounts(d)).toEqual(before);
  });
});

describe("vehicleEdits.requestCreate -> approve", () => {
  test("a blank source type is refused at request time and queues nothing", async () => {
    const d = await seedDealer("r1");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.requestCreate, { orgId: d.orgId, payload: { ...baseVehicle } }),
      ...code("VEHICLE_SOURCE_TYPE_REQUIRED")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("an owned request with a consignment supplier is refused at request time", async () => {
    const d = await seedDealer("r2");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.requestCreate, {
        orgId: d.orgId,
        payload: { ...baseVehicle, sourceType: "STOCK", sourcedFromName: "Gulf Motors", purchasePrice: 5000, purchasePaymentMethod: "CASH" },
      }),
      ...code("VEHICLE_STOCK_CARRIES_SOURCING")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("owned ON_ACCOUNT approval uses purchaseSupplierName and never stamps the vehicle with a supplier; approving twice posts once", async () => {
    const d = await seedDealer("r3");
    const requestId = await d.asOwner.mutation(api.vehicleEdits.requestCreate, {
      orgId: d.orgId,
      payload: {
        ...baseVehicle, sourceType: "STOCK", purchasePrice: 7000,
        purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierName: "Approval Flow Supplier",
      },
    });
    await d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" });
    // A second approval is refused and must not post a second journal.
    await expect(
      d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" })
    ).rejects.toThrow(/already resolved/i);

    const vehicle = await d.t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", d.orgId).eq("vin", baseVehicle.vin)).unique()
    );
    expect(vehicle?.sourcedFromName).toBeUndefined();
    expect(vehicle?.sourceCost).toBeUndefined();
    expect(await acquisitionEvents(d, vehicle!._id)).toHaveLength(1);
    const payables = await payablesOf(d, vehicle!._id);
    expect(payables).toHaveLength(1);
    expect(payables[0].sourcedFromName).toBe("Approval Flow Supplier");
  });

  test("approving a request with no ownership decision (WhatsApp shape) is refused until the approver classifies it", async () => {
    const d = await seedDealer("r4");
    // The WhatsApp intake inserts this exact shape: no sourceType at all.
    const requestId = await d.t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId: d.orgId, requestedBy: d.ownerId, type: "CREATE", status: "PENDING", createdAt: Date.now(),
        payload: { ...baseVehicle, color: "Not specified" },
      })
    );
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" }),
      ...code("VEHICLE_SOURCE_TYPE_REQUIRED")
    );
    expect(await worldCounts(d)).toEqual(before);
    expect((await d.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");

    // A decision that contradicts itself is refused too.
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.resolve, {
        orgId: d.orgId, requestId, status: "APPROVED",
        ownership: { sourceType: "STOCK", sourceCost: 5000 },
      }),
      ...code("VEHICLE_STOCK_CARRIES_SOURCING")
    );
    expect(await worldCounts(d)).toEqual(before);

    // The approver classifies it as consignment: no accounting at intake.
    await d.asOwner.mutation(api.vehicleEdits.resolve, {
      orgId: d.orgId, requestId, status: "APPROVED",
      ownership: { sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 },
    });
    const vehicle = await d.t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", d.orgId).eq("vin", baseVehicle.vin)).unique()
    );
    expect(vehicle).toMatchObject({ sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 });
    expect(await acquisitionEvents(d, vehicle!._id)).toHaveLength(0);
    expect(await payablesOf(d, vehicle!._id)).toHaveLength(0);
  });

  test("the ownership decision is refused on an UPDATE request", async () => {
    const d = await seedDealer("r5");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    const requestId = await d.asOwner.mutation(api.vehicleEdits.requestUpdate, {
      orgId: d.orgId, vehicleId, payload: { color: "Red" },
    });
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.resolve, {
        orgId: d.orgId, requestId, status: "APPROVED", ownership: { sourceType: "SOURCED", sourcedFromName: "X", sourceCost: 1 },
      }),
      ...code("VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE")
    );
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.color).toBe("White");
  });
});

describe("ownership flips", () => {
  test("requestUpdate refuses ANY sourceType change, both directions, and queues nothing", async () => {
    const d = await seedDealer("f1");
    const stockId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    const sourcedId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, vin: "1HGCM82633A000002", ...sourcedFields,
    });
    const before = await worldCounts(d);
    await expectAppError(
      d.asClerk.mutation(api.vehicleEdits.requestUpdate, { orgId: d.orgId, vehicleId: stockId, payload: { sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 } }),
      ...code("VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE")
    );
    await expectAppError(
      d.asClerk.mutation(api.vehicleEdits.requestUpdate, { orgId: d.orgId, vehicleId: sourcedId, payload: { sourceType: "STOCK", purchasePrice: 9000, purchasePaymentMethod: "CASH" } }),
      ...code("VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("a forged UPDATE request that carries a sourceType change is refused at approval, with nothing applied", async () => {
    const d = await seedDealer("f1b");
    const sourcedId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    const requestId = await d.t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId: d.orgId, vehicleId: sourcedId, requestedBy: d.ownerId, type: "UPDATE", status: "PENDING", createdAt: Date.now(),
        payload: { sourceType: "STOCK", purchasePrice: 9000, purchasePaymentMethod: "CASH" },
      })
    );
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" }),
      ...code("VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE")
    );
    expect(await worldCounts(d)).toEqual(before);
    expect((await d.t.run((ctx) => ctx.db.get(sourcedId)))?.sourceType).toBe("SOURCED");
  });

  test("STOCK -> SOURCED is refused once the acquisition is POSTED; no journal or cashbook change", async () => {
    const d = await seedDealer("f2");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
      purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
    expect(await acquisitionEvents(d, vehicleId)).toHaveLength(1);
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, {
        orgId: d.orgId, vehicleId, sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000,
      }),
      ...code("VEHICLE_OWNERSHIP_FLIP_POSTED")
    );
    expect(await worldCounts(d)).toEqual(before);
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.sourceType).toBe("STOCK");
  });

  test("STOCK -> SOURCED is refused when the acquisition is QUEUED (pendingAccountingEvents), nothing written", async () => {
    const d = await seedDealer("f3");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    await d.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: d.orgId, kind: "POST", status: "PENDING", idempotencyKey: `vehicle_acquired_${vehicleId}`,
        accountingDate: Date.now(), actorId: d.ownerId, attempts: 0, createdAt: Date.now(),
        sourceType: "vehicles", sourceId: String(vehicleId), eventType: "VEHICLE_ACQUIRED",
      })
    );
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, {
        orgId: d.orgId, vehicleId, sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000,
      }),
      ...code("VEHICLE_OWNERSHIP_FLIP_POSTED")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("direct SOURCED -> STOCK without MANAGE_FINANCE is refused and writes nothing", async () => {
    const d = await seedDealer("f4");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    const before = await worldCounts(d);
    await expect(
      d.asClerk.mutation(api.vehicles.update, {
        orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8000, purchasePaymentMethod: "CASH",
      })
    ).rejects.toThrow(/Forbidden|permission/i);
    expect(await worldCounts(d)).toEqual(before);
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.sourceType).toBe("SOURCED");
  });

  test("SOURCED -> STOCK without the explicit buy-out terms is refused (price > 0 AND a method)", async () => {
    const d = await seedDealer("f5");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    const before = await worldCounts(d);
    for (const terms of [
      {},
      { purchasePaymentMethod: "CASH" as const },
      { purchasePrice: 8000 },
      { purchasePrice: 0, purchasePaymentMethod: "CASH" as const },
      { purchasePrice: 8000, purchasePaymentMethod: "ON_ACCOUNT" as const },
    ]) {
      await expectAppError(
        d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, sourceType: "STOCK", ...terms }),
        ...code("VEHICLE_BUYOUT_TERMS_REQUIRED")
      );
    }
    expect(await worldCounts(d)).toEqual(before);
  });

  test("an authorized buy-out writes the conversion audit row with the explicit terms and exactly one acquisition journal for the explicit amount", async () => {
    const d = await seedDealer("f6");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    // The agreed buy-out differs from the consignment cost on purpose.
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200, purchasePaymentMethod: "BANK_TRANSFER",
    });
    const events = await acquisitionEvents(d, vehicleId);
    expect(events).toHaveLength(1);
    const lines = await d.t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", events[0].journalEntryId!)).collect()
    );
    expect(lines.reduce((sum, l) => sum + l.debitMinor, 0)).toBe(8_200_000);

    const conversions = await d.t.run((ctx) =>
      ctx.db.query("vehicleOwnershipConversions").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).collect()
    );
    expect(conversions).toHaveLength(1);
    expect(conversions[0]).toMatchObject({
      fromSourceType: "SOURCED", toSourceType: "STOCK", purchaseAmount: 8200, paymentMethod: "BANK_TRANSFER",
      supplierName: "Gulf Motors", supplierEntitlementAtConversion: 9000, convertedBy: d.ownerId,
    });
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.sourceType).toBe("STOCK");
  });

  test("an authorized buy-out ON_ACCOUNT opens the payable under purchaseSupplierName", async () => {
    const d = await seedDealer("f7");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200,
      purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierName: "Credit Supplier Co",
    });
    const payables = await payablesOf(d, vehicleId);
    expect(payables).toHaveLength(1);
    expect(payables[0].sourcedFromName).toBe("Credit Supplier Co");
    expect(payables[0].amountDue).toBe(8200);
    expect(await acquisitionEvents(d, vehicleId)).toHaveLength(1);
  });
});

describe("a legacy Neta-shape row (STOCK carrying supplier fields)", () => {
  async function netaVehicle(d: Dealer) {
    return d.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: d.orgId, ...baseVehicle, sourceType: "STOCK", sourcedFromName: "Legacy Supplier", sourceCost: 4000,
        addedBy: d.ownerId, updatedBy: d.ownerId, updatedAt: Date.now(),
      })
    );
  }

  test("an unrelated metadata edit still succeeds, directly and through a request", async () => {
    const d = await seedDealer("n1");
    const vehicleId = await netaVehicle(d);
    await d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, color: "Blue", notes: "serviced" });
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.color).toBe("Blue");

    const requestId = await d.asClerk.mutation(api.vehicleEdits.requestUpdate, {
      orgId: d.orgId, vehicleId, payload: { color: "Green" },
    });
    await d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" });
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.color).toBe("Green");
  });

  test("echoing the stored supplier and cost back is not a change", async () => {
    const d = await seedDealer("n2");
    const vehicleId = await netaVehicle(d);
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId, color: "Blue", sourceType: "STOCK", sourcedFromName: "Legacy Supplier", sourceCost: 4000,
    });
    expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.color).toBe("Blue");
  });

  test("changing the supplier or cost on an owned car is refused", async () => {
    const d = await seedDealer("n3");
    const vehicleId = await netaVehicle(d);
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, sourcedFromName: "Someone Else" }),
      ...code("VEHICLE_STOCK_CARRIES_SOURCING")
    );
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, sourceCost: 4500 }),
      ...code("VEHICLE_STOCK_CARRIES_SOURCING")
    );
    expect(await worldCounts(d)).toEqual(before);
  });
});

describe("vehicles.importBulk", () => {
  const importRow = {
    make: "Kia", model: "Sportage", year: 2023, color: "Silver", fuelType: "Petrol",
    transmission: "Automatic", sellingPrice: 15000,
  };

  test("a blank source type fails the whole file and writes nothing", async () => {
    const d = await seedDealer("i1");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.importBulk, {
        orgId: d.orgId, acquisitionPosting: "OPENING_STOCK",
        vehicles: [
          { ...importRow, vin: "IMPORTGOOD0000001", sourceType: "STOCK" },
          { ...importRow, vin: "IMPORTBLANK000002" },
        ],
      }),
      ...code("VEHICLE_SOURCE_TYPE_REQUIRED")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("an unrecognised source type is refused, not defaulted", async () => {
    const d = await seedDealer("i2");
    await expectAppError(
      d.asOwner.mutation(api.vehicles.importBulk, {
        orgId: d.orgId, acquisitionPosting: "OPENING_STOCK",
        vehicles: [{ ...importRow, vin: "IMPORTODD00000001", sourceType: "CONSIGNED" }],
      }),
      ...code("VEHICLE_SOURCE_TYPE_REQUIRED")
    );
  });

  test("an owned row carrying a consignment supplier is refused (STOCK + supplier)", async () => {
    const d = await seedDealer("i3");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.importBulk, {
        orgId: d.orgId, acquisitionPosting: "OPENING_STOCK",
        vehicles: [{ ...importRow, vin: "IMPORTSTK0000001", sourceType: "STOCK", sourcedFromName: "Gulf Motors", purchasePrice: 9000 }],
      }),
      ...code("VEHICLE_STOCK_CARRIES_SOURCING")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("PURCHASE ON_ACCOUNT takes the creditor from purchaseSupplierName and the vehicle row never carries it", async () => {
    const d = await seedDealer("i4");
    await d.asOwner.mutation(api.vehicles.importBulk, {
      orgId: d.orgId, acquisitionPosting: "PURCHASE", importId: "imp-717", purchasePaymentMethod: "ON_ACCOUNT",
      vehicles: [{ rowId: 1, ...importRow, vin: "IMPORTONACC000001", sourceType: "STOCK", purchasePrice: 10000, purchaseSupplierName: "Gulf Motors" }],
    });
    const vehicle = await d.t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", d.orgId).eq("vin", "IMPORTONACC000001")).unique()
    );
    expect(vehicle?.sourcedFromName).toBeUndefined();
    const payables = await payablesOf(d, vehicle!._id);
    expect(payables).toHaveLength(1);
    expect(payables[0].sourcedFromName).toBe("Gulf Motors");
  });
});

describe("the data browser (adminData.adminUpdateRecord)", () => {
  async function withAdmin<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
    process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.SUPER_ADMIN_EMAILS;
      else process.env.SUPER_ADMIN_EMAILS = previous;
    }
  }

  test("a CHANGE to an ownership field is refused; unchanged round-tripped values and other fields still save", async () => {
    await withAdmin(async () => {
      const d = await seedDealer("a1");
      await d.t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_717", email: "admin@autoflow.dev" }));
      const asAdmin = d.t.withIdentity({ subject: "dev_717" });
      const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
      });

      const lockedPatches: Array<Record<string, unknown>> = [
        { sourceType: "STOCK" },
        { sourcedFromName: "Someone Else" },
        { sourceCost: 1 },
        { purchasePrice: 1 },
        { purchasePaymentMethod: "CASH" },
      ];
      for (const patch of lockedPatches) {
        await expectAppError(
          asAdmin.mutation(api.adminData.adminUpdateRecord, { table: "vehicles", id: vehicleId, patch }),
          ...code("VEHICLE_OWNERSHIP_FIELDS_LOCKED")
        );
      }
      const row = await d.t.run((ctx) => ctx.db.get(vehicleId));
      expect(row).toMatchObject({ sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 });

      // The editor re-sends the whole record: unchanged values are not a change.
      await asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles", id: vehicleId,
        patch: { sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000, purchasePrice: row?.purchasePrice, color: "Green" },
      });
      expect((await d.t.run((ctx) => ctx.db.get(vehicleId)))?.color).toBe("Green");
    });
  });
});
