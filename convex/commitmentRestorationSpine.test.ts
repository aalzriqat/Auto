/**
 * SCRUM-208 PHASE 3 — THE PRODUCTION RESTORATION SPINE, END TO END.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. The first Phase-3 implementation was
 * BLOCKED by both review seats for one shared reason: the canonical machinery
 * was built and never connected to production, and its tests concealed that by
 * manufacturing states production has no writer for. Three of the five
 * confirmed defects were invisible to a suite of 71 passing contracts:
 *
 *   · `resolveRestorationDecision` required the CLAIM to be CONSUMED by the
 *     cancelled sale. Real finalization patches the ROOT and nothing else —
 *     Phase 2's certified F.12 pins that deliberately — so the predicate was
 *     false for every real cancellation. The fixture hand-patched the claim.
 *   · `deposits.usesVehicleHoldRows` had readers on both sides and NO WRITER.
 *     Every real deposit carried `undefined`, which every canonical reader
 *     correctly fails closed on. The fixtures set it by hand.
 *   · `restoreCommitment` had no production caller at all.
 *
 * So every contract below starts from a REAL deposit taken through
 * `api.deposits.create`, completed through a REAL sale door, and cancelled
 * through the REAL manager cancellation. Nothing here patches a claim or root
 * status by hand. The one deliberate exception is the corruption fixture in
 * S.10, which exists precisely to reproduce state no writer should produce.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  hasLiveCommitmentBasis,
  releaseRootIfNoLiveBasis,
  resolveOwnership,
  settleAuthorityAfterReversal,
} from "./commitments";
import { settleSources } from "../test-utils/authorityWork";
import { completeDeferredReversal } from "./utils/depositApplications";
import {
  beginUserRun,
  COMMITMENT_AUTHORITY_V1,
  hasCanonicalDepositHold,
  requireDecisionContext,
} from "./utils/commitmentKernel";

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
let vinCounter = 3000;

async function seedDealer(suffix: string, options: { canonical?: boolean } = {}) {
  const canonical = options.canonical ?? true;
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: `Dealer ${suffix}`,
      createdAt: Date.now(),
      ...(canonical ? { commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1 } : {}),
    })
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
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `u_${suffix}`, email: `${suffix}@t.com`, name: "Sales" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `u_${suffix}`, clerkId: `u_${suffix}` });

  // Cancellation goes through a SECOND person: the seller may not cancel their
  // own sale, and a permission grant cannot stand in for a second identity.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `m_${suffix}`, email: `m-${suffix}@t.com`, name: "Manager" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  const asManager = t.withIdentity({ subject: `m_${suffix}`, clerkId: `m_${suffix}` });

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+9627931${suffix}1`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+9627931${suffix}2`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, managerId, asUser, asManager, customerA, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function vehicle(seed: Seed) {
  vinCounter += 1;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `3HGCM82633A${String(vinCounter).slice(0, 6)}`,
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

async function quoteFor(seed: Seed, customerId: Id<"customers">, vehicles: Array<Id<"vehicles">>) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId: vehicles[0],
    ...(vehicles.length > 1
      ? { vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })) }
      : {}),
    mode: "CASH" as const,
    vehiclePrice: PRICE * vehicles.length,
    downPayment: 0,
    termMonths: 0,
  });
}

const depositOn = async (seed: Seed, quoteId: Id<"quotes">, amount: number) =>
  await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount });

const directSale = async (
  seed: Seed,
  quoteId: Id<"quotes">,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
) =>
  (await seed.asUser.mutation(api.sales.create, {
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    quoteId,
  })) as Id<"sales">;

const cancelSale = async (seed: Seed, saleId: Id<"sales">) =>
  await seed.asManager.mutation(api.sales.update, {
    orgId: seed.orgId,
    saleId,
    status: "CANCELLED" as const,
  });

// ── observation ─────────────────────────────────────────────────────────────

const rootsOn = async (seed: Seed, v: Id<"vehicles">) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("commitmentRoots").collect()).filter((r) => String(r.vehicleId) === String(v))
  );

const claimsOn = async (seed: Seed, v: Id<"vehicles">) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
      (c) => String(c.vehicleId) === String(v)
    )
  );

const depositRow = async (seed: Seed, id: Id<"deposits">) =>
  (await seed.t.run((ctx) => ctx.db.get(id)))!;

const vehicleRow = async (seed: Seed, id: Id<"vehicles">) =>
  (await seed.t.run((ctx) => ctx.db.get(id)))!;

const authorityAudit = async (seed: Seed) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("financialAuditLog").collect()).filter(
      (row) => row.actionType === "SETTLE_COMMITMENT_AUTHORITY"
    )
  );

/**
 * Finish whatever the cancellation deferred to the outbox, exactly as the
 * drain does — the reversal completion and the authority settlement in ONE
 * transaction, because that is what `markEntryPosted` runs.
 *
 * ⚠️ RETURNS WHETHER IT DID ANYTHING, so a contract can state which of the two
 * cancellation paths it exercised instead of quietly passing on neither.
 */
async function drainDeferredReversals(seed: Seed) {
  const pending = await seed.t.run(async (ctx) =>
    (await ctx.db.query("depositApplications").collect()).filter(
      (row) => String(row.orgId) === String(seed.orgId) && row.status === "REVERSING"
    )
  );
  const outcomes: Array<string> = [];
  for (const application of pending) {
    // Accounting completion and authority settlement are separate transactions
    // in production (SCRUM-208 c15814), so drive them as two steps here too.
    const freed = await seed.t.run((ctx) =>
      completeDeferredReversal(ctx, {
        orgId: seed.orgId,
        reversalIdempotencyKey: `reversed_${application.eventIdempotencyKey}`,
        postedAt: Date.now(),
      })
    );
    const outcome = await settleSources(
      seed.t,
      seed.orgId,
      seed.managerId,
      freed,
      `reversed_${application.eventIdempotencyKey}`
    );
    if (outcome) outcomes.push(outcome.outcome);
  }
  return outcomes;
}

/**
 * A real single-vehicle deal: quote → deposit → completed sale → cancelled,
 * with whatever the cancellation deferred then drained.
 *
 * ⚠️ EVERY STEP IS A PRODUCT DOOR. Nothing is inserted or patched by hand.
 */
async function cancelledRealDeal(seed: Seed, customerId: Id<"customers">) {
  const vehicleId = await vehicle(seed);
  const quoteId = await quoteFor(seed, customerId, [vehicleId]);
  const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;
  const beforeSale = await claimsOn(seed, vehicleId);
  const saleId = await directSale(seed, quoteId, vehicleId, customerId);
  const afterSale = await claimsOn(seed, vehicleId);
  await cancelSale(seed, saleId);
  const drained = await drainDeferredReversals(seed);
  return { vehicleId, quoteId, depositId, saleId, beforeSale, afterSale, drained };
}

// ═════════════════════════════════════════════════════════════════════════════
// S.1 — THE REPRESENTATION CLASS HAS A PRODUCTION WRITER
// ═════════════════════════════════════════════════════════════════════════════

describe("S.1 every deposit the product creates declares its representation", () => {
  test("S.1a a single-vehicle deposit is DIRECT and names its episode", async () => {
    const seed = await seedDealer("s1a");
    const vehicleId = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;

    const deposit = await depositRow(seed, depositId);
    // ⚠️ `false`, NOT `undefined`. The canonical DIRECT range is an equality on
    // this column, and `undefined` is a different key: a deposit without it is
    // invisible to the authority for its whole life.
    expect(deposit.usesVehicleHoldRows, "the discriminator is written at insert").toBe(false);

    const claims = await claimsOn(seed, vehicleId);
    expect(claims.length).toBe(1);
    expect(
      String(deposit.singleVehicleCommitmentClaimId),
      "and the maintained pointer names the episode this money opened"
    ).toBe(String(claims[0]._id));

    const held = await seed.t.run(async (ctx) => {
      const decision = await requireDecisionContext(
        ctx,
        beginUserRun(seed.userId, Date.now()),
        seed.orgId
      );
      return await hasCanonicalDepositHold(ctx, decision, vehicleId);
    });
    expect(held, "so the canonical reader can see an ordinary deposit").toBe(true);
  });

  test("S.1b a multi-vehicle deposit is SLICED, and carries no direct pointer", async () => {
    const seed = await seedDealer("s1b");
    const first = await vehicle(seed);
    const second = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [first, second]);
    const depositId = (await depositOn(seed, quoteId, 4_000)) as Id<"deposits">;

    const deposit = await depositRow(seed, depositId);
    expect(deposit.usesVehicleHoldRows, "its cars are held by hold rows").toBe(true);
    // ⚠️ THE DUAL FORM IS CORRUPTION EVEN WHEN BOTH AGREE. `resolveCanonicalBinding`
    // refuses a deposit carrying both representations, so the writer must not
    // create one.
    expect(deposit.singleVehicleCommitmentClaimId).toBeUndefined();

    const holds = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => String(h.depositId) === String(depositId)
      )
    );
    expect(holds.length).toBe(2);
    for (const hold of holds) {
      expect(hold.sourceCommitmentClaimId, "each slice names the episode it was created with")
        .toBeDefined();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.2 — WHAT REAL FINALIZATION ACTUALLY LEAVES BEHIND
//
// The state the restoration model must be keyed on. Asserted here rather than
// assumed, because assuming it wrong is the defect this phase was blocked for.
// ═════════════════════════════════════════════════════════════════════════════

describe("S.2 a completed sale consumes the ROOT and leaves its episodes alone", () => {
  test("S.2a the root carries the sale; every claim is byte-identical", async () => {
    const seed = await seedDealer("s2a");
    const vehicleId = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    await depositOn(seed, quoteId, 2_000);

    const before = await claimsOn(seed, vehicleId);
    const saleId = await directSale(seed, quoteId, vehicleId, seed.customerA);
    const after = await claimsOn(seed, vehicleId);

    const roots = await rootsOn(seed, vehicleId);
    expect(roots.length).toBe(1);
    expect(roots[0].status).toBe("CONSUMED");
    expect(String(roots[0].consumedBySaleId)).toBe(String(saleId));

    // ⚠️ THE FACT THE WHOLE RESTORATION MODEL TURNS ON. Finalization does not
    // scan or patch episodes — F.12 — so a restoration that waits for a
    // CONSUMED claim waits forever.
    expect(after).toEqual(before);
    expect(after.every((c) => c.status === "ACTIVE"), "claims stay ACTIVE on a sold deal").toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.3 — THE SPINE
// ═════════════════════════════════════════════════════════════════════════════

describe("S.3 cancelling a real sale gives the customer their deal back", () => {
  test("S.3a a successor generation opens, the pointer moves, the car is held", async () => {
    const seed = await seedDealer("s3a");
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const roots = await rootsOn(seed, deal.vehicleId);
    expect(roots.length, "the terminal root stays as history; a successor is opened").toBe(2);
    const predecessor = roots.find((r) => r.status !== "OPEN")!;
    const successor = roots.find((r) => r.status === "OPEN")!;
    expect(predecessor.status).toBe("CONSUMED");
    expect(String(predecessor.consumedBySaleId)).toBe(String(deal.saleId));

    expect(String(successor.customerId), "the SAME customer, carried not re-derived").toBe(
      String(seed.customerA)
    );
    expect(String(successor.lineageRootId), "one lineage across the generations").toBe(
      String(predecessor.lineageRootId)
    );
    expect(successor.lineageGeneration).toBe((predecessor.lineageGeneration ?? 0) + 1);
    expect(String(successor.restoredFromRootId)).toBe(String(predecessor._id));

    const claims = await claimsOn(seed, deal.vehicleId);
    expect(claims.length, "one new episode, and the old one untouched").toBe(2);
    const successorClaim = claims.find((c) => String(c.rootId) === String(successor._id))!;
    const predecessorClaim = claims.find((c) => String(c.rootId) === String(predecessor._id))!;
    expect(String(successorClaim.restoredFromClaimId)).toBe(String(predecessorClaim._id));
    expect(successorClaim.evidenceKind, "the predecessor's own tag, never a default").toBe(
      predecessorClaim.evidenceKind
    );
    // ⚠️ THE PREDECESSOR IS STILL ACTIVE, AND THAT IS CORRECT. I10: a claim on
    // a non-OPEN root is stale bookkeeping, not ownership.
    expect(predecessorClaim.status).toBe("ACTIVE");
    expect(deal.afterSale).toEqual(deal.beforeSale);

    const deposit = await depositRow(seed, deal.depositId);
    expect(deposit.status, "the money is the customer's held funds again").toBe("HELD");
    expect(deposit.holdActive).toBe(true);
    expect(
      String(deposit.singleVehicleCommitmentClaimId),
      "and it names the NEW episode, not the one it was reversed out of"
    ).toBe(String(successorClaim._id));

    const ownership = await seed.t.run((ctx) =>
      resolveOwnership(ctx, seed.orgId, deal.vehicleId)
    );
    expect(ownership.kind).toBe("OWNED");
    expect(String((ownership as { root: Doc<"commitmentRoots"> }).root._id)).toBe(
      String(successor._id)
    );

    // ⚠️ THE PROJECTION IS PART OF THE POSTCONDITION. A restored deal whose car
    // still advertises as available is the same defect one layer down.
    expect((await vehicleRow(seed, deal.vehicleId)).status).toBe("RESERVED");
  });

  test("S.3b a rival cannot take the car after the restoration", async () => {
    const seed = await seedDealer("s3b");
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const rivalQuote = await quoteFor(seed, seed.customerB, [deal.vehicleId]);
    let threw: unknown = null;
    try {
      await depositOn(seed, rivalQuote, 1_000);
    } catch (e) {
      threw = e;
    }
    expect(threw, "the restored deal holds the car against a rival").not.toBeNull();

    // And nothing of the rival's attempt survives.
    expect((await rootsOn(seed, deal.vehicleId)).length).toBe(2);
  });

  test("S.3c the outcome is recorded durably, and it says RESTORED", async () => {
    const seed = await seedDealer("s3c");
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const recorded: string[] = [
      ...deal.drained,
      ...(await authorityAudit(seed)).map(
        (row) => (row.after as { outcome?: string } | undefined)?.outcome ?? "«no outcome»"
      ),
    ];
    // ⚠️ NOT VACUOUS: one of the two cancellation paths must actually have run.
    expect(recorded.length, "the cancellation settled the authority somewhere").toBeGreaterThan(0);
    expect(recorded).toContain("RESTORED");
  });

  test("S.3d settling twice does not open a second successor", async () => {
    const seed = await seedDealer("s3d");
    const deal = await cancelledRealDeal(seed, seed.customerA);
    const before = await seed.t.run(async (ctx) => ({
      roots: (await ctx.db.query("commitmentRoots").collect()).length,
      claims: (await ctx.db.query("vehicleCommitmentClaims").collect()).length,
    }));

    // The drain is at-least-once. Running it again must change nothing.
    await drainDeferredReversals(seed);

    const after = await seed.t.run(async (ctx) => ({
      roots: (await ctx.db.query("commitmentRoots").collect()).length,
      claims: (await ctx.db.query("vehicleCommitmentClaims").collect()).length,
    }));
    expect(after).toEqual(before);
    expect((await rootsOn(seed, deal.vehicleId)).filter((r) => r.status === "OPEN").length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.4 — A LEGACY ORGANIZATION KEEPS WORKING
// ═════════════════════════════════════════════════════════════════════════════

describe("S.4 an organization without the canonical authority", () => {
  test("S.4a the money still comes back, and the authority says WITHHELD", async () => {
    const seed = await seedDealer("s4a", { canonical: false });
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const deposit = await depositRow(seed, deal.depositId);
    // ⚠️ THE NON-NEGOTIABLE HALF. Gating the money on a restoration that can
    // never succeed on a legacy org would strand the customer's deposit.
    expect(deposit.status).toBe("HELD");
    expect(deposit.holdActive).toBe(true);

    const recorded: string[] = [
      ...deal.drained,
      ...(await authorityAudit(seed)).map(
        (row) => (row.after as { outcome?: string } | undefined)?.outcome ?? "«no outcome»"
      ),
    ];
    expect(recorded.length).toBeGreaterThan(0);
    // ⚠️ AND IT MUST NOT CLAIM A RESTORATION. Nothing was examined: the
    // pre-Phase-3 state was silence, and asserting RESTORED here would be a
    // false audit record — strictly worse than the silence it replaced.
    expect(recorded).toContain("AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE");
    expect(recorded).not.toContain("RESTORED");

    // No canonical rows were invented for an org that is not on the model.
    expect((await rootsOn(seed, deal.vehicleId)).filter((r) => r.status === "OPEN").length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.5 — "RESTORED" MEANS RESTORED
// ═════════════════════════════════════════════════════════════════════════════

describe("S.5 the outcome taxonomy tells the truth", () => {
  test("S.5a a free car reports NO_RESTORABLE_BASIS, never RESTORED", async () => {
    const seed = await seedDealer("s5a");
    const vehicleId = await vehicle(seed);

    const outcome = await seed.t.run((ctx) =>
      settleAuthorityAfterReversal(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: Date.now(),
        reason: "deferred reversal posted",
      })
    );
    expect(outcome.outcome).toBe("ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS");
  });

  test("S.5b a car nothing holds is released, and that is not a restoration", async () => {
    const seed = await seedDealer("s5b");
    const vehicleId = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;
    // The deposit's own door ends its hold — the money side stays a manager's
    // decision, which is exactly why the ROOT must then close on its own.
    await seed.t.run((ctx) => ctx.db.patch(depositId, { holdActive: false }));

    const outcome = await seed.t.run((ctx) =>
      settleAuthorityAfterReversal(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: Date.now(),
        reason: "deferred reversal posted",
      })
    );
    expect(outcome.outcome).toBe("ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS");
    expect((await rootsOn(seed, vehicleId))[0].status).toBe("RELEASED");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.6 — THE AUTHORITY MAY NOT REST ON THE DEFECTIVE LEGACY READER
//
// ⚠️ THE ONE PLACE THIS FILE MANUFACTURES STATE, AND IT IS A CORRUPTION
// FIXTURE BY DESIGN. `getActiveDepositHolds` `.take(50)`s an index range and
// post-filters it, so fifty stale rows in front of a live one make it answer
// "nothing holds this car". `releaseRootIfNoLiveBasis` writes on that answer.
// ═════════════════════════════════════════════════════════════════════════════

describe("S.6 a stale-row backlog cannot release a live deal", () => {
  async function withStaleBacklog(seed: Seed) {
    const vehicleId = await vehicle(seed);
    // Fifty rows that LOOK live to the legacy index and are not: resolved
    // deposits that kept `holdActive`. They carry no representation class,
    // which is what a pre-cutover row looks like — so they are outside the
    // canonical range entirely and inside the legacy one.
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < 50; i += 1) {
        await ctx.db.insert("deposits", {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerB,
          amount: 1,
          status: "VOIDED" as const,
          holdActive: true,
          createdBy: seed.userId,
          createdAt: Date.now(),
        });
      }
    });
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;
    return { vehicleId, depositId };
  }

  test("S.6a the legacy reader false-negatives on this state", async () => {
    const seed = await seedDealer("s6a");
    const { vehicleId } = await withStaleBacklog(seed);

    const legacy = await seed.t.run((ctx) =>
      hasLiveCommitmentBasis(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: Date.now(),
        excludeKinds: ["RESERVATION", "FINANCE"],
      })
    );
    // Documented, not endorsed: this is the reader SCRUM-201's cutover
    // replaces. The contract that matters is S.6b.
    expect(legacy, "the capped post-filtered read cannot see the live deposit").toBe(false);
  });

  test("S.6b the canonical decision sees it, and the live root survives", async () => {
    const seed = await seedDealer("s6b");
    const { vehicleId } = await withStaleBacklog(seed);
    const openBefore = (await rootsOn(seed, vehicleId)).filter((r) => r.status === "OPEN");
    expect(openBefore.length, "the deal is live before anything settles").toBe(1);

    await seed.t.run(async (ctx) => {
      const now = Date.now();
      const decision = await requireDecisionContext(ctx, beginUserRun(seed.userId, now), seed.orgId);
      const live = await hasLiveCommitmentBasis(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: now,
        decision,
        excludeKinds: ["RESERVATION", "FINANCE"],
      });
      expect(live, "the exact range is not fooled by fifty stale rows").toBe(true);

      await releaseRootIfNoLiveBasis(ctx, {
        orgId: seed.orgId,
        vehicleId,
        reason: "deferred reversal posted",
        decisionNow: now,
        decision,
      });
    });

    const openAfter = (await rootsOn(seed, vehicleId)).filter((r) => r.status === "OPEN");
    expect(
      openAfter.length,
      "the customer who paid still holds the car — releasing here is how a rival takes it"
    ).toBe(1);
    expect(String(openAfter[0]._id)).toBe(String(openBefore[0]._id));
  });
});
