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
  reservationIsLive,
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
/**
 * The car's LIVE root, if it has one.
 *
 * ⚠️ NOT a replacement for `rootsOn`, which stays as it is. Total-root counts
 * are how several contracts here prove that an unauthorized operation wrote no
 * extra history, and that question is about ALL roots. This one answers a
 * different question — who holds the car NOW — and after SCRUM-195 M3 those
 * two genuinely differ: a released or consumed root stays on the vehicle
 * forever as history while a later legitimate acquisition opens a fresh one.
 */
async function openRootsOn(seed: Seed, v: Id<"vehicles">) {
  return (await rootsOn(seed, v)).filter((r) => r.status === "OPEN");
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
    // through the boundary, and the slice that comes back must NAME the
    // episode that re-acquired the car — on the root that is live now.
    //
    // ⚠️ REWRITTEN UNDER OWNER RULING c15695 §1. This contract used to demand
    // that the car still had exactly ONE root and that every ACTIVE claim sat
    // on it. Both were true only because the pre-M3 world had no release side
    // at all: the root stayed OPEN through the release, so a re-acquisition
    // had nothing to do but join it. M3 terminalizes, and under B+ a claim is
    // never re-statused — so the honest post-M3 shape is
    //
    //     RELEASED historical root   (immutable, its ACTIVE claim now stale)
    //          + RETURN_TO_UNALLOCATED
    //     -> a FRESH OPEN root       (the acquisition that actually holds it)
    //
    // Ownership comes from the OPEN root, never from `claim.status`. Counting
    // roots and filtering claims by ACTIVE are both pre-M3 bookkeeping, and
    // the assertions below replace them with the stronger claim: exactly one
    // live root, the old one untouched, and the reopened slice pointing at an
    // acquisition ON the live one.
    const seed = await seedDealer("w1");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const { holdId } = await releasedSlice(seed, a, b);

    const rootsBefore = await rootsOn(seed, b);
    expect(rootsBefore.length, "the released slice left exactly one root behind").toBe(1);
    const historical = rootsBefore[0];
    expect(historical.status, "and the release really did terminalize it").toBe("RELEASED");
    expect(await openRootsOn(seed, b), "so nothing holds the car right now").toEqual([]);

    await seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId,
      treatment: "RETURN_TO_UNALLOCATED" as const,
      reason: "back on the deal",
    });

    // THE HISTORICAL ROOT IS IMMUTABLE. Re-acquiring a car may not reach back
    // and reopen the episode that ended — a terminal root is a closed fact,
    // and rewriting it would destroy the provenance Phase 3 reads.
    expect(
      await seed.t.run((ctx) => ctx.db.get(historical._id)),
      "the released root is a closed fact and nothing rewrote it"
    ).toEqual(historical);

    // ONE live root, and it is a NEW one.
    const liveRoots = await openRootsOn(seed, b);
    expect(liveRoots.length, "the car is held again, on exactly one live root").toBe(1);
    expect(String(liveRoots[0]._id), "and it is a fresh root, not the released one").not.toBe(
      String(historical._id)
    );

    // SCRUM-195: the re-opened slice NAMES the episode that re-acquired the
    // car. Without it, the next decision on this money has nothing to read but
    // history — which is exactly the unbounded search the pointer replaced.
    const reopened = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find(
        (h) => String(h.vehicleId) === String(b) && String(h.sourceHoldId) === String(holdId)
      )
    );
    expect(reopened?.sourceCommitmentClaimId, "the re-opened slice names its episode").toBeTruthy();

    // AND THAT EPISODE IS ON THE LIVE ROOT. This is the assertion that
    // replaces the old root count, and it is strictly stronger: a pointer at
    // the stale claim on the RELEASED root would satisfy "names its episode"
    // and still leave the money pointing at a deal that has ended.
    const acquiring = await seed.t.run((ctx) => ctx.db.get(reopened!.sourceCommitmentClaimId!));
    expect(acquiring, "the named episode exists").toBeTruthy();
    expect(
      String(acquiring!.rootId),
      "and it is an acquisition on the LIVE root, not the released one"
    ).toBe(String(liveRoots[0]._id));
    expect(acquiring!.evidenceKind, "tagged by its evidence").toBe("DEPOSIT");
    expect(
      await seed.t.run(async (ctx) =>
        evidenceForDepositHold(ctx, seed.orgId, (await ctx.db.get(reopened!._id))!)
      ),
      "and that episode resolves to what the money is evidence of"
    ).toEqual({ kind: "DEPOSIT", depositId: reopened!.depositId });
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

    // The receiving car's new slice names the episode that acquired it — the
    // NEW one, not the source hold's.
    const moved = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find(
        (h) => String(h.vehicleId) === String(a) && String(h.sourceHoldId) === String(holdId)
      )
    );
    expect(moved?.sourceCommitmentClaimId, "the moved slice names its episode").toBeTruthy();
    expect(
      await seed.t.run(async (ctx) =>
        evidenceForDepositHold(ctx, seed.orgId, (await ctx.db.get(moved!._id))!)
      ),
      "and it resolves to the evidence carried from the source"
    ).toEqual({ kind: "DEPOSIT", depositId: moved!.depositId });
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

  // ════════════════════════════════════════════════════════════════════════════
  // A.7 — PROVENANCE IS CARRIED, EXACT, AND BOUNDED
  //
  // ⚠️ TWO DEFECTS SHAPED THIS SECTION, AND BOTH WERE MINE.
  //
  // The first A.7 COULD NOT FAIL. Its fixture was a single-vehicle reservation,
  // which produces NO `depositVehicleHolds` row, so the branch that calls
  // `evidenceForDepositHold` was dead and the assertion ran on a literal built
  // inside the test. A helper hardcoded to return DEPOSIT passed it.
  //
  // The correction that replaced it asked the right question — which episode
  // does THIS car's slice of THIS money come from — and answered it by reading
  // EVERY episode sharing that deposit and that vehicle, then checking they
  // agreed. Agreement is the normal case, so the read grew with the deal's
  // history: 61 rows to return one answer, reproduced. An authority that
  // eventually meets Convex's transaction limit is not a complete authority,
  // and bounding it with a page size would have been worse still.
  //
  // So a hold now NAMES the episode it was created alongside. These contracts
  // prove the named one is what gets read, that every way of naming the wrong
  // one fails closed, and that the read does not grow with history.
  // ════════════════════════════════════════════════════════════════════════════

  /** A real multi-vehicle deposit — the one reachable way to get hold rows. */
  async function multiVehicleDeposit(seed: Seed, cars: Id<"vehicles">[], amount = 4_000) {
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: cars[0],
      vehicleItems: cars.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })),
      mode: "CASH" as const,
      vehiclePrice: PRICE * cars.length,
      downPayment: 0,
      termMonths: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount });
    return await seed.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect()).find((d) => d.quoteId === quoteId)!;
      const holds = (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => String(h.depositId) === String(deposit._id)
      );
      return { quoteId, depositId: deposit._id, holds };
    });
  }

  async function holdFor(seed: Seed, depositId: Id<"deposits">, v: Id<"vehicles">) {
    return await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find(
        (h) => String(h.depositId) === String(depositId) && String(h.vehicleId) === String(v)
      )!
    );
  }

  async function evidenceFor(seed: Seed, depositId: Id<"deposits">, v: Id<"vehicles">) {
    const hold = await holdFor(seed, depositId, v);
    return await seed.t.run(async (ctx) => {
      const fresh = (await ctx.db.get(hold._id))!;
      return await evidenceForDepositHold(ctx, seed.orgId, fresh);
    });
  }

  /** Point a hold somewhere else, to prove the pointer is CHECKED, not trusted. */
  async function repoint(
    seed: Seed,
    holdId: Id<"depositVehicleHolds">,
    claimId: Id<"vehicleCommitmentClaims"> | undefined
  ) {
    await seed.t.run(async (ctx) =>
      ctx.db.patch(holdId, { sourceCommitmentClaimId: claimId })
    );
  }

  const UNPROVEN = /missing its commitment record/i;

  test("A.7a the WRITER stamps the episode, and the helper reads the one it names", async () => {
    const seed = await seedDealer("a7a");
    const cars = [await vehicle(seed), await vehicle(seed)];
    const { depositId, holds } = await multiVehicleDeposit(seed, cars);
    expect(holds.length, "the fixture really produced hold rows to resolve").toBe(2);

    // The production writer, not the test, put the pointer there.
    for (const hold of holds) {
      expect(
        hold.sourceCommitmentClaimId,
        `the hold on ${hold.vehicleId} names the episode it was created with`
      ).toBeTruthy();
    }
    const first = holds.find((h) => String(h.vehicleId) === String(cars[0]))!;
    const claim = await seed.t.run((ctx) => ctx.db.get(first.sourceCommitmentClaimId!));
    expect(String(claim?.vehicleId), "and it is THIS car's episode").toBe(String(cars[0]));
    expect(String(claim?.depositId), "resting on THIS money").toBe(String(depositId));

    expect(
      await evidenceFor(seed, depositId, cars[0]),
      "the helper's own return value, not a literal"
    ).toEqual({ kind: "DEPOSIT", depositId });
  });

  test("A.7b provenance is per-CAR — proven in both directions", async () => {
    // ⚠️ FIXTURE BOUNDARY, STATED. One deposit under episodes of DIFFERENT kinds
    // on two cars cannot be built through a public door — the writers keep one
    // defining kind per deposit. That is precisely why nothing enforces it, and
    // why the helper must not depend on it.
    //
    // Both directions matter: one alone is satisfied by a helper that always
    // answers with the same kind.
    const seed = await seedDealer("a7b");
    const depositCar = await vehicle(seed);
    const reservationCar = await vehicle(seed);
    const { depositId } = await multiVehicleDeposit(seed, [depositCar, await vehicle(seed)]);

    const reservationId = await seed.t.run(async (ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: seed.orgId,
        vehicleId: reservationCar,
        customerId: seed.customerA,
        status: "ACTIVE" as const,
        reservedBy: seed.userId,
        reservedAt: Date.now(),
      })
    );
    await seed.t.run(async (ctx) => {
      const rootId = await ctx.db.insert("commitmentRoots", {
        orgId: seed.orgId,
        vehicleId: reservationCar,
        customerId: seed.customerA,
        status: "OPEN" as const,
        originReservationId: reservationId,
        openedAt: Date.now(),
        openedBy: seed.userId,
      });
      const claimId = await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: seed.orgId,
        rootId,
        vehicleId: reservationCar,
        status: "ACTIVE" as const,
        evidenceKind: "RESERVATION" as const,
        reservationId,
        depositId, // the same money, carried as CONTEXT on a reservation episode
        createdAt: Date.now(),
        createdBy: seed.userId,
      });
      await ctx.db.insert("depositVehicleHolds", {
        orgId: seed.orgId,
        depositId,
        vehicleId: reservationCar,
        active: true,
        createdAt: Date.now(),
        sourceCommitmentClaimId: claimId,
      });
    });

    expect(
      await evidenceFor(seed, depositId, reservationCar),
      "the reservation car's episode is a RESERVATION, and says so"
    ).toEqual({ kind: "RESERVATION", reservationId, depositId });
    expect(
      await evidenceFor(seed, depositId, depositCar),
      "and the same deposit on the OTHER car is still a DEPOSIT"
    ).toEqual({ kind: "DEPOSIT", depositId });
  });

  test("A.7c a hold that names NO episode REFUSES — it is not an ordinary deposit", async () => {
    // ⚠️ THE REMOVED FALLBACK, PINNED AS A REFUSAL. The previous helper ended
    // on "no claim references this deposit anywhere, therefore DEPOSIT". Under
    // the canonical model every hold is written alongside its acquisition, so a
    // hold with no episode is either state from before that model (SCRUM-201
    // owns the cutover) or a row written incompletely. Guessing DEPOSIT is how
    // a reservation's money became a DEPOSIT-kind claim in the first place.
    const seed = await seedDealer("a7c");
    const car = await vehicle(seed);
    const { depositId } = await multiVehicleDeposit(seed, [car, await vehicle(seed)]);
    const hold = await holdFor(seed, depositId, car);

    // The control: it resolves BEFORE the pointer is removed, so the refusal
    // below is the missing pointer and nothing else about the fixture.
    expect(await evidenceFor(seed, depositId, car)).toEqual({ kind: "DEPOSIT", depositId });
    await repoint(seed, hold._id, undefined);

    await expectRefusal(evidenceFor(seed, depositId, car), UNPROVEN, "A.7c");
  });

  test("A.7d a pointer at ANOTHER CAR's episode REFUSES", async () => {
    const seed = await seedDealer("a7d");
    const mine = await vehicle(seed);
    const other = await vehicle(seed);
    const { depositId } = await multiVehicleDeposit(seed, [mine, other]);
    const otherHold = await holdFor(seed, depositId, other);
    const mineHold = await holdFor(seed, depositId, mine);

    // Same deposit, same org, real episode — the ONLY thing wrong is the car,
    // so nothing else in the helper can be what refuses.
    await repoint(seed, mineHold._id, otherHold.sourceCommitmentClaimId!);
    await expectRefusal(evidenceFor(seed, depositId, mine), UNPROVEN, "A.7d");
  });

  test("A.7e a pointer at ANOTHER DEPOSIT's episode REFUSES", async () => {
    const seed = await seedDealer("a7e");
    const car = await vehicle(seed);
    const second = await vehicle(seed);
    const first = await multiVehicleDeposit(seed, [car, second], 4_000);
    // A further instalment on the SAME deal: joins the same root, opens its own
    // episode, and writes its own holds.
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: first.quoteId,
      amount: 3_000,
    });
    const secondDepositId = await seed.t.run(async (ctx) => {
      const rows = (await ctx.db.query("deposits").collect()).filter(
        (d) => String(d.quoteId) === String(first.quoteId)
      );
      return rows.find((d) => String(d._id) !== String(first.depositId))!._id;
    });
    const secondHold = await holdFor(seed, secondDepositId, car);
    const firstHold = await holdFor(seed, first.depositId, car);

    // Same org, same CAR, real episode — only the money is a different row.
    await repoint(seed, firstHold._id, secondHold.sourceCommitmentClaimId!);
    await expectRefusal(evidenceFor(seed, first.depositId, car), UNPROVEN, "A.7e");
  });

  test("A.7f a DANGLING pointer REFUSES", async () => {
    const seed = await seedDealer("a7f");
    const car = await vehicle(seed);
    const { depositId } = await multiVehicleDeposit(seed, [car, await vehicle(seed)]);
    const hold = await holdFor(seed, depositId, car);

    await seed.t.run((ctx) => ctx.db.delete(hold.sourceCommitmentClaimId!));
    await expectRefusal(evidenceFor(seed, depositId, car), UNPROVEN, "A.7f");
  });

  test("A.7g a pointer into ANOTHER TENANT REFUSES", async () => {
    const seed = await seedDealer("a7g");
    const other = await secondTenant(seed);
    const car = await vehicle(seed);
    const { depositId } = await multiVehicleDeposit(seed, [car, await vehicle(seed)]);
    const hold = await holdFor(seed, depositId, car);

    // ⚠️ BUILT TO MATCH ON EVERY OTHER AXIS. The foreign episode names this
    // org's car and this org's deposit, so the vehicle and deposit checks both
    // pass and the tenancy check is the only thing left to refuse.
    const foreign = await seed.t.run(async (ctx) => {
      const rootId = await ctx.db.insert("commitmentRoots", {
        orgId: other.orgId,
        vehicleId: car,
        customerId: other.customerId,
        status: "OPEN" as const,
        openedAt: Date.now(),
        openedBy: seed.userId,
      });
      return await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: other.orgId,
        rootId,
        vehicleId: car,
        status: "ACTIVE" as const,
        evidenceKind: "DEPOSIT" as const,
        depositId,
        createdAt: Date.now(),
        createdBy: seed.userId,
      });
    });
    await repoint(seed, hold._id, foreign);
    await expectRefusal(evidenceFor(seed, depositId, car), UNPROVEN, "A.7g");
  });

  test("A.7h resolving provenance does NOT grow with the deal's history", async () => {
    // ⚠️ THE CARDINALITY CONTRACT, AND IT ASSERTS THE PROPERTY RATHER THAN THE
    // MECHANISM. No index name, no timing, no page size — it counts the reads
    // the helper actually performs and requires that number to be the same
    // whether the car's slice has one episode behind it or sixty-one. The
    // previous implementation read every one of them.
    const seed = await seedDealer("a7h");
    const car = await vehicle(seed);
    const { depositId } = await multiVehicleDeposit(seed, [car, await vehicle(seed)]);
    const hold = await holdFor(seed, depositId, car);

    async function resolveCountingReads() {
      return await seed.t.run(async (ctx) => {
        // Fetched with the RAW ctx so the fixture's own read is not counted.
        const fresh = (await ctx.db.get(hold._id))!;
        let gets = 0;
        let queries = 0;
        const counted = {
          db: {
            get: (...a: unknown[]) => {
              gets += 1;
              return (ctx.db.get as unknown as (...x: unknown[]) => unknown)(...a);
            },
            query: (...a: unknown[]) => {
              queries += 1;
              return (ctx.db.query as unknown as (...x: unknown[]) => unknown)(...a);
            },
          },
        } as unknown as Parameters<typeof evidenceForDepositHold>[0];
        const evidence = await evidenceForDepositHold(counted, seed.orgId, fresh);
        return { gets, queries, evidence };
      });
    }

    const before = await resolveCountingReads();
    expect(before.evidence, "the answer, on a fresh deal").toEqual({ kind: "DEPOSIT", depositId });

    // Sixty more episodes on the SAME deposit and the SAME car, all agreeing —
    // ordinary reacquisition history, not corruption.
    const root = (await rootsOn(seed, car))[0];
    await seed.t.run(async (ctx) => {
      for (let n = 0; n < 60; n += 1) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: seed.orgId,
          rootId: root._id,
          vehicleId: car,
          status: "RELEASED" as const,
          evidenceKind: "DEPOSIT" as const,
          depositId,
          createdAt: Date.now(),
          createdBy: seed.userId,
        });
      }
    });
    const historical = await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
        (c) =>
          String(c.vehicleId) === String(car) && String(c.depositId) === String(depositId)
      )
    );
    expect(historical.length, "the fixture really did build a long history").toBe(61);

    const after = await resolveCountingReads();
    expect(after.evidence, "the same answer").toEqual({ kind: "DEPOSIT", depositId });

    // ⚠️ THE EQUALITY ALONE WOULD BE TOO WEAK. An implementation that SEARCHES
    // issues the same number of `query()` calls whatever the history holds, so
    // "one run cost what the other did" is satisfied by the very design this
    // contract exists to forbid. What separates bounded from unbounded is that
    // there is no search AT ALL: one document, fetched by name.
    expect(
      { gets: before.gets, queries: before.queries },
      "one episode fetched by name, and nothing searched"
    ).toEqual({ gets: 1, queries: 0 });
    expect(
      { gets: after.gets, queries: after.queries },
      "still one, after sixty more episodes on the same money and the same car"
    ).toEqual({ gets: 1, queries: 0 });
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

    // THE CONTROL — the identical call WITHOUT the dead adoption is admitted,
    // which is what makes the refusal above about the adoption argument and
    // nothing else.
    //
    // ⚠️ REWRITTEN UNDER OWNER RULING c15695 §1. It used to say "the quote
    // alone really would have JOINED" and check for a single root. That was
    // true only before M3: the cancellation above ends the deal, and the
    // release side did not exist, so the terminal deal's root stayed OPEN and
    // there was something left to join. Now the cancellation genuinely frees
    // the car, so the correct outcome is an admitted acquisition on a FRESH
    // live root — a car with no live holder is acquirable, which is the exact
    // property this control needs to establish.
    const rootsBeforeControl = await rootsOn(seed, v);
    expect(await openRootsOn(seed, v), "the cancellation really did free the car").toEqual([]);

    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    const liveAfterControl = await openRootsOn(seed, v);
    expect(liveAfterControl.length, "the quote alone really was admitted").toBe(1);
    expect(
      rootsBeforeControl.some((r) => String(r._id) === String(liveAfterControl[0]._id)),
      "on a fresh root — a terminal root is never reopened to receive it"
    ).toBe(false);
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

  test("A.14 the AUTHORITY refuses a foreign customer reusing another deal's deposit proof", async () => {
    // ⚠️ CALLS THE HELPER DIRECTLY, ON PURPOSE, AND THIS IS THE REASON.
    //
    // On the public path `createReservation` has an older guard — "another
    // customer's deposit is currently holding this vehicle" — which fires
    // FIRST. A.15 covers that path and proves the operation is refused with no
    // residue. But a test that dies at an earlier validator proves nothing
    // about the guard it is named for, so participant consistency is asserted
    // here, at the authority, where the rule actually lives.
    const seed = await seedDealer("a14");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const depositId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("deposits").collect();
      return rows.find((d) => d.vehicleId === v)!._id;
    });

    // Customer A's own deposit, presented by customer A: this proof is real.
    const owner = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { depositId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(owner.decision, "the deal that owns the money may act on its own root").toBe("JOIN");

    // The SAME real proof, presented by somebody else.
    const rival = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { depositId },
        actingCustomerId: seed.customerB,
      })
    );
    expect(
      rival.decision,
      "genuine evidence does not entitle whoever happens to present it"
    ).toBe("REFUSE");
  });

  test("A.15 and on the public path that attempt leaves no residue", async () => {
    // ⚠️ WHICH GUARD FIRES IS NOT ASSERTED HERE, and that is deliberate: an
    // older deposit-holder check in `createReservation` refuses this before the
    // authority is consulted. Both refusals are correct and the older one is
    // not being removed. What this contract owns is the OUTCOME — the rival
    // gets nothing, and no reservation, root or episode is left behind.
    const seed = await seedDealer("a15");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const depositId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("deposits").collect();
      return rows.find((d) => d.vehicleId === v)!._id;
    });

    const before = await snapshot(seed, v);
    let threw: unknown = null;
    try {
      await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerB,
        dealDepositId: depositId,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw, "A.15: the rival's reservation must be refused").not.toBeNull();

    expect(await snapshot(seed, v), "and nothing of theirs survived it").toEqual(before);
    const reservations = await seed.t.run((ctx) =>
      ctx.db.query("vehicleReservations").collect()
    );
    expect(reservations.length, "no reservation was recorded for the rival").toBe(0);
  });

  test("A.16 a reservation for one customer citing ANOTHER customer's quote refuses", async () => {
    // The contradiction case, and the authority IS the guard that fires: the
    // car is held by a FINANCE episode with no deposit behind it, so the older
    // deposit-holder check has nothing to say and stands aside.
    //
    // Two statements of who is acting that disagree — the quote says A, the
    // operation says B — are contradictory evidence. Picking whichever is
    // convenient is how a rival gets in.
    const seed = await seedDealer("a16");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });
    const holds = await seed.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(holds.length, "the fixture really has no deposit holding this car").toBe(0);

    const before = await snapshot(seed, v);
    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerB,
        dealQuoteId: quoteId,
      }),
      HELD,
      "A.16"
    );
    expect(await snapshot(seed, v), "nothing moved").toEqual(before);

    // THE CONTROL — the very same call for the quote's OWN customer is allowed,
    // so the refusal above is about the mismatch and not about the door.
    await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      dealQuoteId: quoteId,
    });
    expect((await rootsOn(seed, v)).length, "the deal's own reservation JOINED").toBe(1);
  });

  test("A.17 a held car refuses a RESERVATION proof from an unattributed operation", async () => {
    // ⚠️ ABSENCE IS NOT "NO CONTRADICTION". The participant rule could only
    // compare two things it had, so an operation that named NOBODY sailed past
    // it and the lineage branch below joined a held root on genuine evidence
    // with no attributable deal behind it.
    //
    // Direct-helper contracts, and deliberately so: no shipped door can present
    // a proof without a principal today. This is the answer the authority owes
    // the NEXT caller.
    const seed = await seedDealer("a17");
    const { v, reservationId } = await reserved(seed);

    const unattributed = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, { orgId: seed.orgId, vehicleId: v, lineage: { reservationId } })
    );
    expect(unattributed.decision, "nobody is acting, so nobody may act").toBe("REFUSE");

    // THE CONTROL — the very same proof, attributed, still joins. Without this
    // A.17 would be satisfied by breaking the reservation proof outright.
    const attributed = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { reservationId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(attributed.decision, "the proof itself is good — only the silence was not").toBe("JOIN");
  });

  test("A.18 a held car refuses a DEPOSIT proof from an unattributed operation", async () => {
    const seed = await seedDealer("a18");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const depositId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("deposits").collect();
      return rows.find((d) => d.vehicleId === v)!._id;
    });

    const unattributed = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, { orgId: seed.orgId, vehicleId: v, lineage: { depositId } })
    );
    expect(unattributed.decision, "genuine money, nobody accountable for it").toBe("REFUSE");

    const attributed = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { depositId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(attributed.decision, "the deal whose money it is may still act").toBe("JOIN");
  });

  test("A.19 attribution alone still grants NOTHING — lineage must prove the root", async () => {
    // ⚠️ THE OTHER HALF, AND THE ONE THAT KEEPS I2 INTACT. A.17/A.18 could be
    // satisfied by an authority that hands the root to anyone who names the
    // right customer. The same customer's SECOND, unrelated deal is perfectly
    // attributed and still has no lineage on this car — and is still refused.
    const seed = await seedDealer("a19");
    const v = await vehicle(seed);
    const first = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: first,
      amount: 2_000,
    });

    const decision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: {},
        actingCustomerId: seed.customerA,
      })
    );
    expect(decision.decision, "same customer is not evidence of the same deal").toBe("REFUSE");
  });

  test("A.20 a FREE car still OPENS a root with no principal at all", async () => {
    // The boundary of A.17/A.18: refusing the unattributed must not spread to
    // the one case where acting without lineage is correct. A car nobody holds
    // is still acquirable.
    const seed = await seedDealer("a20");
    const free = await vehicle(seed);
    const decision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, { orgId: seed.orgId, vehicleId: free, lineage: {} })
    );
    expect(decision.decision, "OPEN_NEW is unchanged on a genuinely free car").toBe("OPEN_NEW");
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

// ══════════════════════════════════════════════════════════════════════════════
// C2 — A NAMED PROOF IS PROVED BEFORE IT CAN OPEN OR RE-HEAD A ROOT
//
// ⚠️ A FREE VEHICLE DOES NOT TURN BAD EVIDENCE INTO GOOD EVIDENCE, and that
// was the hole. Proofs were checked only where they were USED to JOIN, so a car
// nobody held took the OPEN_NEW branch before any of it ran and `openRoot`
// persisted whatever it was handed. `createReservation` takes `dealQuoteId`
// straight from the client, so another dealership's quote, a deleted one, or
// one that simply does not include this car became the new root's
// `headQuoteId` — a permanent, unproven statement about which deal owns a car.
//
// The reservation half is worse than untidy metadata: adoption rule (c) admits
// whoever OWNS the reservation a root claims to have come from, so a root
// opened with a stranger's `originReservationId` hands that stranger a door
// into it.
// ══════════════════════════════════════════════════════════════════════════════
describe("P1-C2 a supplied lineage proof is proved, not taken on trust", () => {
  const UNPROVABLE = /does not apply to it/i;

  /** Nothing was opened, nothing was claimed. */
  async function openedNothing(seed: Seed, v: Id<"vehicles">, label: string) {
    expect((await rootsOn(seed, v)).length, `${label}: no root was opened`).toBe(0);
    expect((await claimsOn(seed, v)).length, `${label}: and no episode was attached`).toBe(0);
  }

  test("C2.1 a quote from ANOTHER TENANT cannot open a root on this org's car", async () => {
    // ⚠️ THE FOREIGN QUOTE NAMES *THIS* ORG'S CAR, AND THAT IS THE WHOLE POINT.
    // Written the obvious way — the other dealership quoting its own vehicle —
    // this contract passed for the wrong reason: the quote did not cover this
    // car either, so it died on the coverage rule and the tenancy rule was
    // never reached. Mutation M02 exposed it by deleting the org check and
    // killing nothing. Covering THIS car leaves tenancy as the only rule left
    // to refuse.
    //
    // FIXTURE BOUNDARY, STATED: a cross-tenant quote row cannot be produced
    // through `saveQuote`, so it is written directly.
    const seed = await seedDealer("c21");
    const other = await secondTenant(seed);
    const free = await vehicle(seed);
    const foreignQuote = await seed.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: other.orgId,
        customerId: other.customerId,
        vehicleId: free,
        mode: "CASH" as const,
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        status: "DRAFT" as const,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: free,
        customerId: seed.customerA,
        dealQuoteId: foreignQuote,
      }),
      UNPROVABLE,
      "C2.1"
    );
    await openedNothing(seed, free, "C2.1");
  });

  test("C2.2 a real quote of OUR OWN that does not cover this car refuses", async () => {
    const seed = await seedDealer("c22");
    const otherCar = await vehicle(seed);
    const free = await vehicle(seed);
    // Same org, same customer, genuinely valid — just not about this vehicle.
    const quoteId = await cashQuote(seed, seed.customerA, otherCar);

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: free,
        customerId: seed.customerA,
        dealQuoteId: quoteId,
      }),
      UNPROVABLE,
      "C2.2"
    );
    await openedNothing(seed, free, "C2.2");
  });

  test("C2.3 a DANGLING quote id refuses", async () => {
    const seed = await seedDealer("c23");
    const free = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, free);
    await seed.t.run((ctx) => ctx.db.delete(quoteId));

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: free,
        customerId: seed.customerA,
        dealQuoteId: quoteId,
      }),
      UNPROVABLE,
      "C2.3"
    );
    await openedNothing(seed, free, "C2.3");
  });

  test("C2.4 the matched POSITIVE — a real covering quote opens the root and heads it", async () => {
    // ⚠️ WITHOUT THIS, EVERY REFUSAL ABOVE IS SATISFIED BY REFUSING EVERYTHING.
    const seed = await seedDealer("c24");
    const free = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, free);

    await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: free,
      customerId: seed.customerA,
      dealQuoteId: quoteId,
    });

    const roots = await rootsOn(seed, free);
    expect(roots.length, "exactly one root").toBe(1);
    expect(String(roots[0].headQuoteId), "headed by the quote that proved it").toBe(
      String(quoteId)
    );
  });

  test("C2.5 a deposit that does not apply to this car refuses", async () => {
    const seed = await seedDealer("c25");
    const otherCar = await vehicle(seed);
    const free = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, otherCar);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const depositId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("deposits").collect();
      return rows.find((d) => String(d.vehicleId) === String(otherCar))!._id;
    });

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: free,
        customerId: seed.customerA,
        dealDepositId: depositId,
      }),
      UNPROVABLE,
      "C2.5"
    );
    await openedNothing(seed, free, "C2.5");
  });

  test("C2.6 a deposit belonging to ANOTHER customer refuses, and its owner's does not", async () => {
    // ⚠️ CALLS THE AUTHORITY DIRECTLY, AND THIS IS THE REASON. On the public
    // path `createReservation` has an older guard — "another customer's deposit
    // is currently holding this vehicle" — which fires first whenever the
    // deposit really is on this car. A test that dies at an earlier validator
    // proves nothing about the guard it is named for.
    //
    // FIXTURE BOUNDARY, STATED: the join row is written directly, because a
    // deposit that applies to a car this org still reads as FREE is not a shape
    // a public door produces.
    const seed = await seedDealer("c26");
    const otherCar = await vehicle(seed);
    const free = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, otherCar);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });
    const depositId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query("deposits").collect();
      return rows.find((d) => String(d.vehicleId) === String(otherCar))!._id;
    });
    await seed.t.run((ctx) =>
      ctx.db.insert("depositVehicleHolds", {
        orgId: seed.orgId,
        depositId,
        vehicleId: free,
        active: true,
        createdAt: Date.now(),
      })
    );

    const rival = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: free,
        lineage: { depositId },
        actingCustomerId: seed.customerB,
      })
    );
    expect(rival.decision, "somebody else's money proves nothing for this deal").toBe("REFUSE");

    const owner = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: free,
        lineage: { depositId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(owner.decision, "and the customer whose money it is may still open it").toBe("OPEN_NEW");
  });

  test("C2.7 a reservation proof must be live, for this car, and this customer's", async () => {
    // ⚠️ THE FAIL-CLOSED DEFAULT FOR THE NEXT DOOR, AND SAID PLAINLY. No
    // shipped caller can present an arbitrary `reservationId`:
    // `createReservation` passes the row it has just created, for this car and
    // this customer. These are pinned because the rule is the authority's, not
    // that caller's — Phase 2 and Phase 3 add doors, and a guard that holds
    // only because of who calls it today is not a guard.
    const seed = await seedDealer("c27");
    const free = await vehicle(seed);
    const elsewhere = await vehicle(seed);

    async function decide(reservationId: Id<"vehicleReservations">, customerId: Id<"customers">) {
      return await seed.t.run((ctx) =>
        resolveActingRoot(ctx, {
          orgId: seed.orgId,
          vehicleId: free,
          lineage: { reservationId },
          actingCustomerId: customerId,
        })
      );
    }
    async function reservationRow(
      vehicleId: Id<"vehicles">,
      customerId: Id<"customers">,
      status: "ACTIVE" | "RELEASED"
    ) {
      return await seed.t.run((ctx) =>
        ctx.db.insert("vehicleReservations", {
          orgId: seed.orgId,
          vehicleId,
          customerId,
          status,
          reservedBy: seed.userId,
          reservedAt: Date.now(),
        })
      );
    }

    const otherCar = await reservationRow(elsewhere, seed.customerA, "ACTIVE");
    expect((await decide(otherCar, seed.customerA)).decision, "not this car").toBe("REFUSE");

    const spent = await reservationRow(free, seed.customerA, "RELEASED");
    expect((await decide(spent, seed.customerA)).decision, "no longer a live deal").toBe("REFUSE");

    const strangers = await reservationRow(free, seed.customerB, "ACTIVE");
    expect((await decide(strangers, seed.customerA)).decision, "not this deal's").toBe("REFUSE");

    const good = await reservationRow(free, seed.customerA, "ACTIVE");
    expect(
      (await decide(good, seed.customerA)).decision,
      "and a live reservation for this car and this customer still opens the root"
    ).toBe("OPEN_NEW");
  });

  test("C2.9 a proof from ANOTHER TENANT, or one that has been deleted, proves nothing", async () => {
    // The remaining conjuncts of the deposit and reservation proofs, each with
    // every OTHER axis deliberately valid so only the rule under test can be
    // what refuses. Direct authority calls, for the reason C2.7 gives.
    const seed = await seedDealer("c29");
    const other = await secondTenant(seed);
    const free = await vehicle(seed);

    async function decide(lineage: Parameters<typeof resolveActingRoot>[1]["lineage"]) {
      return await seed.t.run((ctx) =>
        resolveActingRoot(ctx, {
          orgId: seed.orgId,
          vehicleId: free,
          lineage,
          actingCustomerId: seed.customerA,
        })
      );
    }

    // A reservation that is real, live, for this very car and this customer —
    // and recorded under another dealership.
    const foreignReservation = await seed.t.run((ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: other.orgId,
        vehicleId: free,
        customerId: seed.customerA,
        status: "ACTIVE" as const,
        reservedBy: seed.userId,
        reservedAt: Date.now(),
      })
    );
    expect(
      (await decide({ reservationId: foreignReservation })).decision,
      "another dealership's reservation is not proof here"
    ).toBe("REFUSE");

    // A deposit on this very car, for this customer, under another dealership.
    const foreignDeposit = await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: other.orgId,
        vehicleId: free,
        customerId: seed.customerA,
        amount: 1_000,
        status: "HELD" as const,
        holdActive: true,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );
    expect(
      (await decide({ depositId: foreignDeposit })).decision,
      "and neither is another dealership's money"
    ).toBe("REFUSE");

    // Ours, this car, this customer — but soft-deleted. The control proves the
    // fixture would otherwise have opened the root, so the refusal is the
    // deletion and nothing else.
    const ourDeposit = await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId: free,
        customerId: seed.customerA,
        amount: 1_000,
        status: "HELD" as const,
        holdActive: true,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );
    expect(
      (await decide({ depositId: ourDeposit })).decision,
      "the live version of it opens the root"
    ).toBe("OPEN_NEW");
    await seed.t.run((ctx) => ctx.db.patch(ourDeposit, { isDeleted: true }));
    expect(
      (await decide({ depositId: ourDeposit })).decision,
      "a deleted row is not a row"
    ).toBe("REFUSE");
  });

  test("C2.8 an ADOPTION cannot re-head a root onto a quote that is not about this car", async () => {
    // ⚠️ THE OTHER DECISION THAT WRITES ROOT METADATA. OPEN_NEW persists the
    // quote it was handed; ADOPT_RESERVATION re-heads an EXISTING root onto it.
    // Proving one and not the other would leave the same unproven statement
    // reachable through the adoption door.
    //
    // FAIL-CLOSED DEFAULT, STATED: no shipped caller can present this shape.
    // `deposits.create` and `applications.createFromQuote` derive the cars they
    // acquire FROM the quote, so their quote always covers them. Phase 2 and
    // Phase 3 add doors, and the rule belongs to the authority rather than to
    // today's callers.
    const seed = await seedDealer("c28");
    const reservedCar = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: reservedCar,
      customerId: seed.customerA,
      depositAmount: 1_000,
    });

    // Real, this org's, this customer's — and about a different car entirely.
    const elsewhere = await cashQuote(seed, seed.customerA, await vehicle(seed));
    const refused = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: reservedCar,
        lineage: { quoteId: elsewhere, adoptReservationId: reservationId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(refused.decision, "a quote that does not cover the car cannot head it").toBe("REFUSE");

    const covering = await cashQuote(seed, seed.customerA, reservedCar);
    const adopted = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: reservedCar,
        lineage: { quoteId: covering, adoptReservationId: reservationId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(adopted.decision, "and the deal's own quote still adopts it").toBe("ADOPT_RESERVATION");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C4 — AN ADOPTION IS PART OF THE REQUEST, SO IT IS PART OF ITS IDENTITY
//
// ⚠️ AN IDEMPOTENCY KEY ANSWERS "IS THIS THE SAME REQUEST?", AND THE ANSWER WAS
// COMPUTED WITHOUT THE ADOPTION. Two calls sharing a key but naming different
// reservations — or one naming a reservation and one naming none — read as the
// same request, so the second was answered from the first's stored result. Not
// a replay: an affirmative claim about which deal the money continues is
// silently dropped, and the authority never sees the second call to refuse it.
// ══════════════════════════════════════════════════════════════════════════════
describe("P1-C4 an idempotency key does not launder a changed adoption", () => {
  const CONFLICT = /reused with different request content/i;

  async function reservationOn(seed: Seed, v: Id<"vehicles">) {
    return await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      depositAmount: 1_000,
    });
  }

  async function depositCount(seed: Seed) {
    return await seed.t.run(async (ctx) => (await ctx.db.query("deposits").collect()).length);
  }

  test("C4.1 the SAME request, adoption included, is a genuine replay", async () => {
    const seed = await seedDealer("c41");
    const v = await vehicle(seed);
    const reservationId = await reservationOn(seed, v);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    const call = {
      orgId: seed.orgId,
      quoteId,
      amount: 2_000,
      idempotencyKey: "replay-1",
      adoptReservationId: reservationId,
    };

    const first = await seed.asUser.mutation(api.deposits.create, call);
    const before = await snapshot(seed, v);
    const again = await seed.asUser.mutation(api.deposits.create, call);

    expect(String(again), "the same deposit is returned, not a second one").toBe(String(first));
    expect(await snapshot(seed, v), "and nothing moved").toEqual(before);
  });

  test("C4.2 the same key naming a DIFFERENT reservation is a CONFLICT", async () => {
    const seed = await seedDealer("c42");
    const v = await vehicle(seed);
    const reservationId = await reservationOn(seed, v);
    const otherReservation = await reservationOn(seed, await vehicle(seed));
    const quoteId = await cashQuote(seed, seed.customerA, v);

    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 2_000,
      idempotencyKey: "swap-1",
      adoptReservationId: reservationId,
    });
    const before = await snapshot(seed, v);
    const deposits = await depositCount(seed);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 2_000,
        idempotencyKey: "swap-1",
        adoptReservationId: otherReservation,
      }),
      CONFLICT,
      "C4.2"
    );
    expect(await snapshot(seed, v), "no root re-headed, no episode attached").toEqual(before);
    expect(await depositCount(seed), "and no second deposit").toBe(deposits);
  });

  test("C4.3 the same key that ADDS an adoption is a CONFLICT", async () => {
    // The dangerous direction. Without the adoption in the fingerprint the
    // second call is answered from the first's result, so an adoption the
    // authority would have had to rule on never reaches it at all.
    const seed = await seedDealer("c43");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    const elsewhere = await reservationOn(seed, await vehicle(seed));

    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 2_000,
      idempotencyKey: "add-1",
    });
    const before = await snapshot(seed, v);
    const deposits = await depositCount(seed);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 2_000,
        idempotencyKey: "add-1",
        adoptReservationId: elsewhere,
      }),
      CONFLICT,
      "C4.3"
    );
    expect(await snapshot(seed, v), "nothing on this car changed").toEqual(before);
    expect(await depositCount(seed), "and no second deposit").toBe(deposits);
  });

  test("C4.4 the same key that DROPS an adoption is a CONFLICT", async () => {
    const seed = await seedDealer("c44");
    const v = await vehicle(seed);
    const reservationId = await reservationOn(seed, v);
    const quoteId = await cashQuote(seed, seed.customerA, v);

    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 2_000,
      idempotencyKey: "drop-1",
      adoptReservationId: reservationId,
    });
    const before = await snapshot(seed, v);
    const deposits = await depositCount(seed);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 2_000,
        idempotencyKey: "drop-1",
      }),
      CONFLICT,
      "C4.4"
    );
    expect(await snapshot(seed, v), "nothing moved").toEqual(before);
    expect(await depositCount(seed), "and no second deposit").toBe(deposits);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE MULTI-VEHICLE NARROWING, LOAD-BEARING FROM BOTH SIDES
//
// A.11 proves a multi-vehicle deal presenting one adoption is not broken by it.
// These two prove the narrowing did not become a hole: an adoption admitted for
// the deal's OTHER cars still faces each car's own authority decision, and an
// invalid adoption still refuses a car nobody holds.
// ══════════════════════════════════════════════════════════════════════════════
describe("P1-S the multi-vehicle narrowing refuses what it must", () => {
  test("S.5 a legitimate adoption does not carry the deal onto a car ANOTHER deal holds", async () => {
    const seed = await seedDealer("s5");
    const carA = await vehicle(seed);
    const carB = await vehicle(seed);

    // A: this deal's own reservation, genuinely adoptable.
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: carA,
      customerId: seed.customerA,
      depositAmount: 1_000,
    });
    // B: somebody else's deal, already holding it.
    const rivalQuote = await cashQuote(seed, seed.customerB, carB);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 2_000,
    });

    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: carA,
      vehicleItems: [
        { vehicleId: carA, unitPrice: PRICE },
        { vehicleId: carB, unitPrice: PRICE },
      ],
      mode: "CASH" as const,
      vehiclePrice: PRICE * 2,
      downPayment: 0,
      termMonths: 0,
    });

    const beforeA = await snapshot(seed, carA);
    const beforeB = await snapshot(seed, carB);
    const deposits = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).length
    );

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 4_000,
        adoptReservationId: reservationId,
      }),
      HELD,
      "S.5"
    );

    // ⚠️ THE WHOLE OPERATION, NOT JUST CAR B. A refusal that had already
    // re-headed car A onto this quote would leave the deal half-converted.
    expect(await snapshot(seed, carA), "car A was not re-headed").toEqual(beforeA);
    expect(await snapshot(seed, carB), "car B's deal is untouched").toEqual(beforeB);
    expect(
      await seed.t.run(async (ctx) => (await ctx.db.query("deposits").collect()).length),
      "and no deposit was taken"
    ).toBe(deposits);
  });

  test("S.6 a FREE car refuses an invalid adoption — validation precedes opening", async () => {
    const seed = await seedDealer("s6");
    const free = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, free);

    // A reservation that no longer exists. Every other part of the request is
    // valid, so an authority that checked adoption only where it could JOIN
    // would have opened the root and ignored the claim entirely.
    const dangling = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: await vehicle(seed),
      customerId: seed.customerA,
    });
    await seed.t.run((ctx) => ctx.db.delete(dangling));

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 2_000,
        adoptReservationId: dangling,
      }),
      HELD,
      "S.6"
    );
    expect((await rootsOn(seed, free)).length, "no root was opened").toBe(0);
    expect((await claimsOn(seed, free)).length, "no episode was attached").toBe(0);
    expect(
      await seed.t.run(async (ctx) =>
        (await ctx.db.query("deposits").collect()).filter(
          (d) => String(d.vehicleId) === String(free)
        ).length
      ),
      "and no deposit was taken"
    ).toBe(0);

    // The matched positive: the identical call without the false claim works,
    // so the refusal above is the adoption and not the fixture.
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 2_000,
    });
    expect((await rootsOn(seed, free)).length, "the same deal opens it cleanly").toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C2E — A RESERVATION'S LIVENESS IS TIME-BASED, NOT STATUS-ONLY
//
// ⚠️ THE STORED STATUS IS A CACHE OF THE TRUTH, NOT THE TRUTH. `expiresAt` is
// the reservation's actual business lifetime; `status` only catches up when the
// 15-minute `expire-vehicle-reservations` cron next runs. So an expired
// reservation reads `ACTIVE` for a window — and the authority tested nothing but
// that status, which made an expired reservation adoptable and let it re-head a
// commitment root. Reproduced: `headQuoteId` undefined before the call, the
// quote after.
//
// The authority was the ONE place that believed the enum. Its neighbours never
// did: the duplicate-reservation guard admits only
// `expiresAt === undefined || expiresAt > now`, and the sweep's own query is
// `status === "ACTIVE" AND expiresAt <= now` — a written admission that ACTIVE
// rows can be expired. The sweep MATERIALISES the expiry; it does not grant
// extra life.
//
// Binding rule (owner c15657), and the boundary is deliberate:
//   live  ⇔  status === "ACTIVE" && (expiresAt === undefined || expiresAt > decisionNow)
// so `expiresAt === decisionNow` is EXPIRED, not live.
// ══════════════════════════════════════════════════════════════════════════════
describe("P1-C2E a reservation proof must still be LIVE, not merely ACTIVE", () => {
  /** A reservation row with an explicit lifetime, written directly. */
  async function reservationRow(
    seed: Seed,
    vehicleId: Id<"vehicles">,
    expiresAt: number | undefined,
    status: "ACTIVE" | "EXPIRED" = "ACTIVE"
  ) {
    return await seed.t.run((ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerA,
        status,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        reservedBy: seed.userId,
        reservedAt: Date.now() - 60_000,
      })
    );
  }

  // ── the predicate itself, where the BOUNDARY can be stated exactly ───────
  //
  // ⚠️ CALLED DIRECTLY, AND THIS IS THE REASON. `resolveActingRoot` reads its own
  // clock, so no fixture can make `expiresAt` exactly equal the decision instant
  // through a door. Pinning the comparison here is what kills a `>=` mutant;
  // the contracts below prove the same rule is REACHED in production.
  test("C2E.1 the liveness rule, at the exact boundary", () => {
    const T = 1_700_000_000_000;
    const row = (over: Record<string, unknown>) =>
      ({
        status: "ACTIVE",
        expiresAt: T + 1,
        ...over,
      }) as unknown as Parameters<typeof reservationIsLive>[0];

    expect(reservationIsLive(row({}), T), "expiry in the future is live").toBe(true);
    expect(
      reservationIsLive(row({ expiresAt: T }), T),
      "expiry EXACTLY at the decision instant is EXPIRED, not live"
    ).toBe(false);
    expect(reservationIsLive(row({ expiresAt: T - 1 }), T), "past expiry is expired").toBe(false);
    expect(
      reservationIsLive(row({ expiresAt: undefined }), T),
      "a legacy row with no expiry stays live while ACTIVE"
    ).toBe(true);
    expect(
      reservationIsLive(row({ status: "RELEASED" }), T),
      "and status still refuses on its own"
    ).toBe(false);
  });

  // ── the generic lineage proof ─────────────────────────────────
  test("C2E.2 a FREE car refuses an ACTIVE-but-EXPIRED reservation proof", async () => {
    const seed = await seedDealer("c2e2");
    const free = await vehicle(seed);
    const expired = await reservationRow(seed, free, Date.now() - 60_000);

    const decision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: free,
        lineage: { reservationId: expired },
        actingCustomerId: seed.customerA,
      })
    );
    expect(decision.decision, "an expired reservation proves nothing").toBe("REFUSE");
    expect((await rootsOn(seed, free)).length, "and opens no root").toBe(0);
    expect((await claimsOn(seed, free)).length, "and attaches no episode").toBe(0);
  });

  test("C2E.3 the matched POSITIVES — an unexpired one, and a legacy row with no expiry", async () => {
    // ⚠️ WITHOUT THESE, C2E.2 IS SATISFIED BY REFUSING EVERY RESERVATION.
    const seed = await seedDealer("c2e3");

    const liveCar = await vehicle(seed);
    const live = await reservationRow(seed, liveCar, Date.now() + 60 * 60 * 1000);
    const liveDecision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: liveCar,
        lineage: { reservationId: live },
        actingCustomerId: seed.customerA,
      })
    );
    expect(liveDecision.decision, "an unexpired reservation still opens the root").toBe("OPEN_NEW");

    const legacyCar = await vehicle(seed);
    const legacy = await reservationRow(seed, legacyCar, undefined);
    const legacyDecision = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: legacyCar,
        lineage: { reservationId: legacy },
        actingCustomerId: seed.customerA,
      })
    );
    expect(
      legacyDecision.decision,
      "and a row with no expiry at all is unchanged — no migration is invented here"
    ).toBe("OPEN_NEW");
  });

  // ── adoption ─────────────────────────────────────────────
  //
  // ⚠️ EVERY OTHER AXIS IS DELIBERATELY VALID: the quote is this org's, this
  // customer's, and covers this very car; the reservation IS the root's origin
  // and belongs to the same customer. Expiry is the only thing wrong, so no
  // earlier guard can be what refuses.
  async function adoptableButExpiring(seed: Seed) {
    const v = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      depositAmount: 1_000,
    });
    const quoteId = await cashQuote(seed, seed.customerA, v);
    return { v, reservationId, quoteId };
  }

  test("C2E.4 an ACTIVE-but-EXPIRED reservation cannot be ADOPTED, and re-heads nothing", async () => {
    const seed = await seedDealer("c2e4");
    const { v, reservationId, quoteId } = await adoptableButExpiring(seed);

    // The control first: while it is live, this exact call adopts. So the
    // refusal below is the expiry and nothing else about the fixture.
    const live = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { quoteId, adoptReservationId: reservationId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(live.decision, "control: the live reservation is adoptable").toBe("ADOPT_RESERVATION");

    await seed.t.run((ctx) => ctx.db.patch(reservationId, { expiresAt: Date.now() - 60_000 }));
    const still = await seed.t.run((ctx) => ctx.db.get(reservationId));
    expect(still?.status, "the sweep has NOT run — the row still reads ACTIVE").toBe("ACTIVE");

    const before = await snapshot(seed, v);
    const expired = await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: v,
        lineage: { quoteId, adoptReservationId: reservationId },
        actingCustomerId: seed.customerA,
      })
    );
    expect(expired.decision, "an expired reservation cannot continue a deal").toBe("REFUSE");
    expect(await snapshot(seed, v), "and the decision alone changed nothing").toEqual(before);
  });

  test("C2E.5 and the PUBLIC adoption door refuses it, leaving no residue", async () => {
    // The reachability contract. C2E.4 pins the rule at the authority; this
    // proves a real caller reaches it — `deposits.create` is the door that
    // accepts `adoptReservationId` from a client.
    const seed = await seedDealer("c2e5");
    const { v, reservationId, quoteId } = await adoptableButExpiring(seed);
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { expiresAt: Date.now() - 60_000 }));

    const before = await snapshot(seed, v);
    const depositsBefore = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).length
    );

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 2_000,
        adoptReservationId: reservationId,
      }),
      HELD,
      "C2E.5"
    );

    expect(await snapshot(seed, v), "no root re-headed, no episode attached").toEqual(before);
    expect(
      await seed.t.run(async (ctx) => (await ctx.db.query("deposits").collect()).length),
      "and no deposit was taken"
    ).toBe(depositsBefore);
  });

  test("C2E.6 the authority does NOT clean up — it only refuses", async () => {
    // ⚠️ THE AUTHORITY ANSWERS A QUESTION; THE SWEEP OWNS THE ROW. Patching
    // `status` here would put lifecycle mutation inside a decision function that
    // a query context may also call, and would race the cron that owns it.
    const seed = await seedDealer("c2e6");
    const free = await vehicle(seed);
    const expiresAt = Date.now() - 60_000;
    const expired = await reservationRow(seed, free, expiresAt);

    // ⚠️ THE BEFORE VALUE IS READ BACK, NOT ASSUMED. An earlier version asserted
    // only `toBeDefined()` under the words "its expiry is untouched" — which any
    // rewrite to another number, `0` included, would have satisfied. The claim
    // was stronger than the assertion; this is the assertion catching up.
    const before = await seed.t.run((ctx) => ctx.db.get(expired));
    expect(
      before?.expiresAt,
      "precondition: the row really carries the expiry we wrote, so the comparison below cannot pass undefined-to-undefined"
    ).toBe(expiresAt);

    await seed.t.run((ctx) =>
      resolveActingRoot(ctx, {
        orgId: seed.orgId,
        vehicleId: free,
        lineage: { reservationId: expired },
        actingCustomerId: seed.customerA,
      })
    );

    const after = await seed.t.run((ctx) => ctx.db.get(expired));
    expect(after?.status, "the row is left exactly as the sweep will find it").toBe("ACTIVE");
    expect(
      after?.expiresAt,
      "and its expiry is the EXACT value it had before — not merely still defined"
    ).toBe(before?.expiresAt);
  });

  // ── ONE CLOCK READING, PROVED BEHAVIOURALLY ──────────────────────────────
  //
  // ⚠️ THIS EXISTS BECAUSE I ARGUED IT COULDN'T. I disclosed a surviving mutant
  // — swapping the shared `decisionNow` inside `resolveAdoption` for its own
  // `Date.now()` — and claimed any test killing it would be written for the
  // mutant rather than for behaviour. Both reviewer seats disagreed, and they
  // were right: the property is not "how many times is the clock read", it is
  // A RESERVATION LIVE WHEN THE DECISION BEGAN STAYS LIVE FOR THAT DECISION.
  // That is the invariant the comment at `commitments.ts:292-296` claims, and
  // an authority that contradicts itself mid-call is a real defect, not a
  // stylistic one.
  test("C2E.7 the FIRST clock reading governs the WHOLE decision", async () => {
    const seed = await seedDealer("c2e7");
    const { v, reservationId, quoteId } = await adoptableButExpiring(seed);

    // Alive by exactly one millisecond at the decision instant. Any later
    // reading of the clock inside the decision sees it expired.
    const T = Date.now();
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { expiresAt: T + 1 }));

    const decision = await seed.t.run(async (ctx) => {
      // ⚠️ THE SPY IS INSTALLED HERE — INSIDE `t.run`, IMMEDIATELY BEFORE THE
      // CALL — AND THE PLACEMENT IS THE POINT. `mockReturnValueOnce` binds to
      // whichever `Date.now()` fires first, so installing it outside would
      // couple this test to the harness's setup reads: if `convex-test` read
      // the clock first it would consume `T`, the authority would start at
      // `T + 2`, and a CORRECT implementation would fail. Installed here, every
      // setup read has already happened, so the first reading is the
      // authority's own. The test is then coupled to the invariant, not to
      // call order.
      const spy = vi.spyOn(Date, "now");
      spy.mockReturnValueOnce(T).mockReturnValue(T + 2);
      try {
        return await resolveActingRoot(ctx, {
          orgId: seed.orgId,
          vehicleId: v,
          lineage: { quoteId, adoptReservationId: reservationId },
          actingCustomerId: seed.customerA,
        });
      } finally {
        spy.mockRestore();
      }
    });

    // Shared reading: the decision weighs the reservation at T, where T + 1 is
    // still ahead, and adopts. A second reading inside the adoption door would
    // see T + 2, call the same reservation expired, and REFUSE — the authority
    // disagreeing with itself about one row inside one call.
    expect(
      decision.decision,
      "a reservation live when the decision began must stay live for that whole decision"
    ).toBe("ADOPT_RESERVATION");
  });
});
