import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { ruleCollectionRefund } from "./accounting/postingRules";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const paginationOpts = { numItems: 20, cursor: null };

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

async function seedVehicleQuoteSaleAndApplication(
  t: ReturnType<typeof convexTest>,
  args: {
    orgId: any;
    customerId: any;
    userId: any;
    vin?: string;
  }
) {
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: args.orgId,
      vin: args.vin ?? "COLLECTIONLINKS0001",
      make: "Toyota",
      model: "Corolla",
      year: 2024,
      mileage: 1200,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 18000,
      status: "AVAILABLE",
      sourceType: "STOCK",
    })
  );
  const saleId = await t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: args.orgId,
      vehicleId,
      customerId: args.customerId,
      salespersonId: args.userId,
      salePrice: 18000,
      saleDate: Date.now(),
      status: "PENDING",
    })
  );
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: args.orgId,
      customerId: args.customerId,
      vehicleId,
      vehiclePrice: 18000,
      downPayment: 2000,
      termMonths: 36,
      status: "ACCEPTED",
      createdBy: args.userId,
      createdAt: Date.now(),
    })
  );
  const applicationId = await t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId: args.orgId,
      quoteId,
      customerId: args.customerId,
      vehicleId,
      salespersonId: args.userId,
      status: "APPROVED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );

  return { vehicleId, saleId, quoteId, applicationId };
}

async function insertReceivable(
  t: ReturnType<typeof convexTest>,
  args: {
    orgId: any;
    customerId: any;
    createdBy: any;
    title?: string;
    amount?: number;
    outstandingAmount?: number;
    dueDate?: number;
    status?: "OPEN" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "RESCHEDULED" | "CANCELLED" | "REFUNDED";
    sourceType?: "CUSTOMER_DEPOSIT" | "RESERVATION_PAYMENT" | "INTERNAL_INSTALLMENT" | "BANK_FINANCED_BALANCE" | "BANK_TRANSFER" | "PAYMENT_LINK" | "CHEQUE" | "OTHER";
    vehicleId?: any;
    saleId?: any;
    quoteId?: any;
    applicationId?: any;
    assignedTo?: any;
    isDeleted?: boolean;
  }
) {
  const now = Date.now();
  const originalAmount = args.amount ?? 100;
  return await t.run((ctx) =>
    ctx.db.insert("receivables", {
      orgId: args.orgId,
      customerId: args.customerId,
      vehicleId: args.vehicleId,
      saleId: args.saleId,
      quoteId: args.quoteId,
      applicationId: args.applicationId,
      assignedTo: args.assignedTo,
      sourceType: args.sourceType ?? "INTERNAL_INSTALLMENT",
      title: args.title ?? "Test receivable",
      originalAmount,
      outstandingAmount: args.outstandingAmount ?? originalAmount,
      dueDate: args.dueDate ?? now + 86_400_000,
      status: args.status ?? "OPEN",
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
      isDeleted: args.isDeleted,
    })
  );
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

  test("collection_queries_hydrate_reports_and_filter_settled_rows", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);
    const { vehicleId } = await seedVehicleQuoteSaleAndApplication(t, { orgId, customerId, userId, vin: "QUERYHYDRATE0001" });
    const now = Date.now();
    const dueToday = new Date(now);
    dueToday.setHours(23, 59, 59, 0);
    const dueTodayMs = dueToday.getTime();

    const todayReceivableId = await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      vehicleId,
      title: "Today balance",
      amount: 75,
      dueDate: dueTodayMs,
    });
    const overdueReceivableId = await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      title: "Aged balance",
      amount: 120,
      dueDate: now - 45 * 24 * 60 * 60 * 1000,
      status: "OVERDUE",
    });
    await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      title: "Settled balance",
      amount: 50,
      outstandingAmount: 0,
      dueDate: dueTodayMs,
      status: "PAID",
    });
    await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      title: "Deleted balance",
      amount: 30,
      dueDate: dueTodayMs,
      isDeleted: true,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("collectionPayments", {
        orgId,
        receivableId: todayReceivableId,
        customerId,
        vehicleId,
        direction: "IN",
        method: "CASH",
        amount: 25,
        paymentDate: now,
        status: "POSTED",
        cashierId: userId,
        createdAt: now,
      });
      await ctx.db.insert("collectionPayments", {
        orgId,
        receivableId: todayReceivableId,
        customerId,
        vehicleId,
        direction: "OUT",
        method: "REFUND",
        amount: 5,
        paymentDate: now,
        status: "POSTED",
        cashierId: userId,
        createdAt: now,
      });
      await ctx.db.insert("collectionPayments", {
        orgId,
        receivableId: todayReceivableId,
        customerId,
        direction: "IN",
        method: "CASH",
        amount: 999,
        paymentDate: now,
        status: "VOIDED",
        cashierId: userId,
        createdAt: now,
      });
      await ctx.db.insert("postDatedCheques", {
        orgId,
        receivableId: todayReceivableId,
        customerId,
        vehicleId,
        bank: "Report Bank",
        chequeNumber: "RPT-1",
        chequeDate: now + 24 * 60 * 60 * 1000,
        amount: 200,
        status: "HELD",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("postDatedCheques", {
        orgId,
        receivableId: overdueReceivableId,
        customerId,
        bank: "Report Bank",
        chequeNumber: "RPT-2",
        chequeDate: now + 2 * 24 * 60 * 60 * 1000,
        amount: 300,
        status: "DEPOSITED",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Report Bank",
        chequeNumber: "RPT-3",
        chequeDate: now + 3 * 24 * 60 * 60 * 1000,
        amount: 400,
        status: "RETURNED",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
    });

    const summary = await asFinance.query(api.collections.summary, { orgId });
    expect(summary).toMatchObject({
      totalOutstanding: 225,
      overdueOutstanding: 120,
      dueToday: 105,
      collectedToday: 20,
      upcomingChequeTotal: 500,
      upcomingChequeCount: 2,
    });

    const openReceivables = await asFinance.query(api.collections.listReceivables, {
      orgId,
      status: "OPEN",
      paginationOpts,
    });
    expect(openReceivables.page.some((row) => row._id === todayReceivableId && row.customerName === "Layla Nasser" && row.vehicleLabel === "2024 Toyota Corolla")).toBe(true);

    const allReceivables = await asFinance.query(api.collections.listReceivables, { orgId, paginationOpts });
    expect(allReceivables.page.length).toBeGreaterThanOrEqual(4);

    const dueBetween = await asFinance.query(api.collections.listReceivablesDueBetween, {
      orgId,
      startDate: now - 60 * 24 * 60 * 60 * 1000,
      endDate: now + 2 * 24 * 60 * 60 * 1000,
    });
    expect(dueBetween.map((row) => row.title)).toEqual(expect.arrayContaining(["Today balance", "Aged balance"]));
    expect(dueBetween.some((row) => row.title === "Settled balance" || row.title === "Deleted balance")).toBe(false);

    const heldCheques = await asFinance.query(api.collections.listCheques, {
      orgId,
      status: "HELD",
      paginationOpts,
    });
    expect(heldCheques.page[0]).toMatchObject({
      bank: "Report Bank",
      chequeNumber: "RPT-1",
      customerName: "Layla Nasser",
      receivableTitle: "Today balance",
    });
    const allCheques = await asFinance.query(api.collections.listCheques, { orgId, paginationOpts });
    expect(allCheques.page).toHaveLength(3);

    const payments = await asFinance.query(api.collections.listPayments, { orgId, paginationOpts });
    expect(payments.page.some((payment) => payment.customerName === "Layla Nasser" && payment.receivableTitle === "Today balance")).toBe(true);

    const dailyList = await asFinance.query(api.collections.dailyCollectionList, { orgId, businessDate: now });
    expect(dailyList.total).toBe(20);
    expect(dailyList.totalsByMethod).toMatchObject({ CASH: 25, REFUND: -5 });
    expect(dailyList.rows).toHaveLength(2);

    const upcoming = await asFinance.query(api.collections.upcomingChequeReport, {
      orgId,
      startDate: now,
      endDate: now + 7 * 24 * 60 * 60 * 1000,
    });
    expect(upcoming.total).toBe(500);
    expect(upcoming.rows.map((row) => row.chequeNumber)).toEqual(expect.arrayContaining(["RPT-1", "RPT-2"]));

    const aging = await asFinance.query(api.collections.agingReport, { orgId });
    expect(aging.current).toMatchObject({ count: 2, amount: 105 });
    expect(aging.days31To60).toMatchObject({ count: 1, amount: 120 });
  });

  test("create_receivable_and_installment_plan_validate_links_and_round_schedule", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);
    const related = await seedVehicleQuoteSaleAndApplication(t, { orgId, customerId, userId, vin: "LINKVALID000001" });
    const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() }));
    const otherUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "collections_other_user", email: "collections.other@example.com" })
    );
    const otherCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "Other", lastName: "Customer" })
    );
    const otherRelated = await seedVehicleQuoteSaleAndApplication(t, {
      orgId: otherOrgId,
      customerId: otherCustomerId,
      userId: otherUserId,
      vin: "OTHERLINK000001",
    });

    const baseArgs = {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT" as const,
      title: "Manual linked receivable",
      amount: 450,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME" as const,
    };

    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, amount: 0 })).rejects.toThrow("Amount must be greater than 0");
    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, title: "   " })).rejects.toThrow("Receivable title is required");
    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, customerId: otherCustomerId })).rejects.toThrow("Customer not found");
    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, vehicleId: otherRelated.vehicleId })).rejects.toThrow("Vehicle not found");
    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, saleId: otherRelated.saleId })).rejects.toThrow("Sale not found");
    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, quoteId: otherRelated.quoteId })).rejects.toThrow("Quote not found");
    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, applicationId: otherRelated.applicationId })).rejects.toThrow("Finance application not found");
    await expect(asFinance.mutation(api.collections.createReceivable, { ...baseArgs, assignedTo: otherUserId })).rejects.toThrow("Assigned user is not a member");
    await expect(asFinance.mutation(api.collections.createReceivable, {
      ...baseArgs,
      sourceType: "OTHER",
      creditSystemKey: undefined,
    })).rejects.toThrow("credit account");

    const saleLinkedReceivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      vehicleId: related.vehicleId,
      saleId: related.saleId,
      quoteId: related.quoteId,
      applicationId: related.applicationId,
      assignedTo: userId,
      sourceType: "OTHER",
      title: "Sale-linked receivable",
      amount: 321.1234,
      dueDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
    });

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(saleLinkedReceivableId);
      expect(receivable).toMatchObject({
        vehicleId: related.vehicleId,
        saleId: related.saleId,
        quoteId: related.quoteId,
        applicationId: related.applicationId,
        assignedTo: userId,
        originalAmount: 321.123,
        outstandingAmount: 321.123,
        status: "OPEN",
      });
      expect(receivable?.canonicalReceivableDocumentId).toBeTruthy();
    });

    await expect(asFinance.mutation(api.collections.createInstallmentPlan, {
      orgId,
      customerId,
      title: "Bad plan",
      totalAmount: 0,
      installmentCount: 3,
      firstDueDate: Date.now(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    })).rejects.toThrow("Total amount must be greater than 0");
    await expect(asFinance.mutation(api.collections.createInstallmentPlan, {
      orgId,
      customerId,
      title: "Bad plan",
      totalAmount: 100,
      installmentCount: 121,
      firstDueDate: Date.now(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    })).rejects.toThrow("Installment count must be between 1 and 120");
    await expect(asFinance.mutation(api.collections.createInstallmentPlan, {
      orgId,
      customerId,
      title: "Bad plan",
      totalAmount: 100,
      installmentCount: 3,
      intervalMonths: 13,
      firstDueDate: Date.now(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    })).rejects.toThrow("Installment interval must be between 1 and 12");
    await expect(asFinance.mutation(api.collections.createInstallmentPlan, {
      orgId,
      customerId,
      title: "   ",
      totalAmount: 100,
      installmentCount: 3,
      firstDueDate: Date.now(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    })).rejects.toThrow("Payment plan title is required");

    const firstDueDate = Date.UTC(2026, 0, 15);
    const planIds = await asFinance.mutation(api.collections.createInstallmentPlan, {
      orgId,
      customerId,
      vehicleId: related.vehicleId,
      assignedTo: userId,
      title: "Rounded plan",
      totalAmount: 100,
      installmentCount: 3,
      intervalMonths: 2,
      firstDueDate,
      notes: "Customer requested bimonthly payments",
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    expect(planIds).toHaveLength(3);

    await t.run(async (ctx) => {
      const rows = await Promise.all(planIds.map((id) => ctx.db.get(id)));
      expect(rows.map((row) => row?.title)).toEqual(["Rounded plan #1", "Rounded plan #2", "Rounded plan #3"]);
      expect(rows.map((row) => row?.originalAmount)).toEqual([33.333, 33.333, 33.334]);
      expect(rows.map((row) => row?.installmentNumber)).toEqual([1, 2, 3]);
      expect(rows[1]?.dueDate).toBe(Date.UTC(2026, 2, 15));
      expect(rows.every((row) => Boolean(row?.canonicalReceivableDocumentId))).toBe(true);
    });
  });

  test("payment_and_cheque_mutations_cover_guardrails_and_state_transitions", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);
    const { vehicleId, saleId, quoteId, applicationId } = await seedVehicleQuoteSaleAndApplication(t, {
      orgId,
      customerId,
      userId,
      vin: "PAYCHEQUE00001",
    });
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      vehicleId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Payment guard receivable",
      amount: 100,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await expect(asFinance.mutation(api.collections.recordPayment, {
      orgId,
      amount: 10,
      method: "CASH",
      paymentDate: Date.now(),
    })).rejects.toThrow("Customer is required");
    await expect(asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 10,
      method: "REFUND",
      paymentDate: Date.now(),
    })).rejects.toThrow("Refunds require manager approval");
    await expect(asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 101,
      method: "CASH",
      paymentDate: Date.now(),
    })).rejects.toThrow("cannot exceed the outstanding");

    const adHocPaymentId = await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      customerId,
      vehicleId,
      saleId,
      amount: 12.3456,
      method: "OTHER",
      paymentDate: Date.now(),
      reference: "manual-counter",
      notes: "No receivable selected",
      idempotencyKey: "ad-hoc-payment",
    });
    await t.run(async (ctx) => {
      const payment = await ctx.db.get(adHocPaymentId);
      expect(payment).toMatchObject({
        amount: 12.346,
        method: "OTHER",
        customerId,
        vehicleId,
        saleId,
      });
      expect(payment?.paymentAllocationId).toBeUndefined();
      const canonical = payment?.canonicalPaymentId ? await ctx.db.get(payment.canonicalPaymentId) : null;
      expect(canonical?.method).toBe("OTHER");
    });

    const appliedDepositPaymentId = await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      customerId,
      amount: 5,
      method: "DEPOSIT_APPLIED",
      paymentDate: Date.now(),
    });
    await t.run(async (ctx) => {
      const payment = await ctx.db.get(appliedDepositPaymentId);
      const canonical = payment?.canonicalPaymentId ? await ctx.db.get(payment.canonicalPaymentId) : null;
      expect(canonical?.method).toBe("OTHER");
    });

    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 100,
      method: "CASH",
      paymentDate: Date.now(),
    });
    await expect(asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 1,
      method: "CASH",
      paymentDate: Date.now(),
    })).rejects.toThrow("can no longer accept payments");

    const secondCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Mismatch", lastName: "Customer" })
    );
    await expect(asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "  ",
      chequeNumber: "BLANK-1",
      chequeDate: Date.now(),
      amount: 10,
    })).rejects.toThrow("Bank and cheque number are required");
    await expect(asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId: secondCustomerId,
      bank: "Mismatch Bank",
      chequeNumber: "MIS-1",
      chequeDate: Date.now(),
      amount: 10,
    })).rejects.toThrow("Cheque customer must match receivable customer");

    const returnReceivableId = await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      amount: 100,
      title: "Cheque return receivable",
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId: returnReceivableId,
      customerId,
      bank: "Duplicate Bank",
      chequeNumber: "DUP-1",
      chequeDate: Date.now() + 86_400_000,
      amount: 50,
    });
    await expect(asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId: returnReceivableId,
      customerId,
      bank: "Duplicate Bank",
      chequeNumber: "DUP-1",
      chequeDate: Date.now() + 86_400_000,
      amount: 50,
    })).rejects.toThrow("already exists");

    const depositedDate = Date.now() + 1_000;
    await asFinance.mutation(api.collections.depositCheque, { orgId, chequeId, depositedDate });
    await expect(asFinance.mutation(api.collections.depositCheque, { orgId, chequeId })).rejects.toThrow("Only held cheques can be deposited");
    await asFinance.mutation(api.collections.returnCheque, {
      orgId,
      chequeId,
      returnedAt: depositedDate + 1_000,
      returnReason: "Insufficient funds",
    });
    await t.run(async (ctx) => {
      const cheque = await ctx.db.get(chequeId);
      expect(cheque).toMatchObject({
        status: "RETURNED",
        depositedDate,
        returnReason: "Insufficient funds",
      });
      const reminder = await ctx.db
        .query("collectionReminders")
        .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId))
        .first();
      expect(reminder?.messageType).toBe("CHEQUE_RETURNED");
    });
    await t.finishAllScheduledFunctions(() => undefined);

    const appChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        vehicleId,
        saleId,
        applicationId,
        bank: "App Bank",
        chequeNumber: "APP-1",
        chequeDate: Date.now() + 2 * 86_400_000,
        amount: 150,
        status: "HELD",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const replacementId = await asFinance.mutation(api.collections.replaceCheque, {
      orgId,
      chequeId: appChequeId,
      bank: "Replacement Bank",
      chequeNumber: "APP-2",
      chequeDate: Date.now() + 3 * 86_400_000,
      amount: 150,
      notes: "Customer changed bank",
    });
    await t.run(async (ctx) => {
      const oldCheque = await ctx.db.get(appChequeId);
      const replacement = await ctx.db.get(replacementId);
      expect(oldCheque).toMatchObject({
        status: "REPLACED",
        replacementChequeId: replacementId,
      });
      expect(oldCheque?.applicationId).toBeUndefined();
      expect(replacement).toMatchObject({
        status: "HELD",
        applicationId,
        bank: "Replacement Bank",
      });
    });
    await expect(asFinance.mutation(api.collections.returnCheque, { orgId, chequeId: appChequeId })).rejects.toThrow("can no longer be returned");
    const cancelledChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Cancelled Bank",
        chequeNumber: "CANCEL-1",
        chequeDate: Date.now(),
        amount: 100,
        status: "CANCELLED",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(asFinance.mutation(api.collections.replaceCheque, {
      orgId,
      chequeId: cancelledChequeId,
      bank: "Another Bank",
      chequeNumber: "APP-3",
      chequeDate: Date.now(),
      amount: 100,
    })).rejects.toThrow("Cleared or cancelled cheques cannot be replaced");

    const financeLinkedChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        vehicleId,
        applicationId,
        bank: "Finance Bank",
        chequeNumber: "FIN-1",
        chequeDate: Date.now(),
        amount: 100,
        status: "HELD",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(asFinance.mutation(api.collections.clearCheque, {
      orgId,
      chequeId: financeLinkedChequeId,
    })).rejects.toThrow("confirm disbursement from the Applications page");

    const otherOrgChequeId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Cheque Org", createdAt: Date.now() });
      const otherCustomerId = await ctx.db.insert("customers", {
        orgId: otherOrgId,
        firstName: "Other",
        lastName: "Cheque",
      });
      return await ctx.db.insert("postDatedCheques", {
        orgId: otherOrgId,
        customerId: otherCustomerId,
        bank: "Other Bank",
        chequeNumber: "OTHER-1",
        chequeDate: Date.now(),
        amount: 10,
        status: "HELD",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(asFinance.mutation(api.collections.clearCheque, {
      orgId,
      chequeId: otherOrgChequeId,
    })).rejects.toThrow("Cheque not found");

    const returnedChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Returned Bank",
        chequeNumber: "RET-1",
        chequeDate: Date.now(),
        amount: 10,
        status: "RETURNED",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(asFinance.mutation(api.collections.clearCheque, {
      orgId,
      chequeId: returnedChequeId,
    })).rejects.toThrow("Only held or deposited cheques can be cleared");

    const smallReceivableId = await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      amount: 25,
      outstandingAmount: 25,
    });
    const oversizedChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        receivableId: smallReceivableId,
        customerId,
        bank: "Oversized Bank",
        chequeNumber: "BIG-1",
        chequeDate: Date.now(),
        amount: 30,
        status: "HELD",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(asFinance.mutation(api.collections.clearCheque, {
      orgId,
      chequeId: oversizedChequeId,
    })).rejects.toThrow("Cheque amount cannot exceed");
    await expect(asFinance.mutation(api.collections.returnClearedCheque, {
      orgId,
      chequeId: oversizedChequeId,
      idempotencyKey: "not-cleared-return",
    })).rejects.toThrow("Only cleared cheques can be returned after clearing");
  });

  test("approval_requests_cover_rejections_listing_and_legacy_guardrails", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Approval guard receivable",
      amount: 200,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await expect(asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "   ",
    })).rejects.toThrow("Reason is required");
    await expect(asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 10,
      reason: "Refund without method",
    })).rejects.toThrow("Disbursement method is required");
    await expect(asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "RESCHEDULE",
      reason: "Need more time",
    })).rejects.toThrow("New due date is required");

    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "RESCHEDULE",
      requestedDueDate: Date.now() + 14 * 24 * 60 * 60 * 1000,
      reason: "Need more time",
    });
    await expect(asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "RESCHEDULE",
      requestedDueDate: Date.now() + 21 * 24 * 60 * 60 * 1000,
      reason: "Duplicate request",
    })).rejects.toThrow("pending request");

    const pending = await asApprover.query(api.collections.listApprovals, { orgId });
    expect(pending[0]).toMatchObject({
      _id: requestId,
      receivableTitle: "Approval guard receivable",
      customerName: "Layla Nasser",
      requestedByName: "Collections User",
    });

    await expect(asFinance.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    })).rejects.toThrow("Requester cannot approve");
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "REJECTED",
      decisionNotes: "Customer needs documentation first",
    });
    await expect(asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    })).rejects.toThrow("already been resolved");
    const rejected = await asApprover.query(api.collections.listApprovals, { orgId, status: "REJECTED" });
    expect(rejected[0]).toMatchObject({
      _id: requestId,
      requestedByName: "Collections User",
    });

    const missingDueReceivableId = await insertReceivable(t, { orgId, customerId, createdBy: userId, amount: 50 });
    const missingDueRequestId = await t.run((ctx) =>
      ctx.db.insert("collectionApprovalRequests", {
        orgId,
        receivableId: missingDueReceivableId,
        customerId,
        requestedBy: userId,
        requestType: "RESCHEDULE",
        status: "PENDING",
        reason: "Legacy missing due date",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: missingDueRequestId,
      status: "APPROVED",
    })).rejects.toThrow("Requested due date is missing");

    const paidReceivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Legacy refund receivable",
      amount: 100,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId: paidReceivableId,
      amount: 100,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const missingDisbursementRequestId = await t.run((ctx) =>
      ctx.db.insert("collectionApprovalRequests", {
        orgId,
        receivableId: paidReceivableId,
        customerId,
        requestedBy: userId,
        requestType: "REFUND",
        status: "PENDING",
        requestedAmount: 25,
        reason: "Legacy missing disbursement method",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: missingDisbursementRequestId,
      status: "APPROVED",
    })).rejects.toThrow("legacy refund request has no disbursement method");

    const deletedReceivableId = await insertReceivable(t, { orgId, customerId, createdBy: userId, amount: 75 });
    const orphanedRequestId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("collectionApprovalRequests", {
        orgId,
        receivableId: deletedReceivableId,
        customerId,
        requestedBy: userId,
        requestType: "CANCEL_RECEIVABLE",
        status: "PENDING",
        reason: "Receivable was removed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(deletedReceivableId);
      return id;
    });
    await expect(asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: orphanedRequestId,
      status: "APPROVED",
    })).rejects.toThrow("Receivable not found");
  });

  test("refund_approval_handles_multiple_allocations_and_rejects_missing_canonical_allocations", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover, userId } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Two-payment receivable",
      amount: 300,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 100,
      method: "CASH",
      paymentDate: Date.now() - 1_000,
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 200,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const partialRefundRequestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 150,
      disbursementMethod: "CASH",
      reason: "Partial refund across multiple allocations",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: partialRefundRequestId,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.outstandingAmount).toBe(150);
      const allocations = receivable?.canonicalReceivableDocumentId
        ? await ctx.db
            .query("paymentAllocations")
            .withIndex("by_receivable", (q) =>
              q.eq("receivableDocumentId", receivable.canonicalReceivableDocumentId!)
            )
            .collect()
        : [];
      const reversedAllocations = allocations.filter((allocation) => allocation.status === "REVERSED");
      const activeMinor = allocations
        .filter((allocation) => allocation.status === "ACTIVE")
        .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      expect(reversedAllocations.length).toBeGreaterThan(0);
      expect(activeMinor).toBe(150_000);
    });

    const legacyReceivableId = await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      title: "Legacy paid without allocations",
      amount: 100,
      outstandingAmount: 0,
      status: "PAID",
    });
    const legacyRefundRequestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId: legacyReceivableId,
      requestType: "REFUND",
      requestedAmount: 25,
      disbursementMethod: "CASH",
      reason: "Legacy data repair case",
    });
    await expect(asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: legacyRefundRequestId,
      status: "APPROVED",
    })).rejects.toThrow(/Canonical allocations cover only 0/);
  });

  test("return_cleared_cheque_defers_reversal_when_no_open_period_exists", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await asFinance.mutation(api.chartOfAccounts.initialize, { orgId });
    await asFinance.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(2020, 0, 1),
      endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2026,
      periodNumber: 1,
    });
    const period = (await asFinance.query(api.accountingPeriods.list, { orgId }))[0];
    await asFinance.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "CHEQUE",
      title: "Posted cheque return",
      amount: 250,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Posted Bank",
      chequeNumber: "POST-RETURN-1",
      chequeDate: Date.now(),
      amount: 250,
    });
    await asFinance.mutation(api.collections.clearCheque, { orgId, chequeId });
    await asFinance.mutation(api.accountingPeriods.close, { orgId, periodId: period._id });

    await asFinance.mutation(api.collections.returnClearedCheque, {
      orgId,
      chequeId,
      returnReason: "No open period for reversal",
      idempotencyKey: "posted-cheque-return-no-open-period",
    });

    await t.run(async (ctx) => {
      const pendingReversal = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `cheque_return_after_clear_${chequeId}`)
        )
        .unique();
      expect(pendingReversal).toMatchObject({
        kind: "REVERSE",
        status: "PENDING",
        sourceType: "collectionPayments",
      });
    });
  });

  test("cashier_reconciliation_computes_differences_and_enforces_review_controls", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);
    const now = Date.now();
    const receivableId = await insertReceivable(t, { orgId, customerId, createdBy: userId, amount: 100 });

    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 100,
      method: "CASH",
      paymentDate: now,
    });
    await t.run((ctx) =>
      ctx.db.insert("collectionPayments", {
        orgId,
        receivableId,
        customerId,
        direction: "OUT",
        method: "REFUND",
        amount: 30,
        paymentDate: now,
        status: "POSTED",
        cashierId: userId,
        createdAt: now,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("collectionPayments", {
        orgId,
        receivableId,
        customerId,
        direction: "IN",
        method: "BANK_TRANSFER",
        amount: 1000,
        paymentDate: now,
        status: "POSTED",
        cashierId: userId,
        createdAt: now,
      })
    );

    const draft = await asFinance.query(api.collections.getReconciliationDraft, { orgId, businessDate: now });
    expect(draft).toMatchObject({ expectedCash: 70, paymentCount: 2 });

    await expect(asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId,
      businessDate: now,
      countedCash: -1,
    })).rejects.toThrow("Counted cash must be zero or greater");

    const reconciliationId = await asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId,
      businessDate: now,
      countedCash: 65,
      notes: "Short by five",
      idempotencyKey: "cash-recon-short",
    });
    await t.run(async (ctx) => {
      const reconciliation = await ctx.db.get(reconciliationId);
      expect(reconciliation).toMatchObject({
        expectedCash: 70,
        countedCash: 65,
        difference: -5,
        status: "SUBMITTED",
      });
      const reconciledPayments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_reconciliation", (q) => q.eq("reconciliationId", reconciliationId))
        .collect();
      expect(reconciledPayments.map((payment) => payment.method).sort()).toEqual(["CASH", "REFUND"]);
    });

    const listed = await asFinance.query(api.collections.listReconciliations, { orgId });
    expect(listed[0]).toMatchObject({
      _id: reconciliationId,
      cashierName: "Collections User",
      difference: -5,
    });

    await expect(asFinance.mutation(api.collections.reviewCashierReconciliation, {
      orgId,
      reconciliationId,
      status: "APPROVED",
    })).rejects.toThrow("Cashier cannot approve");
    await asApprover.mutation(api.collections.reviewCashierReconciliation, {
      orgId,
      reconciliationId,
      status: "APPROVED",
      notes: "Accepted variance",
    });
    await expect(asApprover.mutation(api.collections.reviewCashierReconciliation, {
      orgId,
      reconciliationId,
      status: "REJECTED",
    })).rejects.toThrow("Only submitted reconciliations can be reviewed");
  });

  test("daily_collection_reminders_queue_channels_dedupe_and_mark_results", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId } = await seedFinanceMember(t);
    const now = Date.now();
    const whatsappCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Whats", lastName: "App", whatsapp: "+962790000001" })
    );
    const manualCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "No", lastName: "Phone" })
    );
    const overdueReceivableId = await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      title: "Overdue reminder",
      amount: 90,
      dueDate: now - 24 * 60 * 60 * 1000,
      status: "OPEN",
    });
    const dueSoonReceivableId = await insertReceivable(t, {
      orgId,
      customerId: whatsappCustomerId,
      createdBy: userId,
      title: "Due soon reminder",
      amount: 80,
      dueDate: now + 24 * 60 * 60 * 1000,
      status: "OPEN",
    });
    const manualReceivableId = await insertReceivable(t, {
      orgId,
      customerId: manualCustomerId,
      createdBy: userId,
      title: "Manual reminder",
      amount: 70,
      dueDate: now + 24 * 60 * 60 * 1000,
      status: "OPEN",
    });
    const chequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId: whatsappCustomerId,
        receivableId: dueSoonReceivableId,
        bank: "Reminder Bank",
        chequeNumber: "REM-1",
        chequeDate: now + 2 * 24 * 60 * 60 * 1000,
        amount: 80,
        status: "HELD",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
    );
    const standaloneChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId: whatsappCustomerId,
        bank: "Standalone Reminder Bank",
        chequeNumber: "REM-2",
        chequeDate: now + 2 * 24 * 60 * 60 * 1000,
        amount: 40,
        status: "HELD",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
    );

    const result = await t.mutation(internal.collections.processDailyCollectionReminders, {});
    expect(result).toMatchObject({ queued: 5, markedOverdue: 1 });
    const secondResult = await t.mutation(internal.collections.processDailyCollectionReminders, {});
    expect(secondResult).toMatchObject({ queued: 0, markedOverdue: 0 });

    const reminders = await t.run((ctx) =>
      ctx.db
        .query("collectionReminders")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(reminders.map((reminder) => reminder.messageType).sort()).toEqual([
      "CHEQUE_UPCOMING",
      "CHEQUE_UPCOMING",
      "DUE_SOON",
      "DUE_SOON",
      "OVERDUE",
    ]);
    expect(reminders.find((reminder) => reminder.receivableId === overdueReceivableId)?.channel).toBe("SMS");
    expect(reminders.find((reminder) => reminder.receivableId === dueSoonReceivableId)?.channel).toBe("WHATSAPP");
    expect(reminders.find((reminder) => reminder.receivableId === manualReceivableId)).toMatchObject({
      channel: "MANUAL",
      status: "SKIPPED",
      error: "No customer phone or WhatsApp number on file.",
    });

    const payload = await t.query(internal.collections.getReminderPayload, { reminderId: reminders[0]._id });
    expect(payload?.reminder._id).toBe(reminders[0]._id);
    expect(payload?.customer).toBeTruthy();
    expect(payload?.currency).toBe("JOD");
    const deletedReminderId = await t.run((ctx) =>
      ctx.db.insert("collectionReminders", {
        orgId,
        customerId: manualCustomerId,
        channel: "MANUAL",
        messageType: "DUE_SOON",
        status: "SKIPPED",
        scheduledAt: now,
        createdAt: now,
      })
    );
    await t.run((ctx) => ctx.db.delete(deletedReminderId));
    const missingPayload = await t.query(internal.collections.getReminderPayload, { reminderId: deletedReminderId });
    expect(missingPayload).toBeNull();

    const remainingReminder = reminders.find((reminder) => reminder.chequeId === chequeId);
    expect(remainingReminder).toBeTruthy();
    expect(reminders.some((reminder) => reminder.chequeId === standaloneChequeId && reminder.receivableId === undefined)).toBe(true);
    await t.mutation(internal.collections.markReminderResult, {
      reminderId: remainingReminder!._id,
      status: "SENT",
    });
    await t.run(async (ctx) => {
      const reminder = await ctx.db.get(remainingReminder!._id);
      expect(reminder?.status).toBe("SENT");
      expect(reminder?.sentAt).toBeTypeOf("number");
    });
    await t.finishAllScheduledFunctions(() => undefined);
  });
});
