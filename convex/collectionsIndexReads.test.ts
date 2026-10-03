/**
 * SCRUM-555 part 3 - `collections.ts` reads through indexes instead of query
 * field predicates. Only the READ MECHANISM changed: which rows are chosen, in
 * what order, and every refusal must be exactly what it was.
 *
 * These are characterization tests. They pass on the pre-image (query
 * `.filter(...)`) and on the post-image (index read + in-memory narrowing).
 *
 * Sites, by entrypoint:
 *   1. `reverseAllocationsForRefund`  (via `respondToApproval`, REFUND)
 *      - ACTIVE allocations only, newest first.
 *   2. `returnClearedCheque`
 *      - the POSTED collection payment of the cheque is the one voided.
 *   3/4. `respondToApproval` CANCEL_RECEIVABLE
 *      - refused while a HELD or DEPOSITED cheque of the same org points at the
 *        receivable; other statuses and other orgs' rows never block.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.*s");

type TestConvex = ReturnType<typeof convexTestWithComponents>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function seedFinance(t: TestConvex) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "IdxReads Collections Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "idx_collections_user",
      email: "idx.collections@example.com",
      name: "Idx Collections User",
    })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "idx_collections_approver",
      email: "idx.collections.approver@example.com",
      name: "Idx Collections Approver",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Manager",
      permissions: ["view:finance", "manage:finance", "approve:requests"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Idx", lastName: "Customer", phone: "+962790000001" })
  );
  return {
    orgId,
    userId,
    customerId,
    asFinance: t.withIdentity({ subject: "idx_collections_user", clerkId: "idx_collections_user" }),
    asApprover: t.withIdentity({ subject: "idx_collections_approver", clerkId: "idx_collections_approver" }),
  };
}

type Finance = Awaited<ReturnType<typeof seedFinance>>;

describe("reverseAllocationsForRefund - ACTIVE allocations, newest first", () => {
  test("a refund reverses only ACTIVE allocations, newest first, leaving earlier REVERSED rows untouched", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, customerId, asFinance, asApprover } = await seedFinance(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "RESERVATION_PAYMENT",
      title: "Idx refund order",
      amount: 1000,
      dueDate: Date.now() + WEEK_MS,
    });
    await asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 300,
      method: "CASH",
      paymentDate: Date.now(),
    });
    await asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 700,
      method: "CASH",
      paymentDate: Date.now(),
    });

    const canonicalId = await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      return receivable!.canonicalReceivableDocumentId!;
    });
    // Make "newest" unambiguous: createdAt can tie inside one millisecond.
    const seeded = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", canonicalId))
        .collect();
      const small = rows.find((r) => r.amountMinor === 300_000)!;
      const big = rows.find((r) => r.amountMinor === 700_000)!;
      await ctx.db.patch(small._id, { createdAt: 1_000 });
      await ctx.db.patch(big._id, { createdAt: 2_000 });
      return { smallId: small._id, bigId: big._id };
    });

    async function refund(amount: number) {
      const requestId = await asFinance.mutation(api.collections.requestApproval, {
        orgId,
        receivableId,
        requestType: "REFUND",
        requestedAmount: amount,
        disbursementMethod: "CASH",
        reason: `Idx refund ${amount}`,
      });
      await asApprover.mutation(api.collections.respondToApproval, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        requestId,
        status: "APPROVED",
      });
    }

    // Refund 1: reverses the NEWEST (700), re-allocates the 600 remainder.
    await refund(100);
    const afterFirst = await t.run(async (ctx) =>
      ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", canonicalId))
        .collect()
    );
    expect(afterFirst.find((r) => r._id === seeded.bigId)?.status).toBe("REVERSED");
    expect(afterFirst.find((r) => r._id === seeded.smallId)?.status).toBe("ACTIVE");
    // The reversal also leaves a REVERSED mirror row (same 700 amount, newest
    // createdAt) - exactly the kind of row the ACTIVE filter must skip.
    expect(afterFirst.filter((r) => r.status === "REVERSED").length).toBeGreaterThanOrEqual(2);
    const firstRemainder = afterFirst.find((r) => r.status === "ACTIVE" && r.amountMinor === 600_000);
    expect(firstRemainder).toBeDefined();

    // Refund 2: the REVERSED 700 row must be skipped; the 600 remainder (newest
    // ACTIVE) goes first, then the 300 row covers the last 50.
    await refund(650);
    const afterSecond = await t.run(async (ctx) =>
      ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", canonicalId))
        .collect()
    );
    const active = afterSecond.filter((r) => r.status === "ACTIVE");
    expect(active.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(250_000);
    expect(active).toHaveLength(1);
    expect(afterSecond.find((r) => r._id === seeded.smallId)?.status).toBe("REVERSED");
    expect(afterSecond.find((r) => r._id === seeded.bigId)?.status).toBe("REVERSED");
    expect(afterSecond.find((r) => r._id === firstRemainder!._id)?.status).toBe("REVERSED");

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.outstandingAmount).toBe(750);
    });
  });
});

describe("returnClearedCheque - the POSTED collection payment is the one acted on", () => {
  test("a non-POSTED payment on the same cheque, created first, is skipped and left untouched", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, customerId, userId, asFinance } = await seedFinance(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "CHEQUE",
      title: "Idx cleared cheque",
      amount: 500,
      dueDate: Date.now() + WEEK_MS,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "IDX-POSTED-1",
      chequeDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
      amount: 500,
    });

    // Inserted BEFORE the cheque clears, so it precedes the POSTED row in the
    // by_cheque index: a read that took the first row blindly would pick it.
    const strayPaymentId = await t.run((ctx) =>
      ctx.db.insert("collectionPayments", {
        orgId,
        receivableId,
        customerId,
        chequeId,
        direction: "IN",
        method: "CHEQUE",
        amount: 500,
        paymentDate: Date.now(),
        status: "VOIDED",
        cashierId: userId,
        createdAt: Date.now(),
      })
    );

    await asFinance.mutation(api.collections.clearCheque, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      chequeId,
    });
    await asFinance.mutation(api.collections.returnClearedCheque, {
      orgId,
      chequeId,
      idempotencyKey: "idx-return-cleared-1",
    });

    await t.run(async (ctx) => {
      const cheque = await ctx.db.get(chequeId);
      expect(cheque?.status).toBe("RETURNED");

      const payments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId))
        .collect();
      expect(payments).toHaveLength(2);
      const stray = payments.find((p) => p._id === strayPaymentId);
      expect(stray?.status).toBe("VOIDED");
      expect(stray?.voidedAt).toBeUndefined();
      const posted = payments.find((p) => p._id !== strayPaymentId);
      expect(posted?.status).toBe("VOIDED");
      expect(posted?.canonicalPaymentId).toBeTruthy();
      const canonicalPayment = await ctx.db.get(posted!.canonicalPaymentId!);
      expect(canonicalPayment?.status).toBe("VOIDED");
      const allocation = await ctx.db.get(posted!.paymentAllocationId!);
      expect(allocation?.status).toBe("REVERSED");

      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.outstandingAmount).toBe(500);
    });
  });
});

describe("CANCEL_RECEIVABLE - active cheque gate (HELD / DEPOSITED, same org)", () => {
  const ACTIVE_CHEQUE_REFUSAL = /Cannot cancel a receivable with an active cheque/;

  async function seedReceivable(f: Finance, title: string) {
    return await f.asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId: f.orgId,
      customerId: f.customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title,
      amount: 600,
      dueDate: Date.now() + WEEK_MS,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
  }

  async function insertCheque(
    t: TestConvex,
    f: Finance,
    args: {
      receivableId: Id<"receivables">;
      status: "HELD" | "DEPOSITED" | "CLEARED" | "RETURNED" | "REPLACED" | "CANCELLED";
      orgId?: Id<"organizations">;
      chequeNumber: string;
    }
  ) {
    const now = Date.now();
    return await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId: args.orgId ?? f.orgId,
        receivableId: args.receivableId,
        customerId: f.customerId,
        bank: "Arab Bank",
        chequeNumber: args.chequeNumber,
        chequeDate: now + WEEK_MS,
        amount: 600,
        status: args.status,
        createdBy: f.userId,
        createdAt: now,
        updatedAt: now,
      })
    );
  }

  async function requestCancel(f: Finance, receivableId: Id<"receivables">) {
    return await f.asFinance.mutation(api.collections.requestApproval, {
      orgId: f.orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Idx cancel",
    });
  }

  async function approve(f: Finance, requestId: Id<"collectionApprovalRequests">) {
    return await f.asApprover.mutation(api.collections.respondToApproval, {
      idempotencyKey: crypto.randomUUID(),
      orgId: f.orgId,
      requestId,
      status: "APPROVED",
    });
  }

  async function statusOf(t: TestConvex, receivableId: Id<"receivables">) {
    return await t.run(async (ctx) => (await ctx.db.get(receivableId))?.status);
  }

  test("a HELD cheque blocks the cancel and nothing is written", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const f = await seedFinance(t);
    const receivableId = await seedReceivable(f, "Idx held");
    await insertCheque(t, f, { receivableId, status: "HELD", chequeNumber: "IDX-H-1" });

    const requestId = await requestCancel(f, receivableId);
    await expect(approve(f, requestId)).rejects.toThrow(ACTIVE_CHEQUE_REFUSAL);

    expect(await statusOf(t, receivableId)).toBe("OPEN");
    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("PENDING");
  });

  test("a DEPOSITED cheque (no HELD one) blocks the cancel", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const f = await seedFinance(t);
    const receivableId = await seedReceivable(f, "Idx deposited");
    await insertCheque(t, f, { receivableId, status: "DEPOSITED", chequeNumber: "IDX-D-1" });

    const requestId = await requestCancel(f, receivableId);
    await expect(approve(f, requestId)).rejects.toThrow(ACTIVE_CHEQUE_REFUSAL);
    expect(await statusOf(t, receivableId)).toBe("OPEN");
  });

  test("a HELD and a DEPOSITED cheque together still refuse with the same message", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const f = await seedFinance(t);
    const receivableId = await seedReceivable(f, "Idx both");
    await insertCheque(t, f, { receivableId, status: "DEPOSITED", chequeNumber: "IDX-B-1" });
    await insertCheque(t, f, { receivableId, status: "HELD", chequeNumber: "IDX-B-2" });

    const requestId = await requestCancel(f, receivableId);
    await expect(approve(f, requestId)).rejects.toThrow(ACTIVE_CHEQUE_REFUSAL);
    expect(await statusOf(t, receivableId)).toBe("OPEN");
  });

  test("CLEARED / RETURNED / REPLACED / CANCELLED cheques do not block the cancel", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const f = await seedFinance(t);
    const receivableId = await seedReceivable(f, "Idx inactive cheques");
    await insertCheque(t, f, { receivableId, status: "CLEARED", chequeNumber: "IDX-I-1" });
    await insertCheque(t, f, { receivableId, status: "RETURNED", chequeNumber: "IDX-I-2" });
    await insertCheque(t, f, { receivableId, status: "REPLACED", chequeNumber: "IDX-I-3" });
    await insertCheque(t, f, { receivableId, status: "CANCELLED", chequeNumber: "IDX-I-4" });

    const requestId = await requestCancel(f, receivableId);
    await approve(f, requestId);
    expect(await statusOf(t, receivableId)).toBe("CANCELLED");
  });

  test("a HELD cheque on a DIFFERENT receivable does not block", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const f = await seedFinance(t);
    const receivableId = await seedReceivable(f, "Idx target");
    const otherReceivableId = await seedReceivable(f, "Idx other receivable");
    await insertCheque(t, f, { receivableId: otherReceivableId, status: "HELD", chequeNumber: "IDX-R-1" });
    await insertCheque(t, f, { receivableId: otherReceivableId, status: "DEPOSITED", chequeNumber: "IDX-R-2" });

    const requestId = await requestCancel(f, receivableId);
    await approve(f, requestId);
    expect(await statusOf(t, receivableId)).toBe("CANCELLED");
    expect(await statusOf(t, otherReceivableId)).toBe("OPEN");
  });

  test("another org's HELD / DEPOSITED cheque carrying this receivableId does not block (tenant scope)", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const f = await seedFinance(t);
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "IdxReads Other Dealer", createdAt: Date.now() })
    );
    const receivableId = await seedReceivable(f, "Idx tenant");
    // Constructed directly: schema does not tie a cheque's orgId to its
    // receivable's, so a cross-org row can exist and must stay invisible here.
    await insertCheque(t, f, { receivableId, status: "HELD", orgId: otherOrgId, chequeNumber: "IDX-T-1" });
    await insertCheque(t, f, { receivableId, status: "DEPOSITED", orgId: otherOrgId, chequeNumber: "IDX-T-2" });

    const requestId = await requestCancel(f, receivableId);
    await approve(f, requestId);
    expect(await statusOf(t, receivableId)).toBe("CANCELLED");
  });
});
