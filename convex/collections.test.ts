import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

async function seedFinanceMember(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Collections Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "collections_user",
      email: "collections@example.com",
      name: "Collections User",
    })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "collections_approver",
      email: "collections.approver@example.com",
      name: "Collections Approver",
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
    ctx.db.insert("customers", {
      orgId,
      firstName: "Layla",
      lastName: "Nasser",
      phone: "+962790000000",
    })
  );

  return {
    orgId,
    userId,
    approverId,
    customerId,
    asFinance: t.withIdentity({ subject: "collections_user", clerkId: "collections_user" }),
    asApprover: t.withIdentity({ subject: "collections_approver", clerkId: "collections_approver" }),
  };
}

describe("Collections", () => {
  test("partial_payment_reduces_outstanding_and_records_ledger_entry", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment 1",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 300,
      method: "CASH",
      paymentDate: Date.now(),
    });

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.outstandingAmount).toBe(700);
      expect(receivable?.status).toBe("PARTIALLY_PAID");

      const payment = await ctx.db
        .query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", receivableId))
        .unique();
      expect(payment?.amount).toBe(300);
      expect(payment?.method).toBe("CASH");
      expect(payment?.canonicalPaymentId).toBeTruthy();
      expect(payment?.paymentAllocationId).toBeTruthy();

      const canonicalReceivable = receivable?.canonicalReceivableDocumentId
        ? await ctx.db.get(receivable.canonicalReceivableDocumentId)
        : null;
      expect(canonicalReceivable?.status).toBe("PARTIALLY_PAID");
      const canonicalPayment = payment?.canonicalPaymentId
        ? await ctx.db.get(payment.canonicalPaymentId)
        : null;
      expect(canonicalPayment?.method).toBe("CASH");
      expect(canonicalPayment?.amountMinor).toBe(300_000);
      const allocation = payment?.paymentAllocationId
        ? await ctx.db.get(payment.paymentAllocationId)
        : null;
      expect(allocation?.amountMinor).toBe(300_000);

      const transaction = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique();
      expect(transaction?.category).toBe("COLLECTION_PAYMENT");
      expect(transaction?.type).toBe("IN");
    });
  });

  test("cleared_cheque_pays_receivable_and_posts_cheque_payment", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "CHEQUE",
      title: "Post-dated cheque",
      amount: 500,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "12345",
      chequeDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
      amount: 500,
    });

    await asFinance.mutation(api.collections.clearCheque, { orgId, chequeId });

    await t.run(async (ctx) => {
      const cheque = await ctx.db.get(chequeId);
      expect(cheque?.status).toBe("CLEARED");

      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.outstandingAmount).toBe(0);
      expect(receivable?.status).toBe("PAID");

      const payment = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId))
        .unique();
      expect(payment?.method).toBe("CHEQUE");
      expect(payment?.status).toBe("POSTED");
      expect(payment?.canonicalPaymentId).toBeTruthy();
      expect(payment?.paymentAllocationId).toBeTruthy();
      const canonicalPayment = payment?.canonicalPaymentId
        ? await ctx.db.get(payment.canonicalPaymentId)
        : null;
      expect(canonicalPayment?.method).toBe("CHEQUE");
      const canonicalReceivable = receivable?.canonicalReceivableDocumentId
        ? await ctx.db.get(receivable.canonicalReceivableDocumentId)
        : null;
      expect(canonicalReceivable?.status).toBe("PAID");
    });

    await asFinance.mutation(api.collections.returnClearedCheque, {
      orgId,
      chequeId,
      idempotencyKey: "return-cleared-cheque-1",
    });

    await t.run(async (ctx) => {
      const cheque = await ctx.db.get(chequeId);
      expect(cheque?.status).toBe("RETURNED");

      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.outstandingAmount).toBe(500);

      const payment = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId))
        .unique();
      expect(payment?.status).toBe("VOIDED");

      const canonicalPayment = payment?.canonicalPaymentId
        ? await ctx.db.get(payment.canonicalPaymentId)
        : null;
      expect(canonicalPayment?.status).toBe("VOIDED");
      const allocation = payment?.paymentAllocationId
        ? await ctx.db.get(payment.paymentAllocationId)
        : null;
      expect(allocation?.status).toBe("REVERSED");
    });
  });

  test("approved_refund_posts_outbound_payment_and_reopens_balance", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "RESERVATION_PAYMENT",
      title: "Reservation payment",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 1000,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 200,
      reason: "Customer overpaid",
    });

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.outstandingAmount).toBe(200);
      expect(receivable?.status).toBe("PARTIALLY_PAID");

      const payments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", receivableId))
        .collect();
      expect(payments.some((payment) => payment.direction === "OUT" && payment.method === "REFUND" && payment.amount === 200)).toBe(true);
      const refund = payments.find((payment) => payment.direction === "OUT" && payment.method === "REFUND");
      expect(refund?.canonicalPaymentId).toBeTruthy();
      const canonicalRefund = refund?.canonicalPaymentId
        ? await ctx.db.get(refund.canonicalPaymentId)
        : null;
      expect(canonicalRefund?.direction).toBe("OUT");
      expect(canonicalRefund?.method).toBe("OTHER");

      const transactions = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      expect(transactions.some((tx) => tx.type === "OUT" && tx.category === "REFUND" && tx.amount === 200)).toBe(true);

      // The canonical receivable must reopen by exactly the refunded amount:
      // original allocations get reversed (not left ACTIVE), and the status
      // leaves PAID.
      expect(receivable?.canonicalReceivableDocumentId).toBeTruthy();
      const canonicalReceivable = receivable?.canonicalReceivableDocumentId
        ? await ctx.db.get(receivable.canonicalReceivableDocumentId)
        : null;
      expect(canonicalReceivable?.status).toBe("PARTIALLY_PAID");

      const allocations = receivable?.canonicalReceivableDocumentId
        ? await ctx.db
            .query("paymentAllocations")
            .withIndex("by_receivable", (q) =>
              q.eq("receivableDocumentId", receivable.canonicalReceivableDocumentId!)
            )
            .collect()
        : [];
      const activeMinor = allocations
        .filter((allocation) => allocation.status === "ACTIVE")
        .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      // 1000 collected − 200 refunded = 800 still applied
      expect(activeMinor).toBe(800_000);
      expect(allocations.some((allocation) => allocation.status === "REVERSED")).toBe(true);
    });
  });

  test("approved_cancel_marks_canonical_receivable_cancelled", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cancelled installment",
      amount: 600,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Deal fell through",
    });

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.status).toBe("CANCELLED");
      expect(receivable?.outstandingAmount).toBe(0);

      expect(receivable?.canonicalReceivableDocumentId).toBeTruthy();
      const canonicalReceivable = receivable?.canonicalReceivableDocumentId
        ? await ctx.db.get(receivable.canonicalReceivableDocumentId)
        : null;
      expect(canonicalReceivable?.status).toBe("CANCELLED");
    });
  });

  test("approved_reschedule_moves_overdue_receivable_to_new_due_date", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Late installment",
      amount: 400,
      dueDate: Date.now() - 24 * 60 * 60 * 1000,
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "RESCHEDULE",
      requestedDueDate: tomorrow,
      reason: "Customer requested a new payment date",
    });

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.dueDate).toBe(tomorrow);
      expect(receivable?.status).toBe("RESCHEDULED");

      expect(receivable?.canonicalReceivableDocumentId).toBeTruthy();
      const canonicalReceivable = receivable?.canonicalReceivableDocumentId
        ? await ctx.db.get(receivable.canonicalReceivableDocumentId)
        : null;
      expect(canonicalReceivable?.dueDate).toBe(tomorrow);
    });
  });
});
