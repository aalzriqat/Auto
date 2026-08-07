/**
 * Allocating one reservation deposit across the cars on a multi-vehicle quote.
 *
 * ## The shape these tests use, and why it matters
 *
 * `deposits.create` writes exactly ONE `deposits` row per quote — one عربون,
 * one receipt voucher, one payment — and records the extra cars on
 * `depositVehicleHolds`. The row's own `vehicleId` is only ever the quote's
 * first line item.
 *
 * An earlier attempt at this scoped sale completion by `deposit.vehicleId` and
 * proved it with tests that inserted two synthetic deposit rows by hand. Those
 * tests passed against a shape production never creates, so they validated the
 * patch and not the behaviour: in the real shape, the first car absorbed the
 * whole deposit and every other car looked undeposited. Every fixture here goes
 * through `api.deposits.create` for that reason.
 *
 * ## What is being pinned
 *
 * The split is a stored decision, never a calculation. No FIFO, no
 * proportional-to-price, no `min(deposit, thisCarsBill)`, and never the deposit
 * row's own `vehicleId`. A quote with more than one car cannot finalize any of
 * them until somebody says how the money divides.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales", "delete:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "manage:finance", "view:finance", "view:expenses", "view:reports",
];

const PRICE_A = 3_000;
const PRICE_B = 20_000;
const DEPOSIT = 5_000;
const SCALE = 1000; // JOD minor units

async function seed(tag: string, opts: { vehicleCount?: 1 | 2 } = {}) {
  const vehicleCount = opts.vehicleCount ?? 2;
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Alloc ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Sales" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  // Refunds and forfeitures may not be actioned by whoever took the deposit.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_m`, email: `${tag}m@e.com`, name: "Manager" })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Manager", permissions: PERMS })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const asManager = t.withIdentity({ subject: `${tag}_m`, clerkId: `${tag}_m` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );

  const makeVehicle = async (suffix: string, price: number) =>
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VINALLOC${tag}${suffix}`, make: "Toyota", model: `M${suffix}`,
        year: 2024, mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: price, status: "AVAILABLE", sourceType: "STOCK",
        purchasePrice: Math.round(price * 0.8),
      })
    );

  const vehicleA = await makeVehicle("A", PRICE_A);
  const vehicleB = vehicleCount === 2 ? await makeVehicle("B", PRICE_B) : null;

  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId: vehicleA,
      vehiclePrice: vehicleB ? PRICE_A + PRICE_B : PRICE_A,
      ...(vehicleB
        ? {
            vehicleItems: [
              { vehicleId: vehicleA, unitPrice: PRICE_A },
              { vehicleId: vehicleB, unitPrice: PRICE_B },
            ],
          }
        : {}),
      downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    })
  );

  return { t, orgId, userId, managerId, asUser, asManager, customerId, vehicleA, vehicleB, quoteId };
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** The real path: one deposit row plus a hold row per car. */
async function payDeposit(s: Seed, amount = DEPOSIT) {
  await s.asUser.mutation(api.deposits.create, {
    orgId: s.orgId,
    quoteId: s.quoteId,
    amount,
    method: "CASH" as const,
  });
}

const allocate = (s: Seed, allocations: Array<{ vehicleId: Id<"vehicles">; amount: number }>) =>
  s.asUser.mutation(api.deposits.allocateToVehicles, {
    orgId: s.orgId,
    quoteId: s.quoteId,
    allocations,
  });

async function sell(
  s: Seed,
  vehicleId: Id<"vehicles">,
  salePrice: number,
  opts: { actor?: Seed["asUser"] } = {}
) {
  return await (opts.actor ?? s.asUser).mutation(api.sales.create, {
    orgId: s.orgId,
    vehicleId,
    customerId: s.customerId,
    salespersonId: s.userId,
    salePrice,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    quoteId: s.quoteId,
  });
}

const allocationView = (s: Seed) =>
  s.asUser.query(api.deposits.quoteAllocation, { orgId: s.orgId, quoteId: s.quoteId });

const saleTransactionFor = async (s: Seed, vehicleId: Id<"vehicles">) =>
  await s.t.run(async (ctx) =>
    (await ctx.db.query("transactions").collect()).find(
      (tx) => tx.orgId === s.orgId && tx.category === "VEHICLE_SALE" && tx.vehicleId === vehicleId
    )
  );

// ─── The shape itself ────────────────────────────────────────────────────────

describe("what the application actually writes", () => {
  test("one deposit row for the whole quote, and a hold row per car", async () => {
    // The premise everything else rests on. If this ever changes, the scoping
    // rules below have to change with it.
    const s = await seed("shape");
    await payDeposit(s);

    const deposits = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).filter((d) => d.orgId === s.orgId)
    );
    expect(deposits).toHaveLength(1);
    // And its own vehicleId is the FIRST line item, which is not an allocation.
    expect(deposits[0]!.vehicleId).toBe(s.vehicleA);

    const holds = await s.t.run((ctx) => ctx.db.query("depositVehicleHolds").collect());
    expect(holds.map((h) => h.vehicleId).sort()).toEqual([s.vehicleA, s.vehicleB].sort());
    // Created unallocated: nobody has said how the money divides yet.
    expect(holds.every((h) => h.allocatedAmountMinor === undefined)).toBe(true);
  });
});

// ─── 1. Single vehicle ───────────────────────────────────────────────────────

describe("a single-vehicle quote", () => {
  test("allocates the whole deposit to its one car without being asked", async () => {
    // One place the money can go and no decision to make.
    const s = await seed("single", { vehicleCount: 1 });
    await payDeposit(s, 1_000);

    await sell(s, s.vehicleA, PRICE_A);

    const tx = await saleTransactionFor(s, s.vehicleA);
    expect(tx!.amount).toBe(PRICE_A - 1_000);
    const deposit = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)
    );
    expect(deposit!.status).toBe("APPLIED");
  });

  test("refuses an explicit allocation, because there is nothing to divide", async () => {
    const s = await seed("singleAlloc", { vehicleCount: 1 });
    await payDeposit(s, 1_000);

    await expect(allocate(s, [{ vehicleId: s.vehicleA, amount: 1_000 }])).rejects.toThrow(
      /single vehicle/i
    );
  });

  test("an excess deposit on a single-vehicle quote still needs a resolution", async () => {
    // `deposits.create` caps the deposit at the quote total, so the excess can
    // only arise the way it does in life: the car finally sells for less than
    // the customer put down.
    const s = await seed("singleExcess", { vehicleCount: 1 });
    await payDeposit(s, PRICE_A);

    await expect(sell(s, s.vehicleA, PRICE_A - 500)).rejects.toThrow(
      /larger than what the dealership billed/i
    );
  });
});

// ─── 2. Two vehicles ─────────────────────────────────────────────────────────

describe("a two-vehicle quote", () => {
  test("cannot finalize either car until the deposit is allocated", async () => {
    // The rule. Not FIFO, not proportional, not the deposit row's vehicleId —
    // no answer at all until a person gives one.
    const s = await seed("unallocated");
    await payDeposit(s);

    await expect(sell(s, s.vehicleA, PRICE_A)).rejects.toThrow(/has not been allocated/i);
    await expect(sell(s, s.vehicleB!, PRICE_B)).rejects.toThrow(/has not been allocated/i);
  });

  test("finalizing A evaluates only A's share", async () => {
    // The worked example: 3,000 / 2,000 of a 5,000 deposit.
    const s = await seed("allocated");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    await sell(s, s.vehicleA, PRICE_A);

    // A's invoice cleared by exactly its own 3,000 — not by the whole 5,000,
    // which would have driven it negative.
    const tx = await saleTransactionFor(s, s.vehicleA);
    expect(tx!.amount).toBe(0);

    // B's 2,000 is untouched and B is still on hold.
    const view = await allocationView(s);
    const b = view!.vehicles.find((v) => v.vehicleId === s.vehicleB)!;
    expect(b.allocatedMinor).toBe(2_000 * SCALE);
    expect(b.status).toBe("ALLOCATED");
    const holdB = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find((h) => h.vehicleId === s.vehicleB)
    );
    expect(holdB!.active).toBe(true);
  });

  test("the deposit row stays HELD until the last car consumes its share", async () => {
    // A row cannot be half-APPLIED, so its status follows the last allocation.
    const s = await seed("rowStatus");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    await sell(s, s.vehicleA, PRICE_A);
    const midway = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)
    );
    expect(midway!.status).toBe("HELD");

    await sell(s, s.vehicleB!, PRICE_B);
    const after = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)
    );
    expect(after!.status).toBe("APPLIED");
  });

  test("both applications reach the ledger, not just the first", async () => {
    // One deposit row applied twice is two movements of money. Keyed on the
    // deposit alone, the second silently deduped away and the ledger recorded
    // one application where the subledger recorded two.
    const s = await seed("twoEvents");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    await sell(s, s.vehicleA, PRICE_A);
    await sell(s, s.vehicleB!, PRICE_B);

    const events = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").collect()).filter(
        (e) => e.orgId === s.orgId && e.eventType === "DEPOSIT_APPLIED" && e.status === "POSTED"
      )
    );
    expect(events).toHaveLength(2);
  });
});

// ─── 3-4. Partial allocation and the unallocated remainder ───────────────────

describe("a partial allocation", () => {
  test("leaves the remainder as a quote-level balance, not as spare change", async () => {
    // 1,000 / 2,000 of 5,000: the other 2,000 belongs to nobody yet and stays
    // a customer deposit liability.
    const s = await seed("partial");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 1_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    const view = await allocationView(s);
    expect(view!.allocatedMinor).toBe(3_000 * SCALE);
    expect(view!.unallocatedMinor).toBe(2_000 * SCALE);
  });

  test("the unallocated remainder is never swept into a completing sale", async () => {
    const s = await seed("partialSell");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 1_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    await sell(s, s.vehicleA, PRICE_A);

    // A consumed 1,000 and only 1,000.
    const tx = await saleTransactionFor(s, s.vehicleA);
    expect(tx!.amount).toBe(PRICE_A - 1_000);
    const view = await allocationView(s);
    expect(view!.unallocatedMinor).toBe(2_000 * SCALE);
  });

  test("a car explicitly allocated zero can complete on that basis", async () => {
    // Explicit zero is a decision and is not the same as unallocated.
    const s = await seed("zeroAlloc");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 0 },
      { vehicleId: s.vehicleB!, amount: 5_000 },
    ]);

    await sell(s, s.vehicleA, PRICE_A);
    const tx = await saleTransactionFor(s, s.vehicleA);
    expect(tx!.amount).toBe(PRICE_A);
  });

  test("allocations totalling more than the deposit are refused", async () => {
    const s = await seed("overAlloc");
    await payDeposit(s);

    await expect(
      allocate(s, [
        { vehicleId: s.vehicleA, amount: 3_000 },
        { vehicleId: s.vehicleB!, amount: 2_500 },
      ])
    ).rejects.toThrow(/more than the deposit has left to give/i);
  });

  test("editing one car's allocation is checked against the other's", async () => {
    // Vehicles left out of the call keep what they had, so the invariant holds
    // across the whole quote rather than only the part being edited.
    const s = await seed("editAlloc");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 1_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    await expect(allocate(s, [{ vehicleId: s.vehicleA, amount: 4_000 }])).rejects.toThrow(
      /more than the deposit has left to give/i
    );
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    const view = await allocationView(s);
    expect(view!.unallocatedMinor).toBe(0);
  });
});

// ─── 5. Order of finalization ────────────────────────────────────────────────

describe("finalizing in either order", () => {
  test("gives the same result both ways round", async () => {
    // Order-dependence is the tell-tale of an implicit allocation rule.
    const forward = await seed("orderF");
    await payDeposit(forward);
    await allocate(forward, [
      { vehicleId: forward.vehicleA, amount: 3_000 },
      { vehicleId: forward.vehicleB!, amount: 2_000 },
    ]);
    await sell(forward, forward.vehicleA, PRICE_A);
    await sell(forward, forward.vehicleB!, PRICE_B);

    const reverse = await seed("orderR");
    await payDeposit(reverse);
    await allocate(reverse, [
      { vehicleId: reverse.vehicleA, amount: 3_000 },
      { vehicleId: reverse.vehicleB!, amount: 2_000 },
    ]);
    await sell(reverse, reverse.vehicleB!, PRICE_B);
    await sell(reverse, reverse.vehicleA, PRICE_A);

    for (const s of [forward, reverse]) {
      expect((await saleTransactionFor(s, s.vehicleA))!.amount).toBe(PRICE_A - 3_000);
      expect((await saleTransactionFor(s, s.vehicleB!))!.amount).toBe(PRICE_B - 2_000);
    }
  });
});

// ─── 6. A deposit larger than one car's bill ─────────────────────────────────

describe("an allocation larger than that car's invoice", () => {
  test("still requires a resolution, and the other car is unaffected", async () => {
    // A is billed 3,000 and allocated 4,000. That excess is a decision — but it
    // is A's excess, not the quote's, so B is not dragged into it.
    const s = await seed("excess");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 4_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);

    await expect(sell(s, s.vehicleA, PRICE_A)).rejects.toThrow(
      /larger than what the dealership billed/i
    );

    const view = await allocationView(s);
    expect(view!.vehicles.find((v) => v.vehicleId === s.vehicleB)!.allocatedMinor).toBe(
      1_000 * SCALE
    );
  });

  test("refuses to refund a shared deposit from the sale, which would take the other car's money", async () => {
    // releaseHeldDeposit resolves the WHOLE row. On a shared deposit that pays
    // out the rest of the deal by accident.
    const s = await seed("excessRefund");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 4_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);

    await expect(
      s.asManager.mutation(api.sales.create, {
        orgId: s.orgId,
        vehicleId: s.vehicleA,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: PRICE_A,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        quoteId: s.quoteId,
        depositResolution: { treatment: "REFUND_TO_CUSTOMER" as const, refundMethod: "CASH" as const },
      })
    ).rejects.toThrow(/shared with other vehicles/i);
  });

  test("the excess is handled by re-allocating it and resolving the released slice", async () => {
    // The path that does work: bring A down to what it was billed, which frees
    // the difference, then decide what happens to it.
    const s = await seed("excessPath");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 4_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);

    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    await sell(s, s.vehicleA, PRICE_A);

    expect((await saleTransactionFor(s, s.vehicleA))!.amount).toBe(0);
    const view = await allocationView(s);
    expect(view!.unallocatedMinor).toBe(1_000 * SCALE);
  });
});

// ─── 7-8. Cancellation, release, and re-allocation ───────────────────────────

describe("a vehicle that leaves the deal after being allocated", () => {
  async function allocatedThenReleased(tag: string) {
    const s = await seed(tag);
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
      reason: "Customer dropped the first car",
    });
    return s;
  }

  test("a share already applied to a completed sale cannot be released", async () => {
    // Removing the car would be undoing a posted application; that is a sale
    // cancellation, not an allocation edit.
    const s = await seed("releaseApplied");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    await sell(s, s.vehicleA, PRICE_A);

    await expect(
      s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: s.orgId,
        quoteId: s.quoteId,
        vehicleId: s.vehicleA,
      })
    ).rejects.toThrow(/already been applied|holds no active share/i);
  });

  test("its released share is not silently handed to the other car", async () => {
    // The invariant that matters most: money allocated against A does not
    // become B's because A fell through.
    const s = await allocatedThenReleased("release1");

    const view = await allocationView(s);
    expect(view!.vehicles.find((v) => v.vehicleId === s.vehicleB)!.allocatedMinor).toBe(
      2_000 * SCALE
    );
    // Nor does it quietly become spendable by the next sale to close.
    expect(view!.releasedAwaitingDecisionMinor).toBe(3_000 * SCALE);
    expect(view!.unallocatedMinor).toBe(0);
  });

  test("the released share is unavailable until somebody decides about it", async () => {
    const s = await allocatedThenReleased("release2");

    // B cannot quietly grow into it.
    await expect(allocate(s, [{ vehicleId: s.vehicleB!, amount: 5_000 }])).rejects.toThrow(
      /more than the deposit has left to give/i
    );
  });

  test("it can be re-allocated to another car on the quote, explicitly", async () => {
    const s = await allocatedThenReleased("release3");
    const view = await allocationView(s);
    const released = view!.vehicles.find((v) => v.vehicleId === s.vehicleA)!;
    expect(released.status).toBe("RELEASED");

    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: released.holdId!,
      treatment: "REALLOCATE_TO_VEHICLE" as const,
      toVehicleId: s.vehicleB!,
      reason: "Customer put the whole deposit on the second car instead",
    });

    const after = await allocationView(s);
    expect(after!.vehicles.find((v) => v.vehicleId === s.vehicleB)!.allocatedMinor).toBe(
      5_000 * SCALE
    );
    expect(after!.releasedAwaitingDecisionMinor).toBe(0);
  });

  test("it can be returned to the quote's unallocated balance", async () => {
    const s = await allocatedThenReleased("release4");
    const view = await allocationView(s);
    const released = view!.vehicles.find((v) => v.vehicleId === s.vehicleA)!;

    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: released.holdId!,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });

    const after = await allocationView(s);
    expect(after!.unallocatedMinor).toBe(3_000 * SCALE);
    expect(after!.releasedAwaitingDecisionMinor).toBe(0);
  });
});

// ─── 9. Refund / forfeit authorization ───────────────────────────────────────

describe("refund and forfeiture of a released share", () => {
  test("need the approval permission, not merely the right to sell", async () => {
    const s = await seed("auth");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    const noApproval = await s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId: "auth_plain", email: "plain@e.com", name: "Plain",
      });
      const roleId = await ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "SalesOnly",
        permissions: PERMS.filter((p) => p !== "approve:requests"),
      });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
      return userId;
    });
    void noApproval;

    const asPlain = s.t.withIdentity({ subject: "auth_plain", clerkId: "auth_plain" });
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId, quoteId: s.quoteId, vehicleId: s.vehicleA,
    });
    const holds = await s.t.run((ctx) => ctx.db.query("depositVehicleHolds").collect());
    const holdA = holds.find((h) => h.vehicleId === s.vehicleA)!;

    await expect(
      asPlain.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: holdA._id,
        treatment: "REFUND_TO_CUSTOMER" as const,
        refundMethod: "CASH" as const,
      })
    ).rejects.toThrow(/permission/i);

    // Re-allocating within the quote is deal work and does not need it.
    await asPlain.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdA._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });
  });

  test("a refund must say how the money is going out", async () => {
    const s = await seed("refundMethod");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId, quoteId: s.quoteId, vehicleId: s.vehicleA,
    });
    const holds = await s.t.run((ctx) => ctx.db.query("depositVehicleHolds").collect());
    const holdA = holds.find((h) => h.vehicleId === s.vehicleA)!;

    await expect(
      s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: holdA._id,
        treatment: "REFUND_TO_CUSTOMER" as const,
      })
    ).rejects.toThrow(/method the money is going out/i);
  });
});

// ─── 10. The whole quote completed ───────────────────────────────────────────

describe("completing the whole quote", () => {
  test("consumes the deposit exactly once, across both cars", async () => {
    const s = await seed("full");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    await sell(s, s.vehicleA, PRICE_A);
    await sell(s, s.vehicleB!, PRICE_B);

    // 3,000 + 2,000 credited across the two invoices, and no more.
    const a = await saleTransactionFor(s, s.vehicleA);
    const b = await saleTransactionFor(s, s.vehicleB!);
    expect(a!.amount + b!.amount).toBe(PRICE_A + PRICE_B - DEPOSIT);

    const view = await allocationView(s);
    expect(view!.appliedMinor).toBe(DEPOSIT * SCALE);
    expect(view!.unallocatedMinor).toBe(0);
    expect(view!.allocatedMinor).toBe(0);
  });
});

// ─── Money that has left the quote ───────────────────────────────────────────

describe("a slice that was refunded or forfeited", () => {
  async function releasedSlice(tag: string) {
    const s = await seed(tag);
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const view = await allocationView(s);
    const holdId = view!.vehicles.find((v) => v.vehicleId === s.vehicleA)!.holdId!;
    return { s, holdId };
  }

  test("does not come back as money the quote can still allocate", async () => {
    // The defect this replaces: a decision recorded by zeroing the slice made
    // it vanish from the released bucket and reappear in the unallocated
    // balance. Refunded money became allocatable again — the same error as
    // paying it out twice.
    const { s, holdId } = await releasedSlice("refundGone");

    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "REFUND_TO_CUSTOMER" as const,
      refundMethod: "CASH" as const,
    });

    const view = await allocationView(s);
    expect(view!.releasedAwaitingDecisionMinor).toBe(0);
    expect(view!.resolvedOutMinor).toBe(3_000 * SCALE);
    // And crucially not 3,000 of newly available money.
    expect(view!.unallocatedMinor).toBe(0);
  });

  test("a forfeiture is treated the same way", async () => {
    const { s, holdId } = await releasedSlice("forfeitGone");

    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "FORFEITED" as const,
      reason: "Customer walked away",
    });

    const view = await allocationView(s);
    expect(view!.resolvedOutMinor).toBe(3_000 * SCALE);
    expect(view!.unallocatedMinor).toBe(0);
  });

  test("cannot be resolved a second time", async () => {
    // Without a terminal status the hold stayed RELEASED, so the same slice
    // could be refunded and then re-allocated to another car.
    const { s, holdId } = await releasedSlice("resolveTwice");

    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "REFUND_TO_CUSTOMER" as const,
      refundMethod: "CASH" as const,
    });

    await expect(
      s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId,
        treatment: "REALLOCATE_TO_VEHICLE" as const,
        toVehicleId: s.vehicleB!,
      })
    ).rejects.toThrow(/has not been released/i);
  });

  test("re-allocating within the quote keeps the money on the quote", async () => {
    // The distinction the summary has to make: a slice moved to another car is
    // still the customer's money on this deal; a refunded one is not.
    const { s, holdId } = await releasedSlice("reallocStays");

    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "REALLOCATE_TO_VEHICLE" as const,
      toVehicleId: s.vehicleB!,
    });

    const view = await allocationView(s);
    expect(view!.resolvedOutMinor).toBe(0);
    expect(view!.vehicles.find((v) => v.vehicleId === s.vehicleB)!.allocatedMinor).toBe(
      5_000 * SCALE
    );
    expect(view!.unallocatedMinor).toBe(0);
  });
});

describe("a quote whose deposit was paid in instalments", () => {
  test("sums every payment's share for the vehicle being sold", async () => {
    // `deposits.create` can be called more than once on a quote — the customer
    // pays the عربون in parts — and each payment is its own row with its own
    // hold rows. Reading only the first consumed one instalment's share and
    // left the rest of the customer's money unapplied against their invoice.
    const s = await seed("instalments");
    await payDeposit(s, 3_000);
    await payDeposit(s, 2_000);

    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);

    const view = await allocationView(s);
    expect(view!.heldTotalMinor).toBe(5_000 * SCALE);

    await sell(s, s.vehicleA, PRICE_A);
    // 3,000 against a 3,000 invoice, from both payments taken together.
    expect((await saleTransactionFor(s, s.vehicleA))!.amount).toBe(0);
  });
});
