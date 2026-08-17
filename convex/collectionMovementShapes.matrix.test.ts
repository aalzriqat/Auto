import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * SCRUM-121 — PRIORITY-1 PATH × INPUT-SHAPE MATRIX. Measurement only.
 *
 * Authorized by AF30-D007 (SCRUM-121 c12483): Priority-1 tier only, TESTS ONLY,
 * run against clean `main` so they measure the BASE, not a fix. No production
 * code, no schema, no `convex/subledger.ts`. Do not extend into a fix.
 *
 * Each test asserts the OWNER CONTRACT. Run here, a red cell is a contract
 * violation present on `main` today — that is the point of the exercise, not a
 * broken test. A cell that cannot be constructed at all is also a finding and
 * is reported as such rather than quietly dropped.
 *
 * SHAPES
 *   S1  neither receivableId nor saleId
 *   S2  saleId only
 *   S3  STANDALONE receivableId only (row carries no saleId)
 *   S4  sale-linked receivableId only
 *   S5  correlated receivableId + saleId
 *   S6  UNRELATED receivableId + saleId  <- the shape that fired the breaker
 *
 * CONTRACT UNDER TEST (owner rules 1 and 3)
 *   §1 every movement resolves exactly ONE canonical debt before it allocates
 *      money or updates an operational mirror;
 *   §3 if receivableId and saleId are both present they must resolve to the
 *      SAME canonical debt or the operation FAILS CLOSED; the sale fallback
 *      applies ONLY when receivableId is absent; a standalone receivable must
 *      NEVER fall through to an unrelated sale invoice.
 *
 * NOT ASSERTED ANYWHERE HERE: any verdict about a path that this file does not
 * measure. A result measured on one input shape is not a result about the path.
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
    ctx.db.insert("organizations", { name: "Shape Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "sh_u", email: "u@t.com", name: "U" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "sh_a", email: "a@t.com", name: "A" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Nora", lastName: "Khaled" })
  );
  return {
    t, orgId, userId, customerId,
    asUser: t.withIdentity({ subject: "sh_u", clerkId: "sh_u" }),
    asApprover: t.withIdentity({ subject: "sh_a", clerkId: "sh_a" }),
  };
}

/** A completed sale, and therefore a canonical sale invoice. */
async function completedSale(t: any, asUser: any, orgId: any, customerId: any, vin: string) {
  const vehicleId = await t.run((ctx: any) =>
    ctx.db.insert("vehicles", {
      orgId, vin, make: "Mazda", model: "CX-5", year: 2023, color: "Red",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 500,
      sellingPrice: SALE_PRICE, status: "AVAILABLE",
    })
  );
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: SALE_PRICE, downPayment: 0, termMonths: 0,
  });
  const ids = await asUser.mutation(api.sales.completeFromQuote, { orgId, quoteId });
  const saleId = (Array.isArray(ids) ? ids[0] : ids) as Id<"sales">;
  const invoiceId = await t.run(async (ctx: any) => (await ctx.db.get(saleId)).canonicalReceivableDocumentId);
  return { saleId, invoiceId, vehicleId };
}

/**
 * A STANDALONE hand-keyed row — deliberately no saleId.
 *
 * `creditSystemKey` is REQUIRED here and is itself a measured fact about the
 * shape: `createReceivable:636` derives the credit account from `args.saleId`
 * when present, and otherwise demands an explicit key. So a standalone row is
 * constructable, but only by naming its own income/liability account — the
 * sale-linked shape never has to. Recorded because "the standalone shape is
 * harder to construct than the sale-linked one" is exactly the kind of asymmetry
 * that keeps a shape out of a fixture matrix.
 */
async function standaloneRow(asUser: any, orgId: any, customerId: any, amount = 8000) {
  return await asUser.mutation(api.collections.createReceivable, {
    orgId, customerId, sourceType: "INTERNAL_INSTALLMENT",
    title: "Standalone", amount, dueDate: Date.now() + 86_400_000,
    creditSystemKey: "MISCELLANEOUS_INCOME",
  });
}

/** Where did this org's money actually land, and what does the record claim? */
async function ledgerState(t: any, invoiceId: any, rowId: any) {
  return await t.run(async (ctx: any) => {
    const allocations = (await ctx.db.query("paymentAllocations").collect())
      .filter((a: any) => a.status === "ACTIVE");
    const row = rowId ? await ctx.db.get(rowId) : null;
    const rowTwinId = row?.canonicalReceivableDocumentId ?? null;
    const payments = await ctx.db.query("collectionPayments").collect();
    return {
      onSaleInvoiceMinor: allocations
        .filter((a: any) => String(a.receivableDocumentId) === String(invoiceId))
        .reduce((s: number, a: any) => s + a.amountMinor, 0),
      onRowTwinMinor: rowTwinId
        ? allocations.filter((a: any) => String(a.receivableDocumentId) === String(rowTwinId))
            .reduce((s: number, a: any) => s + a.amountMinor, 0)
        : 0,
      rowOutstanding: row?.outstandingAmount ?? null,
      mirrorSaleIds: payments.map((p: any) => (p.saleId ? String(p.saleId) : null)),
      mirrorCount: payments.length,
    };
  });
}

describe("SCRUM-121 Priority-1 — path × input shape, measured on clean main", () => {
  // ---- A2: P1 recordPayment × S6 (the breaker shape, cash) ---------------

  test("A2 · P1×S6 · cash: a standalone row paid while naming an unrelated sale", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000001");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    // S6: the row belongs to no sale; the caller names an UNRELATED completed sale.
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, saleId, amount: 8000,
      method: "CASH", paymentDate: Date.now(),
    });

    const state = await ledgerState(t, invoiceId, rowId);

    // §3 — the money must settle the row's own debt, never the unrelated sale.
    expect(state.onSaleInvoiceMinor).toBe(0);
    expect(state.onRowTwinMinor).toBe(8000 * MINOR);

    // §1 — and the record must not claim this movement belonged to that sale.
    // `main` computes saleId as `receivable?.saleId ?? args.saleId`, so a
    // STANDALONE row falls through to the unrelated sale for this field.
    expect(state.mirrorSaleIds).not.toContain(String(saleId));
  });

  // ---- A3: P2 cheque × S6, asserted at BOTH boundaries -------------------

  test("A3 · P2×S6 · cheque: shape asserted at register and again at clear", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000002");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId, saleId,
      bank: "ABC", chequeNumber: "CQ-A3", chequeDate: Date.now(), amount: 8000,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });

    const state = await ledgerState(t, invoiceId, rowId);
    expect(state.onSaleInvoiceMinor).toBe(0);
    expect(state.onRowTwinMinor).toBe(8000 * MINOR);
    expect(state.mirrorSaleIds).not.toContain(String(saleId));
  });

  // ---- A1: P3 payment intent × S6 ---------------------------------------

  test("A1 · P3×S6 · payment link: standalone row + unrelated sale", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000003");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: 8000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a1",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await ledgerState(t, invoiceId, rowId);
    expect(state.onSaleInvoiceMinor).toBe(0);
    expect(state.onRowTwinMinor).toBe(8000 * MINOR);
    expect(state.mirrorSaleIds).not.toContain(String(saleId));
  });

  // ---- A4: P3 × S3 — standalone row only, no fallback --------------------

  test("A4 · P3×S3 · standalone row only settles that row, with no sale fallback", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000004");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId,
      amountMinor: 8000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a4",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await ledgerState(t, invoiceId, rowId);
    expect(state.onSaleInvoiceMinor).toBe(0);
    expect(state.onRowTwinMinor).toBe(8000 * MINOR);
  });

  // ---- A5: P3 × S2 — the legitimate sale-only fallback -------------------

  test("A5 · P3×S2 · sale only settles that sale's canonical invoice", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000005");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, saleId,
      amountMinor: 8000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a5",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    // §1 — a movement that can name exactly one debt must settle it.
    const state = await ledgerState(t, invoiceId, null);
    expect(state.onSaleInvoiceMinor).toBe(8000 * MINOR);
  });

  // ---- A6: P3 × S5 — correlated pair, one target ------------------------

  test("A6 · P3×S5 · a correlated pair resolves to one target", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000006");
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Correlated", amount: 8000, dueDate: Date.now() + 86_400_000,
    });

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: 8000 * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a6",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    // One debt: the money lands in exactly one place, not split across both
    // representations of the same sale.
    const state = await ledgerState(t, invoiceId, rowId);
    const landedInBothPlaces = state.onSaleInvoiceMinor > 0 && state.onRowTwinMinor > 0;
    expect(landedInBothPlaces).toBe(false);
    expect(state.onSaleInvoiceMinor + state.onRowTwinMinor).toBe(8000 * MINOR);
  });

  // ---- A7: S1 — neither reference present -------------------------------

  test("A7 · P1×S1 · with neither reference, main must not invent a debt mirror", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000007");

    // Measured, not assumed: does `main` accept a payment naming no debt at all?
    let refused: string | null = null;
    try {
      await asUser.mutation(api.collections.recordPayment, {
        orgId, customerId, amount: 8000, method: "CASH", paymentDate: Date.now(),
      });
    } catch (e: any) {
      refused = String(e?.data ?? e?.message ?? e);
    }

    const state = await ledgerState(t, invoiceId, null);

    // Either it refuses, or it records an unapplied payment — but it must never
    // allocate against a debt it was never given.
    expect(state.onSaleInvoiceMinor).toBe(0);
    // Record which of the two `main` actually does, so the contract can adopt
    // the existing semantics rather than invent one.
    expect({ refused: refused !== null, mirrorCount: state.mirrorCount }).toEqual(
      { refused: false, mirrorCount: 1 }
    );
  });

  // ---- D3 / X6 REOPENED: P8 sale cancellation across shapes --------------

  test("X6a · P8 · sale cancellation with a CORRELATED paid row (the shape measured before)", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000008");
    const rowId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Correlated", amount: 8000, dueDate: Date.now() + 86_400_000,
    });
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: 8000, method: "CASH", paymentDate: Date.now(),
    });

    let refused: string | null = null;
    try {
      await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });
    } catch (e: any) {
      refused = String(e?.data ?? e?.message ?? e);
    }
    expect(refused).not.toBeNull();
  });

  test("X6b · P8 · sale cancellation with a STANDALONE paid row present (never measured)", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000009");
    // A paid standalone row exists for the same customer but belongs to no sale.
    const rowId = await standaloneRow(asUser, orgId, customerId);
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: 8000, method: "CASH", paymentDate: Date.now(),
    });

    let refused: string | null = null;
    try {
      await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });
    } catch (e: any) {
      refused = String(e?.data ?? e?.message ?? e);
    }

    // Cancelling the sale must not disturb money that was never the sale's.
    const state = await ledgerState(t, invoiceId, rowId);
    expect(state.onRowTwinMinor).toBe(8000 * MINOR);
    expect({ refusedCancellation: refused !== null }).toEqual({ refusedCancellation: false });
  });
});
