import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * SCRUM-56 — APPLIED MOVEMENT AUTHORITY. Design fixtures, not a fix.
 *
 * PR #241 is frozen at c2e570261. Two HIGH findings were confirmed there, and
 * they are NOT two bugs: both are one movement described by two numbers that
 * nothing forces to agree.
 *
 *   Finding I  the payment-intent path allocates against the sale invoice but
 *              records the legacy mirror against the ROW's private balance
 *   Finding II `returnClearedCheque` reopens the cheque's ORIGINAL amount, not
 *              the part of it still applied after a refund
 *
 * THE AUTHORITY THESE FIXTURES SPECIFY — one result per collection movement:
 *
 *   canonicalPaymentId          money received (canonicalPayments is authority)
 *   targetReceivableDocumentId  the canonical debt it settles
 *   sourceReceivableId          the legacy row it came from, where applicable
 *   requestedMinor              what the movement asked to apply
 *   appliedMinor                what was actually allocated
 *   unappliedMinor              requested - applied; stays on the payment
 *   activeAppliedMinor          still applied after reversals/refunds
 *   activeAllocationIds         the allocations that make that up
 *
 * `paymentAllocations` stays the authority for money currently applied. The
 * legacy `collectionPayments`/`receivables` mirror CONSUMES `appliedMinor` and
 * must never recompute an amount from the row's own stored balance.
 *
 * Every assertion below is written against that contract and measured from
 * observable records only, so these run today and fail where the contract does
 * not hold yet.
 *
 * PRODUCTION PREVALENCE, MEASURED BY LANE 3 ON 2026-08-17: zero legacy
 * receivable rows -- `npx convex data receivables --prod` reported "There are no
 * documents in this table". That is a MEASUREMENT WITH A SHELF LIFE, not a
 * standing fact. It justifies "no backfill" for this round only, and must be
 * re-run before it is ever cited again -- especially to justify a deploy.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales", "edit:sales", "view:sales", "edit:vehicles", "view:vehicles",
  "approve:requests", "manage:finance", "view:finance",
  "register:vehicle_handover", "register:expected_payment",
];

const SALE_PRICE = 22000;
const MINOR = 1000; // JOD, scale 3

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Movement Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "mv_u", email: "u@t.com", name: "U" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "mv_a", email: "a@t.com", name: "A" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "1HGCM82633A777777", make: "Mazda", model: "CX-5", year: 2023,
      color: "Red", fuelType: "Gasoline", transmission: "Automatic", mileage: 500,
      sellingPrice: SALE_PRICE, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Nora", lastName: "Khaled" })
  );
  return {
    t, orgId, userId, customerId, vehicleId,
    asUser: t.withIdentity({ subject: "mv_u", clerkId: "mv_u" }),
    asApprover: t.withIdentity({ subject: "mv_a", clerkId: "mv_a" }),
  };
}

async function completeSale(asUser: any, orgId: any, customerId: any, vehicleId: any) {
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: SALE_PRICE, downPayment: 0, termMonths: 0,
  });
  const ids = await asUser.mutation(api.sales.completeFromQuote, { orgId, quoteId });
  return (Array.isArray(ids) ? ids[0] : ids) as Id<"sales">;
}

async function saleInvoiceId(t: any, saleId: any) {
  return await t.run(async (ctx: any) => (await ctx.db.get(saleId)).canonicalReceivableDocumentId);
}

/** Reduce the sale invoice directly so the canonical balance and the row's own stored balance disagree. */
async function settleInvoiceDirectly(asUser: any, t: any, orgId: any, saleId: any, amount: number) {
  await asUser.mutation(api.collections.recordPayment, {
    orgId, receivableDocumentId: await saleInvoiceId(t, saleId),
    amount, method: "CASH", paymentDate: Date.now(),
  });
}

/**
 * The movement breakdown, read back from the records that exist today. If the
 * authority cannot be derived from these, that itself is the finding — the
 * contract would then need a shared-contract change, which is out of scope and
 * must go back to AF-30 rather than be invented here.
 */
async function movementFor(t: any, canonicalPaymentId: any) {
  return await t.run(async (ctx: any) => {
    const payment = await ctx.db.get(canonicalPaymentId);
    const allocations = (await ctx.db.query("paymentAllocations").collect())
      .filter((a: any) => a.paymentId === canonicalPaymentId);
    const active = allocations.filter((a: any) => a.status === "ACTIVE");
    const mirror = (await ctx.db.query("collectionPayments").collect())
      .find((p: any) => p.canonicalPaymentId === canonicalPaymentId);
    return {
      requestedMinor: payment?.amountMinor ?? 0,
      activeAppliedMinor: active.reduce((s: number, a: any) => s + a.amountMinor, 0),
      activeAllocationCount: active.length,
      mirrorAmountMinor: mirror ? Math.round(mirror.amount * MINOR) : null,
      mirrorExists: Boolean(mirror),
    };
  });
}

async function latestCanonicalPaymentId(t: any) {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db.query("canonicalPayments").collect();
    return rows.sort((a: any, b: any) => b._creationTime - a._creationTime)[0]?._id ?? null;
  });
}

async function rowState(t: any, rowId: any) {
  return await t.run(async (ctx: any) => {
    const r = await ctx.db.get(rowId);
    return { outstanding: r.outstandingAmount, original: r.originalAmount, status: r.status };
  });
}

async function refund(asUser: any, asApprover: any, orgId: any, receivableId: any, amount: number) {
  const requestId = await asUser.mutation(api.collections.requestApproval, {
    orgId, receivableId, requestType: "REFUND", requestedAmount: amount,
    reason: "movement fixture", disbursementMethod: "CASH",
  });
  return await asApprover.mutation(api.collections.respondToApproval, {
    orgId, requestId, status: "APPROVED",
  });
}

describe("SCRUM-56 applied-movement authority — design fixtures", () => {
  // ---- the legacy mirror must consume appliedMinor, never the row balance ----

  test("M1 the row decreases only by what was actually allocated", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });

    // Sale invoice down to 7,000 while the row still claims 11,000.
    await settleInvoiceDirectly(asUser, t, orgId, saleId, SALE_PRICE - 7000);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: 11000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_m1",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const paymentId = await latestCanonicalPaymentId(t);
    const movement = await movementFor(t, paymentId);
    const row = await rowState(t, rowId);

    // Only 7,000 could be applied, so only 7,000 may leave the row.
    expect(movement.activeAppliedMinor).toBe(7000 * MINOR);
    expect(movement.mirrorAmountMinor).toBe(7000 * MINOR);
    expect(row.outstanding).toBe(4000);
  });

  test("M2 a canonical balance of zero does not falsely close the row or invent a payment", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });

    // The sale is already settled in full through another channel.
    await settleInvoiceDirectly(asUser, t, orgId, saleId, SALE_PRICE);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: 11000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_m2",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const paymentId = await latestCanonicalPaymentId(t);
    const movement = await movementFor(t, paymentId);
    const row = await rowState(t, rowId);

    expect(movement.activeAppliedMinor).toBe(0);
    // Nothing was applied, so the operational mirror must not claim a payment
    // against this row, and the row must not read as settled.
    expect(movement.mirrorAmountMinor === null || movement.mirrorAmountMinor === 0).toBe(true);
    expect(row.outstanding).toBe(11000);
    expect(row.status).not.toBe("PAID");
  });

  test("M3 provider money beyond what the debt can absorb stays unapplied, not misrecorded", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    await settleInvoiceDirectly(asUser, t, orgId, saleId, SALE_PRICE - 7000);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: 11000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_m3",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const movement = await movementFor(t, await latestCanonicalPaymentId(t));

    // requested 11,000 = applied 7,000 + unapplied 4,000, and the mirror agrees
    // with the applied half rather than the requested one.
    expect(movement.requestedMinor).toBe(11000 * MINOR);
    expect(movement.activeAppliedMinor).toBe(7000 * MINOR);
    expect(movement.requestedMinor - movement.activeAppliedMinor).toBe(4000 * MINOR);
    expect(movement.mirrorAmountMinor).toBe(7000 * MINOR);
  });

  // ---- reopening must use what is still applied, not what once was ----------

  test("M4 a cheque return after a partial refund reopens only the still-applied part", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId, bank: "ABC", chequeNumber: "CQ-M4",
      chequeDate: Date.now(), amount: 11000,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });
    await refund(asUser, asApprover, orgId, rowId, 4000);

    // The row has already been reopened by the refunded 4,000.
    expect((await rowState(t, rowId)).outstanding).toBe(4000);

    await asUser.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, returnReason: "Insufficient funds",
    });

    // Only 7,000 of the cheque was still applied, so only 7,000 may reopen.
    // The row can never exceed what it was ever for.
    const row = await rowState(t, rowId);
    expect(row.outstanding).toBe(11000);
    expect(row.outstanding).toBeLessThanOrEqual(row.original);
  });

  test("M5 two partial refunds then a cheque return still lands on the row's own total", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId, bank: "ABC", chequeNumber: "CQ-M5",
      chequeDate: Date.now(), amount: 11000,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });
    await refund(asUser, asApprover, orgId, rowId, 3000);
    await refund(asUser, asApprover, orgId, rowId, 2000);
    expect((await rowState(t, rowId)).outstanding).toBe(5000);

    await asUser.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, returnReason: "Insufficient funds",
    });

    const row = await rowState(t, rowId);
    expect(row.outstanding).toBe(11000);
    expect(row.outstanding).toBeLessThanOrEqual(row.original);
  });

  // ---- no lineage means refuse, never recompute from the row ---------------

  test("M6 an untraceable refund refuses instead of recomputing from the row balance", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: 11000, method: "CASH", paymentDate: Date.now(),
    });

    // The row still claims it collected 11,000, but the lineage is gone.
    await t.run(async (ctx: any) => {
      const payments = (await ctx.db.query("collectionPayments").collect())
        .filter((p: any) => String(p.receivableId) === String(rowId));
      for (const p of payments) await ctx.db.patch(p._id, { receivableId: undefined });
    });

    await expect(refund(asUser, asApprover, orgId, rowId, 11000)).rejects.toThrow();
  });

  // ---- one movement, whatever channel carried it ---------------------------

  // ---- X-series: the remaining paths, pinned or proven -------------------

  test("X1 recordPayment: the row decreases by what was applied, or the payment is refused", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    await settleInvoiceDirectly(asUser, t, orgId, saleId, SALE_PRICE - 7000);

    // Pin for P1: cash refuses an over-claim rather than recording one. The
    // contract permits refusal here -- the money has not been received yet.
    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId, receivableId: rowId, amount: 11000, method: "CASH", paymentDate: Date.now(),
      })
    ).rejects.toThrow(/larger than the sale still owes/);

    expect((await rowState(t, rowId)).outstanding).toBe(11000);
  });

  test("X2 clearCheque: same bound as recordPayment, same refusal", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    await settleInvoiceDirectly(asUser, t, orgId, saleId, SALE_PRICE - 7000);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId, bank: "ABC", chequeNumber: "CQ-X2",
      chequeDate: Date.now(), amount: 11000,
    });
    await expect(
      asUser.mutation(api.collections.clearCheque, { orgId, chequeId })
    ).rejects.toThrow(/larger than the sale still owes/);
  });

  test("X4 a cheque return with no prior refund still reopens the whole applied amount", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId, bank: "ABC", chequeNumber: "CQ-X4",
      chequeDate: Date.now(), amount: 11000,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });
    expect((await rowState(t, rowId)).outstanding).toBe(0);

    await asUser.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, returnReason: "Insufficient funds",
    });

    // The other half of R3: bounding the reopening by the LIVE figure must not
    // under-reopen when nothing has been refunded.
    expect((await rowState(t, rowId)).outstanding).toBe(11000);
  });

  test("X5 a fully-refunded cheque reopens nothing, and the reversal is chosen by anchor not pointer", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId, bank: "ABC", chequeNumber: "CQ-X5",
      chequeDate: Date.now(), amount: 11000,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });

    // A SECOND row with its own live payment, so the sale invoice carries an
    // allocation that does not belong to the cheque. Without it there is nothing
    // for a pointer-based implementation to wrongly consume, and the assertion
    // below would pass vacuously.
    const otherRowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Other", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: otherRowId, amount: 11000, method: "CASH", paymentDate: Date.now(),
    });

    // Refund the whole cheque, then point the moving pointer at the OTHER row's
    // allocation. R4 requires the return to select through `canonicalPaymentId`,
    // so a wrong pointer must not change the outcome and must not let the return
    // reverse money belonging to a different row.
    await refund(asUser, asApprover, orgId, rowId, 11000);
    await t.run(async (ctx: any) => {
      const chequePayment = (await ctx.db.query("collectionPayments").collect())
        .find((p: any) => String(p.chequeId) === String(chequeId));
      const foreign = (await ctx.db.query("paymentAllocations").collect())
        .find((a: any) => a.paymentId !== chequePayment.canonicalPaymentId && a.status === "ACTIVE");
      expect(foreign).toBeDefined();
      await ctx.db.patch(chequePayment._id, { paymentAllocationId: foreign._id });
    });

    const beforeOutstanding = (await rowState(t, rowId)).outstanding;
    await asUser.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, returnReason: "Insufficient funds",
    });
    const row = await rowState(t, rowId);

    // Nothing of the cheque was still applied, so nothing may reopen -- and the
    // row can never exceed what it was ever for.
    expect(row.outstanding).toBe(beforeOutstanding);
    expect(row.outstanding).toBeLessThanOrEqual(row.original);

    // The foreign allocation the stale pointer named must be untouched: an
    // implementation that reversed by pointer would have consumed it.
    await t.run(async (ctx: any) => {
      const sale = await ctx.db.get(saleId);
      const chequePayment = (await ctx.db.query("collectionPayments").collect())
        .find((p: any) => String(p.chequeId) === String(chequeId));
      const foreignActive = (await ctx.db.query("paymentAllocations").collect())
        .filter((a: any) =>
          a.paymentId !== chequePayment.canonicalPaymentId &&
          a.receivableDocumentId === sale.canonicalReceivableDocumentId &&
          a.status === "ACTIVE");
      expect(foreignActive.length).toBeGreaterThan(0);
    });
  });

  /**
   * X6 — P8, and the answer was better than expected.
   *
   * `utils/saleCancellation.ts` consumes allocation ids from outside Collections
   * and had never been exercised against a sale-linked legacy row, so this case
   * was reported to AF-30 as genuinely unknown rather than predicted. Measured:
   * it does not orphan allocations because it REFUSES to cancel while customer
   * money is applied. P8 is safe by fail-closed refusal, not by cleanup — which
   * is the stronger of the two, and means the escalation path AF-30 pre-authorised
   * is NOT needed. Pinned here so a later change cannot quietly turn the refusal
   * into an automatic reversal.
   */
  test("X6 cancelling a sale with applied customer money refuses rather than orphaning it", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: 11000, method: "CASH", paymentDate: Date.now(),
    });

    await expect(
      asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" })
    ).rejects.toThrow(/Refund or reverse those payments first/);

    // And the refusal leaves the money exactly where it was.
    const state = await t.run(async (ctx: any) => {
      const sale = await ctx.db.get(saleId);
      const active = (await ctx.db.query("paymentAllocations").collect())
        .filter((a: any) =>
          a.status === "ACTIVE" && a.receivableDocumentId === sale.canonicalReceivableDocumentId);
      return {
        saleStatus: sale.status,
        activeMinor: active.reduce((s: number, a: any) => s + a.amountMinor, 0),
      };
    });
    expect(state.saleStatus).not.toBe("CANCELLED");
    expect(state.activeMinor).toBe(11000 * MINOR);
  });

  /**
   * Y-series — the three escape paths Codex found at d512b9cde, on the
   * CORRECTED axis: "every path that MOVES Collections money", not "every path
   * that writes both an allocation and a mirror". All three were pre-existing;
   * all three bypassed the authority this PR introduces, and an authority
   * cannot ship with known escapes.
   */

  test("Y1 an intent that names only the sale still settles that sale's invoice", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);

    // A row that owns a twin, but an intent that does NOT reference the row --
    // it names the sale only. The redirect used to be gated on the owned-row
    // shape, so this combination allocated to whatever the intent named.
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 8000, dueDate: Date.now() + 86_400_000,
    });
    const twinId = await t.run(async (ctx: any) => (await ctx.db.get(rowId)).canonicalReceivableDocumentId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, saleId, receivableDocumentId: twinId,
      amountMinor: 8000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_y1",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await t.run(async (ctx: any) => {
      const sale = await ctx.db.get(saleId);
      const active = (await ctx.db.query("paymentAllocations").collect())
        .filter((a: any) => a.status === "ACTIVE");
      return {
        onInvoice: active.filter((a: any) => a.receivableDocumentId === sale.canonicalReceivableDocumentId)
          .reduce((s: number, a: any) => s + a.amountMinor, 0),
        onTwin: active.filter((a: any) => String(a.receivableDocumentId) === String(twinId))
          .reduce((s: number, a: any) => s + a.amountMinor, 0),
      };
    });

    expect(state.onInvoice).toBe(8000 * MINOR);
    expect(state.onTwin).toBe(0);
  });

  test("Y2 a sub-minor payment moves the row and the canonical debt by the same amount", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 10, dueDate: Date.now() + 86_400_000,
    });

    // 1.0005 in a scale-3 currency normalizes UP to 1.001. Unfixed, the payment
    // row stored 1.001 while the legacy balance was reduced by the raw 1.0005 and
    // then rounded, landing on 9.000 -- so the row and the canonical debt moved
    // by DIFFERENT amounts for one payment. 1.0004 would not expose this: it
    // rounds to the same place from both directions, which is exactly the kind
    // of fixture that passes without proving anything.
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: 1.0005, method: "CASH", paymentDate: Date.now(),
    });

    const state = await t.run(async (ctx: any) => {
      const row = await ctx.db.get(rowId);
      const payment = (await ctx.db.query("collectionPayments").collect())
        .find((p: any) => String(p.receivableId) === String(rowId));
      const applied = (await ctx.db.query("paymentAllocations").collect())
        .filter((a: any) => a.paymentId === payment.canonicalPaymentId && a.status === "ACTIVE")
        .reduce((s: number, a: any) => s + a.amountMinor, 0);
      return { rowOutstanding: row.outstandingAmount, mirrorAmount: payment.amount, appliedMinor: applied };
    });

    // One normalized value everywhere: 1.000 recorded, 1.000 applied, 1.000 off
    // the row -- never 8.9996 against 1.000.
    expect(state.mirrorAmount).toBe(1.001);
    expect(state.appliedMinor).toBe(1001);
    expect(state.rowOutstanding).toBe(8.999);
  });

  test("Y3 returning a cheque whose cleared payment cannot be traced refuses outright", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Row", amount: 8000, dueDate: Date.now() + 86_400_000,
    });

    // The shape the finance-application disbursement leaves behind: a CLEARED
    // cheque with no `collectionPayments` row. This used to mark the cheque
    // RETURNED and reverse nothing, leaving its canonical receipt live.
    const chequeId = await t.run(async (ctx: any) =>
      ctx.db.insert("postDatedCheques", {
        orgId, customerId, receivableId: rowId, bank: "ABC", chequeNumber: "CQ-Y3",
        chequeDate: Date.now(), amount: 8000, status: "CLEARED",
        createdBy: (await ctx.db.query("users").collect())[0]._id,
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    await expect(
      asUser.mutation(api.collections.returnClearedCheque, {
        orgId, chequeId, returnReason: "Insufficient funds",
      })
    ).rejects.toThrow(/cannot be traced/);

    // And the refusal changed nothing: no silent success.
    const state = await t.run(async (ctx: any) => {
      const cheque = await ctx.db.get(chequeId);
      const row = await ctx.db.get(rowId);
      return { chequeStatus: cheque.status, rowOutstanding: row.outstandingAmount };
    });
    expect(state.chequeStatus).toBe("CLEARED");
    expect(state.rowOutstanding).toBe(8000);
  });

  test("Y4 equivalent facts produce the same normalized breakdown on every channel", async () => {
    // The row that would have caught all three escapes at once, and whose
    // absence is why the round-1 path map read as complete.
    const breakdowns: Record<string, { mirror: number; appliedMinor: number; rowOutstanding: number }> = {};

    for (const channel of ["cash", "cheque", "link"] as const) {
      const { t, orgId, customerId, vehicleId, asUser } = await setup();
      const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
      const rowId = await asUser.mutation(api.collections.createReceivable, {
        orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
        title: "Row", amount: 10, dueDate: Date.now() + 86_400_000,
      });

      if (channel === "cash") {
        await asUser.mutation(api.collections.recordPayment, {
          orgId, receivableId: rowId, amount: 1.0005, method: "CASH", paymentDate: Date.now(),
        });
      } else if (channel === "cheque") {
        const chequeId = await asUser.mutation(api.collections.registerCheque, {
          orgId, receivableId: rowId, customerId, bank: "ABC", chequeNumber: "CQ-Y4",
          chequeDate: Date.now(), amount: 1.0005,
        });
        await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });
      } else {
        const intentId = await asUser.mutation(api.paymentIntents.create, {
          orgId, customerId, receivableId: rowId, saleId,
          amountMinor: 1001, currency: "JOD", provider: "stripe", externalId: "pi_y4",
        });
        await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });
      }

      breakdowns[channel] = await t.run(async (ctx: any) => {
        const row = await ctx.db.get(rowId);
        const payment = (await ctx.db.query("collectionPayments").collect())
          .find((p: any) => String(p.receivableId) === String(rowId));
        const applied = (await ctx.db.query("paymentAllocations").collect())
          .filter((a: any) => a.paymentId === payment.canonicalPaymentId && a.status === "ACTIVE")
          .reduce((s: number, a: any) => s + a.amountMinor, 0);
        return { mirror: payment.amount, appliedMinor: applied, rowOutstanding: row.outstandingAmount };
      });
    }

    expect(breakdowns.cheque).toEqual(breakdowns.cash);
    expect(breakdowns.link).toEqual(breakdowns.cash);
    expect(breakdowns.cash).toEqual({ mirror: 1.001, appliedMinor: 1001, rowOutstanding: 8.999 });
  });

  test("M7 cash, cheque and payment link record exactly what they applied", async () => {
    // Same facts on each channel: the canonical debt can absorb 7,000 while the
    // row still claims 11,000. A channel may refuse -- money not yet received
    // can be declined -- but a channel that DOES record a payment must record
    // the amount it actually applied, not the amount it was asked for.
    const results: Record<string, { recorded: number | null; applied: number }> = {};

    for (const channel of ["cash", "cheque", "link"] as const) {
      const { t, orgId, customerId, vehicleId, asUser } = await setup();
      const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
      const rowId = await asUser.mutation(api.collections.createReceivable, {
        orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
        title: "Row", amount: 11000, dueDate: Date.now() + 86_400_000,
      });
      await settleInvoiceDirectly(asUser, t, orgId, saleId, SALE_PRICE - 7000);

      try {
        if (channel === "cash") {
          await asUser.mutation(api.collections.recordPayment, {
            orgId, receivableId: rowId, amount: 11000, method: "CASH", paymentDate: Date.now(),
          });
        } else if (channel === "cheque") {
          const chequeId = await asUser.mutation(api.collections.registerCheque, {
            orgId, receivableId: rowId, customerId, bank: "ABC", chequeNumber: "CQ-M7",
            chequeDate: Date.now(), amount: 11000,
          });
          await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });
        } else {
          const intentId = await asUser.mutation(api.paymentIntents.create, {
            orgId, customerId, receivableId: rowId, saleId,
            amountMinor: 11000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_m7",
          });
          await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });
        }
      } catch {
        results[channel] = { recorded: null, applied: 0 };
        continue;
      }

      const movement = await movementFor(t, await latestCanonicalPaymentId(t));
      results[channel] = {
        recorded: movement.mirrorAmountMinor,
        applied: movement.activeAppliedMinor,
      };
    }

    for (const [channel, r] of Object.entries(results)) {
      if (r.recorded === null) continue; // refused outright -- acceptable
      expect(`${channel}:${r.recorded}`).toBe(`${channel}:${r.applied}`);
    }
  });
});
