/**
 * SCRUM-717 remediation batch.
 *
 * Common invariant: a vehicle's ownership is a function of its posted or queued
 * accounting exposure and of explicit, recorded decisions. It is never derived from
 * form residue, stale row fields, or an unrecorded approver override.
 *
 * Every refusal asserts that NOTHING was written (a caught Convex error does not
 * roll back, so "rejected" alone proves too little).
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
const sourcedFields = { sourceType: "SOURCED" as const, sourcedFromName: "Gulf Motors", sourceCost: 9000 };

// English texts of the refusals added by this batch. The codes are what the client
// translates; the text equals the dictionary entry.
const MSG = {
  VEHICLE_OWNERSHIP_ALREADY_CLASSIFIED:
    "This request already states how the vehicle is held (consignment or owned), so the approver can't override it. Reject the request and ask for a corrected one.",
  VEHICLE_OWNERSHIP_FLIP_POSTED:
    "This vehicle's purchase has already been posted to accounting, so it can't be changed to consignment. To fix a mistaken entry, use 'Correct purchase cost' or ask your accountant for a reversal.",
  VEHICLE_OWNERSHIP_FLIP_LANDED_COSTS:
    "This vehicle carries landed costs that have been posted or queued to accounting as owned inventory, so it can't be changed to consignment. To fix a mistaken entry, ask your accountant for a reversal.",
  VEHICLE_BUYOUT_SOURCED_LANDED_COSTS:
    "This consignment vehicle has landed costs recorded against it. Remove them before buying the vehicle out, so the purchase is capitalized once at the agreed price.",
} as const;
const code = (c: keyof typeof MSG) => [c, MSG[c]] as const;

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Remediation Dealer ${suffix}`, createdAt: Date.now() })
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
  return { t, orgId, ownerId, asOwner };
}
type Dealer = Awaited<ReturnType<typeof seedDealer>>;

/** Everything a refused write must leave untouched (single-org world: whole-table counts). */
async function worldCounts(d: Dealer) {
  return d.t.run(async (ctx) => ({
    vehicles: (await ctx.db.query("vehicles").take(1000)).length,
    events: (await ctx.db.query("accountingEvents").take(1000)).length,
    journals: (await ctx.db.query("journalEntries").take(1000)).length,
    pending: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
    conversions: (await ctx.db.query("vehicleOwnershipConversions").take(1000)).length,
    edits: (await ctx.db.query("vehicleEdits").take(1000)).length,
    landedCosts: (await ctx.db.query("vehicleLandedCosts").take(1000)).length,
  }));
}

const getVehicle = (d: Dealer, id: Id<"vehicles">) => d.t.run((ctx) => ctx.db.get(id));

async function acquisitionEvents(d: Dealer, vehicleId: Id<"vehicles">) {
  return d.t.run(async (ctx) =>
    (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", d.orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId))
        .take(1000)
    ).filter((e) => e.eventType === "VEHICLE_ACQUIRED")
  );
}

async function landedCostEvents(d: Dealer) {
  return d.t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", d.orgId).eq("sourceType", "vehicleLandedCosts"))
      .take(1000)
  );
}

// ───────────────────────────── FIX 1 ─────────────────────────────

describe("vehicleEdits.resolve — approver ownership override", () => {
  async function requestWith(d: Dealer, payload: Record<string, unknown>) {
    return d.asOwner.mutation(api.vehicleEdits.requestCreate, {
      orgId: d.orgId,
      payload: { ...baseVehicle, ...payload } as never,
    });
  }

  test("a classified SOURCED request plus a STOCK override is refused; nothing is written", async () => {
    const d = await seedDealer("e1");
    const requestId = await requestWith(d, sourcedFields);
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.resolve, {
        orgId: d.orgId, requestId, status: "APPROVED",
        ownership: { sourceType: "STOCK", purchasePrice: 5000, purchasePaymentMethod: "CASH" },
      }),
      ...code("VEHICLE_OWNERSHIP_ALREADY_CLASSIFIED")
    );
    expect(await worldCounts(d)).toEqual(before);
    const request = await d.t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("PENDING");
    expect(request?.payload).toMatchObject(sourcedFields);
  });

  test("a classified STOCK/CASH request plus a SOURCED override is refused; nothing is written", async () => {
    const d = await seedDealer("e2");
    const requestId = await requestWith(d, { sourceType: "STOCK", purchasePrice: 7000, purchasePaymentMethod: "CASH" });
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.resolve, {
        orgId: d.orgId, requestId, status: "APPROVED",
        ownership: { sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 },
      }),
      ...code("VEHICLE_OWNERSHIP_ALREADY_CLASSIFIED")
    );
    expect(await worldCounts(d)).toEqual(before);
    expect((await d.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
  });

  test("control: an unclassified request plus ownership is applied and the stored payload states what was applied", async () => {
    const d = await seedDealer("e3");
    // WhatsApp shape: no sourceType, plus stale ownership residue.
    const requestId = await d.t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId: d.orgId, requestedBy: d.ownerId, type: "CREATE", status: "PENDING", createdAt: Date.now(),
        payload: { ...baseVehicle, sourcedFromName: "Stale Residue", purchasePrice: 3000 },
      })
    );
    await d.asOwner.mutation(api.vehicleEdits.resolve, {
      orgId: d.orgId, requestId, status: "APPROVED",
      ownership: { sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 },
    });
    const request = await d.t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("APPROVED");
    expect(request?.payload).toMatchObject(sourcedFields);
    expect(request?.payload.purchasePrice).toBeUndefined();
    expect(request?.payload.vin).toBe(baseVehicle.vin);
    const vehicle = await d.t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", d.orgId).eq("vin", baseVehicle.vin)).unique()
    );
    expect(vehicle).toMatchObject(sourcedFields);
  });

  test("control: a normal approval without an ownership override is unchanged", async () => {
    const d = await seedDealer("e4");
    const requestId = await requestWith(d, sourcedFields);
    await d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" });
    const vehicle = await d.t.run((ctx) =>
      ctx.db.query("vehicles").withIndex("by_org_vin", (q) => q.eq("orgId", d.orgId).eq("vin", baseVehicle.vin)).unique()
    );
    expect(vehicle).toMatchObject(sourcedFields);
    expect((await d.t.run((ctx) => ctx.db.get(requestId)))?.payload).toMatchObject(sourcedFields);
  });

  test("control: reject is unchanged and creates no vehicle", async () => {
    const d = await seedDealer("e5");
    const requestId = await requestWith(d, sourcedFields);
    await d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "REJECTED" });
    expect((await d.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("REJECTED");
    expect((await worldCounts(d)).vehicles).toBe(0);
  });
});

// ───────────────────────────── FIX 3 + 5 ─────────────────────────────

describe("SOURCED -> STOCK buy-out clears the consignment fields", () => {
  test("CASH buy-out: snapshot keeps the supplier/cost, the vehicle loses both, exactly one acquisition at the negotiated price", async () => {
    const d = await seedDealer("b1");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200, purchasePaymentMethod: "CASH",
    });
    const vehicle = await getVehicle(d, vehicleId);
    expect(vehicle?.sourceType).toBe("STOCK");
    expect(vehicle && "sourcedFromName" in vehicle).toBe(false);
    expect(vehicle && "sourceCost" in vehicle).toBe(false);
    const conversions = await d.t.run((ctx) => ctx.db.query("vehicleOwnershipConversions").take(1000));
    expect(conversions).toHaveLength(1);
    expect(conversions[0]).toMatchObject({ supplierName: "Gulf Motors", supplierEntitlementAtConversion: 9000, purchaseAmount: 8200 });
    const events = await acquisitionEvents(d, vehicleId);
    expect(events).toHaveLength(1);
    const lines = await d.t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", events[0].journalEntryId!)).take(1000)
    );
    expect(lines.reduce((s, l) => s + l.debitMinor, 0)).toBe(8_200_000);
  });

  test("ON_ACCOUNT buy-out: fields cleared, and the payable creditor is purchaseSupplierName", async () => {
    const d = await seedDealer("b2");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200,
      purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierName: "Credit Supplier Co",
    });
    const vehicle = await getVehicle(d, vehicleId);
    expect(vehicle && "sourcedFromName" in vehicle).toBe(false);
    expect(vehicle && "sourceCost" in vehicle).toBe(false);
    const payables = await d.t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).take(1000)
    );
    expect(payables).toHaveLength(1);
    expect(payables[0].sourcedFromName).toBe("Credit Supplier Co");
    expect(await acquisitionEvents(d, vehicleId)).toHaveLength(1);
    const conversions = await d.t.run((ctx) => ctx.db.query("vehicleOwnershipConversions").take(1000));
    expect(conversions[0]).toMatchObject({ supplierName: "Gulf Motors", supplierEntitlementAtConversion: 9000 });
  });

  test("the export of a bought-out car has an empty Sourced From and the purchase price as cost", async () => {
    const d = await seedDealer("b3");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200, purchasePaymentMethod: "CASH",
    });
    const exported = await d.asOwner.query(api.vehicles.exportData, { orgId: d.orgId });
    expect(exported.vehicles).toHaveLength(1);
    expect(exported.vehicles[0]).toMatchObject({ sourceType: "STOCK", sourcedFrom: "", cost: 8200 });
  });

  test("a legacy STOCK row with stale supplier fields: an unrelated edit succeeds and the export does not present the stale supplier", async () => {
    const d = await seedDealer("b4");
    const vehicleId = await d.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: d.orgId, ...baseVehicle, sourceType: "STOCK", sourcedFromName: "Legacy Supplier", sourceCost: 4000,
        addedBy: d.ownerId, updatedBy: d.ownerId, updatedAt: Date.now(),
      })
    );
    await d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, color: "Blue" });
    expect((await getVehicle(d, vehicleId))?.color).toBe("Blue");
    const exported = await d.asOwner.query(api.vehicles.exportData, { orgId: d.orgId });
    expect(exported.vehicles[0].sourcedFrom).toBe("");
    expect(exported.vehicles[0].cost).toBeNull();
  });

  test("export of a SOURCED car still shows the supplier and sourceCost", async () => {
    const d = await seedDealer("b5");
    await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    const exported = await d.asOwner.query(api.vehicles.exportData, { orgId: d.orgId });
    expect(exported.vehicles[0]).toMatchObject({ sourceType: "SOURCED", sourcedFrom: "Gulf Motors", cost: 9000 });
  });

  test("FIX 5: a whitespace-only sourcedFromName submitted on a STOCK car is not persisted", async () => {
    const d = await seedDealer("w1");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
      purchasePrice: 7000, purchasePaymentMethod: "CASH",
    });
    await d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, color: "Blue", sourcedFromName: "   " });
    const vehicle = await getVehicle(d, vehicleId);
    expect(vehicle?.color).toBe("Blue");
    expect(vehicle?.sourcedFromName).toBeUndefined();
    expect(vehicle && "sourcedFromName" in vehicle).toBe(false);
  });
});

// ───────────────────────────── FIX 4 ─────────────────────────────

describe("landed-cost inventory exposure", () => {
  async function ownedCar(d: Dealer) {
    return d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
      purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });
  }
  const flipToSourced = (d: Dealer, vehicleId: Id<"vehicles">) =>
    d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId, sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourceCost: 9000 });

  test("(a) an owned car with a POSTED landed cost cannot flip to SOURCED; nothing is written", async () => {
    const d = await seedDealer("l1");
    const vehicleId = await ownedCar(d);
    await d.asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId: d.orgId, vehicleId, items: [{ label: "Paint", amount: 600, paymentMethod: "CASH" }],
    });
    expect((await landedCostEvents(d)).length).toBeGreaterThan(0);
    // Remove the acquisition's own exposure signal so only the landed cost remains.
    const before = await worldCounts(d);
    await d.t.run(async (ctx) => {
      for (const e of await ctx.db.query("accountingEvents").take(1000)) {
        if (e.eventType === "VEHICLE_ACQUIRED") await ctx.db.patch(e._id, { sourceType: "vehiclesDetached" });
      }
    });
    await expectAppError(flipToSourced(d, vehicleId), ...code("VEHICLE_OWNERSHIP_FLIP_LANDED_COSTS"));
    expect(await worldCounts(d)).toEqual(before);
    expect((await getVehicle(d, vehicleId))?.sourceType).toBe("STOCK");
  });

  test("(a) a QUEUED landed cost (pendingAccountingEvents) also refuses the flip", async () => {
    const d = await seedDealer("l2");
    // Owned, no purchase price: no acquisition exposure at all.
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    await d.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: d.orgId, kind: "POST", status: "PENDING", idempotencyKey: `landed_cost_${vehicleId}_tok1`,
        accountingDate: Date.now(), actorId: d.ownerId, attempts: 0, createdAt: Date.now(),
        sourceType: "vehicleLandedCosts", sourceId: `${vehicleId}_tok1`, eventType: "VEHICLE_LANDED_COST_CAPITALIZED",
      })
    );
    const before = await worldCounts(d);
    await expectAppError(flipToSourced(d, vehicleId), ...code("VEHICLE_OWNERSHIP_FLIP_LANDED_COSTS"));
    expect(await worldCounts(d)).toEqual(before);
  });

  test("(a) landed costs edited back to total 0 after a posting still refuse the flip", async () => {
    const d = await seedDealer("l3");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    await d.asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId: d.orgId, vehicleId, items: [{ label: "Paint", amount: 600, paymentMethod: "CASH" }],
    });
    await d.asOwner.mutation(api.vehicles.upsertLandedCosts, { orgId: d.orgId, vehicleId, items: [] });
    expect((await getVehicle(d, vehicleId))?.landedCostTotal).toBe(0);
    const before = await worldCounts(d);
    await expectAppError(flipToSourced(d, vehicleId), ...code("VEHICLE_OWNERSHIP_FLIP_LANDED_COSTS"));
    expect(await worldCounts(d)).toEqual(before);
  });

  test("(a) another car's landed cost does not block this car's flip (prefix bound)", async () => {
    const d = await seedDealer("l4");
    const other = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, vin: "1HGCM82633A000009", sourceType: "STOCK",
    });
    await d.asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId: d.orgId, vehicleId: other, items: [{ label: "Paint", amount: 600, paymentMethod: "CASH" }],
    });
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    await flipToSourced(d, vehicleId);
    expect((await getVehicle(d, vehicleId))?.sourceType).toBe("SOURCED");
  });

  test("control: a flip on an owned car with no exposure still succeeds", async () => {
    const d = await seedDealer("l5");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    await flipToSourced(d, vehicleId);
    expect((await getVehicle(d, vehicleId))?.sourceType).toBe("SOURCED");
  });

  test("(b) a SOURCED car with landed-cost items cannot be bought out; nothing is written", async () => {
    const d = await seedDealer("l6");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    await d.asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId: d.orgId, vehicleId, items: [{ label: "Shipping", amount: 300 }],
    });
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, {
        orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200, purchasePaymentMethod: "CASH",
      }),
      ...code("VEHICLE_BUYOUT_SOURCED_LANDED_COSTS")
    );
    expect(await worldCounts(d)).toEqual(before);
    expect((await getVehicle(d, vehicleId))?.sourceType).toBe("SOURCED");
  });

  test("(b) offsetting landed-cost items (signed total zero) also refuse the buy-out", async () => {
    const d = await seedDealer("l7");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    await d.asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId: d.orgId, vehicleId, items: [{ label: "Shipping", amount: 300 }, { label: "Rebate", amount: -300 }],
    });
    const row = await d.t.run((ctx) => ctx.db.query("vehicleLandedCosts").first());
    expect(row?.total).toBe(0);
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, {
        orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200, purchasePaymentMethod: "CASH",
      }),
      ...code("VEHICLE_BUYOUT_SOURCED_LANDED_COSTS")
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("control: a clean buy-out followed by a new landed-cost edit capitalizes into Vehicle Inventory (1400)", async () => {
    const d = await seedDealer("l8");
    const vehicleId = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedFields,
    });
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8200, purchasePaymentMethod: "CASH",
    });
    await d.asOwner.mutation(api.vehicles.upsertLandedCosts, {
      orgId: d.orgId, vehicleId, items: [{ label: "Paint", amount: 600, paymentMethod: "CASH" }],
    });
    const events = await landedCostEvents(d);
    expect(events).toHaveLength(1);
    const { lines, accounts } = await d.t.run(async (ctx) => ({
      lines: await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", events[0].journalEntryId!)).take(1000),
      accounts: await ctx.db.query("chartOfAccounts").take(1000),
    }));
    const codeOf = (id: Id<"chartOfAccounts">) => accounts.find((a) => a._id === id)?.code;
    const inventoryDebit = lines.filter((l) => codeOf(l.accountId) === "1400").reduce((s, l) => s + l.debitMinor, 0);
    expect(inventoryDebit).toBe(600_000);
  });
});
