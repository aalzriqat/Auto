/**
 * SCRUM-208 PHASE 3 — LINEAGE AND SUCCESSION.
 *
 * A root is terminal FOREVER once CONSUMED or RELEASED, so a restoration
 * cannot revive one: it opens the next generation of the same lineage. These
 * contracts cover the identity that makes that possible and the four ways it
 * is allowed to refuse.
 *
 * Scoped to lineage and succession only. The restoration doors themselves, the
 * legacy/V1 dispatcher and the cutover shadow read ship with their own steps.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Doc, Id } from "./_generated/dataModel";
import { acquireVehicle, openSuccessorRoot } from "./commitments";
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

/** A reservation to serve as defining evidence for an acquisition. */
async function reservation(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
) {
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

function decisionFor(seed: Seed, now = Date.now()) {
  return async (ctx: any): Promise<AuthorityDecisionContext> =>
    await requireDecisionContext(ctx, beginUserRun(seed.userId, now), seed.orgId);
}

/** Acquire a car through the real door, then terminalize its root. */
async function acquireThenConsume(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
): Promise<Doc<"commitmentRoots">> {
  const reservationId = await reservation(seed, vehicleId, customerId);
  const { rootId } = await seed.t.run((ctx) =>
    acquireVehicle(ctx, {
      orgId: seed.orgId,
      vehicleId,
      customerId,
      createdBy: seed.userId,
      evidence: { kind: "RESERVATION", reservationId },
      lineage: { reservationId },
    })
  );
  await seed.t.run((ctx) =>
    ctx.db.patch(rootId, { status: "CONSUMED" as const, closedAt: Date.now() })
  );
  const root = await seed.t.run((ctx) => ctx.db.get(rootId));
  return root!;
}

describe("L9 — a canonical root commits as its own lineage origin", () => {
  test("lineageRootId points at itself and the generation is 0", async () => {
    const seed = await seedDealer("l9");
    const vehicleId = await vehicle(seed);
    const reservationId = await reservation(seed, vehicleId, seed.customerA);

    const { rootId } = await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerA,
        createdBy: seed.userId,
        evidence: { kind: "RESERVATION", reservationId },
        lineage: { reservationId },
      })
    );

    const root = await seed.t.run((ctx) => ctx.db.get(rootId));
    // ⚠️ Not "absent, and a reader normalizes it to self". Absent is the
    // LEGACY signal and has to keep meaning that.
    expect(String(root?.lineageRootId)).toBe(String(rootId));
    expect(root?.lineageGeneration).toBe(0);
  });
});

describe("succession", () => {
  test("a successor carries the lineage, the next generation and the principal", async () => {
    const seed = await seedDealer("s1");
    const vehicleId = await vehicle(seed);
    const predecessor = await acquireThenConsume(seed, vehicleId, seed.customerA);

    const outcome = await seed.t.run(async (ctx) =>
      openSuccessorRoot(ctx, {
        decision: await decisionFor(seed)(ctx),
        predecessor,
        openedBy: seed.userId,
        reason: "sale reversed",
      })
    );

    expect(outcome.kind).toBe("OPENED");
    const successor = await seed.t.run((ctx) =>
      ctx.db.get((outcome as { kind: "OPENED"; rootId: Id<"commitmentRoots"> }).rootId)
    );
    expect(String(successor?.lineageRootId)).toBe(String(predecessor.lineageRootId));
    expect(successor?.lineageGeneration).toBe(1);
    expect(String(successor?.restoredFromRootId)).toBe(String(predecessor._id));
    expect(successor?.status).toBe("OPEN");
    // The principal is CARRIED, never re-derived from whoever is presenting
    // the evidence — that is how one customer's money becomes another's deal.
    expect(String(successor?.customerId)).toBe(String(seed.customerA));
  });

  test("a rival holding the car is refused, and NOTHING is written", async () => {
    const seed = await seedDealer("s2");
    const vehicleId = await vehicle(seed);
    const predecessor = await acquireThenConsume(seed, vehicleId, seed.customerA);

    // A different deal legitimately takes the car after the first one ended.
    const rivalReservation = await reservation(seed, vehicleId, seed.customerB);
    const { rootId: rivalRootId } = await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerB,
        createdBy: seed.userId,
        evidence: { kind: "RESERVATION", reservationId: rivalReservation },
        lineage: { reservationId: rivalReservation },
      })
    );

    const before = await seed.t.run((ctx) =>
      ctx.db
        .query("commitmentRoots")
        .withIndex("by_org_vehicle_status", (q) =>
          q.eq("orgId", seed.orgId).eq("vehicleId", vehicleId)
        )
        .collect()
    );

    const outcome = await seed.t.run(async (ctx) =>
      openSuccessorRoot(ctx, {
        decision: await decisionFor(seed)(ctx),
        predecessor,
        openedBy: seed.userId,
        reason: "sale reversed while another deal holds the car",
      })
    );

    expect(outcome).toEqual({ kind: "RIVAL", rivalRootId });

    // ⚠️ THE RIVAL KEEPS THE CAR. The accounting reversal stands; the vehicle
    // does not move. A second OPEN root here is one car promised to two deals.
    const after = await seed.t.run((ctx) =>
      ctx.db
        .query("commitmentRoots")
        .withIndex("by_org_vehicle_status", (q) =>
          q.eq("orgId", seed.orgId).eq("vehicleId", vehicleId)
        )
        .collect()
    );
    expect(after.length).toBe(before.length);
  });

  test("a legacy predecessor fails closed instead of being normalized", async () => {
    const seed = await seedDealer("s3");
    const vehicleId = await vehicle(seed);
    const predecessor = await acquireThenConsume(seed, vehicleId, seed.customerA);
    // A row that predates the canonical authority: no lineage identity at all.
    await seed.t.run((ctx) =>
      ctx.db.patch(predecessor._id, {
        lineageRootId: undefined,
        lineageGeneration: undefined,
      })
    );
    const legacy = (await seed.t.run((ctx) => ctx.db.get(predecessor._id)))!;

    const outcome = await seed.t.run(async (ctx) =>
      openSuccessorRoot(ctx, {
        decision: await decisionFor(seed)(ctx),
        predecessor: legacy,
        openedBy: seed.userId,
        reason: "sale reversed",
      })
    );

    expect(outcome.kind).toBe("REFUSED");
  });

  test("a root that has already been continued cannot be continued again", async () => {
    const seed = await seedDealer("s4");
    const vehicleId = await vehicle(seed);
    const predecessor = await acquireThenConsume(seed, vehicleId, seed.customerA);

    const first = await seed.t.run(async (ctx) =>
      openSuccessorRoot(ctx, {
        decision: await decisionFor(seed)(ctx),
        predecessor,
        openedBy: seed.userId,
        reason: "first restoration",
      })
    );
    expect(first.kind).toBe("OPENED");
    // Terminalize the successor so the SECOND attempt fails on the tip check
    // rather than on "the tip is still OPEN".
    await seed.t.run((ctx) =>
      ctx.db.patch((first as { kind: "OPENED"; rootId: Id<"commitmentRoots"> }).rootId, {
        status: "RELEASED" as const,
      })
    );

    // ⚠️ Succeeding a NON-TIP forks the lineage: two roots would then claim
    // the same next generation and the tip is corrupt forever after.
    const second = await seed.t.run(async (ctx) =>
      openSuccessorRoot(ctx, {
        decision: await decisionFor(seed)(ctx),
        predecessor,
        openedBy: seed.userId,
        reason: "duplicate restoration",
      })
    );
    expect(second.kind).toBe("REFUSED");
  });

  test("a live root is a programmer error, not a refusal", async () => {
    const seed = await seedDealer("s5");
    const vehicleId = await vehicle(seed);
    const reservationId = await reservation(seed, vehicleId, seed.customerA);
    const { rootId } = await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerA,
        createdBy: seed.userId,
        evidence: { kind: "RESERVATION", reservationId },
        lineage: { reservationId },
      })
    );
    const open = (await seed.t.run((ctx) => ctx.db.get(rootId)))!;

    await expect(
      seed.t.run(async (ctx) =>
        openSuccessorRoot(ctx, {
          decision: await decisionFor(seed)(ctx),
          predecessor: open,
          openedBy: seed.userId,
          reason: "succeeding a live root",
        })
      )
    ).rejects.toThrow(/still OPEN/);
  });

  test("a legacy organization cannot reach the canonical path at all", async () => {
    const seed = await seedDealer("s6", { canonical: false });
    const vehicleId = await vehicle(seed);
    const predecessor = await acquireThenConsume(seed, vehicleId, seed.customerA);

    await expect(
      seed.t.run(async (ctx) =>
        openSuccessorRoot(ctx, {
          decision: await decisionFor(seed)(ctx),
          predecessor,
          openedBy: seed.userId,
          reason: "legacy org",
        })
      )
    ).rejects.toThrow(/canonical commitment authority/);
  });
});

describe("L3 — the tip is the MAXIMUM generation, not whichever root is OPEN", () => {
  test("an OPEN root below a later terminal generation is corruption", async () => {
    const seed = await seedDealer("l3");
    const vehicleId = await vehicle(seed);
    const origin = await acquireThenConsume(seed, vehicleId, seed.customerA);
    const lineageRootId = origin.lineageRootId!;

    // R1 gen 1 OPEN, R2 gen 2 CONSUMED. Exactly ONE open root, no duplicate
    // generation — every check a live-first probe makes would pass, and it
    // would answer R1 while R2 is the real tip.
    await seed.t.run((ctx) =>
      ctx.db.insert("commitmentRoots", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerA,
        status: "OPEN" as const,
        openedAt: Date.now(),
        openedBy: seed.userId,
        lineageRootId,
        lineageGeneration: 1,
      })
    );
    await seed.t.run((ctx) =>
      ctx.db.insert("commitmentRoots", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerA,
        status: "CONSUMED" as const,
        openedAt: Date.now(),
        openedBy: seed.userId,
        lineageRootId,
        lineageGeneration: 2,
      })
    );

    const tip = await seed.t.run(async (ctx) =>
      resolveLineageTip(ctx, await decisionFor(seed)(ctx), lineageRootId)
    );
    expect(tip.kind).toBe("CORRUPT");
  });

  test("two roots at the same generation is corruption", async () => {
    const seed = await seedDealer("l3b");
    const vehicleId = await vehicle(seed);
    const origin = await acquireThenConsume(seed, vehicleId, seed.customerA);
    const lineageRootId = origin.lineageRootId!;

    for (const status of ["RELEASED", "CONSUMED"] as const) {
      await seed.t.run((ctx) =>
        ctx.db.insert("commitmentRoots", {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerA,
          status,
          openedAt: Date.now(),
          openedBy: seed.userId,
          lineageRootId,
          lineageGeneration: 1,
        })
      );
    }

    const tip = await seed.t.run(async (ctx) =>
      resolveLineageTip(ctx, await decisionFor(seed)(ctx), lineageRootId)
    );
    expect(tip).toEqual({
      kind: "CORRUPT",
      reason: "two roots share the lineage's highest generation",
    });
  });

  test("a healthy lineage resolves to its newest root", async () => {
    const seed = await seedDealer("l3c");
    const vehicleId = await vehicle(seed);
    const predecessor = await acquireThenConsume(seed, vehicleId, seed.customerA);

    const outcome = await seed.t.run(async (ctx) =>
      openSuccessorRoot(ctx, {
        decision: await decisionFor(seed)(ctx),
        predecessor,
        openedBy: seed.userId,
        reason: "sale reversed",
      })
    );
    const successorId = (outcome as { kind: "OPENED"; rootId: Id<"commitmentRoots"> }).rootId;

    const tip = await seed.t.run(async (ctx) =>
      resolveLineageTip(ctx, await decisionFor(seed)(ctx), predecessor.lineageRootId!)
    );
    expect(tip.kind).toBe("TIP");
    expect(String((tip as { kind: "TIP"; root: Doc<"commitmentRoots"> }).root._id)).toBe(
      String(successorId)
    );
  });
});
