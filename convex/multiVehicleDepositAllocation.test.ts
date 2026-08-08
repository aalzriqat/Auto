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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
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
  "reopen:accounting_periods",
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
    expect(released.status).toBe("RELEASED_AWAITING_DECISION");

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

// ─── The application lifecycle ───────────────────────────────────────────────
//
// One deposit row is applied once per car, against a different sale each time.
// Everything below turns on the applications being told apart: which journal
// belongs to which car, and therefore which one a cancellation may touch.

const cancel = (s: Seed, saleId: Id<"sales">) =>
  s.asManager.mutation(api.sales.update, {
    orgId: s.orgId,
    saleId,
    status: "CANCELLED" as const,
  });

/** DEPOSIT_APPLIED events with the car they belong to and whether they still stand. */
async function depositApplicationEvents(s: Seed) {
  return await s.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").collect())
      .filter((e) => e.orgId === s.orgId && e.eventType === "DEPOSIT_APPLIED")
      .map((e) => ({
        vehicleId: (e.payload as { allocationVehicleId?: string }).allocationVehicleId,
        status: e.status,
      }))
  );
}

const holdsFor = (s: Seed, vehicleId: Id<"vehicles">) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("depositVehicleHolds").collect()).filter(
      (h) => h.orgId === s.orgId && h.vehicleId === vehicleId
    )
  );

/** Every dinar received sits in exactly one bucket. Checked after each move. */
async function expectConservation(s: Seed) {
  const view = await allocationView(s);
  const sum =
    view!.allocatedMinor +
    view!.appliedMinor +
    view!.reversingMinor +
    view!.releasedAwaitingDecisionMinor +
    view!.refundedMinor +
    view!.forfeitedMinor +
    view!.otherFinalizedMinor +
    view!.unallocatedMinor;
  expect(sum).toBe(view!.totalReceivedMinor);
  return view!;
}

describe("cancelling one car's sale on a shared deposit", () => {
  async function bothSold(tag: string) {
    const s = await seed(tag);
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    const saleB = await sell(s, s.vehicleB!, PRICE_B);
    return { s, saleA, saleB };
  }

  test("reverses that car's journal and leaves the other car's alone", async () => {
    // The failure this pins: reversal used to find the original entry by
    // (org, sourceType "deposits", sourceId depositId) and take the FIRST
    // match. One deposit applied to two cars posts two entries under that same
    // id, so cancelling B reversed A's — stripping the credit from an invoice
    // that was still live, and leaving the cancelled deal's credit standing.
    const { s, saleB } = await bothSold("crossReversal");

    await cancel(s, saleB);

    const events = await depositApplicationEvents(s);
    const forA = events.find((e) => e.vehicleId === s.vehicleA);
    const forB = events.find((e) => e.vehicleId === s.vehicleB);
    expect(forA!.status).toBe("POSTED");
    expect(forB!.status).toBe("REVERSED");
  });

  test("A's invoice keeps its credit", async () => {
    // The same defect stated as money: A's receivable must not move because B
    // was cancelled.
    const { s, saleB } = await bothSold("liveInvoiceIntact");
    const before = (await saleTransactionFor(s, s.vehicleA))!.amount;

    await cancel(s, saleB);

    expect((await saleTransactionFor(s, s.vehicleA))!.amount).toBe(before);
    expect(before).toBe(PRICE_A - 3_000);
  });

  test("the cancelled car's share comes back as a decision, not as stranded money", async () => {
    // A slice used to be left APPLIED with its sale gone and no mutation on any
    // path able to move it — the money was neither spendable, refundable nor
    // re-allocatable, and the car could never be sold again on that quote.
    const { s, saleB } = await bothSold("notStranded");

    await cancel(s, saleB);

    const [holdB] = await holdsFor(s, s.vehicleB!);
    expect(holdB!.allocationStatus).toBe("RELEASED_AWAITING_DECISION");
    expect(holdB!.appliedSaleId).toBeUndefined();
    const view = await expectConservation(s);
    expect(view.releasedAwaitingDecisionMinor).toBe(2_000 * SCALE);
    expect(view.appliedMinor).toBe(3_000 * SCALE);
  });

  test("the freed car can be sold again once its share has been decided", async () => {
    const { s, saleB } = await bothSold("resellAfterCancel");
    await cancel(s, saleB);

    const [holdB] = await holdsFor(s, s.vehicleB!);
    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdB!._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });
    await allocate(s, [{ vehicleId: s.vehicleB!, amount: 2_000 }]);

    await expect(sell(s, s.vehicleB!, PRICE_B)).resolves.toBeDefined();
    const view = await expectConservation(s);
    expect(view.appliedMinor).toBe(5_000 * SCALE);
  });

  test("selling it again posts a second, distinct application", async () => {
    // Re-applying the same deposit to the same car is a genuine new movement of
    // money. Posted under the first application's identity it would dedupe away
    // and the ledger would show one credit where the customer has two.
    const { s, saleB } = await bothSold("reapply");
    await cancel(s, saleB);
    const [holdB] = await holdsFor(s, s.vehicleB!);
    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdB!._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });
    await allocate(s, [{ vehicleId: s.vehicleB!, amount: 2_000 }]);
    await sell(s, s.vehicleB!, PRICE_B);

    const forB = (await depositApplicationEvents(s)).filter((e) => e.vehicleId === s.vehicleB);
    expect(forB.map((e) => e.status).sort()).toEqual(["POSTED", "REVERSED"]);
  });
});

describe("refunding what is left of a shared deposit", () => {
  test("refunds only the part no sale has claimed", async () => {
    // 5,000 received, 3,000 already credited against A's live invoice. The row
    // stays HELD until its last slice is consumed, so releasing it used to pay
    // out the face value: the customer got 3,000 twice, once off the invoice
    // and once in cash, with a full-amount DEPOSIT_REFUNDED journal on top.
    const s = await seed("partialRefund");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    await sell(s, s.vehicleA, PRICE_A);

    const depositId = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!._id
    );
    await s.asManager.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId,
      resolution: "REFUNDED" as const,
      refundMethod: "CASH" as const,
    });

    const refunds = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).filter(
        (tx) => tx.orgId === s.orgId && tx.type === "OUT" && tx.category === "DEPOSIT"
      )
    );
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount).toBe(2_000);

    const view = await expectConservation(s);
    expect(view.appliedMinor).toBe(3_000 * SCALE);
    expect(view.refundedMinor).toBe(2_000 * SCALE);
  });

  test("refuses when every dinar is already applied or allocated", async () => {
    const s = await seed("nothingLeft");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    await sell(s, s.vehicleA, PRICE_A);

    const depositId = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!._id
    );
    await expect(
      s.asManager.mutation(api.deposits.release, {
        orgId: s.orgId,
        depositId,
        resolution: "REFUNDED" as const,
        refundMethod: "CASH" as const,
      })
    ).rejects.toThrow(/nothing left of this deposit/i);
  });

  test("a partial refund does not cancel the other car's agreed share", async () => {
    const s = await seed("keepOtherShare");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleB!, amount: 3_000 }]);

    const depositId = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!._id
    );
    await s.asManager.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId,
      resolution: "REFUNDED" as const,
      refundMethod: "CASH" as const,
    });

    // B keeps its 3,000 and can still complete on it.
    await sell(s, s.vehicleB!, PRICE_B);
    const view = await expectConservation(s);
    expect(view.appliedMinor).toBe(3_000 * SCALE);
    expect(view.refundedMinor).toBe(2_000 * SCALE);
  });
});

describe("a released share that is refunded or forfeited", () => {
  async function releasedSliceOf(tag: string) {
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
    const [hold] = await holdsFor(s, s.vehicleA);
    return { s, holdId: hold!._id };
  }

  test("the refund actually pays the customer", async () => {
    // The treatment used to be recorded and nothing else: no payment, no
    // cashflow row, no journal. The customer's money stayed on the books as a
    // liability against a car that had left the deal, and the refund existed
    // only as a word in an audit log.
    const { s, holdId } = await releasedSliceOf("sliceRefundPays");

    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "REFUND_TO_CUSTOMER" as const,
      refundMethod: "CASH" as const,
    });

    const out = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).filter(
        (tx) => tx.orgId === s.orgId && tx.type === "OUT" && tx.category === "DEPOSIT"
      )
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBe(3_000);

    const payments = await s.t.run(async (ctx) =>
      (await ctx.db.query("collectionPayments").collect()).filter(
        (p) => p.orgId === s.orgId && p.direction === "OUT"
      )
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]!.canonicalPaymentId).toBeTruthy();

    const posted = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").collect()).filter(
        (e) => e.orgId === s.orgId && e.eventType === "DEPOSIT_REFUNDED" && e.status === "POSTED"
      )
    );
    expect(posted).toHaveLength(1);
    expect((posted[0]!.payload as { amountMinor: number }).amountMinor).toBe(3_000 * SCALE);

    await expectConservation(s);
  });

  test("the forfeiture reaches the ledger rather than only the audit log", async () => {
    const { s, holdId } = await releasedSliceOf("sliceForfeitPosts");

    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "FORFEITED" as const,
      reason: "Customer walked away",
    });

    const posted = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").collect()).filter(
        (e) => e.orgId === s.orgId && e.eventType === "DEPOSIT_FORFEITED" && e.status === "POSTED"
      )
    );
    expect(posted).toHaveLength(1);
    expect((posted[0]!.payload as { amountMinor: number }).amountMinor).toBe(3_000 * SCALE);
    // No cash moves on a forfeiture — the dealership keeps what it already has.
    const out = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).filter(
        (tx) => tx.orgId === s.orgId && tx.type === "OUT"
      )
    );
    expect(out).toHaveLength(0);
    await expectConservation(s);
  });

  test("whoever took the deposit cannot be the one who disposes of it", async () => {
    const { s, holdId } = await releasedSliceOf("sliceSoD");

    await expect(
      s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId,
        treatment: "FORFEITED" as const,
        reason: "Keeping it",
      })
    ).rejects.toThrow(/cannot resolve their own/i);
  });

  test("returning it to the pool leaves the car sellable again", async () => {
    // The old terminal state had no way back: the car's only hold row was
    // RESOLVED and inactive, an allocation can only be written onto an active
    // row, and a multi-vehicle quote refuses to finalize a car with no
    // allocation. The car was unsellable on that quote for good.
    const { s, holdId } = await releasedSliceOf("returnThenSell");

    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });

    const view = await expectConservation(s);
    expect(view.unallocatedMinor).toBe(3_000 * SCALE);
    expect(view.refundedMinor).toBe(0);

    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    await expect(sell(s, s.vehicleA, PRICE_A)).resolves.toBeDefined();
  });

  test("re-allocating opens a new share and keeps the old one on the record", async () => {
    const { s, holdId } = await releasedSliceOf("reallocHistory");

    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId,
      treatment: "REALLOCATE_TO_VEHICLE" as const,
      toVehicleId: s.vehicleB!,
    });

    const original = await s.t.run((ctx) => ctx.db.get(holdId));
    expect(original!.allocationStatus).toBe("RESOLVED");
    expect(original!.resolutionTreatment).toBe("REALLOCATE_TO_VEHICLE");
    expect(original!.vehicleId).toBe(s.vehicleA);
    expect(original!.allocatedAmountMinor).toBe(3_000 * SCALE);

    const holdsB = await holdsFor(s, s.vehicleB!);
    const created = holdsB.find((h) => h.sourceHoldId === holdId);
    expect(created!.allocatedAmountMinor).toBe(3_000 * SCALE);

    const view = await expectConservation(s);
    expect(view.vehicles.find((v) => v.vehicleId === s.vehicleB)!.allocatedMinor).toBe(
      5_000 * SCALE
    );
  });

  test("a share applied to a live sale is neither refundable nor re-allocatable", async () => {
    const s = await seed("liveShareLocked");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    await sell(s, s.vehicleA, PRICE_A);

    const [holdA] = await holdsFor(s, s.vehicleA);
    await expect(
      s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: holdA!._id,
        treatment: "REFUND_TO_CUSTOMER" as const,
        refundMethod: "CASH" as const,
      })
    ).rejects.toThrow(/has not been released/i);
    // Refused for either reason — the share is spent, and the sale it was spent
    // on is complete. Whichever guard answers first, the answer is no.
    await expect(allocate(s, [{ vehicleId: s.vehicleA, amount: 0 }])).rejects.toThrow(
      /already (been applied|complete)/i
    );
  });
});

describe("instalments through the whole lifecycle", () => {
  test("cancelling a sale paid for out of two instalments backs out only that car", async () => {
    const s = await seed("instalmentCancel");
    await payDeposit(s, 3_000);
    await payDeposit(s, 2_000);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    await sell(s, s.vehicleB!, PRICE_B);

    await cancel(s, saleA);

    const events = await depositApplicationEvents(s);
    expect(events.filter((e) => e.vehicleId === s.vehicleB).every((e) => e.status === "POSTED")).toBe(
      true
    );
    const view = await expectConservation(s);
    expect(view.appliedMinor).toBe(2_000 * SCALE);
    expect(view.releasedAwaitingDecisionMinor).toBe(3_000 * SCALE);
  });
});

// ─── Releasing the row itself ────────────────────────────────────────────────
//
// A `deposits` row is no longer all-or-nothing: part of it can be paid back
// while the rest is still committed to a car. Everything that used to be safe
// because the row flipped out of HELD on the first release has to be checked
// again.

const depositRowId = (s: Seed) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!._id
  );

const cashOut = (s: Seed) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("transactions").collect())
      .filter((tx) => tx.orgId === s.orgId && tx.type === "OUT" && tx.category === "DEPOSIT")
      .map((tx) => tx.amount)
  );

const postedRefunds = (s: Seed) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").collect())
      .filter(
        (e) =>
          e.orgId === s.orgId && e.eventType === "DEPOSIT_REFUNDED" && e.status === "POSTED"
      )
      .map((e) => (e.payload as { amountMinor: number }).amountMinor)
  );

const outPayments = (s: Seed) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("canonicalPayments").collect()).filter(
      (p) => p.orgId === s.orgId && p.direction === "OUT"
    )
  );

const release = (
  s: Seed,
  depositId: Id<"deposits">,
  resolution: "REFUNDED" | "FORFEITED" = "REFUNDED",
  idempotencyKey?: string
) =>
  s.asManager.mutation(api.deposits.release, {
    orgId: s.orgId,
    depositId,
    resolution,
    ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

describe("releasing a deposit row more than once", () => {
  test("every payout has its own journal and its own payment", async () => {
    // Both keys used to be per-row and the event version was always 1, so the
    // second release found "already posted", moved 3,000 JOD of real cash, and
    // wrote no ledger entry at all — while its collectionPayments row pointed
    // at the FIRST release's canonical payment.
    const s = await seed("releaseTwice");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);
    const depositId = await depositRowId(s);

    await release(s, depositId); // the free 1,000
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    // A's 3,000 is now awaiting its own decision, so the row has nothing free.
    await expect(release(s, depositId)).rejects.toThrow(/nothing left of this deposit/i);

    const cash = await cashOut(s);
    const journals = await postedRefunds(s);
    expect(cash).toEqual([1_000]);
    expect(journals).toEqual([1_000 * SCALE]);
    await expectConservation(s);
  });

  test("two genuine releases both post, and the cash matches the ledger", async () => {
    const s = await seed("releaseTwiceReal");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    const depositId = await depositRowId(s);

    await release(s, depositId); // the free 2,000
    // A leaves the deal and its share is decided separately; then what is left
    // of the row is genuinely free again.
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const [holdA] = await holdsFor(s, s.vehicleA);
    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdA!._id,
      treatment: "REFUND_TO_CUSTOMER" as const,
      refundMethod: "CASH" as const,
    });

    const cash = await cashOut(s);
    const journals = await postedRefunds(s);
    expect(cash.reduce((a, b) => a + b, 0)).toBe(5_000);
    expect(journals.reduce((a, b) => a + b, 0)).toBe(5_000 * SCALE);
    // One payment per payout, not one shared between them.
    expect((await outPayments(s))).toHaveLength(2);
    await expectConservation(s);
  });

  test("a refund and a forfeiture on one row are not reported as the same thing", async () => {
    // `status` records only whichever release happened last, so reading the
    // treatment off it made a 2,000 refund followed by a 1,000 forfeiture
    // report all 3,000 as forfeited.
    const s = await seed("refundThenForfeit");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    const depositId = await depositRowId(s);

    await release(s, depositId); // refunds the free 2,000
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const [holdA] = await holdsFor(s, s.vehicleA);
    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdA!._id,
      treatment: "FORFEITED" as const,
      reason: "Customer walked away",
    });

    const view = await expectConservation(s);
    expect(view.refundedMinor).toBe(2_000 * SCALE);
    expect(view.forfeitedMinor).toBe(3_000 * SCALE);
  });

  test("a share awaiting its own decision is not swept up by a row release", async () => {
    const s = await seed("awaitingNotSwept");
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

    await expect(release(s, await depositRowId(s))).rejects.toThrow(
      /awaiting its own decision/i
    );
    const [holdA] = await holdsFor(s, s.vehicleA);
    expect(holdA!.allocationStatus).toBe("RELEASED_AWAITING_DECISION");
    expect(await cashOut(s)).toEqual([]);
  });

  test("a partly refunded deposit lets the customer put the money down again", async () => {
    const s = await seed("reDeposit");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    await release(s, await depositRowId(s)); // refunds the free 2,000

    await expect(payDeposit(s, 2_000)).resolves.toBeUndefined();
    await expectConservation(s);
  });
});

describe("voiding a deposit that has already moved money", () => {
  test("is refused after part of it was refunded", async () => {
    // Voiding says the payment was recorded in error and reverses the receipt.
    // After a refund that leaves the books showing cash out against a receipt
    // that never came in — and soft-deletes the row out of every allocation
    // view while another car's share still points at it.
    const s = await seed("voidAfterRefund");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleB!, amount: 2_000 }]);
    const depositId = await depositRowId(s);
    await release(s, depositId); // refunds the free 3,000

    await expect(
      s.asManager.mutation(api.deposits.voidDeposit, { orgId: s.orgId, depositId })
    ).rejects.toThrow(/already been refunded or forfeited/i);

    const deposit = await s.t.run((ctx) => ctx.db.get(depositId));
    expect(deposit!.isDeleted).not.toBe(true);
  });

  test("is refused while a completed sale still holds part of it", async () => {
    const s = await seed("voidAfterApply");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    await sell(s, s.vehicleA, PRICE_A);
    const depositId = await depositRowId(s);

    await expect(
      s.asManager.mutation(api.deposits.voidDeposit, { orgId: s.orgId, depositId })
    ).rejects.toThrow(/applied to a completed sale/i);
  });
});

/** Closing needs every current warning acknowledged, exactly as the UI does. */
async function closePeriod(s: Seed, periodId: Id<"accountingPeriods">) {
  const checklist = await s.asUser.query(api.accountingPeriods.closeChecklist, {
    orgId: s.orgId,
    periodId,
  });
  await s.asUser.mutation(api.accountingPeriods.close, {
    orgId: s.orgId,
    periodId,
    acknowledgedWarnings: checklist.warnings,
  });
}

describe("a reversal that has to wait for an accounting period", () => {
  test("leaves the share unspendable until the journal is actually reversed", async () => {
    // The state exists precisely for this. With the period closed the reversing
    // entry is only queued and the original DEPOSIT_APPLIED is still POSTED, so
    // paying the share out now pays the customer money the ledger still shows
    // credited against their invoice.
    const s = await seed("deferredReversal");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);

    const period = (await s.asUser.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
    await closePeriod(s, period._id);

    await cancel(s, saleA);

    const [holdA] = await holdsFor(s, s.vehicleA);
    expect(holdA!.allocationStatus).toBe("REVERSING");
    const application = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).find(
        (a) => a.orgId === s.orgId && a.vehicleId === s.vehicleA
      )
    );
    expect(application!.status).toBe("REVERSING");
    // Still POSTED — the money has not come back yet.
    const applied = await depositApplicationEvents(s);
    expect(applied.find((e) => e.vehicleId === s.vehicleA)!.status).toBe("POSTED");

    await expect(
      s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: holdA!._id,
        treatment: "REFUND_TO_CUSTOMER" as const,
        refundMethod: "CASH" as const,
      })
    ).rejects.toThrow(/still being backed out/i);
    expect(await cashOut(s)).toEqual([]);
  });

  test("finishes when the outbox drains, and only then", async () => {
    const s = await seed("deferredDrain");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    const period = (await s.asUser.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
    await closePeriod(s, period._id);
    await cancel(s, saleA);

    await s.asUser.mutation(api.accountingPeriods.reopen, {
      orgId: s.orgId,
      periodId: period._id,
      reason: "Backdated cancellation needs its reversal posted",
    });
    await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, {
      orgId: s.orgId,
    });

    const application = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).find(
        (a) => a.orgId === s.orgId && a.vehicleId === s.vehicleA
      )
    );
    expect(application!.status).toBe("REVERSED");
    const [holdA] = await holdsFor(s, s.vehicleA);
    expect(holdA!.allocationStatus).toBe("RELEASED_AWAITING_DECISION");
    expect(
      (await depositApplicationEvents(s)).find((e) => e.vehicleId === s.vehicleA)!.status
    ).toBe("REVERSED");

    // And now the decision is allowed.
    await expect(
      s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: holdA!._id,
        treatment: "REFUND_TO_CUSTOMER" as const,
        refundMethod: "CASH" as const,
      })
    ).resolves.toBeDefined();
    expect(await cashOut(s)).toEqual([3_000]);
  });
});

describe("finalizing a share under an approved 'other' treatment", () => {
  test("carries the same approval bar as a refund", async () => {
    // OTHER takes the money out of the pool for good under a free-text reason.
    // It was available to any salesperson.
    const s = await seed("otherApproval");
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
    const [holdA] = await holdsFor(s, s.vehicleA);

    const salesOnly = await s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId: "otherApproval_s",
        email: "otherApproval_s@e.com",
        name: "Sales Only",
      });
      const roleId = await ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "SalesOnly",
        permissions: ["view:sales"],
      });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
      return userId;
    });
    void salesOnly;

    await expect(
      s.t
        .withIdentity({ subject: "otherApproval_s", clerkId: "otherApproval_s" })
        .mutation(api.deposits.resolveReleasedAllocation, {
          orgId: s.orgId,
          holdId: holdA!._id,
          treatment: "OTHER" as const,
          reason: "Transferred to another deal by agreement",
        })
    ).rejects.toThrow();
  });
});

// ─── A car holding more than one share at once ───────────────────────────────
//
// A re-allocation opens a NEW hold on the receiving car rather than rewriting
// the released one, so both histories survive. Everything that reads "the car's
// hold" therefore has to read all of them.

describe("a car that holds two shares of the same deposit", () => {
  async function reallocatedOntoB(tag: string) {
    const s = await seed(tag);
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 2_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const [holdA] = await holdsFor(s, s.vehicleA);
    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdA!._id,
      treatment: "REALLOCATE_TO_VEHICLE" as const,
      toVehicleId: s.vehicleB!,
    });
    return s;
  }

  test("credits the sale with everything the allocation screen showed", async () => {
    // The screen said 3,000 against B — its own 1,000 plus A's re-allocated
    // 2,000. Completion consumed the first hold it found and billed the
    // customer 2,000 more than the deposit they had been told was theirs.
    const s = await reallocatedOntoB("reallocSell");
    const view = await allocationView(s);
    expect(view!.vehicles.find((v) => v.vehicleId === s.vehicleB)!.allocatedMinor).toBe(
      3_000 * SCALE
    );

    await sell(s, s.vehicleB!, PRICE_B);

    expect((await saleTransactionFor(s, s.vehicleB!))!.amount).toBe(PRICE_B - 3_000);
    await expectConservation(s);
  });

  test("leaves nothing active behind on a car that has been sold", async () => {
    // The un-consumed share stayed active on a SOLD vehicle, where no path
    // could reach it: release wants an active hold it cannot find, resolve
    // wants a status it can never reach, and the row release excludes it as
    // still allocated. The customer's money was frozen for good.
    const s = await reallocatedOntoB("reallocStrand");
    await sell(s, s.vehicleB!, PRICE_B);

    const live = (await holdsFor(s, s.vehicleB!)).filter((h) => h.active);
    expect(live).toEqual([]);
    const view = await expectConservation(s);
    expect(view.allocatedMinor).toBe(0);
    expect(view.appliedMinor).toBe(3_000 * SCALE);
  });

  test("cancelling its sale backs out both shares, each against its own journal", async () => {
    // The highest-risk transition this change makes reachable: two
    // applications of one deposit to one car, on one sale, each with its own
    // accounting identity. Reversal has to find and back out both — the whole
    // reason applications carry the coordinates they posted under.
    const s = await reallocatedOntoB("reallocCancel");
    const saleB = await sell(s, s.vehicleB!, PRICE_B);

    await cancel(s, saleB);

    const applications = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).filter(
        (a) => a.orgId === s.orgId && a.vehicleId === s.vehicleB
      )
    );
    expect(applications).toHaveLength(2);
    expect(applications.every((a) => a.status === "REVERSED")).toBe(true);
    // Two identities, not one applied twice.
    expect(new Set(applications.map((a) => a.eventVersion)).size).toBe(2);
    expect(new Set(applications.map((a) => a.eventIdempotencyKey)).size).toBe(2);

    const holds = await holdsFor(s, s.vehicleB!);
    const decided = holds.filter(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    );
    expect(decided).toHaveLength(2);
    expect(decided.map((h) => h.allocatedAmountMinor).sort((a, b) => a! - b!)).toEqual([
      1_000 * SCALE,
      2_000 * SCALE,
    ]);

    const view = await expectConservation(s);
    expect(view.releasedAwaitingDecisionMinor).toBe(3_000 * SCALE);
    expect(view.appliedMinor).toBe(0);
  });

  test("can still be taken off the deal after a re-allocation", async () => {
    const s = await reallocatedOntoB("reallocRelease");

    await expect(
      s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: s.orgId,
        quoteId: s.quoteId,
        vehicleId: s.vehicleB!,
      })
    ).resolves.toBeDefined();

    const view = await expectConservation(s);
    expect(view.releasedAwaitingDecisionMinor).toBe(3_000 * SCALE);
  });

  test("a share returned to the pool and allocated again can be released again", async () => {
    const s = await seed("returnThenRelease");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 2_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const [holdA] = await holdsFor(s, s.vehicleA);
    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdA!._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 2_000 }]);

    await expect(
      s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: s.orgId,
        quoteId: s.quoteId,
        vehicleId: s.vehicleA,
      })
    ).resolves.toBeDefined();
    await expectConservation(s);
  });
});

describe("a share allocated at zero", () => {
  test("its car is allocatable again once the sale is cancelled", async () => {
    // A zero allocation is a decision, and completion marks its hold APPLIED
    // like any other — but nothing posts for nothing, so there is no
    // application row to reverse it, and the hold stayed APPLIED after the sale
    // was cancelled. The car was then refused a new allocation because of a
    // sale that no longer existed.
    const s = await seed("zeroSliceCancel");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 0 },
      { vehicleId: s.vehicleB!, amount: 5_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);

    await cancel(s, saleA);

    await expect(allocate(s, [{ vehicleId: s.vehicleA, amount: 0 }])).resolves.toBeDefined();
    await expectConservation(s);
  });

  test("its car does not come back reserved with no way to free it", async () => {
    // Sell the funded car first, then the zero-share car, then cancel the
    // second.
    //
    // Reported, and initially unreproducible — because a zero share used to
    // leave its hold untouched, so nothing ever closed the row and there was
    // nothing to reopen. Consuming a zero share like any other (see
    // saleCompletion) makes the row close on that last sale, and this test now
    // fails without the reopen guard in `reinstateAppliedDeposits`: the row
    // stays APPLIED and the reinstated hold has nothing releasable behind it.
    //
    // Worth keeping in mind next time a finding will not reproduce: the
    // scenario can be real and reached through a path the current code does not
    // take yet.
    const s = await seed("zeroSliceRowClosed");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 0 },
      { vehicleId: s.vehicleB!, amount: 5_000 },
    ]);
    await sell(s, s.vehicleB!, PRICE_B);
    const saleA = await sell(s, s.vehicleA, PRICE_A);

    await cancel(s, saleA);

    const deposit = await s.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)
    );
    expect([deposit!.status, deposit!.holdActive]).toEqual(["HELD", true]);
    expect(deposit!.holdActive).toBe(true);
    // And the share can be taken off the deal again, which is what proves the
    // car is not stuck.
    await expect(
      s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: s.orgId,
        quoteId: s.quoteId,
        vehicleId: s.vehicleA,
      })
    ).resolves.toBeDefined();
    await expectConservation(s);
  });
});

describe("what the allocation screen is told about a released share", () => {
  test("each share carries its own amount, not the car's total", async () => {
    // A car can hold more than one share at once. Printing the vehicle figure
    // beside each of them showed 1,000 and 2,000 as "3,000" twice — 6,000 on
    // screen where 3,000 exists — and an operator forfeiting "3,000" forfeited
    // 1,000.
    const s = await seed("perShareAmount");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 2_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const [holdA] = await holdsFor(s, s.vehicleA);
    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdA!._id,
      treatment: "REALLOCATE_TO_VEHICLE" as const,
      toVehicleId: s.vehicleB!,
    });
    const saleB = await sell(s, s.vehicleB!, PRICE_B);
    await cancel(s, saleB);

    const view = await allocationView(s);
    const shares = view!.vehicles.find((v) => v.vehicleId === s.vehicleB)!.awaitingDecision;
    expect(shares.map((share) => share.amountMinor).sort((a, b) => a - b)).toEqual([
      1_000 * SCALE,
      2_000 * SCALE,
    ]);
    // And they sum to the bucket, rather than to twice the car's total.
    expect(shares.reduce((sum, share) => sum + share.amountMinor, 0)).toBe(
      view!.releasedAwaitingDecisionMinor
    );
  });

  test("a share still mid-reversal is reported as such, not as decidable", async () => {
    // `resolveReleasedAllocation` refuses a REVERSING share — its original
    // entry is still POSTED — so a screen that cannot tell the two apart offers
    // four treatments that all fail.
    const s = await seed("shareStatusReported");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    const period = (await s.asUser.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
    await closePeriod(s, period._id);
    await cancel(s, saleA);

    const view = await allocationView(s);
    const shares = view!.vehicles.find((v) => v.vehicleId === s.vehicleA)!.awaitingDecision;
    expect(shares).toHaveLength(1);
    expect(shares[0]!.status).toBe("REVERSING");
    expect(shares[0]!.amountMinor).toBe(3_000 * SCALE);
  });
});

describe("the lifecycle has somewhere to happen", () => {
  test("the screen is mounted where a quote can be reached at any time", () => {
    // Asserting the mutations appear SOMEWHERE across both files let the mount
    // be deleted while the test stayed green — which is the defect, not the
    // component's existence.
    const dialog = readFileSync(
      join(process.cwd(), "components/customers/CustomerDetailsDialog.tsx"),
      "utf8"
    );
    expect(dialog).toContain("<QuoteDepositManager");
  });

  test("a released share can be decided from a shipped screen", async () => {
    // An ordinary sale cancellation on a multi-vehicle quote produces a share
    // awaiting a decision, and `deposits.release` refuses to pay it out — it
    // has to go through `resolveReleasedAllocation`. If no client calls that,
    // the money is real, on the books, and untouchable by any member of staff.
    const clientSources = [
      "components/deposits/QuoteDepositManager.tsx",
      "components/customers/CustomerDetailsDialog.tsx",
    ]
      .map((relative) => {
        try {
          return readFileSync(join(process.cwd(), relative), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");

    expect(clientSources).toContain("resolveReleasedAllocation");
    expect(clientSources).toContain("releaseVehicleAllocation");
  });
});

describe("releasing the same row twice from the same screen", () => {
  async function freePartRefunded(tag: string) {
    const s = await seed(tag);
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    const depositId = await depositRowId(s);
    const key = `deposit_release_${depositId}_REFUNDED`;

    await release(s, depositId, "REFUNDED", key); // the free 2,000
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const [holdA] = await holdsFor(s, s.vehicleA);
    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: holdA!._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });
    return { s, depositId, key };
  }

  test("the deposit screen sends no fixed key, because a row can be released again", async () => {
    // The screen used to send `deposit_release_<depositId>_<resolution>`. A row
    // can now be released more than once — the free part today, the rest when
    // the cars it was held against fall away — so the SECOND genuine payout
    // matched the first's stored command: the mutation returned without
    // running, no money moved, and the operator was told the customer had been
    // refunded 3,000 JOD.
    //
    // There is nothing the server can do about it: a retry of one release and a
    // second, different release both arrive after the first has committed, so
    // no fingerprint can separate them. The key has to identify one attempt,
    // which means the screen must not derive it from the deposit alone.
    const source = readFileSync(
      join(process.cwd(), "components/vehicles/VehicleDetailsDialog.tsx"),
      "utf8"
    );
    const releaseCall = source.slice(
      source.indexOf("await releaseDeposit({"),
      source.indexOf("});", source.indexOf("await releaseDeposit({"))
    );
    expect(releaseCall).not.toContain("idempotencyKey");
  });

  test("a genuine retry of the SAME release replays rather than paying twice", async () => {
    const s = await seed("clientKeyRetry");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    const depositId = await depositRowId(s);
    const key = `deposit_release_${depositId}_attempt1`;

    await release(s, depositId, "REFUNDED", key);
    await release(s, depositId, "REFUNDED", key);

    expect(await cashOut(s)).toEqual([2_000]);
    await expectConservation(s);
  });

  test("and without a key the second release goes through on its own merits", async () => {
    const { s, depositId } = await freePartRefunded("clientKeyNone");

    await release(s, depositId, "REFUNDED"); // the remaining 3,000

    expect(await cashOut(s)).toEqual([2_000, 3_000]);
    expect((await postedRefunds(s)).reduce((a, b) => a + b, 0)).toBe(5_000 * SCALE);
    await expectConservation(s);
  });
});

describe("a deferred reversal and the money beside it", () => {
  test("does not make a genuinely free balance unrefundable", async () => {
    // The slice mid-reversal was subtracted twice — once through its
    // application row, once through its hold — so a free 2,000 was reported as
    // nothing left, for as long as the reversal waited on an accounting period.
    const s = await seed("reversingDoubleCount");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 2_000 },
      { vehicleId: s.vehicleB!, amount: 1_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    const period = (await s.asUser.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
    await closePeriod(s, period._id);
    await cancel(s, saleA);

    const [holdA] = await holdsFor(s, s.vehicleA);
    expect(holdA!.allocationStatus).toBe("REVERSING");

    await s.asUser.mutation(api.accountingPeriods.reopen, {
      orgId: s.orgId,
      periodId: period._id,
      reason: "Refund the unallocated remainder",
    });
    await release(s, await depositRowId(s));

    expect(await cashOut(s)).toEqual([2_000]);
    await expectConservation(s);
  });
});

// ─── The whole life of one deal's deposit ────────────────────────────────────

/**
 * Two payments, two cars, and every transition the model has, in one run.
 *
 * The individual tests above each pin one movement. This one exists because the
 * defects that survived them were all interactions: a release that was correct
 * on its own paid twice after a cancellation; a reversal that targeted the
 * right event reversed the wrong car once a second application existed; a
 * refund that posted correctly stranded the slice it came from. Conservation is
 * re-checked after every single step, so the step that breaks it is named
 * rather than discovered three moves later.
 *
 * The arithmetic is stated in full at each point on purpose. A test that only
 * asserts "it balances" balances just as happily around two compensating
 * errors.
 */
describe("a deposit paid in two instalments, followed to the end", () => {
  test("every dinar stays accounted for through every transition", async () => {
    const s = await seed("wholeLife");

    // ── The customer pays the عربون in two parts ──────────────────────────
    await payDeposit(s, 3_000);
    await payDeposit(s, 2_000);

    let view = await expectConservation(s);
    expect(view.totalReceivedMinor).toBe(5_000 * SCALE);
    expect(view.unallocatedMinor).toBe(5_000 * SCALE);
    // Two payments, so two hold rows per car.
    expect(await s.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter((h) => h.orgId === s.orgId).length
    )).toBe(4);

    // ── They say how it divides. 1,500 stays on the deal, against neither ──
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 2_000 },
      { vehicleId: s.vehicleB!, amount: 1_500 },
    ]);
    view = await expectConservation(s);
    expect(view.allocatedMinor).toBe(3_500 * SCALE);
    expect(view.unallocatedMinor).toBe(1_500 * SCALE);

    // ── Car A completes, and consumes exactly its own share ───────────────
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    expect((await saleTransactionFor(s, s.vehicleA))!.amount).toBe(PRICE_A - 2_000);
    view = await expectConservation(s);
    expect(view.appliedMinor).toBe(2_000 * SCALE);
    expect(view.allocatedMinor).toBe(1_500 * SCALE);
    expect(view.unallocatedMinor).toBe(1_500 * SCALE);

    // ── That sale is cancelled. A's share comes off it, and waits ─────────
    await cancel(s, saleA);
    view = await expectConservation(s);
    expect(view.appliedMinor).toBe(0);
    expect(view.releasedAwaitingDecisionMinor).toBe(2_000 * SCALE);
    // B's share is untouched by A's cancellation — the whole point of the
    // per-application identity.
    expect(view.allocatedMinor).toBe(1_500 * SCALE);

    // ── Somebody decides: back to the deal, not onto the other car ────────
    const releasedA = (await holdsFor(s, s.vehicleA)).filter(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    );
    expect(releasedA).toHaveLength(1);
    await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId,
      holdId: releasedA[0]!._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
    });
    view = await expectConservation(s);
    expect(view.releasedAwaitingDecisionMinor).toBe(0);
    expect(view.unallocatedMinor).toBe(3_500 * SCALE);
    expect(view.refundedMinor).toBe(0);

    // ── The customer asks for some of it back ────────────────────────────
    // B leaves the deal, and its 1,500 is refunded rather than moved.
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleB!,
    });
    const releasedB = (await holdsFor(s, s.vehicleB!)).filter(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    );
    // One share per payment the money came from: 1,000 of the first 3,000 and
    // 500 of the second 2,000, because a car's allocation is spread across the
    // payments that can actually cover it. Each is refunded on its own, which
    // is what the screen lists.
    expect(
      releasedB.map((h) => h.allocatedAmountMinor).sort((a, b) => a! - b!)
    ).toEqual([500 * SCALE, 1_000 * SCALE]);
    for (const hold of releasedB) {
      await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: hold._id,
        treatment: "REFUND_TO_CUSTOMER" as const,
        refundMethod: "CASH" as const,
      });
    }
    view = await expectConservation(s);
    expect(view.refundedMinor).toBe(1_500 * SCALE);
    expect(view.unallocatedMinor).toBe(3_500 * SCALE);
    // Real money left, and the ledger says the same amount.
    expect((await cashOut(s)).reduce((a, b) => a + b, 0)).toBe(1_500);
    expect((await postedRefunds(s)).reduce((a, b) => a + b, 0)).toBe(1_500 * SCALE);

    // ── They put the rest against A, then move it to B ───────────────────
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_500 }]);
    view = await expectConservation(s);
    expect(view.allocatedMinor).toBe(3_500 * SCALE);
    expect(view.unallocatedMinor).toBe(0);

    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    const awaitingA = (await holdsFor(s, s.vehicleA)).filter(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    );
    // One share per payment the money came from, and they total the allocation.
    expect(
      awaitingA.reduce((sum, h) => sum + (h.allocatedAmountMinor ?? 0), 0)
    ).toBe(3_500 * SCALE);

    for (const hold of awaitingA) {
      await s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: hold._id,
        treatment: "REALLOCATE_TO_VEHICLE" as const,
        toVehicleId: s.vehicleB!,
      });
    }
    view = await expectConservation(s);
    expect(view.allocatedMinor).toBe(3_500 * SCALE);
    expect(view.vehicles.find((v) => v.vehicleId === s.vehicleB)!.allocatedMinor).toBe(
      3_500 * SCALE
    );
    // Moved, not refunded — it is still the customer's money on this deal.
    expect(view.refundedMinor).toBe(1_500 * SCALE);

    // ── B completes, on everything that ended up against it ──────────────
    await sell(s, s.vehicleB!, PRICE_B);
    expect((await saleTransactionFor(s, s.vehicleB!))!.amount).toBe(PRICE_B - 3_500);

    view = await expectConservation(s);
    expect(view.appliedMinor).toBe(3_500 * SCALE);
    expect(view.refundedMinor).toBe(1_500 * SCALE);
    expect(view.allocatedMinor).toBe(0);
    expect(view.unallocatedMinor).toBe(0);
    expect(view.releasedAwaitingDecisionMinor).toBe(0);

    // 5,000 received: 3,500 credited against an invoice, 1,500 handed back.
    expect(view.appliedMinor + view.refundedMinor).toBe(view.totalReceivedMinor);

    // ── And the ledger agrees with the cash ──────────────────────────────
    const appliedEvents = await depositApplicationEvents(s);
    // A's application was reversed; B's two stand — one per payment.
    expect(appliedEvents.filter((e) => e.status === "POSTED")).toHaveLength(2);
    expect(appliedEvents.filter((e) => e.status === "REVERSED")).toHaveLength(1);
    // Two payouts, one per share, each with its own payment record.
    expect((await cashOut(s)).reduce((a, b) => a + b, 0)).toBe(1_500);
    expect((await outPayments(s))).toHaveLength(2);
  });
});

// ─── The deposit liability, as the accountant sees it ────────────────────────

const depositReconciliation = (s: Seed) =>
  s.asUser.query(api.accountingReports.customerDepositsReconciliation, { orgId: s.orgId });

describe("the customer-deposit liability reconciles while the deal is mid-life", () => {
  test("the subledger side is what is still owed, not the row's face value", async () => {
    // The GL debits Customer Deposits per slice, at the moment each is applied.
    // The subledger side read the `deposits` row at face value and counted any
    // HELD row in full — and on this branch a row stays HELD until its LAST
    // slice is consumed. So every multi-car deal mid-life reported "customer
    // deposits do not reconcile", which an accountant then has to acknowledge
    // at every period close: the one control that catches a real
    // deposit-liability error, turned into noise.
    const s = await seed("reconMidLife");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB!, amount: 2_000 },
    ]);
    expect((await depositReconciliation(s)).isReconciled).toBe(true);

    await sell(s, s.vehicleA, PRICE_A);

    const recon = await depositReconciliation(s);
    expect(recon.isReconciled).toBe(true);
    // 3,000 of the 5,000 has been credited against A's invoice, so 2,000 is
    // still owed — and both sides have to say so, not just agree.
    expect(recon.byCurrency.JOD!.subledgerBalanceMinor).toBe(2_000 * SCALE);
    expect(recon.byCurrency.JOD!.glBalanceMinor).toBe(2_000 * SCALE);
  });

  test("and after a partial refund of what no sale claimed", async () => {
    const s = await seed("reconPartialRefund");
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3_000 }]);
    await sell(s, s.vehicleA, PRICE_A);
    await release(s, await depositRowId(s)); // refunds the free 2,000

    const recon = await depositReconciliation(s);
    expect(recon.isReconciled).toBe(true);
    // 3,000 applied and 2,000 handed back leaves nothing outstanding.
    expect(recon.byCurrency.JOD!.subledgerBalanceMinor).toBe(0);
  });

  test("and once every car on the quote is sold, including one carrying nothing", async () => {
    // The permanent variance: a car allocated zero completes, and its row's
    // face value stayed on the subledger side for good.
    const s = await seed("reconZeroShare");
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 0 },
      { vehicleId: s.vehicleB!, amount: 5_000 },
    ]);
    await sell(s, s.vehicleB!, PRICE_B);
    await sell(s, s.vehicleA, PRICE_A);

    const recon = await depositReconciliation(s);
    expect(recon.isReconciled).toBe(true);
    // Nothing is owed: all 5,000 went against B's invoice and A carried none.
    expect(recon.byCurrency.JOD!.subledgerBalanceMinor).toBe(0);
    expect(recon.byCurrency.JOD!.glBalanceMinor).toBe(0);
  });

  test("a deposit resolved before per-slice tracking existed still reconciles", async () => {
    // Historical rows carry no application rows, no releasedAmountMinor and no
    // hold treatments. Their status is the only record of what happened, and
    // reading the remainder off face value would resurrect every one of them as
    // an outstanding liability on deploy.
    const s = await seed("reconLegacy");
    await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId,
        vehicleId: s.vehicleA,
        customerId: s.customerId,
        amount: 1_500,
        amountMinor: 1_500 * SCALE,
        currency: "JOD",
        status: "REFUNDED",
        holdActive: false,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );

    expect((await depositReconciliation(s)).isReconciled).toBe(true);
  });
});

describe("a car whose share is zero, once its sale is complete", () => {
  async function zeroShareSold(tag: string) {
    const s = await seed(tag);
    await payDeposit(s);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 0 },
      { vehicleId: s.vehicleB!, amount: 5_000 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    return { s, saleA };
  }

  test("its hold is consumed like any other, not left live on a sold car", async () => {
    // Completion returned early for a zero share, so the hold stayed ALLOCATED
    // and active on a car that was now SOLD — and everything downstream reads
    // an active hold as money that can still be moved.
    const { s } = await zeroShareSold("zeroConsumed");

    const [holdA] = await holdsFor(s, s.vehicleA);
    expect(holdA!.allocationStatus).toBe("APPLIED");
    expect(holdA!.active).toBe(false);
    expect(holdA!.appliedSaleId).toBeDefined();
    await expectConservation(s);
  });

  test("no more deposit money can be allocated to it", async () => {
    const { s } = await zeroShareSold("zeroNoRealloc");

    await expect(allocate(s, [{ vehicleId: s.vehicleA, amount: 2_000 }])).rejects.toThrow(
      /already (been applied|complete)/i
    );
  });

  test("and another car's released share cannot be moved onto it", async () => {
    const { s } = await zeroShareSold("zeroNoTarget");
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleB!,
    });
    const releasedB = (await holdsFor(s, s.vehicleB!)).filter(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    );

    await expect(
      s.asUser.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId: releasedB[0]!._id,
        treatment: "REALLOCATE_TO_VEHICLE" as const,
        toVehicleId: s.vehicleA,
      })
    ).rejects.toThrow(/already complete/i);
  });

  test("cancelling that sale puts the share back and frees the car", async () => {
    const { s, saleA } = await zeroShareSold("zeroCancel");

    await cancel(s, saleA);

    const [holdA] = await holdsFor(s, s.vehicleA);
    expect(holdA!.allocationStatus).toBe("ALLOCATED");
    expect(holdA!.active).toBe(true);
    await expect(allocate(s, [{ vehicleId: s.vehicleA, amount: 0 }])).resolves.toBeDefined();
    await expectConservation(s);
  });
});
