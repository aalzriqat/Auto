/**
 * SCRUM-302 R1 — THE LIFECYCLE RACE AROUND AUTHORITY DISPATCH.
 *
 * ⚠️ WHAT THIS FILE EXISTS TO PREVENT, AND IT IS A DEFECT SCRUM-302 ITSELF
 * INTRODUCED.
 *
 * The first version of the lifecycle gate put an early return at the TOP of
 * `performAuthoritySettlement`, above the `activeAttemptId` / `generation`
 * guards, with a comment claiming it "matches how this handler already treats a
 * superseded execution". It does not. A superseded execution returns at those
 * LOWER guards, by which point re-dispatch has already moved the work to a
 * coherent state under a new generation. The lifecycle return fired while the
 * attempt was still the ACTIVE one, so it left:
 *
 *     work.status    === "DISPATCHED"
 *     attempt.status === "SCHEDULED"
 *     scheduled fn    state.kind === "success"   (it returned normally)
 *
 * and that exact triple is the invariant `observeAuthorityAttempt` THROWS on.
 * The one-minute `dispatchDueAuthorityWork` cron re-selected the row and
 * re-threw forever, and `reactivateOrganization` touches neither table, so
 * unsuspending the organization could not repair it. The car stayed held.
 *
 * ⚠️ THE RACES RUN THROUGH THE REAL DISPATCHER AND THE REAL SCHEDULER. The
 * suspension lands between dispatch and the scheduled settlement, which is how
 * it happens in production. Two setup steps do patch rows directly: the
 * stale-generation case clears `scheduledFunctionId` and rewinds
 * `nextActionAt` to force a re-dispatch. Those are setup, not the behaviour
 * under test.
 *
 * ⚠️ THE HARNESS PROVES LOGIC, NOT CONTENTION. `convex-test` serializes and has
 * no OCC. These are state-machine properties, not concurrency results.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { acquireVehicle, consumeRootForSale } from "./commitments";
import { COMMITMENT_AUTHORITY_V1 } from "./utils/commitmentKernel";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import {
  dispatchWork,
  readAttempts,
  readWork,
  seedAuthorityEvent,
  seedAuthorityWork,
} from "../test-utils/authorityWork";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/** See `test-utils/authorityWork.ts` — timers only, never `Date`. */
const TIMER_FNS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;

/**
 * The MONEY half of the ledger-core set.
 *
 * ⚠️ `commitmentAuthorityWork` AND `commitmentAuthorityAttempt` ARE
 * DELIBERATELY EXCLUDED, AND THE REASON IS THE ASSERTION'S MEANING. They are
 * also ledger-core tables and the gate covers them too, but they are the
 * DISPATCH MACHINERY of the very race under test: the dispatcher legitimately
 * mints an attempt row before the lifecycle change lands, and the settlement's
 * whole job here is to terminalize that row rather than leave it outstanding.
 * Freezing them would assert that the correction did nothing, which is the
 * opposite of the contract. Their state is asserted explicitly and precisely in
 * each test instead.
 */
const MONEY_TABLES = [
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
  "accountBalanceSnapshots",
  "canonicalPayments",
  "receivableDocuments",
  "paymentAllocations",
] as const;

let vin = 7100;

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
      phone: `+96279${suffix}0007`,
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

const suspend = (seed: Seed) => seed.t.run((ctx) => ctx.db.patch(seed.orgId, { suspended: true }));
const reactivate = (seed: Seed) =>
  seed.t.run((ctx) => ctx.db.patch(seed.orgId, { suspended: false }));
const beginDestructivePurge = (seed: Seed) =>
  seed.t.run((ctx) =>
    ctx.db.patch(seed.orgId, { suspended: true, destructivePurgeStartedAt: Date.now() })
  );

/**
 * Dispatch through the real dispatcher, let `mutate` happen in the gap, then
 * let the SCHEDULER run the settlement it queued.
 *
 * ⚠️ THIS IS THE WHOLE RACE, AND IT FORCES NOTHING. Running the settlement via
 * the scheduler rather than calling it directly is what makes Convex record a
 * real `state.kind` for the execution — which is the value the observer reads
 * and the original defect depended on.
 */
async function raceDuringDispatch(seed: Seed, workId: Id<"commitmentAuthorityWork">, mutate: () => Promise<unknown>) {
  vi.useFakeTimers({ toFake: [...TIMER_FNS] });
  try {
    await seed.t.mutation(internal.accountingOutbox.dispatchAuthorityWorkItem, { workId });
    await mutate();
    await seed.t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

/** Selected root/claim/deposit indicators plus `MONEY_TABLES` row counts. */
async function footprint(seed: Seed, depositId: Id<"deposits">) {
  return await seed.t.run(async (ctx) => {
    const roots = await ctx.db.query("commitmentRoots").collect();
    const claims = await ctx.db.query("vehicleCommitmentClaims").collect();
    const deposit = await ctx.db.get(depositId);
    const ledger: Record<string, number> = {};
    for (const table of MONEY_TABLES) {
      ledger[table] = (await ctx.db.query(table).collect()).length;
    }
    return {
      openRoots: roots.filter((r) => r.status === "OPEN").length,
      claims: claims.length,
      pointer: deposit?.singleVehicleCommitmentClaimId ?? null,
      holdActive: deposit?.holdActive ?? null,
      ledger,
    };
  });
}

/** The scheduler's own verdict on the settlement execution. */
async function settlementOutcomes(seed: Seed): Promise<string[]> {
  return await seed.t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs
      .filter((j) => j.name.includes("performAuthoritySettlement"))
      .map((j) => j.state.kind);
  });
}

describe("SCRUM-302 R1 — a suspension between dispatch and settlement (TEMPORARY)", () => {
  test("leaves no poison state, writes nothing, and the observer does not throw", async () => {
    const seed = await seedDealer("r1a");
    const { workId, deal } = await workFor(seed, "reversed_race_temp_1");
    const before = await footprint(seed, deal.depositId);

    await raceDuringDispatch(seed, workId, () => suspend(seed));

    // The execution really ran and really reported success — this is the exact
    // condition the observer used to throw on.
    expect(await settlementOutcomes(seed), "the scheduled execution completed normally").toEqual([
      "success",
    ]);

    const work = await readWork(seed.t, workId);
    const attempts = await readAttempts(seed.t, workId);

    // ⚠️ THE POISON TRIPLE MUST BE GONE. Either half alone is enough to hang
    // the work forever, so both are asserted.
    expect(work.status, "work must not still be claimed").not.toBe("DISPATCHED");
    expect(attempts[0]?.status, "the attempt must not still be outstanding").not.toBe("SCHEDULED");
    expect(work.activeAttemptId, "the claim must be released").toBeUndefined();

    // Zero economic effect, compared over `MONEY_TABLES` row counts and the
    // root/claim/deposit indicators `footprint` reads.
    expect(await footprint(seed, deal.depositId)).toEqual(before);

    // The R1 defect, stated as the assertion that used to fail.
    await expect(
      seed.t.mutation(internal.accountingOutbox.observeAuthorityAttempt, { workId }),
      "the observer must not report an invariant violation for a lifecycle refusal"
    ).resolves.toBeDefined();

    // Resumable, not abandoned.
    expect(work.status, "a temporary refusal HOLDS the work").toBe("READY");
  });

  test("and after reactivation a fresh generation settles normally", async () => {
    const seed = await seedDealer("r1b");
    const { workId } = await workFor(seed, "reversed_race_temp_2");

    await raceDuringDispatch(seed, workId, () => suspend(seed));
    expect((await readWork(seed.t, workId)).status).toBe("READY");

    await reactivate(seed);
    await seed.t.run((ctx) => ctx.db.patch(workId, { nextActionAt: Date.now() - 1 }));

    vi.useFakeTimers({ toFake: [...TIMER_FNS] });
    try {
      await seed.t.mutation(internal.accountingOutbox.dispatchAuthorityWorkItem, { workId });
      await seed.t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const work = await readWork(seed.t, workId);
    expect(work.status, "reactivation lets the work finish for real").toBe("SETTLED");
    expect(work.generation, "under a NEW generation, not the refused one").toBeGreaterThan(1);
    expect(work.outcome).toBeDefined();
  });
});

describe("SCRUM-302 R1 — repeated suspend/reactivate cannot exhaust the retry budget", () => {
  test("eight lifecycle refusals leave the work healthy, not falsely BLOCKED", async () => {
    const seed = await seedDealer("r1c");
    const { workId } = await workFor(seed, "reversed_race_budget_1");

    // MAX_AUTHORITY_EXECUTIONS is 5. Racing more times than that is the point:
    // if a lifecycle refusal charged the technical budget, the work would
    // terminalize as RETRY_EXHAUSTED — an audit record asserting repeated
    // FAILED attempts when not one settlement ever ran.
    const rounds = 8;
    for (let i = 0; i < rounds; i++) {
      await reactivate(seed);
      await seed.t.run((ctx) => ctx.db.patch(workId, { nextActionAt: Date.now() - 1 }));
      await raceDuringDispatch(seed, workId, () => suspend(seed));

      const round = await readWork(seed.t, workId);
      expect(round.status, `round ${i + 1} must stay resumable`).toBe("READY");
      expect(round.outcome, `round ${i + 1} must not invent an outcome`).toBeUndefined();
    }

    const work = await readWork(seed.t, workId);
    expect(work.status).toBe("READY");
    expect(work.executions, "every dispatch really did schedule an execution").toBe(rounds);
    expect(work.lifecycleHolds, "and every one of them was a lifecycle refusal").toBe(rounds);

    // The budget is what the dispatcher actually consults.
    await reactivate(seed);
    await seed.t.run((ctx) => ctx.db.patch(workId, { nextActionAt: Date.now() - 1 }));
    const claim = await dispatchWork(seed.t, workId);
    expect(claim, "the dispatcher must still be willing to work this row").not.toBeNull();
  });
});

describe("SCRUM-302 R1 — destructive purge between dispatch and settlement (PERMANENT)", () => {
  test("abandons terminally with its own outcome, writes nothing, and never retries", async () => {
    const seed = await seedDealer("r1d");
    const { workId, deal, eventId } = await workFor(seed, "reversed_race_purge_1");
    const before = await footprint(seed, deal.depositId);

    await raceDuringDispatch(seed, workId, () => beginDestructivePurge(seed));

    expect(await settlementOutcomes(seed)).toEqual(["success"]);

    const work = await readWork(seed.t, workId);
    const attempts = await readAttempts(seed.t, workId);

    expect(work.status, "terminal, and terminal means BLOCKED here").toBe("BLOCKED");
    expect(
      work.outcome,
      "the truthful outcome — NOT retry exhaustion, NOT inconsistency, NOT canonical unavailability"
    ).toBe("ACCOUNTING_REVERSED_AUTHORITY_ABANDONED_ORG_PURGED");
    expect(work.activeAttemptId).toBeUndefined();
    expect(attempts[0]?.status).not.toBe("SCHEDULED");

    // Zero authority and zero economic effect.
    expect(await footprint(seed, deal.depositId)).toEqual(before);

    // No observer poison.
    await expect(
      seed.t.mutation(internal.accountingOutbox.observeAuthorityAttempt, { workId })
    ).resolves.toBeDefined();

    // ⚠️ AND NO FUTURE SETTLEMENT IS REACHABLE. Both doors are checked: the
    // work is no longer READY, and the dispatcher refuses the org anyway.
    await seed.t.run((ctx) => ctx.db.patch(workId, { nextActionAt: Date.now() - 1 }));
    expect(await dispatchWork(seed.t, workId), "no further attempt may be minted").toBeNull();
    expect((await readAttempts(seed.t, workId)).length, "still exactly one attempt").toBe(1);

    // The summary carries the fact rather than leaving the accounting row clean.
    const event = await seed.t.run((ctx) => ctx.db.get(eventId));
    expect(event?.authorityOutcome).toBe("ACCOUNTING_REVERSED_AUTHORITY_ABANDONED_ORG_PURGED");
  });

  test("and the purge manifest still deletes both authority tables", () => {
    // The new outcome is truthful state for the interval BEFORE these rows are
    // deleted. It is not a retention mechanism, and it must not become a reason
    // to keep the rows.
    const tables = ORGANIZATION_DELETION_STEPS.filter((s) => s.kind === "orgRows").map(
      (s) => (s as { table: string }).table
    );
    expect(tables).toContain("commitmentAuthorityWork");
    expect(tables).toContain("commitmentAuthorityAttempt");
  });
});

describe("SCRUM-302 R1 — lifecycle must never act on a stale execution", () => {
  test("a superseded generation stays a pure no-op even while the org is blocked", async () => {
    const seed = await seedDealer("r1e");
    const { workId } = await workFor(seed, "reversed_race_stale_1");

    // Generation 1, then make the observer release it so a fresh generation is
    // minted — the real path by which a stale execution comes to exist.
    const stale = await dispatchWork(seed.t, workId);
    expect(stale).not.toBeNull();
    const claimed = await readWork(seed.t, workId);
    await seed.t.run((ctx) =>
      ctx.db.patch(claimed.activeAttemptId, { scheduledFunctionId: undefined })
    );
    await seed.t.mutation(internal.accountingOutbox.observeAuthorityAttempt, { workId });

    await seed.t.run((ctx) => ctx.db.patch(workId, { nextActionAt: Date.now() - 1 }));
    const fresh = await dispatchWork(seed.t, workId);
    expect(fresh).not.toBeNull();
    expect(fresh!.generation).toBeGreaterThan(stale!.generation);

    const beforeStale = await readWork(seed.t, workId);
    await suspend(seed);

    // The stale execution arrives late, into a blocked organization.
    await seed.t.mutation(internal.accountingOutbox.performAuthoritySettlement, {
      workId,
      attemptId: stale!.attemptId,
      generation: stale!.generation,
    });

    const after = await readWork(seed.t, workId);

    // ⚠️ THE LIFECYCLE CHECK MUST NOT HAVE RUN AT ALL. If it sat above the
    // identity guards — the original defect — this stale arrival would have
    // released or terminalized the CURRENT generation's claim.
    expect(after.status, "the active claim is untouched").toBe(beforeStale.status);
    expect(String(after.activeAttemptId), "still the fresh attempt").toBe(
      String(beforeStale.activeAttemptId)
    );
    expect(after.generation).toBe(beforeStale.generation);
    expect(after.lifecycleHolds ?? 0, "a stale arrival must not record a lifecycle hold").toBe(
      beforeStale.lifecycleHolds ?? 0
    );
    expect(after.outcome).toBeUndefined();
  });
});
