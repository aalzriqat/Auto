import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * SCRUM-56 — LINEAGE CONTRACT FIXTURES. Design artefact, not a fix.
 *
 * PR #241 is frozen at 603b324fc. These fixtures exist to specify, executably,
 * what the legacy-row -> canonical-payment/allocation relationship must
 * guarantee before any further implementation. They are deliberately written
 * against the CONTRACT, not against current behaviour, so the ones that fail
 * are the measurement of how far the model is from the contract.
 *
 * THE CONTRACT UNDER TEST
 *
 *   C1  Every money movement recorded against a legacy `receivables` row must
 *       be traceable, unambiguously and permanently, to that row.
 *   C2  Reversing money for a row must reverse exactly that row's own
 *       allocations — never another row's, even when both rows resolve to the
 *       same canonical document.
 *   C3  Where lineage cannot be established, the operation must FAIL CLOSED.
 *       Guessing (e.g. "newest active allocation on the shared document") is
 *       not an acceptable substitute for lineage.
 *
 * WHY THE CONTRACT IS NOT MET TODAY (evidence, not assertion)
 *
 *   `collectionPayments` already carries real lineage: `receivableId` (the
 *   row), `canonicalPaymentId`, and `paymentAllocationId`. `returnCheque`
 *   (collections.ts:1732) uses it correctly — it reverses the exact stored
 *   `paymentAllocationId`. `reverseAllocationsForRefund` (collections.ts:461)
 *   does NOT: it queries `paymentAllocations` by `receivableDocumentId` and
 *   consumes newest-first. Once two rows share one sale invoice, that walks
 *   into another row's money.
 *
 *   It is also not merely a matter of "use the stored id": that field is
 *   single-valued and is NOT rewritten when `reverseAllocationsForRefund`
 *   re-allocates a remainder (collections.ts:489), so the stored lineage goes
 *   stale after the first partial refund. `paymentAllocations` itself carries
 *   no back-link to the row. That is the underspecification.
 *
 * PRODUCTION EXPOSURE: ZERO. `npx convex data receivables --prod` returns "no
 * documents in this table", so no legacy rows exist in production and none of
 * these scenarios has a live instance. No backfill is authorised or needed.
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

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Lineage Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "lin_u", email: "u@t.com", name: "U" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "lin_a", email: "a@t.com", name: "A" })
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
    asUser: t.withIdentity({ subject: "lin_u", clerkId: "lin_u" }),
    asApprover: t.withIdentity({ subject: "lin_a", clerkId: "lin_a" }),
  };
}

async function completeSale(asUser: any, orgId: any, customerId: any, vehicleId: any) {
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: SALE_PRICE, downPayment: 0, termMonths: 0,
  });
  const ids = await asUser.mutation(api.sales.completeFromQuote, { orgId, quoteId });
  return (Array.isArray(ids) ? ids[0] : ids) as Id<"sales">;
}

async function addRow(
  t: any, orgId: any, customerId: any, userId: any,
  saleId: any, amount: number, title: string
) {
  const now = Date.now();
  return await t.run((ctx: any) =>
    ctx.db.insert("receivables", {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT", title,
      originalAmount: amount, outstandingAmount: amount, dueDate: now + 86_400_000,
      status: "OPEN", createdBy: userId, createdAt: now, updatedAt: now,
    })
  );
}

/**
 * What C1/C2 need to be answerable: for a given legacy row, how much of ITS
 * money is still applied. Today this can only be reconstructed by joining
 * through `collectionPayments`, which is exactly the lineage the reversal path
 * declines to use.
 */
async function appliedMinorForRow(t: any, rowId: any) {
  return await t.run(async (ctx: any) => {
    const payments = await ctx.db
      .query("collectionPayments")
      .filter((q: any) => q.eq(q.field("receivableId"), rowId))
      .collect();
    const allocations = await ctx.db.query("paymentAllocations").collect();
    let applied = 0;
    for (const p of payments.filter((x: any) => x.direction === "IN")) {
      applied += allocations
        .filter((a: any) => a.paymentId === p.canonicalPaymentId && a.status === "ACTIVE")
        .reduce((s: number, a: any) => s + a.amountMinor, 0);
    }
    return applied;
  });
}

async function refund(asUser: any, asApprover: any, orgId: any, receivableId: any, amount: number) {
  const requestId = await asUser.mutation(api.collections.requestApproval, {
    orgId, receivableId, requestType: "REFUND", requestedAmount: amount,
    reason: "lineage fixture", disbursementMethod: "CASH",
  });
  return await asApprover.mutation(api.collections.respondToApproval, {
    orgId, requestId, status: "APPROVED",
  });
}

describe("SCRUM-56 lineage contract — fixtures for the redesign", () => {
  // ---- C2: reversal must be row-attributable -----------------------------

  test("F1 two installments both paid, refunding A reverses A's money and leaves B's alone", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowA = await addRow(t, orgId, customerId, userId, saleId, 11000, "A");
    const rowB = await addRow(t, orgId, customerId, userId, saleId, 11000, "B");

    for (const row of [rowA, rowB]) {
      await asUser.mutation(api.collections.recordPayment, {
        orgId, receivableId: row, amount: 11000, method: "CASH", paymentDate: Date.now(),
      });
    }

    await refund(asUser, asApprover, orgId, rowA, 11000);

    // A was refunded in full: none of A's money remains applied.
    expect(await appliedMinorForRow(t, rowA)).toBe(0);
    // B was never part of the request and must be untouched.
    expect(await appliedMinorForRow(t, rowB)).toBe(11000 * 1000);
  });

  test("F2 payment order must not decide whose money gets reversed", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowA = await addRow(t, orgId, customerId, userId, saleId, 11000, "A");
    const rowB = await addRow(t, orgId, customerId, userId, saleId, 11000, "B");

    // Identical amounts, reversed payment order relative to F1. Newest-first
    // consumption makes the outcome depend on this; lineage must not.
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowB, amount: 11000, method: "CASH", paymentDate: Date.now(),
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowA, amount: 11000, method: "CASH", paymentDate: Date.now(),
    });

    await refund(asUser, asApprover, orgId, rowA, 11000);

    expect(await appliedMinorForRow(t, rowA)).toBe(0);
    expect(await appliedMinorForRow(t, rowB)).toBe(11000 * 1000);
  });

  test("F3 a partial refund leaves the row's remaining money applied and traceable", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowA = await addRow(t, orgId, customerId, userId, saleId, 11000, "A");
    const rowB = await addRow(t, orgId, customerId, userId, saleId, 11000, "B");

    for (const row of [rowA, rowB]) {
      await asUser.mutation(api.collections.recordPayment, {
        orgId, receivableId: row, amount: 11000, method: "CASH", paymentDate: Date.now(),
      });
    }

    await refund(asUser, asApprover, orgId, rowA, 4000);

    // The re-allocated remainder must still belong to A. This is where the
    // single-valued `collectionPayments.paymentAllocationId` goes stale today:
    // the remainder is re-allocated (collections.ts:489) without updating it.
    expect(await appliedMinorForRow(t, rowA)).toBe(7000 * 1000);
    expect(await appliedMinorForRow(t, rowB)).toBe(11000 * 1000);
  });

  test("F4 a returned cheque reverses only the cheque's own allocation", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowA = await addRow(t, orgId, customerId, userId, saleId, 11000, "A");
    const rowB = await addRow(t, orgId, customerId, userId, saleId, 11000, "B");

    // B pays cash; A pays by cheque which then bounces.
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowB, amount: 11000, method: "CASH", paymentDate: Date.now(),
    });
    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowA, customerId, bank: "ABC", chequeNumber: "CHQ-1",
      chequeDate: Date.now(), amount: 11000,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });
    // `returnCheque` refuses a CLEARED cheque (collections.ts:1550); the path
    // that unwinds an already-cleared cheque's money is `returnClearedCheque`.
    await asUser.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, returnReason: "Insufficient funds",
    });

    // returnCheque follows the stored allocation id, so this is the shape the
    // refund path should match — included to pin the behaviour that is already
    // correct, so a redesign cannot regress it.
    expect(await appliedMinorForRow(t, rowA)).toBe(0);
    expect(await appliedMinorForRow(t, rowB)).toBe(11000 * 1000);
  });

  test("F5 cancelling one row leaves the other row's money and the sale's debt intact", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    // Created through the real mutation, NOT a raw insert: `createReceivable`
    // is what raises the unconditional canonical twin, and a raw-inserted row
    // has none — which would make the twin assertion below pass vacuously.
    const rowA = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "A", amount: 11000, dueDate: Date.now() + 86_400_000,
    });
    const rowB = await addRow(t, orgId, customerId, userId, saleId, 11000, "B");

    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowB, amount: 11000, method: "CASH", paymentDate: Date.now(),
    });

    // A is unpaid, so it can be cancelled directly.
    const requestId = await asUser.mutation(api.collections.requestApproval, {
      orgId, receivableId: rowA, requestType: "CANCEL_RECEIVABLE", reason: "keyed twice",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId, requestId, status: "APPROVED",
    });

    expect(await appliedMinorForRow(t, rowB)).toBe(11000 * 1000);

    // And cancelling a duplicate copy must not retire the row's own canonical
    // twin into a permanently OPEN orphan (the Finding B regression) nor touch
    // the sale invoice.
    const state = await t.run(async (ctx: any) => {
      const row = await ctx.db.get(rowA);
      const sale = await ctx.db.get(saleId);
      const invoice = await ctx.db.get(sale.canonicalReceivableDocumentId);
      const twin = row.canonicalReceivableDocumentId
        ? await ctx.db.get(row.canonicalReceivableDocumentId)
        : null;
      return { rowStatus: row.status, invoiceStatus: invoice.status, twinStatus: twin?.status ?? null };
    });
    expect(state.rowStatus).toBe("CANCELLED");
    expect(state.invoiceStatus).not.toBe("CANCELLED");
    // Either there is no twin, or it was retired with its row. What must not
    // happen is a twin left OPEN at full value forever.
    expect(state.twinStatus === null || state.twinStatus === "CANCELLED").toBe(true);
  });

  // ---- C3: no lineage means refuse, never guess ---------------------------

  test("F6 a historical payment with no recoverable lineage must fail closed, not guess", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser, asApprover } = await setup();
    const saleId = await completeSale(asUser, orgId, customerId, vehicleId);
    const rowA = await addRow(t, orgId, customerId, userId, saleId, 11000, "A");
    const rowB = await addRow(t, orgId, customerId, userId, saleId, 11000, "B");

    for (const row of [rowA, rowB]) {
      await asUser.mutation(api.collections.recordPayment, {
        orgId, receivableId: row, amount: 11000, method: "CASH", paymentDate: Date.now(),
      });
    }

    // Simulate a pre-contract row: its payment's lineage back to the row is
    // missing, exactly as it would be for anything written before the contract
    // existed. The system must refuse rather than reverse someone else's money.
    await t.run(async (ctx: any) => {
      const payments = await ctx.db
        .query("collectionPayments")
        .filter((q: any) => q.eq(q.field("receivableId"), rowA))
        .collect();
      for (const p of payments) await ctx.db.patch(p._id, { receivableId: undefined });
    });

    await expect(refund(asUser, asApprover, orgId, rowA, 11000)).rejects.toThrow();

    // And the refusal must not have consumed B's money on the way out.
    expect(await appliedMinorForRow(t, rowB)).toBe(11000 * 1000);
  });
});
