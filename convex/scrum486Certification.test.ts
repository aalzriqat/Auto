/**
 * SCRUM-486: literal, independent certification rows driven through public money doors.
 *
 * These harness rows cover only selected owned CASH and retired-mode paths.
 * They are not the whole route/deposit/lifecycle matrix and are not
 * real Convex platform evidence. The owner-ruling derivation lives in
 * docs/architecture/scrum486-certification-oracle.md. Expected amounts are
 * literals here and import no production accounting calculations.
 */
import { describe, expect, test, vi } from "vitest";
import { seedFinancedDealership } from "../test-utils/financedDealFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { expectRetiredDealMode } from "../test-utils/retiredDealMode";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const OWNER_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests", "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "view:finance", "manage:finance", "view:reports",
];

async function cashQuote(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES,
    ownerPerms: OWNER_PERMS,
    actors: {},
    label: "Certification",
    vinPrefix: "V486",
  });

  // Opening fixture facts, before any deal money moves: owned cost 10,000 JOD.
  await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { purchasePrice: 10_000 }));
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    mode: "CASH",
    vehiclePrice: 12_500,
    downPayment: 0,
    termMonths: 0,
  });
  return { s, quoteId };
}

type CashSeed = Awaited<ReturnType<typeof cashQuote>>["s"];

async function completeCashSale(s: CashSeed, quoteId: Id<"quotes">, suffix: string) {
  return (await s.owner.as.mutation(api.sales.create, {
    orgId: s.orgId,
    idempotencyKey: `scrum486-cash-${suffix}`,
    quoteId,
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    salespersonId: s.owner.userId,
    salePrice: 12_500,
    saleDate: Date.now(),
    status: "COMPLETED",
  })) as Id<"sales">;
}

async function journalRows(s: CashSeed) {
  return await s.t.run(async (ctx) => {
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const entryById = new Map(entries.map((entry) => [entry._id, entry]));
    const lines = await ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    return await Promise.all(lines.map(async (line) => {
      const account = await ctx.db.get(line.accountId);
      return {
        account: account?.code,
        currency: line.currency,
        debit: line.debitMinor,
        credit: line.creditMinor,
        entryStatus: entryById.get(line.journalEntryId)?.status,
      };
    }));
  });
}

async function eventStatuses(s: CashSeed, eventType: string, sourceId: string) {
  return await s.t.run(async (ctx) => (
    await ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
      q.eq("orgId", s.orgId).eq("sourceType", eventType === "SALE_COMPLETED" ? "sales" : "deposits").eq("sourceId", sourceId)
    ).collect()
  ).filter((event) => event.eventType === eventType).map((event) => event.status));
}

function expectBalanced(rows: Awaited<ReturnType<typeof journalRows>>) {
  expect(rows.reduce((total, row) => total + row.debit - row.credit, 0)).toBe(0);
}

type JournalRow = Awaited<ReturnType<typeof journalRows>>[number];

/** Journal line order is not a dealer-visible economic result; the exact multiset is. */
function expectLiteralRows(actual: JournalRow[], expected: JournalRow[]) {
  const key = (row: JournalRow) => [
    row.account ?? "",
    row.currency,
    String(row.debit).padStart(12, "0"),
    String(row.credit).padStart(12, "0"),
    row.entryStatus ?? "",
  ].join("|");
  const order = (a: JournalRow, b: JournalRow) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  expect([...actual].sort(order)).toEqual([...expected].sort(order));
}

/** The ledger consumer counts the original and its reversal, including REVERSED history. */
function netByAccount(rows: JournalRow[]) {
  const net = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.account}|${row.currency}`;
    net.set(key, (net.get(key) ?? 0) + row.debit - row.credit);
  }
  return Object.fromEntries([...net].filter(([, amount]) => amount !== 0).sort());
}

describe("SCRUM-486 literal certification matrix (harness only)", () => {
  test("owned CASH × no deposit: sale recognizes literal receivable, revenue, COGS and inventory", async () => {
    const { s, quoteId } = await cashQuote("s486cashnone");
    const saleId = await completeCashSale(s, quoteId, "no-deposit");

    const saleStatus = await s.t.run(async (ctx) => (await ctx.db.get(saleId))?.status);
    const rows = await journalRows(s);
    expect(saleStatus).toBe("COMPLETED");
    expectLiteralRows(rows, [
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
  });

  test("owned CASH × held/applied deposit: 200,000 liability reduces the invoice receivable, not revenue", async () => {
    const { s, quoteId } = await cashQuote("s486cashapplied");
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: "scrum486-applied-deposit",
    });
    const saleId = await completeCashSale(s, quoteId, "applied-deposit");
    const { deposit, sale } = await s.t.run(async (ctx) => ({
      deposit: await ctx.db.get(depositId),
      sale: await ctx.db.get(saleId),
    }));
    const rows = await journalRows(s);
    expect(deposit?.status).toBe("APPLIED");
    expect(sale?.status).toBe("COMPLETED");
    expectLiteralRows(rows, [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
  });

  test("owned CASH × applied deposit × cancelled sale × refund: only the held customer money survives the reversal", async () => {
    const { s, quoteId } = await cashQuote("s486cancelrefund");
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: "scrum486-cancel-refund-hold",
    });
    const saleId = await completeCashSale(s, quoteId, "cancel-refund");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(await eventStatuses(s, "DEPOSIT_RECEIVED", depositId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": 200_000,
      "1200|JOD": 12_300_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": -12_500_000,
      "5100|JOD": 10_000_000,
    });

    await s.approver.as.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      status: "CANCELLED",
    });
    const cancelled = await s.t.run(async (ctx) => ({
      sale: await ctx.db.get(saleId),
      deposit: await ctx.db.get(depositId),
      applications: await ctx.db.query("depositApplications").withIndex("by_sale", (q) => q.eq("saleId", saleId)).collect(),
    }));
    expect(cancelled.sale?.status).toBe("CANCELLED");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["REVERSED"]);
    expect(await eventStatuses(s, "DEPOSIT_RECEIVED", depositId)).toEqual(["POSTED"]);
    expect(cancelled.deposit).toMatchObject({ status: "HELD", holdActive: true, amountMinor: 200_000 });
    expect(cancelled.applications.map((application) => application.status)).toEqual(["REVERSED"]);
    const cancellationRows = await journalRows(s);
    expect(netByAccount(cancellationRows)).toEqual({ "1100|JOD": 200_000, "2100|JOD": -200_000 });
    expectBalanced(cancellationRows);

    await s.approver.as.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: "scrum486-cancel-refund-release",
    });
    const refunded = await s.t.run((ctx) => ctx.db.get(depositId));
    const finalRows = await journalRows(s);
    expect(refunded?.status).toBe("REFUNDED");
    expect(await eventStatuses(s, "DEPOSIT_REFUNDED", depositId)).toEqual(["POSTED"]);
    expect(netByAccount(finalRows)).toEqual({});
    expectBalanced(finalRows);
  });

  test.each([
    { ending: "REFUNDED" as const, creditAccount: "1100" },
    { ending: "FORFEITED" as const, creditAccount: "4200" },
  ])("owned CASH × held deposit × $ending before sale: only customer money moves", async ({ ending, creditAccount }) => {
    const { s, quoteId } = await cashQuote(`s486${ending.toLowerCase()}`);
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: `scrum486-${ending}-deposit`,
    });
    expectLiteralRows(await journalRows(s), [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
    ]);

    await s.approver.as.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId,
      resolution: ending,
      ...(ending === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
      idempotencyKey: `scrum486-${ending}-release`,
    });
    const deposit = await s.t.run((ctx) => ctx.db.get(depositId));
    const saleCount = await s.t.run(async (ctx) => (await ctx.db.query("sales").collect()).length);
    const rows = await journalRows(s);
    expect(deposit?.status).toBe(ending);
    expect(saleCount).toBe(0);
    expectLiteralRows(rows, [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: creditAccount, currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
  });

  test.each(["LEASE", "INTERNAL_INSTALLMENT"] as const)(
    "retired %s quote route refuses before any row changes",
    async (mode) => {
      const { s } = await cashQuote(`s486retired${mode.toLowerCase()}`);
      const tables = Object.keys(schema.tables);
      const before = await dbSnapshot(s.t, tables);
      await expectRetiredDealMode(s.owner.as.mutation(api.quotes.saveQuote, {
        orgId: s.orgId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        mode,
        vehiclePrice: 12_500,
        downPayment: 0,
        termMonths: 48,
      }));
      expect(await dbSnapshot(s.t, tables)).toEqual(before);
    },
  );
});
