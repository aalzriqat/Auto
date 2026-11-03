/**
 * SCRUM-894 (retro on SCRUM-886, owner standard SCRUM-760 c24361 practice 2, "retro into checks"): one property test over
 * EVERY mutation that completes a sale.
 *
 * PR #746 needed rounds 6 to 12 because each round found one more sibling door of the same class: a mutation response (refusal text,
 * stored-value comparison, replay fingerprint, refusal order) that let an actor without `view:cost_price` learn a COST-tier value.
 * Round 13 closed the class by permission (ADR 2026-11-02-sourced-sale-completion-requires-cost-access.md). This file keeps it closed.
 *
 * 1. ENUMERATION IS DERIVED, NEVER LISTED. `scripts/saleCompletionDoors.ts` scans the Convex sources for every exported mutation that
 *    calls one of the three sale-completion entry points (`completeSale`, `completeSalesForLineItems`, `completeExistingSale`). A new
 *    completing door that is not in `DRIVERS`, a driver whose door no longer exists, a completing call from anything that is not a
 *    mutation (a helper nobody classified), and a door that does not run `assertActorMayCompleteConsignedSale` all FAIL the suite.
 * 2. For each door, an actor who completes sales but lacks `view:cost_price` is driven at every combination of supplier entitlement
 *    (E-1 fils, E, E+1 fils, never recorded) and submitted price (E-1, E, E+1 fils). Every response is byte-identical (the whole
 *    ConvexError.data), is the coded amount-free refusal, and the whole database (every table in the schema) is unchanged.
 * 3. Non-vacuity control: a `view:cost_price` holder is driven through the same door and the sale commits, so the driver provably
 *    reaches the real completion path and the refusal above is the permission, not a broken fixture.
 *
 * Expected values are literals from the seeded rows: an entitlement of 8,765.432 JOD and one-fils neighbours.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { payForwardBeforeFinalize, readyDeal, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { supplierIdInCtx } from "../test-utils/supplierFixture";
import { discoverCompletionDoors, discoverInSource } from "../scripts/saleCompletionDoors";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const NEEDS_COST_ACCESS_CODE = "CONSIGNED_SALE_NEEDS_COST_ACCESS";
const ENTITLEMENT = 8_765.432;
const FILS = 0.001;
const ENTITLEMENT_LEAK = /8[,. ]?765|765[.,]?432|8765432/;

/** The role the owner ruling names: it can complete a sale and cannot read vehicle cost. */
const COMPLETER_NO_COST = [
  "view:sales", "create:sales", "view:vehicles", "view:customers", "edit:vehicles", "confirm:finance_disbursement",
];
const COMPLETER_WITH_COST = [...COMPLETER_NO_COST, "view:cost_price"];

type Who = "nonReader" | "reader";

interface Variant {
  /** The vehicle's frozen supplier entitlement (COST tier); null models "never recorded". */
  cost: number | null;
  /** The price the actor submits. */
  price: number;
  /**
   * The car's stock status. An archived SOURCED car has its own caller-aimed refusal further down every door; the ruling
   * (SCRUM-886 c24358) makes the permission refusal the FIRST decision, so it must still answer for it.
   */
  status: "AVAILABLE" | "ARCHIVED";
}
const COSTS: Array<number | null> = [ENTITLEMENT - FILS, ENTITLEMENT, ENTITLEMENT + FILS, null];
const PRICES = [ENTITLEMENT - FILS, ENTITLEMENT, ENTITLEMENT + FILS];
const STATUSES = ["AVAILABLE", "ARCHIVED"] as const;
const VARIANTS: Variant[] = COSTS.flatMap((cost) =>
  PRICES.flatMap((price) => STATUSES.map((status) => ({ cost, price, status })))
);

/** A world holding one door under test. `prepare` applies a variant to the stored rows; `call` runs the door. */
interface DoorWorld {
  snapshot: () => Promise<Record<string, unknown[]>>;
  prepare: (variant: Variant) => Promise<void>;
  call: (who: Who) => Promise<string | null>;
}
interface Driver {
  /** Shapes of the door worth driving (for example a one-line and a multi-line quote). */
  shapes: readonly string[];
  /**
   * The shape the reader control drives when the refusal shape cannot complete for a reader for an unrelated reason (a stock line
   * of a CASH quote needs a recorded deposit first). It must keep the SOURCED car in the same position.
   */
  controlShape?: Readonly<Record<string, string>>;
  setup: (shape: string) => Promise<DoorWorld>;
}

/** The whole `ConvexError.data` of a refused call as one string (the byte-identical oracle), or null when accepted. */
async function payloadOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: unknown })?.data;
    if (data !== undefined) return JSON.stringify(data);
    return `PLAIN:${(error as Error)?.message ?? String(error)}`;
  }
  return null;
}

type TestConvex = ReturnType<typeof convexTestWithComponents>;

/** Every table in the schema, so a write anywhere (not only the tables the author thought of) is seen. */
async function snapshotAllTables(t: TestConvex): Promise<Record<string, unknown[]>> {
  const names = Object.keys(schema.tables).sort();
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const name of names) out[name] = await ctx.db.query(name as never).collect();
    return out;
  });
}

/** Applies the variant's entitlement and status to the stored SOURCED car. */
async function setCost(t: TestConvex, vehicleId: Id<"vehicles">, variant: Variant) {
  await t.run(async (ctx) => {
    const car = await ctx.db.get(vehicleId);
    if (!car) throw new Error("vehicle missing");
    const { sourceCost: _removed, ...rest } = car;
    void _removed;
    await ctx.db.replace(vehicleId, {
      ...rest,
      status: variant.status,
      ...(variant.cost === null ? {} : { sourceCost: variant.cost }),
    });
  });
}

async function seedSalesWorld() {
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Sale Door Class", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"], commissionMode: "MANUAL" })
  );
  const specs: Record<Who, string[]> = { nonReader: COMPLETER_NO_COST, reader: COMPLETER_WITH_COST };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  const userIds = {} as Record<Who, Id<"users">>;
  for (const who of Object.keys(specs) as Who[]) {
    const clerkId = `scrum894_${who}`;
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: who }));
    // A direct `roles` insert, exactly as a role stored before the rule existed would be.
    const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: `Role ${who}`, permissions: specs[who] }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    actors[who] = t.withIdentity({ subject: clerkId, clerkId });
    userIds[who] = userId;
  }
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Class" }));
  let vin = 0;
  const consignedCar = async (): Promise<Id<"vehicles">> =>
    await t.run(async (ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VIN894CLASS${String((vin += 1)).padStart(5, "0")}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
        color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE",
        sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
        sourcedSupplierId: await supplierIdInCtx(ctx, orgId, "Amman Importer Co"), sourceCost: ENTITLEMENT,
      })
    );
  const stockCar = async (): Promise<Id<"vehicles">> =>
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VIN894CLASS${String((vin += 1)).padStart(5, "0")}`, make: "Honda", model: "Accord", year: 2023, mileage: 20,
        color: "Black", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE", sourceType: "STOCK",
        purchasePrice: 5_000,
      })
    );
  return { t, orgId, actors, userIds, customerId, consignedCar, stockCar };
}

/** A CASH completion on the DIRECT_TO_SUPPLIER route: the buyer pays the supplier, so pay-first has nothing to demand. */
const ROUTE = "DIRECT_TO_SUPPLIER" as const;

// ---------------------------------------------------------------------------------------------------------------------------
// One driver per door. The suite fails if this set differs from the set discovered in source.
// ---------------------------------------------------------------------------------------------------------------------------

const DRIVERS: Record<string, Driver> = {
  "sales.create": {
    shapes: ["single"],
    setup: async () => {
      const s = await seedSalesWorld();
      const car = await s.consignedCar();
      let price = ENTITLEMENT;
      return {
        snapshot: () => snapshotAllTables(s.t),
        prepare: async (variant) => {
          price = variant.price;
          await setCost(s.t, car, variant);
        },
        call: (who) =>
          payloadOf(
            s.actors[who].mutation(api.sales.create, {
              idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: car, customerId: s.customerId,
              salespersonId: s.userIds[who], salePrice: price, saleDate: Date.now(), status: "COMPLETED" as const,
              supplierSettlementRoute: ROUTE,
            })
          ),
      };
    },
  },
  "sales.completeDraft": {
    shapes: ["single"],
    setup: async () => {
      const s = await seedSalesWorld();
      const car = await s.consignedCar();
      const saleId = await s.t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId: s.orgId, vehicleId: car, customerId: s.customerId, salespersonId: s.userIds.nonReader, salePrice: ENTITLEMENT,
          saleDate: Date.now(), status: "PENDING", financingType: "CASH", supplierSettlementRoute: ROUTE,
        })
      );
      return {
        snapshot: () => snapshotAllTables(s.t),
        prepare: async (variant) => {
          await setCost(s.t, car, variant);
          await s.t.run((ctx) => ctx.db.patch(saleId, { salePrice: variant.price }));
        },
        call: (who) =>
          payloadOf(s.actors[who].mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: crypto.randomUUID() })),
      };
    },
  },
  "sales.completeFromQuote": {
    shapes: ["single-line", "multi-line"],
    controlShape: { "multi-line": "multi-line-consigned" },
    setup: async (shape) => {
      const s = await seedSalesWorld();
      // The SOURCED car is the LAST line of a multi-line quote, so a per-line decision on line 1 cannot answer for it.
      const lines: Array<Id<"vehicles">> =
        shape === "multi-line" ? [await s.stockCar()] : shape === "multi-line-consigned" ? [await s.consignedCar()] : [];
      const car = await s.consignedCar();
      lines.push(car);
      const quoteId = await s.t.run((ctx) =>
        ctx.db.insert("quotes", {
          orgId: s.orgId, customerId: s.customerId, vehicleId: lines[0], mode: "CASH",
          vehicleItems: lines.map((vehicleId) => ({ vehicleId, unitPrice: ENTITLEMENT })), vehiclePrice: ENTITLEMENT * lines.length,
          downPayment: 0, termMonths: 0, status: "ACCEPTED", createdBy: s.userIds.nonReader, createdAt: Date.now(),
        })
      );
      return {
        snapshot: () => snapshotAllTables(s.t),
        prepare: async (variant) => {
          await setCost(s.t, car, variant);
          await s.t.run((ctx) =>
            ctx.db.patch(quoteId, {
              vehicleItems: lines.map((vehicleId) => ({ vehicleId, unitPrice: vehicleId === car ? variant.price : ENTITLEMENT })),
            })
          );
        },
        call: (who) =>
          payloadOf(
            s.actors[who].mutation(api.sales.completeFromQuote, {
              orgId: s.orgId, quoteId, idempotencyKey: crypto.randomUUID(), supplierSettlementRoute: ROUTE,
            })
          ),
      };
    },
  },
  "applications.finalizeDeal": {
    shapes: ["financed"],
    setup: async () => {
      const s = await seedFinancedDealership("s894fin", {
        modules: MODULES, ownerPerms: ALL_PERMISSIONS, actors: { nonReader: COMPLETER_NO_COST, reader: COMPLETER_WITH_COST },
        label: "S894", vinPrefix: "VIN894F", sourced: true,
      });
      const { applicationId } = await readyDeal(s, { route: "THROUGH_DEALERSHIP" });
      await payForwardBeforeFinalize(s, s.owner.as, applicationId);
      return {
        snapshot: () => snapshotAllTables(s.t),
        // The deal's price is fixed by the approved application, so only the entitlement varies here.
        prepare: (variant) => setCost(s.t, s.vehicleId, variant),
        call: (who) =>
          payloadOf(
            s.actors[who].as.mutation(api.applications.finalizeDeal, {
              idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
            })
          ),
      };
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------------------------------------------------------

describe("SCRUM-894: the sale-completing doors are derived from source and every one is covered", () => {
  const discovery = discoverCompletionDoors(__dirname);

  test("every exported mutation that calls a completion entry point has a driver, and every driver names a real door", () => {
    expect(discovery.doors, "doors discovered in the Convex sources").toEqual(Object.keys(DRIVERS).sort());
  });

  test("no completion entry point is called from anything that is not an exported mutation (an unclassified helper is a new door)", () => {
    expect(discovery.unclassifiedCallers).toEqual([]);
  });

  test("every door runs the cost-access permission gate in its own body", () => {
    expect(discovery.doorsWithoutGate).toEqual([]);
  });

  test("the scan found something: a vacuous empty discovery cannot pass", () => {
    expect(discovery.doors.length).toBeGreaterThanOrEqual(4);
  });

  test("the scanner itself: a new door, a wrapping helper and an ungated door are each reported (so the checks above can fail)", () => {
    const into = { doors: [] as string[], unclassifiedCallers: [] as string[], doorsWithoutGate: [] as string[] };
    discoverInSource(
      "fake",
      [
        'export const newDoor = mutation({ handler: async (ctx) => { await completeSale(ctx, {}); } });',
        'async function wrapper(ctx) { return await completeExistingSale(ctx, {}); }',
        'export const gated = internalMutation({ handler: async (ctx) => { await assertActorMayCompleteConsignedSale(ctx, {}); await completeSalesForLineItems(ctx, {}); } });',
        '// export const commented = mutation({ handler: async () => completeSale(ctx) })',
        // A door built with a custom builder is not recognised as a mutation, so it must fail closed as unclassified.
        'export const viaBuilder = customMutation({ handler: async (ctx) => { await completeSale(ctx, {}); } });',
      ].join("\n"),
      into
    );
    expect(into.doors.sort()).toEqual(["fake.gated", "fake.newDoor"]);
    expect(into.unclassifiedCallers.sort()).toEqual(["fake.viaBuilder", "fake.wrapper"]);
    expect(into.doorsWithoutGate).toEqual(["fake.newDoor"]);
  });
});

// Static titles, not one generated test per door: the SCRUM-761 library binds a record to one exact title. A failure message names the
// door and the variant, so the loop below loses no diagnostic.
describe("SCRUM-894: a completer without view:cost_price learns nothing and writes nothing at any door", () => {
  test("every discovered sale-completing door gives a non-reader one byte-identical coded refusal at every entitlement, price and status, and writes nothing to any table", async () => {
    for (const door of Object.keys(DRIVERS).sort()) {
      for (const shape of DRIVERS[door].shapes) {
        const label = `${door} (${shape})`;
        const world = await DRIVERS[door].setup(shape);
        const payloads = new Set<string | null>();
        for (const variant of VARIANTS) {
          await world.prepare(variant);
          const before = await world.snapshot();
          const payload = await world.call("nonReader");
          expect(payload, `${label} ${JSON.stringify(variant)}: refused`).not.toBeNull();
          payloads.add(payload);
          expect(await world.snapshot(), `${label} ${JSON.stringify(variant)}: nothing written`).toEqual(before);
        }
        expect([...payloads], `${label}: one response for every variant`).toHaveLength(1);
        const [only] = [...payloads];
        const data = JSON.parse(only as string) as { code?: string };
        expect(data.code, `${label}: the coded cost-access refusal`).toBe(NEEDS_COST_ACCESS_CODE);
        expect(only, `${label}: names no amount`).not.toMatch(ENTITLEMENT_LEAK);
      }
    }
  }, 600_000);

  test("control: a view:cost_price holder completes a sale through every discovered door, so each driver reaches the real completion path", async () => {
    for (const door of Object.keys(DRIVERS).sort()) {
      for (const shape of DRIVERS[door].shapes) {
        const label = `${door} (${shape})`;
        const world = await DRIVERS[door].setup(DRIVERS[door].controlShape?.[shape] ?? shape);
        await world.prepare({ cost: ENTITLEMENT, price: ENTITLEMENT, status: "AVAILABLE" });
        const before = await world.snapshot();
        expect(await world.call("reader"), `${label}: the reader's call is accepted`).toBeNull();
        expect(await world.snapshot(), `${label}: the reader's call wrote the sale`).not.toEqual(before);
      }
    }
  }, 600_000);
});
