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
 * PRODUCTION EXPOSURE: ZERO — `convex data receivables --prod` reports no
 * documents. No backfill is authorised or needed.
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
