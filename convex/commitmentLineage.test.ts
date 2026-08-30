/**
 * SCRUM-208 PHASE 3 — LINEAGE, SUCCESSION AND RESTORATION.
 *
 * A root is terminal FOREVER once CONSUMED or RELEASED, so a restoration
 * cannot revive one: it opens the next generation of the same lineage.
 *
 * ⚠️ THESE GO THROUGH THE RESTORATION DOOR, NOT A ROOT-WRITING HELPER. An
 * earlier version of this suite tested an exported `openSuccessorRoot`, which
 * proved the wrong thing twice over: it exercised a second root-creation path
 * that should not exist, and a helper that can open a root outside the
 * acquisition boundary can commit an OPEN successor with no claim attached.
 * The pure decision resolver is tested directly because it writes nothing;
 * everything that writes is exercised through `restoreCommitment`.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Doc, Id } from "./_generated/dataModel";
import {
  acquireVehicle,
  consumeRootForSale,
  resolveRestorationDecision,
  restoreCommitment,
  settleAuthorityAfterReversal,
} from "./commitments";
import { AUTHORITY_SEVERITY, settleFreedHoldsAuthority } from "./accountingOutbox";
import {
  AuthorityDecisionContext,
  beginUserRun,
  COMMITMENT_AUTHORITY_V1,
  requireDecisionContext,
  resolveLineageTip,
} from "./utils/commitmentKernel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

let vinCounter = 0;

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
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `user_${suffix}`,
      email: `${suffix}@test.com`,
      name: "Sales User",
    })
  );
  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+9627911${suffix}1`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+9627911${suffix}2`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, customerA, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function vehicle(seed: Seed) {
  vinCounter += 1;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `1HGCM82633A${String(100000 + vinCounter).slice(0, 6)}`,
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Red",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 100,
      sellingPrice: 30_000,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

async function reservation(seed: Seed, vehicleId: Id<"vehicles">, customerId: Id<"customers">) {
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicleReservations", {
      orgId: seed.orgId,
      vehicleId,
      customerId,
      status: "ACTIVE" as const,
      reservedBy: seed.userId,
      reservedAt: Date.now(),
    })
  );
}

async function sale(seed: Seed, vehicleId: Id<"vehicles">, customerId: Id<"customers">) {
  return await seed.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: seed.orgId,
      vehicleId,
      customerId,
      salespersonId: seed.userId,
      salePrice: 30_000,
      saleDate: Date.now(),
      status: "CANCELLED" as const,
    })
  );
}

async function decisionFor(seed: Seed, ctx: any): Promise<AuthorityDecisionContext> {
  return await requireDecisionContext(ctx, beginUserRun(seed.userId, Date.now()), seed.orgId);
}

/** Acquire through the real door and return both rows. */
async function acquire(seed: Seed, vehicleId: Id<"vehicles">, customerId: Id<"customers">) {
  const reservationId = await reservation(seed, vehicleId, customerId);
  const { rootId, claimId } = await seed.t.run((ctx) =>
    acquireVehicle(ctx, {
      orgId: seed.orgId,
      vehicleId,
      customerId,
      createdBy: seed.userId,
      evidence: { kind: "RESERVATION", reservationId },
      lineage: { reservationId },
    })
  );
  return { reservationId, rootId, claimId };
}

/**
 * The exact source a business operation names.
 *
 * ⚠️ THERE IS NO SECOND IDENTITY TO SUPPLY. The episode, root, lineage,
 * principal and defining evidence are all read from the database by walking
 * this one reference, so a test cannot compose a mismatched pair — which is
 * the structural point of the change.
 */
const sourceOf = (reservationId: Id<"vehicleReservations">) =>
  ({ kind: "RESERVATION", reservationId }) as const;

/**
 * A deal that completed into a sale, then had that sale cancelled.
 *
 * ⚠️ THE TERMINALIZATION IS THE REAL WRITER, AND IT TOUCHES ONLY THE ROOT.
 * This used to hand-patch the root AND the claim into CONSUMED — a shape
 * production has no writer for. Phase 2's certified F.12 pins the opposite:
 * finalization "neither scans nor patches" the episodes, so a completed deal
 * leaves every claim ACTIVE. Manufacturing the claim status made the whole
 * suite agree with a resolver that could never have fired on real data, which
 * is exactly how a restoration model with zero reachable paths passed 71
 * contracts (SCRUM-208 c15807/c15808).
 */
async function consumedByCancelledSale(seed: Seed, customerId: Id<"customers">) {
  const vehicleId = await vehicle(seed);
  const { reservationId, rootId, claimId } = await acquire(seed, vehicleId, customerId);
  const saleId = await sale(seed, vehicleId, customerId);
  await seed.t.run((ctx) =>
    consumeRootForSale(ctx, {
      orgId: seed.orgId,
      vehicleId,
      saleId,
      reason: "sale completed",
      decisionNow: Date.now(),
    })
  );
  const root = (await seed.t.run((ctx) => ctx.db.get(rootId)))!;
  return { vehicleId, reservationId, rootId, claimId, saleId, root };
}

function restoreArgs(
  seed: Seed,
  fixture: { reservationId: Id<"vehicleReservations">; vehicleId: Id<"vehicles"> }
) {
  void fixture.reservationId;
  void fixture.vehicleId;
  // ⚠️ NO `lineage`. Root identity is copied from the predecessor and the new
  // episode's quote is carried from the episode being continued, so there is
  // nothing about the deal left for a caller to supply — and therefore nothing
  // for a caller to get wrong.
  return { createdBy: seed.userId };
}

describe("L9 — a canonical root commits as its own lineage origin", () => {
  test("lineageRootId points at itself and the generation is 0", async () => {
    const seed = await seedDealer("l9");
    const vehicleId = await vehicle(seed);
    const { rootId } = await acquire(seed, vehicleId, seed.customerA);

    const root = await seed.t.run((ctx) => ctx.db.get(rootId));
    // ⚠️ Not "absent, and a reader normalizes it to self". Absent is the
    // LEGACY signal and has to keep meaning that.
    expect(String(root?.lineageRootId)).toBe(String(rootId));
    expect(root?.lineageGeneration).toBe(0);
  });
});

describe("restoration through the acquisition boundary", () => {
  test("cancelling the exact sale opens a successor WITH its claim attached", async () => {
    const seed = await seedDealer("r1");
    const f = await consumedByCancelledSale(seed, seed.customerA);

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );

    expect(outcome.decision).toBe("RESTORED");
    const restored = outcome as Extract<typeof outcome, { decision: "RESTORED" }>;
    expect(restored.opened).toBe("SUCCESSOR");

    const successor = await seed.t.run((ctx) => ctx.db.get(restored.rootId));
    expect(String(successor?.lineageRootId)).toBe(String(f.root.lineageRootId));
    expect(successor?.lineageGeneration).toBe(1);
    expect(String(successor?.restoredFromRootId)).toBe(String(f.rootId));
    // The principal is CARRIED from the predecessor, never from the caller.
    expect(String(successor?.customerId)).toBe(String(seed.customerA));

    // ⚠️ THE POINT OF ROUTING THROUGH acquireVehicle: the successor cannot
    // exist without its episode. The forbidden intermediate state — an OPEN
    // successor with no claim — is unreachable, not merely discouraged.
    const claims = await seed.t.run((ctx) =>
      ctx.db
        .query("vehicleCommitmentClaims")
        .withIndex("by_root_status", (q) => q.eq("rootId", restored.rootId))
        .collect()
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe("ACTIVE");
    expect(String(claims[0].restoredFromClaimId)).toBe(String(f.claimId));
  });

  test("a source naming no episode can never be a restoration", async () => {
    const seed = await seedDealer("r2");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // A source with no maintained pointer: either it predates the canonical
    // model or it was written incompletely. Accepting it would open a root
    // with no provenance back to what was reversed.
    await seed.t.run((ctx) =>
      ctx.db.patch(f.reservationId, { currentCommitmentClaimId: undefined })
    );

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );
    expect(outcome).toEqual({
      decision: "REFUSE",
      reason: "that record does not name a current commitment episode",
    });
  });

  test("a DIFFERENT sale does not entitle a restoration of this deal", async () => {
    const seed = await seedDealer("r3");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // Some other cancelled sale in the same dealership.
    const unrelated = await sale(seed, f.vehicleId, seed.customerA);

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: unrelated },
        ...restoreArgs(seed, f),
      })
    );

    expect(outcome).toEqual({
      decision: "REFUSE",
      reason: "that sale is not the one this deal was completed into",
    });
  });

  test("a source belonging to a different customer than its deal is refused", async () => {
    const seed = await seedDealer("r4");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // The reservation is genuine and names a genuine episode; it simply
    // belongs to somebody else than the deal that episode sits on.
    await seed.t.run((ctx) => ctx.db.patch(f.reservationId, { customerId: seed.customerB }));

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );
    expect(outcome).toEqual({
      decision: "REFUSE",
      reason: "that record belongs to a different customer than the deal it names",
    });
  });

  test("a rival holding the car is refused, and NOTHING is written", async () => {
    const seed = await seedDealer("r5");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // A different deal legitimately takes the car after the first one ended.
    const rival = await acquire(seed, f.vehicleId, seed.customerB);

    const before = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );

    expect(outcome).toEqual({ decision: "RIVAL", rivalRootId: rival.rootId });

    // ⚠️ THE RIVAL KEEPS THE CAR. The accounting reversal stands; the vehicle
    // does not move. A second OPEN root is one car promised to two deals.
    const after = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    expect(after).toHaveLength(before.length);
  });

  test("an ACTIVE episode has nothing to restore — no second claim, nothing touched", async () => {
    const seed = await seedDealer("r6");
    const vehicleId = await vehicle(seed);
    const { reservationId, rootId, claimId } = await acquire(seed, vehicleId, seed.customerA);
    void rootId;
    void claimId;

    const rootsBefore = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const claimsBefore = await seed.t.run((ctx) =>
      ctx.db.query("vehicleCommitmentClaims").collect()
    );

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(reservationId),
        vehicleId,
        intent: { kind: "SOURCE_EPISODE_REINSTATED" },
        ...restoreArgs(seed, { reservationId, vehicleId }),
      })
    );

    // ⚠️ NOT "ALREADY_LIVE". An episode that was never terminalized has
    // nothing to reinstate, and answering a restoration request with success
    // would let claim status stand in for liveness — the exact thing
    // commitments.ts says claim status may never do.
    expect(outcome).toEqual({
      decision: "REFUSE",
      reason: "that evidence is still live and has nothing to restore",
    });

    // ⚠️ CARDINALITY, NOT JUST ROOT COUNT. An earlier version returned
    // JOIN_LINEAGE here and then dropped the predecessor because the claim was
    // ACTIVE, inserting a SECOND ACTIVE claim for the same evidence on the
    // same car. The test at the time only counted roots, so it certified the
    // duplicate.
    const rootsAfter = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const claimsAfter = await seed.t.run((ctx) =>
      ctx.db.query("vehicleCommitmentClaims").collect()
    );
    expect(rootsAfter).toHaveLength(rootsBefore.length);
    expect(claimsAfter).toHaveLength(claimsBefore.length);
    expect(claimsAfter).toEqual(claimsBefore);
  });

  test("attaching and repointing while the source stays dead rolls everything back", async () => {
    const seed = await seedDealer("r10");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // The reservation itself has ended. Restoration would otherwise open a
    // successor and repoint onto it, leaving an OPEN root that nothing holds.
    await seed.t.run((ctx) => ctx.db.patch(f.reservationId, { status: "RELEASED" as const }));

    const rootsBefore = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const claimsBefore = await seed.t.run((ctx) =>
      ctx.db.query("vehicleCommitmentClaims").collect()
    );

    // ⚠️ ALL FOUR OR NONE. One Convex mutation is one transaction, so throwing
    // in the postcondition un-does the attachment and the repoint together.
    await expect(
      seed.t.run(async (ctx) =>
        restoreCommitment(ctx, {
          decision: await decisionFor(seed, ctx),
          source: sourceOf(f.reservationId),
          vehicleId: f.vehicleId,
          intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
          ...restoreArgs(seed, f),
        })
      )
    ).rejects.toThrow(/did not settle consistently/);

    expect(await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect())).toEqual(
      rootsBefore
    );
    expect(await seed.t.run((ctx) => ctx.db.query("vehicleCommitmentClaims").collect())).toEqual(
      claimsBefore
    );
    const reservation = await seed.t.run((ctx) => ctx.db.get(f.reservationId));
    expect(String(reservation?.currentCommitmentClaimId)).toBe(String(f.claimId));
  });

  test("a legacy predecessor fails closed instead of being normalized", async () => {
    const seed = await seedDealer("r7");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // A deal that predates the canonical model: no lineage identity at all.
    // It is never normalized to "its own origin at generation 0", which would
    // manufacture a second origin in a lineage that already has one.
    await seed.t.run((ctx) =>
      ctx.db.patch(f.rootId, { lineageRootId: undefined, lineageGeneration: undefined })
    );

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );

    expect(outcome.decision).toBe("REFUSE");
  });

  test("a legacy organization cannot reach the canonical path at all", async () => {
    const seed = await seedDealer("r8", { canonical: false });
    const f = await consumedByCancelledSale(seed, seed.customerA);

    await expect(
      seed.t.run(async (ctx) =>
        restoreCommitment(ctx, {
          decision: await decisionFor(seed, ctx),
          source: sourceOf(f.reservationId),
          vehicleId: f.vehicleId,
          intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
          ...restoreArgs(seed, f),
        })
      )
    ).rejects.toThrow(/canonical commitment authority/);
  });

  test("a deal already continued cannot be continued again", async () => {
    const seed = await seedDealer("r9");
    const f = await consumedByCancelledSale(seed, seed.customerA);

    const first = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );
    expect(first.decision).toBe("RESTORED");
    // Terminalize the successor so the second attempt is judged on the tip
    // rule rather than on the car still being held.
    await seed.t.run((ctx) =>
      ctx.db.patch((first as { rootId: Id<"commitmentRoots"> }).rootId, {
        status: "RELEASED" as const,
      })
    );

    // ⚠️ AN ACTIVE CLAIM ON A TERMINAL ROOT IS NOT LIVE. Claims stay ACTIVE
    // forever, including on a released or consumed root, so the successor
    // being ACTIVE proves nothing on its own. An earlier version returned
    // ALREADY_LIVE from exactly this state — an ACTIVE claim whose root had
    // been released — which is claim status manufacturing liveness.
    const restored = first as Extract<typeof first, { decision: "RESTORED" }>;
    const second = await seed.t.run(async (ctx) =>
      resolveRestorationDecision(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
      })
    );
    expect(second).toEqual({
      decision: "REFUSE",
      reason:
        "this evidence has already been reinstated, and its current episode no longer holds this vehicle",
    });
    void restored;
  });
});

describe("dormant evidence from an earlier generation", () => {
  /**
   * A lineage that has advanced two generations past the episode being
   * restored. R0 released, R1 released, R2 the tip.
   *
   * This is the ordinary shape when a deposit sits dormant while finance moves
   * the deal forward — and it is exactly what a direct-parent rule strands
   * forever, because R0 is two generations back from R2.
   */
  async function advancedLineage(seed: Seed, tipStatus: "OPEN" | "RELEASED") {
    const vehicleId = await vehicle(seed);
    const { reservationId, rootId: r0, claimId: c0 } = await acquire(
      seed,
      vehicleId,
      seed.customerA
    );
    await seed.t.run((ctx) => ctx.db.patch(r0, { status: "RELEASED" as const }));
    await seed.t.run((ctx) => ctx.db.patch(c0, { status: "RELEASED" as const }));
    const origin = (await seed.t.run((ctx) => ctx.db.get(r0)))!;

    const generation = async (
      gen: number,
      status: "OPEN" | "RELEASED",
      previous: Id<"commitmentRoots">,
      extra: Record<string, unknown> = {}
    ) =>
      await seed.t.run((ctx) =>
        ctx.db.insert("commitmentRoots", {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerA,
          status,
          openedAt: Date.now(),
          openedBy: seed.userId,
          lineageRootId: origin.lineageRootId!,
          lineageGeneration: gen,
          restoredFromRootId: previous,
          ...extra,
        })
      );

    const r1 = await generation(1, "RELEASED", r0);
    // The tip carries its own origin reservation, which the successor must
    // inherit rather than taking the caller's.
    const tipReservation = await reservation(seed, vehicleId, seed.customerA);
    const r2 = await generation(2, tipStatus, r1, { originReservationId: tipReservation });

    return { vehicleId, reservationId, tipReservation, r0, c0, r1, r2, origin };
  }

  test("a dormant R0 episode joins the OPEN tip two generations later", async () => {
    const seed = await seedDealer("d1");
    const f = await advancedLineage(seed, "OPEN");

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SOURCE_EPISODE_REINSTATED" },
        ...restoreArgs(seed, f),
      })
    );

    const restored = outcome as Extract<typeof outcome, { decision: "RESTORED" }>;
    expect(restored.decision).toBe("RESTORED");
    expect(restored.opened).toBe("JOINED");
    // ⚠️ Onto the TIP, not onto R0's direct child. A parent-only rule refuses
    // this forever and the deposit can never be reinstated.
    expect(String(restored.rootId)).toBe(String(f.r2));

    const claim = (await seed.t.run((ctx) => ctx.db.get(restored.claimId)))!;
    expect(String(claim.rootId)).toBe(String(f.r2));
    expect(String(claim.restoredFromClaimId)).toBe(String(f.c0));
  });

  test("a dormant R0 episode opens R3 from a terminal R2", async () => {
    const seed = await seedDealer("d2");
    const f = await advancedLineage(seed, "RELEASED");

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SOURCE_EPISODE_REINSTATED" },
        ...restoreArgs(seed, f),
      })
    );

    const restored = outcome as Extract<typeof outcome, { decision: "RESTORED" }>;
    expect(restored.opened).toBe("SUCCESSOR");
    const successor = (await seed.t.run((ctx) => ctx.db.get(restored.rootId)))!;
    expect(successor.lineageGeneration).toBe(3);
    expect(String(successor.restoredFromRootId)).toBe(String(f.r2));
    expect(String(successor.lineageRootId)).toBe(String(f.origin.lineageRootId));
  });

  test("the successor's root identity comes from the tip, not the caller", async () => {
    const seed = await seedDealer("d3");
    const f = await advancedLineage(seed, "RELEASED");
    // The operation presents its OWN reservation as lineage proof. That is a
    // claim-level fact and must not re-head the deal.
    const callerReservation = await reservation(seed, f.vehicleId, seed.customerA);

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SOURCE_EPISODE_REINSTATED" },
        // ⚠️ THERE IS NO LONGER A LINEAGE INPUT TO GET WRONG. The caller's own
        // reservation is created below and deliberately NOT passed: root
        // identity comes from the tip and the episode's quote from the episode
        // being continued, so this contract now proves the absence of the
        // channel rather than that the channel is ignored.
        createdBy: seed.userId,
      })
    );

    const restored = outcome as Extract<typeof outcome, { decision: "RESTORED" }>;
    const successor = (await seed.t.run((ctx) => ctx.db.get(restored.rootId)))!;
    // ⚠️ Dormant evidence cannot rewrite root identity as a side effect of
    // being reinstated.
    expect(String(successor.originReservationId)).toBe(String(f.tipReservation));
    // The caller's own reservation exists and is not reachable from root
    // identity by any route — there is no lineage parameter to pass it through.
    expect(String(successor.originReservationId)).not.toBe(String(callerReservation));
  });

  test("a second OPEN root on the car is AMBIGUOUS, decided before any join", async () => {
    const seed = await seedDealer("d4");
    const f = await advancedLineage(seed, "OPEN");
    // A rival OPEN root on the same car, in a lineage of its own.
    await seed.t.run((ctx) =>
      ctx.db.insert("commitmentRoots", {
        orgId: seed.orgId,
        vehicleId: f.vehicleId,
        customerId: seed.customerB,
        status: "OPEN" as const,
        openedAt: Date.now(),
        openedBy: seed.userId,
        lineageGeneration: 0,
      })
    );

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SOURCE_EPISODE_REINSTATED" },
        ...restoreArgs(seed, f),
      })
    );

    // ⚠️ One valid open lineage PLUS a rival open root is not a safe join.
    expect(outcome).toEqual({ decision: "AMBIGUOUS" });
  });

  test("an episode that was not released has nothing to reinstate", async () => {
    const seed = await seedDealer("d5");
    const f = await advancedLineage(seed, "OPEN");
    await seed.t.run((ctx) => ctx.db.patch(f.c0, { status: "CONSUMED" as const }));

    const outcome = await seed.t.run(async (ctx) =>
      resolveRestorationDecision(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SOURCE_EPISODE_REINSTATED" },
      })
    );
    expect(outcome).toEqual({ decision: "REFUSE", reason: "that evidence was not released" });
  });
});

describe("replay — ALREADY_LIVE needs the whole liveness proof, not a claim status", () => {
  /** Restore once, so a proven-live successor episode exists. */
  async function restoredOnce(seed: Seed) {
    const f = await consumedByCancelledSale(seed, seed.customerA);
    const first = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );
    const restored = first as Extract<typeof first, { decision: "RESTORED" }>;
    expect(restored.decision).toBe("RESTORED");
    return { f, restored };
  }

  const replay = async (
    seed: Seed,
    f: {
      reservationId: Id<"vehicleReservations">;
      vehicleId: Id<"vehicles">;
      saleId: Id<"sales">;
    }
  ) =>
    await seed.t.run(async (ctx) =>
      resolveRestorationDecision(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
      })
    );

  test("a proven-live successor replays byte-identically and writes nothing", async () => {
    const seed = await seedDealer("p1");
    const { f, restored } = await restoredOnce(seed);

    const rootsBefore = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const claimsBefore = await seed.t.run((ctx) =>
      ctx.db.query("vehicleCommitmentClaims").collect()
    );

    expect(await replay(seed, f)).toEqual({
      decision: "ALREADY_LIVE",
      rootId: restored.rootId,
      claimId: restored.claimId,
    });

    expect(await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect())).toEqual(
      rootsBefore
    );
    expect(await seed.t.run((ctx) => ctx.db.query("vehicleCommitmentClaims").collect())).toEqual(
      claimsBefore
    );
  });

  test("the maintained pointer moved to the restored episode", async () => {
    const seed = await seedDealer("p2");
    const { f, restored } = await restoredOnce(seed);
    const reservation = (await seed.t.run((ctx) => ctx.db.get(f.reservationId)))!;
    // ⚠️ Left naming the terminal predecessor, the next restoration would
    // resolve the stale episode as "current".
    expect(String(reservation.currentCommitmentClaimId)).toBe(String(restored.claimId));
  });

  test("an ACTIVE successor whose SOURCE is dead is not live", async () => {
    const seed = await seedDealer("p3");
    const { f } = await restoredOnce(seed);
    // Root still OPEN, claim still ACTIVE, pointer still correct — only the
    // reservation itself has ended.
    await seed.t.run((ctx) => ctx.db.patch(f.reservationId, { status: "RELEASED" as const }));

    expect(await replay(seed, f)).toEqual({
      decision: "REFUSE",
      reason:
        "this evidence has already been reinstated, and its current episode no longer holds this vehicle",
    });
  });

  test("an ACTIVE successor the source no longer points at is not live", async () => {
    const seed = await seedDealer("p4");
    const { f } = await restoredOnce(seed);
    // The car is held under some OTHER episode. Handing back the claim the
    // caller asked about would be a lie about who holds it.
    await seed.t.run((ctx) =>
      ctx.db.patch(f.reservationId, { currentCommitmentClaimId: f.claimId })
    );

    expect((await replay(seed, f)).decision).toBe("REFUSE");
  });

  test("the WRONG sale is refused even though the right one was restored", async () => {
    const seed = await seedDealer("p5");
    const { f } = await restoredOnce(seed);
    const unrelated = await sale(seed, f.vehicleId, seed.customerA);

    // ⚠️ Intent is validated BEFORE any replay answer, so naming the wrong
    // sale can never be answered with "already done".
    const outcome = await seed.t.run(async (ctx) =>
      resolveRestorationDecision(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: unrelated },
      })
    );
    expect(outcome).toEqual({
      decision: "REFUSE",
      reason: "that sale is not the one this deal was completed into",
    });
  });

  test("two successors from one predecessor is corruption, never a choice", async () => {
    const seed = await seedDealer("p6");
    const { f, restored } = await restoredOnce(seed);
    // A second successor branching from the same predecessor.
    await seed.t.run((ctx) =>
      ctx.db.insert("vehicleCommitmentClaims", {
        orgId: seed.orgId,
        rootId: restored.rootId,
        vehicleId: f.vehicleId,
        evidenceKind: "RESERVATION" as const,
        status: "ACTIVE" as const,
        reservationId: f.reservationId,
        restoredFromClaimId: f.claimId,
        createdAt: Date.now(),
        createdBy: seed.userId,
      })
    );

    expect(await replay(seed, f)).toEqual({
      decision: "REFUSE",
      reason: "this evidence has been reinstated more than once, which is inconsistent state",
    });
  });

  test("a foreign-tenant row cannot hide this tenant's successor", async () => {
    const seed = await seedDealer("p7");
    const f = await consumedByCancelledSale(seed, seed.customerA);

    // ⚠️ INSERTED BEFORE OUR SUCCESSOR, DELIBERATELY. Equal index keys order
    // by creation, so a foreign row written afterwards is never the one
    // `.first()` returns and the test would pass against the very defect it
    // exists to catch. It has to be ordered FIRST to discriminate.
    const otherOrg = await seed.t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Other Dealer",
        createdAt: Date.now(),
        commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1,
      })
    );
    await seed.t.run((ctx) =>
      ctx.db.insert("vehicleCommitmentClaims", {
        orgId: otherOrg,
        rootId: f.rootId,
        vehicleId: f.vehicleId,
        evidenceKind: "RESERVATION" as const,
        status: "RELEASED" as const,
        reservationId: f.reservationId,
        restoredFromClaimId: f.claimId,
        createdAt: Date.now(),
        createdBy: seed.userId,
      })
    );

    const first = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );
    const restored = first as Extract<typeof first, { decision: "RESTORED" }>;
    expect(restored.decision).toBe("RESTORED");

    // Reading one row from the bare index and checking its org afterwards is a
    // post-filter after a bounded read: the foreign row answers "no successor
    // here", the real one is never seen, and a SECOND successor gets opened.
    expect(await replay(seed, f)).toEqual({
      decision: "ALREADY_LIVE",
      rootId: restored.rootId,
      claimId: restored.claimId,
    });
  });
});

describe("typed authority outcomes after a reversal posts", () => {
  const settle = async (seed: Seed, vehicleId: Id<"vehicles">) =>
    await seed.t.run((ctx) =>
      settleAuthorityAfterReversal(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: Date.now(),
        reason: "deferred reversal posted",
      })
    );

  test("a car nobody holds reports NOTHING TO RESTORE — never RESTORED", async () => {
    const seed = await seedDealer("t1");
    const vehicleId = await vehicle(seed);
    // ⚠️ SCRUM-208 c15808. This asserted RESTORED, and the code obliged: an
    // audit field claiming a customer's deal had been reinstated when no deal
    // existed at all. RESTORED now means restored — see the taxonomy note in
    // commitments.ts — and "there was nothing here" has its own name.
    expect(await settle(seed, vehicleId)).toEqual({
      outcome: "ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS",
      detail: "no commitment root holds this vehicle",
    });
  });

  test("a held car whose basis has ended is FREED — reported as such, not as a restoration", async () => {
    const seed = await seedDealer("t2");
    const vehicleId = await vehicle(seed);
    const { reservationId, rootId } = await acquire(seed, vehicleId, seed.customerA);
    // The reservation has ended, so nothing holds the car any more.
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { status: "RELEASED" as const }));

    // Freeing a car is not restoring a deal. The root closes because nothing
    // holds it any more, which is the opposite of a restoration.
    expect(await settle(seed, vehicleId)).toEqual({
      outcome: "ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS",
      detail: "the deal was closed because nothing still held this vehicle",
    });
    const root = await seed.t.run((ctx) => ctx.db.get(rootId));
    expect(root?.status).toBe("RELEASED");
  });

  test("a car something still legitimately holds is NOT taken", async () => {
    const seed = await seedDealer("t3");
    const vehicleId = await vehicle(seed);
    const { rootId } = await acquire(seed, vehicleId, seed.customerA);

    // ⚠️ A RIVAL NEVER HAS ITS VEHICLE TAKEN. The accounting reversal stands;
    // the car does not move, and the root is left exactly as it was.
    expect(await settle(seed, vehicleId)).toEqual({
      outcome: "ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL",
      rootId,
    });
    const root = await seed.t.run((ctx) => ctx.db.get(rootId));
    expect(root?.status).toBe("OPEN");
  });

  test("two OPEN roots is a durable repair condition, not an error to retry", async () => {
    const seed = await seedDealer("t4");
    const vehicleId = await vehicle(seed);
    await acquire(seed, vehicleId, seed.customerA);
    await seed.t.run((ctx) =>
      ctx.db.insert("commitmentRoots", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerB,
        status: "OPEN" as const,
        openedAt: Date.now(),
        openedBy: seed.userId,
        lineageGeneration: 0,
      })
    );

    const rootsBefore = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    // ⚠️ IT DOES NOT THROW. A throw here lands in the outbox drain's generic
    // catch and becomes a bare `lastError`, indistinguishable from a transient
    // posting failure that the drain will retry identically forever.
    const outcome = await settle(seed, vehicleId);
    expect(outcome).toEqual({
      outcome: "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS",
      detail: "2 open commitment roots on this vehicle",
    });

    // Left byte-identical for a human to repair.
    expect(await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect())).toEqual(
      rootsBefore
    );
  });
});

describe("when one reversal frees several cars, the worst outcome survives", () => {
  /** A hold row on its own car, in whichever authority state is wanted. */
  async function freedCar(seed: Seed, state: "FREE" | "HELD" | "AMBIGUOUS") {
    const vehicleId = await vehicle(seed);
    if (state !== "FREE") await acquire(seed, vehicleId, seed.customerA);
    if (state === "AMBIGUOUS") {
      await seed.t.run((ctx) =>
        ctx.db.insert("commitmentRoots", {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerB,
          status: "OPEN" as const,
          openedAt: Date.now(),
          openedBy: seed.userId,
          lineageGeneration: 0,
        })
      );
    }
    const depositId = await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerA,
        amount: 100,
        status: "HELD" as const,
        holdActive: true,
        usesVehicleHoldRows: true,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );
    const holdId = await seed.t.run((ctx) =>
      ctx.db.insert("depositVehicleHolds", {
        orgId: seed.orgId,
        depositId,
        vehicleId,
        active: false,
        createdAt: Date.now(),
      })
    );
    const saleId = await sale(seed, vehicleId, seed.customerA);
    return { kind: "SLICE" as const, depositId, vehicleId, saleId, holdId };
  }

  test("a blocked car survives however the freed holds are ordered", async () => {
    const seed = await seedDealer("w1");
    const clean = await freedCar(seed, "FREE");
    const held = await freedCar(seed, "HELD");
    const blocked = await freedCar(seed, "AMBIGUOUS");

    // ⚠️ ORDER-INDEPENDENCE IS THE CONTRACT. The order rows come back in is
    // not something a caller controls, so "worst wins" has to hold both ways
    // round — a clean car read last must not overwrite a repair condition.
    for (const order of [
      [clean, held, blocked],
      [blocked, held, clean],
    ]) {
      const outcome = await seed.t.run((ctx) =>
        settleFreedHoldsAuthority(ctx, seed.orgId, order, Date.now(), seed.userId)
      );
      expect(outcome?.outcome).toBe("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS");
    }
  });

  test("a rival outranks a clean settle but yields to a blocked one", async () => {
    const seed = await seedDealer("w2");
    const clean = await freedCar(seed, "FREE");
    const held = await freedCar(seed, "HELD");

    const outcome = await seed.t.run((ctx) =>
      settleFreedHoldsAuthority(ctx, seed.orgId, [held, clean], Date.now(), seed.userId)
    );
    expect(outcome?.outcome).toBe("ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL");
  });

  test("a hold belonging to another dealership is skipped, not settled", async () => {
    const seed = await seedDealer("w3");
    const clean = await freedCar(seed, "FREE");
    const otherOrg = await seed.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() })
    );
    await seed.t.run((ctx) => ctx.db.patch(clean.holdId, { orgId: otherOrg }));

    expect(
      await seed.t.run((ctx) => settleFreedHoldsAuthority(ctx, seed.orgId, [clean], Date.now(), seed.userId))
    ).toBeNull();
  });

  test("a clean settle can never overwrite a condition needing repair", () => {
    // ⚠️ A reversal can free several cars at once. Recording "RESTORED" over a
    // blocked one is how a repair condition disappears, so the ordering is
    // asserted rather than left to the order rows happen to be read in.
    expect(AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS).toBeGreaterThan(
      AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL
    );
    expect(AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL).toBeGreaterThan(
      AUTHORITY_SEVERITY.RESTORED
    );
  });
});

describe("L3 — the tip is the MAXIMUM generation, not whichever root is OPEN", () => {
  async function corruptLineage(
    seed: Seed,
    rows: Array<{ status: "OPEN" | "RELEASED" | "CONSUMED"; generation: number }>
  ) {
    const vehicleId = await vehicle(seed);
    const { rootId } = await acquire(seed, vehicleId, seed.customerA);
    await seed.t.run((ctx) => ctx.db.patch(rootId, { status: "CONSUMED" as const }));
    const origin = (await seed.t.run((ctx) => ctx.db.get(rootId)))!;
    for (const row of rows) {
      await seed.t.run((ctx) =>
        ctx.db.insert("commitmentRoots", {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerA,
          status: row.status,
          openedAt: Date.now(),
          openedBy: seed.userId,
          lineageRootId: origin.lineageRootId!,
          lineageGeneration: row.generation,
        })
      );
    }
    return origin.lineageRootId!;
  }

  test("an OPEN root below a later terminal generation is corruption", async () => {
    const seed = await seedDealer("l3");
    // Exactly ONE open root and no duplicate generation — every check a
    // live-first probe makes would pass, and it would answer generation 1
    // while generation 2 is the real tip.
    const lineageRootId = await corruptLineage(seed, [
      { status: "OPEN", generation: 1 },
      { status: "CONSUMED", generation: 2 },
    ]);

    const tip = await seed.t.run(async (ctx) =>
      resolveLineageTip(ctx, await decisionFor(seed, ctx), lineageRootId)
    );
    expect(tip).toEqual({
      kind: "CORRUPT",
      reason: "an OPEN root sits below a later terminal generation",
    });
  });

  test("two roots at the same generation is corruption", async () => {
    const seed = await seedDealer("l3b");
    const lineageRootId = await corruptLineage(seed, [
      { status: "RELEASED", generation: 1 },
      { status: "CONSUMED", generation: 1 },
    ]);

    const tip = await seed.t.run(async (ctx) =>
      resolveLineageTip(ctx, await decisionFor(seed, ctx), lineageRootId)
    );
    expect(tip).toEqual({
      kind: "CORRUPT",
      reason: "two roots share the lineage's highest generation",
    });
  });

  test("a healthy lineage resolves to its newest root", async () => {
    const seed = await seedDealer("l3c");
    const f = await consumedByCancelledSale(seed, seed.customerA);

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        source: sourceOf(f.reservationId),
        vehicleId: f.vehicleId,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
        ...restoreArgs(seed, f),
      })
    );
    const successorId = (outcome as { rootId: Id<"commitmentRoots"> }).rootId;

    const tip = await seed.t.run(async (ctx) =>
      resolveLineageTip(ctx, await decisionFor(seed, ctx), f.root.lineageRootId!)
    );
    expect(tip.kind).toBe("TIP");
    expect(String((tip as { root: Doc<"commitmentRoots"> }).root._id)).toBe(String(successorId));
  });
});
