/**
 * SCRUM-208 — A CAR COMES BACK ONLY AFTER ITS REVERSING JOURNAL EXISTS.
 *
 * The defect these contracts close: cancelling a sale whose accounting
 * reversal had to be DEFERRED still put a single-vehicle deposit's car back on
 * hold immediately. On a direct deposit `holdActive` IS the car hold, so the
 * car was held again against an entry the ledger still showed posted.
 *
 * The multi-vehicle path already gated its slice on `journalReversed` and says
 * so in a comment. The direct path did not. Same shape as every other defect
 * this phase found: the rule was pinned on the branch somebody was looking at
 * and missing from its neighbour.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { completeDeferredReversal } from "./utils/depositApplications";
import { reinstateDirectDepositHold } from "./utils/commitmentWriters";
import { settleFreedHoldsAuthority } from "./accountingOutbox";
import { acquireVehicle } from "./commitments";
import { cancelCompletedSaleOperationalRecords } from "./utils/saleCancellation";
import { COMMITMENT_AUTHORITY_V1 } from "./utils/commitmentKernel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

let vinCounter = 7000;

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
    ctx.db.insert("users", { clerkId: `d_${suffix}`, email: `${suffix}@t.com`, name: "U" })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "C",
      lastName: suffix,
      phone: `+96276${suffix}`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "D",
      lastName: suffix,
      phone: `+96275${suffix}`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, customerId, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function vehicle(seed: Seed) {
  vinCounter += 1;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `5HGCM82633A${String(vinCounter).slice(0, 6)}`,
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

/**
 * A direct deposit whose sale was cancelled while the reversing journal is
 * still queued: money back to HELD, but the car deliberately NOT re-held.
 */
async function deferredDirectCancellation(seed: Seed) {
  const vehicleId = await vehicle(seed);
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
  const depositId = await seed.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: seed.orgId,
      vehicleId,
      customerId: seed.customerId,
      amount: 1_000,
      status: "HELD" as const,
      // ⚠️ THE STATE THE CANCELLATION LEAVES BEHIND on a deferred reversal.
      holdActive: false,
      usesVehicleHoldRows: false,
      createdBy: seed.userId,
      createdAt: Date.now(),
    })
  );
  const key = `apply_${depositId}`;
  await seed.t.run((ctx) =>
    ctx.db.insert("depositApplications", {
      orgId: seed.orgId,
      depositId,
      vehicleId,
      saleId,
      customerId: seed.customerId,
      amountMinor: 100_000,
      currency: "JOD",
      treatment: "CUSTOMER_RECEIVABLE" as const,
      eventType: "deposit.applied",
      eventSourceType: "depositApplications",
      eventSourceId: String(depositId),
      eventVersion: 1,
      eventIdempotencyKey: key,
      // REVERSING: the reversing entry is queued and the original is still
      // POSTED. Nothing downstream may treat the amount as recovered.
      status: "REVERSING" as const,
      appliedAt: Date.now(),
      appliedBy: seed.userId,
    })
  );
  return { vehicleId, saleId, depositId, reversalKey: `reversed_${key}` };
}

const completion = async (seed: Seed, reversalKey: string) =>
  await seed.t.run((ctx) =>
    completeDeferredReversal(ctx, {
      orgId: seed.orgId,
      reversalIdempotencyKey: reversalKey,
      postedAt: Date.now(),
    })
  );

const settle = async (seed: Seed, sources: Awaited<ReturnType<typeof completion>>) =>
  await seed.t.run((ctx) =>
    settleFreedHoldsAuthority(ctx, seed.orgId, sources, Date.now())
  );

describe("while the reversing journal is only queued", () => {
  /**
   * Drives the REAL cancellation door.
   *
   * ⚠️ THIS HAD TO GO THROUGH `cancelCompletedSaleOperationalRecords`. A first
   * version of this contract built the post-cancellation state by hand and
   * asserted it — which asserts the FIXTURE, not the gate. Forcing
   * `reinstateHold: true` back into the code left that version green, so it
   * was covering nothing. With no chart of accounts the reversal necessarily
   * DEFERS, which is exactly the branch under test.
   */
  async function cancelWithDeferredReversal(seed: Seed, options: { posted?: boolean } = {}) {
    const vehicleId = await vehicle(seed);
    const saleId = await seed.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        salespersonId: seed.userId,
        salePrice: 30_000,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
      })
    );
    const depositId = await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        amount: 1_000,
        // As a completed sale leaves it: consumed, and its car released.
        status: "APPLIED" as const,
        holdActive: false,
        usesVehicleHoldRows: false,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );
    await seed.t.run((ctx) =>
      ctx.db.insert("depositApplications", {
        orgId: seed.orgId,
        depositId,
        vehicleId,
        saleId,
        customerId: seed.customerId,
        amountMinor: 100_000,
        currency: "JOD",
        treatment: "CUSTOMER_RECEIVABLE" as const,
        eventType: "deposit.applied",
        eventSourceType: "depositApplications",
        eventSourceId: String(depositId),
        eventVersion: 1,
        eventIdempotencyKey: `apply_${depositId}`,
        status: "APPLIED" as const,
        appliedAt: Date.now(),
        appliedBy: seed.userId,
      })
    );

    if (options.posted) {
      // ⚠️ THE ORIGINAL ENTRY, STILL POSTED. With it present the reversal has
      // something real to back out and — with no chart or open period — must
      // QUEUE that work, which is the DEFERRED branch. Without it the reversal
      // resolves to NOT_POSTED and finishes inside the cancellation.
      await seed.t.run((ctx) =>
        ctx.db.insert("accountingEvents", {
          orgId: seed.orgId,
          eventType: "DEPOSIT_APPLIED",
          sourceType: "depositApplications",
          sourceId: String(depositId),
          eventVersion: 1,
          idempotencyKey: `apply_${depositId}`,
          occurredAt: Date.now(),
          accountingDate: Date.now(),
          currency: "JOD",
          payload: {},
          status: "POSTED" as const,
          createdBy: seed.userId,
          createdAt: Date.now(),
        })
      );
    }

    const sale = (await seed.t.run((ctx) => ctx.db.get(saleId)))!;
    await seed.t.run((ctx) =>
      cancelCompletedSaleOperationalRecords(ctx, {
        orgId: seed.orgId,
        sale,
        actorId: seed.userId,
        reason: "cancelled in test",
        reversalDate: Date.now(),
      })
    );
    return { vehicleId, saleId, depositId };
  }

  test("the NOT_POSTED control restores atomically inside the cancellation", async () => {
    const seed = await seedDealer("q0");
    const f = await cancelWithDeferredReversal(seed, { posted: false });

    const application = (
      await seed.t.run((ctx) => ctx.db.query("depositApplications").collect())
    )[0];
    // Nothing was ever posted, so there is nothing to wait for: the reversal
    // completes inside the cancellation mutation...
    expect(application.status).toBe("REVERSED");
    // ...and the car comes back in that same transaction.
    const deposit = await seed.t.run((ctx) => ctx.db.get(f.depositId));
    expect(deposit?.status).toBe("HELD");
    expect(deposit?.holdActive).toBe(true);
  });

  test("the car stays un-held and no successor exists", async () => {
    const seed = await seedDealer("q1");
    const f = await cancelWithDeferredReversal(seed, { posted: true });

    const application = (
      await seed.t.run((ctx) => ctx.db.query("depositApplications").collect())
    )[0];
    // The reversal really did defer — otherwise this contract proves nothing.
    expect(application.status).toBe("REVERSING");

    const deposit = await seed.t.run((ctx) => ctx.db.get(f.depositId));
    // ⚠️ THE WHOLE POINT. Re-holding here would hold a car against an entry
    // the ledger still shows credited against the customer's invoice. The
    // MONEY comes back out of APPLIED; the CAR waits for the journal.
    expect(deposit?.status).toBe("HELD");
    expect(deposit?.holdActive).toBe(false);

    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const claims = await seed.t.run((ctx) =>
      ctx.db.query("vehicleCommitmentClaims").collect()
    );
    expect(roots).toHaveLength(0);
    expect(claims).toHaveLength(0);
  });
});

describe("when the reversing journal finally posts", () => {
  test("the exact source is reported — a direct deposit, with no hold row invented", async () => {
    const seed = await seedDealer("q2");
    const f = await deferredDirectCancellation(seed);

    const sources = await completion(seed, f.reversalKey);
    expect(sources).toEqual([
      {
        kind: "DIRECT",
        depositId: f.depositId,
        vehicleId: f.vehicleId,
        saleId: f.saleId,
      },
    ]);

    // ⚠️ NO FABRICATED SLICE. A single-vehicle quote has no hold rows, and
    // inventing one to make the shapes uniform would put a hold on a car whose
    // money never had one.
    const holds = await seed.t.run((ctx) => ctx.db.query("depositVehicleHolds").collect());
    expect(holds).toHaveLength(0);
  });

  test("the car comes back, and only once", async () => {
    const seed = await seedDealer("q3");
    const f = await deferredDirectCancellation(seed);
    const sources = await completion(seed, f.reversalKey);

    expect((await settle(seed, sources))?.outcome).toBe("RESTORED");
    expect((await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive).toBe(true);

    // ⚠️ AT MOST ONCE, DECIDED FROM PERSISTED STATE. A second completion — a
    // redrive, a duplicate queue entry — finds the work done and changes
    // nothing. Nothing here remembers what the drain has already seen.
    const before = await seed.t.run((ctx) => ctx.db.query("deposits").collect());
    expect((await settle(seed, sources))?.outcome).toBe("RESTORED");
    expect(await seed.t.run((ctx) => ctx.db.query("deposits").collect())).toEqual(before);
  });

  test("a rival holding the car keeps it; the money still comes back to the customer", async () => {
    const seed = await seedDealer("q4");
    const f = await deferredDirectCancellation(seed);
    // Someone else took the car while the reversal sat in the queue.
    const rivalReservation = await seed.t.run((ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: seed.orgId,
        vehicleId: f.vehicleId,
        customerId: seed.customerB,
        status: "ACTIVE" as const,
        reservedBy: seed.userId,
        reservedAt: Date.now(),
      })
    );
    await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId: f.vehicleId,
        customerId: seed.customerB,
        createdBy: seed.userId,
        evidence: { kind: "RESERVATION", reservationId: rivalReservation },
        lineage: { reservationId: rivalReservation },
      })
    );

    const sources = await completion(seed, f.reversalKey);
    const outcome = await settle(seed, sources);

    // ⚠️ A RIVAL NEVER HAS ITS VEHICLE TAKEN — and the ACCOUNTING STILL STANDS.
    expect(outcome?.outcome).toBe("ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL");
    expect((await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive).toBe(false);
    const application = await seed.t.run((ctx) =>
      ctx.db.query("depositApplications").collect()
    );
    expect(application[0].status).toBe("REVERSED");
  });

  test("ambiguous ownership is reported, and nothing is written", async () => {
    const seed = await seedDealer("q5");
    const f = await deferredDirectCancellation(seed);
    for (const customerId of [seed.customerId, seed.customerB]) {
      await seed.t.run((ctx) =>
        ctx.db.insert("commitmentRoots", {
          orgId: seed.orgId,
          vehicleId: f.vehicleId,
          customerId,
          status: "OPEN" as const,
          openedAt: Date.now(),
          openedBy: seed.userId,
          lineageGeneration: 0,
        })
      );
    }

    const sources = await completion(seed, f.reversalKey);
    const rootsBefore = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const outcome = await settle(seed, sources);

    expect(outcome).toEqual({
      outcome: "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS",
      detail: "2 open commitment roots on this vehicle",
    });
    // The accounting completion stands; the car is left byte-identical.
    expect((await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive).toBe(false);
    expect(await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect())).toEqual(
      rootsBefore
    );
  });

  test("money that has left the business is never re-held", async () => {
    const seed = await seedDealer("q6");
    const f = await deferredDirectCancellation(seed);
    // Refunded while the reversal was queued: putting the car back on hold for
    // it would make that money spendable a second time.
    await seed.t.run((ctx) => ctx.db.patch(f.depositId, { status: "REFUNDED" as const }));

    const sources = await completion(seed, f.reversalKey);
    await settle(seed, sources);
    expect((await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive).toBe(false);
  });
});

describe("completion order does not change where things end up", () => {
  test("two sources settled in opposite orders converge to the same state", async () => {
    const snapshot = async (seed: Seed) => ({
      deposits: (await seed.t.run((ctx) => ctx.db.query("deposits").collect())).map((d) => ({
        vehicleId: String(d.vehicleId),
        holdActive: d.holdActive,
        status: d.status,
      })),
      roots: (await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect())).length,
    });

    const run = async (reverseOrder: boolean) => {
      const seed = await seedDealer(reverseOrder ? "c1" : "c2");
      const first = await deferredDirectCancellation(seed);
      const second = await deferredDirectCancellation(seed);
      const sources = [
        ...(await completion(seed, first.reversalKey)),
        ...(await completion(seed, second.reversalKey)),
      ];
      await settle(seed, reverseOrder ? [...sources].reverse() : sources);
      return await snapshot(seed);
    };

    // ⚠️ THE QUEUE DOES NOT PROMISE AN ORDER. Restoration is decided from
    // persisted state per source, so the drain order cannot change the
    // destination — only which entry gets there first.
    const forwards = await run(false);
    const backwards = await run(true);
    expect(new Set(forwards.deposits.map((d) => d.holdActive))).toEqual(new Set([true]));
    expect(forwards.roots).toBe(backwards.roots);
    expect(forwards.deposits.map((d) => d.holdActive).sort()).toEqual(
      backwards.deposits.map((d) => d.holdActive).sort()
    );
  });
});

describe("the direct re-hold writer refuses what it must", () => {
  const attempt = async (seed: Seed, depositId: Id<"deposits">) =>
    await seed.t.run((ctx) =>
      reinstateDirectDepositHold(ctx, { orgId: seed.orgId, depositId })
    );

  test("a sliced deposit is never re-held through the direct writer", async () => {
    const seed = await seedDealer("w1");
    const f = await deferredDirectCancellation(seed);
    await seed.t.run((ctx) => ctx.db.patch(f.depositId, { usesVehicleHoldRows: true }));

    expect(await attempt(seed, f.depositId)).toBeNull();
    expect((await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive).toBe(false);
  });

  test("a legacy deposit with no representation class fails closed", async () => {
    const seed = await seedDealer("w2");
    const f = await deferredDirectCancellation(seed);
    await seed.t.run((ctx) => ctx.db.patch(f.depositId, { usesVehicleHoldRows: undefined }));

    // ⚠️ `undefined` IS NOT `false`. SCRUM-201's cutover owns these rows.
    expect(await attempt(seed, f.depositId)).toBeNull();
    expect((await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive).toBe(false);
  });

  test("another dealership's deposit is refused", async () => {
    const seed = await seedDealer("w3");
    const f = await deferredDirectCancellation(seed);
    const otherOrg = await seed.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() })
    );
    await seed.t.run((ctx) => ctx.db.patch(f.depositId, { orgId: otherOrg }));

    expect(await attempt(seed, f.depositId)).toBeNull();
  });
});
