/**
 * SCRUM-886 round 4 (OWASP API3:2023, property-level authorization, and the OWASP guidance that an
 * error message must not disclose protected data). Round 3 closed the READERS. Two WRITE doors
 * still told a caller without `view:cost_price` something about a stored cost:
 *
 *  1. `vehicles.importBulk` (needs only `create:vehicles`) put the stored supplier cost, and the
 *     stored acquisition cost, into its refusal message.
 *  2. `vehicleEdits.requestUpdate` (the default SALES door) compared a submitted cost with the
 *     stored one and answered "No changes detected." only when they were equal, so a caller could
 *     confirm a guessed cost.
 *
 * Every test goes through the public function. The expected values are literals taken from the
 * seeded rows, never recomputed from the code under test.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { supplierIdFor } from "../test-utils/supplierFixture";
import { DEFAULT_ROLE_TEMPLATES, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";

// The pilot containment refuses every ownership change before it reaches the code under test; the
// buy-out controls below need the door open (shipped-state refusals live in rt11DoorContainment.test.ts).
vi.mock("./utils/rt11DoorContainment", async (importOriginal) =>
  (await import("../test-utils/rt11DoorSwitches")).openRt11Doors(
    await importOriginal<typeof import("./utils/rt11DoorContainment")>()
  ));

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const STORED_SOURCE_COST = 7_100_004;
const STORED_PURCHASE_PRICE = 7_100_001;
const STORED_MINIMUM_PROFIT = 7_100_003;
const ACQUISITION_COST = 10_000;
const SOURCED_VIN = "VIN886IMPORT0001";
const OWNED_VIN = "VIN886IMPORT0002";
const EDIT_SOURCED_VIN = "VIN886EDITSRC001";
const EDIT_STOCK_VIN = "VIN886EDITSTK001";

const IMPORTER = ["view:vehicles", "create:vehicles"];
const SALES = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "SALES")!.permissions as string[];
// A requester who MAY read cost: the control for "a cost reader keeps the detailed answers".
const COST_REQUESTER = ["view:vehicles", "edit:vehicles:request", "view:cost_price"];
// Direct editors (`vehicles.update` needs edit:vehicles). A custom role: no default template pairs
// edit:vehicles with a missing view:cost_price.
const EDITOR = ["view:vehicles", "edit:vehicles"];
const FINANCE_EDITOR = ["view:vehicles", "edit:vehicles", "manage:finance"];
const COST_EDITOR = ["view:vehicles", "edit:vehicles", "view:cost_price"];

type Who = "owner" | "importer" | "sales" | "costRequester" | "editor" | "financeEditor" | "costEditor";

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Cost Writes", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const roles: Record<Who, string[] | "owner"> = {
    owner: "owner",
    importer: IMPORTER,
    sales: SALES,
    costRequester: COST_REQUESTER,
    editor: EDITOR,
    financeEditor: FINANCE_EDITOR,
    costEditor: COST_EDITOR,
  };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  const userIds = {} as Record<Who, Id<"users">>;
  for (const who of Object.keys(roles) as Who[]) {
    const clerkId = `scrum886w_${who}`;
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: who }));
    const spec = roles[who];
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", spec === "owner"
        ? { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true }
        : { orgId, name: `Role ${who}`, permissions: spec })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    actors[who] = t.withIdentity({ subject: clerkId, clerkId });
    userIds[who] = userId;
  }
  await actors.owner.mutation(api.chartOfAccounts.initialize, { orgId });
  await actors.owner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999), fiscalYear: 2025, periodNumber: 1,
  });
  const period = (await actors.owner.query(api.accountingPeriods.list, { orgId }))[0];
  await actors.owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const common = {
    orgId, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
    fuelType: "Gas", transmission: "Auto", sellingPrice: 25_000, status: "AVAILABLE" as const,
  };
  const { sourcedId, stockId } = await t.run(async (ctx) => ({
    sourcedId: await ctx.db.insert("vehicles", {
      ...common, vin: EDIT_SOURCED_VIN, sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      sourceCost: STORED_SOURCE_COST,
    }),
    stockId: await ctx.db.insert("vehicles", {
      ...common, vin: EDIT_STOCK_VIN, sourceType: "STOCK",
      purchasePrice: STORED_PURCHASE_PRICE, minimumProfit: STORED_MINIMUM_PROFIT,
    }),
  }));
  // Import targets: a consigned car already recorded at a supplier cost, and an owned car whose
  // purchase is posted at ACQUISITION_COST (posted through the real import so the acquisition
  // evidence exists exactly as production holds it).
  const supplierId = await supplierIdFor(t, orgId, "Amman Importer Co");
  await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      ...common, vin: SOURCED_VIN, sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      sourcedSupplierId: supplierId, sourceCost: STORED_SOURCE_COST,
    })
  );
  await actors.owner.mutation(api.vehicles.importBulk, {
    orgId, acquisitionPosting: "PURCHASE", importId: "seed-owned", purchasePaymentMethod: "CASH",
    vehicles: [{
      rowId: 1, make: "Kia", model: "Sportage", year: 2023, color: "Silver", fuelType: "Petrol",
      transmission: "Automatic", sellingPrice: 15_000, sourceType: "STOCK", vin: OWNED_VIN, purchasePrice: ACQUISITION_COST,
    }],
  });
  return { t, orgId, actors, userIds, sourcedId, stockId, supplierId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** The text a refusal carries, whether it is a plain ConvexError string or a coded one. */
async function refusalText(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    const failure = error as { data?: unknown; message?: string };
    return typeof failure.data === "string" ? failure.data : JSON.stringify(failure.data ?? failure.message);
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

const sourcedRow = (supplierId: Id<"suppliers">, sourceCost: number) => ({
  rowId: 1, make: "Toyota", model: "Camry", year: 2024, color: "White", fuelType: "Gas", transmission: "Auto",
  sellingPrice: 25_000, sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
  sourcedSupplierId: supplierId, sourceCost, vin: SOURCED_VIN,
});
const ownedRow = (purchasePrice: number) => ({
  rowId: 1, make: "Kia", model: "Sportage", year: 2023, color: "Silver", fuelType: "Petrol", transmission: "Automatic",
  sellingPrice: 15_000, sourceType: "STOCK", vin: OWNED_VIN, purchasePrice,
});
const importOf = (s: Seeded, who: Who, importId: string, row: ReturnType<typeof sourcedRow> | ReturnType<typeof ownedRow>) =>
  s.actors[who].mutation(api.vehicles.importBulk, {
    orgId: s.orgId, acquisitionPosting: "PURCHASE", importId, purchasePaymentMethod: "CASH", vehicles: [row],
  });

describe("SCRUM-886 round 4: importBulk refusals do not disclose a stored cost", () => {
  test("a consigned VIN recorded at another supplier cost is refused without naming the stored cost", async () => {
    const s = await seed();
    const message = await refusalText(importOf(s, "importer", "imp-src-1", sourcedRow(s.supplierId, STORED_SOURCE_COST + 1)));
    expect(message).not.toContain(String(STORED_SOURCE_COST));
    expect(message).not.toMatch(/supplier cost of/);
  });

  test("a caller without cost access cannot tell a matching supplier cost from a different one", async () => {
    const s = await seed();
    const different = await refusalText(importOf(s, "importer", "imp-src-2", sourcedRow(s.supplierId, STORED_SOURCE_COST + 1)));
    const matching = await refusalText(importOf(s, "importer", "imp-src-3", sourcedRow(s.supplierId, STORED_SOURCE_COST)));
    expect(different).toBe(matching);
  });

  test("an owned VIN recorded at another acquisition cost is refused without naming the stored cost", async () => {
    const s = await seed();
    const message = await refusalText(importOf(s, "importer", "imp-own-1", ownedRow(12_000)));
    expect(message).not.toContain(String(ACQUISITION_COST));
    expect(message).not.toMatch(/recorded at/);
  });

  test("a caller without cost access cannot tell a matching acquisition cost from a different one", async () => {
    const s = await seed();
    const different = await refusalText(importOf(s, "importer", "imp-own-2", ownedRow(12_000)));
    const matching = await refusalText(importOf(s, "importer", "imp-own-3", ownedRow(ACQUISITION_COST)));
    expect(different).toBe(matching);
  });

  test("the refusal is kept: nothing is imported and no vehicle changes", async () => {
    const s = await seed();
    await refusalText(importOf(s, "importer", "imp-keep-1", sourcedRow(s.supplierId, STORED_SOURCE_COST + 1)));
    await refusalText(importOf(s, "importer", "imp-keep-2", ownedRow(12_000)));
    const vehicles = await s.t.run((ctx) => ctx.db.query("vehicles").collect());
    expect(vehicles.filter((vehicle) => vehicle.vin === SOURCED_VIN)).toHaveLength(1);
    expect(vehicles.find((vehicle) => vehicle.vin === SOURCED_VIN)?.sourceCost).toBe(STORED_SOURCE_COST);
    expect(vehicles.filter((vehicle) => vehicle.vin === OWNED_VIN)).toHaveLength(1);
  });

  test("control: the system owner, who may read cost, still gets the detailed reasons", async () => {
    const s = await seed();
    expect(await refusalText(importOf(s, "owner", "imp-ctl-1", sourcedRow(s.supplierId, STORED_SOURCE_COST + 1))))
      .toContain(`recorded at a supplier cost of ${STORED_SOURCE_COST}, this file says ${STORED_SOURCE_COST + 1}`);
    expect(await refusalText(importOf(s, "owner", "imp-ctl-2", ownedRow(12_000))))
      .toContain(`recorded at ${ACQUISITION_COST}, this file says 12000`);
  });
});

const CREDITOR_VIN = "VIN886IMPORT0003";
const onAccountRow = (purchaseSupplierId: Id<"suppliers">) => ({ ...ownedRow(ACQUISITION_COST), vin: CREDITOR_VIN, purchaseSupplierId });
const importOnAccount = (s: Seeded, who: Who, importId: string, row: ReturnType<typeof onAccountRow>) =>
  s.actors[who].mutation(api.vehicles.importBulk, {
    orgId: s.orgId, acquisitionPosting: "PURCHASE", importId, purchasePaymentMethod: "ON_ACCOUNT", vehicles: [row],
  });

describe("SCRUM-886 round 4: importBulk does not name a stored creditor", () => {
  test("an owned VIN bought on account is refused without naming the stored creditor, and a different creditor looks like the same one", async () => {
    const s = await seed();
    const stored = await supplierIdFor(s.t, s.orgId, "Gulf Parts Ltd");
    const other = await supplierIdFor(s.t, s.orgId, "Other Creditor Co");
    await importOnAccount(s, "owner", "imp-acct-seed", onAccountRow(stored));
    const different = await refusalText(importOnAccount(s, "importer", "imp-acct-1", onAccountRow(other)));
    const matching = await refusalText(importOnAccount(s, "importer", "imp-acct-2", onAccountRow(stored)));
    expect(different).toBe(matching);
    expect(different).not.toContain("Gulf Parts Ltd");
    expect(different).not.toMatch(/owed to/);
  });

  test("control: the system owner still gets the stored creditor named", async () => {
    const s = await seed();
    const stored = await supplierIdFor(s.t, s.orgId, "Gulf Parts Ltd");
    const other = await supplierIdFor(s.t, s.orgId, "Other Creditor Co");
    await importOnAccount(s, "owner", "imp-acct-seed", onAccountRow(stored));
    expect(await refusalText(importOnAccount(s, "owner", "imp-acct-3", onAccountRow(other)))).toContain("owed to Gulf Parts Ltd");
  });
});
describe("SCRUM-886 round 4: requestUpdate gives a caller without cost access no equality oracle", () => {
  const COST_REFUSAL = { data: { code: "VEHICLE_COST_EDIT_NEEDS_COST_ACCESS" } };

  test("a submitted sourceCost is refused whether or not it equals the stored cost", async () => {
    const s = await seed();
    const equal = await refusalText(s.actors.sales.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { sourceCost: STORED_SOURCE_COST },
    }));
    const different = await refusalText(s.actors.sales.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { sourceCost: STORED_SOURCE_COST + 1 },
    }));
    expect(equal).toBe(different);
    expect(equal).not.toMatch(/No changes detected/);
    await expect(s.actors.sales.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { sourceCost: STORED_SOURCE_COST + 1 },
    })).rejects.toMatchObject(COST_REFUSAL);
  });

  test("purchasePrice and minimumProfit are refused the same way", async () => {
    const s = await seed();
    for (const payload of [
      { purchasePrice: STORED_PURCHASE_PRICE },
      { purchasePrice: STORED_PURCHASE_PRICE + 1 },
      { minimumProfit: STORED_MINIMUM_PROFIT },
      { minimumProfit: STORED_MINIMUM_PROFIT + 1 },
    ]) {
      await expect(s.actors.sales.mutation(api.vehicleEdits.requestUpdate, {
        orgId: s.orgId, vehicleId: s.stockId, payload,
      })).rejects.toMatchObject(COST_REFUSAL);
    }
  });

  test("a refused request queues nothing", async () => {
    const s = await seed();
    await refusalText(s.actors.sales.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { sourceCost: STORED_SOURCE_COST + 1 },
    }));
    expect(await s.t.run((ctx) => ctx.db.query("vehicleEdits").collect())).toHaveLength(0);
  });

  test("legitimate flow kept: a salesperson still requests a non-cost change, and an unchanged one is still reported", async () => {
    const s = await seed();
    const requestId = await s.actors.sales.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { sellingPrice: 24_000, color: "White" },
    });
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.payload).toEqual({ sellingPrice: 24_000 });
    await expect(s.actors.sales.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { color: "White" },
    })).rejects.toThrow("No changes detected.");
  });

  test("control: a requester who may read cost can still request a cost change", async () => {
    const s = await seed();
    const requestId = await s.actors.costRequester.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { sourceCost: STORED_SOURCE_COST + 1 },
    });
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.payload).toEqual({ sourceCost: STORED_SOURCE_COST + 1 });
    await expect(s.actors.costRequester.mutation(api.vehicleEdits.requestUpdate, {
      orgId: s.orgId, vehicleId: s.sourcedId, payload: { sourceCost: STORED_SOURCE_COST },
    })).rejects.toThrow("No changes detected.");
  });
});

describe("SCRUM-886 round 5: vehicles.update gives a caller without cost access no equality oracle", () => {
  const COST_REFUSAL = { data: { code: "VEHICLE_COST_EDIT_NEEDS_COST_ACCESS" } };
  const update = (s: Seeded, who: Who, vehicleId: Id<"vehicles">, patch: Record<string, unknown>) =>
    s.actors[who].mutation(api.vehicles.update, { orgId: s.orgId, vehicleId, ...patch });

  test("an editor without cost access is refused for a cost equal to the stored one and for a different one, identically", async () => {
    const s = await seed();
    const equal = await refusalText(update(s, "editor", s.stockId, { purchasePrice: STORED_PURCHASE_PRICE }));
    const different = await refusalText(update(s, "editor", s.stockId, { purchasePrice: STORED_PURCHASE_PRICE + 1 }));
    expect(equal).toBe(different);
    await expect(update(s, "editor", s.stockId, { purchasePrice: STORED_PURCHASE_PRICE })).rejects.toMatchObject(COST_REFUSAL);
    await expect(update(s, "editor", s.stockId, { minimumProfit: STORED_MINIMUM_PROFIT })).rejects.toMatchObject(COST_REFUSAL);
    await expect(update(s, "editor", s.sourcedId, { sourceCost: STORED_SOURCE_COST })).rejects.toMatchObject(COST_REFUSAL);
  });

  test("a different cost from the same editor is refused and nothing is written", async () => {
    const s = await seed();
    await expect(update(s, "editor", s.stockId, { minimumProfit: STORED_MINIMUM_PROFIT + 1, sellingPrice: 26_000 }))
      .rejects.toMatchObject(COST_REFUSAL);
    await expect(update(s, "editor", s.sourcedId, { sourceCost: STORED_SOURCE_COST + 1 })).rejects.toMatchObject(COST_REFUSAL);
    const stock = await s.t.run((ctx) => ctx.db.get(s.stockId));
    const sourced = await s.t.run((ctx) => ctx.db.get(s.sourcedId));
    expect(stock?.minimumProfit).toBe(STORED_MINIMUM_PROFIT);
    expect(stock?.sellingPrice).toBe(25_000);
    expect(sourced?.sourceCost).toBe(STORED_SOURCE_COST);
  });

  test("control: the same editor sending no cost keys still edits the vehicle", async () => {
    const s = await seed();
    await update(s, "editor", s.stockId, { sellingPrice: 26_000 });
    expect((await s.t.run((ctx) => ctx.db.get(s.stockId)))?.sellingPrice).toBe(26_000);
  });

  test("control: a holder of view:cost_price still edits a cost", async () => {
    const s = await seed();
    await update(s, "costEditor", s.stockId, { minimumProfit: STORED_MINIMUM_PROFIT + 1 });
    expect((await s.t.run((ctx) => ctx.db.get(s.stockId)))?.minimumProfit).toBe(STORED_MINIMUM_PROFIT + 1);
  });

  test("control: a finance editor without view:cost_price completes a consignment buy-out", async () => {
    const s = await seed();
    await update(s, "financeEditor", s.sourcedId, {
      sourceType: "STOCK", purchasePrice: 9_800, purchasePaymentMethod: "CASH",
    });
    const bought = await s.t.run((ctx) => ctx.db.get(s.sourcedId));
    expect(bought?.sourceType).toBe("STOCK");
    expect(bought?.purchasePrice).toBe(9_800);
  });

  test("manage:finance alone does not unlock a cost edit that changes no ownership", async () => {
    const s = await seed();
    await expect(update(s, "financeEditor", s.stockId, { minimumProfit: STORED_MINIMUM_PROFIT }))
      .rejects.toMatchObject(COST_REFUSAL);
    await expect(update(s, "financeEditor", s.sourcedId, { sourceCost: STORED_SOURCE_COST + 1 }))
      .rejects.toMatchObject(COST_REFUSAL);
    const stock = await s.t.run((ctx) => ctx.db.get(s.stockId));
    expect(stock?.minimumProfit).toBe(STORED_MINIMUM_PROFIT);
  });
  test("an editor with neither manage:finance nor view:cost_price is refused for ownership-change keys", async () => {
    const s = await seed();
    await expect(update(s, "editor", s.sourcedId, {
      sourceType: "STOCK", purchasePrice: 9_800, purchasePaymentMethod: "CASH",
    })).rejects.toMatchObject(COST_REFUSAL);
    expect((await s.t.run((ctx) => ctx.db.get(s.sourcedId)))?.sourceType).toBe("SOURCED");
  });
});