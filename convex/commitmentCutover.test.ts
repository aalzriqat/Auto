/**
 * SCRUM-208 — CUTOVER: the oracle, the shadow and the comparator.
 *
 * The headline contract here reproduces the SHIPPED defect rather than
 * describing it: 50 stale hold rows on voided deposits, and one genuinely live
 * deposit behind them. The legacy reader answers "nothing holds this car"; the
 * oracle answers correctly. That single case is why the legacy reader is a
 * drift comparator and never the truth.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { hasActiveDepositHold, hasActiveReservationHold } from "./utils/depositHelpers";
import {
  canonicalShadowDepositHold,
  canonicalShadowReservationHold,
  COMMITMENT_AUTHORITY_V1,
} from "./utils/commitmentKernel";
import {
  activationBlocked,
  comparePredicateForVehicle,
  oracleDepositHold,
  oracleReservationHold,
  readerForVersion,
  summarizeDrift,
} from "./utils/commitmentCutover";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

let vinCounter = 9000;

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
    ctx.db.insert("users", { clerkId: `c_${suffix}`, email: `${suffix}@t.com`, name: "U" })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "C",
      lastName: suffix,
      phone: `+96277${suffix}`,
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
      vin: `4HGCM82633A${String(vinCounter).slice(0, 6)}`,
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

async function deposit(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  fields: Partial<{
    status: "HELD" | "VOIDED";
    holdActive: boolean;
    isDeleted: boolean;
    usesVehicleHoldRows: boolean;
  }>
) {
  return await seed.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: seed.orgId,
      vehicleId,
      customerId: seed.customerId,
      amount: 500,
      status: fields.status ?? "HELD",
      holdActive: fields.holdActive ?? true,
      createdBy: seed.userId,
      createdAt: Date.now(),
      ...(fields.isDeleted !== undefined ? { isDeleted: fields.isDeleted } : {}),
      ...(fields.usesVehicleHoldRows !== undefined
        ? { usesVehicleHoldRows: fields.usesVehicleHoldRows }
        : {}),
    })
  );
}

async function holdRow(
  seed: Seed,
  depositId: Id<"deposits">,
  vehicleId: Id<"vehicles">,
  active: boolean
) {
  return await seed.t.run((ctx) =>
    ctx.db.insert("depositVehicleHolds", {
      orgId: seed.orgId,
      depositId,
      vehicleId,
      active,
      createdAt: Date.now(),
    })
  );
}

describe("the oracle is genuinely independent of the legacy reader", () => {
  test("50 stale rows hide a live deposit from the legacy reader, not from the oracle", async () => {
    const seed = await seedDealer("o1");
    const vehicleId = await vehicle(seed);

    // The shipped defect, reproduced: the legacy reader takes 50 rows keyed on
    // holdActive === true ALONE and post-filters status/isDeleted afterwards.
    for (let i = 0; i < 50; i += 1) {
      await deposit(seed, vehicleId, { status: "VOIDED", holdActive: true, isDeleted: true });
    }
    // ...and behind them, a genuinely live one.
    await deposit(seed, vehicleId, { usesVehicleHoldRows: false });

    const legacy = await seed.t.run((ctx) => hasActiveDepositHold(ctx, vehicleId));
    const oracle = await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId));

    // ⚠️ THIS IS WHY LEGACY IS A COMPARATOR AND NEVER THE TRUTH. Requiring the
    // canonical reader to agree with `false` here would require it to
    // reproduce the bug.
    expect(legacy).toBe(false);
    expect(oracle).toBe(true);
  });

  test("the canonical shadow agrees with the oracle where legacy cannot", async () => {
    const seed = await seedDealer("o2");
    const vehicleId = await vehicle(seed);
    for (let i = 0; i < 50; i += 1) {
      await deposit(seed, vehicleId, { status: "VOIDED", holdActive: true, isDeleted: true });
    }
    await deposit(seed, vehicleId, { usesVehicleHoldRows: false });

    const canonical = await seed.t.run((ctx) =>
      canonicalShadowDepositHold(ctx, seed.orgId, vehicleId)
    );
    expect(canonical).toBe(true);
  });

  test("legacy disagreement alone does not block activation", async () => {
    const seed = await seedDealer("o3");
    const vehicleId = await vehicle(seed);
    for (let i = 0; i < 50; i += 1) {
      await deposit(seed, vehicleId, { status: "VOIDED", holdActive: true, isDeleted: true });
    }
    await deposit(seed, vehicleId, { usesVehicleHoldRows: false });

    const row = await seed.t.run(async (ctx) =>
      comparePredicateForVehicle(ctx, {
        predicate: "DEPOSIT_HOLD",
        orgId: seed.orgId,
        vehicleId,
        oracle: () => oracleDepositHold(ctx, seed.orgId, vehicleId),
        legacy: () => hasActiveDepositHold(ctx as any, vehicleId),
        canonicalShadow: () => canonicalShadowDepositHold(ctx, seed.orgId, vehicleId),
      })
    );

    expect(row.legacyDisagrees).toBe(true);
    expect(row.canonicalDisagrees).toBe(false);
    expect(activationBlocked(summarizeDrift(seed.orgId, [row]))).toBe(false);
  });

  test("an un-backfilled deposit blocks activation, which is the whole point", async () => {
    const seed = await seedDealer("o4");
    const vehicleId = await vehicle(seed);
    // A live deposit with NO representation class — exactly the pre-cutover
    // state. The canonical range cannot see it, and that disagreement must
    // hold the flip until the backfill runs.
    await deposit(seed, vehicleId, {});

    const row = await seed.t.run(async (ctx) =>
      comparePredicateForVehicle(ctx, {
        predicate: "DEPOSIT_HOLD",
        orgId: seed.orgId,
        vehicleId,
        oracle: () => oracleDepositHold(ctx, seed.orgId, vehicleId),
        legacy: () => hasActiveDepositHold(ctx as any, vehicleId),
        canonicalShadow: () => canonicalShadowDepositHold(ctx, seed.orgId, vehicleId),
      })
    );

    expect(row.oracle).toBe(true);
    expect(row.canonical).toBe(false);
    expect(activationBlocked(summarizeDrift(seed.orgId, [row]))).toBe(true);
  });

  test("a vehicle the comparison could not reach blocks too", () => {
    // ⚠️ A SKIP IS NOT AN AGREEMENT. A green report over an incomplete
    // comparison is indistinguishable from a green report over a clean one.
    const report = summarizeDrift("org" as Id<"organizations">, [], [
      { vehicleId: "v" as Id<"vehicles">, reason: "vehicle row unreadable" },
    ]);
    expect(report.canonicalMatchesOracle).toBe(true);
    expect(activationBlocked(report)).toBe(true);
  });
});

describe("the reservation predicate does NOT share the defect", () => {
  test("a never-expiring ACTIVE reservation is live to both readers", async () => {
    const seed = await seedDealer("r1");
    const vehicleId = await vehicle(seed);
    await seed.t.run((ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        status: "ACTIVE" as const,
        reservedBy: seed.userId,
        reservedAt: Date.now(),
      })
    );
    const now = Date.now();

    const oracle = await seed.t.run((ctx) =>
      oracleReservationHold(ctx, seed.orgId, vehicleId, now)
    );
    const legacy = await seed.t.run((ctx) =>
      hasActiveReservationHold(ctx as any, { orgId: seed.orgId, vehicleId })
    );
    const canonical = await seed.t.run((ctx) =>
      canonicalShadowReservationHold(ctx, seed.orgId, vehicleId, now)
    );

    // ⚠️ THE ASYMMETRY IS THE SIGNAL. Only the deposit reader carries the
    // capped-read defect, so unexplained RESERVATION drift indicts the
    // canonical reader rather than the legacy one.
    expect([oracle, legacy, canonical]).toEqual([true, true, true]);
  });

  test("an ACTIVE reservation past its expiry is unswept, not live", async () => {
    const seed = await seedDealer("r2");
    const vehicleId = await vehicle(seed);
    const now = Date.now();
    await seed.t.run((ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        status: "ACTIVE" as const,
        expiresAt: now - 1,
        reservedBy: seed.userId,
        reservedAt: now - 1000,
      })
    );

    expect(await seed.t.run((ctx) => oracleReservationHold(ctx, seed.orgId, vehicleId, now))).toBe(
      false
    );
    expect(
      await seed.t.run((ctx) => canonicalShadowReservationHold(ctx, seed.orgId, vehicleId, now))
    ).toBe(false);
  });
});

describe("the dispatcher is for runtime only", () => {
  test("version selects the reader", () => {
    expect(readerForVersion("V1")).toBe("CANONICAL");
    expect(readerForVersion("LEGACY")).toBe("LEGACY");
  });
});

/**
 * SCRUM-208 c16192 — THE HOLD-ROW HALF OF THE ORACLE.
 *
 * ⚠️ WHY THIS BLOCK EXISTS. Every fixture above seeds `deposits` and NEVER
 * `depositVehicleHolds`. So the hold-row half of `oracleDepositHold` had never
 * executed once: not the first loop's body, not a NON-EMPTY result from the
 * inner existence probe, not the terminal `false`. A mutant forcing the probe
 * to answer "empty" survived the whole suite. Both adversarial seats measured
 * that gap independently, and it sits on an oracle whose disagreement BLOCKS
 * activation — a wrong oracle mis-certifies the cutover.
 *
 * ⚠️ EVERY NON-EMPTY FIXTURE HERE KEEPS THE FIRST LOOP SILENT ON THE CAR UNDER
 * TEST. That is the load-bearing part of the design, not a detail: if the first
 * loop could return `true` on its own, a probe test would pass without the probe
 * ever deciding anything — passing for the wrong reason about the very line it
 * names. Each test below says which loop is allowed to answer.
 *
 * These assert the ORACLE only. The canonical shadow is compared against it in
 * the blocks above; re-asserting agreement here would test a second contract
 * under a name that promises one.
 */
describe("the oracle reads hold rows, not merely the deposit's own vehicleId", () => {
  test("a live slice on THIS car is a hold — only the first loop can answer", async () => {
    const seed = await seedDealer("h1");
    const vehicleId = await vehicle(seed);
    const elsewhere = await vehicle(seed);
    // The deposit's own `vehicleId` names a DIFFERENT car, so the second loop
    // never reaches this vehicle. The first loop's body is the only decider.
    const depositId = await deposit(seed, elsewhere, {});
    await holdRow(seed, depositId, vehicleId, true);

    expect(await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId))).toBe(true);
  });

  test("a slice whose parent deposit is VOIDED is not a hold", async () => {
    const seed = await seedDealer("h2");
    const vehicleId = await vehicle(seed);
    const elsewhere = await vehicle(seed);
    // Same shape as above, but the parent fails `depositUsable`. This pins the
    // first loop's parent check specifically — the row itself is ACTIVE.
    const depositId = await deposit(seed, elsewhere, { status: "VOIDED" });
    await holdRow(seed, depositId, vehicleId, true);

    expect(await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId))).toBe(false);
  });

  test("a deposit whose ONE slice moved off this car does not hold it", async () => {
    const seed = await seedDealer("h3");
    const vehicleId = await vehicle(seed);
    const elsewhere = await vehicle(seed);
    // The deposit still NAMES this car, so the second loop does reach it...
    const depositId = await deposit(seed, vehicleId, {});
    // ...but its slices say it holds a different one, and hold rows are the
    // whole truth for a deposit that has any. No slice points at this car, so
    // the first loop stays silent and the PROBE alone decides.
    await holdRow(seed, depositId, elsewhere, true);

    expect(await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId))).toBe(false);
  });

  test("MULTIPLE slices elsewhere are still not a hold on this car", async () => {
    const seed = await seedDealer("h4");
    const vehicleId = await vehicle(seed);
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const c = await vehicle(seed);
    const depositId = await deposit(seed, vehicleId, {});
    // Three rows rather than one: `.first()` must answer "non-empty" the same
    // way it does for a single row. Again none names this car, so the first
    // loop stays silent.
    await holdRow(seed, depositId, a, true);
    await holdRow(seed, depositId, b, true);
    await holdRow(seed, depositId, c, false);

    expect(await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId))).toBe(false);
  });

  test("an INACTIVE slice on this car is a row, and still not a hold", async () => {
    const seed = await seedDealer("h5");
    const vehicleId = await vehicle(seed);
    const depositId = await deposit(seed, vehicleId, {});
    // The row IS on this car, so it proves the range non-empty — but it is not
    // active, so the first loop skips it. The deposit therefore holds nothing
    // here, and the probe's non-empty answer is what prevents the scalar
    // `vehicleId` fallback from wrongly reporting a hold.
    await holdRow(seed, depositId, vehicleId, false);

    expect(await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId))).toBe(false);
  });

  test("a deposit with NO slices at all falls back to its own vehicleId", async () => {
    const seed = await seedDealer("h6");
    const vehicleId = await vehicle(seed);
    await deposit(seed, vehicleId, {});

    // The contrast case for the three above: an EMPTY range is what licenses
    // the fallback. This is the only shape in which the probe may answer true.
    expect(await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId))).toBe(true);
  });

  test("a car nothing holds reaches the terminal false", async () => {
    const seed = await seedDealer("h7");
    const vehicleId = await vehicle(seed);

    // No deposits and no slices: both loops run to exhaustion and the function
    // returns from its final statement, which nothing else exercises.
    expect(await seed.t.run((ctx) => oracleDepositHold(ctx, seed.orgId, vehicleId))).toBe(false);
  });
});
