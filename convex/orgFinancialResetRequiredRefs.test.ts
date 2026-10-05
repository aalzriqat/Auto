import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { RESET_TABLES_FOR_TEST } from "./orgFinancialReset";
import {
  rowsOf,
  runContinuationBatch,
  seedBase as seedBaseFor,
  type Base,
  type LooseDb,
} from "../test-utils/orgResetFixtures";

/**
 * SCRUM-549 — REQUIRED (and operationally dereferenced optional) references
 * between reset-scoped tables must never dangle after ANY pass of the reset.
 *
 * Every test drives the reset with `batchSize: 1` — the worst case, one row per
 * table per pass — and checks the invariant AFTER EACH PASS, not just at the
 * end: the reset is interruptible, so every intermediate state is a state the
 * dealership can be left in.
 *
 * The `commitmentAuthority*` edges (work -> deposits/sales/pendingEvents,
 * attempt -> work) are NOT exercised here: the authority preflight refuses a
 * destructive run while such rows exist, so they cannot be driven destructively.
 * They are covered by the schema walk in
 * `scripts/orgFinancialResetReferenceCoverage.test.ts`.
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

type Pair = readonly [string, string, string];

/** [child table, field (an id or an array of ids), target table]. */
const PAIRS: ReadonlyArray<Pair> = [
  ["journalLines", "journalEntryId", "journalEntries"],
  ["journalLines", "accountId", "chartOfAccounts"],
  ["accountBalanceSnapshots", "accountId", "chartOfAccounts"],
  ["paymentVouchers", "depositId", "deposits"],
  ["financeDealCustodyEntries", "custodyId", "financeDealCustody"],
  ["deposits", "canonicalPaymentId", "canonicalPayments"],
  ["receivables", "canonicalReceivableDocumentId", "receivableDocuments"],
  ["paymentAllocations", "paymentId", "canonicalPayments"],
  ["paymentAllocations", "receivableDocumentId", "receivableDocuments"],
  ["collectionApprovalRequests", "receivableId", "receivables"],
  ["collectionPayments", "paymentAllocationId", "paymentAllocations"],
];

/** D1 / D2 have dedicated ISOLATED tests (see below), so they are not in the table. */
const D1: Pair = ["deposits", "canonicalPaymentId", "canonicalPayments"];
const D2: Pair = ["receivables", "canonicalReceivableDocumentId", "receivableDocuments"];

const key = (p: Pair) => `${p[0]}.${p[1]}->${p[2]}`;

/** Every PAIRS reference held by a surviving row that no longer resolves. */
async function danglingNow(t: T, orgId: Id<"organizations">): Promise<string[]> {
  return await t.run(async (ctx) => {
    const db = ctx.db as unknown as LooseDb;
    const out: string[] = [];
    for (const pair of PAIRS) {
      for (const row of await rowsOf(db, pair[0], orgId)) {
        const raw = row[pair[1]];
        const ids = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
        for (const id of ids) {
          if ((await db.get(id)) === null) out.push(key(pair));
        }
      }
    }
    return out;
  });
}

async function populatedTables(t: T, orgId: Id<"organizations">): Promise<string[]> {
  return await t.run(async (ctx) => {
    const db = ctx.db as unknown as LooseDb;
    const out: string[] = [];
    for (const table of RESET_TABLES_FOR_TEST) {
      if ((await rowsOf(db, table, orgId)).length > 0) out.push(table);
    }
    return out;
  });
}

// ── Shared seed helpers ─────────────────────────────────────────────────────

const seedBase = (ctx: MutationCtx, tag: string) => seedBaseFor(ctx, tag, "req_refs_");

async function insertCanonicalPayment(ctx: MutationCtx, b: Base, k: string) {
  return await ctx.db.insert("canonicalPayments", {
    orgId: b.orgId, direction: "IN", method: "CASH", amountMinor: 1000, currency: "JOD",
    scale: 3, status: "SETTLED", idempotencyKey: k, createdBy: b.userId, createdAt: b.now,
  });
}

async function insertReceivableDocument(ctx: MutationCtx, b: Base, k: string) {
  return await ctx.db.insert("receivableDocuments", {
    orgId: b.orgId, documentType: "INVOICE", documentNumber: k, payerType: "CUSTOMER",
    customerId: b.customerId, sourceType: "TEST", sourceId: k, originalAmountMinor: 1000,
    currency: "JOD", scale: 3, issueDate: b.now, dueDate: b.now, status: "OPEN",
    createdAt: b.now, createdBy: b.userId,
  });
}

async function insertDeposit(ctx: MutationCtx, b: Base, canonicalPaymentId: Id<"canonicalPayments">) {
  return await ctx.db.insert("deposits", {
    orgId: b.orgId, vehicleId: b.vehicleId, customerId: b.customerId, amount: 1000,
    status: "HELD", holdActive: false, canonicalPaymentId, createdBy: b.userId,
    createdAt: b.now,
  });
}

async function insertReceivable(
  ctx: MutationCtx,
  b: Base,
  i: number,
  canonicalReceivableDocumentId: Id<"receivableDocuments">
) {
  return await ctx.db.insert("receivables", {
    orgId: b.orgId, customerId: b.customerId, sourceType: "OTHER", title: `R${i}`,
    originalAmount: 1, outstandingAmount: 1, dueDate: b.now, status: "OPEN",
    canonicalReceivableDocumentId, createdBy: b.userId, createdAt: b.now, updatedAt: b.now,
  });
}

/**
 * Seeds an org with TWO of everything on each protected edge, so that a
 * one-row-per-table pass always leaves a second row behind.
 */
async function seedGraph(t: T, name: string) {
  return await t.run(async (ctx) => {
    const b = await seedBase(ctx, name);
    const { orgId, userId, vehicleId, customerId, now } = b;
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 15000, downPayment: 1000,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: now,
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId,
      status: "APPROVED", createdAt: now, updatedAt: now,
    });

    // General ledger: 2 accounts, 2 entries x 2 lines (every line/account combo
    // is used by both entries), 1 period, a snapshot per account.
    const periodId = await ctx.db.insert("accountingPeriods", {
      orgId, startDate: now, endDate: now + 1, fiscalYear: 2026, periodNumber: 1,
      status: "OPEN", createdAt: now,
    });
    const account = async (code: string) =>
      await ctx.db.insert("chartOfAccounts", {
        orgId, code, name: `Acct ${code}`, type: "ASSET", normalBalance: "DEBIT",
        isControlAccount: false, allowManualPosting: true, active: true,
        createdAt: now, updatedAt: now,
      });
    const accounts = [await account("1000"), await account("1100")];
    for (const accountId of accounts) {
      await ctx.db.insert("accountBalanceSnapshots", {
        orgId, accountId, currency: "JOD", periodId,
        runningDebitMinor: 0, runningCreditMinor: 0, updatedAt: now,
      });
    }
    for (const n of [1, 2]) {
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId, journalNumber: `JE-${n}`, accountingDate: now, sourceType: "TEST",
        sourceId: `s${n}`, category: "SYSTEM", memo: "m", status: "POSTED",
        postedBy: userId, postedAt: now, createdAt: now,
      });
      for (const [i, accountId] of accounts.entries()) {
        await ctx.db.insert("journalLines", {
          orgId, journalEntryId, lineNumber: i + 1, accountId,
          debitMinor: i === 0 ? 100 : 0, creditMinor: i === 0 ? 0 : 100,
          currency: "JOD", scale: 3, accountingDate: now,
        });
      }
    }

    // Receivables subledger and money movement. Parents are created first and
    // every child points at the OTHER parent (index 1 - i): row order alone then
    // cannot hide a violation, because a one-row pass deletes parent #1 while
    // child #2 (the survivor) still references it.
    const parents = async (i: number) => ({
      canonicalPaymentId: await insertCanonicalPayment(ctx, b, `cp-${i}`),
      receivableDocumentId: await insertReceivableDocument(ctx, b, `INV-${i}`),
    });
    const base = [await parents(0), await parents(1)];
    const deposits = [
      await insertDeposit(ctx, b, base[1].canonicalPaymentId),
      await insertDeposit(ctx, b, base[0].canonicalPaymentId),
    ];
    const receivables = [
      await insertReceivable(ctx, b, 0, base[1].receivableDocumentId),
      await insertReceivable(ctx, b, 1, base[0].receivableDocumentId),
    ];
    const allocations = [];
    for (const i of [0, 1]) {
      allocations.push(
        await ctx.db.insert("paymentAllocations", {
          orgId, paymentId: base[1 - i].canonicalPaymentId,
          receivableDocumentId: base[1 - i].receivableDocumentId, amountMinor: 1000,
          currency: "JOD", scale: 3, allocationDate: now, status: "ACTIVE",
          createdBy: userId, createdAt: now,
        })
      );
    }
    for (const i of [0, 1]) {
      await ctx.db.insert("paymentVouchers", {
        orgId, depositId: deposits[1 - i], voucherNumber: `V-${i}`, customerId,
        customerNameSnapshot: "c", descriptionAr: "d", amount: 1000, amountMinor: 1000,
        currency: "JOD", issuedAt: now, issuedBy: userId,
      });
      await ctx.db.insert("collectionApprovalRequests", {
        orgId, receivableId: receivables[1 - i], customerId, requestedBy: userId,
        requestType: "REFUND", status: "PENDING", reason: "r", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("collectionPayments", {
        orgId, customerId, paymentAllocationId: allocations[1 - i],
        canonicalPaymentId: base[i].canonicalPaymentId, receivableId: receivables[i],
        direction: "IN", method: "CASH", amount: 1, paymentDate: now, status: "POSTED",
        cashierId: userId, createdAt: now,
      });
    }

    // Custody: 2 records x 2 entries.
    for (const n of [1, 2]) {
      const custodyId = await ctx.db.insert("financeDealCustody", {
        orgId, applicationId, userId, currency: "JOD", issuedMinor: 0, returnedMinor: 0,
        reimbursedMinor: 0, status: "OPEN", createdBy: userId, createdAt: now, updatedAt: now,
      });
      for (const e of [1, 2]) {
        await ctx.db.insert("financeDealCustodyEntries", {
          orgId, custodyId, kind: "ISSUED", amountMinor: 10 * n + e, occurredAt: now,
          recordedBy: userId, recordedAt: now,
        });
      }
    }
    return orgId;
  });
}

const MAX_PASSES = 200;

/** Drives destructive batchSize-1 passes, recording what dangled after each. */
async function drive(t: T, orgId: Id<"organizations">) {
  const dangling = new Set<string>();
  const trace: string[] = [];
  let passes = 0;
  let remaining = Infinity;
  while (remaining > 0 && passes < MAX_PASSES) {
    // D-19: fresh starts are refused; exercised as a continuation.
    const res = await runContinuationBatch(t, orgId, 1);
    remaining = res.remaining;
    passes += 1;
    for (const k of await danglingNow(t, orgId)) {
      dangling.add(k);
      trace.push(`pass ${passes}: ${k}`);
    }
  }
  return { dangling, trace, passes, remaining };
}

/** Seeds an ISOLATED fixture (just the pair under test) and drives it to completion. */
async function driveIsolated(
  tag: string,
  seed: (ctx: MutationCtx, b: Base) => Promise<void>
) {
  const t = setup();
  const orgId = await t.run(async (ctx) => {
    const b = await seedBase(ctx, tag);
    await seed(ctx, b);
    return b.orgId;
  });
  return await drive(t, orgId);
}

let shared: ReturnType<typeof runShared> | undefined;
async function runShared() {
  const t = setup();
  const orgId = await seedGraph(t, "Refs Motors");
  // A bystander org with the same shape, which must be untouched throughout.
  const other = await seedGraph(t, "Bystander Refs");
  const result = await drive(t, orgId);
  return {
    result,
    otherPopulatedAfter: await populatedTables(t, other),
    otherDanglingAfter: await danglingNow(t, other),
    orgPopulatedAfter: await populatedTables(t, orgId),
  };
}
const getShared = () => (shared ??= runShared());

describe("resetOrgFinancialData never leaves a required reference dangling (SCRUM-549)", () => {
  test("fixture sanity: the seed really populates every protected pair", async () => {
    const t = setup();
    const orgId = await seedGraph(t, "Sanity Motors");
    const populated = await populatedTables(t, orgId);
    for (const [child, , target] of PAIRS) {
      expect(populated, `${child} not seeded`).toContain(child);
      expect(populated, `${target} not seeded`).toContain(target);
    }
    expect(await danglingNow(t, orgId)).toEqual([]);
  });

  // D1 and D2 run on ISOLATED fixtures. In the full graph a neighbouring edge
  // (paymentAllocations / paymentVouchers still populated) defers the same
  // target and would mask a missing `deposits` / `receivables` edge.
  test("(v) D1: a surviving deposit's canonicalPayment always resolves", async () => {
    const result = await driveIsolated("D1 Motors", async (ctx, b) => {
      const payments = [
        await insertCanonicalPayment(ctx, b, "d1-0"),
        await insertCanonicalPayment(ctx, b, "d1-1"),
      ];
      // Cross-linked: deposit #2 (the pass-1 survivor) names payment #1.
      await insertDeposit(ctx, b, payments[1]);
      await insertDeposit(ctx, b, payments[0]);
    });
    expect(result.dangling.has(key(D1)), result.trace.join("\n")).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("(vi) D2: a surviving receivable's receivableDocument always resolves", async () => {
    const result = await driveIsolated("D2 Motors", async (ctx, b) => {
      const docs = [
        await insertReceivableDocument(ctx, b, "D2-0"),
        await insertReceivableDocument(ctx, b, "D2-1"),
      ];
      await insertReceivable(ctx, b, 0, docs[1]);
      await insertReceivable(ctx, b, 1, docs[0]);
    });
    expect(result.dangling.has(key(D2)), result.trace.join("\n")).toBe(false);
    expect(result.remaining).toBe(0);
  });

  // Three more pairs run ISOLATED because in the shared graph another child
  // defers the same target at least as long, so removing their own CHILD_TABLES
  // edge would leave the full-graph test green:
  //   paymentAllocations.paymentId            (deposits also defer canonicalPayments)
  //   paymentAllocations.receivableDocumentId (receivables also defer it)
  //   accountBalanceSnapshots.accountId       (journalLines defer chartOfAccounts longer)
  // Here ONLY the child under test is seeded, so no neighbour can hold the parent.
  const A1: Pair = ["paymentAllocations", "paymentId", "canonicalPayments"];
  const A2: Pair = ["paymentAllocations", "receivableDocumentId", "receivableDocuments"];
  const S1: Pair = ["accountBalanceSnapshots", "accountId", "chartOfAccounts"];

  /** Two payments, two documents, two cross-linked allocations and nothing else. */
  const seedAllocationsOnly = async (ctx: MutationCtx, b: Base) => {
    const payments = [
      await insertCanonicalPayment(ctx, b, "al-p0"),
      await insertCanonicalPayment(ctx, b, "al-p1"),
    ];
    const docs = [
      await insertReceivableDocument(ctx, b, "AL-0"),
      await insertReceivableDocument(ctx, b, "AL-1"),
    ];
    // Allocation #2 (the pass-1 survivor) names payment #1 / document #1, which
    // pass 1 deletes first.
    for (const i of [0, 1]) {
      await ctx.db.insert("paymentAllocations", {
        orgId: b.orgId, paymentId: payments[1 - i], receivableDocumentId: docs[1 - i],
        amountMinor: 1000, currency: "JOD", scale: 3, allocationDate: b.now,
        status: "ACTIVE", createdBy: b.userId, createdAt: b.now,
      });
    }
  };

  test("(x) A1: a surviving allocation's canonicalPayment always resolves", async () => {
    const result = await driveIsolated("A1 Motors", seedAllocationsOnly);
    expect(result.dangling.has(key(A1)), result.trace.join("\n")).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("(xi) A2: a surviving allocation's receivableDocument always resolves", async () => {
    const result = await driveIsolated("A2 Motors", seedAllocationsOnly);
    expect(result.dangling.has(key(A2)), result.trace.join("\n")).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("(xii) S1: a surviving balance snapshot's account always resolves", async () => {
    const result = await driveIsolated("S1 Motors", async (ctx, b) => {
      const periodId = await ctx.db.insert("accountingPeriods", {
        orgId: b.orgId, startDate: b.now, endDate: b.now + 1, fiscalYear: 2026,
        periodNumber: 1, status: "OPEN", createdAt: b.now,
      });
      const accounts = [];
      for (const code of ["1000", "1100"]) {
        accounts.push(
          await ctx.db.insert("chartOfAccounts", {
            orgId: b.orgId, code, name: `Acct ${code}`, type: "ASSET",
            normalBalance: "DEBIT", isControlAccount: false, allowManualPosting: true,
            active: true, createdAt: b.now, updatedAt: b.now,
          })
        );
      }
      // Cross-linked: snapshot #2 (the pass-1 survivor) names account #1.
      for (const i of [0, 1]) {
        await ctx.db.insert("accountBalanceSnapshots", {
          orgId: b.orgId, accountId: accounts[1 - i], currency: "JOD", periodId,
          runningDebitMinor: 0, runningCreditMinor: 0, updatedAt: b.now,
        });
      }
    });
    expect(result.dangling.has(key(S1)), result.trace.join("\n")).toBe(false);
    expect(result.remaining).toBe(0);
  });

  // Every other pair, in the full graph. D1/D2 are covered by (v)/(vi) above.
  test.each(PAIRS.filter((p) => key(p) !== key(D1) && key(p) !== key(D2)).map((p) => [key(p), p] as const))(
    "%s never dangles after a pass",
    async (_name, pair) => {
      const { result } = await getShared();
      expect(result.dangling.has(key(pair)), result.trace.join("\n")).toBe(false);
    }
  );

  test("(vii) repeated passes terminate with remaining 0 and every table empty", async () => {
    const { result, orgPopulatedAfter } = await getShared();
    expect(result.remaining).toBe(0);
    expect(result.passes).toBeLessThan(MAX_PASSES);
    expect(orgPopulatedAfter).toEqual([]);
  });

  // Bystander isolation itself is covered in orgFinancialReset.test.ts; this only
  // asserts the new invariant: the other org's references still resolve.
  test("(viii) another organization's references still resolve", async () => {
    const { otherPopulatedAfter, otherDanglingAfter } = await getShared();
    expect(otherPopulatedAfter.length).toBeGreaterThan(0);
    expect(otherDanglingAfter).toEqual([]);
  });

  // The dry-run contract itself is covered in orgFinancialReset.test.ts; this only
  // asserts that a dry run leaves every protected reference resolving.
  test("(ix) a dry run leaves no reference dangling", async () => {
    const t = setup();
    const orgId = await seedGraph(t, "Dry Refs");
    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: true,
      batchSize: 1,
    });
    expect(await danglingNow(t, orgId)).toEqual([]);
  });
});
