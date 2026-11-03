/**
 * SCRUM-886 round 12 (OWASP API3:2023, property-level authorization: the OUTCOME of a mutation is a read channel).
 *
 * Round 11 made every refusal a caller can aim with the arguments of ONE sale decided before that sale's consigned cost gate.
 * Both review seats then found the same oracle one level up: a quote with several lines completes through
 * `sales.completeFromQuote` -> `completeSalesForLineItems`, which used to complete line 1 in full (its cost gate included) and
 * only then begin line 2. So line 2's refusals (archived, in inspection, deleted, the same car twice, held by another deal,
 * the deposit-stage refusals) came AFTER line 1's cost gate. A caller with `create:sales` but without `view:cost_price` could
 * save a two-line quote whose second line is refused and bisect line 1's price: below the stored supplier entitlement E the
 * answer was the coded `CONSIGNED_SALE_NEEDS_COST_ACCESS`, at or above it the line-2 refusal. About 25 refused calls give E
 * to the fils, and every refused call writes nothing.
 *
 * Invariant (round 12, command level): no cost-tier-dependent decision (the consigned cost gate and the cost-derived deposit
 * refusal) runs before every caller-controlled refusal of the WHOLE command. For a caller who cannot read vehicle cost the
 * response at E - 0.001, E, 1 and 20,000 is byte-identical for every refusal the caller can trigger, and the only response that
 * may differ with the price is "a coded cost refusal" versus "a sale that really committed", which is the sale outcome itself.
 *
 * Every test goes through public mutations (`quotes.saveQuote`, `sales.completeFromQuote`, `vehicles.update`, `sales.create`).
 * Expected values are literals from the seeded rows: a supplier entitlement of 8,765.432 JOD (8765432 fils) on the first line.
 *
 * ROUND 13 (owner ruling SCRUM-886 comment 24358): the doors now refuse a caller who cannot read vehicle cost, for any SOURCED
 * car, as their first decision (convex/consignedSaleCostAccessRule.scrum886.test.ts). A non-reader therefore never reaches the code
 * these tests are about. They are kept as DEFENCE IN DEPTH: the non-reader completions below run the shared completion code
 * (`completeSalesForLineItems` / `completeSale`) directly, as the same non-reader actor and without the door check, which is what
 * a future caller that forgot the door check would do. Reader and owner calls still go through the public doors unchanged. The
 * three-phase ordering inside the shared code is unchanged and still proved; what changed is that a non-reader's sale at or above
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
import { completeSale, completeSalesForLineItems } from "./utils/saleCompletion";

const NEEDS_COST_ACCESS_CODE = "CONSIGNED_SALE_NEEDS_COST_ACCESS";
const ENTITLEMENT = 8_765.432;
const ONE_FILS_SHORT = 8_765.431;
/** The four prices the invariant names: one fils short, exactly the entitlement, far below, far above. */
const PRICES = [ONE_FILS_SHORT, ENTITLEMENT, 1, 20_000] as const;
const SECOND_LINE_PRICE = 5_000;
const SECOND_LINE_ENTITLEMENT = 1_000;
const DEPOSIT = 1_000;
/** The deposit door's threshold is the entitlement PLUS the deposit (the margin must cover the deposit). */
const DEPOSIT_DOOR_PRICES = [ENTITLEMENT + DEPOSIT - 0.001, ENTITLEMENT + DEPOSIT, 1, 20_000] as const;

const SALES_NO_COST = ["view:sales", "create:sales", "view:vehicles", "view:customers"];
const SALES_WITH_COST = [...SALES_NO_COST, "view:cost_price"];

type Who = "owner" | "nonReader" | "reader";
type Refusal = { code?: string; message: string } | null;

async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Batch Precedence", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"], commissionMode: "MANUAL",
    })
  );
  const specs: Record<Who, string[] | "owner"> = { owner: "owner", nonReader: SALES_NO_COST, reader: SALES_WITH_COST };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  const userIds = {} as Record<Who, Id<"users">>;
  for (const who of Object.keys(specs) as Who[]) {
    const clerkId = `scrum886b_${who}`;
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
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Batch" }));
  return { t, orgId, actors, userIds, customerId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

afterEach(() => vi.useRealTimers());

let vinCounter = 0;
const nextVin = (prefix: string) => `${prefix}${String((vinCounter += 1)).padStart(6, "0")}`;

/** A consigned car. `sourceCost` null models a car whose supplier amount was never recorded. */
async function consignedCar(
  s: Seeded,
  sourceCost: number | null = ENTITLEMENT,
  status: Doc<"vehicles">["status"] = "AVAILABLE"
): Promise<Id<"vehicles">> {
  return await s.t.run(async (ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: nextVin("VIN886BATC"), make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status,
      sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      sourcedSupplierId: await supplierIdInCtx(ctx, s.orgId, "Amman Importer Co"),
      ...(sourceCost !== null ? { sourceCost } : {}),
    })
  );
}

type Item = { vehicleId: Id<"vehicles">; unitPrice: number };
const total = (items: Item[]) => items.reduce((sum, item) => sum + item.unitPrice, 0);

/** Saves a CASH quote through the public mutation, as the sales wizard does. */
async function saveQuote(s: Seeded, items: Item[]): Promise<Id<"quotes">> {
  return (await s.actors.nonReader.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: items[0].vehicleId, mode: "CASH",
    vehicleItems: items, vehiclePrice: total(items), downPayment: 0, termMonths: 0,
  } as never)) as Id<"quotes">;
}

/** A quote `saveQuote` would refuse (the same car twice), inserted as the stored shape. */
async function insertQuote(s: Seeded, items: Item[]): Promise<Id<"quotes">> {
  return await s.t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId, customerId: s.customerId, vehicleId: items[0].vehicleId, mode: "CASH",
      vehicleItems: items, vehiclePrice: total(items), downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: s.userIds.nonReader, createdAt: Date.now(),
    })
  );
}

/** An owner edit through the public mutation: archive a consigned car after the quote was saved. */
const archive = (s: Seeded, vehicleId: Id<"vehicles">) =>
  s.actors.owner.mutation(api.vehicles.update, {
    orgId: s.orgId, vehicleId, sourceType: "SOURCED" as const, status: "ARCHIVED" as const,
  });

const completeQuote = (s: Seeded, who: Who, quoteId: Id<"quotes">, depositTreatment = false) =>
  who === "nonReader"
    ? s.t.run(async (ctx) => {
        const quote = await ctx.db.get(quoteId);
        if (!quote) throw new Error("quote missing");
        return await completeSalesForLineItems(ctx, {
          orgId: s.orgId, quoteId, vehicleItems: quote.vehicleItems ?? [{ vehicleId: quote.vehicleId, unitPrice: quote.vehiclePrice }],
          customerId: quote.customerId, salespersonId: s.userIds.nonReader, saleDate: Date.now(), downPayment: quote.downPayment,
          financingType: "CASH", supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
          ...(depositTreatment ? { depositResolution: { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" as const } } : {}),
          actorId: s.userIds.nonReader,
        });
      })
    : s.actors[who].mutation(api.sales.completeFromQuote, {
        orgId: s.orgId, quoteId, idempotencyKey: crypto.randomUUID(),
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
        ...(depositTreatment ? { depositResolution: { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" as const } } : {}),
      });

/** Everything a refused command must leave alone. */
async function worldOf(s: Seeded) {
  return s.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").take(1000)).length,
    commands: (await ctx.db.query("commandIdempotency").take(1000)).length,
    queued: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
    payments: (await ctx.db.query("canonicalPayments").take(1000)).length,
    applications: (await ctx.db.query("depositApplications").take(1000)).length,
    vehicles: (await ctx.db.query("vehicles").take(1000)).map((v) => [v._id, v.status, v.isDeleted === true]),
    deposits: (await ctx.db.query("deposits").take(1000)).map((d) => [d._id, d.status, d.holdActive === true]),
    holds: (await ctx.db.query("depositVehicleHolds").take(1000)).map((h) => [h._id, h.active, h.allocationStatus ?? null]),
  }));
}

/** Any rendering of the entitlement, as major units, minor units, or grouped thousands. */
const ENTITLEMENT_LEAK = /8[,. ]?765|765[.,]?432|8765432/;

/** The invariant: one refusal, byte-identical at every price, and never the coded cost-access refusal. */
function expectOneRefusalAtEveryPrice(refusals: Refusal[], message: RegExp, label: string) {
  const [first] = refusals;
  // The oracle itself, stated first so a failure shows the two responses that differ.
  expect(refusals, `${label}: the response must not vary with the price`).toEqual(Array(refusals.length).fill(first));
  expect(first, `${label}: refused`).not.toBeNull();
  expect(first?.code, `${label}: not the coded cost refusal`).not.toBe(NEEDS_COST_ACCESS_CODE);
  expect(first?.message, `${label}: states the caller-aimed refusal`).toMatch(message);
  expect(first?.message, `${label}: names no entitlement`).not.toMatch(ENTITLEMENT_LEAK);
}

/**
 * One fresh world per price: the quote carries its prices, so a refused call cannot be re-run with another price on the same
 * quote. `build` makes the cars and the quote and returns the quote id; the call under test is the same for every price.
 */
async function refusalsAcrossPrices(
  prices: readonly number[],
  build: (s: Seeded, price: number) => Promise<{ quoteId: Id<"quotes">; depositTreatment?: boolean }>
): Promise<{ refusals: Refusal[]; before: unknown[]; after: unknown[] }> {
  const refusals: Refusal[] = [];
  const before: unknown[] = [];
  const after: unknown[] = [];
  for (const price of prices) {
    const s = await seed();
    const { quoteId, depositTreatment } = await build(s, price);
    before.push(await worldOf(s));
    refusals.push(await refusalDataOf(completeQuote(s, "nonReader", quoteId, depositTreatment)));
    after.push(await worldOf(s));
  }
  return { refusals, before, after };
}

async function expectBatchCaseClosed(
  build: (s: Seeded, price: number) => Promise<{ quoteId: Id<"quotes">; depositTreatment?: boolean }>,
  message: RegExp,
  label: string,
  prices: readonly number[] = PRICES
) {
  const { refusals, before, after } = await refusalsAcrossPrices(prices, build);
  expectOneRefusalAtEveryPrice(refusals, message, label);
  expect(after, `${label}: the refused command wrote nothing`).toEqual(before);
}

/** Line 1: the consigned car whose price the caller varies. Line 2: a second consigned car the caller makes unsellable. */
async function twoLines(s: Seeded, price: number) {
  const first = await consignedCar(s);
  const second = await consignedCar(s, SECOND_LINE_ENTITLEMENT);
  return { first, second, items: [{ vehicleId: first, unitPrice: price }, { vehicleId: second, unitPrice: SECOND_LINE_PRICE }] };
}

describe("SCRUM-886 round 12: sales.completeFromQuote, a caller-aimed refusal on a LATER line is the same at every price of the first", () => {
  test("a second line archived after the quote was saved is refused with one response at one fils short, the entitlement, 1 and 20,000", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const { second, items } = await twoLines(s, price);
      const quoteId = await saveQuote(s, items);
      await archive(s, second);
      return { quoteId };
    }, /Cannot sell an archived vehicle/i, "second line archived");
  });

  test("a second line in inspection (quotable, not sellable) is refused with one response at every price", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const first = await consignedCar(s);
      const second = await consignedCar(s, SECOND_LINE_ENTITLEMENT, "IN_INSPECTION");
      const quoteId = await saveQuote(s, [{ vehicleId: first, unitPrice: price }, { vehicleId: second, unitPrice: SECOND_LINE_PRICE }]);
      return { quoteId };
    }, /inspection|repair|not ready/i, "second line in inspection");
  });

  test("a second line that was soft-deleted after the quote was saved is refused with one response at every price", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const { second, items } = await twoLines(s, price);
      const quoteId = await saveQuote(s, items);
      await s.t.run((ctx) => ctx.db.patch(second, { isDeleted: true }));
      return { quoteId };
    }, /deleted|not found/i, "second line soft-deleted");
  });

  test("a second line already sold after the quote was saved is refused with one response at every price", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const { second, items } = await twoLines(s, price);
      const quoteId = await saveQuote(s, items);
      await s.t.run((ctx) => ctx.db.patch(second, { status: "SOLD" }));
      return { quoteId };
    }, /already been sold/i, "second line already sold");
  });

  test("the same car on two lines of one quote is refused with one response at every price of the first line", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const first = await consignedCar(s);
      const quoteId = await insertQuote(s, [{ vehicleId: first, unitPrice: price }, { vehicleId: first, unitPrice: SECOND_LINE_PRICE }]);
      return { quoteId };
    }, /already been sold/i, "same car on two lines");
  });

  test("a second line held by a finance application is refused with one response at every price", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const { second, items } = await twoLines(s, price);
      const quoteId = await saveQuote(s, items);
      await s.t.run(async (ctx) => {
        const rootId = await ctx.db.insert("commitmentRoots", {
          orgId: s.orgId, vehicleId: second, customerId: s.customerId, status: "OPEN",
          openedAt: Date.now(), openedBy: s.userIds.owner,
        });
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: s.orgId, rootId, vehicleId: second, evidenceKind: "FINANCE", status: "ACTIVE",
          createdAt: Date.now(), createdBy: s.userIds.owner,
        });
      });
      return { quoteId };
    }, /finance application in progress/i, "second line held by a finance application");
  });

  test("a middle line that is archived is refused with one response at every price of the first line, with a third line behind it", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const first = await consignedCar(s);
      const middle = await consignedCar(s, SECOND_LINE_ENTITLEMENT);
      const last = await consignedCar(s, SECOND_LINE_ENTITLEMENT);
      const quoteId = await saveQuote(s, [
        { vehicleId: first, unitPrice: price }, { vehicleId: middle, unitPrice: SECOND_LINE_PRICE }, { vehicleId: last, unitPrice: SECOND_LINE_PRICE },
      ]);
      await archive(s, middle);
      return { quoteId };
    }, /Cannot sell an archived vehicle/i, "middle line archived");
  });

  test("the cost-gated car in the MIDDLE of three lines does not tell the caller anything either: the last line is archived", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const head = await consignedCar(s, SECOND_LINE_ENTITLEMENT);
      const gated = await consignedCar(s);
      const last = await consignedCar(s, SECOND_LINE_ENTITLEMENT);
      const quoteId = await saveQuote(s, [
        { vehicleId: head, unitPrice: SECOND_LINE_PRICE }, { vehicleId: gated, unitPrice: price }, { vehicleId: last, unitPrice: SECOND_LINE_PRICE },
      ]);
      await archive(s, last);
      return { quoteId };
    }, /Cannot sell an archived vehicle/i, "gated car in the middle");
  });

  test("a first line whose supplier amount was never recorded answers a later-line refusal exactly as a first line with one does", async () => {
    const withCost = await refusalsAcrossPrices(PRICES, async (s, price) => {
      const { second, items } = await twoLines(s, price);
      const quoteId = await saveQuote(s, items);
      await archive(s, second);
      return { quoteId };
    });
    const withoutCost = await refusalsAcrossPrices(PRICES, async (s, price) => {
      const first = await consignedCar(s, null);
      const second = await consignedCar(s, SECOND_LINE_ENTITLEMENT);
      const quoteId = await saveQuote(s, [{ vehicleId: first, unitPrice: price }, { vehicleId: second, unitPrice: SECOND_LINE_PRICE }]);
      await archive(s, second);
      return { quoteId };
    });
    expectOneRefusalAtEveryPrice(withCost.refusals, /Cannot sell an archived vehicle/i, "cost recorded");
    expectOneRefusalAtEveryPrice(withoutCost.refusals, /Cannot sell an archived vehicle/i, "no cost recorded");
    expect(withoutCost.refusals[0]).toEqual(withCost.refusals[0]);
  });

  test("the later-line refusal is the very response the same car gets from a single sale, so the batch adds no new text", async () => {
    const s = await seed();
    const { second, items } = await twoLines(s, ENTITLEMENT);
    const quoteId = await saveQuote(s, items);
    await archive(s, second);
    const batch = await refusalDataOf(completeQuote(s, "nonReader", quoteId));
    const single = await refusalDataOf(
      s.t.run((ctx) =>
        completeSale(ctx, {
          orgId: s.orgId, vehicleId: second, customerId: s.customerId, salespersonId: s.userIds.nonReader,
          salePrice: SECOND_LINE_PRICE, saleDate: Date.now(), status: "COMPLETED", supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
          actorId: s.userIds.nonReader,
        })
      )
    );
    expect(batch).toEqual(single);
  });
});

describe("SCRUM-886 round 12: the deposit stage of a later line is decided before the first line's cost gate", () => {
  /**
   * Two lines on one quote with one held deposit. `shares` is the deposit allocated to each car in fils; `undefined` leaves
   * that car's hold unallocated (not zero), which is a multi-vehicle quote nobody has split yet.
   */
  async function depositQuote(s: Seeded, price: number, shares: [number | undefined, number | undefined], lastCar = SECOND_LINE_ENTITLEMENT) {
    const first = await consignedCar(s);
    const second = await consignedCar(s, lastCar);
    const quoteId = await insertQuote(s, [{ vehicleId: first, unitPrice: price }, { vehicleId: second, unitPrice: SECOND_LINE_PRICE }]);
    const heldMajor = ((shares[0] ?? 0) + (shares[1] ?? 0)) / 1000;
    const depositId = await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: first, customerId: s.customerId, quoteId,
        amount: heldMajor, amountMinor: heldMajor * 1000, currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdBy: s.userIds.nonReader, createdAt: Date.now(),
      })
    );
    for (const [vehicleId, share] of [[first, shares[0]], [second, shares[1]]] as const) {
      await s.t.run((ctx) =>
        ctx.db.insert("depositVehicleHolds", {
          orgId: s.orgId, depositId, vehicleId, active: true, createdAt: Date.now(),
          ...(share !== undefined ? { allocatedAmountMinor: share, allocationStatus: "ALLOCATED" as const } : {}),
        })
      );
    }
    return { quoteId, first, second };
  }

  test("a second line whose deposit share was never allocated is refused with the allocation text at every price of the first line", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const { quoteId } = await depositQuote(s, price, [0, undefined]);
      return { quoteId };
    }, /has not been allocated between them/i, "second line deposit not allocated");
  });

  test("a second line whose deposit share exceeds what the dealership billed is refused with one response at every price of the first line", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const { quoteId } = await depositQuote(s, price, [0, 600_000]);
      return { quoteId };
    }, /larger than what the dealership billed|exceeds what the dealership billed|deposit/i, "second line deposit larger than the bill");
  });

  test("an archived second line with a deposit applied to the first line's supplier settlement is refused identically at every price", async () => {
    await expectBatchCaseClosed(async (s, price) => {
      const { quoteId, second } = await depositQuote(s, price, [DEPOSIT * 1000, 0]);
      await archive(s, second);
      return { quoteId, depositTreatment: true };
    }, /Cannot sell an archived vehicle/i, "deposit door with a later archived line", DEPOSIT_DOOR_PRICES);
  });

  test("control: the same deposit door with nothing wrong on the second line gives a non-reader the same coded refusal at and below the threshold, and a reader two sales at it", async () => {
    const refused = await refusalsAcrossPrices(DEPOSIT_DOOR_PRICES.slice(0, 2), async (s, price) => {
      const { quoteId } = await depositQuote(s, price, [DEPOSIT * 1000, 0]);
      return { quoteId, depositTreatment: true };
    });
    expect(refused.refusals[0]?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(refused.refusals[1], "the shared gate refuses a non-reader at the threshold too").toEqual(refused.refusals[0]);
    expect(refused.refusals[0]?.message).not.toMatch(ENTITLEMENT_LEAK);
    expect(refused.after).toEqual(refused.before);
    const s = await seed();
    const { quoteId, first, second } = await depositQuote(s, DEPOSIT_DOOR_PRICES[1], [DEPOSIT * 1000, 0]);
    expect(await completeQuote(s, "reader", quoteId, true)).toHaveLength(2);
    const sold = await s.t.run(async (ctx) => [(await ctx.db.get(first))?.status, (await ctx.db.get(second))?.status]);
    expect(sold).toEqual(["SOLD", "SOLD"]);
  });
});

describe("SCRUM-886 round 12: controls that must hold before and after the restructure", () => {
  test("a non-reader with nothing wrong on the later line gets the same coded refusal at every price including the entitlement, and a reader gets two sales at it", async () => {
    const belowRefusals = await refusalsAcrossPrices([ONE_FILS_SHORT, 1, ENTITLEMENT], async (s, price) => {
      const { items } = await twoLines(s, price);
      return { quoteId: await saveQuote(s, items) };
    });
    expect(belowRefusals.refusals[0]?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(belowRefusals.refusals[1]).toEqual(belowRefusals.refusals[0]);
    expect(belowRefusals.refusals[2], "the shared gate refuses a non-reader at the entitlement too").toEqual(belowRefusals.refusals[0]);
    expect(belowRefusals.refusals[0]?.message).not.toMatch(ENTITLEMENT_LEAK);
    expect(belowRefusals.after).toEqual(belowRefusals.before);

    const s = await seed();
    const { first, second, items } = await twoLines(s, ENTITLEMENT);
    const saleIds = await completeQuote(s, "reader", await saveQuote(s, items));
    expect(saleIds).toHaveLength(2);
    const state = await s.t.run(async (ctx) => ({
      cars: [(await ctx.db.get(first))?.status, (await ctx.db.get(second))?.status],
      sales: (await ctx.db.query("sales").take(10)).length,
    }));
    expect(state).toEqual({ cars: ["SOLD", "SOLD"], sales: 2 });
  });

  test("a view:cost_price holder and the system owner still get the detailed shortfall sentence when no later line is refused", async () => {
    for (const who of ["reader", "owner"] as const) {
      const s = await seed();
      const { items } = await twoLines(s, ONE_FILS_SHORT);
      const refusal = await refusalDataOf(completeQuote(s, who, await saveQuote(s, items)));
      expect(refusal?.code, who).toBeUndefined();
      expect(refusal?.message, who).toContain("against an entitlement of 8765.432");
    }
  });

  test("a later-line refusal is still stated for a reader and for the owner", async () => {
    for (const who of ["reader", "owner"] as const) {
      const s = await seed();
      const { second, items } = await twoLines(s, 20_000);
      const quoteId = await saveQuote(s, items);
      await archive(s, second);
      const refusal = await refusalDataOf(completeQuote(s, who, quoteId));
      expect(refusal?.message, who).toMatch(/Cannot sell an archived vehicle/i);
    }
  });
});

describe("SCRUM-886 round 12 (round 11 fifth mutant): sales.create, a valid trade-in on a THROUGH_DEALERSHIP consigned sale carries the same invariant", () => {
  /**
   * The route matters: on THROUGH_DEALERSHIP the customer is billed the whole price, so a deposit equal to the price is the only
   * way to pass the pay-first containment, and the trade-in then finds the invoice already settled to nil.
   */
  async function throughDealershipWorld(price: number) {
    const s = await seed();
    const car = await consignedCar(s);
    const tradeIn = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: nextVin("VIN886TRAD"), make: "Honda", model: "Civic", year: 2019, mileage: 80_000,
        color: "Grey", fuelType: "Gas", transmission: "Auto", sellingPrice: 4_000, status: "AVAILABLE",
      })
    );
    const quoteId = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId, customerId: s.customerId, vehicleId: car, mode: "CASH", vehiclePrice: price,
        downPayment: 0, termMonths: 0, status: "ACCEPTED", createdBy: s.userIds.nonReader, createdAt: Date.now(),
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: car, customerId: s.customerId, quoteId,
        amount: price, amountMinor: Math.round(price * 1000), currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdBy: s.userIds.nonReader, createdAt: Date.now(),
      })
    );
    return { s, car, tradeIn, quoteId };
  }

  test("a valid trade-in on a THROUGH_DEALERSHIP consigned cash sale is refused with the allocation overflow at every price, never the coded cost refusal", async () => {
    const refusals: Refusal[] = [];
    for (const price of PRICES) {
      const { s, car, tradeIn, quoteId } = await throughDealershipWorld(price);
      refusals.push(
        await refusalDataOf(
          s.t.run((ctx) =>
            completeSale(ctx, {
              orgId: s.orgId, vehicleId: car, customerId: s.customerId, salespersonId: s.userIds.nonReader, salePrice: price,
              saleDate: Date.now(), status: "COMPLETED", quoteId, supplierSettlementRoute: "THROUGH_DEALERSHIP",
              tradeInVehicleId: tradeIn, tradeInValue: 1, actorId: s.userIds.nonReader,
            })
          )
        )
      );
    }
    expectOneRefusalAtEveryPrice(refusals, /Allocation amount 1000 exceeds receivable outstanding balance 0\./, "through dealership valid trade-in");
  });
});
