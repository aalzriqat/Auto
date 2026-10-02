import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { RESET_ORG_INDEX_FOR_TEST, RESET_TABLES_FOR_TEST } from "./orgFinancialReset";

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

interface LooseDb {
  query(table: string): {
    withIndex(
      index: string,
      range: (q: { eq(field: string, value: unknown): unknown }) => unknown
    ): { collect(): Promise<Array<Record<string, unknown>>> };
  };
  get(id: unknown): Promise<unknown>;
}

type Pair = readonly [table: string, field: string, target: string];

const E1: Pair = ["collectionPayments", "canonicalPaymentId", "canonicalPayments"];
const E2: Pair = ["accountingEvents", "journalEntryId", "journalEntries"];
const E3: Pair = ["pendingAccountingEvents", "originalEventId", "accountingEvents"];
const E4: Pair = ["financeDealFees", "custodyId", "financeDealCustody"];
const E5A: Pair = ["postDatedCheques", "applicationId", "financeApplications"];
const E5B: Pair = ["postDatedCheques", "originApplicationId", "financeApplications"];
const E6: Pair = ["postDatedCheques", "receivableId", "receivables"];
const PROMOTED: ReadonlyArray<Pair> = [E1, E2, E3, E4, E5A, E5B, E6];

async function rowsOf(db: LooseDb, table: string, orgId: Id<"organizations">) {
  return await db
    .query(table)
    .withIndex(RESET_ORG_INDEX_FOR_TEST[table], (q) => q.eq("orgId", orgId))
    .collect();
}

/** Every survivor of `pair`'s table whose reference no longer resolves. */
async function danglingFor(t: T, orgId: Id<"organizations">, pair: Pair): Promise<string[]> {
  return await t.run(async (ctx) => {
    const db = ctx.db as unknown as LooseDb;
    const out: string[] = [];
    for (const row of await rowsOf(db, pair[0], orgId)) {
      const id = row[pair[1]];
      if (id != null && (await db.get(id)) === null) out.push(`${pair[0]}.${pair[1]} -> ${pair[2]}`);
    }
    return out;
  });
}

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

function onePass(t: T, orgId: Id<"organizations">) {
  return t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun: false, batchSize: 1 });
}

// ── Seed helpers ────────────────────────────────────────────────────────────

interface Base {
  orgId: Id<"organizations">;
  userId: Id<"users">;
  vehicleId: Id<"vehicles">;
  customerId: Id<"customers">;
  now: number;
}

async function seedBase(ctx: MutationCtx, tag: string, suspended = true): Promise<Base> {
  const now = Date.now();
  const orgId = await ctx.db.insert("organizations", { name: tag, createdAt: now, suspended });
  const userId = await ctx.db.insert("users", {
    clerkId: `refs559_${tag}`,
    email: `${tag.replace(/\s/g, "")}@x.com`,
  });
  const vehicleId = await ctx.db.insert("vehicles", {
    orgId, vin: `VIN${tag}`, make: "Kia", model: "Rio", year: 2024, mileage: 10,
    color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15000,
    status: "AVAILABLE",
  });
  const customerId = await ctx.db.insert("customers", { orgId, firstName: "Refs", lastName: "Customer" });
  return { orgId, userId, vehicleId, customerId, now };
}

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

/** Child [i] names parent [1 - i]: a one-row pass deletes parent #0 while child #1 survives. */

async function seedE1(ctx: MutationCtx, b: Base) {
  const payments: Id<"canonicalPayments">[] = [];
  for (const n of [0, 1]) {
    payments.push(
      await ctx.db.insert("canonicalPayments", {
        orgId: b.orgId, direction: "IN", method: "CASH", amountMinor: 1000, currency: "JOD",
        scale: 3, status: "SETTLED", idempotencyKey: `e1-cp-${n}`, createdBy: b.userId, createdAt: b.now,
      })
    );
  }
  for (const n of [0, 1]) {
    await ctx.db.insert("collectionPayments", {
      orgId: b.orgId, customerId: b.customerId, canonicalPaymentId: payments[1 - n],
      direction: "IN", method: "CASH", amount: 1, paymentDate: b.now, status: "POSTED",
      cashierId: b.userId, createdAt: b.now,
    });
  }
}

async function seedE2(ctx: MutationCtx, b: Base) {
  const entries: Id<"journalEntries">[] = [];
  for (const n of [0, 1]) {
    entries.push(
      await ctx.db.insert("journalEntries", {
        orgId: b.orgId, journalNumber: `E2-JE-${n}`, accountingDate: b.now, sourceType: "TEST",
        sourceId: `e2-${n}`, category: "SYSTEM", memo: "m", status: "POSTED",
        postedBy: b.userId, postedAt: b.now, createdAt: b.now,
      })
    );
  }
  for (const n of [0, 1]) {
    await ctx.db.insert("accountingEvents", {
      orgId: b.orgId, eventType: "TEST_EVENT", sourceType: "TEST", sourceId: `e2-ev-${n}`,
      eventVersion: 1, idempotencyKey: `e2-ev-${n}`, occurredAt: b.now, accountingDate: b.now,
      currency: "JOD", payload: {}, status: "POSTED", createdBy: b.userId, createdAt: b.now,
      journalEntryId: entries[1 - n],
    });
  }
}

async function seedE3(ctx: MutationCtx, b: Base) {
  const events: Id<"accountingEvents">[] = [];
  for (const n of [0, 1]) {
    events.push(
      await ctx.db.insert("accountingEvents", {
        orgId: b.orgId, eventType: "TEST_EVENT", sourceType: "TEST", sourceId: `e3-ev-${n}`,
        eventVersion: 1, idempotencyKey: `e3-ev-${n}`, occurredAt: b.now, accountingDate: b.now,
        currency: "JOD", payload: {}, status: "POSTED", createdBy: b.userId, createdAt: b.now,
      })
    );
  }
  for (const n of [0, 1]) {
    await ctx.db.insert("pendingAccountingEvents", {
      orgId: b.orgId, kind: "REVERSE", status: "PENDING", idempotencyKey: `e3-pe-${n}`,
      accountingDate: b.now, actorId: b.userId, attempts: 0, createdAt: b.now,
      sourceType: "TEST", sourceId: `e3-pe-${n}`, originalEventId: events[1 - n],
    });
  }
}

async function seedE4(ctx: MutationCtx, b: Base) {
  const [applicationId] = await seedApplications(ctx, b, 1);
  const custodies: Id<"financeDealCustody">[] = [];
  for (const n of [0, 1]) {
    custodies.push(
      await ctx.db.insert("financeDealCustody", {
        orgId: b.orgId, applicationId, userId: b.userId, currency: "JOD", issuedMinor: 0,
        returnedMinor: 0, reimbursedMinor: 0, status: "OPEN", createdBy: b.userId,
        createdAt: b.now + n, updatedAt: b.now,
      })
    );
  }
  for (const n of [0, 1]) {
    await ctx.db.insert("financeDealFees", {
      orgId: b.orgId, applicationId, feeType: "APPRAISAL_FEE", currency: "JOD",
      paidBy: "DEALER", paidTo: "APPRAISER", accountingTreatment: "APPRAISAL_EXPENSE",
      includedInQuotation: false, deductedFromSettlement: false, refundable: false,
      custodyId: custodies[1 - n], source: "MANUAL", createdBy: b.userId, createdAt: b.now, updatedAt: b.now,
    });
  }
}

async function seedE5(ctx: MutationCtx, b: Base) {
  const apps = await seedApplications(ctx, b, 2);
  for (const n of [0, 1]) {
    await insertCheque(ctx, b, 500 + n, { applicationId: apps[1 - n], originApplicationId: apps[1 - n] });
  }
}

async function seedE6(ctx: MutationCtx, b: Base, outstanding = 500) {
  const receivables = [await insertReceivable(ctx, b, 0, outstanding), await insertReceivable(ctx, b, 1, outstanding)];
  for (const n of [0, 1]) await insertCheque(ctx, b, 600 + n, { receivableId: receivables[1 - n] });
}

async function seedOrg(seed: (ctx: MutationCtx, b: Base) => Promise<void>, tag: string) {
  const t = setup();
  const orgId = await t.run(async (ctx) => {
    const b = await seedBase(ctx, tag);
    await seed(ctx, b);
    return b.orgId;
  });
  return { t, orgId };
}

// ── 1. Preflight ────────────────────────────────────────────────────────────

async function insertIntent(ctx: MutationCtx, b: Base, status: "PENDING" | "SETTLED" | "FAILED" | "EXPIRED", k: string) {
  return await ctx.db.insert("paymentIntents", {
    orgId: b.orgId, customerId: b.customerId, amountMinor: 1000, currency: "JOD",
    provider: "TEST", status, idempotencyKey: `intent-${k}`, createdBy: b.userId,
    createdAt: b.now, updatedAt: b.now,
  } as never);
}

/** An org that owns financial rows in several reset tables. */
async function seedFinancialOrg(ctx: MutationCtx, b: Base) {
  await seedE1(ctx, b);
  await seedE2(ctx, b);
}

describe("resetOrgFinancialData preflight (SCRUM-559 I1)", () => {
  test("an unsuspended organization is refused and ZERO rows are deleted", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const b = await seedBase(ctx, "Unsuspended", false);
      await seedFinancialOrg(ctx, b);
      return b.orgId;
    });
    const before = await totalRows(t, orgId);
    expect(sum(before)).toBeGreaterThan(0);

    await expect(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun: false })
    ).rejects.toThrow(/Suspend this organization/);

    expect(await totalRows(t, orgId)).toEqual(before);
  });

  test("a suspended organization with a PENDING payment intent is refused and ZERO rows are deleted", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const b = await seedBase(ctx, "PendingIntent");
      await seedFinancialOrg(ctx, b);
      await insertIntent(ctx, b, "PENDING", "p");
      return b.orgId;
    });
    const before = await totalRows(t, orgId);
    expect(sum(before)).toBeGreaterThan(0);

    await expect(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun: false })
    ).rejects.toThrow(/pending online payment intents/);

    expect(await totalRows(t, orgId)).toEqual(before);
  });

  test("a PENDING intent of ANOTHER organization does not block this one", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const other = await seedBase(ctx, "OtherOrg");
      await insertIntent(ctx, other, "PENDING", "other");
      const b = await seedBase(ctx, "ThisOrg");
      await seedFinancialOrg(ctx, b);
      return b.orgId;
    });
    const result = await onePass(t, orgId);
    expect(result.total).toBeGreaterThan(0);
  });

  test("a suspended organization whose intents are all SETTLED, FAILED or EXPIRED proceeds", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const b = await seedBase(ctx, "TerminalIntents");
      await seedFinancialOrg(ctx, b);
      for (const s of ["SETTLED", "FAILED", "EXPIRED"] as const) await insertIntent(ctx, b, s, s);
      return b.orgId;
    });
    const before = sum(await totalRows(t, orgId));

    const result = await onePass(t, orgId);

    expect(result.pendingPaymentIntentsPresent).toBe(false);
    expect(result.orgSuspended).toBe(true);
    expect(sum(await totalRows(t, orgId))).toBeLessThan(before);
  });

  test("a dry run on an unsuspended organization works, reports both conditions and deletes nothing", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const b = await seedBase(ctx, "DryUnsuspended", false);
      await seedFinancialOrg(ctx, b);
      await insertIntent(ctx, b, "PENDING", "dry");
      return b.orgId;
    });
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
  test("E1 collectionPayments.canonicalPaymentId -> canonicalPayments", async () => {
    const { t, orgId } = await seedOrg(seedE1, "E1");
    await onePass(t, orgId);
    expect(await survivors(t, orgId, "collectionPayments")).toBeGreaterThan(0);
    expect(await danglingFor(t, orgId, E1)).toEqual([]);
  });

  test("E2 accountingEvents.journalEntryId -> journalEntries", async () => {
    const { t, orgId } = await seedOrg(seedE2, "E2");
    await onePass(t, orgId);
    expect(await survivors(t, orgId, "accountingEvents")).toBeGreaterThan(0);
    expect(await danglingFor(t, orgId, E2)).toEqual([]);
  });

  test("E3 pendingAccountingEvents.originalEventId -> accountingEvents", async () => {
    const { t, orgId } = await seedOrg(seedE3, "E3");
    await onePass(t, orgId);
    expect(await survivors(t, orgId, "pendingAccountingEvents")).toBeGreaterThan(0);
    expect(await danglingFor(t, orgId, E3)).toEqual([]);
  });

  test("E4 financeDealFees.custodyId -> financeDealCustody", async () => {
    const { t, orgId } = await seedOrg(seedE4, "E4");
    await onePass(t, orgId);
    expect(await survivors(t, orgId, "financeDealFees")).toBeGreaterThan(0);
    expect(await danglingFor(t, orgId, E4)).toEqual([]);
  });

  test("E5 postDatedCheques.applicationId / originApplicationId -> financeApplications", async () => {
    const { t, orgId } = await seedOrg(seedE5, "E5");
    await onePass(t, orgId);
    expect(await survivors(t, orgId, "postDatedCheques")).toBeGreaterThan(0);
    expect(await danglingFor(t, orgId, E5A)).toEqual([]);
    expect(await danglingFor(t, orgId, E5B)).toEqual([]);
  });

  test("E6 postDatedCheques.receivableId -> receivables", async () => {
    const { t, orgId } = await seedOrg(seedE6, "E6");
    await onePass(t, orgId);
    expect(await survivors(t, orgId, "postDatedCheques")).toBeGreaterThan(0);
    expect(await danglingFor(t, orgId, E6)).toEqual([]);
  });
});

// ── 2b. E6 on the real path: clearing the surviving cheque (R1 / #17) ───────

describe("E6 on the real path: collections.clearCheque after a partial pass", () => {
  test("the surviving cheque still meets its receivable's outstanding-amount check", async () => {
    const t = setup();
    // The receivable owes LESS than the cheque face: clearing must be refused.
    const { orgId } = await t.run(async (ctx) => {
      const b = await seedBase(ctx, "ClearCheque", false);
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
      await ctx.db.patch(b.orgId, { suspended: true });
      return { orgId: b.orgId };
    });

    await onePass(t, orgId);

    // Unsuspended ONLY so the tenant-authenticated mutation can run: the point
    // is the reference, not the auth. A dangling receivableId makes the cheque
    // skip the outstanding-amount check and insert a payment that names a
    // deleted receivable.
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

    expect(await danglingFor(t, orgId, ["collectionPayments", "receivableId", "receivables"])).toEqual([]);
  });
});

// ── 3. Full drain ───────────────────────────────────────────────────────────

describe("resetOrgFinancialData drains a populated organization to zero (SCRUM-559 I4)", () => {
  test("every promoted reference resolves after EVERY pass and the run reaches zero", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const b = await seedBase(ctx, "FullDrain");
      await seedE1(ctx, b);
      await seedE2(ctx, b);
      await seedE3(ctx, b);
      await seedE4(ctx, b);
      await seedE5(ctx, b);
      await seedE6(ctx, b);
      return b.orgId;
    });
    expect(sum(await totalRows(t, orgId))).toBeGreaterThan(0);

    const MAX_PASSES = 200;
    let remaining = Number.POSITIVE_INFINITY;
    let passes = 0;
    while (remaining > 0 && passes < MAX_PASSES) {
      const res = await onePass(t, orgId);
      remaining = res.remaining;
      passes += 1;
      for (const pair of PROMOTED) {
        expect(await danglingFor(t, orgId, pair), `pass ${passes}`).toEqual([]);
      }
    }

    expect(remaining, `still ${remaining} rows after ${passes} passes`).toBe(0);
    const left = await totalRows(t, orgId);
    expect(Object.entries(left).filter(([, n]) => n > 0)).toEqual([]);
  });
});
