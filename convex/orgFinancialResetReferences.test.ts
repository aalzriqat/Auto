import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { RESET_TABLES_FOR_TEST } from "./orgFinancialReset";
import {
  beginInProgressReset,
  rowsOf,
  runContinuationBatch,
  seedBase as seedBaseFor,
  type Base,
  type LooseDb,
} from "../test-utils/orgResetFixtures";

/**
 * SCRUM-559 — the organization financial reset.
 *
 *  1. PREFLIGHT (I1): a destructive run needs a suspended org with no PENDING
 *     payment intent, and refuses BEFORE any delete otherwise.
 *  2. PROMOTED REFERENCES (I2): six optional references that user-facing or
 *     outbox code dereferences were promoted to CHILD_TABLES edges (E1-E6). Each
 *     test seeds the pair in CROSSED order at `batchSize: 1`: a one-row pass
 *     deletes parent #1 first, while the surviving child #2 names it. Without the
 *     edge, the child dangles after one pass.
 *  3. FULL DRAIN (I4): every edge together drains to zero, and every promoted
 *     reference resolves after EVERY pass.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

type T = ReturnType<typeof setup>;

function setup() {
  return convexTestWithComponents(schema, MODULES);
}

const seedBase = (ctx: MutationCtx, tag: string, suspended = true) =>
  seedBaseFor(ctx, tag, "refs559_", suspended);

type Pair = readonly [table: string, field: string, target: string];
type Seed = (ctx: MutationCtx, b: Base) => Promise<void>;

interface RefCheck {
  /** Every survivor whose reference no longer resolves. */
  dangling: string[];
  /** Survivors whose id belongs to a table other than the pair's target: never counted as resolved. */
  wrongTable: string[];
  /** Per `table.field`: how many survivors held an id that RESOLVED to a live row. */
  resolved: Record<string, number>;
}

/**
 * One `t.run` over `pairs`. `dangling` alone can pass by emptiness: a misspelled
 * field path reads `undefined` on every row and is skipped, so it reports nothing.
 * `resolved` is the other half: a pair that never resolved a single id was not checked.
 */
async function checkRefs(t: T, orgId: Id<"organizations">, pairs: ReadonlyArray<Pair>): Promise<RefCheck> {
  return await t.run(async (ctx) => {
    const db = ctx.db as unknown as LooseDb & { normalizeId(table: string, id: string): string | null };
    const out: RefCheck = { dangling: [], wrongTable: [], resolved: {} };
    for (const [table, field, target] of pairs) {
      const key = `${table}.${field}`;
      out.resolved[key] = 0;
      for (const row of await rowsOf(db, table, orgId)) {
        // A dotted field ("custodyPosted.custodyId") names a nested reference.
        const id = field.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | null | undefined)?.[k], row);
        if (id == null) continue;
        // An id of ANOTHER table is not a reference to `target`, even when its row is live.
        if (db.normalizeId(target, id as string) === null) out.wrongTable.push(`${key} -> ${target}`);
        else if ((await db.get(id)) === null) out.dangling.push(`${key} -> ${target}`);
        else out.resolved[key] += 1;
      }
    }
    return out;
  });
}

/** Every survivor, across `pairs`, whose reference no longer resolves; a wrong-table id counts as dangling too. */
async function dangling(t: T, orgId: Id<"organizations">, pairs: ReadonlyArray<Pair>): Promise<string[]> {
  const check = await checkRefs(t, orgId, pairs);
  return [...check.dangling, ...check.wrongTable.map((k) => `${k} (wrong table)`)];
}

/** The pairs that resolved no id at all: a vacuous or misspelled path, not a passing one. */
const vacuousPairs = (check: RefCheck): string[] =>
  Object.entries(check.resolved)
    .filter(([, n]) => n === 0)
    .map(([key]) => key);

async function survivors(t: T, orgId: Id<"organizations">, table: string): Promise<number> {
  return await t.run(async (ctx) => (await rowsOf(ctx.db as unknown as LooseDb, table, orgId)).length);
}

async function totalRows(t: T, orgId: Id<"organizations">): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const db = ctx.db as unknown as LooseDb;
    const out: Record<string, number> = {};
    for (const table of RESET_TABLES_FOR_TEST) out[table] = (await rowsOf(db, table, orgId)).length;
    return out;
  });
}

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

// D-19: fresh starts are refused; exercised as a continuation.
function onePass(t: T, orgId: Id<"organizations">) {
  return runContinuationBatch(t, orgId, 1);
}

// ── Seed helpers ────────────────────────────────────────────────────────────

async function seedApplications(ctx: MutationCtx, b: Base, count: number) {
  const quoteId = await ctx.db.insert("quotes", {
    orgId: b.orgId, customerId: b.customerId, vehicleId: b.vehicleId, vehiclePrice: 15000,
    downPayment: 1000, termMonths: 48, status: "ACCEPTED", createdBy: b.userId, createdAt: b.now,
  });
  const ids: Id<"financeApplications">[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(
      await ctx.db.insert("financeApplications", {
        orgId: b.orgId, quoteId, customerId: b.customerId, vehicleId: b.vehicleId,
        salespersonId: b.userId, status: "APPROVED", createdAt: b.now, updatedAt: b.now,
      })
    );
  }
  return ids;
}

async function insertCheque(
  ctx: MutationCtx,
  b: Base,
  n: number,
  refs: {
    applicationId?: Id<"financeApplications">;
    originApplicationId?: Id<"financeApplications">;
    receivableId?: Id<"receivables">;
  }
) {
  return await ctx.db.insert("postDatedCheques", {
    orgId: b.orgId, customerId: b.customerId, bank: "Bank", chequeNumber: `CH-${n}`,
    chequeDate: b.now, amount: 500, status: "HELD", createdBy: b.userId, createdAt: b.now,
    updatedAt: b.now, ...refs,
  });
}

async function insertReceivable(ctx: MutationCtx, b: Base, n: number, outstanding = 500) {
  return await ctx.db.insert("receivables", {
    orgId: b.orgId, customerId: b.customerId, sourceType: "OTHER", title: `R${n}`,
    originalAmount: 500, outstandingAmount: outstanding, dueDate: b.now, status: "OPEN",
    createdBy: b.userId, createdAt: b.now, updatedAt: b.now,
  });
}

/**
 * Two parents, then two children where child [n] names parent [1 - n]: a
 * one-row pass deletes parent #0 while child #1, which names it, survives.
 */
async function seedCrossed<P>(
  makeParent: (n: number) => Promise<P>,
  makeChild: (n: number, parent: P) => Promise<unknown>
): Promise<void> {
  const parents = [await makeParent(0), await makeParent(1)];
  for (const n of [0, 1]) await makeChild(n, parents[1 - n]);
}

const seedE1: Seed = (ctx, b) =>
  seedCrossed(
    (n) =>
      ctx.db.insert("canonicalPayments", {
        orgId: b.orgId, direction: "IN", method: "CASH", amountMinor: 1000, currency: "JOD",
        scale: 3, status: "SETTLED", idempotencyKey: `e1-cp-${n}`, createdBy: b.userId, createdAt: b.now,
      }),
    (_n, canonicalPaymentId) =>
      ctx.db.insert("collectionPayments", {
        orgId: b.orgId, customerId: b.customerId, canonicalPaymentId,
        direction: "IN", method: "CASH", amount: 1, paymentDate: b.now, status: "POSTED",
        cashierId: b.userId, createdAt: b.now,
      })
  );

const seedE2: Seed = (ctx, b) =>
  seedCrossed(
    (n) =>
      ctx.db.insert("journalEntries", {
        orgId: b.orgId, journalNumber: `E2-JE-${n}`, accountingDate: b.now, sourceType: "TEST",
        sourceId: `e2-${n}`, category: "SYSTEM", memo: "m", status: "POSTED",
        postedBy: b.userId, postedAt: b.now, createdAt: b.now,
      }),
    (n, journalEntryId) =>
      ctx.db.insert("accountingEvents", {
        orgId: b.orgId, eventType: "TEST_EVENT", sourceType: "TEST", sourceId: `e2-ev-${n}`,
        eventVersion: 1, idempotencyKey: `e2-ev-${n}`, occurredAt: b.now, accountingDate: b.now,
        currency: "JOD", payload: {}, status: "POSTED", createdBy: b.userId, createdAt: b.now,
        journalEntryId,
      })
  );

const seedE3: Seed = (ctx, b) =>
  seedCrossed(
    (n) =>
      ctx.db.insert("accountingEvents", {
        orgId: b.orgId, eventType: "TEST_EVENT", sourceType: "TEST", sourceId: `e3-ev-${n}`,
        eventVersion: 1, idempotencyKey: `e3-ev-${n}`, occurredAt: b.now, accountingDate: b.now,
        currency: "JOD", payload: {}, status: "POSTED", createdBy: b.userId, createdAt: b.now,
      }),
    (n, originalEventId) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: b.orgId, kind: "REVERSE", status: "PENDING", idempotencyKey: `e3-pe-${n}`,
        accountingDate: b.now, actorId: b.userId, attempts: 0, createdAt: b.now,
        sourceType: "TEST", sourceId: `e3-pe-${n}`, originalEventId,
      })
  );

const seedE4: Seed = async (ctx, b) => {
  const [applicationId] = await seedApplications(ctx, b, 1);
  await seedCrossed(
    (n) =>
      ctx.db.insert("financeDealCustody", {
        orgId: b.orgId, applicationId, userId: b.userId, currency: "JOD", issuedMinor: 0,
        returnedMinor: 0, reimbursedMinor: 0, status: "OPEN", createdBy: b.userId,
        createdAt: b.now + n, updatedAt: b.now,
      }),
    (_n, custodyId) =>
      ctx.db.insert("financeDealFees", {
        orgId: b.orgId, applicationId, feeType: "APPRAISAL_FEE", currency: "JOD",
        paidBy: "DEALER", paidTo: "APPRAISER", accountingTreatment: "APPRAISAL_EXPENSE",
        includedInQuotation: false, deductedFromSettlement: false, refundable: false,
        custodyId, custodyPosted: { version: 1, amountMinor: 0, custodyId },
        source: "MANUAL", createdBy: b.userId, createdAt: b.now, updatedAt: b.now,
      })
  );
};

const seedE5: Seed = async (ctx, b) => {
  const apps = await seedApplications(ctx, b, 2);
  await seedCrossed(
    async (n) => apps[n],
    (n, appId) => insertCheque(ctx, b, 500 + n, { applicationId: appId, originApplicationId: appId })
  );
};

const seedE6 = (ctx: MutationCtx, b: Base, outstanding = 500) =>
  seedCrossed(
    (n) => insertReceivable(ctx, b, n, outstanding),
    (n, receivableId) => insertCheque(ctx, b, 600 + n, { receivableId })
  );

const E1: Pair = ["collectionPayments", "canonicalPaymentId", "canonicalPayments"];
const E2: Pair = ["accountingEvents", "journalEntryId", "journalEntries"];
const E3: Pair = ["pendingAccountingEvents", "originalEventId", "accountingEvents"];
const E4A: Pair = ["financeDealFees", "custodyId", "financeDealCustody"];
const E4B: Pair = ["financeDealFees", "custodyPosted.custodyId", "financeDealCustody"];
const E5A: Pair = ["postDatedCheques", "applicationId", "financeApplications"];
const E5B: Pair = ["postDatedCheques", "originApplicationId", "financeApplications"];
const E6: Pair = ["postDatedCheques", "receivableId", "receivables"];

/** One row per promoted edge: its seed, and the reference pairs it must keep resolving. */
const EDGES: ReadonlyArray<{ id: string; label: string; seed: Seed; pairs: ReadonlyArray<Pair> }> = [
  { id: "E1", label: "collectionPayments.canonicalPaymentId -> canonicalPayments", seed: seedE1, pairs: [E1] },
  { id: "E2", label: "accountingEvents.journalEntryId -> journalEntries", seed: seedE2, pairs: [E2] },
  { id: "E3", label: "pendingAccountingEvents.originalEventId -> accountingEvents", seed: seedE3, pairs: [E3] },
  {
    id: "E4",
    label: "financeDealFees.custodyId / custodyPosted.custodyId -> financeDealCustody",
    seed: seedE4,
    pairs: [E4A, E4B],
  },
  {
    id: "E5",
    label: "postDatedCheques.applicationId / originApplicationId -> financeApplications",
    seed: seedE5,
    pairs: [E5A, E5B],
  },
  { id: "E6", label: "postDatedCheques.receivableId -> receivables", seed: seedE6, pairs: [E6] },
];

const PROMOTED: ReadonlyArray<Pair> = EDGES.flatMap((e) => e.pairs);
const ALL_SEEDS: ReadonlyArray<Seed> = EDGES.map((e) => e.seed);

async function seedOrg(seed: Seed, tag: string) {
  const t = setup();
  const orgId = await t.run(async (ctx) => {
    const b = await seedBase(ctx, tag);
    await seed(ctx, b);
    return b.orgId;
  });
  return { t, orgId };
}

// ── 1. Preflight ────────────────────────────────────────────────────────────

type IntentStatus = "PENDING" | "SETTLED" | "FAILED" | "EXPIRED";

async function insertIntent(ctx: MutationCtx, b: Base, status: IntentStatus, k: string) {
  return await ctx.db.insert("paymentIntents", {
    orgId: b.orgId, customerId: b.customerId, amountMinor: 1000, currency: "JOD",
    provider: "TEST", status, idempotencyKey: `intent-${k}`, createdBy: b.userId,
    createdAt: b.now, updatedAt: b.now,
  });
}

/** An org that owns financial rows in several reset tables, plus one payment intent per `intents` entry. */
async function seedPreflightOrg(
  tag: string,
  opts: {
    suspended?: boolean;
    intents?: ReadonlyArray<IntentStatus>;
    /** SCRUM-571 S1 (D-22): one `unmatchedProviderFunds` row per entry, with that review status. */
    heldCaptures?: ReadonlyArray<"OPEN" | "RESOLVED">;
  } = {}
) {
  const t = setup();
  const orgId = await t.run(async (ctx) => {
    const b = await seedBase(ctx, tag, opts.suspended ?? true);
    for (const seed of ALL_SEEDS) await seed(ctx, b);
    for (const [i, status] of (opts.intents ?? []).entries()) await insertIntent(ctx, b, status, `${status}-${i}`);
    for (const [i, reviewStatus] of (opts.heldCaptures ?? []).entries()) {
      await ctx.db.insert("unmatchedProviderFunds", {
        orgId: b.orgId, provider: "TEST", externalId: `held-${tag}-${i}`, reason: "INTENT_NOT_PENDING",
        amountMinor: 1000, currency: "JOD", providerEventIds: [], deliveryCount: 1, amountConflict: false,
        reviewStatus, firstReceivedAt: b.now, lastReceivedAt: b.now,
      });
    }
    return b.orgId;
  });
  return { t, orgId };
}

describe("resetOrgFinancialData preflight (SCRUM-559 I1)", () => {
  test.each([
    {
      name: "an unsuspended organization",
      tag: "Unsuspended",
      opts: { suspended: false },
      refusal: /Suspend this organization/,
    },
    {
      name: "a suspended organization with a PENDING payment intent",
      tag: "PendingIntent",
      opts: { intents: ["PENDING"] as const },
      refusal: /pending online payment intents/,
    },
    // SCRUM-571 S1 (D-22): a held provider capture of ANY review status blocks.
    {
      name: "a suspended organization with an OPEN held provider capture",
      tag: "HeldOpen",
      opts: { heldCaptures: ["OPEN"] as const },
      refusal: /verified provider capture is held/,
    },
    {
      name: "a suspended organization with only a RESOLVED held provider capture",
      tag: "HeldResolved",
      opts: { heldCaptures: ["RESOLVED"] as const },
      refusal: /verified provider capture is held/,
    },
  ])("$name is refused and ZERO rows are deleted", async ({ tag, opts, refusal }) => {
    const { t, orgId } = await seedPreflightOrg(tag, opts);
    const before = await totalRows(t, orgId);
    expect(sum(before)).toBeGreaterThan(0);

    // D-19: fresh starts are refused; exercised as a continuation.
    await beginInProgressReset(t, orgId);
    await expect(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun: false })
    ).rejects.toThrow(refusal);

    expect(await totalRows(t, orgId)).toEqual(before);
  });

  // D-23 Q1: the unconditional refusal is the S1 stand-in for D-15's HALT. A
  // continuation (reset already in progress) with a held row refuses BEFORE any
  // deletion, and repeating the call is stable.
  test.each([
    { name: "an OPEN held capture", tag: "ContHeldOpen", status: "OPEN" as const },
    { name: "a RESOLVED held capture", tag: "ContHeldResolved", status: "RESOLVED" as const },
  ])("D-23: a continuation with $name refuses before any deletion, twice, with the generation unchanged", async ({ tag, status }) => {
    const { t, orgId } = await seedPreflightOrg(tag, { heldCaptures: [status] });
    await beginInProgressReset(t, orgId);
    const readGeneration = () =>
      t.run(async (ctx) => {
        const org = await ctx.db.get(orgId);
        return {
          generation: org?.financialResetGeneration,
          completed: org?.financialResetCompletedGeneration,
        };
      });
    const before = await totalRows(t, orgId);
    expect(sum(before)).toBeGreaterThan(0);
    const generationBefore = await readGeneration();
    expect(generationBefore.generation).not.toEqual(generationBefore.completed);

    for (let call = 0; call < 2; call += 1) {
      await expect(
        t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun: false })
      ).rejects.toThrow(/verified provider capture is held/);
      expect(await totalRows(t, orgId)).toEqual(before);
      expect(await readGeneration()).toEqual(generationBefore);
    }
  });

  test("a PENDING intent of ANOTHER organization does not block this one", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const other = await seedBase(ctx, "OtherOrg");
      await insertIntent(ctx, other, "PENDING", "other");
      const b = await seedBase(ctx, "ThisOrg");
      for (const seed of ALL_SEEDS) await seed(ctx, b);
      return b.orgId;
    });
    const result = await onePass(t, orgId);
    expect(result.total).toBeGreaterThan(0);
  });

  test("a suspended organization whose intents are all SETTLED, FAILED or EXPIRED proceeds", async () => {
    const { t, orgId } = await seedPreflightOrg("TerminalIntents", {
      intents: ["SETTLED", "FAILED", "EXPIRED"],
    });
    const before = sum(await totalRows(t, orgId));

    const result = await onePass(t, orgId);

    expect(result.pendingPaymentIntentsPresent).toBe(false);
    expect(result.orgSuspended).toBe(true);
    expect(sum(await totalRows(t, orgId))).toBeLessThan(before);
  });

  test("D-22: a held provider capture of ANOTHER organization does not block this one, and the dry run reports the flag", async () => {
    const t = setup();
    const { orgId, otherId } = await t.run(async (ctx) => {
      const other = await seedBase(ctx, "OtherHeldOrg");
      await ctx.db.insert("unmatchedProviderFunds", {
        orgId: other.orgId, provider: "TEST", externalId: "held-other", reason: "INTENT_NOT_PENDING",
        amountMinor: 1000, currency: "JOD", providerEventIds: [], deliveryCount: 1, amountConflict: false,
        reviewStatus: "OPEN", firstReceivedAt: other.now, lastReceivedAt: other.now,
      });
      const b = await seedBase(ctx, "ThisHeldOrg");
      for (const seed of ALL_SEEDS) await seed(ctx, b);
      return { orgId: b.orgId, otherId: other.orgId };
    });
    const dry = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId });
    expect(dry.heldProviderCapturesPresent).toBe(false);
    const otherDry = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: otherId });
    expect(otherDry.heldProviderCapturesPresent).toBe(true);
    const result = await onePass(t, orgId);
    expect(result.total).toBeGreaterThan(0);
  });

  test("a dry run on an unsuspended organization works, reports both conditions and deletes nothing", async () => {
    const { t, orgId } = await seedPreflightOrg("DryUnsuspended", { suspended: false, intents: ["PENDING"] });
    const before = await totalRows(t, orgId);

    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId });

    expect(result.dryRun).toBe(true);
    expect(result.orgSuspended).toBe(false);
    expect(result.pendingPaymentIntentsPresent).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(await totalRows(t, orgId)).toEqual(before);
  });
});

// ── 2. One test per promoted edge ───────────────────────────────────────────

describe("resetOrgFinancialData keeps a promoted reference resolving after a one-row pass (SCRUM-559 I2)", () => {
  test.each(EDGES)("$id $label", async ({ id, seed, pairs }) => {
    const { t, orgId } = await seedOrg(seed, id);
    await onePass(t, orgId);
    expect(await survivors(t, orgId, pairs[0][0])).toBeGreaterThan(0);
    const check = await checkRefs(t, orgId, pairs);
    expect(check.dangling).toEqual([]);
    expect(check.wrongTable).toEqual([]);
    // Every promoted pair must have RESOLVED at least one id, or the check above proved nothing.
    expect(vacuousPairs(check), `pairs that resolved no id: ${JSON.stringify(check.resolved)}`).toEqual([]);
  });

  test("CONTROL: a misspelled field path is reported as vacuous, not as passing", async () => {
    const { t, orgId } = await seedOrg(seedE4, "E4Control");
    await onePass(t, orgId);
    const good = await checkRefs(t, orgId, [E4B]);
    expect(vacuousPairs(good)).toEqual([]);
    const misspelled: Pair = ["financeDealFees", "custodyPosted.custodyID", "financeDealCustody"];
    const bad = await checkRefs(t, orgId, [misspelled]);
    expect(bad.dangling).toEqual([]); // the old check was silent here: it would have passed
    expect(vacuousPairs(bad)).toEqual(["financeDealFees.custodyPosted.custodyID"]);
  });

  test("CONTROL (N2): dangling() reports a wrong-table pair instead of dropping it", async () => {
    const { t, orgId } = await seedOrg(seedE4, "E4N2");
    await onePass(t, orgId);
    const wrong: Pair = ["financeDealFees", "applicationId", "financeDealCustody"];
    expect(await dangling(t, orgId, [wrong])).toEqual(["financeDealFees.applicationId -> financeDealCustody (wrong table)"]);
  });

  test("CONTROL (F4): an id from a different table is not counted as resolved against the pair's target", async () => {
    const { t, orgId } = await seedOrg(seedE4, "E4WrongTable");
    await onePass(t, orgId);
    // financeDealFees.applicationId holds a LIVE financeApplications id, not a financeDealCustody one.
    const wrong: Pair = ["financeDealFees", "applicationId", "financeDealCustody"];
    const check = await checkRefs(t, orgId, [wrong]);
    expect(check.wrongTable).toEqual(["financeDealFees.applicationId -> financeDealCustody"]);
    expect(check.resolved["financeDealFees.applicationId"]).toBe(0);
    expect(vacuousPairs(check)).toEqual(["financeDealFees.applicationId"]);
  });
});

// ── 2b. E6 on the real path: clearing the surviving cheque (R1 / #17) ───────

describe("E6 on the real path: collections.clearCheque after a partial pass", () => {
  test("the surviving cheque still meets its receivable's outstanding-amount check", async () => {
    const t = setup();
    // The receivable owes LESS than the cheque face: clearing must be refused.
    const { orgId } = await t.run(async (ctx) => {
      const b = await seedBase(ctx, "ClearCheque");
      await ctx.db.insert("subscriptions", {
        orgId: b.orgId, plan: "professional", status: "active", createdAt: b.now, updatedAt: b.now,
      });
      const roleId = await ctx.db.insert("roles", {
        orgId: b.orgId, name: "Owner", isSystemOwnerRole: true,
        permissions: ["view:finance", "manage:finance"],
      });
      await ctx.db.insert("memberships", { orgId: b.orgId, userId: b.userId, roleId });
      await ctx.db.insert("orgSettings", {
        orgId: b.orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
      });
      await seedE6(ctx, b, 100);
      return { orgId: b.orgId };
    });

    await onePass(t, orgId);

    // Unsuspended only so the tenant-authenticated mutation can run. A dangling
    // receivableId would skip the outstanding-amount check and insert a payment
    // naming a deleted receivable.
    await t.run((ctx) => ctx.db.patch(orgId, { suspended: false }));
    const survivor = await t.run(async (ctx) =>
      (await rowsOf(ctx.db as unknown as LooseDb, "postDatedCheques", orgId))[0]
    );
    expect(survivor).toBeDefined();
    const asUser = t.withIdentity({ subject: "refs559_ClearCheque", clerkId: "refs559_ClearCheque" });

    await expect(
      asUser.mutation(api.collections.clearCheque, {
        orgId,
        chequeId: survivor._id as Id<"postDatedCheques">,
        idempotencyKey: "clear-559",
      })
    ).rejects.toThrow(/cannot exceed the outstanding receivable amount/);

    expect(await dangling(t, orgId, [["collectionPayments", "receivableId", "receivables"]])).toEqual([]);
  });
});

// ── 3. Full drain ───────────────────────────────────────────────────────────

describe("resetOrgFinancialData drains a populated organization to zero (SCRUM-559 I4)", () => {
  test("every promoted reference resolves after EVERY pass and the run reaches zero", async () => {
    const { t, orgId } = await seedPreflightOrg("FullDrain");
    const total = sum(await totalRows(t, orgId));
    expect(total).toBeGreaterThan(0);

    // A pass deletes at least one row or the run is stuck: rows + a small margin bounds a healthy drain.
    const maxPasses = total + 10;
    let remaining = Number.POSITIVE_INFINITY;
    let passes = 0;
    while (remaining > 0 && passes < maxPasses) {
      const res = await onePass(t, orgId);
      remaining = res.remaining;
      passes += 1;
      expect(await dangling(t, orgId, PROMOTED), `pass ${passes}`).toEqual([]);
    }

    expect(remaining, `still ${remaining} rows after ${passes} passes`).toBe(0);
    const left = await totalRows(t, orgId);
    expect(Object.entries(left).filter(([, n]) => n > 0)).toEqual([]);
  });
});
