/**
 * SCRUM-208 PHASE 3 — THE PRODUCTION RESTORATION SPINE, END TO END.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. The first Phase-3 implementation was
 * BLOCKED by both review seats for one shared reason: the canonical machinery
 * was built and never connected to production, and its tests concealed that by
 * manufacturing states production has no writer for. Three of the five
 * confirmed defects were invisible to a suite of 71 passing contracts:
 *
 *   · `resolveRestorationDecision` required the CLAIM to be CONSUMED by the
 *     cancelled sale. Real finalization patches the ROOT and nothing else —
 *     Phase 2's certified F.12 pins that deliberately — so the predicate was
 *     false for every real cancellation. The fixture hand-patched the claim.
 *   · `deposits.usesVehicleHoldRows` had readers on both sides and NO WRITER.
 *     Every real deposit carried `undefined`, which every canonical reader
 *     correctly fails closed on. The fixtures set it by hand.
 *   · `restoreCommitment` had no production caller at all.
 *
 * So every contract below starts from a REAL deposit taken through
 * `api.deposits.create`, completed through a REAL sale door, and cancelled
 * through the REAL manager cancellation. Nothing here patches a claim or root
 * status by hand. The one deliberate exception is the corruption fixture in
 * S.10, which exists precisely to reproduce state no writer should produce.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  hasLiveCommitmentBasis,
  releaseRootIfNoLiveBasis,
  resolveOwnership,
  settleAuthorityAfterReversal,
} from "./commitments";
import { settleSources } from "../test-utils/authorityWork";
import { completeDeferredReversal } from "./utils/depositApplications";
import {
  beginUserRun,
  COMMITMENT_AUTHORITY_V1,
  hasCanonicalDepositHold,
  requireDecisionContext,
} from "./utils/commitmentKernel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
  // S.4b reopens a closed month so a deferred reversal can finally post.
  // Deliberately a separate permission in production — MANAGE_FINANCE alone
  // does not grant it, because reopening un-does a close's own protections.
  "reopen:accounting_periods",
  // S.4c drives the OTHER public cancellation door, which needs a finance
  // application finalized into a sale before `cancelApplication` can reach the
  // shared cancellation spine at all.
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
];

const PRICE = 30_000;
let vinCounter = 3000;

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
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `u_${suffix}`, email: `${suffix}@t.com`, name: "Sales" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `u_${suffix}`, clerkId: `u_${suffix}` });

  // Cancellation goes through a SECOND person: the seller may not cancel their
  // own sale, and a permission grant cannot stand in for a second identity.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `m_${suffix}`, email: `m-${suffix}@t.com`, name: "Manager" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  const asManager = t.withIdentity({ subject: `m_${suffix}`, clerkId: `m_${suffix}` });

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+9627931${suffix}1`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+9627931${suffix}2`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, managerId, asUser, asManager, customerA, customerB };
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
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

async function quoteFor(seed: Seed, customerId: Id<"customers">, vehicles: Array<Id<"vehicles">>) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId: vehicles[0],
    ...(vehicles.length > 1
      ? { vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })) }
      : {}),
    mode: "CASH" as const,
    vehiclePrice: PRICE * vehicles.length,
    downPayment: 0,
    termMonths: 0,
  });
}

const depositOn = async (seed: Seed, quoteId: Id<"quotes">, amount: number) =>
  await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount });

const directSale = async (
  seed: Seed,
  quoteId: Id<"quotes">,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
) =>
  (await seed.asUser.mutation(api.sales.create, {
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    quoteId,
  })) as Id<"sales">;

const cancelSale = async (seed: Seed, saleId: Id<"sales">) =>
  await seed.asManager.mutation(api.sales.update, {
    orgId: seed.orgId,
    saleId,
    status: "CANCELLED" as const,
  });

// ── observation ─────────────────────────────────────────────────────────────

const rootsOn = async (seed: Seed, v: Id<"vehicles">) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("commitmentRoots").collect()).filter((r) => String(r.vehicleId) === String(v))
  );

const claimsOn = async (seed: Seed, v: Id<"vehicles">) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
      (c) => String(c.vehicleId) === String(v)
    )
  );

const depositRow = async (seed: Seed, id: Id<"deposits">) =>
  (await seed.t.run((ctx) => ctx.db.get(id)))!;

const vehicleRow = async (seed: Seed, id: Id<"vehicles">) =>
  (await seed.t.run((ctx) => ctx.db.get(id)))!;

const authorityAudit = async (seed: Seed) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("financialAuditLog").collect()).filter(
      (row) => row.actionType === "SETTLE_COMMITMENT_AUTHORITY"
    )
  );

/**
 * Finish whatever the cancellation deferred to the outbox, exactly as the
 * drain does — the reversal completion and the authority settlement in ONE
 * transaction, because that is what `markEntryPosted` runs.
 *
 * ⚠️ RETURNS WHETHER IT DID ANYTHING, so a contract can state which of the two
 * cancellation paths it exercised instead of quietly passing on neither.
 */
async function drainDeferredReversals(seed: Seed) {
  const pending = await seed.t.run(async (ctx) =>
    (await ctx.db.query("depositApplications").collect()).filter(
      (row) => String(row.orgId) === String(seed.orgId) && row.status === "REVERSING"
    )
  );
  const outcomes: Array<string> = [];
  for (const application of pending) {
    // Accounting completion and authority settlement are separate transactions
    // in production (SCRUM-208 c15814), so drive them as two steps here too.
    const freed = await seed.t.run((ctx) =>
      completeDeferredReversal(ctx, {
        orgId: seed.orgId,
        reversalIdempotencyKey: `reversed_${application.eventIdempotencyKey}`,
        postedAt: Date.now(),
      })
    );
    const outcome = await settleSources(
      seed.t,
      seed.orgId,
      seed.managerId,
      freed,
      `reversed_${application.eventIdempotencyKey}`
    );
    if (outcome) outcomes.push(outcome.outcome);
  }
  return outcomes;
}

/**
 * A real single-vehicle deal: quote → deposit → completed sale → cancelled,
 * with whatever the cancellation deferred then drained.
 *
 * ⚠️ EVERY STEP IS A PRODUCT DOOR. Nothing is inserted or patched by hand.
 */
async function cancelledRealDeal(seed: Seed, customerId: Id<"customers">) {
  const vehicleId = await vehicle(seed);
  const quoteId = await quoteFor(seed, customerId, [vehicleId]);
  const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;
  const beforeSale = await claimsOn(seed, vehicleId);
  const saleId = await directSale(seed, quoteId, vehicleId, customerId);
  const afterSale = await claimsOn(seed, vehicleId);
  await cancelSale(seed, saleId);
  const drained = await drainDeferredReversals(seed);
  return { vehicleId, quoteId, depositId, saleId, beforeSale, afterSale, drained };
}

// ═════════════════════════════════════════════════════════════════════════════
// S.1 — THE REPRESENTATION CLASS HAS A PRODUCTION WRITER
// ═════════════════════════════════════════════════════════════════════════════

describe("S.1 every deposit the product creates declares its representation", () => {
  test("S.1a a single-vehicle deposit is DIRECT and names its episode", async () => {
    const seed = await seedDealer("s1a");
    const vehicleId = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;

    const deposit = await depositRow(seed, depositId);
    // ⚠️ `false`, NOT `undefined`. The canonical DIRECT range is an equality on
    // this column, and `undefined` is a different key: a deposit without it is
    // invisible to the authority for its whole life.
    expect(deposit.usesVehicleHoldRows, "the discriminator is written at insert").toBe(false);

    const claims = await claimsOn(seed, vehicleId);
    expect(claims.length).toBe(1);
    expect(
      String(deposit.singleVehicleCommitmentClaimId),
      "and the maintained pointer names the episode this money opened"
    ).toBe(String(claims[0]._id));

    const held = await seed.t.run(async (ctx) => {
      const decision = await requireDecisionContext(
        ctx,
        beginUserRun(seed.userId, Date.now()),
        seed.orgId
      );
      return await hasCanonicalDepositHold(ctx, decision, vehicleId);
    });
    expect(held, "so the canonical reader can see an ordinary deposit").toBe(true);
  });

  test("S.1b a multi-vehicle deposit is SLICED, and carries no direct pointer", async () => {
    const seed = await seedDealer("s1b");
    const first = await vehicle(seed);
    const second = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [first, second]);
    const depositId = (await depositOn(seed, quoteId, 4_000)) as Id<"deposits">;

    const deposit = await depositRow(seed, depositId);
    expect(deposit.usesVehicleHoldRows, "its cars are held by hold rows").toBe(true);
    // ⚠️ THE DUAL FORM IS CORRUPTION EVEN WHEN BOTH AGREE. `resolveCanonicalBinding`
    // refuses a deposit carrying both representations, so the writer must not
    // create one.
    expect(deposit.singleVehicleCommitmentClaimId).toBeUndefined();

    const holds = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => String(h.depositId) === String(depositId)
      )
    );
    expect(holds.length).toBe(2);
    for (const hold of holds) {
      expect(hold.sourceCommitmentClaimId, "each slice names the episode it was created with")
        .toBeDefined();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.2 — WHAT REAL FINALIZATION ACTUALLY LEAVES BEHIND
//
// The state the restoration model must be keyed on. Asserted here rather than
// assumed, because assuming it wrong is the defect this phase was blocked for.
// ═════════════════════════════════════════════════════════════════════════════

describe("S.2 a completed sale consumes the ROOT and leaves its episodes alone", () => {
  test("S.2a the root carries the sale; every claim is byte-identical", async () => {
    const seed = await seedDealer("s2a");
    const vehicleId = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    await depositOn(seed, quoteId, 2_000);

    const before = await claimsOn(seed, vehicleId);
    const saleId = await directSale(seed, quoteId, vehicleId, seed.customerA);
    const after = await claimsOn(seed, vehicleId);

    const roots = await rootsOn(seed, vehicleId);
    expect(roots.length).toBe(1);
    expect(roots[0].status).toBe("CONSUMED");
    expect(String(roots[0].consumedBySaleId)).toBe(String(saleId));

    // ⚠️ THE FACT THE WHOLE RESTORATION MODEL TURNS ON. Finalization does not
    // scan or patch episodes — F.12 — so a restoration that waits for a
    // CONSUMED claim waits forever.
    expect(after).toEqual(before);
    expect(after.every((c) => c.status === "ACTIVE"), "claims stay ACTIVE on a sold deal").toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.3 — THE SPINE
// ═════════════════════════════════════════════════════════════════════════════

describe("S.3 cancelling a real sale gives the customer their deal back", () => {
  test("S.3a a successor generation opens, the pointer moves, the car is held", async () => {
    const seed = await seedDealer("s3a");
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const roots = await rootsOn(seed, deal.vehicleId);
    expect(roots.length, "the terminal root stays as history; a successor is opened").toBe(2);
    const predecessor = roots.find((r) => r.status !== "OPEN")!;
    const successor = roots.find((r) => r.status === "OPEN")!;
    expect(predecessor.status).toBe("CONSUMED");
    expect(String(predecessor.consumedBySaleId)).toBe(String(deal.saleId));

    expect(String(successor.customerId), "the SAME customer, carried not re-derived").toBe(
      String(seed.customerA)
    );
    expect(String(successor.lineageRootId), "one lineage across the generations").toBe(
      String(predecessor.lineageRootId)
    );
    expect(successor.lineageGeneration).toBe((predecessor.lineageGeneration ?? 0) + 1);
    expect(String(successor.restoredFromRootId)).toBe(String(predecessor._id));

    const claims = await claimsOn(seed, deal.vehicleId);
    expect(claims.length, "one new episode, and the old one untouched").toBe(2);
    const successorClaim = claims.find((c) => String(c.rootId) === String(successor._id))!;
    const predecessorClaim = claims.find((c) => String(c.rootId) === String(predecessor._id))!;
    expect(String(successorClaim.restoredFromClaimId)).toBe(String(predecessorClaim._id));
    expect(successorClaim.evidenceKind, "the predecessor's own tag, never a default").toBe(
      predecessorClaim.evidenceKind
    );
    // ⚠️ THE PREDECESSOR IS STILL ACTIVE, AND THAT IS CORRECT. I10: a claim on
    // a non-OPEN root is stale bookkeeping, not ownership.
    expect(predecessorClaim.status).toBe("ACTIVE");
    expect(deal.afterSale).toEqual(deal.beforeSale);

    const deposit = await depositRow(seed, deal.depositId);
    expect(deposit.status, "the money is the customer's held funds again").toBe("HELD");
    expect(deposit.holdActive).toBe(true);
    expect(
      String(deposit.singleVehicleCommitmentClaimId),
      "and it names the NEW episode, not the one it was reversed out of"
    ).toBe(String(successorClaim._id));

    const ownership = await seed.t.run((ctx) =>
      resolveOwnership(ctx, seed.orgId, deal.vehicleId)
    );
    expect(ownership.kind).toBe("OWNED");
    expect(String((ownership as { root: Doc<"commitmentRoots"> }).root._id)).toBe(
      String(successor._id)
    );

    // ⚠️ THE PROJECTION IS PART OF THE POSTCONDITION. A restored deal whose car
    // still advertises as available is the same defect one layer down.
    expect((await vehicleRow(seed, deal.vehicleId)).status).toBe("RESERVED");
  });

  test("S.3b a rival cannot take the car after the restoration", async () => {
    const seed = await seedDealer("s3b");
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const rivalQuote = await quoteFor(seed, seed.customerB, [deal.vehicleId]);
    let threw: unknown = null;
    try {
      await depositOn(seed, rivalQuote, 1_000);
    } catch (e) {
      threw = e;
    }
    expect(threw, "the restored deal holds the car against a rival").not.toBeNull();

    // And nothing of the rival's attempt survives.
    expect((await rootsOn(seed, deal.vehicleId)).length).toBe(2);
  });

  test("S.3c the outcome is recorded durably, and it says RESTORED", async () => {
    const seed = await seedDealer("s3c");
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const recorded: string[] = [
      ...deal.drained,
      ...(await authorityAudit(seed)).map(
        (row) => (row.after as { outcome?: string } | undefined)?.outcome ?? "«no outcome»"
      ),
    ];
    // ⚠️ NOT VACUOUS: one of the two cancellation paths must actually have run.
    expect(recorded.length, "the cancellation settled the authority somewhere").toBeGreaterThan(0);
    expect(recorded).toContain("RESTORED");
  });

  test("S.3d settling twice does not open a second successor", async () => {
    const seed = await seedDealer("s3d");
    const deal = await cancelledRealDeal(seed, seed.customerA);
    const before = await seed.t.run(async (ctx) => ({
      roots: (await ctx.db.query("commitmentRoots").collect()).length,
      claims: (await ctx.db.query("vehicleCommitmentClaims").collect()).length,
    }));

    // The drain is at-least-once. Running it again must change nothing.
    await drainDeferredReversals(seed);

    const after = await seed.t.run(async (ctx) => ({
      roots: (await ctx.db.query("commitmentRoots").collect()).length,
      claims: (await ctx.db.query("vehicleCommitmentClaims").collect()).length,
    }));
    expect(after).toEqual(before);
    expect((await rootsOn(seed, deal.vehicleId)).filter((r) => r.status === "OPEN").length).toBe(1);
  });
});

// ── the accounting fixture the DEFERRED path needs ──────────────────────────
//
// ⚠️ A CANCELLATION WHOSE ORIGINAL POSTING NEVER POSTED REVERSES SYNCHRONOUSLY,
// through `reinstateAppliedDeposits` — a different authority path entirely. The
// deferred worker is reached only when the original DID post and the reversal
// cannot: sell inside an open month, close the month, cancel, then reopen so
// the queued reversal can finally post. That is an ordinary business sequence,
// and it is the only one that reaches the code S.4b/S.4c are about.

async function openAccountingMonth(seed: Seed) {
  const year = new Date().getUTCFullYear();
  await seed.asManager.mutation(api.chartOfAccounts.initialize, { orgId: seed.orgId });
  await seed.asManager.mutation(api.accountingPeriods.create, {
    orgId: seed.orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await seed.asManager.query(api.accountingPeriods.list, {
    orgId: seed.orgId,
  }))[0]!;
  await seed.asManager.mutation(api.accountingPeriods.open, {
    orgId: seed.orgId,
    periodId: period._id,
  });
  return period;
}

async function closeAccountingMonth(seed: Seed, periodId: Id<"accountingPeriods">) {
  const checklist = await seed.asManager.query(api.accountingPeriods.closeChecklist, {
    orgId: seed.orgId,
    periodId,
  });
  await seed.asManager.mutation(api.accountingPeriods.close, {
    orgId: seed.orgId,
    periodId,
    overrideReason: "test fixture: closing the month before the cancellation",
    acknowledgedWarnings: (checklist.warnings ?? []).map((w) =>
      typeof w === "string" ? w : String((w as { message?: string }).message ?? w)
    ),
  });
}

/**
 * Run a cancellation and let the whole deferred chain finish deterministically.
 *
 * ⚠️ THE FAKE TIMERS GO ON BEFORE THE MUTATION THAT SCHEDULES, NOT AFTER.
 * `runAfter` creates its timer inside the mutation, so installing them
 * afterwards leaves the chain on real timers where the pump cannot reach it —
 * and the contract then races, passing or failing on machine speed. Only the
 * timer functions are faked: freezing `Date` would move every row out of the
 * due-time window the dispatcher compares against.
 */
async function cancelAndDrain(
  seed: Seed,
  periodId: Id<"accountingPeriods">,
  cancel: () => Promise<unknown>
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    await cancel();
    // The queued reversal cannot post into a closed month — it waits, which is
    // the whole reason the REVERSING state exists. Reopening is what finally
    // lets it through, and it is the accountant's ordinary next step rather
    // than a test shortcut: `reopen` schedules the drain itself.
    await seed.asManager.mutation(api.accountingPeriods.reopen, {
      orgId: seed.orgId,
      periodId,
      reason: "cancellation reversal must post",
    });
    await seed.t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

/** The authority work this organization's deferred cancellation produced. */
const authorityWorkFor = async (seed: Seed) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("commitmentAuthorityWork").collect()).filter(
      (w) => String(w.orgId) === String(seed.orgId)
    )
  );

const summarisedOutcomes = async (seed: Seed) =>
  await seed.t.run(async (ctx) =>
    (await ctx.db.query("pendingAccountingEvents").collect())
      .map((p) => p.authorityOutcome)
      .filter(Boolean)
  );

/**
 * Every assertion c15831 requires of a withheld legacy slice, in one place so
 * the two public doors cannot drift apart in what they prove.
 */
async function expectWithheldWithNoAuthorityResidue(
  seed: Seed,
  before: { roots: Doc<"commitmentRoots">[]; claims: Doc<"vehicleCommitmentClaims">[]; holds: Doc<"depositVehicleHolds">[] },
  depositId: Id<"deposits">,
  sourceKind: "DIRECT" | "SLICE"
) {
  const settled = await authorityWorkFor(seed);
  // ⚠️ IT MUST HAVE BEEN THE DEFERRED PATH, IN THE EXPECTED REPRESENTATION.
  // Without this the contract could pass against a synchronous reversal, which
  // is a different code path and not the one this ruling is about.
  expect(settled, "the deferred authority worker was reached").toHaveLength(1);
  expect(settled[0]!.sourceKind, "in the expected representation").toBe(sourceKind);
  expect(settled[0]!.status).toBe("SETTLED");
  expect(settled[0]!.outcome).toBe("AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE");
  // Terminal on the first execution — no technical retry spent on an answer no
  // retry can change.
  expect(settled[0]!.executions, "no retry budget consumed").toBe(1);

  const summarised = await summarisedOutcomes(seed);
  expect(summarised).toContain("AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE");
  expect(summarised).not.toContain("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT");
  expect(summarised).not.toContain("ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS");
  expect(summarised).not.toContain("RESTORED");

  // ⚠️ NOT ONE CANONICAL BYTE MOVED. Root statuses are compared as a SET,
  // because the damage the old fallthrough did was to CHANGE one — and an
  // assertion that only counted OPEN roots would miss a release that happened
  // to be offset by another open row.
  const after = await seed.t.run(async (ctx) => ({
    roots: await ctx.db.query("commitmentRoots").collect(),
    claims: await ctx.db.query("vehicleCommitmentClaims").collect(),
    holds: await ctx.db.query("depositVehicleHolds").collect(),
  }));
  expect(
    after.roots.map((r) => `${String(r._id)}:${r.status}`).sort(),
    "legacy liveness readers may not terminalize a canonical root"
  ).toEqual(before.roots.map((r) => `${String(r._id)}:${r.status}`).sort());
  expect(after.claims.length, "no successor claim was opened").toBe(before.claims.length);
  expect(
    after.holds.map((h) => `${String(h._id)}:${h.active}`).sort(),
    "no slice was re-activated — a withheld answer restores nothing"
  ).toEqual(before.holds.map((h) => `${String(h._id)}:${h.active}`).sort());
  expect((await depositRow(seed, depositId)).status, "and the money is untouched").toBe("HELD");
}

// ═════════════════════════════════════════════════════════════════════════════
// S.4 — A LEGACY ORGANIZATION KEEPS WORKING
// ═════════════════════════════════════════════════════════════════════════════

describe("S.4 an organization without the canonical authority", () => {
  test("S.4a the money still comes back, and the authority says WITHHELD", async () => {
    const seed = await seedDealer("s4a", { canonical: false });
    const deal = await cancelledRealDeal(seed, seed.customerA);

    const deposit = await depositRow(seed, deal.depositId);
    // ⚠️ THE NON-NEGOTIABLE HALF. Gating the money on a restoration that can
    // never succeed on a legacy org would strand the customer's deposit.
    expect(deposit.status).toBe("HELD");
    expect(deposit.holdActive).toBe(true);

    const recorded: string[] = [
      ...deal.drained,
      ...(await authorityAudit(seed)).map(
        (row) => (row.after as { outcome?: string } | undefined)?.outcome ?? "«no outcome»"
      ),
    ];
    expect(recorded.length).toBeGreaterThan(0);
    // ⚠️ AND IT MUST NOT CLAIM A RESTORATION. Nothing was examined: the
    // pre-Phase-3 state was silence, and asserting RESTORED here would be a
    // false audit record — strictly worse than the silence it replaced.
    expect(recorded).toContain("AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE");
    expect(recorded).not.toContain("RESTORED");

    // No canonical rows were invented for an org that is not on the model.
    expect((await rootsOn(seed, deal.vehicleId)).filter((r) => r.status === "OPEN").length).toBe(0);
  });

  /**
   * SCRUM-208 c15831 — THE SLICED PATH MUST WITHHOLD TOO, AND FOR A REASON
   * STRONGER THAN SYMMETRY.
   *
   * ⚠️ TWO DEFECTS WERE FOUND HERE IN SUCCESSIVE ROUNDS, AND THE SECOND WAS MY
   * REPAIR FOR THE FIRST.
   *
   * First, the sliced path ran the canonical contradiction probe for ANY
   * resolvable context — and a legacy org resolves. The canonical readers throw
   * for non-V1, the probe persists that throw verbatim, and every sliced
   * deferred reversal in every dealership was recorded as "your records
   * contradict each other". Both reviewer seats found that independently.
   *
   * I then gated only the PROBE on V1 and let a legacy slice fall through to
   * `settleAuthorityAfterReversal`, on the grounds that changing legacy
   * behaviour was a product decision. The structural objection I missed: that
   * fallthrough reaches `releaseRootIfNoLiveBasis`, which patches
   * `commitmentRoots.status = "RELEASED"` — a CANONICAL write — on the word of
   * `hasLiveCommitmentBasis` using the LEGACY readers. **S.6a above proves that
   * exact reader false-negatives on a stale backlog.** So the fallthrough could
   * release a live deal's canonical root, which is the precise harm S.6 exists
   * to forbid, reached through the one door that still used the old reader.
   *
   * Legacy data may not authorize a canonical write. An operational
   * legacy-slice settlement, if AutoFlow needs one, is SCRUM-201's to design
   * explicitly — not something obtained sideways through the canonical worker.
   */
  test("S.4b a SLICED legacy deal withholds through api.sales.update, touching no authority", async () => {
    const seed = await seedDealer("s4b", { canonical: false });

    // ⚠️ THE REVERSAL MUST ACTUALLY DEFER, OR THIS CONTRACT TESTS THE WRONG
    // CODE. A cancellation whose original posting never posted reverses
    // synchronously through `reinstateAppliedDeposits` — a different authority
    // path entirely. The deferred SLICE worker is only reached when the
    // original DID post and the reversal cannot: sell inside an open month,
    // close the month, then cancel. That is an ordinary business sequence, and
    // it is the only one that reaches the code this ruling is about.
    const year = new Date().getUTCFullYear();
    await seed.asManager.mutation(api.chartOfAccounts.initialize, { orgId: seed.orgId });
    await seed.asManager.mutation(api.accountingPeriods.create, {
      orgId: seed.orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await seed.asManager.query(api.accountingPeriods.list, {
      orgId: seed.orgId,
    }))[0]!;
    await seed.asManager.mutation(api.accountingPeriods.open, {
      orgId: seed.orgId,
      periodId: period._id,
    });

    const vehicleA = await vehicle(seed);
    const vehicleB = await vehicle(seed);
    // Two vehicles on one quote is the definition of the sliced representation.
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleA, vehicleB]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;
    // ⚠️ THE PRODUCT REFUSES TO COMPLETE THE SALE UNTIL THE CUSTOMER'S SPLIT IS
    // RECORDED, and it is right to: the share cannot be inferred from prices.
    // Going through the real allocation door is what makes the slice rows this
    // contract depends on exist at all.
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: vehicleA, amount: 1_200 },
        { vehicleId: vehicleB, amount: 800 },
      ],
    });
    const saleId = await directSale(seed, quoteId, vehicleA, seed.customerA);

    // Close the month the sale posted in, so the cancellation's reversing entry
    // has nowhere to post and is queued instead.
    const checklist = await seed.asManager.query(api.accountingPeriods.closeChecklist, {
      orgId: seed.orgId,
      periodId: period._id,
    });
    await seed.asManager.mutation(api.accountingPeriods.close, {
      orgId: seed.orgId,
      periodId: period._id,
      overrideReason: "test fixture: closing the month before the cancellation",
      acknowledgedWarnings: (checklist.warnings ?? []).map((w) =>
        typeof w === "string" ? w : String((w as { message?: string }).message ?? w)
      ),
    });

    const before = await seed.t.run(async (ctx) => ({
      roots: await ctx.db.query("commitmentRoots").collect(),
      claims: await ctx.db.query("vehicleCommitmentClaims").collect(),
      holds: await ctx.db.query("depositVehicleHolds").collect(),
    }));

    // ⚠️ NOTHING IS DRAINED BY HAND HERE, AND THE SCHEDULER IS DRIVEN
    // DETERMINISTICALLY. The cancellation queues the reversing entry, the
    // outbox drain posts it, `markEntryPosted` records the authority work, and
    // the dispatcher and settlement each run in their own scheduled
    // transaction — exactly as production does. This is the first contract in
    // the repo that reaches the deferred authority worker with no seeded row.
    //
    // ⚠️ THE FAKE TIMERS GO ON BEFORE THE MUTATION THAT SCHEDULES, NOT AFTER.
    // `runAfter` creates its timer inside the mutation, so installing them
    // afterwards leaves the chain on real timers where the pump cannot reach
    // it — and the contract then races, passing or failing on machine speed.
    // Only the timer functions are faked: freezing `Date` would move every row
    // out of the due-time window the dispatcher compares against.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      await cancelSale(seed, saleId);
      // The queued reversal cannot post into a closed month — it waits, which
      // is the whole reason the REVERSING state exists. Reopening is what
      // finally lets it through, and it is the accountant's ordinary next
      // step, not a test shortcut: `reopen` schedules the drain itself.
      await seed.asManager.mutation(api.accountingPeriods.reopen, {
        orgId: seed.orgId,
        periodId: period._id,
        reason: "cancellation reversal must post",
      });
      await seed.t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    await expectWithheldWithNoAuthorityResidue(seed, before, depositId, "SLICE");

    // Vehicle B was never part of the cancelled sale and must be inert.
    expect((await rootsOn(seed, vehicleB)).filter((r) => r.status === "OPEN").length).toBe(1);
  });

  /**
   * THE SECOND PUBLIC DOOR — AND THE REACHABILITY BOUNDARY THAT SHAPES IT.
   *
   * ⚠️ THE SLICED REPRESENTATION CANNOT REACH THIS DOOR AT ALL, and that is a
   * product rule rather than an oversight: `applications.createFromQuote`
   * refuses a multi-vehicle quote outright ("Finance applications currently
   * support exactly one vehicle"), because `finalizeDeal` only ever completes
   * `app.vehicleId`'s sale and would silently drop the rest. A sliced deposit
   * requires a multi-vehicle quote. The two are mutually exclusive.
   *
   * So this door carries the DIRECT representation, and the contract asserted
   * is the same one — a legacy dealership withholds and touches no canonical
   * authority. The refusal itself is pinned below, so the day financed deals
   * gain multi-vehicle support, this test fails and whoever changes it is told
   * that the sliced withheld contract now needs extending to this door too.
   */
  test("S.4c a multi-vehicle quote cannot reach the applications door at all", async () => {
    const seed = await seedDealer("s4c", { canonical: false });
    const vehicleA = await vehicle(seed);
    const vehicleB = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleA, vehicleB]);
    await depositOn(seed, quoteId, 2_000);

    await expect(
      seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      }),
      "if this ever succeeds, S.4b's sliced withheld contract must be extended to this door"
    ).rejects.toThrow(/exactly one vehicle/i);
  });

  test("S.4d the withheld contract holds through api.applications.cancelApplication", async () => {
    const seed = await seedDealer("s4d", { canonical: false });
    const period = await openAccountingMonth(seed);

    const vehicleA = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleA]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;

    // The financed close, through the real doors it actually requires.
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    // A salesperson may not approve their own application.
    await seed.asManager.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });
    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now() + 86_400_000,
    });
    await seed.asUser.mutation(api.applications.finalizeDeal, {
      orgId: seed.orgId,
      applicationId,
    });

    await closeAccountingMonth(seed, period._id);

    const before = await seed.t.run(async (ctx) => ({
      roots: await ctx.db.query("commitmentRoots").collect(),
      claims: await ctx.db.query("vehicleCommitmentClaims").collect(),
      holds: await ctx.db.query("depositVehicleHolds").collect(),
    }));

    await cancelAndDrain(seed, period._id, () =>
      seed.asManager.mutation(api.applications.cancelApplication, {
        orgId: seed.orgId,
        applicationId,
        reason: "customer withdrew",
      })
    );

    await expectWithheldWithNoAuthorityResidue(seed, before, depositId, "DIRECT");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.5 — "RESTORED" MEANS RESTORED
// ═════════════════════════════════════════════════════════════════════════════

describe("S.5 the outcome taxonomy tells the truth", () => {
  test("S.5a a free car reports NO_RESTORABLE_BASIS, never RESTORED", async () => {
    const seed = await seedDealer("s5a");
    const vehicleId = await vehicle(seed);

    const outcome = await seed.t.run((ctx) =>
      settleAuthorityAfterReversal(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: Date.now(),
        reason: "deferred reversal posted",
      })
    );
    expect(outcome.outcome).toBe("ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS");
  });

  test("S.5b a car nothing holds is released, and that is not a restoration", async () => {
    const seed = await seedDealer("s5b");
    const vehicleId = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;
    // The deposit's own door ends its hold — the money side stays a manager's
    // decision, which is exactly why the ROOT must then close on its own.
    await seed.t.run((ctx) => ctx.db.patch(depositId, { holdActive: false }));

    const outcome = await seed.t.run((ctx) =>
      settleAuthorityAfterReversal(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: Date.now(),
        reason: "deferred reversal posted",
      })
    );
    expect(outcome.outcome).toBe("ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS");
    expect((await rootsOn(seed, vehicleId))[0].status).toBe("RELEASED");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S.6 — THE AUTHORITY MAY NOT REST ON THE DEFECTIVE LEGACY READER
//
// ⚠️ THE ONE PLACE THIS FILE MANUFACTURES STATE, AND IT IS A CORRUPTION
// FIXTURE BY DESIGN. `getActiveDepositHolds` `.take(50)`s an index range and
// post-filters it, so fifty stale rows in front of a live one make it answer
// "nothing holds this car". `releaseRootIfNoLiveBasis` writes on that answer.
// ═════════════════════════════════════════════════════════════════════════════

describe("S.6 a stale-row backlog cannot release a live deal", () => {
  async function withStaleBacklog(seed: Seed) {
    const vehicleId = await vehicle(seed);
    // Fifty rows that LOOK live to the legacy index and are not: resolved
    // deposits that kept `holdActive`. They carry no representation class,
    // which is what a pre-cutover row looks like — so they are outside the
    // canonical range entirely and inside the legacy one.
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < 50; i += 1) {
        await ctx.db.insert("deposits", {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerB,
          amount: 1,
          status: "VOIDED" as const,
          holdActive: true,
          createdBy: seed.userId,
          createdAt: Date.now(),
        });
      }
    });
    const quoteId = await quoteFor(seed, seed.customerA, [vehicleId]);
    const depositId = (await depositOn(seed, quoteId, 2_000)) as Id<"deposits">;
    return { vehicleId, depositId };
  }

  test("S.6a the legacy reader false-negatives on this state", async () => {
    const seed = await seedDealer("s6a");
    const { vehicleId } = await withStaleBacklog(seed);

    const legacy = await seed.t.run((ctx) =>
      hasLiveCommitmentBasis(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: Date.now(),
        excludeKinds: ["RESERVATION", "FINANCE"],
      })
    );
    // Documented, not endorsed: this is the reader SCRUM-201's cutover
    // replaces. The contract that matters is S.6b.
    expect(legacy, "the capped post-filtered read cannot see the live deposit").toBe(false);
  });

  test("S.6b the canonical decision sees it, and the live root survives", async () => {
    const seed = await seedDealer("s6b");
    const { vehicleId } = await withStaleBacklog(seed);
    const openBefore = (await rootsOn(seed, vehicleId)).filter((r) => r.status === "OPEN");
    expect(openBefore.length, "the deal is live before anything settles").toBe(1);

    await seed.t.run(async (ctx) => {
      const now = Date.now();
      const decision = await requireDecisionContext(ctx, beginUserRun(seed.userId, now), seed.orgId);
      const live = await hasLiveCommitmentBasis(ctx, {
        orgId: seed.orgId,
        vehicleId,
        decisionNow: now,
        decision,
        excludeKinds: ["RESERVATION", "FINANCE"],
      });
      expect(live, "the exact range is not fooled by fifty stale rows").toBe(true);

      await releaseRootIfNoLiveBasis(ctx, {
        orgId: seed.orgId,
        vehicleId,
        reason: "deferred reversal posted",
        decisionNow: now,
        decision,
      });
    });

    const openAfter = (await rootsOn(seed, vehicleId)).filter((r) => r.status === "OPEN");
    expect(
      openAfter.length,
      "the customer who paid still holds the car — releasing here is how a rival takes it"
    ).toBe(1);
    expect(String(openAfter[0]._id)).toBe(String(openBefore[0]._id));
  });
});
