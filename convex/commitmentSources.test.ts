/**
 * SCRUM-208 — THE CANONICAL SOURCE BINDING.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE A COMMENT ONCE CLAIMED IT DID. An earlier version
 * of `utils/commitmentSources.ts` declared its own copy of the finance-status
 * list and said "the two lists are pinned equal by a contract in
 * commitmentSources.test.ts". No such file existed. The claim was false, and
 * the right repair was not to write that test but to delete the second list —
 * two independently maintained copies are the distributed-inference defect
 * SCRUM-195 removed, and a test can only report that they drifted.
 *
 * What is pinned here instead is that the resolver walks ONE chain from the
 * source row and refuses every way that chain can be broken.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { acquireVehicle, IN_FLIGHT_FINANCE_STATUSES } from "./commitments";
import {
  AuthorityDecisionContext,
  beginUserRun,
  COMMITMENT_AUTHORITY_V1,
  requireDecisionContext,
} from "./utils/commitmentKernel";
import { resolveCanonicalBinding, SourceRef } from "./utils/commitmentSources";
import { IN_FLIGHT_FINANCE_STATUSES as SHARED_STATUSES } from "./utils/financeStatuses";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

let vinCounter = 5000;

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: `Dealer ${suffix}`,
      createdAt: Date.now(),
      commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1,
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `u_${suffix}`, email: `${suffix}@t.com`, name: "U" })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "C",
      lastName: suffix,
      phone: `+96278${suffix}`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, customerId };
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
      sellingPrice: 30_000,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

async function decisionFor(seed: Seed, ctx: any): Promise<AuthorityDecisionContext> {
  return await requireDecisionContext(ctx, beginUserRun(seed.userId, Date.now()), seed.orgId);
}

const bind = async (seed: Seed, source: SourceRef, vehicleId: Id<"vehicles">) =>
  await seed.t.run(async (ctx) =>
    resolveCanonicalBinding(ctx, await decisionFor(seed, ctx), { source, vehicleId })
  );

/** A deposit acquired through the real door, in the named representation. */
async function depositFixture(seed: Seed, usesVehicleHoldRows: boolean) {
  const vehicleId = await vehicle(seed);
  const depositId = await seed.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: seed.orgId,
      vehicleId,
      customerId: seed.customerId,
      amount: 1_000,
      status: "HELD" as const,
      holdActive: true,
      usesVehicleHoldRows,
      createdBy: seed.userId,
      createdAt: Date.now(),
    })
  );
  const { claimId } = await seed.t.run((ctx) =>
    acquireVehicle(ctx, {
      orgId: seed.orgId,
      vehicleId,
      customerId: seed.customerId,
      createdBy: seed.userId,
      evidence: { kind: "DEPOSIT", depositId },
      lineage: { depositId },
    })
  );
  return { vehicleId, depositId, claimId };
}

async function holdRow(
  seed: Seed,
  args: {
    depositId: Id<"deposits">;
    vehicleId: Id<"vehicles">;
    claimId?: Id<"vehicleCommitmentClaims">;
    active?: boolean;
  }
) {
  return await seed.t.run((ctx) =>
    ctx.db.insert("depositVehicleHolds", {
      orgId: seed.orgId,
      depositId: args.depositId,
      vehicleId: args.vehicleId,
      active: args.active ?? true,
      createdAt: Date.now(),
      ...(args.claimId ? { sourceCommitmentClaimId: args.claimId } : {}),
    })
  );
}

describe("one finance-status definition", () => {
  test("the authority re-exports the shared list rather than copying it", () => {
    // ⚠️ IDENTITY, NOT EQUALITY. Two arrays with the same contents is exactly
    // the state a drift test reports after the damage is done; the same array
    // object cannot drift at all.
    expect(IN_FLIGHT_FINANCE_STATUSES).toBe(SHARED_STATUSES);
  });
});

describe("initial acquisition stamps its pointer", () => {
  test("a reservation names its episode as soon as the claim exists", async () => {
    const seed = await seedDealer("a1");
    const vehicleId = await vehicle(seed);
    const reservationId = await seed.t.run((ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        status: "ACTIVE" as const,
        reservedBy: seed.userId,
        reservedAt: Date.now(),
      })
    );
    const { claimId } = await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        createdBy: seed.userId,
        evidence: { kind: "RESERVATION", reservationId },
        lineage: { reservationId },
      })
    );

    // ⚠️ RESTORATION MUST NOT BE THE ONLY PATH THAT WRITES THIS. A pointer that
    // appears only after a restoration is absent for every ordinary deal, so
    // the first reader to consult it fails closed on healthy data.
    const reservation = await seed.t.run((ctx) => ctx.db.get(reservationId));
    expect(String(reservation?.currentCommitmentClaimId)).toBe(String(claimId));
  });

  test("a direct deposit names its episode as soon as the claim exists", async () => {
    const seed = await seedDealer("a2");
    const f = await depositFixture(seed, false);
    const deposit = await seed.t.run((ctx) => ctx.db.get(f.depositId));
    expect(String(deposit?.singleVehicleCommitmentClaimId)).toBe(String(f.claimId));
  });
});

describe("deposit representation is exact", () => {
  test("a direct deposit resolves through its scalar pointer", async () => {
    const seed = await seedDealer("d1");
    const f = await depositFixture(seed, false);
    const result = await bind(seed, { kind: "DEPOSIT", depositId: f.depositId }, f.vehicleId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.binding.claim._id)).toBe(String(f.claimId));
  });

  test("a direct deposit that also carries a hold row refuses, even when they agree", async () => {
    const seed = await seedDealer("d2");
    const f = await depositFixture(seed, false);
    // Both representations name the SAME claim — and it is still corruption:
    // two copies of one fact are two facts, and the next writer updates one.
    await holdRow(seed, { depositId: f.depositId, vehicleId: f.vehicleId, claimId: f.claimId });

    const result = await bind(seed, { kind: "DEPOSIT", depositId: f.depositId }, f.vehicleId);
    expect(result).toEqual({
      ok: false,
      reason: "that deposit carries both representations of its hold on this vehicle",
    });
  });

  test("a sliced deposit must NAME its slice, never have one guessed", async () => {
    const seed = await seedDealer("d3");
    const f = await depositFixture(seed, true);
    await holdRow(seed, { depositId: f.depositId, vehicleId: f.vehicleId, claimId: f.claimId });

    const result = await bind(seed, { kind: "DEPOSIT", depositId: f.depositId }, f.vehicleId);
    expect(result).toEqual({
      ok: false,
      reason: "that deposit holds this vehicle through a slice that was not named",
    });
  });

  test("the NEWEST hold row is not the answer — the named one is", async () => {
    const seed = await seedDealer("d4");
    const f = await depositFixture(seed, true);
    // The slice the operation is acting on...
    const namedHold = await holdRow(seed, {
      depositId: f.depositId,
      vehicleId: f.vehicleId,
      claimId: f.claimId,
    });
    // ...and a LATER one, from a reallocation, carrying no episode at all.
    // RETURN_TO_UNALLOCATED and REALLOCATE_TO_VEHICLE both INSERT fresh holds,
    // so "newest" is a guess about which slice was meant.
    await holdRow(seed, { depositId: f.depositId, vehicleId: f.vehicleId });

    const result = await bind(
      seed,
      { kind: "DEPOSIT", depositId: f.depositId, holdId: namedHold },
      f.vehicleId
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.binding.claim._id)).toBe(String(f.claimId));
  });

  test("a sliced deposit carrying a scalar pointer too is corrupt", async () => {
    const seed = await seedDealer("d5");
    const f = await depositFixture(seed, true);
    const hold = await holdRow(seed, {
      depositId: f.depositId,
      vehicleId: f.vehicleId,
      claimId: f.claimId,
    });
    await seed.t.run((ctx) =>
      ctx.db.patch(f.depositId, { singleVehicleCommitmentClaimId: f.claimId })
    );

    const result = await bind(
      seed,
      { kind: "DEPOSIT", depositId: f.depositId, holdId: hold },
      f.vehicleId
    );
    expect(result).toEqual({
      ok: false,
      reason: "that deposit carries both representations of its hold on this vehicle",
    });
  });

  test("a slice belonging to another deposit is refused", async () => {
    const seed = await seedDealer("d6");
    const mine = await depositFixture(seed, true);
    const theirs = await depositFixture(seed, true);
    const foreignHold = await holdRow(seed, {
      depositId: theirs.depositId,
      vehicleId: mine.vehicleId,
      claimId: mine.claimId,
    });

    const result = await bind(
      seed,
      { kind: "DEPOSIT", depositId: mine.depositId, holdId: foreignHold },
      mine.vehicleId
    );
    expect(result).toEqual({ ok: false, reason: "that slice belongs to a different deposit" });
  });

  test("a deposit with no representation class fails closed", async () => {
    const seed = await seedDealer("d7");
    const f = await depositFixture(seed, false);
    await seed.t.run((ctx) => ctx.db.patch(f.depositId, { usesVehicleHoldRows: undefined }));

    const result = await bind(seed, { kind: "DEPOSIT", depositId: f.depositId }, f.vehicleId);
    expect(result).toEqual({
      ok: false,
      reason: "that deposit predates the canonical commitment authority",
    });
  });
});

describe("the pointer must name an episode that matches the source", () => {
  test("a pointer naming another vehicle's episode is refused", async () => {
    const seed = await seedDealer("m1");
    const mine = await depositFixture(seed, false);
    const other = await depositFixture(seed, false);
    await seed.t.run((ctx) =>
      ctx.db.patch(mine.depositId, { singleVehicleCommitmentClaimId: other.claimId })
    );

    const result = await bind(seed, { kind: "DEPOSIT", depositId: mine.depositId }, mine.vehicleId);
    expect(result).toEqual({
      ok: false,
      reason: "the episode this record names is for a different vehicle",
    });
  });

  test("a pointer naming an episode opened on different evidence is refused", async () => {
    const seed = await seedDealer("m2");
    const f = await depositFixture(seed, false);
    const other = await depositFixture(seed, false);
    // Same vehicle, but the claim was opened on a DIFFERENT deposit.
    await seed.t.run((ctx) => ctx.db.patch(other.claimId, { vehicleId: f.vehicleId }));
    await seed.t.run((ctx) =>
      ctx.db.patch(f.depositId, { singleVehicleCommitmentClaimId: other.claimId })
    );

    const result = await bind(seed, { kind: "DEPOSIT", depositId: f.depositId }, f.vehicleId);
    expect(result).toEqual({
      ok: false,
      reason: "the episode this record names was opened on different evidence",
    });
  });

  test("a pointer naming an episode of the wrong KIND is refused", async () => {
    const seed = await seedDealer("m3");
    const f = await depositFixture(seed, false);
    // The claim keeps its deposit reference but is retagged as a reservation
    // episode. The tag is the primary fact, so this is a different KIND of
    // claim on the car.
    await seed.t.run((ctx) =>
      ctx.db.patch(f.claimId, { evidenceKind: "RESERVATION" as const, depositId: undefined })
    );

    const result = await bind(seed, { kind: "DEPOSIT", depositId: f.depositId }, f.vehicleId);
    expect(result.ok).toBe(false);
  });
});

describe("a finance application's pointer set must be complete and unique", () => {
  async function financeFixture(seed: Seed, vehicles: Id<"vehicles">[]) {
    const quoteId = await seed.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId: vehicles[0],
        vehiclePrice: 30_000,
        downPayment: 0,
        termMonths: 12,
        createdBy: seed.userId,
        createdAt: Date.now(),
        status: "DRAFT" as const,
      })
    );
    const applicationId = await seed.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: seed.orgId,
        quoteId,
        customerId: seed.customerId,
        vehicleId: vehicles[0],
        ...(vehicles.length > 1
          ? { vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: 30_000 })) }
          : {}),
        salespersonId: seed.userId,
        status: "APPROVED" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const { claimId } = await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId: vehicles[0],
        customerId: seed.customerId,
        createdBy: seed.userId,
        evidence: { kind: "FINANCE", applicationId },
        lineage: { quoteId },
      })
    );
    return { applicationId, claimId };
  }

  test("a single-vehicle application resolves through the normalized set", async () => {
    const seed = await seedDealer("f1");
    const vehicleId = await vehicle(seed);
    const f = await financeFixture(seed, [vehicleId]);

    // ⚠️ `vehicleItems` is ABSENT here — the commonest shape. Reading it
    // directly would see zero vehicles for an ordinary application.
    const result = await bind(seed, { kind: "FINANCE", applicationId: f.applicationId }, vehicleId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.binding.claim._id)).toBe(String(f.claimId));
  });

  test("an incomplete pointer set is refused rather than searched", async () => {
    const seed = await seedDealer("f2");
    const first = await vehicle(seed);
    const second = await vehicle(seed);
    const f = await financeFixture(seed, [first, second]);
    // Only the first car was ever stamped; the set is missing an entry.

    const result = await bind(seed, { kind: "FINANCE", applicationId: f.applicationId }, first);
    expect(result).toEqual({
      ok: false,
      reason: "that finance application's episode pointers are incomplete",
    });
  });

  test("a duplicated pointer entry is refused", async () => {
    const seed = await seedDealer("f3");
    const vehicleId = await vehicle(seed);
    const f = await financeFixture(seed, [vehicleId]);
    await seed.t.run((ctx) =>
      ctx.db.patch(f.applicationId, {
        currentCommitmentClaims: [
          { vehicleId, claimId: f.claimId },
          { vehicleId, claimId: f.claimId },
        ],
      })
    );

    const result = await bind(seed, { kind: "FINANCE", applicationId: f.applicationId }, vehicleId);
    expect(result).toEqual({
      ok: false,
      reason: "that finance application names two episodes for the same vehicle",
    });
  });

  test("a pointer for a vehicle the application does not cover is refused", async () => {
    const seed = await seedDealer("f4");
    const covered = await vehicle(seed);
    const foreign = await vehicle(seed);
    const f = await financeFixture(seed, [covered]);
    await seed.t.run((ctx) =>
      ctx.db.patch(f.applicationId, {
        currentCommitmentClaims: [{ vehicleId: foreign, claimId: f.claimId }],
      })
    );

    const result = await bind(seed, { kind: "FINANCE", applicationId: f.applicationId }, covered);
    expect(result).toEqual({
      ok: false,
      reason: "that finance application names an episode for a vehicle it does not cover",
    });
  });

  test("a primary vehicle missing from its own list is refused", async () => {
    const seed = await seedDealer("f5");
    const primary = await vehicle(seed);
    const other = await vehicle(seed);
    const f = await financeFixture(seed, [primary]);
    await seed.t.run((ctx) =>
      ctx.db.patch(f.applicationId, {
        vehicleItems: [{ vehicleId: other, unitPrice: 30_000 }],
      })
    );

    const result = await bind(seed, { kind: "FINANCE", applicationId: f.applicationId }, primary);
    expect(result).toEqual({
      ok: false,
      reason: "that finance application's primary vehicle is missing from its own vehicle list",
    });
  });
});
