/**
 * SCRUM-208 c15814 — AUTHORITY SETTLEMENT HAS A REAL ROLLBACK BOUNDARY.
 *
 * ⚠️ THIS IS THE FILE THAT PROVES THE STRUCTURAL SPLIT, so it is worth being
 * exact about what was wrong before it.
 *
 * Settlement used to run inside `accountingOutbox.markEntryPosted`, under
 * `drainEntries`' per-row `try`/`catch`. That catch is correct for accounting —
 * one bad row must not abort an organization's whole drain — but it made the
 * authority half un-rollbackable. An unexpected failure AFTER a successor root,
 * claim or pointer had been written was caught, the mutation returned normally
 * and COMMITTED the partial state, which was then labelled INCONSISTENT.
 * Truthful about failure, and still a half-restoration on a money path.
 *
 * Three rounds of guards closed every failure path anyone enumerated. None of
 * them could prove the next unenumerated one impossible — and "all four or
 * none" is the property c15808's postcondition actually demands.
 *
 * So each source episode now settles in `performAuthoritySettlement`, a
 * registered mutation of its own. A throw there aborts that transaction and
 * nothing else. The contracts below are what that buys, and each one fails if
 * settlement is ever moved back under the drain's catch.
 *
 * ⚠️ THE FAILURE IS INJECTED AFTER THE AUTHORITY WRITES, DELIBERATELY.
 * `syncVehicleHoldStatus` is the last thing `restoreAuthorityAfterReversal`
 * calls — by then the source is live, the successor root and claim exist and
 * the pointer has moved. A guard that only refused BEFORE writing would pass a
 * test that threw early, and prove nothing about the boundary.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { acquireVehicle, consumeRootForSale } from "./commitments";
import { COMMITMENT_AUTHORITY_V1 } from "./utils/commitmentKernel";
import { seedAuthorityEvent, seedAuthorityWork, settleThroughWorkers } from "../test-utils/authorityWork";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * The injection point. Off by default, so every other contract in this file
 * exercises the real function.
 */
const inject = { failProjection: false };

vi.mock("./utils/depositHelpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/depositHelpers")>();
  return {
    ...actual,
    syncVehicleHoldStatus: async (...args: Parameters<typeof actual.syncVehicleHoldStatus>) => {
      if (inject.failProjection) {
        // A plain Error, not a ConvexError: this stands in for an unexpected
        // technical fault, which is exactly the class that must roll back
        // rather than be described.
        throw new Error("INJECTED PROJECTION FAILURE");
      }
      return actual.syncVehicleHoldStatus(...args);
    },
  };
});

let vin = 7000;

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
      phone: `+96279${suffix}0001`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, customerId };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

/**
 * A deal whose sale was cancelled with the reversal deferred: the deposit is
 * still HELD, its hold is DOWN, and the root is CONSUMED by the cancelled sale.
 * Exactly the state a real deferred cancellation leaves behind.
 */
async function deferredCancelledDeal(seed: Seed) {
  vin += 1;
  const vehicleId = await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `5HGCM82633A${String(vin)}`,
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
  const depositId = await seed.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: seed.orgId,
      vehicleId,
      customerId: seed.customerId,
      amount: 1_000,
      status: "HELD" as const,
      holdActive: false,
      usesVehicleHoldRows: false,
      createdBy: seed.userId,
      createdAt: Date.now(),
    })
  );
  const saleId = await seed.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: seed.orgId,
      vehicleId,
      customerId: seed.customerId,
      salespersonId: seed.userId,
      salePrice: 30_000,
      saleDate: Date.now(),
      status: "CANCELLED" as const,
    })
  );
  await seed.t.run((ctx) =>
    acquireVehicle(ctx, {
      orgId: seed.orgId,
      vehicleId,
      customerId: seed.customerId,
      createdBy: seed.userId,
      evidence: { kind: "DEPOSIT", depositId },
      lineage: { depositId },
    })
  );
  await seed.t.run((ctx) =>
    consumeRootForSale(ctx, {
      orgId: seed.orgId,
      vehicleId,
      saleId,
      reason: "sale completed",
      decisionNow: Date.now(),
    })
  );
  return { vehicleId, depositId, saleId };
}

/** Everything the authority may have written, read back from the database. */
async function residue(seed: Seed, depositId: Id<"deposits">) {
  return await seed.t.run(async (ctx) => {
    const roots = await ctx.db.query("commitmentRoots").collect();
    const claims = await ctx.db.query("vehicleCommitmentClaims").collect();
    const deposit = await ctx.db.get(depositId);
    return {
      openRoots: roots.filter((r) => r.status === "OPEN").length,
      claims: claims.length,
      pointer: deposit?.singleVehicleCommitmentClaimId ?? null,
      holdActive: deposit?.holdActive,
    };
  });
}

const workFor = async (seed: Seed, deal: { vehicleId: Id<"vehicles">; depositId: Id<"deposits">; saleId: Id<"sales"> }, key: string) => {
  const eventId = await seedAuthorityEvent(seed.t, seed.orgId, seed.userId, key);
  const [workId] = await seedAuthorityWork(seed.t, seed.orgId, eventId, [
    { kind: "DIRECT", depositId: deal.depositId, vehicleId: deal.vehicleId, saleId: deal.saleId },
  ]);
  return { eventId, workId };
};

describe("an unexpected failure after an authority write", () => {
  /**
   * ⚠️ THE CONTROL RUNS FIRST, AND IT MATTERS.
   *
   * Without it, the rollback contract below would prove only that "something
   * failed" — not that the injection caused it. A fixture that could never have
   * restored anyway would produce identical assertions.
   */
  test("CONTROL — the same deal restores cleanly when nothing is injected", async () => {
    inject.failProjection = false;
    const seed = await seedDealer("c1");
    const deal = await deferredCancelledDeal(seed);
    const { eventId, workId } = await workFor(seed, deal, "reversed_control_1");

    const summary = await settleThroughWorkers(seed.t, [workId], eventId);
    expect(summary?.outcome).toBe("RESTORED");

    const after = await residue(seed, deal.depositId);
    expect(after.openRoots, "a successor root was opened").toBe(1);
    expect(after.holdActive, "and the money holds its car again").toBe(true);
    expect((await seed.t.run((ctx) => ctx.db.get(workId)))?.status).toBe("SETTLED");
  });

  test("rolls back every authority write, and leaves the work still owed", async () => {
    const seed = await seedDealer("r1");
    const deal = await deferredCancelledDeal(seed);
    const before = await residue(seed, deal.depositId);
    const { eventId, workId } = await workFor(seed, deal, "reversed_rollback_1");

    inject.failProjection = true;
    try {
      // ⚠️ IT REJECTS. Nothing converts this into a recorded outcome, because
      // doing so from inside this mutation would commit the writes it made.
      await expect(settleThroughWorkers(seed.t, [workId], eventId)).rejects.toThrow(
        /INJECTED PROJECTION FAILURE/
      );
    } finally {
      inject.failProjection = false;
    }

    // ⚠️ BYTE-IDENTICAL. This is the contract the previous three rounds could
    // not provide: the failure landed AFTER the source was made live and after
    // the successor root, claim and pointer were written, and none of it
    // survived.
    const after = await residue(seed, deal.depositId);
    expect(after.openRoots, "no successor root committed").toBe(before.openRoots);
    expect(after.claims, "no successor claim committed").toBe(before.claims);
    expect(after.pointer, "the source pointer did not move").toBe(before.pointer);
    expect(after.holdActive, "and the source was not left live").toBe(before.holdActive);

    // Still owed, and still findable — not silently finished, not lost.
    const work = await seed.t.run((ctx) => ctx.db.get(workId));
    expect(work?.status, "the episode remains retryable").toBe("PENDING");
    expect(work?.outcome, "and claims no outcome it never reached").toBeUndefined();

    // The accounting row is untouched by a settlement that did not happen.
    const event = await seed.t.run((ctx) => ctx.db.get(eventId));
    expect(event?.status, "accounting stayed final and independent").toBe("POSTED");
    expect(event?.authorityOutcome).toBeUndefined();
  });

  test("and the retry settles it, once the fault is gone", async () => {
    const seed = await seedDealer("r2");
    const deal = await deferredCancelledDeal(seed);
    const { eventId, workId } = await workFor(seed, deal, "reversed_retry_1");

    inject.failProjection = true;
    try {
      await expect(settleThroughWorkers(seed.t, [workId], eventId)).rejects.toThrow();
    } finally {
      inject.failProjection = false;
    }

    // The same work item, tried again — which is only possible because the
    // failure left it PENDING rather than terminal.
    const summary = await settleThroughWorkers(seed.t, [workId], eventId);
    expect(summary?.outcome).toBe("RESTORED");
    expect((await residue(seed, deal.depositId)).openRoots).toBe(1);
  });
});

describe("at-most-once settlement", () => {
  test("running the worker twice does not open a second successor", async () => {
    inject.failProjection = false;
    const seed = await seedDealer("o1");
    const deal = await deferredCancelledDeal(seed);
    const { eventId, workId } = await workFor(seed, deal, "reversed_once_1");

    await settleThroughWorkers(seed.t, [workId], eventId);
    const afterFirst = await residue(seed, deal.depositId);

    // ⚠️ A duplicate schedule, a re-drained accounting row and the retry sweep
    // can all land on the same work item. The terminal check is what stops a
    // second root or claim being minted; nothing about the ordering is relied
    // on.
    await settleThroughWorkers(seed.t, [workId], eventId);

    const afterSecond = await residue(seed, deal.depositId);
    expect(afterSecond.openRoots, "no second successor root").toBe(afterFirst.openRoots);
    expect(afterSecond.claims, "no second successor claim").toBe(afterFirst.claims);
    expect(afterSecond.pointer, "and the pointer did not move again").toBe(afterFirst.pointer);
  });
});
