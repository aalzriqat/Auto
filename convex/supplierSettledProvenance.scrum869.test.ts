/**
 * SCRUM-869 settled history: every figure must come from what its source actually records.
 *
 * Two seat findings (PR #764, HIGH):
 *  1. A payable stored as PAID with no `amountPaid` (a row from before the field existed) is read as fully paid by
 *     `settlementView`, the sale-cancellation guard and the payments reconciliation. The history must show it too.
 *  2. `vehicleSupplierReceivables.amountReceived` also holds the customer deposit applied to the settlement of a
 *     DIRECT_TO_SUPPLIER sale (`openSupplierReceivable`'s `alreadyReceivedAmount`). It is not cash from the supplier.
 *     The history derives supplier receipts from the receipts' own postings (SUPPLIER_RECEIVABLE_COLLECTED journal
 *     entries sourced by the claim), never from that mixed field.
 *
 * Hand computation (JOD, 3 decimals): margin claim 3_000 JOD = 3_000_000 minor; customer deposit applied 1_000 JOD;
 * supplier receipt 500 JOD = 500_000 minor. Expected values below come from those fixtures, not from the code.
 * Evidence boundary: convex-test only, seeded rows plus the real `openSupplierReceivable` and `recordReceipt` writers.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { openSupplierReceivable } from "./supplierReceivables";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const PERMS = ["view:finance", "view:cost_price", "manage:finance"];
const MARGIN = 3_000;
const DEPOSIT = 1_000;
const RECEIPT = 500;

async function seed(tag: string, options: { transactionLimits?: boolean } = {}) {
  const t = convexTestWithComponents(schema, MODULE_GLOB, options);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `SP ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() }),
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "SP User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Finance", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] }),
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const supplierId = await addSupplier(t, orgId, "Amman Importer Co", userId);
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINSP${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White", fuelType: "Gas",
      transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: 9_500, sourcedSupplierId: supplierId,
    }),
  );
  return { t, orgId, userId, asUser, customerId, vehicleId, supplierId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

function addSupplier(t: ReturnType<typeof convexTestWithComponents>, orgId: Id<"organizations">, displayName: string, userId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db.insert("suppliers", {
      orgId, displayName, displayNameKey: displayName.toLowerCase(), status: "ACTIVE", version: 1, origin: "MANUAL",
      createdBy: userId, createdAt: Date.now(), updatedBy: userId, updatedAt: Date.now(),
    }),
  );
}

/**
 * A DIRECT_TO_SUPPLIER claim opened by the real writer. `depositApplied` is the customer deposit applied to the
 * supplier settlement (`alreadyReceivedAmount`); it is the dealership's own margin held in customer cash.
 */
async function openClaim(s: Seed, depositApplied: number, currency = "JOD", amountDue = MARGIN): Promise<Id<"vehicleSupplierReceivables">> {
  return await s.t.run(async (ctx) => {
    const saleId = await ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 12_500, saleDate: Date.now(), status: "COMPLETED",
    } as never);
    const id = await openSupplierReceivable(ctx as never, {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co",
      amountDue, currency, alreadyReceivedAmount: depositApplied, actorId: s.userId,
    });
    return id!;
  });
}

const receive = (s: Seed, receivableId: Id<"vehicleSupplierReceivables">, amount: number, key: string) =>
  s.asUser.mutation(api.supplierReceivables.recordReceipt, {
    orgId: s.orgId, receivableId, amount, receiptMethod: "CASH", idempotencyKey: key,
  });

const settled = (s: Seed, supplierId: Id<"suppliers"> = s.supplierId) =>
  s.asUser.query(api.supplierStatement.settled, { orgId: s.orgId, supplierId });

const addPayable = (s: Seed, fields: Record<string, unknown> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co", amountDue: 9_500,
      currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(), ...fields,
    } as never),
  );

describe("SCRUM-869 settled history: receipts from the supplier come from receipt postings, not amountReceived", () => {
  test("deposit-only: a customer deposit applied to the settlement is not shown as received from the supplier", async () => {
    const s = await seed("dep");
    const claimId = await openClaim(s, DEPOSIT);
    // The claim really does carry the deposit in amountReceived: that is what makes the field unfit as a cash source.
    expect(await s.t.run((ctx) => ctx.db.get(claimId))).toMatchObject({ amountReceived: DEPOSIT, status: "PARTIALLY_PAID" });
    const r = await settled(s);
    expect(r.receivable.rows).toEqual([]);
    expect(r.receivable.totals).toEqual([]);
    expect(r.receivable.complete).toBe(true);
  });

  test("deposit plus receipt: only the supplier's own 500 JOD is shown, not 1,500", async () => {
    const s = await seed("depr");
    const claimId = await openClaim(s, DEPOSIT);
    await receive(s, claimId, RECEIPT, "depr-1");
    expect(await s.t.run((ctx) => ctx.db.get(claimId))).toMatchObject({ amountReceived: DEPOSIT + RECEIPT, receiptSeq: 1 });
    const r = await settled(s);
    expect(r.receivable.rows).toHaveLength(1);
    expect(r.receivable.rows[0]).toMatchObject({ kind: "RECEIVABLE", id: claimId, dueMinor: 3_000_000, settledMinor: 500_000 });
    expect(r.receivable.totals).toEqual([{ currency: "JOD", settledMinor: 500_000 }]);
    expect(r.receivable.complete).toBe(true);
  });

  test("receipt-only (control): a supplier receipt with no deposit is shown in full", async () => {
    const s = await seed("rcpt");
    const claimId = await openClaim(s, 0);
    await receive(s, claimId, RECEIPT, "rcpt-1");
    await receive(s, claimId, 250, "rcpt-2");
    const r = await settled(s);
    expect(r.receivable.rows.map((x: { settledMinor: number }) => x.settledMinor)).toEqual([750_000]);
    expect(r.receivable.totals).toEqual([{ currency: "JOD", settledMinor: 750_000 }]);
  });

  test("a claim settled in full by the deposit alone is not a supplier receipt", async () => {
    const s = await seed("depfull");
    const claimId = await openClaim(s, MARGIN);
    expect(await s.t.run((ctx) => ctx.db.get(claimId))).toMatchObject({ status: "PAID", amountReceived: MARGIN });
    const r = await settled(s);
    expect(r.receivable.rows).toEqual([]);
  });

  test("a receipt that was recorded but never posted is incomplete, not zero and not the mixed figure", async () => {
    const s = await seed("unposted");
    const claimId = await openClaim(s, DEPOSIT);
    // A recorded receipt (receiptSeq 1) whose posting is not in the ledger yet: the cash cannot be established.
    await s.t.run((ctx) => ctx.db.patch(claimId, { amountReceived: DEPOSIT + RECEIPT, receiptSeq: 1 }));
    const r = await settled(s);
    expect(r.receivable.rows).toEqual([]);
    expect(r.receivable.unverifiedCount).toBe(1);
    expect(r.receivable.complete).toBe(false);
    expect(r.receivable.totals).toEqual([]);
  });

  test("a receipt that was posted and then reversed nets to zero", async () => {
    const s = await seed("rev");
    const claimId = await openClaim(s, DEPOSIT);
    await receive(s, claimId, RECEIPT, "rev-1");
    // The shape accounting/reversals.ts leaves behind: original patched REVERSED, plus an inverted POSTED entry, same source.
    await s.t.run(async (ctx) => {
      const original = (
        await ctx.db
          .query("journalEntries")
          .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId).eq("sourceType", "vehicleSupplierReceivables").eq("sourceId", claimId))
          .take(5)
      )[0]!;
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", original._id)).take(10);
      const { _id, _creationTime, ...rest } = original;
      void _id; void _creationTime;
      const reversalId = await ctx.db.insert("journalEntries", {
        ...rest, journalNumber: "JE-REVTEST", category: "REVERSAL", status: "POSTED", reversalOfJournalEntryId: original._id,
      });
      for (const l of lines) {
        const { _id: lid, _creationTime: lct, ...lr } = l;
        void lid; void lct;
        await ctx.db.insert("journalLines", { ...lr, journalEntryId: reversalId, debitMinor: l.creditMinor, creditMinor: l.debitMinor });
      }
      await ctx.db.patch(original._id, { status: "REVERSED", reversedByJournalEntryId: reversalId });
    });
    const r = await settled(s);
    expect(r.receivable.rows).toEqual([]);
    expect(r.receivable.unverifiedCount).toBe(0);
  });

  test("currency separation: a deposit-only claim in one currency never reaches another currency's receipts", async () => {
    const s = await seed("ccy");
    const usdDeposit = await openClaim(s, 100, "USD", 400);
    const jodClaim = await openClaim(s, 0);
    await receive(s, jodClaim, RECEIPT, "ccy-1");
    expect(await s.t.run((ctx) => ctx.db.get(usdDeposit))).toMatchObject({ currency: "USD", amountReceived: 100 });
    // Legacy-paid payables in two currencies stay separate totals too.
    await addPayable(s, { status: "PAID" });
    await addPayable(s, { status: "PAID", amountDue: 100, currency: "USD" });
    const r = await settled(s);
    expect(r.receivable.totals).toEqual([{ currency: "JOD", settledMinor: 500_000 }]);
    const byCurrency = Object.fromEntries(
      r.payable.totals.map((t: { currency: string; settledMinor: number }) => [t.currency, t.settledMinor]),
    );
    expect(byCurrency).toEqual({ JOD: 9_500_000, USD: 10_000 });
  });
});

describe("SCRUM-869 settled history: a legacy PAID payable with no amountPaid is read as fully paid, like every other reader", () => {
  test("shows the 9,500 JOD, labelled as inferred from the paid status, and agrees with the payments reconciliation", async () => {
    const s = await seed("legacy");
    const payableId = await addPayable(s, { status: "PAID", paidAt: Date.UTC(2025, 2, 1) });
    const r = await settled(s);
    expect(r.payable.rows).toHaveLength(1);
    expect(r.payable.rows[0]).toMatchObject({
      kind: "PAYABLE", id: payableId, status: "PAID", dueMinor: 9_500_000, settledMinor: 9_500_000, basis: "INFERRED_FROM_PAID_STATUS",
    });
    expect(r.payable.totals).toEqual([{ currency: "JOD", settledMinor: 9_500_000 }]);
    expect(r.payable.complete).toBe(true);
    // Like with like: the reconciliation reads the same row through the same view, so the two reports agree on the paid figure.
    const recon = await s.asUser.query(api.supplierStatement.paymentsReconciliation, { orgId: s.orgId, supplierId: s.supplierId });
    expect(recon.currencies.map((c: { subledgerPaidMinor: number }) => c.subledgerPaidMinor)).toEqual([9_500_000]);
  });

  test("a payable with recorded payments is labelled as recorded, and a PAID row with a partial amountPaid is not inflated", async () => {
    const s = await seed("recorded");
    await addPayable(s, { status: "PARTIALLY_PAID", amountPaid: 4_000 });
    await addPayable(s, { status: "PAID", amountPaid: 9_500 });
    const r = await settled(s);
    expect(r.payable.rows.map((x: { basis: string }) => x.basis)).toEqual(["RECORDED", "RECORDED"]);
    expect(r.payable.totals).toEqual([{ currency: "JOD", settledMinor: 13_500_000 }]);
  });
});

describe("SCRUM-869 settled history: the receivable section is merged newest-first (ADR)", () => {
  test("a receivable, a cost recovery and a later receivable come back in creation order, newest first", async () => {
    const s = await seed("order");
    const older = await openClaim(s, 0);
    await receive(s, older, RECEIPT, "order-1");
    const recoveryId = await s.t.run(async (ctx) => {
      const expenseId = await ctx.db.insert("expenses", {
        orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport", amount: 200, date: Date.now(), category: "TRANSPORT", status: "PAID",
      } as never);
      return await ctx.db.insert("supplierCostRecoveries", {
        orgId: s.orgId, vehicleId: s.vehicleId, expenseId, supplierId: s.supplierId, sourceEventKey: "ev_order",
        sourcedFromName: "Amman Importer Co", amountDueMinor: 200_000, amountRecoveredMinor: 50_000, currency: "JOD",
        receiptSeq: 1, status: "PARTIALLY_RECOVERED", createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      } as never);
    });
    const newer = await openClaim(s, 0);
    await receive(s, newer, 250, "order-2");
    const r = await settled(s);
    expect(r.receivable.rows.map((x: { id: string }) => x.id)).toEqual([newer, recoveryId, older]);
  });
});

/**
 * Reverses the `index`-th receipt posting of a claim the way accounting/reversals.ts leaves it: the original is patched
 * REVERSED and an inverted POSTED REVERSAL entry with the same source is added. The claim row itself is not touched, which
 * is what the real reversal does too.
 */
async function reverseReceiptPosting(s: Seed, claimId: Id<"vehicleSupplierReceivables">, index: number) {
  await s.t.run(async (ctx) => {
    const entries = await ctx.db
      .query("journalEntries")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId).eq("sourceType", "vehicleSupplierReceivables").eq("sourceId", claimId))
      .take(10);
    const original = entries[index]!;
    const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", original._id)).take(10);
    const { _id, _creationTime, ...rest } = original;
    void _id; void _creationTime;
    const reversalId = await ctx.db.insert("journalEntries", {
      ...rest, journalNumber: `JE-REV-${index}`, category: "REVERSAL", status: "POSTED", reversalOfJournalEntryId: original._id,
    });
    for (const l of lines) {
      const { _id: lid, _creationTime: lct, ...lr } = l;
      void lid; void lct;
      await ctx.db.insert("journalLines", { ...lr, journalEntryId: reversalId, debitMinor: l.creditMinor, creditMinor: l.debitMinor });
    }
    await ctx.db.patch(original._id, { status: "REVERSED", reversedByJournalEntryId: reversalId });
  });
}

/**
 * Finding 1 (MEDIUM, money label): "settled in full" is a fact about the obligation, "cash received from the supplier" is a
 * different fact. The statement compared the second with the first, so a 3,000 JOD claim closed by a 1,000 JOD customer deposit
 * plus a 2,000 JOD supplier receipt (status PAID, cash 2,000) was labelled "Partly settled". The server now returns the
 * completion separately (`settlement`); the cash figure stays the supplier's own money. Hand-computed from the fixtures:
 * 3,000 JOD = 3_000_000 minor; deposit 1_000_000; receipts as stated per test.
 */
describe("SCRUM-869 settled history: completion is returned separately from supplier cash (Finding 1)", () => {
  test("full deposit-assisted settlement: 1,000 deposit + 2,000 supplier receipt closes the 3,000 claim (COMPLETE), and the cash stays 2,000", async () => {
    const s = await seed("f1full");
    const claimId = await openClaim(s, DEPOSIT);
    await receive(s, claimId, 2_000, "f1full-1");
    expect(await s.t.run((ctx) => ctx.db.get(claimId))).toMatchObject({ status: "PAID", amountReceived: MARGIN });
    const r = await settled(s);
    expect(r.receivable.rows).toHaveLength(1);
    expect(r.receivable.rows[0]).toMatchObject({
      id: claimId, status: "PAID", dueMinor: 3_000_000, settledMinor: 2_000_000, settlement: "COMPLETE",
    });
    // The deposit is still not a supplier receipt: the total is the supplier's 2,000, never 3,000.
    expect(r.receivable.totals).toEqual([{ currency: "JOD", settledMinor: 2_000_000 }]);
  });

  test("partial deposit-assisted settlement: 1,000 deposit + 500 receipt leaves the claim PARTIAL, with cash 500", async () => {
    const s = await seed("f1part");
    const claimId = await openClaim(s, DEPOSIT);
    await receive(s, claimId, RECEIPT, "f1part-1");
    const r = await settled(s);
    expect(r.receivable.rows[0]).toMatchObject({ id: claimId, status: "PARTIALLY_PAID", settledMinor: 500_000, settlement: "PARTIAL" });
  });

  test("receipt-only controls: 750 of 3,000 is PARTIAL; the same claim paid to 3,000 in two receipts is COMPLETE with cash 3,000", async () => {
    const s = await seed("f1ctl");
    const partial = await openClaim(s, 0);
    await receive(s, partial, 750, "f1ctl-1");
    const full = await openClaim(s, 0);
    await receive(s, full, 1_800, "f1ctl-2");
    await receive(s, full, 1_200, "f1ctl-3");
    const r = await settled(s);
    const byId = Object.fromEntries(r.receivable.rows.map((x: { id: string }) => [x.id, x]));
    expect(byId[partial]).toMatchObject({ settledMinor: 750_000, settlement: "PARTIAL" });
    expect(byId[full]).toMatchObject({ settledMinor: 3_000_000, settlement: "COMPLETE" });
  });

  test("a reversed receipt: fully reversed cash leaves no row; a partly reversed claim is no longer shown as COMPLETE", async () => {
    const s = await seed("f1rev");
    // Fully reversed: deposit 1,000 + one 2,000 receipt that is then reversed => no supplier cash, no row.
    const gone = await openClaim(s, DEPOSIT);
    await receive(s, gone, 2_000, "f1rev-1");
    await reverseReceiptPosting(s, gone, 0);
    // Partly reversed: deposit 1,000 + 1,500 + 500, the 500 reversed => cash 1,500. The claim row still says PAID (the real
    // reversal does not touch it), but its cash is short, so it must not be labelled settled in full.
    const partly = await openClaim(s, DEPOSIT);
    await receive(s, partly, 1_500, "f1rev-2");
    await receive(s, partly, 500, "f1rev-3");
    expect(await s.t.run((ctx) => ctx.db.get(partly))).toMatchObject({ status: "PAID" });
    await reverseReceiptPosting(s, partly, 1);
    const r = await settled(s);
    expect(r.receivable.rows.map((x: { id: string }) => x.id)).toEqual([partly]);
    expect(r.receivable.rows[0]).toMatchObject({ settledMinor: 1_500_000, settlement: "PARTIAL" });
    expect(r.receivable.unverifiedCount).toBe(0);
  });

  test("payables and cost recoveries: completion follows their own paid / recovered amounts", async () => {
    const s = await seed("f1other");
    const fullPayable = await addPayable(s, { status: "PAID", amountPaid: 9_500 });
    const partPayable = await addPayable(s, { status: "PARTIALLY_PAID", amountPaid: 4_000 });
    const mkRecovery = (key: string, recovered: number, status: string) =>
      s.t.run(async (ctx) => {
        const expenseId = await ctx.db.insert("expenses", {
          orgId: s.orgId, vehicleId: s.vehicleId, title: key, amount: 200, date: Date.now(), category: "TRANSPORT", status: "PAID",
        } as never);
        return await ctx.db.insert("supplierCostRecoveries", {
          orgId: s.orgId, vehicleId: s.vehicleId, expenseId, supplierId: s.supplierId, sourceEventKey: key,
          sourcedFromName: "Amman Importer Co", amountDueMinor: 200_000, amountRecoveredMinor: recovered, currency: "JOD",
          receiptSeq: 1, status, createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
        } as never);
      });
    const fullRecovery = await mkRecovery("ev_full", 200_000, "RECOVERED");
    const partRecovery = await mkRecovery("ev_part", 50_000, "PARTIALLY_RECOVERED");
    const r = await settled(s);
    const settlementOf = (rows: { id: string; settlement: string }[]) => Object.fromEntries(rows.map((x) => [x.id, x.settlement]));
    expect(settlementOf(r.payable.rows)).toEqual({ [fullPayable]: "COMPLETE", [partPayable]: "PARTIAL" });
    expect(settlementOf(r.receivable.rows)).toEqual({ [fullRecovery]: "COMPLETE", [partRecovery]: "PARTIAL" });
  });
});

/**
 * L1 (Seat 1, LOW): after the first claim whose receipts cannot be read back, `entriesLeft` was set to 0, so every older claim
 * with any posting at all was counted unverified too. Only the claim that really cannot be established counts.
 */
describe("SCRUM-869 settled history: an unverifiable claim does not make older, fully posted claims unverified (L1)", () => {
  test("newer claim with receiptSeq 2 and one posting is the only unverified claim; the older, fully posted claim is still shown", async () => {
    const s = await seed("l1");
    const older = await openClaim(s, 0);
    await receive(s, older, RECEIPT, "l1-1");
    const newer = await openClaim(s, 0);
    await receive(s, newer, 250, "l1-2");
    // Two receipts recorded, only one posted: the second is missing from the ledger.
    await s.t.run((ctx) => ctx.db.patch(newer, { amountReceived: 750, receiptSeq: 2 }));
    const r = await settled(s);
    expect(r.receivable.unverifiedCount).toBe(1);
    expect(r.receivable.rows.map((x: { id: string }) => x.id)).toEqual([older]);
    expect(r.receivable.complete).toBe(false);
    expect(r.receivable.totals).toEqual([]);
  });
});

/**
 * Finding 2 (MEDIUM, Convex limit): a row cap bounds documents, not bytes. A single transaction may read 16 MiB
 * (https://docs.convex.dev/production/state/limits) and `receiptNotes` is an unbounded string up to the 1 MiB document limit,
 * so 20 claims of ~0.9 MB each read about 18 MB while staying far under the 100-row cap, and the query threw. These tests run
 * with convex-test's `transactionLimits: true`, which enforces the 16 MiB ceiling in the test database. Evidence boundary: that is
 * convex-test's emulation, not the Convex backend; the budget arithmetic itself is pinned in utils/transactionReadHeadroom.test.ts.
 */
describe("SCRUM-869 settled history: the read stays inside the transaction's byte limit (Finding 2)", () => {
  const HEAVY_CHARS = 900_000;
  const CLAIMS = 20;

  async function claimsWithNotes(s: Seed, count: number, chars: number, prefix: string) {
    const ids: Id<"vehicleSupplierReceivables">[] = [];
    for (let i = 0; i < count; i += 1) {
      const claimId = await openClaim(s, 0);
      await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId, receivableId: claimId, amount: 100, receiptMethod: "CASH", receiptNotes: "n".repeat(chars), idempotencyKey: `${prefix}-${i}`,
      });
      ids.push(claimId);
    }
    return ids;
  }

  test("the fixture is a real counterexample: an unbounded read of these 20 claims exceeds the transaction limit", async () => {
    const s = await seed("f2fixture", { transactionLimits: true });
    await claimsWithNotes(s, CLAIMS, HEAVY_CHARS, "f2fixture");
    await expect(
      s.t.run((ctx) =>
        ctx.db
          .query("vehicleSupplierReceivables")
          .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", s.orgId).eq("supplierId", s.supplierId).eq("status", "PARTIALLY_PAID"))
          .take(101),
      ),
    ).rejects.toThrow(/too much data|exceed|limit/i);
  });

  test("CONTROL: 20 small-note claims are read in full with the limits enforced: every row, the total, complete", async () => {
    const s = await seed("f2small", { transactionLimits: true });
    await claimsWithNotes(s, CLAIMS, 100, "f2small");
    const r = await settled(s);
    expect(r.receivable.complete).toBe(true);
    expect(r.receivable.unverifiedCount).toBe(0);
    expect(r.receivable.rows).toHaveLength(CLAIMS);
    expect(r.receivable.totals).toEqual([{ currency: "JOD", settledMinor: CLAIMS * 100_000 }]);
  });

  test("20 claims of ~0.9 MB each: the query answers instead of throwing, lists only what it read, and withholds the total", async () => {
    const s = await seed("f2heavy", { transactionLimits: true });
    await claimsWithNotes(s, CLAIMS, HEAVY_CHARS, "f2heavy");
    const r = await settled(s);
    expect(r.receivable.complete).toBe(false);
    expect(r.receivable.totals).toEqual([]);
    expect(r.receivable.rows.length).toBeLessThan(CLAIMS);
    // Not a row-count or ledger problem, so it is reported as an incomplete list, not as unconfirmed receipts.
    expect(r.receivable.unverifiedCount).toBe(0);
  });

  test("mixed families: small payables stay complete with their total while the heavy claims family is withheld", async () => {
    const s = await seed("f2mixed", { transactionLimits: true });
    await addPayable(s, { status: "PAID", amountPaid: 9_500 });
    await addPayable(s, { status: "PARTIALLY_PAID", amountPaid: 4_000 });
    await claimsWithNotes(s, CLAIMS, HEAVY_CHARS, "f2mixed");
    const r = await settled(s);
    expect(r.payable.complete).toBe(true);
    expect(r.payable.totals).toEqual([{ currency: "JOD", settledMinor: 13_500_000 }]);
    expect(r.receivable.complete).toBe(false);
    expect(r.receivable.totals).toEqual([]);
  });

  test("the budget is shared across families: heavy payables use it up, and the receivable side is withheld rather than thrown", async () => {
    const s = await seed("f2shared", { transactionLimits: true });
    for (let i = 0; i < CLAIMS; i += 1) {
      await addPayable(s, { status: "PAID", amountPaid: 9_500, paymentNotes: "n".repeat(HEAVY_CHARS) });
    }
    const light = await openClaim(s, 0);
    await receive(s, light, RECEIPT, "f2shared-1");
    const r = await settled(s);
    expect(r.payable.complete).toBe(false);
    expect(r.payable.totals).toEqual([]);
    expect(r.receivable.complete).toBe(false);
    expect(r.receivable.totals).toEqual([]);
  });
});
