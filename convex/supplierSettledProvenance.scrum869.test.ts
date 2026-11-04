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

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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
