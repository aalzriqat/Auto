/**
 * SCRUM-195 PHASE 2 (M3) — ROOT-LOCAL FINALIZATION, SPECIFIED BEFORE IT EXISTS.
 *
 * REBUILT. The previous specification at `b3a8cb1d9` was BLOCKED by both review
 * seats and is frozen as rejected evidence. This is not a patch of it — the
 * defect was in its premise, and a patch would have carried the premise forward.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THE LAST SPECIFICATION GOT WRONG, SO IT IS NOT REPEATED HERE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. IT ASSUMED ONE LIVE CLAIM PER ROOT. Every contract indexed `claims[0]` or
 *    asserted `claims.length === 1`. Phase 1's own certified suite disproves it:
 *    `commitmentAuthority.test.ts:337` — "the SAME deal taking a further
 *    instalment JOINS its root (I3)" — two instalments on a SINGLE-CAR quote,
 *    "each acquisition is its own episode… and both are live". A finance
 *    application adds a third kind alongside them. G.2 and G.3 below pin that
 *    fact FIRST, in this file, so nothing downstream can quietly assume away.
 *
 * 2. IT REACHED A "NO SALE" STATE BY COMPLETING A SALE AND CANCELLING IT.
 *    Complete-then-cancel is a REVERSAL — Phase 3's mechanism. Four contracts
 *    became unsatisfiable because the reversal had already made rows terminal.
 *    The genuine never-sold door is `deposits.releaseVehicleAllocation`, whose
 *    own guard refuses when a slice is already APPLIED, so it can only run when
 *    no sale ever consumed it.
 *
 * 3. IT MADE THE ROOT WAIT ON THE MONEY. It required a deal to stay OPEN while
 *    its cash sat in `RELEASED_AWAITING_DECISION`. Owner ruling c15676 corrects
 *    this, and the correction is the load-bearing idea of this file:
 *
 *        THE ROOT LOCKS THE CAR. IT DOES NOT LOCK THE CASH.
 *
 *    A released car is free immediately; its money can still be undecided. If
 *    the root stayed OPEN, no rival could ever take the car — which would make
 *    `resolveReleasedAllocation`'s own "somebody else may legitimately have
 *    taken the vehicle in the meantime" guard permanently unreachable. F.8
 *    proves the rival CAN take it; F.9 proves the return then refuses.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE MODEL — B+, ROOT-ONLY FINALIZATION (owner ruling c15676)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 writes EXACTLY TWO THINGS, both on `commitmentRoots`:
 *
 *      sale completes for a committed car   ->  status OPEN -> CONSUMED
 *                                               consumedBySaleId = that sale
 *      never-sold car leaves the deal       ->  status OPEN -> RELEASED
 *
 * Phase 2 NEVER writes: `vehicleCommitmentClaims.status`,
 * `vehicleCommitmentClaims.consumedBySaleId`, or `restoredFromClaimId`. Claim
 * lifecycle is Phase 3's entirely. F.1, F.12 and F.10 each assert the claims are
 * left untouched, from three different directions.
 *
 * WHY NOT CONSUME THE CLAIMS (the rejected option A): a root can legitimately
 * carry several live episodes at once, so "consume the live claims" has no
 * structural cardinality bound, and "consume the right subset" has no defensible
 * definition when a root holds two deposit instalments plus a FINANCE episode.
 * Root-only finalization has exactly one row to write per car, always.
 *
 * WHY THE ROOT STILL NEEDS `consumedBySaleId`: without it, Phase 3 would have to
 * GUESS which root a cancelled sale belonged to. This gives it an exact
 * `sale -> root` entry point without pretending the individual episodes were
 * consumed. It is write-once, on OPEN -> CONSUMED only.
 *
 * ⚠️ THAT FIELD DOES NOT EXIST IN THE SCHEMA YET. This commit is tests-only, so
 * it cannot add it. The contracts below read it through a narrow cast so the
 * file typechecks against today's schema while still specifying tomorrow's
 * behaviour. Adding the field is Phase-2 implementation work.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * PART A / PART B, AND WHY THE SPLIT SURVIVES THE REBUILD
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   PART A (G.*) — what is TRUE TODAY. Green now, green after M3. If one of
 *   these is red, my model of the system is wrong and Part B is built on sand.
 *   Last round this caught three fixture errors before they could be misread as
 *   missing behaviour. It earned its place; it is bigger here, not smaller.
 *
 *   PART B (F.*) — what M3 must do. Red now, each failing at its own
 *   finalization assertion and never in setup.
 *
 * No contract imports a finalization function: importing something unwritten is
 * a compile error that would turn the whole file red, Part A included, and
 * destroy the only signal the split provides. Every contract asserts observable
 * state after a real product door runs.
 *
 * THE COMPLETION DOORS ARE ENUMERATED FROM CALL SITES, not guessed. Walking
 * upward from every call of `completeSale` / `completeSalesForLineItems` /
 * `completeExistingSale` gives exactly four:
 *
 *      sales.ts:372   -> api.sales.create
 *      sales.ts:421   -> api.sales.completeFromQuote
 *      sales.ts:523   -> api.sales.completeDraft
 *      applications.ts:3130 -> api.applications.finalizeDeal
 *
 * The previous spec exercised only the second. F.13 covers all four.
 */

import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "delete:sales",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
  "create:finance_application",
];

const PRICE = 30_000;

/**
 * `commitmentRoots.consumedBySaleId` is Phase-2 implementation work and is not
 * in the schema yet. Reading it through this cast lets a tests-only commit
 * specify the behaviour without the file failing to typecheck today.
 */
function rootSaleStamp(root: Doc<"commitmentRoots">): string | undefined {
  const stamped = (root as unknown as { consumedBySaleId?: Id<"sales"> }).consumedBySaleId;
  return stamped === undefined ? undefined : String(stamped);
}

// ── fixtures ────────────────────────────────────────────────────────────────
//
// `ctx.db` seeds the org/user/vehicle scaffolding, as Phase 1's suite does.
// Every ACT under test goes through a real product door under a real
// authenticated identity — no write-capable backdoor into quotes, deposits,
// sales, applications or the authority.

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Dealer ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `user_${suffix}`,
      email: `${suffix}@test.com`,
      name: "Sales User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `user_${suffix}`, clerkId: `user_${suffix}` });

  // A SECOND REAL IDENTITY. Cancelling a completed sale calls
  // `assertDifferentActors` (`sales.ts:641`) and refunds/forfeits refuse the
  // deposit's own creator — two separation-of-duties controls that killed
  // contracts in SETUP last round.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `mgr_${suffix}`,
      email: `mgr-${suffix}@test.com`,
      name: "Manager",
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  const asManager = t.withIdentity({ subject: `mgr_${suffix}`, clerkId: `mgr_${suffix}` });

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+9627922${suffix.length}01`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+9627922${suffix.length}02`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, asUser, managerId, asManager, customerA, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

let vinCounter = 0;
async function vehicle(seed: Seed) {
  vinCounter += 1;
  const vin = `3VWFA7AT${String(700000 + vinCounter).slice(0, 6)}ZZ`;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Toyota",
      model: "RAV4",
      year: 2023,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 90,
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

async function quoteFor(
  seed: Seed,
  customerId: Id<"customers">,
  vehicles: Array<Id<"vehicles">>
) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId: vehicles[0],
    vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })),
    mode: "CASH" as const,
    vehiclePrice: PRICE * vehicles.length,
    downPayment: 0,
    termMonths: 0,
  });
}

async function depositOn(seed: Seed, quoteId: Id<"quotes">, amount: number) {
  return await seed.asUser.mutation(api.deposits.create, {
    orgId: seed.orgId,
    quoteId,
    amount,
  });
}

async function allocate(
  seed: Seed,
  quoteId: Id<"quotes">,
  allocations: Array<{ vehicleId: Id<"vehicles">; amount: number }>
) {
  return await seed.asUser.mutation(api.deposits.allocateToVehicles, {
    orgId: seed.orgId,
    quoteId,
    allocations,
  });
}

async function completeQuote(seed: Seed, quoteId: Id<"quotes">) {
  return await seed.asUser.mutation(api.sales.completeFromQuote, {
    orgId: seed.orgId,
    quoteId,
  });
}

/** The never-sold door: this car leaves the deal, no sale ever existed. */
async function releaseVehicle(seed: Seed, quoteId: Id<"quotes">, vehicleId: Id<"vehicles">) {
  return await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
    orgId: seed.orgId,
    quoteId,
    vehicleId,
    reason: "customer dropped this car from the deal",
  });
}

/** Cancellation goes through the MANAGER — the seller may not cancel their own sale. */
async function cancelSale(seed: Seed, saleId: Id<"sales">) {
  return await seed.asManager.mutation(api.sales.update, {
    orgId: seed.orgId,
    saleId,
    status: "CANCELLED" as const,
  });
}

async function rootsOn(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("commitmentRoots").collect()).filter((r) => r.vehicleId === v)
  );
}

async function claimsOn(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleCommitmentClaims").collect()).filter((c) => c.vehicleId === v)
  );
}

async function holdsOn(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("depositVehicleHolds").collect()).filter((h) => h.vehicleId === v)
  );
}

/** Every claim fact Phase 2 is forbidden to change, as a comparable census. */
async function claimCensus(seed: Seed, v: Id<"vehicles">) {
  return (await claimsOn(seed, v))
    .map((c) =>
      [
        String(c._id),
        c.status,
        c.evidenceKind,
        String(c.consumedBySaleId ?? "-"),
        String(c.restoredFromClaimId ?? "-"),
        String(c.resolvedAt ?? "-"),
      ].join("|")
    )
    .sort();
}

async function salesByVehicle(seed: Seed): Promise<Record<string, string>> {
  return await seed.t.run(async (ctx) => {
    const rows = await ctx.db.query("sales").collect();
    return Object.fromEntries(rows.map((s) => [String(s.vehicleId), String(s._id)]));
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PART A — THE SYSTEM AS IT ACTUALLY IS
// ══════════════════════════════════════════════════════════════════════════════

describe("P2-G ground truth the M3 spec is built on", () => {
  test("G.1 a deposit opens exactly one OPEN root", async () => {
    const seed = await seedDealer("g1");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const roots = await rootsOn(seed, car);
    expect(roots.length, "one physical car, one root").toBe(1);
    expect(roots[0].status, "acquisition opens it").toBe("OPEN");
  });

  test("G.2 ONE root can carry SEVERAL live episodes — two instalments", async () => {
    // ⚠️ THE FACT THAT KILLED THE PREVIOUS SPECIFICATION. It assumed one live
    // claim per root throughout. Phase 1's own certified contract 1.4 already
    // disproved that, on a SINGLE-CAR quote, and I did not read it. Pinning it
    // here, first, so nothing below can quietly assume it away again.
    const seed = await seedDealer("g2");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    await depositOn(seed, quoteId, 1_000);

    expect((await rootsOn(seed, car)).length, "one deal, one root").toBe(1);
    const claims = await claimsOn(seed, car);
    expect(claims.length, "each instalment is its own episode").toBe(2);
    expect(
      claims.every((c) => c.status === "ACTIVE"),
      "and BOTH are live at once"
    ).toBe(true);
    expect(
      new Set(claims.map((c) => String(c.rootId))).size,
      "on the SAME root"
    ).toBe(1);
  });

  test("G.3 and it can carry DIFFERENT EVIDENCE KINDS at once — DEPOSIT + FINANCE", async () => {
    // The second half of the cardinality fact. `applications.ts:2199` is
    // explicit: the application is "a separate episode" from any co-existing
    // deposit episode on the same root, and "each must be able to end
    // independently". So a root can hold two KINDS of live evidence, not just
    // two of one kind.
    const seed = await seedDealer("g3");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    expect((await rootsOn(seed, car)).length, "still one deal, one root").toBe(1);
    const claims = await claimsOn(seed, car);
    expect(
      claims.map((c) => c.evidenceKind).sort(),
      "two live episodes of DIFFERENT kinds"
    ).toEqual(["DEPOSIT", "FINANCE"]);
    expect(
      claims.every((c) => c.status === "ACTIVE"),
      "both live"
    ).toBe(true);
  });

  test("G.4 THE GAP: a completed sale leaves the root OPEN and unstamped", async () => {
    // ⚠️ MUST BE DELETED WHEN M3 LANDS, not fixed. F.1 is its inversion. It is
    // named GAP so that is unmissable. Its job is to make a Part B failure
    // readable as "finalization is missing" rather than "the fixture never sold
    // anything".
    const seed = await seedDealer("g4");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: the sale really completed").toBe(1);
    const sale = await seed.t.run((ctx) => ctx.db.get(saleIds[0]));
    expect(sale?.status, "precondition: and it is COMPLETED").toBe("COMPLETED");

    const root = (await rootsOn(seed, car))[0];
    expect(root.status, "the deal that sold the car still holds it").toBe("OPEN");
    expect(rootSaleStamp(root), "and nothing recorded which sale ended it").toBeUndefined();
  });

  test("G.5 nothing anywhere in the branch has ever written a terminal root", async () => {
    const seed = await seedDealer("g5");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_000 },
      { vehicleId: b, amount: 2_000 },
    ]);
    await completeQuote(seed, quoteId);

    const roots = await seed.t.run(async (ctx) => await ctx.db.query("commitmentRoots").collect());
    expect(roots.length, "precondition: there are roots to have terminalized").toBeGreaterThan(0);
    expect(
      roots.map((r) => r.status),
      "every root in the database is still OPEN"
    ).toEqual(roots.map(() => "OPEN"));
  });

  test("G.6 the NEVER-SOLD door releases a car's money without any sale existing", async () => {
    // ⚠️ THIS IS THE DOOR THE PREVIOUS SPEC SHOULD HAVE USED. It reached the
    // same money-state by completing a sale and cancelling it — a REVERSAL,
    // which is Phase 3 — and four contracts became unsatisfiable as a result.
    // `releaseVehicleAllocation` refuses when a slice is already APPLIED
    // ("Cancel the sale before removing the vehicle from the deal"), so it can
    // only ever run when no sale consumed it.
    const seed = await seedDealer("g6");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);

    await releaseVehicle(seed, quoteId, a);

    const sales = await seed.t.run(async (ctx) => await ctx.db.query("sales").collect());
    expect(sales.length, "no sale was ever created — this is the never-sold path").toBe(0);

    const limbo = (await holdsOn(seed, a)).filter(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    );
    expect(limbo.length, "car A's money is off the car and awaiting a decision").toBe(1);
  });

  test("G.7 a cancelled sale leaves the canonical commitment history untouched", async () => {
    // The Phase-3 sentinel, in its strongest form. Owner ruling c15676:
    // "Cancellation performs zero canonical commitment lifecycle work in Phase
    // 2." True today because nothing writes lifecycle at all; F.10 requires it
    // to STAY true once M3 ships.
    const seed = await seedDealer("g7");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    const saleIds = await completeQuote(seed, quoteId);

    const before = await claimCensus(seed, a);
    const saleA = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return rows.find((s) => String(s.vehicleId) === String(a))!;
    });
    expect(saleIds.map(String), "precondition").toContain(String(saleA._id));

    await cancelSale(seed, saleA._id);

    expect(await claimCensus(seed, a), "not one claim fact changed").toEqual(before);
    expect(
      (await claimsOn(seed, a)).filter((c) => c.restoredFromClaimId !== undefined).length,
      "and no successor episode was invented — restoration is Phase 3"
    ).toBe(0);
  });

  test("G.8 a root can carry 60+ live episodes at once", async () => {
    // The cardinality fact at scale, and the reason option A was rejected:
    // "consume the live claims" has no structural bound. F.11 requires root
    // finalization to be indifferent to this number.
    const seed = await seedDealer("g8");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    const root = (await rootsOn(seed, car))[0];

    await seed.t.run(async (ctx) => {
      for (let n = 0; n < 60; n += 1) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: seed.orgId,
          rootId: root._id,
          vehicleId: car,
          evidenceKind: "DEPOSIT" as const,
          status: "ACTIVE" as const,
          createdAt: Date.now(),
          createdBy: seed.userId,
        });
      }
    });

    const live = await seed.t.run(async (ctx) =>
      await ctx.db
        .query("vehicleCommitmentClaims")
        .withIndex("by_root_status", (q) => q.eq("rootId", root._id).eq("status", "ACTIVE"))
        .collect()
    );
    expect(live.length, "sixty-one live episodes on ONE root, and all legitimate").toBe(61);
    expect((await rootsOn(seed, car)).length, "still exactly one root").toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART B — THE M3 SPECIFICATION (B+, root-only)
//
// RED until M3 ships. Each must fail at its own finalization assertion, never in
// setup — Part A is what buys the right to read a failure that way.
// ══════════════════════════════════════════════════════════════════════════════

describe("P2-F root-local finalization (M3)", () => {
  test("F.1 a completed sale CONSUMES the root, stamps the sale, and touches NO claim", async () => {
    // The inversion of G.4, and the whole of B+ in one contract. Note what is
    // asserted about the episodes: NOTHING CHANGED. Under B+ the claim lifecycle
    // is Phase 3's entirely, so "the claims are untouched" is not an omission —
    // it is the specification.
    const seed = await seedDealer("f1");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const before = await claimCensus(seed, car);
    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: one car, one sale").toBe(1);

    const root = (await rootsOn(seed, car))[0];
    expect(root.status, "the deal became a sale — CONSUMED, not RELEASED").toBe("CONSUMED");
    expect(root.closedAt, "and it records when").toBeTruthy();
    expect(
      rootSaleStamp(root),
      "stamped with THIS sale — Phase 3's exact sale->root entry point"
    ).toBe(String(saleIds[0]));

    expect(
      await claimCensus(seed, car),
      "and not one episode was touched: claim lifecycle is Phase 3, not Phase 2"
    ).toEqual(before);
  });

  test("F.2 a genuinely FREE walk-in car sells without inventing a deal to close", async () => {
    const seed = await seedDealer("f2");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    expect((await rootsOn(seed, car)).length, "precondition: nobody committed").toBe(0);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "the walk-in sale completes").toBe(1);
    expect(
      (await rootsOn(seed, car)).length,
      "and no root was invented to give finalization something to close"
    ).toBe(0);
  });

  test("F.3 a RIVAL customer's sale on a held car is REFUSED, with zero residue", async () => {
    const seed = await seedDealer("f3");
    const car = await vehicle(seed);

    const bQuote = await quoteFor(seed, seed.customerB, [car]);
    await depositOn(seed, bQuote, 2_000);
    const rival = (await rootsOn(seed, car))[0];

    const aQuote = await quoteFor(seed, seed.customerA, [car]);
    let threw: unknown = null;
    try {
      await completeQuote(seed, aQuote);
    } catch (e) {
      threw = e;
    }
    expect(threw, "A may not sell a car B's deal holds").toBeTruthy();

    expect(
      (await seed.t.run(async (ctx) => await ctx.db.query("sales").collect())).length,
      "and no sale row survives the refusal"
    ).toBe(0);
    const after = (await rootsOn(seed, car))[0];
    expect(String(after._id), "B's root, not a replacement").toBe(String(rival._id));
    expect(after.status, "untouched").toBe("OPEN");
  });

  test("F.4 the SAME customer on a DIFFERENT deal is refused too — identity is the root, not the person", async () => {
    // ⚠️ I2. A root's identity is server-owned and is never `(customerId,
    // vehicleId)`. An implementation that reads "same customer" as sufficient
    // lineage would pass F.3 and fail here — which is exactly why F.3 alone is
    // not enough, and why the previous specification's rival test was weak.
    const seed = await seedDealer("f4");
    const car = await vehicle(seed);

    const dealOne = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, dealOne, 2_000);
    const held = (await rootsOn(seed, car))[0];

    // A SECOND, UNRELATED quote for the same customer and the same car, proving
    // nothing about the first deal.
    const dealTwo = await quoteFor(seed, seed.customerA, [car]);

    let threw: unknown = null;
    try {
      await completeQuote(seed, dealTwo);
    } catch (e) {
      threw = e;
    }
    expect(
      threw,
      "a second deal cannot sell the car merely because it names the same customer"
    ).toBeTruthy();

    const after = (await rootsOn(seed, car))[0];
    expect(String(after._id), "the FIRST deal's root, not a replacement").toBe(String(held._id));
    expect(after.customerId, "still owned by the deal that proved itself").toBe(held.customerId);
    expect(after.status, "the first deal still holds it").toBe("OPEN");
    expect(rootSaleStamp(after), "and nothing was stamped on it").toBeUndefined();
    expect(
      (await rootsOn(seed, car)).length,
      "and the second deal did not open a rival root on the same car"
    ).toBe(1);
    expect(
      (await seed.t.run(async (ctx) => await ctx.db.query("sales").collect())).length,
      "no sale row"
    ).toBe(0);
  });

  test("F.5 a 2-car deal terminalizes each root against ITS OWN sale", async () => {
    const seed = await seedDealer("f5");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: two cars, two sales").toBe(2);
    const byVehicle = await salesByVehicle(seed);

    const stamps = new Set<string>();
    for (const car of [a, b]) {
      const root = (await rootsOn(seed, car))[0];
      expect(root.status, `car ${String(car)} consumed`).toBe("CONSUMED");
      expect(
        rootSaleStamp(root),
        "stamped with THAT CAR'S sale, not whichever ran last"
      ).toBe(byVehicle[String(car)]);
      stamps.add(String(rootSaleStamp(root)));
    }
    expect(stamps.size, "two DISTINCT stamps").toBe(2);
  });

  test("F.6 a 3-car deal does the same, with three distinct stamps", async () => {
    const seed = await seedDealer("f6");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const c = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b, c]);
    await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 3_000 },
      { vehicleId: b, amount: 2_000 },
      { vehicleId: c, amount: 1_000 },
    ]);

    expect((await completeQuote(seed, quoteId)).length, "three sales").toBe(3);
    const byVehicle = await salesByVehicle(seed);

    const stamps = new Set<string>();
    for (const car of [a, b, c]) {
      const root = (await rootsOn(seed, car))[0];
      expect(root.status, `car ${String(car)} consumed`).toBe("CONSUMED");
      expect(rootSaleStamp(root), "its own sale").toBe(byVehicle[String(car)]);
      stamps.add(String(rootSaleStamp(root)));
    }
    expect(stamps.size, "three DISTINCT stamps — no state leaked between cars").toBe(3);
  });

  test("F.7 completion order does not change any car's outcome — including WHICH sale stamped it", async () => {
    // ⚠️ THE PREVIOUS VERSION OF THIS CONTRACT RECORDED ONLY *WHETHER* A STAMP
    // EXISTED, so a reverse-order bug that stamped each car with the other's
    // sale would have passed it. This compares the stamp to the car's own sale
    // in BOTH orders.
    async function run(suffix: string, reverse: boolean) {
      const seed = await seedDealer(suffix);
      const a = await vehicle(seed);
      const b = await vehicle(seed);
      const quoteId = await quoteFor(seed, seed.customerA, reverse ? [b, a] : [a, b]);
      await depositOn(seed, quoteId, 4_000);
      await allocate(seed, quoteId, [
        { vehicleId: a, amount: 2_500 },
        { vehicleId: b, amount: 1_500 },
      ]);
      await completeQuote(seed, quoteId);
      const byVehicle = await salesByVehicle(seed);

      const describeCar = async (car: Id<"vehicles">) => {
        const root = (await rootsOn(seed, car))[0];
        return {
          status: root?.status ?? null,
          stampedWithOwnSale: rootSaleStamp(root) === byVehicle[String(car)],
        };
      };
      return { a: await describeCar(a), b: await describeCar(b) };
    }

    const forward = await run("f7f", false);
    const backward = await run("f7b", true);

    expect(forward, "the same outcome whichever car completed first").toEqual(backward);
    expect(forward.a.status, "and it is the RIGHT outcome, not merely a stable wrong one").toBe(
      "CONSUMED"
    );
    expect(forward.a.stampedWithOwnSale, "car A stamped with car A's sale").toBe(true);
    expect(forward.b.stampedWithOwnSale, "car B stamped with car B's sale").toBe(true);
  });

  test("F.8 SCRUM-199: a never-sold car leaving the deal RELEASES its root — while the money stays undecided", async () => {
    // ⚠️ THE SEMANTIC CORRECTION AT THE HEART OF THIS REBUILD (owner c15676):
    // THE ROOT LOCKS THE CAR, IT DOES NOT LOCK THE CASH. The previous spec had
    // the deal stay OPEN until the money was resolved. These two states coexist
    // legitimately: the car is free, the cash still needs a decision.
    const seed = await seedDealer("f8");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);

    await releaseVehicle(seed, quoteId, a);

    const rootA = (await rootsOn(seed, a))[0];
    expect(rootA.status, "the deal let the car go without selling it").toBe("RELEASED");
    expect(
      rootSaleStamp(rootA),
      "and no sale is stamped on it, because none happened"
    ).toBeUndefined();

    expect(
      (await holdsOn(seed, a)).filter(
        (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
      ).length,
      "the money is STILL undecided — and that does not keep the car"
    ).toBe(1);

    expect(
      (await rootsOn(seed, b))[0].status,
      "car B, still on the deal, is untouched"
    ).toBe("OPEN");
  });

  test("F.9 and a RIVAL can then genuinely acquire that released car", async () => {
    // The proof that F.8's release is real rather than cosmetic. If the root had
    // stayed OPEN, this acquisition could never succeed — and
    // `resolveReleasedAllocation`'s own "somebody else may legitimately have
    // taken the vehicle in the meantime" guard would be unreachable code.
    const seed = await seedDealer("f9");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    await releaseVehicle(seed, quoteId, a);
    const releasedRootId = String((await rootsOn(seed, a))[0]._id);

    // ⚠️ THE ACQUISITION IS AN ASSERTED STEP, NOT BARE SETUP. Until M3 releases
    // the root the authority refuses this with "already committed to another
    // deal" — which is the very behaviour under test. Left as a plain fixture
    // line it would throw, and the failure would read as a broken fixture
    // rather than as the missing release. Naming it makes the red legible.
    const rivalQuote = await quoteFor(seed, seed.customerB, [a]);
    let refusal: unknown = null;
    try {
      await depositOn(seed, rivalQuote, 1_000);
    } catch (e) {
      refusal = e;
    }
    expect(
      refusal,
      "a RELEASED car must be acquirable by a rival — if this refuses, the release was cosmetic"
    ).toBeNull();

    const roots = await rootsOn(seed, a);
    const rivalRoots = roots.filter((r) => String(r._id) !== releasedRootId);
    expect(rivalRoots.length, "the rival opened its OWN root on the freed car").toBe(1);
    expect(rivalRoots[0].status, "which is live").toBe("OPEN");
    expect(rivalRoots[0].customerId, "and belongs to the rival").toBe(seed.customerB);
    expect(
      roots.find((r) => String(r._id) === releasedRootId)!.status,
      "the released deal stays RELEASED — the rival did not reopen it"
    ).toBe("RELEASED");
  });

  test("F.10 a RETURN of that money then REFUSES, because the car is no longer free", async () => {
    // The other half of F.9, and the reason the release must be real.
    // `resolveReleasedAllocation` treats RETURN/REALLOCATE as a FRESH
    // acquisition; a fresh acquisition of a car somebody else now holds must
    // refuse rather than silently re-take it.
    const seed = await seedDealer("f10");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    await releaseVehicle(seed, quoteId, a);

    const limbo = (await holdsOn(seed, a)).find(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    )!;
    expect(limbo, "precondition: money awaiting a decision").toBeTruthy();

    // The rival takes the freed car first — asserted, not assumed, for the same
    // reason as F.9: today this refuses because the root was never released,
    // and that must read as the missing release rather than a broken fixture.
    const rivalQuote = await quoteFor(seed, seed.customerB, [a]);
    let rivalRefusal: unknown = null;
    try {
      await depositOn(seed, rivalQuote, 1_000);
    } catch (e) {
      rivalRefusal = e;
    }
    expect(
      rivalRefusal,
      "precondition: the rival can take the released car (F.9's contract)"
    ).toBeNull();

    let threw: unknown = null;
    try {
      await seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId: limbo._id,
        treatment: "RETURN_TO_UNALLOCATED" as const,
        reason: "customer wants this car back",
      });
    } catch (e) {
      threw = e;
    }
    expect(
      threw,
      "the money cannot be put back onto a car another deal now holds"
    ).toBeTruthy();

    const rivalRoot = (await rootsOn(seed, a)).find((r) => r.customerId === seed.customerB)!;
    expect(rivalRoot.status, "and the rival's hold is undisturbed").toBe("OPEN");
  });

  test("F.11 cancelling a sale changes NOTHING in canonical commitment history", async () => {
    // ⚠️ THE PHASE BOUNDARY, AS A CONTRACT (owner c15676): "Cancellation
    // performs zero canonical commitment lifecycle work in Phase 2." The root
    // stays CONSUMED and stamped; no episode moves; no successor appears.
    // Restoration — deciding which evidence returns and on which root — is
    // Phase 3's, and doing any of it here would pre-empt that design.
    const seed = await seedDealer("f11");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    const saleIds = await completeQuote(seed, quoteId);
    const byVehicle = await salesByVehicle(seed);

    const rootBefore = (await rootsOn(seed, a))[0];
    expect(rootBefore.status, "precondition: the sale consumed the root").toBe("CONSUMED");
    const claimsBefore = await claimCensus(seed, a);

    const saleA = byVehicle[String(a)];
    expect(saleIds.map(String), "precondition").toContain(saleA);
    await cancelSale(seed, saleA as Id<"sales">);

    const rootAfter = (await rootsOn(seed, a))[0];
    expect(rootAfter.status, "the root stays CONSUMED — reversal is Phase 3").toBe("CONSUMED");
    expect(
      rootSaleStamp(rootAfter),
      "and its write-once sale stamp is NOT erased"
    ).toBe(saleA);
    expect(await claimCensus(seed, a), "no episode moved").toEqual(claimsBefore);
    expect(
      (await claimsOn(seed, a)).filter((c) => c.restoredFromClaimId !== undefined).length,
      "and no successor episode was created"
    ).toBe(0);
  });

  test("F.12 root finalization is indifferent to 61 live episodes — it neither scans nor patches them", async () => {
    // ⚠️ WHY B+ WAS CHOSEN OVER A. "Consume the live claims" has no structural
    // bound: G.8 shows a root can carry any number. Root-only finalization
    // writes exactly ONE row per car regardless. This asserts the property that
    // makes that true — every episode is byte-for-byte unchanged.
    const seed = await seedDealer("f12");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    const root = (await rootsOn(seed, car))[0];

    await seed.t.run(async (ctx) => {
      for (let n = 0; n < 60; n += 1) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: seed.orgId,
          rootId: root._id,
          vehicleId: car,
          evidenceKind: "DEPOSIT" as const,
          status: "ACTIVE" as const,
          createdAt: Date.now(),
          createdBy: seed.userId,
        });
      }
    });

    const before = await claimCensus(seed, car);
    expect(before.length, "precondition: sixty-one live episodes").toBe(61);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: the sale completed").toBe(1);

    expect((await rootsOn(seed, car))[0].status, "the ONE root is consumed").toBe("CONSUMED");
    expect(
      await claimCensus(seed, car),
      "and all sixty-one episodes are exactly as they were"
    ).toEqual(before);
  });

  test("F.13 a root holding DEPOSIT and FINANCE episodes is consumed once, and neither episode moves", async () => {
    // The mixed-evidence case. Under A this was the ambiguity with no
    // defensible answer — consume the deposit episode, the finance one, or
    // both? Under B+ the question does not arise: the ROOT is the unit.
    const seed = await seedDealer("f13");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    const before = await claimCensus(seed, car);
    expect(before.length, "precondition: two live episodes of two kinds").toBe(2);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: the sale completed").toBe(1);

    const roots = await rootsOn(seed, car);
    expect(roots.length, "still ONE root").toBe(1);
    expect(roots[0].status, "consumed once").toBe("CONSUMED");
    expect(rootSaleStamp(roots[0]), "stamped once").toBe(String(saleIds[0]));
    expect(
      await claimCensus(seed, car),
      "and NEITHER episode moved — not the deposit one, not the finance one"
    ).toEqual(before);
  });

  test("F.14 EVERY production completion door terminalizes the root, not just the quote wizard", async () => {
    // ⚠️ THE PREVIOUS SPEC EXERCISED ONE DOOR OF FOUR. An implementation wired
    // only into `completeFromQuote` would have satisfied all of it while
    // leaving three production paths writing sales that never close a deal.
    // The four are enumerated from CALL SITES of `completeSale` /
    // `completeSalesForLineItems` / `completeExistingSale`, not guessed.

    // (a) api.sales.create — a direct completed sale.
    const s1 = await seedDealer("f14a");
    const car1 = await vehicle(s1);
    const q1 = await quoteFor(s1, s1.customerA, [car1]);
    await depositOn(s1, q1, 2_000);
    const sale1 = await s1.asUser.mutation(api.sales.create, {
      orgId: s1.orgId,
      vehicleId: car1,
      customerId: s1.customerA,
      salespersonId: s1.userId,
      salePrice: PRICE,
      saleDate: Date.now(),
      status: "COMPLETED" as const,
      quoteId: q1,
    });
    const r1 = (await rootsOn(s1, car1))[0];
    expect(r1.status, "sales.create consumes the root").toBe("CONSUMED");
    expect(rootSaleStamp(r1), "and stamps its sale").toBe(String(sale1));

    // (b) api.sales.completeDraft — a PENDING sale finished later.
    const s2 = await seedDealer("f14b");
    const car2 = await vehicle(s2);
    const q2 = await quoteFor(s2, s2.customerA, [car2]);
    await depositOn(s2, q2, 2_000);
    const draftId = await s2.asUser.mutation(api.sales.createDraft, {
      orgId: s2.orgId,
      vehicleId: car2,
      customerId: s2.customerA,
      salespersonId: s2.userId,
      salePrice: PRICE,
      saleDate: Date.now(),
      quoteId: q2,
    });
    await s2.asUser.mutation(api.sales.completeDraft, { orgId: s2.orgId, saleId: draftId });
    const r2 = (await rootsOn(s2, car2))[0];
    expect(r2.status, "sales.completeDraft consumes the root").toBe("CONSUMED");
    expect(rootSaleStamp(r2), "and stamps its sale").toBe(String(draftId));

    // (c) api.sales.completeFromQuote — the wizard path, already covered by F.1.
    const s3 = await seedDealer("f14c");
    const car3 = await vehicle(s3);
    const q3 = await quoteFor(s3, s3.customerA, [car3]);
    await depositOn(s3, q3, 2_000);
    const sale3 = (await completeQuote(s3, q3))[0];
    const r3 = (await rootsOn(s3, car3))[0];
    expect(r3.status, "sales.completeFromQuote consumes the root").toBe("CONSUMED");
    expect(rootSaleStamp(r3), "and stamps its sale").toBe(String(sale3));

    // ⚠️⚠️ THE FOURTH DOOR IS NOT EXERCISED HERE, AND THAT IS A DECLARED GAP.
    //
    // `api.applications.finalizeDeal` (`applications.ts:2963`, reaching
    // `completeSale` at `:3130`) is the financed completion path. Its
    // preconditions are a real lifecycle, not a flag:
    //
    //   status APPROVED            -> api.applications.updateStatus
    //   vehicleHandoverAt          -> api.applications.registerVehicleHandover,
    //                                 which "demands unconditionally" an
    //                                 `economicsStamp` the server issues from
    //                                 the deal cockpit
    //   expectedPaymentMethod/Date -> api.applications.registerExpectedPayment
    //
    // Reaching it honestly means driving the financed-deal cockpit. Reaching it
    // DISHONESTLY — patching those fields with `ctx.db` — would build a fixture
    // that does not reflect production, which is precisely the class of error
    // this rebuild exists to eliminate, so it is not done.
    //
    // This is recorded as an OPEN ITEM against the owner's requirement to cover
    // every completion door. M3 must not be considered specified until a
    // financed-completion contract exists here; three of four doors is a
    // narrower guarantee than it looks, because the financed path is the one
    // that can carry FINANCE and DEPOSIT evidence on the same root (F.13).
  });

  test("F.15 terminalization is monotonic — a consumed root is never reopened or re-stamped", async () => {
    const seed = await seedDealer("f15");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    const saleIds = await completeQuote(seed, quoteId);

    const first = (await rootsOn(seed, car))[0];
    expect(first.status, "precondition: consumed").toBe("CONSUMED");
    const firstStamp = rootSaleStamp(first);
    expect(firstStamp, "precondition: stamped").toBe(String(saleIds[0]));

    // A second completion attempt on the same quote. Whatever it does — succeed
    // idempotently or refuse — it must not move a terminal root.
    await completeQuote(seed, quoteId).catch(() => undefined);

    const second = (await rootsOn(seed, car))[0];
    expect(second.status, "still CONSUMED — terminal is terminal").toBe("CONSUMED");
    expect(rootSaleStamp(second), "and the write-once stamp is unchanged").toBe(firstStamp);
    expect(
      (await rootsOn(seed, car)).length,
      "and no second root appeared for the same car"
    ).toBe(1);
  });
});
