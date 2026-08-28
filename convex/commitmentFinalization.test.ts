/**
 * SCRUM-195 PHASE 2 (M3) — THE FINALIZATION BARRIER, SPECIFIED BEFORE IT EXISTS.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS SPLIT IN TWO, AND WHY THAT IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * PR #259 is the reason this file has a PART A. That attempt produced a large,
 * confident, entirely test-first specification — and the specification itself
 * was wrong. A red suite proves nothing about whether the thing it demands is
 * the right thing; it only proves the thing is absent. Absence is easy to
 * demonstrate and worthless to be confident about.
 *
 * So this file separates two claims that a single red suite silently merges:
 *
 *   PART A — WHAT IS TRUE TODAY.  Green now, and green after M3 ships.
 *            These pin the existing system: the doors, the deposit lifecycle,
 *            the sequential completion loop, the provenance pointer. If any of
 *            them is red, MY MODEL OF THE SYSTEM IS WRONG and every contract in
 *            Part B is suspect — because Part B is built on this model.
 *
 *   PART B — WHAT M3 MUST DO.  Red now, green when M3 lands.
 *            Nothing in the branch terminalizes a root or a claim today, so
 *            these fail. They must fail *at their finalization assertion*, not
 *            in their setup — Part A is what buys the right to say that.
 *
 * A Part A failure is a louder signal than any Part B failure. It says the spec
 * is describing a system that does not exist.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE GAP, ESTABLISHED BY READING THE BRANCH RATHER THAN ASSUMING IT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 1 shipped acquisition authority and NO finalization. Verified:
 *
 *   - `convex/utils/saleCompletion.ts` contains ZERO references to commitments,
 *     roots or claims. Selling a car does not touch the model that says who
 *     holds it.
 *   - `convex/commitments.ts` performs exactly three writes: insert a root
 *     (always OPEN), insert a claim (always ACTIVE), and patch `headQuoteId`.
 *     There is no status transition anywhere in the branch. Nothing ever writes
 *     RELEASED or CONSUMED.
 *   - `completeSalesForLineItems` loops the quote's vehicles and calls
 *     `completeSale` once per car, passing the SAME `depositResolution` to every
 *     one of them — while the deposit state they share spans the whole deal.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURAL DECISION — OPTION A, AND WHY THE ARTIFACT DECIDES IT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * The owner required an explicit choice, with no accidental hybrid:
 *
 *   A. Phase 2 consumes the forward-sale claim episodes, ACTIVE → CONSUMED,
 *      stamping the exact `consumedBySaleId`.
 *   B. Phase 2 terminalizes roots only and leaves claim consumption to Phase 3.
 *
 * THIS FILE SPECIFIES A. The case is not preference; it is three facts about the
 * schema as committed:
 *
 *   1. `consumedBySaleId` is declared WRITE-ONCE, on ACTIVE → CONSUMED only.
 *      The field exists for exactly one transition, and B never performs it.
 *
 *   2. `by_consumed_sale` is declared and has ZERO uses anywhere in the
 *      repository — production or test. So is `by_restored_from`. These are not
 *      dead weight; they are the two halves of a plan. Phase 2 writes
 *      `consumedBySaleId`, which makes `by_consumed_sale` answer "what did this
 *      sale consume?" in one bounded read. Phase 3 reads that and writes
 *      `restoredFromClaimId`. Under B, `by_consumed_sale` stays permanently
 *      dead and Phase 3 has NOTHING to read.
 *
 *   3. Reversal is the whole reason the model exists, and B makes reversal
 *      reconstruct history. With no sale↔claim link recorded, Phase 3 would have
 *      to infer which episode a cancelled sale had consumed by searching the
 *      episodes that share a deposit — the exact unbounded search that the
 *      `sourceCommitmentClaimId` pointer was introduced to abolish, re-entering
 *      through the reversal door.
 *
 * And A is affordable, which is the part the owner asked to see proved rather
 * than asserted. Two bounded index reads per car sold:
 *
 *      root   :  by_org_vehicle_status (orgId, vehicleId, "OPEN")   -> at most 1 by I1
 *      claims :  by_root_status        (rootId, "ACTIVE")           -> live episodes only
 *
 * The second is the load-bearing one. CONSUMED and RELEASED rows are excluded by
 * the INDEX KEY, not filtered out after reading them — so a root with sixty
 * episodes of history costs exactly what a fresh one costs. G.9 measures that
 * on today's schema, and F.13 requires the barrier to leave that history alone.
 *
 * For deposit-backed evidence there is not even a query: Phase 1 stamped
 * `depositVehicleHolds.sourceCommitmentClaimId`, so the hold a sale consumes
 * already names its episode. `markAllocationApplied` is handed the hold; the
 * claim is one `ctx.db.get` away. The sale→claim bridge was built in Phase 1;
 * Phase 2 is what walks across it.
 *
 * ⚠️ NO HYBRID. A root may not be terminalized while an ACTIVE claim still hangs
 * off it, and a claim may not be consumed without its root being terminalized in
 * the same decision. F.12 pins both directions, because "roots only, mostly" is
 * precisely the half-migrated state the owner forbade.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * SCOPE — THIS COMMIT IS TESTS ONLY
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * No production file changes. Part B is expected to be RED and its redness is
 * the deliverable: it is the specification the M3 implementation will be written
 * against, and the reviewers are being asked whether the SPECIFICATION is right
 * — not whether the code passes it.
 *
 * The two Phase-3 reds in `financedConsignedSettlement.test.ts` and
 * `financingEconomics.test.ts` stay red and stay put. They mark reversal and
 * re-acquisition semantics that Phase 3 owns, and G.8 keeps their precondition
 * honest: nothing here may quietly implement the restoration path they wait for.
 */

import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

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

// ── fixtures ────────────────────────────────────────────────────────────────
//
// Seeding uses `ctx.db` for the org/user/vehicle scaffolding, exactly as the
// Phase 1 suite does. Every ACT under test goes through a real product door
// under a real authenticated identity — there is no write-capable backdoor into
// deposits, quotes, sales or the authority.

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

  // ⚠️ A SECOND REAL IDENTITY, BECAUSE CANCELLATION IS A TWO-PARTY ACT.
  // `sales.update` to CANCELLED calls `assertDifferentActors(user, salespersonId)`
  // — a salesperson may not approve the cancellation of their own sale. Part A
  // caught this: the first draft of these fixtures cancelled as the seller and
  // every cancellation contract died in setup with a separation-of-duties error
  // that has nothing to do with commitments. That is precisely the failure a
  // blind red spec would have mis-read as "M3 is missing".
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
      phone: `+9627911${suffix.length}01`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+9627911${suffix.length}02`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, asUser, managerId, asManager, customerA, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

let vinCounter = 0;
async function vehicle(seed: Seed) {
  vinCounter += 1;
  const vin = `2FMDK3GC${String(400000 + vinCounter).slice(0, 6)}XX`;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Ford",
      model: "Edge",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 120,
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

/** A cash quote over one or more cars, through the real quote door. */
async function quoteFor(
  seed: Seed,
  customerId: Id<"customers">,
  vehicles: Array<Id<"vehicles">>
) {
  const vehicleItems = vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE }));
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId: vehicles[0],
    vehicleItems,
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

// ══════════════════════════════════════════════════════════════════════════════
// PART A — THE SYSTEM AS IT ACTUALLY IS
//
// Green today. Green after M3. If one of these goes red, the spec below is
// describing a system that does not exist and must be re-derived, not patched.
// ══════════════════════════════════════════════════════════════════════════════

describe("P2-G ground truth the M3 spec is built on", () => {
  test("G.1 a deposit on a one-car quote opens exactly one OPEN root with one ACTIVE claim", async () => {
    const seed = await seedDealer("g1");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const roots = await rootsOn(seed, car);
    expect(roots.length, "one physical car, one root").toBe(1);
    expect(roots[0].status, "acquisition opens it").toBe("OPEN");

    const claims = await claimsOn(seed, car);
    expect(claims.length, "one episode").toBe(1);
    expect(claims[0].status, "and it is live").toBe("ACTIVE");
    expect(claims[0].evidenceKind, "on deposit evidence").toBe("DEPOSIT");
  });

  test("G.2 the hold carries its episode pointer — the sale-to-claim bridge exists", async () => {
    // ⚠️ THIS IS WHAT MAKES OPTION A CHEAP. `markAllocationApplied` is handed a
    // hold; the hold names the exact claim. No search, no inference, no history.
    const seed = await seedDealer("g2");
    const car = await vehicle(seed);
    const other = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car, other]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: car, amount: 3_000 },
      { vehicleId: other, amount: 1_000 },
    ]);

    const holds = await holdsOn(seed, car);
    const live = holds.filter((h) => h.active);
    expect(live.length, "one live slice on this car").toBe(1);
    expect(
      live[0].sourceCommitmentClaimId,
      "the slice names the episode that acquired the car"
    ).toBeTruthy();

    const claims = await claimsOn(seed, car);
    expect(
      claims.map((c) => String(c._id)),
      "and it names one of THIS car's episodes, not any episode"
    ).toContain(String(live[0].sourceCommitmentClaimId));
  });

  test("G.3 completing a 2-car quote writes ONE sale per car, sequentially", async () => {
    const seed = await seedDealer("g3");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "one sale per car, not one sale per deal").toBe(2);

    const sales = await seed.t.run(async (ctx) => await ctx.db.query("sales").collect());
    expect(sales.length).toBe(2);
    expect(
      sales.map((s) => String(s.vehicleId)).sort(),
      "each sale is against its own car"
    ).toEqual([String(a), String(b)].sort());
  });

  test("G.4 a completed sale marks that car's slice APPLIED and names the sale", async () => {
    const seed = await seedDealer("g4");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);

    const saleIds = await completeQuote(seed, quoteId);

    const holdsA = await holdsOn(seed, a);
    const applied = holdsA.filter((h) => h.allocationStatus === "APPLIED");
    expect(applied.length, "car A's slice was consumed by its sale").toBe(1);
    expect(
      saleIds.map(String),
      "and it names one of the sales this completion produced"
    ).toContain(String(applied[0].appliedSaleId));
  });

  test("G.5 THE GAP: a completed sale leaves the root OPEN and the claim ACTIVE", async () => {
    // ⚠️ THE ONE PART-A CONTRACT THAT M3 WILL INVERT, AND IT IS HERE ON PURPOSE.
    // Part B is red, and a red test proves only absence. This proves the absence
    // is the ABSENCE OF FINALIZATION specifically — the sale really completed,
    // the money really applied, and the commitment model simply did not move.
    // Without this, a Part B failure could equally mean my fixture never sold
    // anything.
    //
    // WHEN M3 LANDS THIS CONTRACT MUST BE DELETED, not "fixed". F.1 is its
    // inversion and replaces it. It is named GAP so that is unmissable.
    const seed = await seedDealer("g5");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: the sale really did complete").toBe(1);

    const sale = await seed.t.run((ctx) => ctx.db.get(saleIds[0]));
    expect(sale?.status, "precondition: and it is COMPLETED").toBe("COMPLETED");

    const roots = await rootsOn(seed, car);
    expect(roots[0].status, "the deal that sold the car still holds it").toBe("OPEN");

    const claims = await claimsOn(seed, car);
    expect(claims[0].status, "and its episode never ended").toBe("ACTIVE");
    expect(
      claims[0].consumedBySaleId,
      "nothing recorded which sale consumed it, because nothing consumed it"
    ).toBeUndefined();
  });

  test("G.6 and nothing anywhere in the branch has ever written a terminal status", async () => {
    // The census form of G.5. A single completed deal could look untouched by
    // coincidence; this asserts the transition is absent from the SYSTEM, which
    // is what makes "Phase 1 shipped no finalization" a fact rather than a claim.
    const seed = await seedDealer("g6");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_000 },
      { vehicleId: b, amount: 2_000 },
    ]);
    await completeQuote(seed, quoteId);

    const { roots, claims } = await seed.t.run(async (ctx) => ({
      roots: await ctx.db.query("commitmentRoots").collect(),
      claims: await ctx.db.query("vehicleCommitmentClaims").collect(),
    }));

    expect(roots.length, "precondition: there are roots to have terminalized").toBeGreaterThan(0);
    expect(claims.length, "precondition: and episodes to have consumed").toBeGreaterThan(0);
    expect(
      roots.map((r) => r.status),
      "every root in the database is still OPEN"
    ).toEqual(roots.map(() => "OPEN"));
    expect(
      claims.map((c) => c.status),
      "every episode in the database is still ACTIVE"
    ).toEqual(claims.map(() => "ACTIVE"));
  });

  test("G.7 a cancelled multi-car sale leaves its slice awaiting a decision, not back in the pool", async () => {
    // The precondition F.6 rests on. Money does not silently return to the deal
    // when a sale is cancelled — somebody must decide — and M3 must not treat a
    // slice in that limbo as evidence the car is free.
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

    const saleA = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return rows.find((s) => String(s.vehicleId) === String(a))!;
    });
    expect(saleIds.map(String), "precondition").toContain(String(saleA._id));

    await cancelSale(seed, saleA._id);

    const holdsA = await holdsOn(seed, a);
    const limbo = holdsA.filter(
      (h) =>
        h.allocationStatus === "RELEASED_AWAITING_DECISION" || h.allocationStatus === "REVERSING"
    );
    expect(
      limbo.length,
      "the slice came off its sale and is waiting for an explicit decision"
    ).toBe(1);
    expect(limbo[0].appliedSaleId, "and no longer claims to be applied to it").toBeUndefined();
  });

  test("G.8 Phase 3's restoration path does not exist yet — the two Phase-3 reds stay red", async () => {
    // ⚠️ SENTINEL. The owner requires the two intentional Phase-3 failures to be
    // RETAINED. They encode reversal/re-acquisition semantics, and the field
    // that carries them is `restoredFromClaimId`. If anything in Phase 2 starts
    // writing it, Phase 2 has silently absorbed Phase 3 and those reds would go
    // green for the wrong reason — the exact accidental scope creep this
    // sentinel exists to catch.
    const seed = await seedDealer("g8");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    const saleIds = await completeQuote(seed, quoteId);
    await cancelSale(seed, saleIds[0]);

    const claims = await claimsOn(seed, car);
    expect(claims.length, "precondition: episodes exist").toBeGreaterThan(0);
    expect(
      claims.filter((c) => c.restoredFromClaimId !== undefined).length,
      "no episode claims a predecessor: reacquisition is Phase 3, not Phase 2"
    ).toBe(0);
  });

  test("G.9 THE AFFORDABILITY PROOF FOR OPTION A: history does not enter the live read", async () => {
    // ⚠️ THE OWNER ASKED FOR PROOF THAT A CAN BE DONE WITHOUT RECONSTRUCTING
    // HISTORY. This is it, and it is a fact about the schema that holds TODAY —
    // which is why it is evidence rather than a promise.
    //
    // `by_root_status` is keyed (rootId, status). Terminal episodes are excluded
    // by the INDEX KEY, not filtered out after being read. So the read that M3
    // needs — "which episodes on this root are still live?" — costs the same on
    // a root with sixty episodes behind it as on a fresh one.
    //
    // If this were false, option A would require scanning a root's whole history
    // on every sale and B would be the honest choice. It is not false.
    const seed = await seedDealer("g9");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const root = (await rootsOn(seed, car))[0];

    const liveBefore = await seed.t.run(async (ctx) =>
      await ctx.db
        .query("vehicleCommitmentClaims")
        .withIndex("by_root_status", (q) => q.eq("rootId", root._id).eq("status", "ACTIVE"))
        .collect()
    );
    expect(liveBefore.length, "one live episode on a fresh deal").toBe(1);

    // Sixty episodes of ordinary terminal history on the SAME root.
    await seed.t.run(async (ctx) => {
      for (let n = 0; n < 60; n += 1) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: seed.orgId,
          rootId: root._id,
          vehicleId: car,
          evidenceKind: "DEPOSIT" as const,
          status: n % 2 === 0 ? ("CONSUMED" as const) : ("RELEASED" as const),
          createdAt: Date.now(),
          createdBy: seed.userId,
        });
      }
    });

    const allOnRoot = await seed.t.run(async (ctx) =>
      await ctx.db
        .query("vehicleCommitmentClaims")
        .withIndex("by_root_status", (q) => q.eq("rootId", root._id))
        .collect()
    );
    expect(allOnRoot.length, "precondition: the history is really there").toBe(61);

    const liveAfter = await seed.t.run(async (ctx) =>
      await ctx.db
        .query("vehicleCommitmentClaims")
        .withIndex("by_root_status", (q) => q.eq("rootId", root._id).eq("status", "ACTIVE"))
        .collect()
    );
    expect(
      liveAfter.length,
      "the live read returns ONE, not sixty-one: terminal rows never enter it"
    ).toBe(1);
    expect(String(liveAfter[0]._id), "and it is the same live episode as before").toBe(
      String(liveBefore[0]._id)
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART B — THE M3 SPECIFICATION
//
// RED until M3 ships, and the redness is the deliverable. Part A is what earns
// the right to read a failure here as "finalization is missing" rather than
// "the fixture never sold anything".
//
// ⚠️ EVERY CONTRACT ASSERTS OBSERVABLE STATE AFTER A REAL DOOR RUNS. None
// imports a finalization function, deliberately: importing something unwritten
// would be a compile error that turns the WHOLE FILE red, Part A included, and
// destroy the one signal this split exists to give. It also keeps the spec a
// statement about behaviour rather than about a function signature I invented —
// M3 may be built any shape that satisfies these.
// ══════════════════════════════════════════════════════════════════════════════

describe("P2-F the finalization barrier (M3)", () => {
  test("F.1 a completed sale CONSUMES the deal that held the car, naming the exact sale", async () => {
    // The inversion of G.5. When this passes, G.5 must be deleted.
    const seed = await seedDealer("f1");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: one car, one sale").toBe(1);

    const root = (await rootsOn(seed, car))[0];
    expect(root.status, "the deal became a sale — CONSUMED, not RELEASED").toBe("CONSUMED");
    expect(root.closedAt, "and it records when").toBeTruthy();

    const claims = await claimsOn(seed, car);
    expect(claims.length, "still one episode — finalization ENDS episodes, never adds").toBe(1);
    expect(claims[0].status, "the episode was consumed").toBe("CONSUMED");
    expect(
      String(claims[0].consumedBySaleId),
      "by THIS sale, exactly — the provenance Phase 3 reversal will read back"
    ).toBe(String(saleIds[0]));
  });

  test("F.2 a genuinely FREE walk-in car sells without inventing a deal to consume", async () => {
    // The control for F.1. If finalization only ever "closes whatever root it
    // finds", a car nobody ever committed to would expose it — either by
    // throwing, or by conjuring a root so the closing code has something to act
    // on. A cash walk-in is an ordinary sale and must stay one.
    const seed = await seedDealer("f2");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);

    const rootsBefore = await rootsOn(seed, car);
    expect(rootsBefore.length, "precondition: nobody has committed to this car").toBe(0);

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "the walk-in sale completes").toBe(1);

    const sale = await seed.t.run((ctx) => ctx.db.get(saleIds[0]));
    expect(sale?.status, "and it is COMPLETED").toBe("COMPLETED");

    expect(
      (await rootsOn(seed, car)).length,
      "and no commitment root was invented to give finalization something to close"
    ).toBe(0);
    expect((await claimsOn(seed, car)).length, "nor any episode").toBe(0);
  });

  test("F.3 a sale for a deal that does NOT hold the car is REFUSED, with zero residue", async () => {
    // ⚠️ THE BARRIER'S REASON FOR EXISTING. Customer B's deposit holds the car.
    // Customer A must not be able to sell it out from under them — and a refusal
    // that leaves a half-written sale behind is not a refusal.
    const seed = await seedDealer("f3");
    const car = await vehicle(seed);

    const bQuote = await quoteFor(seed, seed.customerB, [car]);
    await depositOn(seed, bQuote, 2_000);
    const rivalRoot = (await rootsOn(seed, car))[0];
    expect(rivalRoot.customerId, "precondition: B's deal holds the car").toBe(seed.customerB);

    const aQuote = await quoteFor(seed, seed.customerA, [car]);

    let threw: unknown = null;
    try {
      await completeQuote(seed, aQuote);
    } catch (e) {
      threw = e;
    }
    expect(threw, "A may not complete a sale on a car B's deal holds").toBeTruthy();

    const sales = await seed.t.run(async (ctx) => await ctx.db.query("sales").collect());
    expect(sales.length, "and no sale row survives the refusal").toBe(0);

    const rootsAfter = await rootsOn(seed, car);
    expect(rootsAfter.length, "B's deal is still the only one").toBe(1);
    expect(rootsAfter[0].status, "and it was not touched").toBe("OPEN");
    expect(String(rootsAfter[0]._id), "the same root, not a replacement").toBe(
      String(rivalRoot._id)
    );
  });

  test("F.4 a 2-car shared-deposit deal consumes BOTH deals, each by its own sale", async () => {
    // One deposit, two cars, two roots, two sales. The failure this guards is a
    // barrier that terminalizes "the deal" as if a multi-car quote were one
    // commitment — it is not; the car is the unit of ownership.
    const seed = await seedDealer("f4");
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

    // A plain record, not a Map: `t.run` serializes its return value and a Map
    // does not survive the crossing.
    const salesByVehicle: Record<string, string> = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return Object.fromEntries(rows.map((s) => [String(s.vehicleId), String(s._id)]));
    });

    for (const car of [a, b]) {
      const root = (await rootsOn(seed, car))[0];
      expect(root.status, `car ${String(car)}: its deal was consumed`).toBe("CONSUMED");

      const claims = await claimsOn(seed, car);
      expect(claims.length, "one episode per car").toBe(1);
      expect(claims[0].status, "consumed").toBe("CONSUMED");
      expect(
        String(claims[0].consumedBySaleId),
        "and by THAT CAR'S sale — not whichever sale happened to run last"
      ).toBe(salesByVehicle[String(car)]);
    }
  });

  test("F.5 a 3-car shared-deposit deal terminalizes all three, none by another's sale", async () => {
    const seed = await seedDealer("f5");
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

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: three cars, three sales").toBe(3);

    // A plain record, not a Map: `t.run` serializes its return value and a Map
    // does not survive the crossing.
    const salesByVehicle: Record<string, string> = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return Object.fromEntries(rows.map((s) => [String(s.vehicleId), String(s._id)]));
    });

    const stamped = new Set<string>();
    for (const car of [a, b, c]) {
      const root = (await rootsOn(seed, car))[0];
      expect(root.status, `car ${String(car)} consumed`).toBe("CONSUMED");
      const claim = (await claimsOn(seed, car))[0];
      expect(String(claim.consumedBySaleId), "stamped with its own car's sale").toBe(
        salesByVehicle[String(car)]
      );
      stamped.add(String(claim.consumedBySaleId));
    }
    expect(
      stamped.size,
      "three DISTINCT sales — one shared stamp would mean the loop leaked state between cars"
    ).toBe(3);
  });

  test("F.6 the outcome does not depend on the order the cars are completed in", async () => {
    // `completeSalesForLineItems` walks `quote.vehicleItems` in order while the
    // deposit state is shared across the whole deal. Order dependence there is a
    // real hazard, and it is invisible in a one-car test.
    async function runWithOrder(suffix: string, reverse: boolean) {
      const seed = await seedDealer(suffix);
      const a = await vehicle(seed);
      const b = await vehicle(seed);
      const order = reverse ? [b, a] : [a, b];
      const quoteId = await quoteFor(seed, seed.customerA, order);
      await depositOn(seed, quoteId, 4_000);
      await allocate(seed, quoteId, [
        { vehicleId: a, amount: 2_500 },
        { vehicleId: b, amount: 1_500 },
      ]);
      await completeQuote(seed, quoteId);

      const summarise = async (car: Id<"vehicles">) => {
        const root = (await rootsOn(seed, car))[0];
        const claim = (await claimsOn(seed, car))[0];
        return {
          rootStatus: root?.status ?? null,
          claimStatus: claim?.status ?? null,
          stamped: claim?.consumedBySaleId !== undefined,
        };
      };
      return { a: await summarise(a), b: await summarise(b) };
    }

    const forward = await runWithOrder("f6f", false);
    const backward = await runWithOrder("f6b", true);

    expect(forward.a, "car A ends the same way whichever car was completed first").toEqual(
      backward.a
    );
    expect(forward.b, "and so does car B").toEqual(backward.b);
    expect(forward.a.rootStatus, "both consumed, not merely equal-and-wrong").toBe("CONSUMED");
    expect(forward.b.rootStatus).toBe("CONSUMED");
  });

  test("F.7 SCRUM-199: a deal that ends WITHOUT a sale RELEASES the car", async () => {
    // ⚠️ THE CASE THAT STARTED THIS PROGRAM: the money leaves and NOTHING holds
    // the car. If the root stays OPEN, the car is held by a deal that no longer
    // exists and nobody can ever acquire it again.
    //
    // ⚠️ THE TREATMENT HERE IS FORFEITED, AND THE FIRST DRAFT OF THIS CONTRACT
    // HAD IT WRONG. It used RETURN_TO_UNALLOCATED, which reads like "the deal
    // ended" but is the one case where it did not: that branch calls
    // `acquireVehicle` and RE-ACQUIRES the same car, so the deal still holds it
    // afterwards (F.10 is where that belongs). REFUND_TO_CUSTOMER and FORFEITED
    // call `payOutDepositSlice` and re-acquire nothing — the money is gone and
    // the car is genuinely free. Specifying the release against a treatment that
    // does not release is exactly the confident-but-wrong specification this
    // file's structure exists to catch.
    const seed = await seedDealer("f7");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    const saleIds = await completeQuote(seed, quoteId);

    const saleA = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return rows.find((s) => String(s.vehicleId) === String(a))!;
    });
    expect(saleIds.map(String), "precondition").toContain(String(saleA._id));
    await cancelSale(seed, saleA._id);

    const limbo = (await holdsOn(seed, a)).find(
      (h) =>
        h.allocationStatus === "RELEASED_AWAITING_DECISION" || h.allocationStatus === "REVERSING"
    )!;
    expect(limbo, "precondition: the slice is awaiting a decision").toBeTruthy();

    // ⚠️ AS THE MANAGER, NOT THE SELLER. Forfeiture and refund move real money,
    // so `payOutDepositSlice` refuses the deposit's own creator — "Deposit
    // creator cannot resolve their own deposit refund or forfeiture." The first
    // draft resolved as the seller and died there, in SETUP, which would have
    // read as "M3 is missing" rather than "the fixture is wrong". OTHER does not
    // move money and so is not subject to this guard, which is why F.9 needs no
    // second actor.
    await seed.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: limbo._id,
      treatment: "FORFEITED" as const,
      reason: "customer walked away; deposit forfeited per the signed terms",
    });

    const claims = await claimsOn(seed, a);
    const original = claims.find((c) => String(c._id) === String(limbo.sourceCommitmentClaimId));
    expect(original, "precondition: the released slice named its episode").toBeTruthy();
    expect(
      original!.status,
      "the episode that held the car ended without a sale — RELEASED, never CONSUMED"
    ).toBe("RELEASED");
    expect(
      original!.consumedBySaleId,
      "and no sale is recorded against it, because none happened"
    ).toBeUndefined();

    // The point of SCRUM-199: the CAR must be free, not merely the episode over.
    expect(
      claims.filter((c) => c.status === "ACTIVE").length,
      "nothing re-acquired the car — a forfeit re-acquires nothing"
    ).toBe(0);
    expect(
      (await rootsOn(seed, a))[0].status,
      "so the deal itself is RELEASED and the car can be acquired again"
    ).toBe("RELEASED");
  });

  test("F.8 a slice still REVERSING or AWAITING a decision does NOT close the deal", async () => {
    // ⚠️ PREMATURE CLOSURE IS THE DANGEROUS DIRECTION. A cancelled sale whose
    // journal has not been reversed leaves money the ledger still shows credited
    // against a live invoice. Treating that as "the deal is over" would release
    // the car while its money is unresolved — and the car could then be sold to
    // somebody else while the first customer's cash is still on it.
    const seed = await seedDealer("f8");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    const saleIds = await completeQuote(seed, quoteId);

    const saleA = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return rows.find((s) => String(s.vehicleId) === String(a))!;
    });
    expect(saleIds.map(String), "precondition").toContain(String(saleA._id));
    await cancelSale(seed, saleA._id);

    const limbo = (await holdsOn(seed, a)).find(
      (h) =>
        h.allocationStatus === "RELEASED_AWAITING_DECISION" || h.allocationStatus === "REVERSING"
    );
    expect(limbo, "precondition: the slice is in limbo, undecided").toBeTruthy();

    // ⚠️ THIS CONTRACT IS DELIBERATELY DIFFERENTIAL, AND THE FIRST DRAFT WAS NOT.
    // Asserting only "car A's root is still OPEN" passes TODAY for free, because
    // nothing terminalizes anything — it would go green against an M3 that does
    // nothing at all, and stay green against one that closes deals at random as
    // long as it missed this one. So car B, whose sale still stands, is asserted
    // in the SAME test: the barrier must close B and leave A alone. That is a
    // discrimination, and only a working M3 can satisfy it.
    const rootB = (await rootsOn(seed, b))[0];
    expect(
      rootB.status,
      "car B's sale stands, so B's deal IS consumed — the barrier is doing something"
    ).toBe("CONSUMED");

    const rootA = (await rootsOn(seed, a))[0];
    expect(
      rootA.status,
      "but car A's deal is NOT closed while its money is still awaiting a decision"
    ).toBe("OPEN");

    const claim = (await claimsOn(seed, a)).find(
      (c) => String(c._id) === String(limbo!.sourceCommitmentClaimId)
    )!;
    expect(claim.status, "and A's episode is neither consumed nor released yet").toBe("ACTIVE");
    expect(
      claim.consumedBySaleId,
      "the cancelled sale must not be left stamped on it"
    ).toBeUndefined();
  });

  test("F.9 a terminal OTHER resolution CLOSES the deal — it does not linger as pending", async () => {
    // The mirror of F.8. OTHER is a real, terminal decision. A barrier that only
    // recognises REFUND and FORFEIT would leave these deals pending forever, and
    // their cars permanently unsellable — the same dead-end as SCRUM-199,
    // reached through the door meant to resolve it.
    const seed = await seedDealer("f9");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    const saleIds = await completeQuote(seed, quoteId);

    const saleA = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return rows.find((s) => String(s.vehicleId) === String(a))!;
    });
    expect(saleIds.map(String), "precondition").toContain(String(saleA._id));
    await cancelSale(seed, saleA._id);

    const limbo = (await holdsOn(seed, a)).find(
      (h) =>
        h.allocationStatus === "RELEASED_AWAITING_DECISION" || h.allocationStatus === "REVERSING"
    )!;
    expect(limbo, "precondition").toBeTruthy();

    await seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: limbo._id,
      treatment: "OTHER" as const,
      reason: "written off against a goodwill credit note",
    });

    const claim = (await claimsOn(seed, a)).find(
      (c) => String(c._id) === String(limbo.sourceCommitmentClaimId)
    )!;
    expect(
      claim.status,
      "OTHER is a decision, so the episode is over — not left ACTIVE forever"
    ).toBe("RELEASED");
    expect(claim.consumedBySaleId, "and it never became a sale").toBeUndefined();
  });

  test("F.10 REALLOCATE and RETURN_TO_UNALLOCATED keep the FRESH acquisition they made", async () => {
    // ⚠️ THE INTERACTION WITH PHASE 1 THAT IS EASIEST TO BREAK. Both treatments
    // INSERT a new hold and, through `acquireVehicle`, a NEW episode. A barrier
    // that terminalizes "this deal's episodes" without distinguishing the ended
    // one from the one just created would close the acquisition it is standing
    // on, and the money would be on a car nothing holds.
    const seed = await seedDealer("f10");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [a, b]);
    await depositOn(seed, quoteId, 4_000);
    await allocate(seed, quoteId, [
      { vehicleId: a, amount: 2_500 },
      { vehicleId: b, amount: 1_500 },
    ]);
    const saleIds = await completeQuote(seed, quoteId);

    const saleA = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("sales").collect();
      return rows.find((s) => String(s.vehicleId) === String(a))!;
    });
    expect(saleIds.map(String), "precondition").toContain(String(saleA._id));
    await cancelSale(seed, saleA._id);

    const limbo = (await holdsOn(seed, a)).find(
      (h) =>
        h.allocationStatus === "RELEASED_AWAITING_DECISION" || h.allocationStatus === "REVERSING"
    )!;
    expect(limbo, "precondition").toBeTruthy();
    const endedClaimId = String(limbo.sourceCommitmentClaimId);

    await seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: limbo._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
      reason: "back on the deal",
    });

    const claims = await claimsOn(seed, a);
    const ended = claims.find((c) => String(c._id) === endedClaimId)!;
    const fresh = claims.filter((c) => String(c._id) !== endedClaimId);

    expect(ended.status, "the episode that ended is terminal").toBe("RELEASED");
    expect(fresh.length, "and the resolution made a NEW one").toBe(1);
    expect(
      fresh[0].status,
      "which is LIVE — the money is back on the deal and something holds the car"
    ).toBe("ACTIVE");
    expect(
      fresh[0].consumedBySaleId,
      "a fresh acquisition was never consumed by the cancelled sale"
    ).toBeUndefined();
  });

  test("F.11 a rival's new deal on the same car is isolated from the finalized one", async () => {
    // After A's deal is consumed by a sale, the car's history holds a terminal
    // root. If B later acquires the same physical car, the barrier must not
    // reach back into A's finished deal, and A's terminal rows must not make B's
    // acquisition look already-closed.
    const seed = await seedDealer("f11");
    const car = await vehicle(seed);

    const aQuote = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, aQuote, 2_000);
    const aRootId = String((await rootsOn(seed, car))[0]._id);
    const saleIds = await completeQuote(seed, aQuote);
    expect(saleIds.length, "precondition: A's deal completed").toBe(1);

    const aRootAfter = (await rootsOn(seed, car)).find((r) => String(r._id) === aRootId)!;
    expect(aRootAfter.status, "A's deal is finished").toBe("CONSUMED");

    // B now acquires the same physical car — a trade-back, a returned unit.
    const bQuote = await quoteFor(seed, seed.customerB, [car]);
    await depositOn(seed, bQuote, 1_000);

    const roots = await rootsOn(seed, car);
    const bRoots = roots.filter((r) => String(r._id) !== aRootId);
    expect(bRoots.length, "B's acquisition opened its OWN root").toBe(1);
    expect(bRoots[0].status, "which is live").toBe("OPEN");
    expect(bRoots[0].customerId, "and belongs to B").toBe(seed.customerB);

    expect(
      String(roots.find((r) => String(r._id) === aRootId)!.status),
      "A's finished deal was not reopened or rewritten by B's acquisition"
    ).toBe("CONSUMED");
  });

  test("F.12 terminalization is monotonic and idempotent — and never partial", async () => {
    // ⚠️ THE NO-HYBRID CONTRACT. The owner forbade an accidental half-state, so
    // this asserts BOTH directions of the pairing rather than only the one the
    // implementation happens to do first:
    //   - no root is CONSUMED while an episode on it is still ACTIVE;
    //   - no episode is CONSUMED while its root is still OPEN.
    // Plus: repeating the completion must not move anything, and CONSUMED must
    // never decay to RELEASED.
    const seed = await seedDealer("f12");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);
    const saleIds = await completeQuote(seed, quoteId);

    const census = async () => {
      const roots = await rootsOn(seed, car);
      const claims = await claimsOn(seed, car);
      return {
        roots: roots
          .map((r) => `${String(r._id)}:${r.status}`)
          .sort(),
        claims: claims
          .map((c) => `${String(c._id)}:${c.status}:${String(c.consumedBySaleId ?? "-")}`)
          .sort(),
      };
    };

    const after = await census();
    const root = (await rootsOn(seed, car))[0];
    const claims = await claimsOn(seed, car);

    // No hybrid, in both directions.
    const liveClaims = claims.filter((c) => c.status === "ACTIVE");
    if (root.status === "CONSUMED") {
      expect(
        liveClaims.length,
        "a CONSUMED root may not have a live episode hanging off it"
      ).toBe(0);
    }
    for (const c of claims.filter((x) => x.status === "CONSUMED")) {
      expect(
        root.status,
        `episode ${String(c._id)} is CONSUMED, so its root must be terminal too`
      ).toBe("CONSUMED");
    }

    // Idempotent: completing the same quote again changes nothing. The door is
    // idempotency-keyed, so a repeat is a real production event, not a contrivance.
    await completeQuote(seed, quoteId).catch(() => undefined);
    expect(await census(), "a repeated completion moves nothing").toEqual(after);

    // Monotonic: CONSUMED outranks RELEASED and never decays into it.
    expect(
      (await rootsOn(seed, car))[0].status,
      "CONSUMED is terminal and outranks RELEASED"
    ).toBe("CONSUMED");
    expect(saleIds.length, "precondition held throughout").toBe(1);
  });

  test("F.13 finalization does not rewrite history, and Phase 3 can find what a sale consumed in ONE read", async () => {
    // ⚠️ THE OPTION-A CONTRACT ITSELF, and the reason the decision is A.
    //
    // Two claims, and they are the whole argument:
    //   1. sixty terminal episodes on the root are left byte-for-byte alone —
    //      the barrier touches the LIVE set only (G.9 is why that is cheap);
    //   2. `by_consumed_sale` answers "what did this sale consume?" in one
    //      bounded index read. Under option B this index stays empty forever and
    //      Phase 3 reversal has to reconstruct the answer from history — the
    //      exact unbounded search the provenance pointer abolished, coming back
    //      through the reversal door.
    const seed = await seedDealer("f13");
    const car = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [car]);
    await depositOn(seed, quoteId, 2_000);

    const root = (await rootsOn(seed, car))[0];
    const liveClaimId = String((await claimsOn(seed, car))[0]._id);

    // Sixty episodes of terminal history, recorded before the sale.
    const historyIds = await seed.t.run(async (ctx) => {
      const ids: string[] = [];
      for (let n = 0; n < 60; n += 1) {
        ids.push(
          String(
            await ctx.db.insert("vehicleCommitmentClaims", {
              orgId: seed.orgId,
              rootId: root._id,
              vehicleId: car,
              evidenceKind: "DEPOSIT" as const,
              status: n % 2 === 0 ? ("CONSUMED" as const) : ("RELEASED" as const),
              createdAt: Date.now(),
              createdBy: seed.userId,
            })
          )
        );
      }
      return ids;
    });

    const historyBefore = await seed.t.run(async (ctx) =>
      Promise.all(historyIds.map(async (id) => JSON.stringify(await ctx.db.get(id as Id<"vehicleCommitmentClaims">))))
    );

    const saleIds = await completeQuote(seed, quoteId);
    expect(saleIds.length, "precondition: the sale completed").toBe(1);

    const historyAfter = await seed.t.run(async (ctx) =>
      Promise.all(historyIds.map(async (id) => JSON.stringify(await ctx.db.get(id as Id<"vehicleCommitmentClaims">))))
    );
    expect(
      historyAfter,
      "sixty terminal episodes are left exactly as they were — finalization touches the live set only"
    ).toEqual(historyBefore);

    // Phase 3's question, answered in one bounded index read.
    const consumed = await seed.t.run(async (ctx) =>
      await ctx.db
        .query("vehicleCommitmentClaims")
        .withIndex("by_consumed_sale", (q) => q.eq("consumedBySaleId", saleIds[0]))
        .collect()
    );
    expect(
      consumed.length,
      "exactly the episode this sale consumed — not sixty-one rows to sift"
    ).toBe(1);
    expect(String(consumed[0]._id), "and it is the LIVE episode, not one of the historical ones").toBe(
      liveClaimId
    );
  });
});
