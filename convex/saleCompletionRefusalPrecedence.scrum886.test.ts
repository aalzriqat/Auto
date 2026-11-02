/**
 * SCRUM-886 round 11 (OWASP API3:2023, property-level authorization: the OUTCOME of a mutation is a read channel).
 *
 * Round 10 made every cost-derived refusal in a consigned (SOURCED) sale completion amount-free and coded for a caller
 * without `view:cost_price`. Both review seats then found the next channel: the ORDER of refusals. In
 * `applySaleCompletionSideEffects` the cost gate (the consigned shortfall / no-cost refusal, and the cost-derived
 * deposit refusal) ran BEFORE the refusals that depend only on what the caller sent (the trade-in checks). So a caller
 * who cannot read cost could send an invalid trade-in (the car against itself, a deleted one, a SOLD one, a SOURCED
 * one, one with a purchase price, a value with too many decimals, any valid trade-in on a cash sale) and read the
 * stored supplier entitlement off WHICH refusal came back: a price below it returned the coded
 * `CONSIGNED_SALE_NEEDS_COST_ACCESS`, a price at or above it returned the trade-in refusal. Halving the price range
 * recovers the entitlement to the fils in about 25 refused calls, each of which writes nothing.
 *
 * Invariant (round 11): for a caller who cannot read vehicle cost, every refusal that caller can trigger at will is
 * decided BEFORE the cost gate, so the response at 1, one fils below the entitlement, the entitlement and 20,000 is
 * byte-identical. The only response that may differ with the price is "a coded refusal" versus "a real sale
 * committed", which is the sale outcome itself and not a probe.
 *
 * Every test goes through a public mutation. Expected values are literals from the seeded rows: a supplier
 * entitlement of 8,765.432 JOD (8765432 fils) and, for the deposit door, a held deposit of 1,000 JOD.
 *
 * ROUND 13 (owner ruling SCRUM-886 comment 24358): the doors now refuse a caller who cannot read vehicle cost, for any SOURCED
 * car, as their first decision (convex/consignedSaleCostAccessRule.scrum886.test.ts). A non-reader therefore never reaches the code
 * these tests are about. They are kept as DEFENCE IN DEPTH: the non-reader calls below run the shared completion code
 * (`completeSale` / `completeExistingSale`) directly, as the same non-reader actor and without the door check, which is what a
 * future caller that forgot the door check would do. Reader and owner calls still go through the public doors unchanged. The
 * ordering of refusals inside the shared code is unchanged and still proved; what changed is that a non-reader's sale at or above
 * the entitlement no longer commits (the shared gate refuses a non-reader of a consigned car at every price).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { supplierIdInCtx } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import { completeExistingSale, completeSale } from "./utils/saleCompletion";

const NEEDS_COST_ACCESS_CODE = "CONSIGNED_SALE_NEEDS_COST_ACCESS";
const ENTITLEMENT = 8_765.432;
const ONE_FILS_SHORT = 8_765.431;
const DEPOSIT = 1_000;
/** The four prices the invariant names: far below, one fils short, exactly the entitlement, far above. */
const PRICES = [1, ONE_FILS_SHORT, ENTITLEMENT, 20_000] as const;
/** The deposit door's threshold is the entitlement PLUS the deposit (the margin must cover the deposit). */
const DEPOSIT_DOOR_PRICES = [1, ENTITLEMENT + DEPOSIT - 0.001, ENTITLEMENT + DEPOSIT, 20_000] as const;

const SALES_NO_COST = ["view:sales", "create:sales", "view:vehicles", "view:customers"];
const SALES_WITH_COST = [...SALES_NO_COST, "view:cost_price"];

type Who = "owner" | "nonReader" | "reader";
type Refusal = { code?: string; message: string } | null;

async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Refusal Precedence", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const specs: Record<Who, string[] | "owner"> = { owner: "owner", nonReader: SALES_NO_COST, reader: SALES_WITH_COST };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  const userIds = {} as Record<Who, Id<"users">>;
  for (const who of Object.keys(specs) as Who[]) {
    const clerkId = `scrum886p_${who}`;
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: who }));
    const spec = specs[who];
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", spec === "owner"
        ? { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true }
        : { orgId, name: `Role ${who}`, permissions: spec })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    actors[who] = t.withIdentity({ subject: clerkId, clerkId });
    userIds[who] = userId;
  }
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Precedence" }));
  return { t, orgId, actors, userIds, customerId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

afterEach(() => vi.useRealTimers());

let vinCounter = 0;
const nextVin = (prefix: string) => `${prefix}${String((vinCounter += 1)).padStart(6, "0")}`;

/** A consigned car. `sourceCost` null models a car whose supplier amount was never recorded. */
async function consignedCar(s: Seeded, sourceCost: number | null = ENTITLEMENT): Promise<Id<"vehicles">> {
  return await s.t.run(async (ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: nextVin("VIN886PREC"), make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE",
      sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      sourcedSupplierId: await supplierIdInCtx(ctx, s.orgId, "Amman Importer Co"),
      ...(sourceCost !== null ? { sourceCost } : {}),
    })
  );
}

/** A trade-in candidate: dealer-owned, AVAILABLE, no purchase price, unless the test says otherwise. */
async function tradeInCar(s: Seeded, overrides: Partial<Doc<"vehicles">> = {}): Promise<Id<"vehicles">> {
  return await s.t.run(async (ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: nextVin("VIN886TRAD"), make: "Honda", model: "Civic", year: 2019,
      mileage: 80_000, color: "Grey", fuelType: "Gas", transmission: "Auto", sellingPrice: 4_000, status: "AVAILABLE",
      ...overrides,
    })
  );
}

type TradeIn = { tradeInVehicleId: Id<"vehicles">; tradeInValue: number };

/** A CASH completion on the DIRECT_TO_SUPPLIER route (the buyer pays the supplier, so the dealership bills the car at nil). */
const create = (s: Seeded, who: Who, vehicleId: Id<"vehicles">, salePrice: number, tradeIn?: TradeIn) =>
  who === "nonReader"
    ? s.t.run((ctx) =>
        completeSale(ctx, {
          orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userIds.nonReader, salePrice,
          saleDate: Date.now(), status: "COMPLETED", supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
          actorId: s.userIds.nonReader, ...(tradeIn ?? {}),
        })
      )
    : s.actors[who].mutation(api.sales.create, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId,
        salespersonId: s.userIds[who], salePrice, saleDate: Date.now(), status: "COMPLETED" as const,
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
        ...(tradeIn ?? {}),
      });

async function worldOf(s: Seeded, vehicleId: Id<"vehicles">) {
  return s.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").take(1000)).length,
    commands: (await ctx.db.query("commandIdempotency").take(1000)).length,
    queued: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
    payments: (await ctx.db.query("canonicalPayments").take(1000)).length,
    vehicle: await ctx.db.get(vehicleId),
  }));
}

/** Any rendering of the entitlement, as major units, minor units, or grouped thousands. */
const ENTITLEMENT_LEAK = /8[,. ]?765|765[.,]?432|8765432/;

/**
 * The refusal the caller gets at each price, in order. Refused calls write nothing, so the same car is reused.
 */
async function refusalsAcrossPrices(
  prices: readonly number[],
  call: (price: number) => Promise<unknown>
): Promise<Refusal[]> {
  const out: Refusal[] = [];
  for (const price of prices) out.push(await refusalDataOf(call(price)));
  return out;
}

/** The invariant: one refusal, byte-identical at every price, and never the coded cost-access refusal. */
function expectOneRefusalAtEveryPrice(refusals: Refusal[], message: RegExp, label: string) {
  const [first] = refusals;
  // The oracle itself, stated first so a failure shows the two responses that differ.
  expect(refusals, `${label}: the response must not vary with the price`).toEqual(Array(refusals.length).fill(first));
  expect(first, `${label}: refused`).not.toBeNull();
  expect(first?.code, `${label}: not the coded cost refusal`).not.toBe(NEEDS_COST_ACCESS_CODE);
  expect(first?.message, `${label}: states the trade-in refusal`).toMatch(message);
  expect(first?.message, `${label}: names no entitlement`).not.toMatch(ENTITLEMENT_LEAK);
}

interface TradeInCase {
  name: string;
  /** Builds the trade-in the caller sends; `car` is the consigned car being sold. */
  build: (s: Seeded, car: Id<"vehicles">) => Promise<TradeIn>;
  message: RegExp;
}

const TRADE_IN_CASES: TradeInCase[] = [
  {
    name: "the car traded in against its own sale",
    build: async (_s, car) => ({ tradeInVehicleId: car, tradeInValue: 1 }),
    message: /cannot be traded in against its own sale/i,
  },
  {
    name: "a trade-in vehicle that was soft-deleted",
    build: async (s) => ({ tradeInVehicleId: await tradeInCar(s, { isDeleted: true }), tradeInValue: 1 }),
    message: /Trade-in vehicle not found in this organization/i,
  },
  {
    name: "a trade-in vehicle that is already SOLD",
    build: async (s) => ({ tradeInVehicleId: await tradeInCar(s, { status: "SOLD" }), tradeInValue: 1 }),
    message: /is sold and cannot be accepted as a trade-in/i,
  },
  {
    name: "a trade-in vehicle that is ARCHIVED",
    build: async (s) => ({ tradeInVehicleId: await tradeInCar(s, { status: "ARCHIVED" }), tradeInValue: 1 }),
    message: /is archived and cannot be accepted as a trade-in/i,
  },
  {
    name: "a SOURCED (consigned) record used as the trade-in",
    build: async (s) => ({ tradeInVehicleId: await consignedCar(s, 5_000), tradeInValue: 1 }),
    message: /sourced\/drop-ship vehicle record cannot be used as a trade-in/i,
  },
  {
    name: "a trade-in vehicle that already carries a purchase price",
    build: async (s) => ({ tradeInVehicleId: await tradeInCar(s, { purchasePrice: 2_000 }), tradeInValue: 1 }),
    message: /already has a purchase price recorded/i,
  },
  {
    name: "a trade-in value with more decimals than the currency has",
    build: async (s) => ({ tradeInVehicleId: await tradeInCar(s), tradeInValue: 1.0005 }),
    message: /trade-in|decimal|precision|fils/i,
  },
  {
    name: "a valid trade-in on a cash sale (the invoice is already nil, so nothing can absorb it)",
    build: async (s) => ({ tradeInVehicleId: await tradeInCar(s), tradeInValue: 1 }),
    message: /Allocation amount 1000 exceeds receivable outstanding balance 0\./,
  },
];

/** One consigned car, one trade-in case, the four prices: the response must be the same at all of them. */
async function expectCaseIdenticalAtEveryPrice(tradeInCase: TradeInCase) {
  const s = await seed();
  const car = await consignedCar(s);
  const tradeIn = await tradeInCase.build(s, car);
  const refusals = await refusalsAcrossPrices(PRICES, (price) => create(s, "nonReader", car, price, tradeIn));
  expectOneRefusalAtEveryPrice(refusals, tradeInCase.message, tradeInCase.name);
}

const caseNamed = (fragment: string): TradeInCase => {
  const found = TRADE_IN_CASES.find((c) => c.name.includes(fragment));
  if (!found) throw new Error(`no trade-in case matches ${fragment}`);
  return found;
};

describe("SCRUM-886 round 11: sales.create, a caller-controlled trade-in refusal is the same at every price for a non-reader", () => {
  test("the car sent as its own trade-in is refused with one response at 1, one fils short, the entitlement and 20,000", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("against its own sale"));
  });

  test("a soft-deleted trade-in vehicle is refused with one response at every price", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("soft-deleted"));
  });

  test("an already SOLD trade-in vehicle is refused with one response at every price", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("already SOLD"));
  });

  test("an ARCHIVED trade-in vehicle is refused with one response at every price", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("ARCHIVED"));
  });

  test("a SOURCED record used as the trade-in is refused with one response at every price", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("SOURCED"));
  });

  test("a trade-in vehicle that already has a purchase price is refused with one response at every price", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("purchase price"));
  });

  test("a trade-in value with too many decimals is refused with one response at every price", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("more decimals"));
  });

  test("a valid trade-in on a cash sale is refused with the allocation overflow at every price, never the coded cost refusal", async () => {
    await expectCaseIdenticalAtEveryPrice(caseNamed("valid trade-in"));
  });

  test("a car whose supplier amount was never recorded answers every trade-in probe exactly as a car with one does", async () => {
    const s = await seed();
    const withCost = await consignedCar(s);
    const withoutCost = await consignedCar(s, null);
    for (const tradeInCase of TRADE_IN_CASES) {
      const tradeInWith = await tradeInCase.build(s, withCost);
      const tradeInWithout = await tradeInCase.build(s, withoutCost);
      const a = await refusalsAcrossPrices(PRICES, (price) => create(s, "nonReader", withCost, price, tradeInWith));
      const b = await refusalsAcrossPrices(PRICES, (price) => create(s, "nonReader", withoutCost, price, tradeInWithout));
      expectOneRefusalAtEveryPrice(a, tradeInCase.message, `${tradeInCase.name} (cost recorded)`);
      expectOneRefusalAtEveryPrice(b, tradeInCase.message, `${tradeInCase.name} (no cost recorded)`);
    }
  });

  test("the refused probes write nothing: no sale, no command row, no queued event, no payment, the car stays AVAILABLE", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const tradeIn = await tradeInCar(s);
    const before = await worldOf(s, car);
    await refusalsAcrossPrices(PRICES, (price) => create(s, "nonReader", car, price, { tradeInVehicleId: tradeIn, tradeInValue: 1 }));
    await refusalsAcrossPrices(PRICES, (price) => create(s, "nonReader", car, price, { tradeInVehicleId: car, tradeInValue: 1 }));
    expect(await worldOf(s, car)).toEqual(before);
    expect(before.vehicle?.status).toBe("AVAILABLE");
  });
});

describe("SCRUM-886 round 11: the draft door (sales.completeDraft) carries the same invariant", () => {
  test("a draft holding an invalid trade-in is refused identically at every price", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const refusals: Refusal[] = [];
    const drafts: Id<"sales">[] = [];
    for (const price of PRICES) {
      const saleId = await s.t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId: s.orgId, vehicleId: car, customerId: s.customerId, salespersonId: s.userIds.nonReader,
          salePrice: price, saleDate: Date.now(), status: "PENDING", financingType: "CASH",
          supplierSettlementRoute: "DIRECT_TO_SUPPLIER", tradeInVehicleId: car, tradeInValue: 1,
        })
      );
      drafts.push(saleId);
      refusals.push(
        await refusalDataOf(
          s.t.run((ctx) => completeExistingSale(ctx, { orgId: s.orgId, saleId, actorId: s.userIds.nonReader }))
        )
      );
    }
    expectOneRefusalAtEveryPrice(refusals, /cannot be traded in against its own sale/i, "completeDraft self trade-in");
    for (const saleId of drafts) {
      expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("PENDING");
    }
  });
});

describe("SCRUM-886 round 11: the deposit door (cost-derived deposit refusal) carries the same invariant", () => {
  /** A consigned car with a quote and one held deposit, completed on DIRECT_TO_SUPPLIER with the deposit applied to the settlement. */
  async function withDeposit(s: Seeded, car: Id<"vehicles">) {
    const quoteId = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId, customerId: s.customerId, vehicleId: car, mode: "CASH", vehiclePrice: 12_500,
        downPayment: 0, termMonths: 0, status: "ACCEPTED", createdBy: s.userIds.nonReader, createdAt: Date.now(),
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: car, customerId: s.customerId, quoteId,
        amount: DEPOSIT, amountMinor: DEPOSIT * 1000, currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdBy: s.userIds.nonReader, createdAt: Date.now(),
      })
    );
    return quoteId;
  }

  const settle = (s: Seeded, who: Who, car: Id<"vehicles">, quoteId: Id<"quotes">, price: number, tradeIn?: TradeIn) =>
    who === "nonReader"
      ? s.t.run((ctx) =>
          completeSale(ctx, {
            orgId: s.orgId, vehicleId: car, customerId: s.customerId, salespersonId: s.userIds.nonReader, salePrice: price,
            saleDate: Date.now(), status: "COMPLETED", quoteId, supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
            depositResolution: { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" }, actorId: s.userIds.nonReader, ...(tradeIn ?? {}),
          })
        )
      : s.actors[who].mutation(api.sales.create, {
          idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: car, customerId: s.customerId,
          salespersonId: s.userIds[who], salePrice: price, saleDate: Date.now(), status: "COMPLETED" as const,
          quoteId, supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
          depositResolution: { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" as const },
          ...(tradeIn ?? {}),
        });

  test("an invalid trade-in with a deposit applied to the supplier settlement is refused identically at every price", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const quoteId = await withDeposit(s, car);
    const refusals = await refusalsAcrossPrices(DEPOSIT_DOOR_PRICES, (price) =>
      settle(s, "nonReader", car, quoteId, price, { tradeInVehicleId: car, tradeInValue: 1 })
    );
    expectOneRefusalAtEveryPrice(refusals, /cannot be traded in against its own sale/i, "deposit door self trade-in");
  });

  test("a valid trade-in with a deposit applied to the supplier settlement is refused identically at every price", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const quoteId = await withDeposit(s, car);
    const tradeIn = await tradeInCar(s);
    const refusals = await refusalsAcrossPrices(DEPOSIT_DOOR_PRICES, (price) =>
      settle(s, "nonReader", car, quoteId, price, { tradeInVehicleId: tradeIn, tradeInValue: 1 })
    );
    expectOneRefusalAtEveryPrice(refusals, /Allocation amount 1000 exceeds receivable outstanding balance 0\./, "deposit door valid trade-in");
  });

  test("control: with no trade-in a non-reader gets the same coded refusal at every price, the threshold included, and a reader's sale at the threshold commits", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const quoteId = await withDeposit(s, car);
    const refusals = await refusalsAcrossPrices(DEPOSIT_DOOR_PRICES, (price) => settle(s, "nonReader", car, quoteId, price));
    expect(refusals[0]?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(refusals, "the shared gate refuses a non-reader at every price, the threshold included").toEqual(Array(refusals.length).fill(refusals[0]));
    expect(refusals[0]?.message).not.toMatch(ENTITLEMENT_LEAK);
    expect((await worldOf(s, car)).vehicle?.status).toBe("AVAILABLE");
    const saleId = await settle(s, "reader", car, quoteId, DEPOSIT_DOOR_PRICES[2]);
    expect(saleId).toBeTruthy();
    expect((await worldOf(s, car)).vehicle?.status).toBe("SOLD");
  });
});

describe("SCRUM-886 round 11: controls that must hold before and after the reorder", () => {
  test("a non-reader with no trade-in gets the same coded refusal at every price including the entitlement, and a reader's sale at the entitlement commits", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const far = await refusalDataOf(create(s, "nonReader", car, 1));
    const oneFilsShort = await refusalDataOf(create(s, "nonReader", car, ONE_FILS_SHORT));
    const atEntitlement = await refusalDataOf(create(s, "nonReader", car, ENTITLEMENT));
    expect(far?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(oneFilsShort).toEqual(far);
    expect(atEntitlement, "the shared gate refuses a non-reader at the entitlement too").toEqual(far);
    expect(far?.message).not.toMatch(ENTITLEMENT_LEAK);
    expect((await worldOf(s, car)).vehicle?.status).toBe("AVAILABLE");
    const saleId = await create(s, "reader", car, ENTITLEMENT);
    expect(saleId).toBeTruthy();
    expect((await worldOf(s, car)).vehicle?.status).toBe("SOLD");
  });

  test("a view:cost_price holder and the system owner still get the detailed shortfall sentence when no trade-in is sent", async () => {
    const s = await seed();
    for (const who of ["reader", "owner"] as const) {
      const car = await consignedCar(s);
      const refusal = await refusalDataOf(create(s, who, car, ONE_FILS_SHORT));
      expect(refusal?.code, who).toBeUndefined();
      expect(refusal?.message, who).toContain("against an entitlement of 8765.432");
    }
  });

  test("a trade-in the sale cannot accept is still refused for a reader and for the owner, with the trade-in sentence", async () => {
    const s = await seed();
    for (const who of ["reader", "owner"] as const) {
      const car = await consignedCar(s);
      const refusal = await refusalDataOf(create(s, who, car, 20_000, { tradeInVehicleId: car, tradeInValue: 1 }));
      expect(refusal?.message, who).toMatch(/cannot be traded in against its own sale/i);
    }
  });
});
