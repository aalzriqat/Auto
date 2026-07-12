import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ruleCollectionRefund } from "./accounting/postingRules";
import { SYSTEM_KEYS } from "./utils/defaultChart";

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
      creditSystemKey: "MISCELLANEOUS_INCOME",
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
      creditSystemKey: "MISCELLANEOUS_INCOME",
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

  test("return_cleared_cheque_rejects_invalid_bank_fee_minor_units", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "CHEQUE",
      title: "Cheque with invalid return fee",
      amount: 500,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "BAD-FEE-1",
      chequeDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
      amount: 500,
    });
    await asFinance.mutation(api.collections.clearCheque, { orgId, chequeId });

    await expect(
      asFinance.mutation(api.collections.returnClearedCheque, {
        orgId,
        chequeId,
        bankFeeMinor: -1,
        idempotencyKey: "return-cleared-bad-fee",
      })
    ).rejects.toThrow(/non-negative integer/i);
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
      disbursementMethod: "CASH",
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
      expect(payments.some((payment) => payment.direction === "OUT" && payment.method === "CASH" && payment.amount === 200)).toBe(true);
      const refund = payments.find((payment) => payment.direction === "OUT" && payment.method === "CASH");
      expect(refund?.canonicalPaymentId).toBeTruthy();
      const canonicalRefund = refund?.canonicalPaymentId
        ? await ctx.db.get(refund.canonicalPaymentId)
        : null;
      expect(canonicalRefund?.direction).toBe("OUT");
      expect(canonicalRefund?.method).toBe("CASH");

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
      creditSystemKey: "MISCELLANEOUS_INCOME",
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

      // No chart of accounts in this suite, so RECEIVABLE_CREATED sat in the
      // outbox as PENDING rather than posting — cancelling the receivable
      // must cancel that pending post too, or it would post AR/income for a
      // receivable that no longer exists once the outbox next drains.
      const stillPending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `receivable_created_${receivableId}`)
        )
        .first();
      expect(stillPending).toBeNull();
    });
  });

  test("approved_cancel_reverses_a_posted_receivable_created_event", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    // Unlike the other tests in this file, this one needs an actual posted
    // GL entry (not just an outbox entry) to verify the reversal — so it
    // initializes a chart of accounts and opens a period first. The
    // "accounting" feature gate requires a paid plan.
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    await asFinance.mutation(api.chartOfAccounts.initialize, { orgId });
    await asFinance.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(2020, 0, 1),
      endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2025,
      periodNumber: 1,
    });
    const period = (await asFinance.query(api.accountingPeriods.list, { orgId }))[0];
    await asFinance.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cancelled installment (posted)",
      amount: 750,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const postedBefore = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "receivables").eq("sourceId", receivableId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "RECEIVABLE_CREATED"))
        .first()
    );
    expect(postedBefore?.status).toBe("POSTED");

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

      const original = await ctx.db.get(postedBefore!._id);
      expect(original?.status).toBe("REVERSED");
      expect(original?.reversedByEventId).toBeTruthy();

      const reversalEvent = await ctx.db.get(original!.reversedByEventId!);
      expect(reversalEvent?.status).toBe("POSTED");
      const reversalLines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", reversalEvent!.journalEntryId!))
        .collect();
      const originalLines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", original!.journalEntryId!))
        .collect();
      // The reversal must swap debit/credit for every original line so AR
      // and the credit account (Other Income here) both net back to zero.
      for (const originalLine of originalLines) {
        const matching = reversalLines.find((l) => l.accountId === originalLine.accountId);
        expect(matching?.debitMinor).toBe(originalLine.creditMinor);
        expect(matching?.creditMinor).toBe(originalLine.debitMinor);
      }
    });
  });

  test("approved_cancel_of_a_sale_linked_receivable_is_a_no_op_for_the_gl", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover, userId } = await seedFinanceMember(t);

    // A sale-linked receivable never posts its own RECEIVABLE_CREATED (the
    // sale's SALE_COMPLETED already recognized the AR) — cancelling it must
    // not error even though there is nothing to reverse or cancel.
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "SALELINKEDVEH0001", make: "Honda", model: "Civic", year: 2022,
        mileage: 5000, color: "White", fuelType: "Gasoline", transmission: "Automatic",
        sellingPrice: 10000, status: "SOLD", sourceType: "STOCK",
      })
    );
    const saleId = await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 10000, saleDate: Date.now(), status: "COMPLETED",
      })
    );

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      saleId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Sale-linked balance",
      amount: 400,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    const noEventPosted = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "receivables").eq("sourceId", receivableId.toString())
        )
        .first()
    );
    expect(noEventPosted).toBeNull();

    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Deal fell through",
    });

    await expect(
      asApprover.mutation(api.collections.respondToApproval, { orgId, requestId, status: "APPROVED" })
    ).resolves.not.toThrow();

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.status).toBe("CANCELLED");
    });
  });

  test("bank_refund_posts_gl_entry_to_bank_account_not_cash_on_hand", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Bank transfer installment",
      amount: 500,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 500,
      method: "BANK_TRANSFER",
      paymentDate: Date.now(),
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 500,
      disbursementMethod: "BANK_TRANSFER",
      reason: "Customer cancelled after bank payment",
    });

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const payments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", receivableId))
        .collect();
      const refund = payments.find((p) => p.direction === "OUT");
      expect(refund?.method).toBe("BANK_TRANSFER");

      // In tests there is no chart of accounts, so the event is durably
      // enqueued in pendingAccountingEvents (the outbox) rather than posted
      // directly. Verify the payload carries BANK_TRANSFER so that when the
      // outbox flushes, postingRules will credit the bank account — not cash.
      const pending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect();
      const refundEvent = pending.find((e) => e.eventType === "COLLECTION_REFUND");
      expect(refundEvent).toBeTruthy();
      expect((refundEvent?.payload as { paymentMethod?: string })?.paymentMethod).toBe("BANK_TRANSFER");

      const canonicalRefund = refund?.canonicalPaymentId
        ? await ctx.db.get(refund.canonicalPaymentId)
        : null;
      expect(canonicalRefund?.method).toBe("BANK_TRANSFER");
    });
  });

  test("cancel_of_partially_paid_receivable_is_blocked", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Paid installment",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 400,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Deal fell through after partial payment",
    });

    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Cannot cancel a receivable that has already received payments");
  });

  test("card_refund_routes_to_bank_account_not_cash_on_hand", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Card payment installment",
      amount: 300,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 300,
      method: "CARD",
      paymentDate: Date.now(),
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 300,
      disbursementMethod: "CARD",
      reason: "Customer requested card reversal",
    });

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const payments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", receivableId))
        .collect();
      const refund = payments.find((p) => p.direction === "OUT");
      expect(refund?.method).toBe("CARD");

      // CARD settlements clear via the bank account — the outbox event must
      // carry CARD so cashAccountKey() resolves to BANK_ACCOUNT, not CASH_ON_HAND.
      const pending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect();
      const refundEvent = pending.find((e) => e.eventType === "COLLECTION_REFUND");
      expect(refundEvent).toBeTruthy();
      expect((refundEvent?.payload as { paymentMethod?: string })?.paymentMethod).toBe("CARD");

      const canonicalRefund = refund?.canonicalPaymentId
        ? await ctx.db.get(refund.canonicalPaymentId)
        : null;
      expect(canonicalRefund?.method).toBe("CARD");
    });
  });

  test("cheque_refund_routes_to_bank_account_not_cheques_in_hand", async () => {
    // Unit-level assertion: the posting rule must credit BANK_ACCOUNT for
    // outbound cheque refunds, not CHEQUES_IN_HAND (which is for held customer cheques).
    const result = ruleCollectionRefund({
      paymentId: "test-payment",
      amountMinor: 50000,
      currency: "JOD",
      customerId: "cust-1" as any,
      paymentMethod: "CHEQUE",
    });
    const creditLine = result.lines.find((l) => l.creditMinor > 0 && l.debitMinor === 0);
    expect(creditLine?.accountSystemKey).toBe(SYSTEM_KEYS.BANK_ACCOUNT);
    expect(creditLine?.accountSystemKey).not.toBe(SYSTEM_KEYS.CHEQUES_IN_HAND);
  });

  test("cheque_refund_approval_posts_cheque_method_to_event_outbox", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cheque refund installment",
      amount: 600,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 600,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 600,
      disbursementMethod: "CHEQUE",
      reason: "Refund by dealership cheque",
    });

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const payments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", receivableId))
        .collect();
      const refund = payments.find((p) => p.direction === "OUT");
      expect(refund?.method).toBe("CHEQUE");

      // The outbox event must carry CHEQUE so that when postingRules flush
      // they call refundDisbursementAccountKey and credit BANK_ACCOUNT.
      const pending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect();
      const refundEvent = pending.find((e) => e.eventType === "COLLECTION_REFUND");
      expect(refundEvent).toBeTruthy();
      expect((refundEvent?.payload as { paymentMethod?: string })?.paymentMethod).toBe("CHEQUE");
    });
  });

  test("cancel_of_receivable_with_held_cheque_is_blocked", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cheque-linked installment",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Test Bank",
      chequeNumber: "CHQ-999",
      chequeDate: Date.now() + 86_400_000,
      amount: 1000,
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Customer cancelled but cheque still held",
    });

    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Cannot cancel a receivable with an active cheque");
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
      creditSystemKey: "MISCELLANEOUS_INCOME",
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
