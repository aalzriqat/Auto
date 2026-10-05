/**
 * SCRUM-693 - unwinding a paid finance deal from the deal page.
 *
 * The #pntr shape on the SCRUM-435 worked example: G = 12,500 approved and
 * transferred by the finance company, H + C = 1,575 forwarded back to it.
 * Unwind = the company returns the forward, the dealership refunds the full
 * remittance by the same rail, and only then does the deal cancel.
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
const FORWARD = H + C;

async function seed(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S693", vinPrefix: "VIN693",
    actors: { sales: SALES_PERMS },
  });
  return { ...s, sales: s.actors.sales };
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
const refund = (
  s: Seeded,
  unwindId: Id<"dealUnwinds">,
  method: "BANK_TRANSFER" | "CASH" = "BANK_TRANSFER"
) =>
  s.owner.as.mutation(api.dealUnwind.recordDealUnwindRemittanceRefund, {
    orgId: s.orgId, unwindId, method, refundedAt: Date.now(),
    ...(method === "BANK_TRANSFER"
      ? { bankReference: "TRF-998" }
      : { voucherNumber: "PV-12", recipientAcknowledged: true }),
    idempotencyKey: crypto.randomUUID(),
  });
const finish = (s: Seeded, unwindId: Id<"dealUnwinds">) =>
  s.owner.as.mutation(api.dealUnwind.finishDealUnwind, {
    orgId: s.orgId, unwindId, creditNoteReference: "CN-77", vehicleReturnedAt: Date.now(),
    vehicleReturnNote: "Returned to the lot.", customerPaymentDisposition: "REFUND", idempotencyKey: crypto.randomUUID(),
  });

const receiptProof = (s: Seeded, applicationId: Id<"financeApplications">, disbursementVersion = 1) =>
  s.t.run((ctx) => isFinanceCashReceivedReversalPosted(ctx, { orgId: s.orgId, applicationId, disbursementVersion }));
const receiptEvents = (s: Seeded) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === "FINANCE_CASH_RECEIVED"
    )
  );

describe("SCRUM-693 - the full unwind of a #pntr-shaped deal", () => {
  test.each(["BANK_TRANSFER", "CASH"] as const)(
    "%s: start -> forward returned -> remittance refunded -> finished: the deal is CANCELLED and every leg is POSTED",
    async (method) => {
      const { s, applicationId } = await paidDeal(`happy_${method}`, method);
      const unwindId = await start(s, applicationId);

      const unwind = await s.t.run((ctx) => ctx.db.get(unwindId));
      expect(unwind).toMatchObject({ status: "ACTIVE", remittanceMinor: G, remittanceMethod: method, forwardDueMinor: FORWARD });

      await forwardReturn(s, unwindId);
      const proof = await s.t.run(async (ctx) => deriveForwardState(ctx, (await ctx.db.get(applicationId))!));
      expect(proof.versions.some((row) => row.state === "RETURNED")).toBe(true);

      const result = await refund(s, unwindId, method);
      expect(result.receiptReversal).toBe("REVERSED");
      const app = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(app?.disbursedAt).toBeUndefined();
      expect(app?.disbursedAmountMinor).toBeUndefined();
      expect(app?.disbursementVersion).toBe(2);
      expect(await receiptProof(s, applicationId)).toBe("REVERSED");

      await finish(s, unwindId);
      expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
      const done = await s.t.run((ctx) => ctx.db.get(unwindId));
      expect(done?.status).toBe("COMPLETED");
      expect(done?.remittanceRefund).toMatchObject({ method, amountMinor: G, receiptReversal: "REVERSED" });

      const payments = await s.t.run((ctx) =>
        ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
      );
      const companyPayment = payments.find((p) => p.amountMinor === G && p.direction === "IN");
      expect(companyPayment?.status).toBe("VOIDED");
    }
  );
});

describe("SCRUM-693 - the steps run in order and only once", () => {
  test("the refund is refused until the forward return is recorded; nothing is written", async () => {
    const { s, applicationId } = await paidDeal("order1");
    const unwindId = await start(s, applicationId);
    expect(await refusalMessageOf(refund(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_FORWARD_FIRST);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.disbursedAt).toBeDefined();
    expect(await receiptProof(s, applicationId)).toBeNull();
  });

  test("finish is refused before the refund", async () => {
    const { s, applicationId } = await paidDeal("order2");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    expect(await refusalMessageOf(finish(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_REFUND_FIRST);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("a second start while one is active is refused; a replay of the same key returns the same unwind", async () => {
    const { s, applicationId } = await paidDeal("order3");
    const key = crypto.randomUUID();
    const first = await start(s, applicationId, key);
    expect(await start(s, applicationId, key)).toEqual(first);
    expect(await refusalMessageOf(start(s, applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ALREADY_ACTIVE);
    expect(await s.t.run((ctx) => ctx.db.query("dealUnwinds").collect())).toHaveLength(1);
  });

  test("a recorded step is not recorded twice", async () => {
    const { s, applicationId } = await paidDeal("order4");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    expect(await refusalMessageOf(forwardReturn(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_STEP_DONE);
  });

  test("an abandoned unwind accepts no further step", async () => {
    const { s, applicationId } = await paidDeal("order5");
    const unwindId = await start(s, applicationId);
    await s.owner.as.mutation(api.dealUnwind.abandonDealUnwind, {
      orgId: s.orgId, unwindId, reason: "Customer kept the car.", idempotencyKey: crypto.randomUUID(),
    });
    expect(await refusalMessageOf(forwardReturn(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_ACTIVE);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });
});

describe("SCRUM-693 - the refund goes back by the rail it came in on, and posts in an OPEN period", () => {
  test("a cash refund of a bank-transfer receipt is refused and nothing moves", async () => {
    const { s, applicationId } = await paidDeal("rail");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    expect(await refusalMessageOf(refund(s, unwindId, "CASH"))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_REFUND_METHOD_MISMATCH);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.disbursedAt).toBeDefined();
  });

  test("cash without the recipient's acknowledgement is refused", async () => {
    const { s, applicationId } = await paidDeal("ack", "CASH");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.dealUnwind.recordDealUnwindRemittanceRefund, {
          orgId: s.orgId, unwindId, method: "CASH", refundedAt: Date.now(), voucherNumber: "PV-1",
          recipientAcknowledged: false, idempotencyKey: crypto.randomUUID(),
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
    expect(await refusalMessageOf(refund(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_PERIOD_NOT_OPEN);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.disbursedAt).toBeDefined();
    expect(await receiptProof(s, applicationId)).toBeNull();
  });
});

describe("SCRUM-693 - the receipt reversal is proven POSTED, not merely queued", () => {
  test("a reversal that is not POSTED fails the strong proof, and finish refuses on it", async () => {
    const { s, applicationId } = await paidDeal("strong");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    await refund(s, unwindId);
    expect(await receiptProof(s, applicationId)).toBe("REVERSED");

    // Degrade the reversal the books carry to a PENDING one.
    await s.t.run(async (ctx) => {
      const original = (await ctx.db.query("accountingEvents").collect()).find(
        (e) => e.orgId === s.orgId && e.eventType === "FINANCE_CASH_RECEIVED" && e.status === "REVERSED"
      )!;
      await ctx.db.patch(original.reversedByEventId!, { status: "PENDING" });
    });
    expect(await receiptProof(s, applicationId)).toBeNull();
    expect(await refusalMessageOf(finish(s, unwindId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_REVERSAL_UNPROVEN);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

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

describe("SCRUM-693 - nothing else moves the deal's money around an active unwind", () => {
  test("a bare cancel of a paid deal points at the unwind", async () => {
    const { s, applicationId } = await paidDeal("bare");
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.applications.cancelApplication, {
          orgId: s.orgId, applicationId, reason: "x", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toBe(DEAL_UNWIND_MESSAGES.DEAL_CANCEL_USE_UNWIND);
  });

  test("cancel and the forward's own return button are refused while the unwind is active", async () => {
    const { s, applicationId } = await paidDeal("guard");
    await start(s, applicationId);
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.applications.cancelApplication, {
          orgId: s.orgId, applicationId, reason: "x", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ACTIVE);
    const forwardId = await s.t.run(async (ctx) => (await ctx.db.query("financeCompanyForwards").first())!._id);
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
          orgId: s.orgId, applicationId, forwardId, reason: "x", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ACTIVE);
  });

  // SCRUM-693-R1 (Codex): the refund clears `disbursedAt`, so an abandoned
  // refunded unwind would leave nothing between a bare cancel and a CANCELLED
  // deal without the credit note, vehicle return or customer disposition.
  test.each(["BANK_TRANSFER", "CASH"] as const)(
    "%s: once the remittance is refunded the unwind cannot be abandoned, so a bare cancel cannot skip its evidence",
    async (method) => {
      const { s, applicationId } = await paidDeal(`r1_${method}`, method);
      const unwindId = await start(s, applicationId);
      await forwardReturn(s, unwindId);
      await refund(s, unwindId, method);
      const abandonRefusal = await refusalMessageOf(
        s.owner.as.mutation(api.dealUnwind.abandonDealUnwind, {
          orgId: s.orgId, unwindId, reason: "Changed our mind.", idempotencyKey: crypto.randomUUID(),
        })
      );
      const cancelRefusal = await refusalMessageOf(
        s.owner.as.mutation(api.applications.cancelApplication, {
          orgId: s.orgId, applicationId, reason: "x", idempotencyKey: crypto.randomUUID(),
        })
      );
      expect({ abandonRefusal, cancelRefusal }).toEqual({
        abandonRefusal: DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ABANDON_AFTER_REFUND,
        cancelRefusal: DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ACTIVE,
      });
      expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
      expect((await s.t.run((ctx) => ctx.db.get(unwindId)))?.status).toBe("ACTIVE");
    }
  );

  test("control: abandoning after only the forward return is allowed, and the still-paid deal keeps pointing at the unwind", async () => {
    const { s, applicationId } = await paidDeal("r1_control");
    const unwindId = await start(s, applicationId);
    await forwardReturn(s, unwindId);
    await s.owner.as.mutation(api.dealUnwind.abandonDealUnwind, {
      orgId: s.orgId, unwindId, reason: "Customer kept the car.", idempotencyKey: crypto.randomUUID(),
    });
    expect((await s.t.run((ctx) => ctx.db.get(unwindId)))?.status).toBe("ABANDONED");
    expect(
      await refusalMessageOf(
        s.owner.as.mutation(api.applications.cancelApplication, {
          orgId: s.orgId, applicationId, reason: "x", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toBe(DEAL_UNWIND_MESSAGES.DEAL_CANCEL_USE_UNWIND);
  });
});
