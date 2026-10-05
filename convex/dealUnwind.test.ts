/**
 * SCRUM-693 - unwinding a paid finance deal from the deal page.
 *
 * The #pntr shape on the SCRUM-435 worked example: G = 12,500 approved and
 * transferred by the finance company, H + C = 1,575 forwarded back to it.
 * Unwind = the company returns the forward, then ONE step (Sol ruling B,
 * c22129) refunds the full remittance by the same rail and cancels the deal.
 * A refusal anywhere in that step - the closed-deal teardown included - leaves
 * every row as it was.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime (no OCC, no paginated-query limit) and not production data.
 */
import {
  C, G, H, finalizeAsOwner, readyDeal, refusalMessageOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isFinanceCashReceivedReversalPosted } from "./dealUnwind";
import { deriveForwardState } from "./utils/financeCompanyForward";
import { DEAL_UNWIND_MESSAGES } from "./utils/dealUnwindMessages";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];
/** SALES: no cancel, no disbursement, no finance view. */
const SALES_PERMS = ALL_PERMS.filter(
  (p) => !["manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement", "view:finance", "manage:finance"].includes(p)
);
/** Can refund (disbursement + finance view) but not cancel a closed deal. */
const CASHIER_PERMS = ALL_PERMS.filter((p) => p !== "cancel:closed_deal");
const FORWARD = H + C;
const MANUAL_CORRECTION = /manual accounting correction/;

async function seed(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S693", vinPrefix: "VIN693",
    actors: { sales: SALES_PERMS, cashier: CASHIER_PERMS, manager: ["manage:users"] },
  });
  return { ...s, sales: s.actors.sales, cashier: s.actors.cashier, manager: s.actors.manager };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Finalized, forward paid to the company, the company's G received. */
async function paidDeal(tag: string, method: "BANK_TRANSFER" | "CASH" = "BANK_TRANSFER") {
  const s = await seed(tag);
  const { applicationId } = await readyDeal(s);
  await finalizeAsOwner(s, applicationId);
  await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
    expectedAmountMinor: FORWARD, idempotencyKey: crypto.randomUUID(),
  });
  if (method === "CASH") await s.t.run((ctx) => ctx.db.patch(applicationId, { expectedPaymentMethod: "CASH" }));
  await s.owner.as.mutation(api.applications.confirmDisbursement, {
    orgId: s.orgId, applicationId, disbursedAmountMinor: G, idempotencyKey: crypto.randomUUID(),
  });
  return { s, applicationId };
}

const start = (s: Seeded, applicationId: Id<"financeApplications">, key = crypto.randomUUID(), as = s.owner.as) =>
  as.mutation(api.dealUnwind.startDealUnwind, {
    orgId: s.orgId, applicationId, reason: "Customer returned the car.", idempotencyKey: key,
  });
const forwardReturn = (s: Seeded, unwindId: Id<"dealUnwinds">) =>
  s.owner.as.mutation(api.dealUnwind.recordDealUnwindForwardReturn, {
    orgId: s.orgId, unwindId, returnedAt: Date.now(), reference: "FC-RET-1", idempotencyKey: crypto.randomUUID(),
  });
const finishArgs = (s: Seeded, unwindId: Id<"dealUnwinds">, method: "BANK_TRANSFER" | "CASH" = "BANK_TRANSFER") => ({
  orgId: s.orgId, unwindId, method, refundedAt: Date.now(),
  ...(method === "BANK_TRANSFER"
    ? { bankReference: "TRF-998" }
    : { voucherNumber: "PV-12", recipientAcknowledged: true }),
  creditNoteReference: "CN-77", vehicleReturnedAt: Date.now(),
  vehicleReturnNote: "Returned to the lot.", customerPaymentDisposition: "REFUND" as const,
  idempotencyKey: crypto.randomUUID(),
});
/** Record the remittance refund and close the deal - one step. */
const finish = (s: Seeded, unwindId: Id<"dealUnwinds">, method: "BANK_TRANSFER" | "CASH" = "BANK_TRANSFER", as = s.owner.as) =>
  as.mutation(api.dealUnwind.finishDealUnwind, finishArgs(s, unwindId, method));
const abandon = (s: Seeded, unwindId: Id<"dealUnwinds">) =>
  s.owner.as.mutation(api.dealUnwind.abandonDealUnwind, {
    orgId: s.orgId, unwindId, reason: "Customer kept the car.", idempotencyKey: crypto.randomUUID(),
  });
const bareCancel = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.owner.as.mutation(api.applications.cancelApplication, {
    orgId: s.orgId, applicationId, reason: "x", idempotencyKey: crypto.randomUUID(),
  });

const receiptProof = (s: Seeded, applicationId: Id<"financeApplications">, disbursementVersion = 1) =>
  s.t.run((ctx) => isFinanceCashReceivedReversalPosted(ctx, { orgId: s.orgId, applicationId, disbursementVersion }));
const receiptEvents = (s: Seeded) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === "FINANCE_CASH_RECEIVED"
    )
  );

/**
 * Every row the combined step writes, reduced to what a partial commit would
 * change. Two equal snapshots around a refused call prove nothing moved.
 */
const moneyState = (s: Seeded, applicationId: Id<"financeApplications">, unwindId: Id<"dealUnwinds">) =>
  s.t.run(async (ctx) => {
    const app = (await ctx.db.get(applicationId))!;
    const sale = (await ctx.db.get(app.finalizedSaleId!))!;
    const unwind = (await ctx.db.get(unwindId))!;
    const ofOrg = <T extends { orgId: Id<"organizations"> }>(rows: T[]) => rows.filter((row) => row.orgId === s.orgId);
    const events = await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const payments = await ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    return {
      app: {
        status: app.status,
        disbursedAt: app.disbursedAt,
        disbursedAmountMinor: app.disbursedAmountMinor,
        disbursementVersion: app.disbursementVersion,
        settlementStatus: app.settlementStatus,
      },
      sale: sale.status,
      unwind: { status: unwind.status, refunded: unwind.remittanceRefund !== undefined, completed: unwind.completion !== undefined },
      events: events.map((e) => `${e.eventType}:${e.status}`).sort(),
      payments: payments.map((p) => `${p.direction}:${p.amountMinor}:${p.status}`).sort(),
      allocations: ofOrg(await ctx.db.query("paymentAllocations").collect()).map((a) => a.status).sort(),
      receivables: ofOrg(await ctx.db.query("receivableDocuments").collect()).map((r) => `${r.sourceType}:${r.status}`).sort(),
      journalLines: ofOrg(await ctx.db.query("journalLines").collect()).length,
      dealUnwindAudits: ofOrg(await ctx.db.query("financialAuditLog").collect())
        .filter((row) => row.actionType.startsWith("DEAL_UNWIND"))
        .map((row) => row.actionType)
        .sort(),
    };
  });

const ledgerTotals = (s: Seeded) =>
  s.t.run(async (ctx) => {
    const lines = (await ctx.db.query("journalLines").collect()).filter((line) => line.orgId === s.orgId);
    return {
      debit: lines.reduce((sum, line) => sum + line.debitMinor, 0),
      credit: lines.reduce((sum, line) => sum + line.creditMinor, 0),
    };
  });

describe("SCRUM-693 - the full unwind of a #pntr-shaped deal", () => {
  test.each(["BANK_TRANSFER", "CASH"] as const)(
    "%s: start -> forward returned -> refund and close: the deal is CANCELLED and every leg is POSTED",
    async (method) => {
      const { s, applicationId } = await paidDeal(`happy_${method}`, method);
      const unwindId = await start(s, applicationId);

      const unwind = await s.t.run((ctx) => ctx.db.get(unwindId));
      expect(unwind).toMatchObject({ status: "ACTIVE", remittanceMinor: G, remittanceMethod: method, forwardDueMinor: FORWARD });

      await forwardReturn(s, unwindId);
      const proof = await s.t.run(async (ctx) => deriveForwardState(ctx, (await ctx.db.get(applicationId))!));
      expect(proof.versions.some((row) => row.state === "RETURNED")).toBe(true);

      const result = await finish(s, unwindId, method);
      expect(result).toMatchObject({ receiptReversal: "REVERSED", nextDisbursementVersion: 2 });

      const app = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(app).toMatchObject({ status: "CANCELLED", disbursementVersion: 2 });
      expect(app?.disbursedAt).toBeUndefined();
      expect(app?.disbursedAmountMinor).toBeUndefined();
      expect(await receiptProof(s, applicationId)).toBe("REVERSED");

      const done = await s.t.run((ctx) => ctx.db.get(unwindId));
      expect(done?.status).toBe("COMPLETED");
      expect(done?.remittanceRefund).toMatchObject({ method, amountMinor: G, receiptReversal: "REVERSED" });
      expect(done?.completion).toMatchObject({ creditNoteReference: "CN-77", customerPaymentDisposition: "REFUND" });

      // F4: the sale, its revenue journal, the receivables and the ledger.
      const after = await s.t.run(async (ctx) => {
        const sale = await ctx.db.get(app!.finalizedSaleId!);
        const events = await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
        const receivables = (await ctx.db.query("receivableDocuments").collect()).filter((r) => r.orgId === s.orgId);
        const payments = await ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
        return { sale, events, receivables, payments };
      });
      expect(after.sale?.status).toBe("CANCELLED");
      // The sale, the forward and the receipt are each reversed, and each
      // reversal is itself POSTED - nothing original is left live.
      const originals = after.events.filter((e) => e.eventType !== "JOURNAL_REVERSAL");
      expect(originals.map((e) => e.eventType).sort()).toEqual(
        ["FINANCE_CASH_RECEIVED", "FINANCE_COMPANY_FORWARD_PAID", "SALE_COMPLETED"]
      );
      expect(originals.every((e) => e.status === "REVERSED")).toBe(true);
      const reversals = after.events.filter((e) => e.eventType === "JOURNAL_REVERSAL");
      expect(reversals).toHaveLength(originals.length);
      expect(reversals.every((e) => e.status === "POSTED")).toBe(true);
      expect(after.receivables.length).toBeGreaterThan(0);
      expect(after.receivables.every((r) => r.status === "CANCELLED")).toBe(true);
      expect(after.payments.find((p) => p.amountMinor === G && p.direction === "IN")?.status).toBe("VOIDED");
      const totals = await ledgerTotals(s);
      expect(totals.debit).toBe(totals.credit);

      // F5: managers hear about it like any other cancelled application.
      const notices = await s.t.run(async (ctx) =>
        (await ctx.db.query("notifications").collect()).filter(
          (n) => n.userId === s.manager.userId && n.type === "application.cancelled"
        )
      );
      expect(notices).toHaveLength(1);
    }
  );

  test("a replay of the closing step with the same key writes nothing new", async () => {
    const { s, applicationId } = await paidDeal("replay");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    const args = finishArgs(s, unwindId);
    const first = await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, args);
    const settled = await moneyState(s, applicationId, unwindId);
    expect(await s.owner.as.mutation(api.dealUnwind.finishDealUnwind, args)).toEqual(first);
    expect(await moneyState(s, applicationId, unwindId)).toEqual(settled);
  });
});

describe("SCRUM-693 ruling B - a refusal in the closing step leaves every row as it was", () => {
  /**
   * Each blocker is a closed-deal teardown refusal `start` does not check,
   * created AFTER the unwind started - the window the old four-step flow left
   * open with the receipt already reversed.
   */
  const BLOCKERS = [
    {
      name: "the supplier payable is PAID",
      message: /supplier payable has been paid/,
      async apply(s: Seeded, saleId: Id<"sales">) {
        const now = Date.now();
        const id = await s.t.run((ctx) =>
          ctx.db.insert("vehicleSupplierPayables", {
            orgId: s.orgId, vehicleId: s.vehicleId, saleId, sourcedFromName: "Amman Importer Co", amountDue: 9_000,
            currency: "JOD", status: "PAID", createdBy: s.owner.userId, createdAt: now, updatedAt: now,
          })
        );
        return () => s.t.run((ctx) => ctx.db.delete(id));
      },
    },
    {
      name: "the trade-in has been resold",
      message: /trade-in vehicle has already been resold/,
      async apply(s: Seeded, saleId: Id<"sales">) {
        const tradeIn = await s.t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId: s.orgId, vin: "VIN693TRADE", make: "Kia", model: "Rio", year: 2018, mileage: 90_000,
            color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 4_000, status: "SOLD",
            sourceType: "STOCK", purchasePrice: 3_000,
          })
        );
        await s.t.run((ctx) => ctx.db.patch(saleId, { tradeInVehicleId: tradeIn, tradeInValue: 3_000 }));
        return () => s.t.run((ctx) => ctx.db.patch(saleId, { tradeInVehicleId: undefined, tradeInValue: undefined }));
      },
    },
    {
      name: "the trade-in is reserved",
      message: /trade-in vehicle is currently reserved/,
      async apply(s: Seeded, saleId: Id<"sales">) {
        const tradeIn = await s.t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId: s.orgId, vin: "VIN693TRADE", make: "Kia", model: "Rio", year: 2018, mileage: 90_000,
            color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 4_000, status: "RESERVED",
            sourceType: "STOCK", purchasePrice: 3_000,
          })
        );
        await s.t.run((ctx) => ctx.db.patch(saleId, { tradeInVehicleId: tradeIn, tradeInValue: 3_000 }));
        return () => s.t.run((ctx) => ctx.db.patch(saleId, { tradeInVehicleId: undefined, tradeInValue: undefined }));
      },
    },
    {
      name: "a legacy receivable is linked to the sale",
      message: /./,
      async apply(s: Seeded, saleId: Id<"sales">) {
        const now = Date.now();
        const id = await s.t.run((ctx) =>
          ctx.db.insert("receivables", {
            orgId: s.orgId, customerId: s.customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
            title: "Legacy", originalAmount: 100, outstandingAmount: 100, dueDate: now + 86_400_000,
            status: "OPEN", createdBy: s.owner.userId, createdAt: now, updatedAt: now,
          })
        );
        return () => s.t.run((ctx) => ctx.db.delete(id));
      },
    },
  ];

  test.each(BLOCKERS)("$name: refused, nothing moves, and clearing the blocker lets it finish", async (blocker) => {
    const { s, applicationId } = await paidDeal(`rb_${blocker.name.length}_${blocker.message.source.length}`);
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    const saleId = (await s.t.run((ctx) => ctx.db.get(applicationId)))!.finalizedSaleId!;
    const clear = await blocker.apply(s, saleId);

    const before = await moneyState(s, applicationId, unwindId);
    const refusal = await refusalMessageOf(finish(s, unwindId));
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(blocker.message);
    expect(Object.values(DEAL_UNWIND_MESSAGES)).not.toContain(refusal);
    expect(await moneyState(s, applicationId, unwindId)).toEqual(before);
    expect(before.app.disbursedAt).toBeDefined();
    expect(before.unwind).toEqual({ status: "ACTIVE", refunded: false, completed: false });
    expect(await receiptProof(s, applicationId)).toBeNull();

    // Control: the same call succeeds once the blocker is gone.
    await clear();
    await finish(s, unwindId);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("after a refused close the unwind can still be abandoned, and the still-paid deal keeps pointing at it", async () => {
    const { s, applicationId } = await paidDeal("rb_abandon");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    const saleId = (await s.t.run((ctx) => ctx.db.get(applicationId)))!.finalizedSaleId!;
    await BLOCKERS[0].apply(s, saleId);
    expect(await refusalMessageOf(finish(s, unwindId))).toMatch(BLOCKERS[0].message);

    await abandon(s, unwindId);
    expect((await s.t.run((ctx) => ctx.db.get(unwindId)))?.status).toBe("ABANDONED");
    expect(await refusalMessageOf(bareCancel(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_CANCEL_USE_UNWIND);
    expect((await receiptEvents(s)).some((e) => e.status === "POSTED")).toBe(true);
  });
});

describe("SCRUM-693 - the steps run in order and only once", () => {
  test("the closing step is refused until the forward return is recorded; nothing is written", async () => {
    const { s, applicationId } = await paidDeal("order1");
    const unwindId = await start(s, applicationId);
    const before = await moneyState(s, applicationId, unwindId);
    expect(await refusalMessageOf(finish(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_FORWARD_FIRST);
    expect(await moneyState(s, applicationId, unwindId)).toEqual(before);
  });

  test("a second start while one is active is refused; a replay of the same key returns the same unwind", async () => {
    const { s, applicationId } = await paidDeal("order3");
    const key = crypto.randomUUID();
    const first = await start(s, applicationId, key);
    expect(await start(s, applicationId, key)).toEqual(first);
    expect(await refusalMessageOf(start(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ALREADY_ACTIVE);
    expect(await s.t.run((ctx) => ctx.db.query("dealUnwinds").collect())).toHaveLength(1);
  });

  test("a recorded step is not recorded twice, and a completed unwind accepts no further step", async () => {
    const { s, applicationId } = await paidDeal("order4");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    expect(await refusalMessageOf(forwardReturn(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_STEP_DONE);
    await finish(s, unwindId);
    expect(await refusalMessageOf(finish(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_ACTIVE);
    expect(await refusalMessageOf(abandon(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_ACTIVE);
  });

  test("an abandoned unwind accepts no further step", async () => {
    const { s, applicationId } = await paidDeal("order5");
    const unwindId = await start(s, applicationId);
    await abandon(s, unwindId);
    expect(await refusalMessageOf(forwardReturn(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_ACTIVE);
    expect(await refusalMessageOf(finish(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_ACTIVE);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("closing needs the deal-cancel authority as well as the refund authority", async () => {
    const { s, applicationId } = await paidDeal("perm_finish");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    const before = await moneyState(s, applicationId, unwindId);
    expect(await refusalMessageOf(finish(s, unwindId, "BANK_TRANSFER", s.cashier.as))).not.toBeNull();
    expect(await moneyState(s, applicationId, unwindId)).toEqual(before);
  });
});

describe("SCRUM-693 - the refund goes back by the rail it came in on, and posts in an OPEN period", () => {
  test("a cash refund of a bank-transfer receipt is refused and nothing moves", async () => {
    const { s, applicationId } = await paidDeal("rail");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    const before = await moneyState(s, applicationId, unwindId);
    expect(await refusalMessageOf(finish(s, unwindId, "CASH"))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_REFUND_METHOD_MISMATCH);
    expect(await moneyState(s, applicationId, unwindId)).toEqual(before);
  });

  test("cash without the recipient's acknowledgement is refused", async () => {
    const { s, applicationId } = await paidDeal("ack", "CASH");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.dealUnwind.finishDealUnwind, {
          ...finishArgs(s, unwindId, "CASH"), recipientAcknowledged: false,
        })
      )
    ).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_EVIDENCE_REQUIRED);
  });

  test("D4: a CLOSING period refuses the refund, which posting rules alone would let through", async () => {
    const { s, applicationId } = await paidDeal("closing");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    await s.t.run(async (ctx) => {
      const period = (await ctx.db.query("accountingPeriods").collect()).find((p) => p.orgId === s.orgId)!;
      await ctx.db.patch(period._id, { status: "CLOSING" });
    });
    const before = await moneyState(s, applicationId, unwindId);
    expect(await refusalMessageOf(finish(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_PERIOD_NOT_OPEN);
    expect(await moneyState(s, applicationId, unwindId)).toEqual(before);
  });
});

describe("SCRUM-693 - the receipt reversal is proven POSTED, not merely queued", () => {
  test("a receipt that was never posted and is not queued proves NOT_POSTED", async () => {
    const s = await seed("np");
    const { applicationId } = await readyDeal(s);
    expect(await receiptProof(s, applicationId)).toBe("NOT_POSTED");
  });

  test("a live receipt is not proof of anything", async () => {
    const { s, applicationId } = await paidDeal("live");
    expect((await receiptEvents(s)).some((e) => e.status === "POSTED")).toBe(true);
    expect(await receiptProof(s, applicationId)).toBeNull();
  });

  test("a reversal that is not POSTED fails the strong proof", async () => {
    const { s, applicationId } = await paidDeal("strong");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    await finish(s, unwindId);
    expect(await receiptProof(s, applicationId)).toBe("REVERSED");
    await s.t.run(async (ctx) => {
      const original = (await ctx.db.query("accountingEvents").collect()).find(
        (e) => e.orgId === s.orgId && e.eventType === "FINANCE_CASH_RECEIVED" && e.status === "REVERSED"
      )!;
      await ctx.db.patch(original.reversedByEventId!, { status: "PENDING" });
    });
    expect(await receiptProof(s, applicationId)).toBeNull();
  });
});

describe("SCRUM-693 - start refuses what it cannot unwind", () => {
  test("a deal whose company payment is not yet received", async () => {
    const s = await seed("unpaid");
    const { applicationId } = await readyDeal(s);
    await finalizeAsOwner(s, applicationId);
    expect(await refusalMessageOf(start(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_ELIGIBLE);
  });

  test("D1: a deal whose commission is already paid", async () => {
    const { s, applicationId } = await paidDeal("comm");
    await s.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      await ctx.db.patch(app!.finalizedSaleId!, { commissionPaidAt: Date.now() });
    });
    expect(await refusalMessageOf(start(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_COMMISSION_PAID);
  });

  test("another organization's deal answers as not found", async () => {
    const { s, applicationId } = await paidDeal("tenant");
    const foreignOrgId = await s.t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() });
      await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
      const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [...ALL_PERMS], isSystemOwnerRole: true });
      await ctx.db.insert("memberships", { orgId, userId: s.owner.userId, roleId });
      return orgId;
    });
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.dealUnwind.startDealUnwind, {
          orgId: foreignOrgId, applicationId, reason: "x", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_FOUND);
  });

  test("a user without cancel and disbursement authority is refused", async () => {
    const { s, applicationId } = await paidDeal("perm");
    expect(await refusalMessageOf(start(s, applicationId, crypto.randomUUID(), s.sales.as))).not.toBeNull();
    expect(await s.t.run((ctx) => ctx.db.query("dealUnwinds").collect())).toHaveLength(0);
  });
});

describe("SCRUM-693-F2 - a bare cancel points only where the deal can actually go", () => {
  test("a bank-transfer paid deal points at the unwind", async () => {
    const { s, applicationId } = await paidDeal("bare");
    expect(await refusalMessageOf(bareCancel(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_CANCEL_USE_UNWIND);
  });

  // Each record start refuses must not be told to use the unwind.
  const NOT_UNWINDABLE = [
    {
      name: "the deal expects a cheque",
      startRefusal: DEAL_UNWIND_MESSAGES.DEAL_UNWIND_CHEQUE_DEAL,
      apply: (s: Seeded, applicationId: Id<"financeApplications">) =>
        s.t.run((ctx) => ctx.db.patch(applicationId, { expectedPaymentMethod: "CHEQUE" })),
    },
    {
      name: "the receipt was recorded as a cheque",
      startRefusal: DEAL_UNWIND_MESSAGES.DEAL_UNWIND_CHEQUE_DEAL,
      apply: (s: Seeded) =>
        s.t.run(async (ctx) => {
          const payment = (await ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
            .find((p) => p.amountMinor === G && p.direction === "IN")!;
          await ctx.db.patch(payment._id, { method: "CHEQUE" });
        }),
    },
    {
      name: "the recorded receipt is no longer settled",
      startRefusal: DEAL_UNWIND_MESSAGES.DEAL_UNWIND_CHAIN_MISMATCH,
      apply: (s: Seeded) =>
        s.t.run(async (ctx) => {
          const payment = (await ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
            .find((p) => p.amountMinor === G && p.direction === "IN")!;
          await ctx.db.patch(payment._id, { status: "VOIDED" });
        }),
    },
  ];

  test.each(NOT_UNWINDABLE)("$name: cancel keeps the manual-correction refusal, and start agrees", async (row) => {
    const { s, applicationId } = await paidDeal(`f2_${row.name.length}`);
    await row.apply(s, applicationId);
    const cancelRefusal = await refusalMessageOf(bareCancel(s, applicationId));
    expect(cancelRefusal).toMatch(MANUAL_CORRECTION);
    expect(cancelRefusal).not.toBe(DEAL_UNWIND_MESSAGES.DEAL_CANCEL_USE_UNWIND);
    expect(await refusalMessageOf(start(s, applicationId))).toBe(row.startRefusal);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });
});

describe("SCRUM-693 - nothing else moves the deal's money around an active unwind", () => {
  test("cancel and the forward's own return button are refused while the unwind is active", async () => {
    const { s, applicationId } = await paidDeal("guard");
    await start(s, applicationId);
    expect(await refusalMessageOf(bareCancel(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ACTIVE);
    const forwardId = await s.t.run(async (ctx) => (await ctx.db.query("financeCompanyForwards").first())!._id);
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
          orgId: s.orgId, applicationId, forwardId, reason: "x", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ACTIVE);
  });

  test("abandoning after the forward return is allowed, and the still-paid deal keeps pointing at the unwind", async () => {
    const { s, applicationId } = await paidDeal("r1_control");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    await abandon(s, unwindId);
    expect((await s.t.run((ctx) => ctx.db.get(unwindId)))?.status).toBe("ABANDONED");
    expect(await refusalMessageOf(bareCancel(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_CANCEL_USE_UNWIND);
  });
});
