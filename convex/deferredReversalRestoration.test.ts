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
import { AUTHORITY_SEVERITY } from "./accountingOutbox";
import {
  readAttempts,
  seedAuthorityEvent,
  seedAuthorityWork,
  settleThroughWorkers,
  type SettleSource,
} from "../test-utils/authorityWork";
import { acquireVehicle, consumeRootForSale } from "./commitments";
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
  // ⚠️ A REAL DEAL BEHIND THE MONEY, TERMINALIZED BY THE REAL WRITER.
  //
  // This fixture used to stop at the deposit row, so the car it described had
  // no commitment root at all — and the contract that asserted the car "comes
  // back" was passing against a vehicle no deal had ever held. Restoration
  // needs something to restore, and `consumeRootForSale` is what a completed
  // sale actually does: it patches the ROOT and leaves the episode ACTIVE.
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

/**
 * ⚠️ SETTLEMENT NOW RUNS THROUGH ITS REAL DOOR, ONE EPISODE AT A TIME.
 *
 * It used to be a single in-drain loop (`settleFreedHoldsAuthority`) whose
 * `try`/`catch` turned any unexpected failure into a recorded INCONSISTENT
 * outcome — from inside `drainEntries`' transaction, so the authority writes
 * made before the failure committed anyway. Each source episode now settles in
 * `performAuthoritySettlement`, a registered mutation of its own.
 *
 * ⚠️ AND THIS HELPER DOES NOT CATCH. A throw is now the CONTRACT — it is what
 * rolls the episode's writes back — so a test that expects one asserts
 * `.rejects` and then proves nothing was written.
 */
let settleSeq = 0;
const settle = async (seed: Seed, sources: SettleSource[]) => {
  const eventId = await seedAuthorityEvent(
    seed.t,
    seed.orgId,
    seed.userId,
    `reversed_seq_${(settleSeq += 1)}`
  );
  const workIds = await seedAuthorityWork(seed.t, seed.orgId, eventId, sources);
  return await settleThroughWorkers(seed.t, workIds, eventId);
};

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

  /**
   * SCRUM-208 — THE WRITER'S ADMISSIBILITY RULE MATCHES ITS OWN READER'S.
   *
   * Found by Codex against 170c5c9f0. `resolveCanonicalBinding` computes
   * `depositUsable` as `status === "HELD" && isDeleted !== true`, and the
   * writer checked only the status half. A deleted row would have been put
   * back on hold and then reported as not live by the very next read.
   *
   * No production door writes `HELD + isDeleted` today — `voidDeposit` sets
   * VOIDED and `holdActive: false` in the same patch, and `deposits` is not an
   * `adminData` table — so this is a guard against the next door, not a repair
   * of a live path. It is asserted rather than assumed precisely because
   * "nothing can reach it" is the claim that stopped being true twice already.
   */
  test("a deleted deposit is never re-held, because the binding would not call it live", async () => {
    const seed = await seedDealer("w4");
    const f = await deferredDirectCancellation(seed);
    await seed.t.run((ctx) => ctx.db.patch(f.depositId, { isDeleted: true }));

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


// ═════════════════════════════════════════════════════════════════════════════
// SCRUM-208 c15810 — THE CUSTOMER'S OWN SECOND INSTALMENT IS NOT A RIVAL
//
// Found by Codex against 6f7d1b5c3 and reproduced before being fixed. The
// deferred drain used to take its OWN `resolveOwnership` reading before
// reinstating a hold, and treat ANY owned root as a rival. On a deal paid in
// two instalments with both reversals deferred, the first instalment restored
// the deal — and the second was then reported as a rival OF ITS OWN CUSTOMER'S
// root, leaving that money HELD with no active hold and no episode. Invisible
// to the canonical reader, so releasing the first deposit afterwards would free
// the car while the dealership still held the second customer's money.
//
// The resolver has always been able to answer this correctly (JOIN_LINEAGE).
// The caller simply was not asking it.
// ═════════════════════════════════════════════════════════════════════════════

describe("a deal paid in instalments", () => {
  /**
   * Two deposits on ONE deal, both reversals deferred.
   *
   * ⚠️ THE SHARED QUOTE IS THE LINEAGE PROOF, and it has to be. A first
   * reproduction attempt gave the second deposit its own id as lineage and the
   * authority correctly REFUSED it as an independent deal — which is the
   * product's real behaviour, not the scenario. A second instalment belongs to
   * the same deal because it is on the same quote.
   */
  async function twoInstalmentsDeferred(seed: Seed) {
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
    const quoteId = await seed.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId,
        mode: "CASH" as const,
        vehiclePrice: 30_000,
        downPayment: 0,
        termMonths: 0,
        status: "DRAFT" as const,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );

    const instalment = async (tag: string) => {
      const depositId = await seed.t.run((ctx) =>
        ctx.db.insert("deposits", {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerId,
          quoteId,
          amount: 1_000,
          status: "HELD" as const,
          // As a deferred cancellation leaves it: money back, car not re-held.
          holdActive: false,
          usesVehicleHoldRows: false,
          createdBy: seed.userId,
          createdAt: Date.now(),
        })
      );
      await seed.t.run((ctx) =>
        acquireVehicle(ctx, {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerId,
          createdBy: seed.userId,
          evidence: { kind: "DEPOSIT", depositId },
          lineage: { quoteId },
        })
      );
      const key = `apply_${tag}_${depositId}`;
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
          status: "REVERSING" as const,
          appliedAt: Date.now(),
          appliedBy: seed.userId,
        })
      );
      return { depositId, reversalKey: `reversed_${key}` };
    };

    const first = await instalment("one");
    const second = await instalment("two");

    // The REAL finalization writer: it patches the ROOT and nothing else.
    await seed.t.run((ctx) =>
      consumeRootForSale(ctx, {
        orgId: seed.orgId,
        vehicleId,
        saleId,
        reason: "sale completed",
        decisionNow: Date.now(),
      })
    );
    return { vehicleId, saleId, quoteId, first, second };
  }

  // Complete one instalment's reversal, then settle its freed episodes through
  // the real per-source worker — the two halves that are now separate
  // transactions in production.
  const drainOne = async (seed: Seed, reversalKey: string) => {
    const freed = await seed.t.run((ctx) =>
      completeDeferredReversal(ctx, {
        orgId: seed.orgId,
        reversalIdempotencyKey: reversalKey,
        postedAt: Date.now(),
      })
    );
    return await settle(seed, freed);
  };

  test("the second instalment JOINS the deal the first one restored", async () => {
    const seed = await seedDealer("i1");
    const f = await twoInstalmentsDeferred(seed);

    expect((await drainOne(seed, f.first.reversalKey))?.outcome).toBe("RESTORED");
    // ⚠️ THE CONTRACT. Before the fix this was
    // ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL, naming the customer's own
    // restored root as the rival.
    expect((await drainOne(seed, f.second.reversalKey))?.outcome).toBe("RESTORED");

    const deposits = await seed.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(
      deposits.every((d) => d.holdActive === true),
      "both instalments hold the car again — neither is left stranded"
    ).toBe(true);
    expect(
      deposits.every((d) => d.singleVehicleCommitmentClaimId !== undefined),
      "and each names the episode it is now evidence of"
    ).toBe(true);

    // ⚠️ ONE OPEN ROOT, TWO EPISODES. The second instalment joins the restored
    // deal; it does not open a rival generation of its own.
    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const open = roots.filter((r) => r.status === "OPEN");
    expect(open).toHaveLength(1);
    const claims = await seed.t.run((ctx) => ctx.db.query("vehicleCommitmentClaims").collect());
    expect(claims.filter((c) => String(c.rootId) === String(open[0]._id))).toHaveLength(2);
  });

  test("order does not matter — whichever instalment drains first restores the deal", async () => {
    const seed = await seedDealer("i2");
    const f = await twoInstalmentsDeferred(seed);

    // The drain visits rows in queue order, which no caller controls.
    expect((await drainOne(seed, f.second.reversalKey))?.outcome).toBe("RESTORED");
    expect((await drainOne(seed, f.first.reversalKey))?.outcome).toBe("RESTORED");

    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    expect(roots.filter((r) => r.status === "OPEN")).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SCRUM-208 c15810 — THE SPINE REPORTS; IT NEVER THROWS
//
// Found by BOTH review seats against 6f7d1b5c3. `drainEntries` wraps every row
// in a try/catch so one bad entry cannot abort an organization's drain. A throw
// from the settlement is therefore ABSORBED — the mutation commits anyway,
// carrying whatever the restoration had already written, and the retry finds
// the reversal already completed and marks the entry POSTED with no
// authorityOutcome at all. Corruption became the one outcome that left no
// trace, in a taxonomy built specifically so it could not be overwritten.
//
// The fix is not to re-throw harder — that would abort every unrelated entry in
// the organization. It is to decide every failure mode BEFORE the first write,
// and to REPORT what a post-write check finds.
// ═════════════════════════════════════════════════════════════════════════════

describe("contradictory canonical records", () => {
  test("are reported as BLOCKED_INCONSISTENT, with nothing thrown", async () => {
    const seed = await seedDealer("x1");
    const f = await deferredDirectCancellation(seed);

    // A row that contradicts the range it sits in: live in the canonical
    // DIRECT index, and VOIDED. `hasCanonicalDepositHold` refuses rather than
    // filters, because filtering would answer "nothing holds this car" and
    // free a vehicle somebody has paid to hold.
    await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId: f.vehicleId,
        customerId: seed.customerB,
        amount: 1,
        status: "VOIDED" as const,
        holdActive: true,
        usesVehicleHoldRows: false,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );

    const sources = await completion(seed, f.reversalKey);
    // ⚠️ RESOLVES, NEVER REJECTS. If this throws, `drainEntries` swallows it
    // and the entry is marked POSTED on the retry with no outcome recorded.
    const outcome = await settle(seed, sources);
    expect(outcome?.outcome).toBe("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT");
    expect(outcome && "detail" in outcome ? outcome.detail : "").toMatch(/disagree/i);

    // ⚠️ AND IT REFUSED BEFORE WRITING. The pre-flight runs the canonical
    // readers while nothing has been written yet, so a contradiction costs a
    // recorded outcome and NOT a half-restoration.
    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    expect(roots.filter((r) => r.status === "OPEN"), "no successor was opened").toHaveLength(0);
    expect(
      (await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive,
      "and the hold was not reinstated against records nobody can trust"
    ).toBe(false);
  });

  test("outrank every other outcome, so a clean car cannot bury them", () => {
    // A reversal can free several cars at once, and the order rows come back in
    // is not something a caller controls.
    expect(AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT).toBeGreaterThan(
      AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS
    );
    expect(AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS).toBeGreaterThan(
      AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL
    );
    expect(AUTHORITY_SEVERITY.AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE).toBeGreaterThan(
      AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS
    );
    expect(AUTHORITY_SEVERITY.ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS).toBeGreaterThan(
      AUTHORITY_SEVERITY.RESTORED
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SCRUM-208 — THE PRE-FLIGHT COVERED ONLY ONE OF THE TWO PATHS
//
// Found by Sonnet MAX against 170c5c9f0, and reproduced here before being
// fixed. `probeCanonicalHold` — built by the previous round precisely so a
// contradictory canonical row is REPORTED rather than thrown — is private to
// `restoreAuthorityAfterReversal`, which only a DIRECT source reaches. A SLICE
// returns early into `settleAuthorityAfterReversal`, whose canonical liveness
// read reaches the very same `refuseContradiction`, with no pre-flight anywhere
// on that path.
//
// The consequence is not a noisy failure. `drainEntries` catches the throw and
// the mutation COMMITS; `completeDeferredReversal` has already moved the
// application to REVERSED through a ONE-WAY gate, so the retry finds nothing
// left to settle and marks the entry POSTED with no `authorityOutcome` at all.
// That is the exact silent loss this taxonomy exists to prevent, reached
// through the one door the previous round did not close.
//
// The fix is a catch at the single boundary BOTH shapes pass through, so a
// failure nobody enumerated still becomes a durable, worst-ranked outcome.
// ═════════════════════════════════════════════════════════════════════════════

describe("a sliced source meeting the same contradiction", () => {
  test("is reported, never thrown — the slice path has no pre-flight of its own", async () => {
    const seed = await seedDealer("sl1");
    const vehicleId = await vehicle(seed);

    // ⚠️ THE ROOT STAYS OPEN. `settleAuthorityAfterReversal` answers
    // NO_RESTORABLE_BASIS and returns BEFORE the canonical read whenever the
    // car is already FREE, so a consumed root never reaches the contradiction
    // at all. A slice reversal on a car a live deal still holds is the shape
    // that does.
    const depositId = await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        amount: 1_000,
        status: "HELD" as const,
        holdActive: false,
        usesVehicleHoldRows: true,
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

    const holdId = await seed.t.run((ctx) =>
      ctx.db.insert("depositVehicleHolds", {
        orgId: seed.orgId,
        depositId,
        vehicleId,
        active: false,
        allocationStatus: "RELEASED_AWAITING_DECISION" as const,
        createdAt: Date.now(),
      })
    );

    // The SAME contradictory row the DIRECT path already reports safely: live
    // in the canonical DIRECT index, and VOIDED.
    await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerB,
        amount: 1,
        status: "VOIDED" as const,
        holdActive: true,
        usesVehicleHoldRows: false,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );

    // ⚠️ A KNOWN CONTRADICTION IS A TERMINAL BUSINESS ANSWER ON BOTH PATHS,
    // AND THIS ASSERTION HAS NOW BEEN WRONG IN BOTH DIRECTIONS (c15825).
    //
    // Originally it asserted the persisted INCONSISTENT outcome and its curated
    // detail. Last round I replaced that with `.rejects`, called it the stronger
    // contract, and shipped it — but throwing here is not strength. The throw
    // did roll the transaction back, and it ALSO destroyed the one sentence the
    // repairer can act on, spent a technical retry on a condition no retry can
    // change, and finally surfaced as "could not be settled after repeated
    // attempts". I ratified the loss of the audit channel as an improvement.
    //
    // Rollback protects the DATA. The pre-flight protects the AUDIT RECORD.
    // `probeCanonicalHold` now runs on the SLICE path too, so the contradiction
    // is classified BEFORE any write: recorded, diagnosed, terminal on the
    // first execution.
    const eventId = await seedAuthorityEvent(seed.t, seed.orgId, seed.userId, "reversed_slice_1");
    const [workId] = await seedAuthorityWork(seed.t, seed.orgId, eventId, [
      { kind: "SLICE", depositId, vehicleId, saleId, holdId },
    ]);

    // ⚠️ MEASURED BEFORE, BECAUSE THE FIXTURE ITSELF OPENS A ROOT. The deal was
    // acquired and never consumed, so an OPEN root is the PRE-EXISTING state —
    // asserting "no roots exist" afterwards would fail against correct code and
    // pass against nothing useful. The contract is that settlement added none.
    const rootsBefore = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const claimsBefore = await seed.t.run((ctx) =>
      ctx.db.query("vehicleCommitmentClaims").collect()
    );

    const summary = await settleThroughWorkers(seed.t, [workId], eventId);
    expect(summary?.outcome).toBe("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT");
    expect(
      summary?.detail,
      "the curated diagnosis survives — it is the whole value of the outcome"
    ).toMatch(/disagree/i);

    // ⚠️ TERMINAL ON EXECUTION ONE. A contradiction must never enter the
    // technical retry channel: five identical failures would tell the repairer
    // nothing the first one did not, and would end in the generic exhaustion
    // message instead of this diagnosis.
    const work = await seed.t.run((ctx) => ctx.db.get(workId));
    expect(work?.status).toBe("SETTLED");
    expect(work?.executions, "one execution, and no retry burned").toBe(1);
    const attempts = await readAttempts(seed.t, workId);
    expect(attempts).toHaveLength(1);
    expect(
      attempts[0]?.status,
      "reaching a typed answer IS a successful execution, even a blocked one"
    ).toBe("SUCCEEDED");

    // ⚠️ AND NO AUTHORITY WAS WRITTEN. The outcome string said INCONSISTENT
    // once before while an OPEN root sat behind it, so the assertion is the
    // ABSENCE of the writes, never the presence of the label.
    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    expect(
      roots.length,
      "no successor root for a source whose records contradict each other"
    ).toBe(rootsBefore.length);
    const claims = await seed.t.run((ctx) =>
      ctx.db.query("vehicleCommitmentClaims").collect()
    );
    expect(claims.length, "and no successor claim").toBe(claimsBefore.length);
  });

  /**
   * SCRUM-208 — AN UNEXPECTED FAILURE IS LOGGED, NOT PUBLISHED.
   *
   * Found by Codex against 170c5c9f0. `authorityOutcomeDetail` is returned by
   * `accountingOutbox.listPending` to every tenant user holding VIEW_FINANCE,
   * so a raw technical message here reaches a dealership. Only the curated
   * ConvexError text may be persisted.
   */
  /**
   * ⚠️ THE SANITIZING BRANCH IS NOT COVERED HERE, AND THAT IS SAID RATHER THAN
   * QUIETLY LEFT.
   *
   * The boundary catch has two arms: a curated `ConvexError` is persisted
   * verbatim (asserted by the test above), and any OTHER throwable is logged
   * and replaced with a fixed sentence, because `authorityOutcomeDetail`
   * reaches every VIEW_FINANCE user through `accountingOutbox.listPending`.
   *
   * Reaching that second arm needs a plain technical `Error` from inside
   * `settleOneReversalSource`, and this harness cannot produce one naturally:
   * `ctx.db.get` under `convex-test` returns null for a malformed id instead of
   * throwing, so the obvious injection settles to null and never enters the
   * catch. Forcing it requires module mocking, which would apply to every test
   * in this file.
   *
   * So that arm is verified by reading, not by execution. Recorded here as a
   * known coverage gap — the same treatment as the deliberately surviving
   * mutant noted in `restoreCommitment` — rather than dressed up with a test
   * that asserts a string literal against itself and proves nothing.
   */
});

// ═════════════════════════════════════════════════════════════════════════════
// SCRUM-208 — A REFUSAL NOBODY READS IS NOT A GUARD
//
// Found by Codex against 641ead8cb, in the fix that closed the round before it.
// `reinstateDirectDepositHold` was taught to refuse a deleted source and it
// does — but `makeSourceLive` was typed `Promise<void>` and the caller dropped
// the `null` on the floor. So the refusal changed nothing: `restoreCommitment`
// still opened a successor root, attached a claim and moved the source pointer
// for a source that is not live, and the postcondition reported INCONSISTENT
// only AFTER those writes were committed.
//
// ⚠️ AND THE GATE HAS TO SIT *AFTER* `makeSourceLive`, NOT BEFORE IT. At
// decision time the source is legitimately NOT live — a deferred cancellation
// deliberately leaves `holdActive` false while the reversal sits in the outbox,
// and the callback is the thing that changes it. So `resolveRestorationDecision`
// cannot gate on liveness; only a re-read afterwards can.
//
// The assertion that matters here is NOT that the outcome string says
// INCONSISTENT — the old code said that too, while committing the writes. It is
// that NOTHING WAS WRITTEN: no open root, no successor claim, no moved pointer.
// ═════════════════════════════════════════════════════════════════════════════

describe("a source that cannot be made live", () => {
  test("opens no root, attaches no claim and moves no pointer", async () => {
    const seed = await seedDealer("rf1");
    const f = await deferredDirectCancellation(seed);
    const pointerBefore = (await seed.t.run((ctx) => ctx.db.get(f.depositId)))
      ?.singleVehicleCommitmentClaimId;

    // The one state the writer refuses: HELD (so the money looks restorable)
    // but deleted (so no reader will ever call it live).
    await seed.t.run((ctx) => ctx.db.patch(f.depositId, { isDeleted: true }));

    const claimsBefore = (
      await seed.t.run((ctx) => ctx.db.query("vehicleCommitmentClaims").collect())
    ).length;

    const outcome = await settle(seed, await completion(seed, f.reversalKey));

    expect(outcome?.outcome).toBe("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT");

    // ⚠️ THE PART THE OLD CODE FAILED. It reported the same outcome while
    // leaving all three of these behind.
    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    expect(roots.filter((r) => r.status === "OPEN"), "no successor root was opened").toHaveLength(
      0
    );
    expect(
      (await seed.t.run((ctx) => ctx.db.query("vehicleCommitmentClaims").collect())).length,
      "no successor claim was attached"
    ).toBe(claimsBefore);
    expect(
      (await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.singleVehicleCommitmentClaimId,
      "the source pointer did not move"
    ).toBe(pointerBefore);
    expect(
      (await seed.t.run((ctx) => ctx.db.get(f.depositId)))?.holdActive,
      "and the deleted source was never re-held"
    ).toBe(false);
  });

  /**
   * SCRUM-208 — ONE BAD CAR DOES NOT COST THE OTHERS THEIR OUTCOME.
   *
   * Raised by Sonnet MAX against 641ead8cb as a coverage gap it could not
   * execute itself. It matters because of what the pre-fix code did to a BATCH:
   * `completeDeferredReversal` frees every source before settlement begins, so
   * a throw on one source skipped every source after it — and the one-way gate
   * meant the retry freed nothing, so NONE of them ever recorded an outcome.
   *
   * The catch is inside the loop precisely so the rest of the batch survives.
   * Moving it outside would restore the old behaviour while keeping every
   * single-source test green, which is exactly why this asserts a batch.
   */
  test("a contradictory car in the batch does not stop the clean one settling", async () => {
    const seed = await seedDealer("rf2");
    const clean = await deferredDirectCancellation(seed);

    // A second car whose canonical records contradict each other.
    const rogueVehicle = await vehicle(seed);
    const rogueSale = await seed.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: seed.orgId,
        vehicleId: rogueVehicle,
        customerId: seed.customerId,
        salespersonId: seed.userId,
        salePrice: 20_000,
        saleDate: Date.now(),
        status: "CANCELLED" as const,
      })
    );
    const rogueDeposit = await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId: rogueVehicle,
        customerId: seed.customerId,
        amount: 500,
        status: "HELD" as const,
        holdActive: false,
        usesVehicleHoldRows: true,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );
    await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId: rogueVehicle,
        customerId: seed.customerId,
        createdBy: seed.userId,
        evidence: { kind: "DEPOSIT", depositId: rogueDeposit },
        lineage: { depositId: rogueDeposit },
      })
    );
    const rogueHold = await seed.t.run((ctx) =>
      ctx.db.insert("depositVehicleHolds", {
        orgId: seed.orgId,
        depositId: rogueDeposit,
        vehicleId: rogueVehicle,
        active: false,
        allocationStatus: "RELEASED_AWAITING_DECISION" as const,
        createdAt: Date.now(),
      })
    );
    await seed.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: seed.orgId,
        vehicleId: rogueVehicle,
        customerId: seed.customerB,
        amount: 1,
        status: "VOIDED" as const,
        holdActive: true,
        usesVehicleHoldRows: false,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );

    const rogue = {
      kind: "SLICE" as const,
      depositId: rogueDeposit,
      vehicleId: rogueVehicle,
      saleId: rogueSale,
      holdId: rogueHold,
    };
    const cleanSources = await completion(seed, clean.reversalKey);

    // ⚠️ TWO SEPARATE ACCOUNTING EVENTS, BECAUSE THAT IS THE ONLY SHAPE
    // PRODUCTION BUILDS (SCRUM-208 c15825).
    //
    // This test previously put both cars under ONE event and I published it as
    // proof that a failing episode cannot damage a clean sibling. It was not
    // proof of anything about production: `completeDeferredReversal` returns AT
    // MOST ONE source per accounting event — the SLICE branch returns
    // immediately, the DIRECT branch pushes one — so a real reversal never
    // mints siblings, and the topology I measured was one only the helpers can
    // build. I withdrew the claim; this is the honest version of it.
    //
    // What it now proves is real and separately worth having: two independent
    // reversals settle independently, and each accounting row summarises ITS
    // OWN work through the exact `by_org_pending_event` range. A blocked car
    // must never be buried by a clean one, and a clean car must never be
    // tarred by a blocked one.
    const rogueEvent = await seedAuthorityEvent(
      seed.t,
      seed.orgId,
      seed.userId,
      "reversed_rogue_1"
    );
    const [rogueWork] = await seedAuthorityWork(seed.t, seed.orgId, rogueEvent, [rogue]);
    const cleanEvent = await seedAuthorityEvent(
      seed.t,
      seed.orgId,
      seed.userId,
      "reversed_clean_1"
    );
    const [cleanWork] = await seedAuthorityWork(seed.t, seed.orgId, cleanEvent, cleanSources);

    const rogueSummary = await settleThroughWorkers(seed.t, [rogueWork], rogueEvent);
    expect(rogueSummary?.outcome).toBe("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT");

    const cleanSummary = await settleThroughWorkers(seed.t, [cleanWork], cleanEvent);
    expect(
      (await seed.t.run((ctx) => ctx.db.get(clean.depositId)))?.holdActive,
      "the clean car settled independently of the reversal that could not"
    ).toBe(true);
    expect(cleanSummary?.outcome).toBe("RESTORED");

    // ⚠️ NEITHER SUMMARY MOVED THE OTHER. The rogue's accounting row keeps its
    // repair condition after the clean one settles — the prefix-range summary
    // this replaced would have been one shared idempotency-key prefix away
    // from writing the wrong row.
    expect(
      (await seed.t.run((ctx) => ctx.db.get(rogueEvent)))?.authorityOutcome,
      "a clean restoration elsewhere does not clear a car that needs a person"
    ).toBe("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT");
    expect((await seed.t.run((ctx) => ctx.db.get(rogueWork)))?.status).toBe("SETTLED");
    expect((await seed.t.run((ctx) => ctx.db.get(cleanWork)))?.status).toBe("SETTLED");
  });
});
