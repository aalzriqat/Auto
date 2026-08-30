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
  resolveRestorationDecision,
  restoreCommitment,
} from "./commitments";
import {
  AuthorityDecisionContext,
  beginUserRun,
  COMMITMENT_AUTHORITY_V1,
  PrincipalBoundEvidence,
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

/** Build the principal-bound evidence a source resolver would produce. */
async function currentEvidence(
  seed: Seed,
  args: {
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    reservationId: Id<"vehicleReservations">;
    claimId: Id<"vehicleCommitmentClaims">;
    root: Doc<"commitmentRoots">;
  }
): Promise<PrincipalBoundEvidence> {
  return {
    orgId: seed.orgId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    evidenceKind: "RESERVATION",
    evidenceRef: { kind: "RESERVATION", reservationId: args.reservationId },
    episode: {
      state: "CURRENT",
      claimId: args.claimId,
      lineageRootId: args.root.lineageRootId!,
      lineageGeneration: args.root.lineageGeneration!,
    },
  };
}

/** A deal that completed into a sale, then had that sale cancelled. */
async function consumedByCancelledSale(seed: Seed, customerId: Id<"customers">) {
  const vehicleId = await vehicle(seed);
  const { reservationId, rootId, claimId } = await acquire(seed, vehicleId, customerId);
  const saleId = await sale(seed, vehicleId, customerId);
  await seed.t.run((ctx) =>
    ctx.db.patch(rootId, {
      status: "CONSUMED" as const,
      consumedBySaleId: saleId,
      closedAt: Date.now(),
    })
  );
  await seed.t.run((ctx) =>
    ctx.db.patch(claimId, { status: "CONSUMED" as const, consumedBySaleId: saleId })
  );
  const root = (await seed.t.run((ctx) => ctx.db.get(rootId)))!;
  const evidence = await currentEvidence(seed, {
    vehicleId,
    customerId,
    reservationId,
    claimId,
    root,
  });
  return { vehicleId, reservationId, rootId, claimId, saleId, root, evidence };
}

function restoreArgs(seed: Seed, fixture: { reservationId: Id<"vehicleReservations"> }) {
  return {
    commitmentEvidence: { kind: "RESERVATION" as const, reservationId: fixture.reservationId },
    lineage: { reservationId: fixture.reservationId },
    createdBy: seed.userId,
  };
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
        evidence: f.evidence,
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

  test("NEW evidence can never be a restoration", async () => {
    const seed = await seedDealer("r2");
    const f = await consumedByCancelledSale(seed, seed.customerA);

    // First acquisition has no episode. Accepting it here would open a root
    // with no provenance back to what was reversed.
    const asNew: PrincipalBoundEvidence = { ...f.evidence, episode: { state: "NEW" } };

    await expect(
      seed.t.run(async (ctx) =>
        restoreCommitment(ctx, {
          decision: await decisionFor(seed, ctx),
          evidence: asNew,
          intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
          ...restoreArgs(seed, f),
        })
      )
    ).rejects.toThrow(/no live commitment episode/);
  });

  test("a DIFFERENT sale does not entitle a restoration of this deal", async () => {
    const seed = await seedDealer("r3");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // Some other cancelled sale in the same dealership.
    const unrelated = await sale(seed, f.vehicleId, seed.customerA);

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        evidence: f.evidence,
        intent: { kind: "SALE_CANCELLED", saleId: unrelated },
        ...restoreArgs(seed, f),
      })
    );

    expect(outcome).toEqual({
      decision: "REFUSE",
      reason: "that sale is not the one this deal was completed into",
    });
  });

  test("evidence proving a different customer is refused", async () => {
    const seed = await seedDealer("r4");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    // The row is genuine; it simply belongs to somebody else.
    const otherCustomer: PrincipalBoundEvidence = {
      ...f.evidence,
      customerId: seed.customerB,
    };

    await expect(
      seed.t.run(async (ctx) =>
        restoreCommitment(ctx, {
          decision: await decisionFor(seed, ctx),
          evidence: otherCustomer,
          intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
          ...restoreArgs(seed, f),
        })
      )
    ).rejects.toThrow(/different customer/);
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
        evidence: f.evidence,
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

  test("a still-open lineage is REJOINED, not succeeded", async () => {
    const seed = await seedDealer("r6");
    const vehicleId = await vehicle(seed);
    const { reservationId, rootId, claimId } = await acquire(seed, vehicleId, seed.customerA);
    const root = (await seed.t.run((ctx) => ctx.db.get(rootId)))!;
    const evidence = await currentEvidence(seed, {
      vehicleId,
      customerId: seed.customerA,
      reservationId,
      claimId,
      root,
    });

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        evidence,
        intent: { kind: "SOURCE_EPISODE_REINSTATED" },
        ...restoreArgs(seed, { reservationId }),
      })
    );

    const restored = outcome as Extract<typeof outcome, { decision: "RESTORED" }>;
    expect(restored.decision).toBe("RESTORED");
    expect(restored.opened).toBe("JOINED");
    expect(String(restored.rootId)).toBe(String(rootId));

    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    expect(roots).toHaveLength(1);
  });

  test("a legacy predecessor fails closed instead of being normalized", async () => {
    const seed = await seedDealer("r7");
    const f = await consumedByCancelledSale(seed, seed.customerA);
    const legacyEvidence: PrincipalBoundEvidence = {
      ...f.evidence,
      // A lineage id that names a row carrying no lineage identity at all.
      episode: { state: "CURRENT", claimId: f.claimId, lineageRootId: f.rootId, lineageGeneration: 0 },
    };
    await seed.t.run((ctx) =>
      ctx.db.patch(f.rootId, { lineageRootId: undefined, lineageGeneration: undefined })
    );

    const outcome = await seed.t.run(async (ctx) =>
      restoreCommitment(ctx, {
        decision: await decisionFor(seed, ctx),
        evidence: legacyEvidence,
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
          evidence: f.evidence,
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
        evidence: f.evidence,
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

    // ⚠️ The tip is now the successor, and the evidence still names generation
    // 0. Succeeding a NON-TIP forks the lineage.
    const second = await seed.t.run(async (ctx) =>
      resolveRestorationDecision(ctx, {
        decision: await decisionFor(seed, ctx),
        evidence: f.evidence,
        intent: { kind: "SALE_CANCELLED", saleId: f.saleId },
      })
    );
    expect(second.decision).toBe("REFUSE");
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
        evidence: f.evidence,
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
