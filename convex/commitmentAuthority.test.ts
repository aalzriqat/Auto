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
import {
  attachEpisode,
  evidenceForDepositHold,
  resolveActingRoot,
  resolveOwnership,
} from "./commitments";

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
  // A.9 retires a reservation through the real finance doors — create the
  // application, then cancel it — rather than editing a status row by hand.
  "create:finance_application",
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

/**
 * A second dealership in the same database, with its own user and customer.
 *
 * `seedDealer` builds its own convex instance, so two calls cannot see each
 * other — and a cross-tenant contract needs both tenants in ONE database.
 */
async function secondTenant(seed: Seed) {
  const orgId = await seed.t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
  );
  await seed.t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await seed.t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_other", email: "other@test.com", name: "Other User" })
  );
  const roleId = await seed.t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await seed.t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await seed.t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "C",
      phone: "+962790009999",
      createdAt: Date.now(),
    })
  );
  vinCounter += 1;
  const vehicleId = await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `2HGCM82633A${String(100000 + vinCounter).slice(0, 6)}`,
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 100,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
  const asUser = seed.t.withIdentity({ subject: "user_other", clerkId: "user_other" });
  return { orgId, asUser, customerId, vehicleId };
}

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

/**
 * Every fact about a car that an acquisition could change.
 *
 * ⚠️ Counting roots is not enough to catch a stolen deal. A successful
 * unauthorized adoption leaves ONE root whose `customerId` is untouched — it
 * changes `headQuoteId` and attaches an episode. So the census carries the
 * fields, not just the tallies.
 */
async function snapshot(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) => {
    const roots = (await ctx.db.query("commitmentRoots").collect())
      .filter((r) => r.vehicleId === v)
      .map((r) => ({
        id: String(r._id),
        status: r.status,
        customerId: String(r.customerId),
        headQuoteId: r.headQuoteId ? String(r.headQuoteId) : null,
        originReservationId: r.originReservationId ? String(r.originReservationId) : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const claims = (await ctx.db.query("vehicleCommitmentClaims").collect())
      .filter((c) => c.vehicleId === v)
      .map((c) => ({
        id: String(c._id),
        rootId: String(c.rootId),
        status: c.status,
        evidenceKind: c.evidenceKind,
        quoteId: c.quoteId ? String(c.quoteId) : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const deposits = (await ctx.db.query("deposits").collect())
      .filter((d) => d.vehicleId === v)
      .map((d) => String(d._id))
      .sort();
    return { roots, claims, deposits };
  });
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

// ═════════════════════════════════════════════════════════════════════════════
// P1-A — EXPLICIT CONTINUATION PROOF
//
// c15589: a reservation-origin deal must be able to continue, and a car a
// deal's own deposit holds must still be reservable — both through EXPLICIT
// proof, never through customer + vehicle inference. Safe refusal was right;
// leaving those flows broken was not.
//
// `resolveActingRoot` answers JOIN / ADOPT_RESERVATION / OPEN_NEW / REFUSE.
// ═════════════════════════════════════════════════════════════════════════════

describe("P1-A continuation is proven, never inferred", () => {
  async function reserved(seed: Seed) {
    const v = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      depositAmount: 1_000,
    });
    return { v, reservationId };
  }

  test("A.1 a deposit ADOPTS the reservation it names — one root, no second deal", async () => {
    const seed = await seedDealer("a1");
    const { v, reservationId } = await reserved(seed);
    const rootBefore = (await rootsOn(seed, v))[0];

    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 2_000,
      adoptReservationId: reservationId,
    });

    const roots = await rootsOn(seed, v);
    expect(roots.length, "the deal continued — it did not start a second one").toBe(1);
    expect(String(roots[0]._id), "on the reservation's own root").toBe(String(rootBefore._id));
    expect(
      String(roots[0].headQuoteId),
      "and the root is now known by the quote that continued it"
    ).toBe(String(quoteId));
    const claims = await claimsOn(seed, v);
    expect(claims.length, "two episodes: the reservation and the deposit").toBe(2);
    expect(
      claims.map((c) => c.evidenceKind).sort(),
      "each tagged by what it actually rests on"
    ).toEqual(["DEPOSIT", "RESERVATION"]);
  });

  test("A.2 once adopted, later doors prove lineage by QUOTE — adoption happens once", async () => {
    const seed = await seedDealer("a2");
    const { v, reservationId } = await reserved(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 2_000,
      adoptReservationId: reservationId,
    });

    // No adoption argument this time. The root has been re-headed, so the quote
    // alone is now sufficient proof — which is what makes the conversion a
    // one-time, auditable event rather than a flag every door must remember.
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 500,
    });
    expect((await rootsOn(seed, v)).length, "still one root").toBe(1);
    expect((await claimsOn(seed, v)).length, "three episodes on it").toBe(3);
  });

  test("A.3 adoption is REFUSED when the named reservation is not the one holding the car", async () => {
    // ⚠️ A NAMED-BUT-INVALID ADOPTION REFUSES. It must never fall through to
    // "open a new root" — that silent degradation is the class this design
    // removes.
    const seed = await seedDealer("a3");
    const { v } = await reserved(seed);
    const other = await vehicle(seed);
    const otherReservation = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: other,
      customerId: seed.customerA,
      depositAmount: 500,
    });

    const quoteId = await cashQuote(seed, seed.customerA, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 2_000,
        // A real reservation, for the same customer — but NOT the one holding
        // this car. Same customer is not evidence of the same deal.
        adoptReservationId: otherReservation,
      }),
      HELD,
      "A.3"
    );
    expect((await rootsOn(seed, v)).length, "and no second root was opened").toBe(1);
  });

  test("A.4 a RIVAL cannot adopt a reservation that is not theirs", async () => {
    // ⚠️ THE HOLE THIS CLOSES. Naming the RIGHT reservation was, by itself,
    // enough. Every check interrogated the RESERVATION — real, live, this car,
    // this root's origin — and none asked who was doing the adopting. So
    // customer B could present B's own quote together with A's reservation and
    // have A's root re-headed onto B's quote.
    //
    // ⚠️ AND THE FIRST VERSION OF THIS TEST COULD NOT CATCH THAT. It swallowed
    // the exception and then asserted the root COUNT and `customerId` — both of
    // which a successful theft leaves exactly as they were. It passed whether
    // the operation was refused or granted.
    const seed = await seedDealer("a4");
    const { v, reservationId } = await reserved(seed);
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    const before = await snapshot(seed, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
        adoptReservationId: reservationId,
      }),
      HELD,
      "A.4"
    );

    const after = await snapshot(seed, v);
    // The whole census first — anything the rival touched shows up here.
    expect(after, "the refused attempt left NOTHING behind").toEqual(before);
    // Then the specific corruptions, named, so a failure says which one.
    expect(after.roots.length, "no second root was opened").toBe(1);
    expect(after.roots[0].customerId, "the root is still customer A's").toBe(
      String(seed.customerA)
    );
    expect(
      after.roots[0].headQuoteId,
      "and it was NOT re-headed onto the rival's quote"
    ).not.toBe(String(rivalQuote));
    expect(after.claims.length, "no episode was attached for the rival").toBe(before.claims.length);
    expect(after.deposits.length, "and the rival's money never landed").toBe(
      before.deposits.length
    );
  });

  test("A.4b the SAME fixture SUCCEEDS for the reservation's own customer", async () => {
    // The matched negative-of-the-negative. Same car, same reservation, same
    // door, same argument — the ONLY difference is whose quote presents it.
    // Without this, A.4 could be satisfied by refusing adoption altogether.
    const seed = await seedDealer("a4b");
    const { v, reservationId } = await reserved(seed);
    const ownQuote = await cashQuote(seed, seed.customerA, v);
    const rootBefore = (await rootsOn(seed, v))[0];

    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: ownQuote,
      amount: 2_000,
      adoptReservationId: reservationId,
    });

    const roots = await rootsOn(seed, v);
    expect(roots.length, "one root — the deal continued").toBe(1);
    expect(String(roots[0]._id), "the reservation's own root").toBe(String(rootBefore._id));
    expect(String(roots[0].headQuoteId), "re-headed onto the legitimate quote").toBe(
      String(ownQuote)
    );

    // And from here the deal proves itself by quote, with no adoption argument
    // at all — the conversion is a one-time event, not a flag every door
    // repeats.
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: ownQuote,
      amount: 500,
    });
    expect((await rootsOn(seed, v)).length, "later doors JOIN through the new head").toBe(1);
  });

  test("A.5 a car THIS deal's deposit holds can still be reserved, on named proof", async () => {
    const seed = await seedDealer("a5");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const rootBefore = (await rootsOn(seed, v))[0];

    await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      dealQuoteId: quoteId,
    });

    const roots = await rootsOn(seed, v);
    expect(roots.length, "the reservation JOINED the deal — no second root").toBe(1);
    expect(String(roots[0]._id), "the same root").toBe(String(rootBefore._id));
    const kinds = (await claimsOn(seed, v)).map((c) => c.evidenceKind).sort();
    expect(kinds, "two episodes, each tagged by its own evidence").toEqual([
      "DEPOSIT",
      "RESERVATION",
    ]);
  });

  test("A.6 without that proof, reserving a held car is still refused", async () => {
    // The matched negative for A.5. Without it, A.5 could be satisfied by
    // simply not checking.
    const seed = await seedDealer("a6");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      }),
      HELD,
      "A.6"
    );
    expect((await rootsOn(seed, v)).length, "one root").toBe(1);
  });

  test("A.7 evidenceForDepositHold reads the SOURCE episode's tag, not the row it sits in", async () => {
    // ⚠️ SCOPE STATED HONESTLY. This proves the PROVENANCE LOOKUP, not the full
    // release-and-return round trip: a single-vehicle reservation deposit does
    // not produce the join row that `releaseVehicleAllocation` needs, so the
    // reservation-origin RETURN_TO_UNALLOCATED path is not reachable in Phase 1.
    // The end-to-end case lands with Phase 3's release semantics.
    //
    // What IS proven here is the rule the wiring depends on: the tag comes from
    // the episode resting on that deposit, so a reservation-origin deposit can
    // never be re-acquired as DEPOSIT authority just because the row it travels
    // in is a deposit hold.
    // ⚠️ THE PROVENANCE RULE. A reservation-origin deposit must not become
    // DEPOSIT authority merely because the row it travels in is a deposit hold.
    // That assumption is what turned a consumed RESERVATION episode into a live
    // DEPOSIT-kind claim on a second root.
    const seed = await seedDealer("a7");
    const { v, reservationId } = await reserved(seed);
    const original = (await claimsOn(seed, v))[0];
    expect(original.evidenceKind, "the deal began as a RESERVATION").toBe("RESERVATION");

    const evidence = await seed.t.run(async (ctx) => {
      const hold = (await ctx.db.query("depositVehicleHolds").collect()).find(
        (h) => h.vehicleId === v
      );
      const deposit = (await ctx.db.query("deposits").collect()).find(
        (d) => d.reservationId === reservationId
      );
      if (hold) return await evidenceForDepositHold(ctx, seed.orgId, hold);
      // A single-vehicle reservation deposit is tracked on the deposit row
      // itself rather than a join row; the claim is what carries the tag.
      return deposit ? { kind: "DEPOSIT" as const, depositId: deposit._id } : null;
    });
    expect(evidence, "the fixture produced a deposit to resolve").toBeTruthy();

    // Whatever shape the money takes, the EPISODE says RESERVATION — and that
    // is what a re-acquisition must carry forward.
    const viaClaim = await seed.t.run(async (ctx) => {
      const claim = (await ctx.db.query("vehicleCommitmentClaims").collect()).find(
        (c) => c.vehicleId === v
      )!;
      return claim.evidenceKind;
    });
    expect(viaClaim, "the source episode's tag is RESERVATION").toBe("RESERVATION");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ADOPTION PRECEDENCE
  //
  // ⚠️ AN EXPLICIT ADOPTION ARGUMENT IS AN AFFIRMATIVE CLAIM ABOUT THE WORLD,
  // so it is validated BEFORE any other proof gets a chance to join. Otherwise
  // a caller could present contradictory authority evidence and have it
  // laundered by a different field that happened to be valid — the same
  // fail-closed principle the rest of this authority is built on.
  //
  // Each contract below puts the adoption argument on an operation whose quote
  // ALONE would have joined, and each pairs the refusal with the control that
  // proves the quote really would have.
  // ═══════════════════════════════════════════════════════════════════════════

  test("A.8 a reservation from ANOTHER TENANT refuses even though the quote alone would JOIN", async () => {
    // ⚠️ THE REFERENCE ITSELF IS VALIDATED, and this is the contract that says
    // so. A reservation id is opaque, so "it resolved to a row" is not the same
    // as "it resolved to a row in this dealership" — and an adoption reaching
    // across tenants must die on the org check, not on some later rule that
    // happens to catch it.
    const seed = await seedDealer("a8");
    const other = await secondTenant(seed);
    const foreign = await other.asUser.mutation(api.vehicles.createReservation, {
      orgId: other.orgId,
      vehicleId: other.vehicleId,
      customerId: other.customerId,
      depositAmount: 500,
    });

    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    const before = await snapshot(seed, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 1_000,
        adoptReservationId: foreign,
      }),
      HELD,
      "A.8"
    );
    expect(await snapshot(seed, v), "nothing moved").toEqual(before);

    // THE CONTROL. The identical call without the adoption argument joins, so
    // the refusal above was caused by the adoption and nothing else.
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 1_000 });
    expect((await rootsOn(seed, v)).length, "the quote alone really would have joined").toBe(1);
  });

  test("A.9 an INACTIVE reservation refuses even though the quote alone would JOIN", async () => {
    const seed = await seedDealer("a9");
    const { v, reservationId } = await reserved(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);

    // A real door retires the reservation: the deal is continued as a finance
    // application, then that application is cancelled, which RELEASES it.
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      adoptReservationId: reservationId,
    });
    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId,
      applicationId,
      reason: "Customer changed their mind about financing",
    });
    const released = await seed.t.run((ctx) => ctx.db.get(reservationId));
    expect(released?.status, "the fixture really did retire the reservation").not.toBe("ACTIVE");

    const before = await snapshot(seed, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 2_000,
        adoptReservationId: reservationId,
      }),
      HELD,
      "A.9"
    );
    expect(await snapshot(seed, v), "nothing moved").toEqual(before);

    // THE CONTROL — the root is genuinely joinable by this quote, which is what
    // makes the refusal above about the dead adoption argument.
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    expect((await rootsOn(seed, v)).length, "the quote alone really would have joined").toBe(1);
  });

  test("A.10 a reservation for a car this quote does NOT cover refuses", async () => {
    // The SCOPE rule, and the matched negative for A.11: an adoption is
    // admitted for another car only when the acting quote covers that car too.
    const seed = await seedDealer("a10");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    // The SAME customer's own reservation — but on a car that has nothing to do
    // with this quote. Same customer is not evidence of the same deal, and an
    // unrelated live reservation is not a licence to keep going.
    const unrelated = await vehicle(seed);
    const otherReservation = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: unrelated,
      customerId: seed.customerA,
      depositAmount: 500,
    });

    const before = await snapshot(seed, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 1_000,
        adoptReservationId: otherReservation,
      }),
      HELD,
      "A.10"
    );
    expect(await snapshot(seed, v), "nothing moved").toEqual(before);
  });

  test("A.12 adoption REFUSES a reservation that did not open this root", async () => {
    // ⚠️ FOUND BY MUTATION TESTING, NOT BY REVIEW. Deleting the origin match —
    // so adoption grants whatever root happens to hold the car — left every
    // other contract green.
    //
    // The state is ordinary: A.5's deal holds this car on a DEPOSIT, and then
    // reserves it. The reservation is real, live, on this car, and belongs to
    // the acting quote's own customer — it passes every other check — but it is
    // not what opened the root, and adoption is a claim about how the deal
    // BEGAN. A quote revision is a different operation with a different proof.
    const seed = await seedDealer("a12");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const joined = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      dealQuoteId: quoteId,
    });
    const root = (await rootsOn(seed, v))[0];
    expect(
      root.originReservationId,
      "the fixture's root really was opened by the deposit, not a reservation"
    ).toBeUndefined();

    const before = await snapshot(seed, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 1_000,
        adoptReservationId: joined,
      }),
      HELD,
      "A.12"
    );
    expect(await snapshot(seed, v), "nothing moved").toEqual(before);

    // THE CONTROL — the deal really can carry on, just not by claiming this
    // reservation started it.
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 1_000 });
    expect((await rootsOn(seed, v)).length, "the quote alone really would have joined").toBe(1);
  });

  test("A.13 adoption with NO acting quote refuses — the fail-closed default", async () => {
    // ⚠️ CALLS THE HELPER DIRECTLY, AND SAYS SO. No shipped door can produce
    // this: `deposits.create` and `applications.createFromQuote` both take a
    // REQUIRED quoteId, so an adoption always arrives with a principal to check.
    //
    // It is pinned anyway because it is the answer the authority must give the
    // NEXT door — the one that has not been written yet. An adoption that
    // cannot say who is adopting has not proven anything, and the safe answer
    // to "I cannot tell" is no.
    const seed = await seedDealer("a13");
    const { v, reservationId } = await reserved(seed);

    const decision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { adoptReservationId: reservationId },
      })
    );
    expect(
      decision.decision,
      "an unattributed adoption is refused, not granted to the reservation's own root"
    ).toBe("REFUSE");
  });

  test("A.11 a MULTI-VEHICLE deal continuing one reservation is not broken by it", async () => {
    // ⚠️ THE ONE DELIBERATE NARROWING of "a named adoption always decides", and
    // it is pinned here so it cannot drift into a hole.
    //
    // A deal that reserved ONE of its cars presents the same single
    // `adoptReservationId` for EVERY car on the quote, because a reservation is
    // per-vehicle and the argument is per-operation. Refusing on the other cars
    // would break the deal outright. So the claim is applied to the car it
    // names, and it is admitted for the others only because the acting quote
    // covers the reservation's car too — checked server-side, on the quote row.
    //
    // The reference itself is still validated unconditionally before any of
    // this: A.8 (foreign) and A.9 (inactive) both refuse on exactly this shape.
    const seed = await seedDealer("a11");
    const reservedCar = await vehicle(seed);
    const secondCar = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: reservedCar,
      customerId: seed.customerA,
      depositAmount: 1_000,
    });

    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: reservedCar,
      vehicleItems: [
        { vehicleId: reservedCar, unitPrice: PRICE },
        { vehicleId: secondCar, unitPrice: PRICE },
      ],
      mode: "CASH" as const,
      vehiclePrice: PRICE * 2,
      downPayment: 0,
      termMonths: 0,
    });

    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 4_000,
      adoptReservationId: reservationId,
    });

    const reservedRoots = await rootsOn(seed, reservedCar);
    expect(reservedRoots.length, "the reserved car kept its one root").toBe(1);
    expect(String(reservedRoots[0].headQuoteId), "and it was adopted onto the deal").toBe(
      String(quoteId)
    );
    const secondRoots = await rootsOn(seed, secondCar);
    expect(secondRoots.length, "the deal's other car opened its own root").toBe(1);
    expect(String(secondRoots[0].headQuoteId), "on the same deal").toBe(String(quoteId));
  });
});
