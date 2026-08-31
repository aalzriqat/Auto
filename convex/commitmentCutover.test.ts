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
