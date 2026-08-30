/**
 * SCRUM-208 c15825 — THE AUTHORITY WORK STATE MACHINE.
 *
 * ⚠️ WHAT THIS FILE EXISTS TO PREVENT. The predecessor held one counter,
 * `attempts`, incremented by whatever delivered an offer to begin settlement.
 * Two things it could not express, and both blocked the round:
 *
 *  1. **Which execution may write.** With no durable execution identity, a late
 *     or duplicated settlement was indistinguishable from the current one, so
 *     the only available guard was "is this still owed" — true of both.
 *  2. **What became of an execution.** A failed settlement rolls its own
 *     transaction back, taking any record of the failure with it. The count of
 *     OFFERS was the only surviving signal, and it counted the wrong thing: a
 *     row could reach its cap and report "repeated attempts" when fewer had
 *     actually run.
 *
 * So a work item is CLAIMED (`READY` → `DISPATCHED`) in the same transaction
 * that mints one immutable attempt, and released only by an observer that has
 * read what Convex says happened to that exact execution.
 *
 * ⚠️ THE HARNESS PROVES LOGIC, NOT CONTENTION. `convex-test` serializes and has
 * no OCC, so "two dispatchers produce one attempt" is demonstrated here as a
 * state-machine property, not as an exclusion result under concurrency. The
 * isolated Convex E2-R owns that, and a green run here is not evidence for it.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { acquireVehicle, consumeRootForSale } from "./commitments";
import { COMMITMENT_AUTHORITY_V1 } from "./utils/commitmentKernel";
import {
  dispatchWork,
  readAttempts,
  readWork,
  seedAuthorityEvent,
  seedAuthorityWork,
  settleViaScheduler,
} from "../test-utils/authorityWork";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

let vin = 9000;

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
      phone: `+96279${suffix}0002`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, customerId };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

/** The state a real deferred cancellation leaves behind. */
async function deferredCancelledDeal(seed: Seed) {
  vin += 1;
  const vehicleId = await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `5HGCM82633B${String(vin)}`,
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

async function workFor(seed: Seed, key: string) {
  const deal = await deferredCancelledDeal(seed);
  const eventId = await seedAuthorityEvent(seed.t, seed.orgId, seed.userId, key);
  const [workId] = await seedAuthorityWork(seed.t, seed.orgId, eventId, [
    { kind: "DIRECT", depositId: deal.depositId, vehicleId: deal.vehicleId, saleId: deal.saleId },
  ]);
  return { deal, eventId, workId: workId! };
}

/** Everything the authority may have written. */
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

/** How many settlement executions the scheduler was actually asked to run. */
async function scheduledSettlements(seed: Seed): Promise<number> {
  return await seed.t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.name.includes("performAuthoritySettlement")).length;
  });
}

/**
 * Make the outstanding execution unobservable, then observe.
 *
 * ⚠️ THIS IS THE "ABSENCE IS NOT SUCCESS" PATH, and it is a real production
 * case rather than a convenience: Convex retains completed scheduled-function
 * results for a bounded window, so an observation that arrives after that
 * window finds nothing. Reading nothing as success would silently abandon a
 * car's authority, so it retries.
 */
async function observeUnobservable(seed: Seed, workId: Id<"commitmentAuthorityWork">) {
  const work = await readWork(seed.t, workId);
  await seed.t.run((ctx) =>
    ctx.db.patch(work.activeAttemptId, { scheduledFunctionId: undefined })
  );
  return await seed.t.mutation(internal.accountingOutbox.observeAuthorityAttempt, { workId });
}

/** Simulate the backoff elapsing, touching nothing else. */
async function elapseBackoff(seed: Seed, workId: Id<"commitmentAuthorityWork">) {
  await seed.t.run((ctx) => ctx.db.patch(workId, { nextActionAt: Date.now() - 1 }));
}

describe("claiming work", () => {
  test("two dispatches before settlement mint ONE attempt and ONE execution", async () => {
    const seed = await seedDealer("d1");
    const { workId } = await workFor(seed, "reversed_dup_1");

    const first = await dispatchWork(seed.t, workId);

    // ⚠️ THE DUE-TIME GATE IS DELIBERATELY TAKEN OUT OF THE WAY, and this is
    // the whole point of the test.
    //
    // A dispatch also sets `nextActionAt` forward, so a second delivery
    // arriving promptly is refused for being EARLY rather than for finding the
    // work claimed. Written the obvious way, this test passed against a mutant
    // that removed the claim guard entirely — the mutation floor caught it, not
    // me. Clearing the due time isolates the one property under test: a work
    // item that is already DISPATCHED cannot be dispatched again, whatever the
    // clock says.
    await seed.t.run((ctx) => ctx.db.patch(workId, { nextActionAt: Date.now() - 1 }));
    const second = await dispatchWork(seed.t, workId);

    // ⚠️ THE DEFECT THIS REPLACES. Both deliveries used to find the work
    // "still owed" and both spent budget, so one settlement could consume two
    // of five attempts — and a row that later blocked reported "repeated
    // attempts" for failures that never happened.
    expect(first, "the first dispatch claims the work").not.toBeNull();
    expect(second, "the second finds it claimed and does nothing").toBeNull();

    const work = await readWork(seed.t, workId);
    expect(work?.status).toBe("DISPATCHED");
    expect(work?.executions, "one execution, not two").toBe(1);
    expect(work?.generation).toBe(1);
    expect(await readAttempts(seed.t, workId)).toHaveLength(1);
    expect(
      await scheduledSettlements(seed),
      "and the scheduler was asked for exactly one settlement"
    ).toBe(1);
  });

  test("a stale generation writes no authority and spends no budget", async () => {
    const seed = await seedDealer("d2");
    const { deal, workId } = await workFor(seed, "reversed_stale_1");

    const stale = await dispatchWork(seed.t, workId);
    expect(stale).not.toBeNull();

    // Release and re-claim, so generation 1 is superseded by generation 2.
    await observeUnobservable(seed, workId);
    await elapseBackoff(seed, workId);
    const current = await dispatchWork(seed.t, workId);
    expect(current?.generation).toBe(2);

    const before = await residue(seed, deal.depositId);
    const workBefore = await readWork(seed.t, workId);

    // ⚠️ GENERATION 1 ARRIVES LATE. Without the identity check this would settle
    // from a decision taken against state that has since moved, and two
    // generations could each mint a successor root for one source episode.
    await seed.t.mutation(internal.accountingOutbox.performAuthoritySettlement, {
      workId,
      attemptId: stale!.attemptId,
      generation: stale!.generation,
    });

    const after = await residue(seed, deal.depositId);
    expect(after.openRoots, "no successor root from a superseded execution").toBe(
      before.openRoots
    );
    expect(after.claims).toBe(before.claims);
    expect(after.pointer).toBe(before.pointer);
    expect(after.holdActive).toBe(before.holdActive);

    const workAfter = await readWork(seed.t, workId);
    expect(workAfter?.executions, "and no budget was spent by it").toBe(workBefore?.executions);
    expect(workAfter?.status, "the current claim is untouched").toBe("DISPATCHED");
    expect(workAfter?.generation).toBe(2);
  });
});

describe("observing an execution", () => {
  test("a cancelled execution releases the claim, like a failed one", async () => {
    const seed = await seedDealer("o1");
    const { workId } = await workFor(seed, "reversed_cancel_1");

    const claim = await dispatchWork(seed.t, workId);
    const attempt = (await readAttempts(seed.t, workId))[0];
    await seed.t.run((ctx) => ctx.scheduler.cancel(attempt.scheduledFunctionId));

    const observed = await seed.t.mutation(internal.accountingOutbox.observeAuthorityAttempt, {
      workId,
    });
    expect(observed.transition).toBe("RETRY");
    expect((await readAttempts(seed.t, workId))[0]?.status).toBe("CANCELED");
    expect((await readWork(seed.t, workId))?.status).toBe("READY");
    expect(claim?.generation).toBe(1);
  });

  test("an unobservable execution retries — absence is never success", async () => {
    const seed = await seedDealer("o2");
    const { workId } = await workFor(seed, "reversed_gone_1");

    await dispatchWork(seed.t, workId);
    const observed = await observeUnobservable(seed, workId);

    expect(observed.transition).toBe("RETRY");
    const attempt = (await readAttempts(seed.t, workId))[0];
    expect(attempt?.status).toBe("FAILED");
    expect(
      attempt?.detail,
      "and it says so, rather than borrowing the wording of an observed failure"
    ).toBe("this settlement attempt could not be observed");
    expect((await readWork(seed.t, workId))?.status).toBe("READY");
  });

  test("a succeeded execution that left the work claimed fails VISIBLE", async () => {
    const seed = await seedDealer("o3");
    const { workId } = await workFor(seed, "reversed_impossible_1");

    // Settle for real, so the scheduled-function document genuinely reports
    // success, then force the work back to a claimed state.
    await settleViaScheduler(seed.t, workId);
    expect((await readWork(seed.t, workId))?.status).toBe("SETTLED");
    const attempt = (await readAttempts(seed.t, workId))[0];
    await seed.t.run((ctx) =>
      ctx.db.patch(workId, { status: "DISPATCHED" as const, activeAttemptId: attempt._id })
    );
    await seed.t.run((ctx) => ctx.db.patch(attempt._id, { status: "SCHEDULED" as const }));

    // ⚠️ CONSTRUCTED ON PURPOSE, AND UNREACHABLE IN PRODUCTION. Tx C either
    // terminalizes the work or returns without writing because it was
    // superseded — and a superseded execution is not the active attempt. There
    // is no legitimate path to this state, which is exactly why recording an
    // outcome for it would paper over a state machine that had stopped being
    // true. It throws instead.
    await expect(
      seed.t.mutation(internal.accountingOutbox.observeAuthorityAttempt, { workId })
    ).rejects.toThrow(/reported success but work .* is still DISPATCHED/);
  });
});

describe("the execution budget", () => {
  test("exactly five real failures produce RETRY_EXHAUSTED, not INCONSISTENT", async () => {
    const seed = await seedDealer("b1");
    const { workId } = await workFor(seed, "reversed_budget_1");

    // Drive the cycle until the machine terminalizes, with a hard ceiling so a
    // runaway loop fails the test rather than hanging it.
    let guard = 0;
    for (;;) {
      guard += 1;
      expect(guard, "the budget must terminate").toBeLessThan(12);
      const claim = await dispatchWork(seed.t, workId);
      if (!claim) break;
      const observed = await observeUnobservable(seed, workId);
      if (observed.transition === "BLOCKED") break;
      await elapseBackoff(seed, workId);
    }

    const work = await readWork(seed.t, workId);
    expect(work?.status).toBe("BLOCKED");
    expect(work?.executions, "five ACTUAL executions, counted one per attempt row").toBe(5);
    expect(await readAttempts(seed.t, workId), "and one immutable attempt each").toHaveLength(5);

    // ⚠️ THE TAXONOMY SEPARATION (c15825). This used to record
    // BLOCKED_INCONSISTENT, which tells the repairer the canonical records
    // contradict each other — a DIAGNOSIS nothing here established. Repeated
    // technical failure is the ABSENCE of a diagnosis and is a different audit
    // fact.
    expect(work?.outcome).toBe("ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED");
    expect(work?.outcome).not.toBe("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT");
  });
});
