/**
 * SCRUM-195 PHASE 1 — M1 (one root decision) and M2 (tagged evidence).
 *
 * ⚠️ BOUNDED BY DESIGN, per owner ruling c15586. The previous attempt answered
 * a failing review with more fixtures until the specification reached 6,717
 * lines against 1,540 lines of authority, and the breaker fired twice. The
 * design authority is now the invariant table and writer map in Jira c15584 —
 * not this file. Every contract below names the invariant it derives from, and
 * this suite covers PHASE 1 ONLY.
 *
 * Out of scope here, deliberately: the touched-root finalization barrier
 * (Phase 2) and reversal/lifecycle restoration (Phase 3). Contracts for those
 * ship with those phases.
 *
 * Everything goes through REAL product doors with REAL authenticated
 * identities. Where a contract is about a helper's own guard rather than a
 * user-visible behaviour, it calls that helper directly and says so.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { attachEpisode, resolveActingRoot, resolveOwnership } from "./commitments";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
];

const PRICE = 30_000;

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

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+96279000${suffix.length}1`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+96279000${suffix.length}2`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, asUser, customerA, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

let vinCounter = 0;
async function vehicle(seed: Seed) {
  vinCounter += 1;
  const vin = `1HGCM82633A${String(100000 + vinCounter).slice(0, 6)}`;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Red",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 100,
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

async function cashQuote(seed: Seed, customerId: Id<"customers">, vehicleId: Id<"vehicles">) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId,
    mode: "CASH" as const,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 0,
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

/** A refusal must be the AUTHORITY's, and must name a reason a person can act on. */
async function expectRefusal(call: Promise<unknown>, pattern: RegExp, label: string) {
  let threw: unknown = null;
  try {
    await call;
  } catch (e) {
    threw = e;
  }
  expect(threw, `${label}: the operation must be REFUSED`).not.toBeNull();
  const message = String(
    (threw as { data?: unknown })?.data ?? (threw as Error)?.message ?? threw
  );
  expect(message, `${label}: refused for the stated reason, not incidentally`).toMatch(pattern);
}

const HELD = /already committed to another deal/i;

// ═════════════════════════════════════════════════════════════════════════════
// M1 — ONE ROOT DECISION, AND IT IS EXPLICIT
//
// The defect this replaces: "which root does this belong to?" was answered
// independently by six writers, three of which could arrive with no lineage and
// silently read that as "open a new root". `resolveActingRoot` is now the only
// answer, and OPEN_NEW is a decision it makes rather than a fallback a caller
// invents.
// ═════════════════════════════════════════════════════════════════════════════

describe("P1-M1 the acting root is decided in exactly one place", () => {
  test("1.1 a FREE car acquires exactly ONE root and ONE episode (I1)", async () => {
    const seed = await seedDealer("m1a");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    const roots = await rootsOn(seed, v);
    expect(roots.length, "one physical car, one root").toBe(1);
    expect(roots[0].status, "and the deal is live").toBe("OPEN");
    expect(roots[0].customerId, "held by the customer whose money it is").toEqual(seed.customerA);
    const claims = await claimsOn(seed, v);
    expect(claims.length, "one acquisition, one episode").toBe(1);
    expect(claims[0].status).toBe("ACTIVE");
    expect(String(claims[0].rootId), "the episode is on that root").toBe(String(roots[0]._id));
  });

  test("1.2 the SAME customer opening a SECOND independent deal is REFUSED (I2)", async () => {
    // c14865: same customer never implies same deal. This is the founding rule
    // — an authority keyed on (customerId, vehicleId) would accept this, and
    // accepting it is how one car gets promised twice.
    const seed = await seedDealer("m1b");
    const v = await vehicle(seed);
    const first = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: first,
      amount: 2_000,
    });

    const second = await cashQuote(seed, seed.customerA, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: second,
        amount: 1_000,
      }),
      HELD,
      "1.2"
    );
    expect((await rootsOn(seed, v)).length, "and NO second root was opened").toBe(1);
  });

  test("1.3 a DIFFERENT customer is refused, and nothing moves", async () => {
    const seed = await seedDealer("m1c");
    const v = await vehicle(seed);
    const first = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: first,
      amount: 2_000,
    });
    const claimsBefore = (await claimsOn(seed, v)).length;

    const rival = await cashQuote(seed, seed.customerB, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rival, amount: 500 }),
      HELD,
      "1.3"
    );
    expect((await rootsOn(seed, v)).length, "still one root").toBe(1);
    expect((await claimsOn(seed, v)).length, "and no episode was opened").toBe(claimsBefore);
    expect((await rootsOn(seed, v))[0].customerId, "the first deal still holds it").toEqual(
      seed.customerA
    );
  });

  test("1.4 the SAME deal taking a further instalment JOINS its root (I3)", async () => {
    // The matched positive for 1.2. Lineage PROOF — the quote names the root —
    // is what separates a continuation from a second deal. Without this
    // contract the safest way to satisfy 1.2 is to refuse everything.
    const seed = await seedDealer("m1d");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 1_000 });

    expect((await rootsOn(seed, v)).length, "one deal, one root, two instalments").toBe(1);
    const claims = await claimsOn(seed, v);
    expect(claims.length, "each acquisition is its own episode").toBe(2);
    expect(
      new Set(claims.map((c) => String(c.rootId))).size,
      "both episodes on the SAME root"
    ).toBe(1);
    expect(
      claims.every((c) => c.status === "ACTIVE"),
      "and both are live"
    ).toBe(true);
  });

  test("1.5 REFUSE is a decision — a held car never falls through to a new root", async () => {
    // ⚠️ THE CLASS THIS PHASE EXISTS TO KILL, asserted on the decision itself.
    //
    // The previous design returned a nullable root id, and every caller read
    // `null` as "then open a new one". A lineage-less operation on a held car
    // therefore minted a SECOND root on one physical vehicle — silently, with
    // no exception for anyone to see. `resolveActingRoot` has no such value:
    // JOIN, OPEN_NEW and REFUSE are the only answers, and OPEN_NEW is reachable
    // only from FREE.
    const seed = await seedDealer("m1e");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    const decision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { quoteId: null, reservationId: null },
      })
    );
    expect(
      decision.decision,
      "no lineage against a held car is a REFUSAL, never a new root"
    ).toBe("REFUSE");

    const free = await vehicle(seed);
    const onFree = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: free,
        lineage: { quoteId: null, reservationId: null },
      })
    );
    expect(onFree.decision, "OPEN_NEW is reachable only when the car is genuinely FREE").toBe(
      "OPEN_NEW"
    );
  });

  test("1.6 two OPEN roots REFUSE rather than pick a winner", async () => {
    // ⚠️ FIXTURE BOUNDARY, STATED. Corrupt state cannot be produced through a
    // public door — that is the point of this phase — so the second root is
    // written directly. This is therefore a contract on the READ side: given
    // corruption, the authority must refuse to act rather than hand the car to
    // whichever root happens to sort first.
    const seed = await seedDealer("m1f");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    await seed.t.run((ctx) =>
      ctx.db.insert("commitmentRoots", {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerB,
        status: "OPEN" as const,
        openedAt: Date.now(),
        openedBy: seed.userId,
      })
    );

    const ownership = await seed.t.run((ctx) => resolveOwnership(ctx, seed.orgId, v));
    expect(ownership.kind, "the authority reports corruption as corruption").toBe("AMBIGUOUS");
    const decision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, { orgId: seed.orgId, vehicleId: v, lineage: { quoteId } })
    );
    expect(decision.decision, "and refuses to act on it").toBe("REFUSE");
  });

  test("1.7 another organization's root does not hold THIS org's car", async () => {
    const seed = await seedDealer("m1g");
    const v = await vehicle(seed);
    const foreignOrg = await seed.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const foreignCustomer = await seed.t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId: foreignOrg,
        firstName: "Foreign",
        lastName: "Customer",
        phone: "+962790009999",
        createdAt: Date.now(),
      })
    );
    await seed.t.run((ctx) =>
      ctx.db.insert("commitmentRoots", {
        orgId: foreignOrg,
        vehicleId: v,
        customerId: foreignCustomer,
        status: "OPEN" as const,
        openedAt: Date.now(),
        openedBy: seed.userId,
      })
    );

    expect(
      (await seed.t.run((ctx) => resolveOwnership(ctx, seed.orgId, v))).kind,
      "a foreign root is not this tenant's ownership"
    ).toBe("FREE");
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const mine = (await rootsOn(seed, v)).filter((r) => String(r.orgId) === String(seed.orgId));
    expect(mine.length, "and this tenant opens its own root normally").toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M2 — EVIDENCE IS TAGGED, CARRIED, AND NEVER RE-DERIVED
//
// The defect this replaces: three writers hardcoded `kind: "DEPOSIT"`, so a
// reservation's own deposit came back as a DEPOSIT-kind claim on RESERVATION
// evidence — on a second root, silently, with the reservation reference simply
// absent. Reading evidence as `depositId ?? applicationId ?? reservationId`
// then reported the deposit as that episode's evidence and the drift was
// invisible.
// ═════════════════════════════════════════════════════════════════════════════

describe("P1-M2 evidence is tagged and carried", () => {
  test("2.1 a RESERVATION acquisition is tagged RESERVATION, not DEPOSIT", async () => {
    const seed = await seedDealer("m2a");
    const v = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      depositAmount: 2_000,
    });

    const claims = await claimsOn(seed, v);
    expect(claims.length, "the reservation opened one episode").toBe(1);
    const claim = claims[0];
    expect(claim.evidenceKind, "tagged by what the evidence IS").toBe("RESERVATION");
    expect(String(claim.reservationId), "and it names the reservation").toBe(String(reservationId));
    // ⚠️ The deposit taken with a reservation is CONTEXT. A row carrying two
    // references is exactly why the tag exists rather than "whichever id
    // happens to be set".
    const roots = await rootsOn(seed, v);
    expect(roots.length, "one root").toBe(1);
    expect(String(roots[0].originReservationId), "the root records how the deal began").toBe(
      String(reservationId)
    );
  });

  test("2.2 a DEPOSIT acquisition is tagged DEPOSIT and names its deposit", async () => {
    const seed = await seedDealer("m2b");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    const claims = await claimsOn(seed, v);
    expect(claims.length).toBe(1);
    expect(claims[0].evidenceKind).toBe("DEPOSIT");
    expect(claims[0].depositId, "and names the deposit it rests on").toBeTruthy();
    expect(claims[0].reservationId, "with no unrelated reference set").toBeUndefined();
    expect(claims[0].applicationId).toBeUndefined();
  });

  test("2.3 a successor may not change the evidence KIND (I7)", async () => {
    // ⚠️ THE SCRUM-200(b) CLASS, as a helper guard. A restoration that assumed
    // DEPOSIT turned a consumed RESERVATION episode into a live DEPOSIT one.
    // `attachEpisode` compares the successor's tag against its predecessor's
    // rather than trusting the caller.
    const seed = await seedDealer("m2c");
    const v = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      depositAmount: 2_000,
    });
    const original = (await claimsOn(seed, v))[0];
    // Make it terminal, the way a sale or release would.
    await seed.t.run((ctx) =>
      ctx.db.patch(original._id, { status: "RELEASED" as const, resolvedAt: Date.now() })
    );
    const terminal = await seed.t.run((ctx) => ctx.db.get(original._id));
    const depositId = await seed.t.run(async (ctx) => (await ctx.db.query("deposits").collect())[0]?._id);

    await expect(
      seed.t.run((ctx) =>
        attachEpisode(ctx, {
          orgId: seed.orgId,
          rootId: original.rootId,
          vehicleId: v,
          evidence: { kind: "DEPOSIT", depositId: depositId as Id<"deposits"> },
          createdBy: seed.userId,
          predecessor: terminal!,
        })
      )
    ).rejects.toThrow(/kind/i);

    // And the legitimate successor — SAME kind, SAME evidence — is accepted.
    await seed.t.run((ctx) =>
      attachEpisode(ctx, {
        orgId: seed.orgId,
        rootId: original.rootId,
        vehicleId: v,
        evidence: { kind: "RESERVATION", reservationId },
        createdBy: seed.userId,
        predecessor: terminal!,
      })
    );
    const after = await claimsOn(seed, v);
    const successor = after.find((c) => String(c._id) !== String(original._id))!;
    expect(successor.evidenceKind, "the successor carries the predecessor's tag").toBe(
      "RESERVATION"
    );
    expect(String(successor.restoredFromClaimId), "and names the episode it succeeds").toBe(
      String(original._id)
    );
    expect(String(successor.rootId), "on the same root").toBe(String(original.rootId));
  });

  test("2.4 a successor may not move root, and may not succeed a LIVE episode (I6)", async () => {
    const seed = await seedDealer("m2d");
    const v = await vehicle(seed);
    const other = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const live = (await claimsOn(seed, v))[0];
    const depositId = live.depositId as Id<"deposits">;

    // A live episode is resolved, never succeeded — succeeding it would leave
    // the same evidence holding the car twice.
    await expect(
      seed.t.run((ctx) =>
        attachEpisode(ctx, {
          orgId: seed.orgId,
          rootId: live.rootId,
          vehicleId: v,
          evidence: { kind: "DEPOSIT", depositId },
          createdBy: seed.userId,
          predecessor: live,
        })
      )
    ).rejects.toThrow(/ACTIVE/i);

    await seed.t.run((ctx) =>
      ctx.db.patch(live._id, { status: "CONSUMED" as const, resolvedAt: Date.now() })
    );
    const terminal = await seed.t.run((ctx) => ctx.db.get(live._id));
    const otherQuote = await cashQuote(seed, seed.customerB, other);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: otherQuote,
      amount: 1_000,
    });
    const otherRoot = (await rootsOn(seed, other))[0];

    await expect(
      seed.t.run((ctx) =>
        attachEpisode(ctx, {
          orgId: seed.orgId,
          rootId: otherRoot._id,
          vehicleId: other,
          evidence: { kind: "DEPOSIT", depositId },
          createdBy: seed.userId,
          predecessor: terminal!,
        })
      )
    ).rejects.toThrow(/root|vehicle/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// P1-W — EVERY REACHABLE ACQUISITION WRITER USES THE SAME BOUNDARY
//
// c15587: the gate is not "migrate six because the old branch had six" — it is
// that every acquisition writer that ACTUALLY EXISTS and is REACHABLE on this
// branch either uses M1+M2 or fails closed.
//
// Five exist today. The historical reversal-restore acquisition is deferred to
// Phase 3 by ruling: wiring it now would mean implementing reversal semantics
// to satisfy an obsolete writer count.
// ═════════════════════════════════════════════════════════════════════════════

describe("P1-W the five reachable acquisition writers", () => {
  /** Release a car's slice so it is awaiting a decision. */
  async function releasedSlice(seed: Seed, a: Id<"vehicles">, b: Id<"vehicles">) {
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      vehicleItems: [
        { vehicleId: a, unitPrice: 15_000 },
        { vehicleId: b, unitPrice: 15_000 },
      ],
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 6_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: a, amount: 3_000 },
        { vehicleId: b, amount: 3_000 },
      ],
    });
    await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: seed.orgId,
      quoteId,
      vehicleId: b,
      reason: "customer changed their mind",
    });
    const hold = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find(
        (h) => h.vehicleId === b && h.allocationStatus === "RELEASED_AWAITING_DECISION"
      )
    );
    expect(hold, "car B's slice is awaiting a decision").toBeTruthy();
    return { quoteId, holdId: hold!._id };
  }

  test("W.1 RETURN_TO_UNALLOCATED re-acquires through the authority", async () => {
    // Putting money back ON the deal is asking for the car again. It must go
    // through the boundary, and it must land on the deal's OWN root.
    const seed = await seedDealer("w1");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const { holdId } = await releasedSlice(seed, a, b);
    const rootsBefore = await rootsOn(seed, b);

    await seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId,
      treatment: "RETURN_TO_UNALLOCATED" as const,
      reason: "back on the deal",
    });

    const rootsAfter = await rootsOn(seed, b);
    expect(rootsAfter.length, "one physical car, one root — never a second").toBe(
      rootsBefore.length
    );
    const live = (await claimsOn(seed, b)).filter((c) => c.status === "ACTIVE");
    expect(live.length, "and the car is held again").toBeGreaterThan(0);
    expect(
      new Set(live.map((c) => String(c.rootId))).size,
      "every live episode on the same root"
    ).toBe(1);
    expect(live.every((c) => c.evidenceKind === "DEPOSIT"), "tagged by its evidence").toBe(true);
  });

  // ⚠️ W.2 WITHDRAWN AS UNREACHABLE IN PHASE 1, AND RECORDED RATHER THAN LEFT
  // RED. It asserted that RETURN_TO_UNALLOCATED refuses a car a rival took
  // between the release and the decision — the refusal branch of W.1.
  //
  // It cannot reach its subject here. Releasing an ALLOCATION does not release
  // the CLAIM: claim lifecycle on release is Phase 3 work. So car B stays held
  // by its own deal throughout Phase 1, the rival's deposit is refused at the
  // fixture, and the contract would die before testing anything.
  //
  // The property still matters and is a PHASE 3 OBLIGATION, listed here so it
  // is carried forward rather than lost: once a released slice frees the car,
  // RETURN_TO_UNALLOCATED must refuse a vehicle another root has since taken,
  // and must refuse BEFORE any side effect. Writing it now would repeat the
  // mistake this rebuild exists to correct — a contract that cannot reach the
  // thing it names proves nothing about it.

  test("W.3 REALLOCATE_TO_VEHICLE acquires the RECEIVING car through the authority", async () => {
    const seed = await seedDealer("w3");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const { holdId } = await releasedSlice(seed, a, b);
    const rootsABefore = await rootsOn(seed, a);

    await seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId,
      treatment: "REALLOCATE_TO_VEHICLE" as const,
      toVehicleId: a,
      reason: "put it on the other car",
    });

    expect(
      (await rootsOn(seed, a)).length,
      "the receiving car keeps its own single root — this deal already held it"
    ).toBe(rootsABefore.length);
    const liveOnA = (await claimsOn(seed, a)).filter((c) => c.status === "ACTIVE");
    expect(liveOnA.length, "and gains an episode for the money that moved").toBeGreaterThan(1);
    expect(
      new Set(liveOnA.map((c) => String(c.rootId))).size,
      "all on the one root"
    ).toBe(1);
  });

  test("W.4 a finance application acquires the car, tagged FINANCE", async () => {
    const seed = await seedDealer("w4");
    const v = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "MANUAL_FINANCE_COMPANY" as const,
      vehiclePrice: PRICE,
      downPayment: 5_000,
      termMonths: 36,
      totalFinancedAmount: 25_000,
    });
    await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });

    const roots = await rootsOn(seed, v);
    expect(roots.length, "a live application holds the car in its own right").toBe(1);
    const claims = await claimsOn(seed, v);
    expect(claims.length).toBe(1);
    expect(claims[0].evidenceKind, "tagged FINANCE, not DEPOSIT").toBe("FINANCE");
    expect(claims[0].applicationId, "and names the application").toBeTruthy();
  });

  test("W.5 a deposit then an application on ONE deal is two episodes on ONE root", async () => {
    // The ordinary financed flow. Two kinds of evidence, one deal — so one
    // root and two independently-endable episodes, not two roots and not one
    // episode that changes kind underneath.
    const seed = await seedDealer("w5");
    const v = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "MANUAL_FINANCE_COMPANY" as const,
      vehiclePrice: PRICE,
      downPayment: 5_000,
      termMonths: 36,
      totalFinancedAmount: 25_000,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });

    expect((await rootsOn(seed, v)).length, "one deal, one root").toBe(1);
    const claims = await claimsOn(seed, v);
    expect(claims.length, "two acquisitions, two episodes").toBe(2);
    expect(
      claims.map((c) => c.evidenceKind).sort(),
      "each tagged by what it actually rests on"
    ).toEqual(["DEPOSIT", "FINANCE"]);
    expect(
      new Set(claims.map((c) => String(c.rootId))).size,
      "on the SAME root — the application JOINED the deposit's deal"
    ).toBe(1);
  });

  test("W.6 a finance application REFUSES a car another deal holds", async () => {
    const seed = await seedDealer("w6");
    const v = await vehicle(seed);
    const held = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: held,
      amount: 2_000,
    });

    const rivalQuote = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerB,
      vehicleId: v,
      mode: "MANUAL_FINANCE_COMPANY" as const,
      vehiclePrice: PRICE,
      downPayment: 5_000,
      termMonths: 36,
      totalFinancedAmount: 25_000,
    });
    await expectRefusal(
      seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
      }),
      HELD,
      "W.6"
    );
    expect((await rootsOn(seed, v)).length, "and no second root was opened").toBe(1);
  });
});
