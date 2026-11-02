/**
 * SCRUM-886 round 7 (OWASP API3:2023, property-level authorization). Seat 2 found two doors that
 * still answer differently depending on whether a caller's guess equals a stored cost, for a caller
 * who may NOT read cost (no `view:cost_price`):
 *
 *  1. `vehicles.upsertLandedCosts` (needs only `edit:vehicles`). A paid landed-cost item whose
 *     amount equals the stored one is accepted; a different amount is refused by the RT11 door.
 *  2. `vehicles.importBulk` with `acquisitionPosting: "OPENING_STOCK"` (needs only `create:vehicles`).
 *     Replaying a row of an import whose id and row id are readable on the vehicle succeeds when the
 *     price equals the stored one and throws IDEMPOTENCY_CONFLICT when it differs.
 *
 * Rule applied to both, the same one `vehicles.update` and `vehicleEdits.requestUpdate` already
 * follow: a caller who cannot read cost is refused with the coded VEHICLE_COST_EDIT_NEEDS_COST_ACCESS
 * before any read or comparison, so the answer carries no signal about the stored row.
 *
 * Shipped containment is NOT mocked: the RT11 door (PAID_LANDED_COST_CHANGE_PILOT_DISABLED) is the
 * comparison the landed-cost oracle rides on. Every test goes through the public function; expected
 * values are literals taken from the seeded rows.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";

const COST_ACCESS_CODE = "VEHICLE_COST_EDIT_NEEDS_COST_ACCESS";
const STORED_LANDED_AMOUNT = 100;
const STORED_OPENING_PRICE = 8_000;
const OPENING_VIN = "OPENSTK886VIN0001";

const EDITOR = ["view:vehicles", "edit:vehicles"];
const COST_EDITOR = ["view:vehicles", "edit:vehicles", "view:cost_price"];
const IMPORTER = ["view:vehicles", "create:vehicles"];
const COST_IMPORTER = ["view:vehicles", "create:vehicles", "view:cost_price"];

type Who = "owner" | "editor" | "costEditor" | "importer" | "costImporter";

async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Cost Oracles", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const specs: Record<Who, string[] | "owner"> = {
    owner: "owner", editor: EDITOR, costEditor: COST_EDITOR, importer: IMPORTER, costImporter: COST_IMPORTER,
  };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  for (const who of Object.keys(specs) as Who[]) {
    const clerkId = `scrum886o_${who}`;
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: who }));
    const spec = specs[who];
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", spec === "owner"
        ? { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true }
        : { orgId, name: `Role ${who}`, permissions: spec })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    actors[who] = t.withIdentity({ subject: clerkId, clerkId });
  }
  await actors.owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await actors.owner.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: year, periodNumber: 1, startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), openImmediately: true,
  });
  const common = {
    orgId, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
    fuelType: "Gas", transmission: "Auto", sellingPrice: 25_000, status: "AVAILABLE" as const,
  };
  const { stockId, sourcedId } = await t.run(async (ctx) => ({
    stockId: await ctx.db.insert("vehicles", { ...common, vin: "VIN886LANDED0001", sourceType: "STOCK" }),
    sourcedId: await ctx.db.insert("vehicles", {
      ...common, vin: "VIN886LANDED0002", sourceType: "SOURCED", sourcedFromName: "Amman Importer Co", sourceCost: 9_000,
    }),
  }));
  return { t, orgId, actors, stockId, sourcedId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

afterEach(() => vi.useRealTimers());

const paid = (amount: number) => ({ label: "Transport", amount, paymentMethod: "CASH" as const });
const landed = (s: Seeded, who: Who, vehicleId: Id<"vehicles">, amount: number) =>
  s.actors[who].mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId, items: [paid(amount)] });

async function landedState(s: Seeded, vehicleId: Id<"vehicles">) {
  return s.t.run(async (ctx) => ({
    landedCostTotal: (await ctx.db.get(vehicleId))?.landedCostTotal,
    items: (await ctx.db.query("vehicleLandedCosts").collect()).filter((row) => row.vehicleId === vehicleId).map((row) => row.items),
    journals: (await ctx.db.query("journalEntries").collect()).length,
  }));
}

describe("SCRUM-886 round 7: upsertLandedCosts gives a caller without cost access no equality oracle", () => {
  test("an editor without cost access is refused for the stored amount and for a different one, identically", async () => {
    const s = await seed();
    await landed(s, "owner", s.stockId, STORED_LANDED_AMOUNT);
    const equal = await refusalDataOf(landed(s, "editor", s.stockId, STORED_LANDED_AMOUNT));
    const different = await refusalDataOf(landed(s, "editor", s.stockId, STORED_LANDED_AMOUNT + 1));
    expect(equal).toEqual(different);
    expect(equal?.code).toBe(COST_ACCESS_CODE);
    expect(different?.code).toBe(COST_ACCESS_CODE);
  });

  test("the refusal comes before any write: items, vehicle total and journals are untouched", async () => {
    const s = await seed();
    await landed(s, "owner", s.stockId, STORED_LANDED_AMOUNT);
    const before = await landedState(s, s.stockId);
    expect(before.landedCostTotal).toBe(STORED_LANDED_AMOUNT);
    await refusalDataOf(landed(s, "editor", s.stockId, STORED_LANDED_AMOUNT));
    await refusalDataOf(landed(s, "editor", s.stockId, STORED_LANDED_AMOUNT + 1));
    await refusalDataOf(s.actors.editor.mutation(api.vehicles.upsertLandedCosts, { orgId: s.orgId, vehicleId: s.stockId, items: [] }));
    expect(await landedState(s, s.stockId)).toEqual(before);
  });

  test("a vehicle with no breakdown is refused too: the write gate matches the read gate, for every source type", async () => {
    const s = await seed();
    expect((await refusalDataOf(landed(s, "editor", s.stockId, 20)))?.code).toBe(COST_ACCESS_CODE);
    expect((await refusalDataOf(landed(s, "editor", s.sourcedId, 20)))?.code).toBe(COST_ACCESS_CODE);
    expect(await s.actors.editor.query(api.vehicles.getLandedCosts, { orgId: s.orgId, vehicleId: s.stockId })).toBeNull();
    expect((await landedState(s, s.stockId)).items).toEqual([]);
  });

  test("control: a holder of view:cost_price still gets the RT11 door for a changed paid item", async () => {
    const s = await seed();
    await landed(s, "owner", s.stockId, STORED_LANDED_AMOUNT);
    const changed = await refusalDataOf(landed(s, "costEditor", s.stockId, STORED_LANDED_AMOUNT + 1));
    expect(changed?.code).toBe("PAID_LANDED_COST_CHANGE_PILOT_DISABLED");
  });

  test("control: a holder of view:cost_price keeps an unchanged paid item and can add a new one", async () => {
    const s = await seed();
    await landed(s, "owner", s.stockId, STORED_LANDED_AMOUNT);
    expect(await landed(s, "costEditor", s.stockId, STORED_LANDED_AMOUNT)).toEqual({ total: STORED_LANDED_AMOUNT });
    const grown = await s.actors.costEditor.mutation(api.vehicles.upsertLandedCosts, {
      orgId: s.orgId, vehicleId: s.stockId,
      items: [paid(STORED_LANDED_AMOUNT), { label: "Inspection", amount: 20, paymentMethod: "CASH" as const }],
    });
    expect(grown).toEqual({ total: 120 });
  });
});

const openingRow = (price: number) => ({
  rowId: 1, vin: OPENING_VIN, make: "Example", model: "Stock", year: 2024, color: "Blue", fuelType: "Petrol",
  transmission: "Automatic", sellingPrice: 15_000, purchasePrice: price, sourceType: "STOCK",
});
const openingImport = (s: Seeded, who: Who, importId: string, price: number) =>
  s.actors[who].mutation(api.vehicles.importBulk, {
    orgId: s.orgId, acquisitionPosting: "OPENING_STOCK", importId, vehicles: [openingRow(price)],
  });

describe("SCRUM-886 round 7: importBulk opening-stock replay gives a caller without cost access no equality oracle", () => {
  test("a create-only caller replaying a known import row is refused for the stored price and for a different one, identically", async () => {
    const s = await seed();
    await openingImport(s, "owner", "os-886-a", STORED_OPENING_PRICE);
    const vehicle = await s.t.run(async (ctx) => (await ctx.db.query("vehicles").collect()).find((row) => row.vin === OPENING_VIN));
    // The import and row ids are OPEN fields on the vehicle, so any reader of the vehicle knows them.
    expect(vehicle?.openingStockImportId).toBe("os-886-a");
    expect(vehicle?.openingStockRowId).toBe(1);
    const equal = await refusalDataOf(openingImport(s, "importer", "os-886-a", STORED_OPENING_PRICE));
    const different = await refusalDataOf(openingImport(s, "importer", "os-886-a", STORED_OPENING_PRICE + 1));
    expect(equal).toEqual(different);
    expect(equal?.code).toBe(COST_ACCESS_CODE);
    expect(different?.code).toBe(COST_ACCESS_CODE);
  });

  test("the refusal comes before any read of the evidence: nothing is written", async () => {
    const s = await seed();
    await openingImport(s, "owner", "os-886-b", STORED_OPENING_PRICE);
    const rows = () => s.t.run(async (ctx) => ({
      openingVehicles: (await ctx.db.query("vehicles").collect()).filter((row) => row.vin === OPENING_VIN).map((row) => [row.vin, row.purchasePrice]),
      commands: (await ctx.db.query("commandIdempotency").collect()).length,
      journals: (await ctx.db.query("journalEntries").collect()).length,
    }));
    const before = await rows();
    await refusalDataOf(openingImport(s, "importer", "os-886-b", STORED_OPENING_PRICE + 1));
    await refusalDataOf(openingImport(s, "importer", "os-886-new", 9_500));
    expect(await rows()).toEqual(before);
    expect(before.openingVehicles).toEqual([[OPENING_VIN, STORED_OPENING_PRICE]]);
  });

  test("control: a create caller who holds view:cost_price still gets a proven replay on a match and a conflict on a mismatch", async () => {
    const s = await seed();
    await openingImport(s, "owner", "os-886-c", STORED_OPENING_PRICE);
    const replay = await openingImport(s, "costImporter", "os-886-c", STORED_OPENING_PRICE);
    expect(replay).toMatchObject({ inserted: 0 });
    const mismatch = await refusalDataOf(openingImport(s, "costImporter", "os-886-c", STORED_OPENING_PRICE + 1));
    expect(mismatch?.message).toMatch(/IDEMPOTENCY_CONFLICT/);
    const stored = (await s.t.run((ctx) => ctx.db.query("vehicles").collect())).filter((row) => row.vin === OPENING_VIN);
    expect(stored.map((row) => row.purchasePrice)).toEqual([STORED_OPENING_PRICE]);
  });

  test("control: a create caller who holds view:cost_price can run a fresh opening-stock import", async () => {
    const s = await seed();
    expect(await openingImport(s, "costImporter", "os-886-d", 7_000)).toMatchObject({ inserted: 1 });
  });
});

/**
 * SCRUM-886 round 8 (Seat 2 at 7cd0cebf). The PURCHASE-mode import replay is the same oracle class as the
 * opening-stock one. A create-only caller who replays a known import key and the vehicle's facts with the
 * stored price gets `alreadyRecorded: 1`; with any other price it gets IDEMPOTENCY_CONFLICT. The import key
 * is client-supplied, not an authorization credential, so "no reader exposes it" is no defence. The rule
 * is general: a caller who cannot read cost may not run an import that compares a cost with a stored
 * fingerprint of it. PURCHASE and OPENING_STOCK-with-an-import-id both do; the legacy OPENING_STOCK call
 * without an import id does not, and stays open to a create-only caller.
 */
const PURCHASE_VIN = "PURCHASE886VIN0001";
const STORED_PURCHASE_COST = 8_000;
const purchaseRow = (price?: number, rowId = 1, vin = PURCHASE_VIN) => ({
  rowId, vin, make: "Kia", model: "Sportage", year: 2023, color: "Silver", fuelType: "Petrol",
  transmission: "Automatic", sellingPrice: 15_000, sourceType: "STOCK",
  ...(price === undefined ? {} : { purchasePrice: price }),
});
const purchaseImport = (s: Seeded, who: Who, importId: string, rows: ReturnType<typeof purchaseRow>[]) =>
  s.actors[who].mutation(api.vehicles.importBulk, {
    orgId: s.orgId, acquisitionPosting: "PURCHASE", importId, purchasePaymentMethod: "CASH", vehicles: rows,
  });

describe("SCRUM-886 round 8: importBulk PURCHASE replay gives a caller without cost access no equality oracle", () => {
  test("a create-only caller replaying a known PURCHASE row is refused for the stored price and for a different one, identically", async () => {
    const s = await seed();
    await purchaseImport(s, "owner", "pur-886-a", [purchaseRow(STORED_PURCHASE_COST)]);
    const equal = await refusalDataOf(purchaseImport(s, "importer", "pur-886-a", [purchaseRow(STORED_PURCHASE_COST)]));
    const different = await refusalDataOf(purchaseImport(s, "importer", "pur-886-a", [purchaseRow(STORED_PURCHASE_COST + 1)]));
    expect(equal).toEqual(different);
    expect(equal?.code).toBe(COST_ACCESS_CODE);
    expect(different?.code).toBe(COST_ACCESS_CODE);
  });

  test("the refusal does not depend on the import key being known, on the price, or on a price being present", async () => {
    const s = await seed();
    await purchaseImport(s, "owner", "pur-886-b", [purchaseRow(STORED_PURCHASE_COST)]);
    const known = await refusalDataOf(purchaseImport(s, "importer", "pur-886-b", [purchaseRow(STORED_PURCHASE_COST)]));
    const fresh = await refusalDataOf(purchaseImport(s, "importer", "pur-886-fresh", [purchaseRow(STORED_PURCHASE_COST + 1)]));
    const priceless = await refusalDataOf(purchaseImport(s, "importer", "pur-886-b", [purchaseRow(undefined)]));
    expect(fresh).toEqual(known);
    expect(priceless).toEqual(known);
    expect(known?.code).toBe(COST_ACCESS_CODE);
  });

  test("the refusal comes before any write: vehicles, evidence and journals are untouched", async () => {
    const s = await seed();
    await purchaseImport(s, "owner", "pur-886-c", [purchaseRow(STORED_PURCHASE_COST)]);
    const rows = () => s.t.run(async (ctx) => ({
      vehicles: (await ctx.db.query("vehicles").collect()).map((row) => [row.vin, row.purchasePrice ?? null]),
      commands: (await ctx.db.query("commandIdempotency").collect()).length,
      journals: (await ctx.db.query("journalEntries").collect()).length,
    }));
    const before = await rows();
    await refusalDataOf(purchaseImport(s, "importer", "pur-886-c", [purchaseRow(STORED_PURCHASE_COST + 1)]));
    await refusalDataOf(purchaseImport(s, "importer", "pur-886-new", [purchaseRow(9_500, 2, "PURCHASE886VIN0002")]));
    expect(await rows()).toEqual(before);
    expect(before.vehicles).toContainEqual([PURCHASE_VIN, STORED_PURCHASE_COST]);
  });

  test("control: a create caller who holds view:cost_price keeps the proven replay on a match and the conflict on a mismatch", async () => {
    const s = await seed();
    await purchaseImport(s, "owner", "pur-886-d", [purchaseRow(STORED_PURCHASE_COST)]);
    expect(await purchaseImport(s, "costImporter", "pur-886-d", [purchaseRow(STORED_PURCHASE_COST)]))
      .toMatchObject({ inserted: 0, alreadyRecorded: 1 });
    const mismatch = await refusalDataOf(purchaseImport(s, "costImporter", "pur-886-d", [purchaseRow(STORED_PURCHASE_COST + 1)]));
    expect(mismatch?.message).toMatch(/IDEMPOTENCY_CONFLICT/);
    expect(mismatch?.code).not.toBe(COST_ACCESS_CODE);
  });

  test("control: a create caller who holds view:cost_price can run a fresh PURCHASE import", async () => {
    const s = await seed();
    expect(await purchaseImport(s, "costImporter", "pur-886-e", [purchaseRow(7_000)])).toMatchObject({ inserted: 1, alreadyRecorded: 0 });
  });

  test("a create-only caller can still run the legacy opening-stock import (no import id, no proof): a row with no cost key is inserted", async () => {
    const s = await seed();
    const { rowId: _rowId, ...legacyRow } = purchaseRow(undefined);
    const result = await s.actors.importer.mutation(api.vehicles.importBulk, {
      orgId: s.orgId, acquisitionPosting: "OPENING_STOCK", vehicles: [legacyRow],
    });
    expect(result).toMatchObject({ inserted: 1, skipped: 0, alreadyRecorded: 0 });
    const stored = (await s.t.run((ctx) => ctx.db.query("vehicles").collect())).filter((row) => row.vin === PURCHASE_VIN);
    expect(stored.map((row) => row.purchasePrice)).toEqual([undefined]);
  });
});
