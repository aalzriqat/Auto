import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RESET_ORG_INDEX_FOR_TEST, RESET_TABLES_FOR_TEST } from "./orgFinancialReset";

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

/** [child table, field (an id or an array of ids), target table]. */
const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
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

const key = (p: readonly [string, string, string]) => `${p[0]}.${p[1]}->${p[2]}`;

interface LooseDb {
  query(table: string): {
    withIndex(
      index: string,
      range: (q: { eq(field: string, value: unknown): unknown }) => unknown
    ): { collect(): Promise<Array<Record<string, unknown>>> };
  };
  get(id: unknown): Promise<unknown>;
}

/** Surviving rows of `table` for the org, read through the reset's own index. */
async function rowsOf(db: LooseDb, table: string, orgId: Id<"organizations">) {
  return await db
    .query(table)
    .withIndex(RESET_ORG_INDEX_FOR_TEST[table], (q) => q.eq("orgId", orgId))
    .collect();
}

/** Every PAIRS reference held by a surviving row that no longer resolves. */
async function danglingNow(t: T, orgId: Id<"organizations">): Promise<string[]> {
  return await t.run(async (ctx) => {
    const db = ctx.db as unknown as LooseDb;
    const out: string[] = [];
    for (const pair of PAIRS) {
      for (const row of await rowsOf(db, pair[0], orgId)) {
        const raw = row[pair[1]];
        const ids = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
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

/**
 * Seeds an org with TWO of everything on each protected edge, so that a
 * one-row-per-table pass always leaves a second row behind.
 */
async function seedGraph(t: T, name: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name, createdAt: Date.now() })
  );
  const now = Date.now();

  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: `req_refs_${name}`,
      email: `${name.replace(/\s/g, "")}@x.com`,
    });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `VIN${name}`, make: "Kia", model: "Rio", year: 2024, mileage: 10,
      color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15000,
      status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", {
      orgId, firstName: "Refs", lastName: "Customer",
    });
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
      canonicalPaymentId: await ctx.db.insert("canonicalPayments", {
        orgId, direction: "IN", method: "CASH", amountMinor: 1000, currency: "JOD",
        scale: 3, status: "SETTLED", idempotencyKey: `cp-${i}`, createdBy: userId,
        createdAt: now,
      }),
      receivableDocumentId: await ctx.db.insert("receivableDocuments", {
        orgId, documentType: "INVOICE", documentNumber: `INV-${i}`, payerType: "CUSTOMER",
        customerId, sourceType: "TEST", sourceId: `rd${i}`, originalAmountMinor: 1000,
        currency: "JOD", scale: 3, issueDate: now, dueDate: now, status: "OPEN",
        createdAt: now, createdBy: userId,
      }),
    });
    const base = [await parents(0), await parents(1)];
    const deposits = [
      await ctx.db.insert("deposits", {
        orgId, vehicleId, customerId, amount: 1000, status: "HELD", holdActive: false,
        canonicalPaymentId: base[1].canonicalPaymentId, createdBy: userId, createdAt: now,
      }),
      await ctx.db.insert("deposits", {
        orgId, vehicleId, customerId, amount: 1000, status: "HELD", holdActive: false,
        canonicalPaymentId: base[0].canonicalPaymentId, createdBy: userId, createdAt: now,
      }),
    ];
    const receivables = [];
    for (const i of [0, 1]) {
      receivables.push(
        await ctx.db.insert("receivables", {
          orgId, customerId, sourceType: "OTHER", title: `R${i}`, originalAmount: 1,
          outstandingAmount: 1, dueDate: now, status: "OPEN",
          canonicalReceivableDocumentId: base[1 - i].receivableDocumentId,
          createdBy: userId, createdAt: now, updatedAt: now,
        })
      );
    }
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
  });
  return orgId;
}

const MAX_PASSES = 200;

/** Drives destructive batchSize-1 passes, recording what dangled after each. */
async function drive(t: T, orgId: Id<"organizations">) {
  const dangling = new Set<string>();
  const trace: string[] = [];
  let passes = 0;
  let remaining = Infinity;
  while (remaining > 0 && passes < MAX_PASSES) {
    const res = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
      batchSize: 1,
    });
    remaining = res.remaining;
    passes += 1;
    for (const k of await danglingNow(t, orgId)) {
      dangling.add(k);
      trace.push(`pass ${passes}: ${k}`);
    }
  }
  return { dangling, trace, passes, remaining };
}

let shared: ReturnType<typeof runShared> | undefined;
async function runShared() {
  const t = setup();
  const orgId = await seedGraph(t, "Refs Motors");
  // A bystander org with the same shape, which must be untouched throughout.
  const other = await seedGraph(t, "Bystander Refs");
  const otherBefore = await populatedTables(t, other);
  const otherDanglingBefore = await danglingNow(t, other);
  const result = await drive(t, orgId);
  return {
    t, orgId, other, otherBefore, otherDanglingBefore, result,
    otherAfter: await populatedTables(t, other),
    otherDanglingAfter: await danglingNow(t, other),
    orgPopulatedAfter: await populatedTables(t, orgId),
  };
}
const getShared = () => (shared ??= runShared());

async function expectNoDangling(pairs: ReadonlyArray<readonly [string, string, string]>) {
  const { result } = await getShared();
  const hit = pairs.map(key).filter((k) => result.dangling.has(k));
  expect(hit, `dangled after a pass:\n${result.trace.join("\n")}`).toEqual([]);
}

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

  test("(i) journalLines never outlive their journalEntries", async () => {
    await expectNoDangling([["journalLines", "journalEntryId", "journalEntries"]]);
  });

  test("(ii) paymentVouchers never outlive their deposits", async () => {
    await expectNoDangling([["paymentVouchers", "depositId", "deposits"]]);
  });

  test("(iii) journalLines and accountBalanceSnapshots never outlive their chartOfAccounts", async () => {
    await expectNoDangling([
      ["journalLines", "accountId", "chartOfAccounts"],
      ["accountBalanceSnapshots", "accountId", "chartOfAccounts"],
    ]);
  });

  test("(iv) financeDealCustodyEntries never outlive their financeDealCustody", async () => {
    await expectNoDangling([["financeDealCustodyEntries", "custodyId", "financeDealCustody"]]);
  });

  // (v) and (vi) run on ISOLATED fixtures. In the full graph a neighbouring edge
  // (paymentAllocations / paymentVouchers still populated) defers the same
  // target and would mask a missing `deposits` / `receivables` edge.
  test("(v) D1: a surviving deposit's canonicalPayment always resolves", async () => {
    const t = setup();
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "D1 Motors", createdAt: Date.now() })
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { clerkId: "d1_u", email: "d1@x.com" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VIND1", make: "Kia", model: "Rio", year: 2024, mileage: 10,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15000,
        status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", { orgId, firstName: "D", lastName: "1" });
      const payments = [];
      for (const i of [0, 1]) {
        payments.push(
          await ctx.db.insert("canonicalPayments", {
            orgId, direction: "IN", method: "CASH", amountMinor: 1000, currency: "JOD",
            scale: 3, status: "SETTLED", idempotencyKey: `d1-${i}`, createdBy: userId,
            createdAt: now,
          })
        );
      }
      // Cross-linked: deposit #2 (the pass-1 survivor) names payment #1.
      for (const i of [0, 1]) {
        await ctx.db.insert("deposits", {
          orgId, vehicleId, customerId, amount: 1000, status: "HELD", holdActive: false,
          canonicalPaymentId: payments[1 - i], createdBy: userId, createdAt: now,
        });
      }
    });
    const result = await drive(t, orgId);
    expect(result.trace.filter((l) => l.includes("deposits.canonicalPaymentId"))).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  test("(vi) D2: a surviving receivable's receivableDocument always resolves", async () => {
    const t = setup();
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "D2 Motors", createdAt: Date.now() })
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { clerkId: "d2_u", email: "d2@x.com" });
      const customerId = await ctx.db.insert("customers", { orgId, firstName: "D", lastName: "2" });
      const docs = [];
      for (const i of [0, 1]) {
        docs.push(
          await ctx.db.insert("receivableDocuments", {
            orgId, documentType: "INVOICE", documentNumber: `D2-${i}`, payerType: "CUSTOMER",
            customerId, sourceType: "TEST", sourceId: `d2${i}`, originalAmountMinor: 1000,
            currency: "JOD", scale: 3, issueDate: now, dueDate: now, status: "OPEN",
            createdAt: now, createdBy: userId,
          })
        );
      }
      for (const i of [0, 1]) {
        await ctx.db.insert("receivables", {
          orgId, customerId, sourceType: "OTHER", title: `R${i}`, originalAmount: 1,
          outstandingAmount: 1, dueDate: now, status: "OPEN",
          canonicalReceivableDocumentId: docs[1 - i], createdBy: userId, createdAt: now,
          updatedAt: now,
        });
      }
    });
    const result = await drive(t, orgId);
    expect(
      result.trace.filter((l) => l.includes("receivables.canonicalReceivableDocumentId"))
    ).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  test("(Class A) paymentAllocations and collectionApprovalRequests never dangle", async () => {
    await expectNoDangling([
      ["paymentAllocations", "paymentId", "canonicalPayments"],
      ["paymentAllocations", "receivableDocumentId", "receivableDocuments"],
      ["collectionApprovalRequests", "receivableId", "receivables"],
    ]);
  });

  test("(addition 3) collectionPayments never point at a deleted paymentAllocation", async () => {
    await expectNoDangling([["collectionPayments", "paymentAllocationId", "paymentAllocations"]]);
  });

  test("(vii) repeated passes terminate with remaining 0 and every table empty", async () => {
    const { result, orgPopulatedAfter } = await getShared();
    expect(result.remaining).toBe(0);
    expect(result.passes).toBeLessThan(MAX_PASSES);
    expect(orgPopulatedAfter).toEqual([]);
  });

  test("(viii) another organization's rows are untouched", async () => {
    const { otherBefore, otherAfter, otherDanglingBefore, otherDanglingAfter } = await getShared();
    expect(otherBefore.length).toBeGreaterThan(0);
    expect(otherAfter).toEqual(otherBefore);
    expect(otherDanglingBefore).toEqual([]);
    expect(otherDanglingAfter).toEqual([]);
  });

  test("(ix) a dry run reports remaining > 0 and deletes nothing", async () => {
    const t = setup();
    const orgId = await seedGraph(t, "Dry Refs");
    const before = await populatedTables(t, orgId);

    const res = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: true,
      batchSize: 1,
    });

    expect(res.dryRun).toBe(true);
    expect(res.remaining).toBeGreaterThan(0);
    expect(await populatedTables(t, orgId)).toEqual(before);
    expect(await danglingNow(t, orgId)).toEqual([]);
  });
});
