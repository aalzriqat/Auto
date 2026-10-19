import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { ruleCollectionPayment, ruleCollectionRefund } from "./accounting/postingRules";
import { registerChequeCore } from "./collections";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import {
  occurrenceReversalIdempotencyKey,
  rehydrateReceiptOccurrence,
} from "./accounting/receiptOccurrence";

/**
 * Two tests here queue collection reminders, which schedule
 * `collectionReminderActions.sendCollectionReminder`. That work used to escape
 * the test file and fire after Vitest tore the environment down, failing the
 * whole run with an unhandled `EnvironmentTeardownError` while every test still
 * reported green — the CI failure that hit PRs #168 and #174 on unrelated
 * changes.
 *
 * The cause was the drain, which this file called as
 * `finishAllScheduledFunctions(() => undefined)`. That helper advances timers
 * via the callback and returns the moment `anyFunctionsRunning()` is false, so
 * a no-op callback means time never moves and the drain can return before the
 * scheduler has even picked the work up.
 *
 * The non-obvious half: passing `vi.runAllTimers` is not enough on its own.
 * Vitest's fake timers only control timers created *after* `useFakeTimers()`,
 * so installing them at drain time leaves the scheduler on the real clock with
 * nothing for `runAllTimers` to fire. They have to be installed before anything
 * schedules — hence the call at the top of each affected test rather than here.
 */
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Runs the scheduled work this suite queues, instead of leaking it.
 *
 * Retried, because the budget is a fixed number of PUMPS and not a deadline.
 * `finishAllScheduledFunctions` gives up after 10,000 advances, and under a
 * loaded full-suite run the awaited work between advances can starve long
 * enough to exhaust them while still being perfectly healthy — the file then
 * fails on machine load rather than on anything it asserts. It went red in two
 * of three full-suite runs while passing 24/24 in isolation, and a gate that
 * teaches people to re-run is not a gate.
 *
 * Each retry buys another full budget, up to `MAX_DRAIN_ATTEMPTS` calls in
 * total. A genuine hang still fails, that many times as slowly, which is the
 * right trade for a suite this is meant to protect.
 */
const MAX_DRAIN_ATTEMPTS = 5;

async function drainScheduled(t: ReturnType<typeof convexTestWithComponents>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      return;
    } catch (error) {
      // ONLY an exhausted pump budget is retried. A blanket catch would swallow
      // an assertion thrown from inside a scheduled function for every attempt
      // but the last and then report it as a drain failure — turning a real
      // defect into a confusing timeout, the opposite of what this retry is for.
      const exhausted = String((error as Error)?.message ?? error).includes("timer pumps");
      if (!exhausted || attempt >= MAX_DRAIN_ATTEMPTS - 1) throw error;
    }
  }
}

const paginationOpts = { numItems: 20, cursor: null };

async function seedFinanceMember(t: ReturnType<typeof convexTestWithComponents>) {
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
  const bankAccountId = await t.run((ctx) => ctx.db.insert("bankAccounts", {
    orgId, name: "Collection bank", currency: "JOD", openingBalanceMinor: 0,
    openingBalanceDate: Date.now(), isActive: true, isReconciliationTarget: false,
    createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
  }));

  return {
    orgId,
    userId,
    approverId,
    customerId,
    bankAccountId,
    asFinance: t.withIdentity({ subject: "collections_user", clerkId: "collections_user" }),
    asApprover: t.withIdentity({ subject: "collections_approver", clerkId: "collections_approver" }),
  };
}

async function seedVehicleQuoteSaleAndApplication(
  t: ReturnType<typeof convexTestWithComponents>,
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
  t: ReturnType<typeof convexTestWithComponents>,
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment 1",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const paymentKey = "legacy-cash-retry";
    const paymentDate = Date.now();
    const paymentArgs = {
      idempotencyKey: paymentKey,
      orgId,
      receivableId,
      amount: 300,
      method: "CASH" as const,
      paymentDate,
    };
    const firstPayment = await asFinance.mutation(api.collections.recordPayment, paymentArgs);

    // A retry crossing this release must match the stored pre-bank fingerprint.
    const command = await t.run((ctx) => ctx.db.query("commandIdempotency")
      .withIndex("by_org_operation_key", (q) => q.eq("orgId", orgId)
        .eq("operation", "collections.recordPayment").eq("idempotencyKey", paymentKey)).unique());
    expect(JSON.parse(command?.fingerprint ?? "{}")).toEqual({
      receivableId,
      customerId: null,
      vehicleId: null,
      saleId: null,
      invoiceSaleId: null,
      amount: 300,
      method: "CASH",
      paymentDate,
      reference: null,
    });
    expect(await asFinance.mutation(api.collections.recordPayment, paymentArgs)).toEqual(firstPayment);

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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, bankAccountId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
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

    await asFinance.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId, bankAccountId });

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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, bankAccountId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
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
    await asFinance.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId, bankAccountId });

    await expect(
      asFinance.mutation(api.collections.returnClearedCheque, {
        orgId,
        chequeId,
        bankFeeMinor: -1,
        idempotencyKey: "return-cleared-bad-fee",
      })
    ).rejects.toThrow(/CHEQUE_BANK_FEE_INVALID/);
  });

  test("approved_refund_posts_outbound_payment_and_reopens_balance", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "RESERVATION_PAYMENT",
      title: "Reservation payment",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
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

    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
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

    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);

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
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cancelled installment (posted)",
      amount: 750,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const postedBefore =
      (
        await t.run((ctx) =>
          ctx.db
            .query("accountingEvents")
            .withIndex("by_org_source", (q) =>
              q.eq("orgId", orgId).eq("sourceType", "receivables").eq("sourceId", receivableId.toString())
            )
            .collect()
        )
      ).find((e) => e.eventType === "RECEIVABLE_CREATED") ?? null;
    expect(postedBefore?.status).toBe("POSTED");

    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Deal fell through",
    });
    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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

    // D-20: createReceivable refuses a saleId now, so the pre-existing legacy
    // row this test exercises is seeded directly (it models a row created
    // before the release). The property under test - cancelling it posts no GL
    // and does not error - is unchanged.
    const receivableId = await insertReceivable(t, {
      orgId,
      customerId,
      createdBy: userId,
      saleId,
      title: "Sale-linked balance",
      amount: 400,
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
      asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(), orgId, requestId, status: "APPROVED" })
    ).resolves.not.toThrow();

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(receivableId);
      expect(receivable?.status).toBe("CANCELLED");
    });
  });

  test("bank_refund_posts_gl_entry_to_bank_account_not_cash_on_hand", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, bankAccountId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Bank transfer installment",
      amount: 500,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 500,
      method: "BANK_TRANSFER",
      bankAccountId: await insertBank(t, orgId, userId),
      paymentDate: Date.now(),
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 500,
      disbursementMethod: "BANK_TRANSFER",
      bankAccountId,
      reason: "Customer cancelled after bank payment",
    });

    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
      expect(refund?.bankAccountId).toBe(bankAccountId);

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
      expect((refundEvent?.payload as { bankAccountId?: string })?.bankAccountId).toBe(bankAccountId);

      const canonicalRefund = refund?.canonicalPaymentId
        ? await ctx.db.get(refund.canonicalPaymentId)
        : null;
      expect(canonicalRefund?.method).toBe("BANK_TRANSFER");
    });
  });

  test("bank refund request refuses a missing bank and approval refuses a bank deactivated while pending", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, bankAccountId, asFinance, asApprover } = await seedFinanceMember(t);
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(), orgId, customerId,
      sourceType: "INTERNAL_INSTALLMENT", title: "Refund bank guard", amount: 50,
      dueDate: Date.now() + 86_400_000, creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(), orgId, receivableId,
      amount: 50, method: "CASH", paymentDate: Date.now(),
    });
    const refund = { orgId, receivableId, requestType: "REFUND" as const,
      requestedAmount: 50, disbursementMethod: "BANK_TRANSFER" as const,
      reason: "Return collected funds" };
    await expect(asFinance.mutation(api.collections.requestApproval, refund))
      .rejects.toThrow("Select the bank account");
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      ...refund, bankAccountId,
    });
    await t.run((ctx) => ctx.db.patch(bankAccountId, { isActive: false }));
    await expect(asApprover.mutation(api.collections.respondToApproval, {
      orgId, requestId, status: "APPROVED", idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow("inactive");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(requestId))?.status).toBe("PENDING");
      const payments = await ctx.db.query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", receivableId)).collect();
      expect(payments.filter((payment) => payment.direction === "OUT")).toHaveLength(0);
    });
  });

  test("cancel_of_partially_paid_receivable_is_blocked", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Paid installment",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
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
      asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Cannot cancel a receivable that has already received payments");
  });

  test("card_refund_routes_to_bank_account_not_cash_on_hand", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, bankAccountId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Card payment installment",
      amount: 300,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 300,
      method: "CARD",
      bankAccountId: await insertBank(t, orgId, userId),
      paymentDate: Date.now(),
    });
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 300,
      disbursementMethod: "CARD",
      bankAccountId,
      reason: "Customer requested card reversal",
    });

    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
      bankAccountId: "bank-1",
    });
    const creditLine = result.lines.find((l) => l.creditMinor > 0 && l.debitMinor === 0);
    expect(creditLine?.accountSystemKey).toBe(SYSTEM_KEYS.BANK_ACCOUNT);
    expect(creditLine?.bankAccountId).toBe("bank-1");
    expect(creditLine?.accountSystemKey).not.toBe(SYSTEM_KEYS.CHEQUES_IN_HAND);
  });

  test("cheque_refund_approval_posts_cheque_method_to_event_outbox", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, bankAccountId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cheque refund installment",
      amount: 600,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
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
      bankAccountId,
      reason: "Refund by dealership cheque",
    });

    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
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
      asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Cannot cancel a receivable with an active cheque");
  });

  test("approved_reschedule_moves_overdue_receivable_to_new_due_date", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
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

    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
      // SCRUM-57: every probe below is a REFUSAL, and an uncaught throw rolls
      // the whole mutation back, so no command row survives any of them and one
      // shared identity cannot collide. If that ever stopped being true the
      // conflict would surface as a failed expectation here, not as a silent pass.
      idempotencyKey: crypto.randomUUID(),
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

    // D-20: a sale-linked legacy receivable can no longer be created (the sale's
    // debt is its invoice), so the original "all links persist" property is
    // exercised through the allowed path (no saleId), and the saleId case now
    // asserts the refusal.
    await expect(
      asFinance.mutation(api.collections.createReceivable, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        saleId: related.saleId,
        sourceType: "OTHER",
        title: "Sale-linked receivable",
        amount: 321.1234,
        dueDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
        creditSystemKey: "MISCELLANEOUS_INCOME",
      })
    ).rejects.toMatchObject({ data: { code: "SALE_DEBT_COMPETING_RECEIVABLE_REFUSED" } });

    const saleLinkedReceivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      vehicleId: related.vehicleId,
      quoteId: related.quoteId,
      applicationId: related.applicationId,
      assignedTo: userId,
      sourceType: "OTHER",
      title: "Linked receivable",
      amount: 321.1234,
      dueDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await t.run(async (ctx) => {
      const receivable = await ctx.db.get(saleLinkedReceivableId);
      expect(receivable).toMatchObject({
        vehicleId: related.vehicleId,
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
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      title: "Bad plan",
      totalAmount: 0,
      installmentCount: 3,
      firstDueDate: Date.now(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    })).rejects.toThrow("Total amount must be greater than 0");
    await expect(asFinance.mutation(api.collections.createInstallmentPlan, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      title: "Bad plan",
      totalAmount: 100,
      installmentCount: 121,
      firstDueDate: Date.now(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    })).rejects.toThrow("Installment count must be between 1 and 120");
    await expect(asFinance.mutation(api.collections.createInstallmentPlan, {
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
    // Installed before anything schedules: vitest fake timers only control
    // timers created after this call, so installing them at drain time leaves
    // the scheduler on the real clock and runAllTimers with nothing to fire.
    vi.useFakeTimers();
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, bankAccountId, asFinance } = await seedFinanceMember(t);
    const { vehicleId, saleId, quoteId, applicationId } = await seedVehicleQuoteSaleAndApplication(t, {
      orgId,
      customerId,
      userId,
      vin: "PAYCHEQUE00001",
    });
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      vehicleId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Payment guard receivable",
      amount: 100,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await expect(asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      amount: 10,
      method: "CASH",
      paymentDate: Date.now(),
    })).rejects.toThrow("Customer is required");
    await expect(asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 10,
      method: "REFUND",
      paymentDate: Date.now(),
    })).rejects.toThrow("Refunds require manager approval");
    await expect(asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 101,
      method: "CASH",
      paymentDate: Date.now(),
    })).rejects.toThrow("cannot exceed the outstanding");

    // D-20: a caller-supplied saleId on a receipt is refused until the invoice
    // receipt resolver exists, so the ad-hoc property below (rounding, canonical
    // mirror, no allocation) is exercised through the allowed path with no saleId.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId,
        customerId,
        vehicleId,
        saleId,
        amount: 12.3456,
        method: "CASH",
        paymentDate: Date.now(),
        idempotencyKey: "ad-hoc-payment-with-sale",
      })
    ).rejects.toMatchObject({ data: { code: "SALE_DEBT_RECEIPT_REFUSED" } });

    const adHocPaymentId = await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      customerId,
      vehicleId,
      amount: 12.3456,
      method: "CASH",
      paymentDate: Date.now(),
      reference: "manual-counter",
      notes: "No receivable selected",
      idempotencyKey: "ad-hoc-payment",
    });
    await t.run(async (ctx) => {
      const payment = await ctx.db.get(adHocPaymentId);
      expect(payment).toMatchObject({
        amount: 12.346,
        method: "CASH",
        customerId,
        vehicleId,
      });
      expect(payment?.saleId).toBeUndefined();
      expect(payment?.paymentAllocationId).toBeUndefined();
      const canonical = payment?.canonicalPaymentId ? await ctx.db.get(payment.canonicalPaymentId) : null;
      expect(canonical?.method).toBe("CASH");
    });

    await expect(asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      amount: 10,
      method: "OTHER",
      paymentDate: Date.now(),
    })).rejects.toThrow("OTHER is not accepted");

    // SCRUM-263: a deposit is applied from the deal; this receipt door refuses it.
    await expect(asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      amount: 5,
      method: "DEPOSIT_APPLIED",
      paymentDate: Date.now(),
    })).rejects.toThrow("A deposit is applied from the deal");

    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 100,
      method: "CASH",
      paymentDate: Date.now(),
    });
    await expect(asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
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

    const deletedChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Deleted Bank",
        chequeNumber: "DEL-1",
        chequeDate: Date.now() + 86_400_000,
        amount: 25,
        status: "HELD",
        isDeleted: true,
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(asFinance.mutation(api.collections.depositCheque, { orgId, chequeId: deletedChequeId })).rejects.toThrow("Cheque not found");

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
    await drainScheduled(t);

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
    // SCRUM-447: a finance-company row is replaceable only while it is the
    // deal's registered payment, and the replacement states its face exactly.
    await t.run((ctx) => ctx.db.patch(applicationId, { expectedPaymentMethod: "CHEQUE" }));
    const replacementId = await asFinance.mutation(api.collections.replaceCheque, {
      orgId,
      chequeId: appChequeId,
      bank: "Replacement Bank",
      chequeNumber: "APP-2",
      chequeDate: Date.now() + 3 * 86_400_000,
      faceAmount: "150",
      notes: "Customer changed bank",
    });
    await t.run(async (ctx) => {
      const oldCheque = await ctx.db.get(appChequeId);
      const replacement = await ctx.db.get(replacementId);
      expect(oldCheque).toMatchObject({
        status: "REPLACED",
        replacementChequeId: replacementId,
      });
      // SCRUM-447 D0: lineage is permanent — the replaced row keeps its application.
      expect(oldCheque?.applicationId).toBe(applicationId);
      expect(oldCheque?.originApplicationId).toBe(applicationId);
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
    await expect(asFinance.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(),
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
    await expect(asFinance.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(),
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
    await expect(asFinance.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(),
      orgId,
      chequeId: returnedChequeId,
      bankAccountId,
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
    await expect(asFinance.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(),
      orgId,
      chequeId: oversizedChequeId,
      bankAccountId,
    })).rejects.toThrow("Cheque amount cannot exceed");
    await expect(asFinance.mutation(api.collections.returnClearedCheque, {
      orgId,
      chequeId: oversizedChequeId,
      idempotencyKey: "not-cleared-return",
    })).rejects.toThrow("Only cleared cheques can be returned after clearing");
  });

  test("approval_requests_cover_rejections_listing_and_legacy_guardrails", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
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

    await expect(asFinance.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
      orgId,
      requestId,
      status: "APPROVED",
    })).rejects.toThrow("Requester cannot approve");
    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
      orgId,
      requestId,
      status: "REJECTED",
      decisionNotes: "Customer needs documentation first",
    });
    await expect(asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    await expect(asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
      orgId,
      requestId: missingDueRequestId,
      status: "APPROVED",
    })).rejects.toThrow("Requested due date is missing");

    const paidReceivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Legacy refund receivable",
      amount: 100,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
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
    await expect(asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    await expect(asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
      orgId,
      requestId: orphanedRequestId,
      status: "APPROVED",
    })).rejects.toThrow("Receivable not found");
  });

  test("refund_approval_handles_multiple_allocations_and_rejects_missing_canonical_allocations", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover, userId } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Two-payment receivable",
      amount: 300,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 100,
      method: "CASH",
      paymentDate: Date.now() - 1_000,
    });
    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
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
    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
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
    await expect(asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
      orgId,
      requestId: legacyRefundRequestId,
      status: "APPROVED",
    })).rejects.toThrow(/Canonical allocations cover only 0/);
  });

  test("return_cleared_cheque_defers_reversal_when_no_open_period_exists", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, bankAccountId, asFinance } = await seedFinanceMember(t);

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
      idempotencyKey: crypto.randomUUID(),
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
    await asFinance.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId, bankAccountId });
    await asFinance.mutation(api.accountingPeriods.close, { orgId, periodId: period._id });

    await asFinance.mutation(api.collections.returnClearedCheque, {
      orgId,
      chequeId,
      returnReason: "No open period for reversal",
      idempotencyKey: "posted-cheque-return-no-open-period",
    });

    // ⚠️ THE DEFERRED REVERSAL'S KEY CHANGED, DELIBERATELY (SCRUM-130).
    //
    // It was the hand-built literal `cheque_return_after_clear_<chequeId>`, which
    // `reversals.ts` records as an OPEN BOUNDARY: a reversal of a
    // `collectionPayments`-sourced event written under a key OUTSIDE SCRUM-249's
    // reserved namespace, addressed with `by_org_source` + `.first()` — no
    // eventType, no eventVersion, no cardinality refusal. The return now goes
    // through `revokeReceiptOccurrence`, so the key is DERIVED from the same
    // identity as the forward post by `occurrenceReversalIdempotencyKey`.
    //
    // The key is recomputed here from the movement's own persisted snapshot
    // rather than hard-coded, so this test cannot drift from the encoder: a
    // change to the framing breaks the encoder's own suite, not this one.
    await t.run(async (ctx) => {
      const payment = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId))
        .first();
      const movement = await ctx.db
        .query("receiptMovements")
        .withIndex("by_org_payment", (q) =>
          q.eq("orgId", orgId).eq("collectionPaymentId", payment!._id)
        )
        .unique();
      const derivedKey = occurrenceReversalIdempotencyKey(
        rehydrateReceiptOccurrence({ orgId, snapshot: movement!.occurrence })
      );
      expect(derivedKey).not.toBe(`cheque_return_after_clear_${chequeId}`);

      const pendingReversal = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", derivedKey)
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);
    const now = Date.now();
    const receivableId = await insertReceivable(t, { orgId, customerId, createdBy: userId, amount: 100 });

    await asFinance.mutation(api.collections.recordPayment, { idempotencyKey: crypto.randomUUID(),
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

    await expect(asFinance.mutation(api.collections.submitCashierReconciliation, { idempotencyKey: crypto.randomUUID(),
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

  // SCRUM-259: the reconciliation read the cashier's first 500 payments of all
  // time and filtered afterwards, so a cash payment behind 500 older rows was
  // invisible and the day was certified from a hidden prefix.
  async function seedCashierPayments(
    t: ReturnType<typeof convexTestWithComponents>,
    base: { orgId: Id<"organizations">; customerId: Id<"customers">; userId: Id<"users"> },
    count: number,
    over: Partial<Doc<"collectionPayments">> & { paymentDate: number }
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i += 1) {
        await ctx.db.insert("collectionPayments", {
          orgId: base.orgId,
          customerId: base.customerId,
          cashierId: base.userId,
          direction: "IN",
          method: "CASH",
          amount: 1,
          status: "POSTED",
          createdAt: over.paymentDate,
          ...over,
        });
      }
    });
  }

  test("cashier_reconciliation_includes_a_cash_payment_behind_500_older_rows", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const seed = await seedFinanceMember(t);
    const { orgId, asFinance } = seed;
    const now = Date.now();
    await seedCashierPayments(t, seed, 500, { paymentDate: now - 30 * 24 * 60 * 60 * 1000 });
    await seedCashierPayments(t, seed, 1, { paymentDate: now, amount: 250 });

    const draft = await asFinance.query(api.collections.getReconciliationDraft, { orgId, businessDate: now });
    expect(draft).toMatchObject({ complete: true, expectedCash: 250, paymentCount: 1 });

    const reconciliationId = await asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId, businessDate: now, countedCash: 250, idempotencyKey: crypto.randomUUID(),
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(reconciliationId)).toMatchObject({ expectedCash: 250, difference: 0 });
      const linked = await ctx.db
        .query("collectionPayments")
        .withIndex("by_reconciliation", (q) => q.eq("reconciliationId", reconciliationId))
        .collect();
      expect(linked.map((payment) => payment.amount)).toEqual([250]);
    });
  });

  test("cashier_reconciliation_refuses_a_day_it_cannot_read_completely", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const seed = await seedFinanceMember(t);
    const { orgId, asFinance } = seed;
    const now = Date.now();
    // Split across both drawer methods: the limit is on what is certified.
    await seedCashierPayments(t, seed, 499, { paymentDate: now });
    await seedCashierPayments(t, seed, 1, { paymentDate: now, method: "REFUND", direction: "OUT" });

    const draft = await asFinance.query(api.collections.getReconciliationDraft, { orgId, businessDate: now });
    expect(draft).toMatchObject({ complete: false, expectedCash: null, paymentCount: null });

    await expect(asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId, businessDate: now, countedCash: 0, idempotencyKey: "recon-too-large",
    })).rejects.toThrow("too many unreconciled payments");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("cashierReconciliations").collect()).toHaveLength(0);
      const linked = await ctx.db.query("collectionPayments").collect();
      expect(linked.filter((payment) => payment.reconciliationId !== undefined)).toHaveLength(0);
    });
  });

  test("cashier_reconciliation_refuses_a_day_whose_cash_alone_fills_the_budget", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const seed = await seedFinanceMember(t);
    const { orgId, asFinance } = seed;
    const now = Date.now();
    // CASH alone reaches the 500-document budget, so no REFUND read is issued.
    await seedCashierPayments(t, seed, 500, { paymentDate: now });

    const draft = await asFinance.query(api.collections.getReconciliationDraft, { orgId, businessDate: now });
    expect(draft).toMatchObject({ complete: false, expectedCash: null, paymentCount: null });
    await expect(asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId, businessDate: now, countedCash: 0, idempotencyKey: "recon-cash-only-too-large",
    })).rejects.toThrow("too many unreconciled payments");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("cashierReconciliations").collect()).toHaveLength(0);
    });
  });
  test("cashier_reconciliation_certifies_exactly_the_limit_across_both_methods", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const seed = await seedFinanceMember(t);
    const { orgId, asFinance } = seed;
    const now = Date.now();
    await seedCashierPayments(t, seed, 450, { paymentDate: now });
    await seedCashierPayments(t, seed, 49, { paymentDate: now, method: "REFUND", direction: "OUT" });

    const draft = await asFinance.query(api.collections.getReconciliationDraft, { orgId, businessDate: now });
    expect(draft).toMatchObject({ complete: true, expectedCash: 401, paymentCount: 499 });
  });

  test("cashier_reconciliation_limit_ignores_reconciled_voided_and_non_cash_rows", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const seed = await seedFinanceMember(t);
    const { orgId, asFinance } = seed;
    const now = Date.now();
    // A day already reconciled once must stay reconcilable: rows it linked, rows
    // since voided, and payments that never enter the drawer do not count.
    const earlierId = await asFinance.mutation(api.collections.submitCashierReconciliation, {
      orgId, businessDate: now, countedCash: 0, idempotencyKey: crypto.randomUUID(),
    });
    await seedCashierPayments(t, seed, 500, { paymentDate: now, reconciliationId: earlierId });
    await seedCashierPayments(t, seed, 500, { paymentDate: now, status: "VOIDED" });
    await seedCashierPayments(t, seed, 500, { paymentDate: now, method: "BANK_TRANSFER" });
    await seedCashierPayments(t, seed, 1, { paymentDate: now, amount: 40 });

    const draft = await asFinance.query(api.collections.getReconciliationDraft, { orgId, businessDate: now });
    expect(draft).toMatchObject({ complete: true, expectedCash: 40, paymentCount: 1 });
  });
  test("SCRUM-447 reminders never chase a finance-company cheque from the customer", async () => {
    vi.useFakeTimers();
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId } = await seedFinanceMember(t);
    const now = Date.now();
    const dueDate = now + 2 * 24 * 60 * 60 * 1000;
    const base = {
      orgId,
      customerId,
      bank: "FC Bank",
      chequeDate: dueDate,
      amount: 500,
      status: "HELD" as const,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    // One row carrying each lineage mark on its own: a drawer type, and the
    // origin anchor a replacement leaves behind. Neither has a live applicationId.
    const drawerOnly = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", { ...base, chequeNumber: "FC-D", drawerType: "FINANCE_COMPANY" as const })
    );
    const ordinary = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", { ...base, chequeNumber: "CUST-1" })
    );

    const result = await t.mutation(internal.collections.processDailyCollectionReminders, {});
    // Only the ordinary customer cheque is reminded.
    expect(result).toMatchObject({ queued: 1 });
    const reminders = await t.run((ctx) =>
      ctx.db.query("collectionReminders").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(reminders.map((r) => r.chequeId)).toEqual([ordinary]);

    // Send-time re-read: a reminder queued BEFORE the row was recognised as
    // finance-company is suppressed by the payload, not sent.
    const staleReminderId = await t.run((ctx) =>
      ctx.db.insert("collectionReminders", {
        orgId,
        customerId,
        chequeId: drawerOnly,
        channel: "SMS",
        messageType: "CHEQUE_UPCOMING",
        status: "PENDING",
        scheduledAt: now,
        createdAt: now,
      })
    );
    const payload = await t.query(internal.collections.getReminderPayload, { reminderId: staleReminderId });
    expect(payload?.fcLineageSuppressed).toBe(true);
    const ordinaryPayload = await t.query(internal.collections.getReminderPayload, { reminderId: reminders[0]._id });
    expect(ordinaryPayload?.fcLineageSuppressed).toBe(false);
  });
  test("daily_collection_reminders_queue_channels_dedupe_and_mark_results", async () => {
    // Installed before anything schedules: vitest fake timers only control
    // timers created after this call, so installing them at drain time leaves
    // the scheduler on the real clock and runAllTimers with nothing to fire.
    vi.useFakeTimers();
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    await drainScheduled(t);
    // Reminders are deliberately not asserted to leave PENDING here. The
    // scheduled send now *runs* — which is the fix — but errors inside the
    // harness with "Component rateLimiter is not registered", so it never
    // reaches markReminderResult. That is a pre-existing gap in
    // convexTestWithComponents, logged and non-fatal, and unrelated to whether
    // the drain worked. What the drain buys is that the failure happens here,
    // during the test, instead of after teardown.
  });
});

// SCRUM-807: the daily reminder cron must stay inside one mutation's read/write
// budget however large a tenant's receivable book is, WITHOUT dropping reminders
// or marking the wrong rows. These tests drive the public internal mutation and
// the scheduler only; they assert what customers and ledgers observe.
// These suites seed hundreds of receivables and cheques and drain the scheduler;
// under coverage they take 3-4.5 s each, too close to the 5 s default (SCRUM-752).
describe("daily collection reminders stay bounded without losing work (SCRUM-807)", { timeout: 30_000 }, () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 17, 6, 30);
  type Statuses = Doc<"receivables">["status"];

  function startClock() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    return convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  }
  type ReminderT = ReturnType<typeof startClock>;

  // Customers carry no phone, so every reminder is a MANUAL/SKIPPED row and no
  // provider send is scheduled: the only scheduled work left is the cron's own
  // continuation, which is exactly what these tests drain.
  async function seedOrg(t: ReminderT, label: string) {
    return await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: label, createdAt: NOW });
      const userId = await ctx.db.insert("users", {
        clerkId: `reminder_${label}`,
        email: `${label}@example.com`,
        name: label,
      });
      const customerId = await ctx.db.insert("customers", { orgId, firstName: label, lastName: "Customer" });
      return { orgId, userId, customerId };
    });
  }
  type Org = Awaited<ReturnType<typeof seedOrg>>;

  async function addReceivables(
    t: ReminderT,
    org: Org,
    count: number,
    dueDate: (index: number) => number,
    status: Statuses = "OPEN"
  ) {
    return await t.run(async (ctx) => {
      const ids: Id<"receivables">[] = [];
      for (let index = 0; index < count; index += 1) {
        const due = dueDate(index);
        ids.push(await ctx.db.insert("receivables", {
          orgId: org.orgId,
          customerId: org.customerId,
          sourceType: "INTERNAL_INSTALLMENT",
          title: `Receivable ${index}`,
          originalAmount: 100,
          outstandingAmount: 100,
          dueDate: due,
          status,
          createdBy: org.userId,
          createdAt: NOW,
          updatedAt: NOW,
        }));
      }
      return ids;
    });
  }

  async function addCheques(
    t: ReminderT,
    org: Org,
    count: number,
    chequeDate: (index: number) => number,
    extra: Partial<Doc<"postDatedCheques">> = {}
  ) {
    return await t.run(async (ctx) => {
      const ids: Id<"postDatedCheques">[] = [];
      for (let index = 0; index < count; index += 1) {
        ids.push(await ctx.db.insert("postDatedCheques", {
          orgId: org.orgId,
          customerId: org.customerId,
          bank: "Bound Bank",
          chequeNumber: `CHQ-${extra.drawerType ?? "C"}-${index}-${chequeDate(index)}`,
          chequeDate: chequeDate(index),
          amount: 50,
          status: "HELD",
          createdBy: org.userId,
          createdAt: NOW,
          updatedAt: NOW,
          ...extra,
        }));
      }
      return ids;
    });
  }

  async function remindersFor(t: ReminderT, orgId: Id<"organizations">) {
    return await t.run((ctx) =>
      ctx.db.query("collectionReminders").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
  }

  async function runCronToCompletion(t: ReminderT) {
    const first = await t.mutation(internal.collections.processDailyCollectionReminders, {});
    await drainScheduled(t);
    return first;
  }

  function receivableReminderCounts(reminders: Doc<"collectionReminders">[]) {
    const counts = new Map<string, number>();
    for (const reminder of reminders) {
      if (!reminder.receivableId || reminder.chequeId) continue;
      counts.set(reminder.receivableId, (counts.get(reminder.receivableId) ?? 0) + 1);
    }
    return counts;
  }

  test.each([
    ["customer", "deleted"], ["customer", "missing"],
    ["receivable", "deleted"], ["receivable", "missing"],
    ["cheque", "deleted"], ["cheque", "missing"],
  ] as const)("queued reminders skip a %s that becomes %s before the payload read", async (kind, state) => {
    await import("./collectionReminderActions");
    const t = startClock();
    const org = await seedOrg(t, `queued-${kind}-${state}`);
    const [receivableId] = await addReceivables(t, org, 1, () => NOW + DAY);
    const [chequeId] = await addCheques(t, org, 1, () => NOW + DAY);
    const reminderId = await t.run(async (ctx) => {
      await ctx.db.patch(org.customerId, { phone: "+15550000001" });
      const id = await ctx.db.insert("collectionReminders", {
        orgId: org.orgId, customerId: org.customerId,
        receivableId: kind === "cheque" ? undefined : receivableId,
        chequeId: kind === "cheque" ? chequeId : undefined,
        channel: "SMS", messageType: kind === "cheque" ? "CHEQUE_UPCOMING" : "DUE_SOON",
        status: "PENDING", scheduledAt: NOW, createdAt: NOW,
      });
      const sourceId = kind === "customer" ? org.customerId : kind === "cheque" ? chequeId : receivableId;
      if (state === "deleted") await ctx.db.patch(sourceId, { isDeleted: true });
      else await ctx.db.delete(sourceId);
      return id;
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 201 }));
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "synthetic-account");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "synthetic-token");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550000000");
    try {
      await t.action(internal.collectionReminderActions.sendCollectionReminder, { reminderId });
      expect(request).not.toHaveBeenCalled();
      const reminder = await t.run((ctx) => ctx.db.get(reminderId));
      expect(reminder?.status).toBe("SKIPPED");
      expect(reminder?.sentAt).toBeUndefined();
    } finally {
      request.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  test.each(["overdue", "dueSoon", "cheque"] as const)(
    "soft-deleted %s rows are never chased or changed by the reminder sweep",
    async (kind) => {
      const t = startClock();
      const org = await seedOrg(t, `deleted-${kind}`);
      const ids = kind === "cheque"
        ? await addCheques(t, org, 3, () => NOW + DAY)
        : await addReceivables(t, org, 3, () => kind === "overdue" ? NOW - DAY : NOW + DAY);
      await t.run(async (ctx) => {
        await ctx.db.patch(ids[1], { isDeleted: false });
        await ctx.db.patch(ids[2], { isDeleted: true });
      });
      const before = await t.run((ctx) => ctx.db.get(ids[2]));

      await runCronToCompletion(t);

      const reminders = await remindersFor(t, org.orgId);
      expect(reminders.map((r) => r.chequeId ?? r.receivableId).sort()).toEqual(ids.slice(0, 2).sort());
      expect(await t.run((ctx) => ctx.db.get(ids[2]))).toEqual(before);
      for (const id of ids.slice(0, 2)) {
        expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject(kind === "cheque"
          ? { amount: 50, status: "HELD" }
          : { originalAmount: 100, outstandingAmount: 100, status: kind === "overdue" ? "OVERDUE" : "OPEN" });
      }
    }
  );

  test("missing and false live cohorts both finish overflow pages without chasing deleted history", async () => {
    const t = startClock();
    const org = await seedOrg(t, "live-cohorts");
    const missing = await addReceivables(t, org, 220, () => NOW + DAY);
    const explicitFalse = await addReceivables(t, org, 220, () => NOW + DAY);
    const deleted = await addReceivables(t, org, 250, () => NOW + DAY);
    await t.run(async (ctx) => {
      for (const id of explicitFalse) await ctx.db.patch(id, { isDeleted: false });
      for (const id of deleted) await ctx.db.patch(id, { isDeleted: true });
    });
    await runCronToCompletion(t);
    const counts = receivableReminderCounts(await remindersFor(t, org.orgId));
    expect([...counts.keys()].sort()).toEqual([...missing, ...explicitFalse].sort());
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(deleted[0]))).toMatchObject({ isDeleted: true, status: "OPEN", outstandingAmount: 100 });
  });

  test("an old index cursor continues on its original index and skips a subsequently deleted row", async () => {
    const t = startClock();
    const org = await seedOrg(t, "legacy-cursor");
    const ids = await addReceivables(t, org, 450, () => NOW + DAY);
    const oldPage = await t.run((ctx) => ctx.db.query("receivables")
      .withIndex("by_org_status_and_dueDate", (q) => q.eq("orgId", org.orgId).eq("status", "OPEN").gt("dueDate", NOW).lte("dueDate", NOW + 2 * DAY))
      .paginate({ cursor: null, numItems: 180 }));
    expect(oldPage.isDone).toBe(false);
    await t.run(async (ctx) => {
      for (const row of oldPage.page) await ctx.db.insert("collectionReminders", {
        orgId: org.orgId, customerId: org.customerId, receivableId: row._id,
        channel: "MANUAL", messageType: "DUE_SOON", status: "SKIPPED", scheduledAt: NOW, createdAt: NOW,
      });
      await ctx.db.patch(ids[220], { isDeleted: true });
      await ctx.db.patch(ids[230], { isDeleted: false });
    });
    const first = await t.mutation(internal.collections.processReminderRange, {
      orgId: org.orgId, step: 1, now: NOW, cursor: oldPage.continueCursor,
    });
    expect(first.isDone).toBe(false);
    await drainScheduled(t);
    const counts = receivableReminderCounts(await remindersFor(t, org.orgId));
    expect([...counts.keys()].sort()).toEqual(ids.filter((id) => id !== ids[220]).sort());
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  test("an overdue book larger than one invocation is fully marked and reminded exactly once", async () => {
    const t = startClock();
    const org = await seedOrg(t, "bigoverdue");
    const ids = await addReceivables(t, org, 260, (i) => NOW - DAY - i * 1_000);

    const first = await runCronToCompletion(t);
    // One invocation never swallows the whole book...
    expect(first.markedOverdue).toBeLessThan(260);

    // ...yet the continuation chain reaches every row.
    const rows = await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
    expect(rows.every((row) => row?.status === "OVERDUE")).toBe(true);
    const counts = receivableReminderCounts(await remindersFor(t, org.orgId));
    expect(counts.size).toBe(260);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);

    // Replaying the whole cron is idempotent: nothing is re-marked or re-sent.
    await runCronToCompletion(t);
    expect(await remindersFor(t, org.orgId)).toHaveLength(260);
  });

  test("a due-soon window larger than one invocation reminds every row and marks none overdue", async () => {
    const t = startClock();
    const org = await seedOrg(t, "bigduesoon");
    const ids = await addReceivables(t, org, 150, (i) => NOW + 60_000 + i * 60_000);

    await runCronToCompletion(t);

    const reminders = await remindersFor(t, org.orgId);
    expect(reminders).toHaveLength(150);
    expect(reminders.every((reminder) => reminder.messageType === "DUE_SOON")).toBe(true);
    expect(receivableReminderCounts(reminders).size).toBe(150);
    const rows = await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
    expect(rows.every((row) => row?.status === "OPEN")).toBe(true);
  });

  test("hundreds of rows sharing one due date are neither skipped nor duplicated across continuations", async () => {
    const t = startClock();
    const org = await seedOrg(t, "tiedates");
    await addReceivables(t, org, 130, () => NOW + DAY);
    await addCheques(t, org, 130, () => NOW + 2 * DAY);

    await runCronToCompletion(t);

    const reminders = await remindersFor(t, org.orgId);
    expect(reminders.filter((r) => r.messageType === "DUE_SOON")).toHaveLength(130);
    expect(reminders.filter((r) => r.messageType === "CHEQUE_UPCOMING")).toHaveLength(130);
    expect([...receivableReminderCounts(reminders).values()].every((n) => n === 1)).toBe(true);
    const chequeIds = reminders.filter((r) => r.chequeId).map((r) => r.chequeId);
    expect(new Set(chequeIds).size).toBe(130);
  });

  test("overdue, due-soon and cheque cohorts across every active status all complete", async () => {
    const t = startClock();
    const org = await seedOrg(t, "allstatuses");
    const statuses: Statuses[] = ["OPEN", "PARTIALLY_PAID", "RESCHEDULED"];
    for (const status of statuses) {
      await addReceivables(t, org, 120, (i) => NOW - DAY - i * 1_000, status);
      await addReceivables(t, org, 120, (i) => NOW + 60_000 + i * 1_000, status);
    }
    await addCheques(t, org, 120, (i) => NOW + DAY + i * 1_000);

    await runCronToCompletion(t);

    const reminders = await remindersFor(t, org.orgId);
    expect(reminders.filter((r) => r.messageType === "OVERDUE")).toHaveLength(360);
    expect(reminders.filter((r) => r.messageType === "DUE_SOON")).toHaveLength(360);
    expect(reminders.filter((r) => r.messageType === "CHEQUE_UPCOMING")).toHaveLength(120);
    const overdueLeft = await t.run(async (ctx) =>
      (await ctx.db.query("receivables").withIndex("by_org_status_and_dueDate", (q) =>
        q.eq("orgId", org.orgId).eq("status", "OVERDUE")).collect()).length
    );
    expect(overdueLeft).toBe(360);
  });

  test("distant-future receivables and cheques are never reminded or marked", async () => {
    const t = startClock();
    const org = await seedOrg(t, "pollution");
    const inWindow = await addReceivables(t, org, 3, (i) => NOW + DAY + i);
    const justOutside = await addReceivables(t, org, 1, () => NOW + 2 * DAY + 1);
    const distant = await addReceivables(t, org, 400, (i) => NOW + 5 * DAY + i * DAY);
    const chequeIn = await addCheques(t, org, 2, (i) => NOW + DAY + i);
    await addCheques(t, org, 300, (i) => NOW + 3 * DAY + 1 + i * DAY);

    await runCronToCompletion(t);

    const reminders = await remindersFor(t, org.orgId);
    const remindedReceivables = new Set(reminders.map((r) => r.receivableId).filter(Boolean));
    expect(remindedReceivables).toEqual(new Set(inWindow));
    expect(new Set(reminders.map((r) => r.chequeId).filter(Boolean))).toEqual(new Set(chequeIn));
    const untouched = await t.run((ctx) => Promise.all([...justOutside, ...distant].map((id) => ctx.db.get(id))));
    expect(untouched.every((row) => row?.status === "OPEN" && row.updatedAt === NOW)).toBe(true);
  });

  test("a long run of finance-company cheques cannot hide the customer cheques behind it", async () => {
    const t = startClock();
    const org = await seedOrg(t, "fclineage");
    const fcIds = await addCheques(t, org, 120, (i) => NOW + DAY + i, { drawerType: "FINANCE_COMPANY" });
    const ordinary = await addCheques(t, org, 40, (i) => NOW + 2 * DAY + i);

    await runCronToCompletion(t);

    const reminders = await remindersFor(t, org.orgId);
    const chased = new Set(reminders.map((r) => r.chequeId).filter(Boolean));
    expect(chased).toEqual(new Set(ordinary));
    for (const fcId of fcIds) expect(chased.has(fcId)).toBe(false);
  });

  test("exact window boundaries: overdue, due-soon and cheque edges are inclusive where specified", async () => {
    const t = startClock();
    const org = await seedOrg(t, "boundaries");
    const [atNow] = await addReceivables(t, org, 1, () => NOW);
    const [justPast] = await addReceivables(t, org, 1, () => NOW - 1);
    const [justAhead] = await addReceivables(t, org, 1, () => NOW + 1);
    const [dueSoonEdge] = await addReceivables(t, org, 1, () => NOW + 2 * DAY);
    const [pastDueSoonEdge] = await addReceivables(t, org, 1, () => NOW + 2 * DAY + 1);
    const [partial] = await addReceivables(t, org, 1, () => NOW - DAY, "PARTIALLY_PAID");
    const [rescheduled] = await addReceivables(t, org, 1, () => NOW + DAY, "RESCHEDULED");
    const [alreadyOverdue] = await addReceivables(t, org, 1, () => NOW - DAY, "OVERDUE");
    const [paid] = await addReceivables(t, org, 1, () => NOW - DAY, "PAID");
    const [chequePast] = await addCheques(t, org, 1, () => NOW - 1);
    const [chequeAtNow] = await addCheques(t, org, 1, () => NOW);
    const [chequeEdge] = await addCheques(t, org, 1, () => NOW + 3 * DAY);
    const [chequePastEdge] = await addCheques(t, org, 1, () => NOW + 3 * DAY + 1);
    const [deposited] = await addCheques(t, org, 1, () => NOW + DAY, { status: "DEPOSITED" });

    await runCronToCompletion(t);

    const reminders = await remindersFor(t, org.orgId);
    const typeOf = (id: Id<"receivables">) => reminders.find((r) => r.receivableId === id && !r.chequeId)?.messageType;
    expect(typeOf(atNow)).toBe("OVERDUE");
    expect(typeOf(justPast)).toBe("OVERDUE");
    expect(typeOf(partial)).toBe("OVERDUE");
    expect(typeOf(justAhead)).toBe("DUE_SOON");
    expect(typeOf(dueSoonEdge)).toBe("DUE_SOON");
    expect(typeOf(rescheduled)).toBe("DUE_SOON");
    expect(typeOf(pastDueSoonEdge)).toBeUndefined();
    expect(typeOf(alreadyOverdue)).toBeUndefined();
    expect(typeOf(paid)).toBeUndefined();
    const chequeChased = (id: Id<"postDatedCheques">) => reminders.some((r) => r.chequeId === id);
    expect(chequeChased(chequeAtNow)).toBe(true);
    expect(chequeChased(chequeEdge)).toBe(true);
    expect(chequeChased(chequePast)).toBe(false);
    expect(chequeChased(chequePastEdge)).toBe(false);
    expect(chequeChased(deposited)).toBe(false);
    const marked = await t.run((ctx) => Promise.all([atNow, justPast, partial, justAhead].map((id) => ctx.db.get(id))));
    expect(marked.map((row) => row?.status)).toEqual(["OVERDUE", "OVERDUE", "OVERDUE", "OPEN"]);
  });

  test("a giant tenant does not starve the tenants behind it, and every tenant ends complete and isolated", async () => {
    const t = startClock();
    const giant = await seedOrg(t, "giant");
    const giantIds = await addReceivables(t, giant, 300, (i) => NOW - DAY - i * 1_000);
    const small: Org[] = [];
    // 54 small tenants: more than one organization page, so the org cursor is exercised too.
    for (let index = 0; index < 54; index += 1) {
      const org = await seedOrg(t, `small${index}`);
      await addReceivables(t, org, 2, () => NOW - DAY);
      small.push(org);
    }

    const first = await t.mutation(internal.collections.processDailyCollectionReminders, {});
    expect(first.isDone).toBe(false);
    // After ONE invocation the tenants on the first organization page are fully
    // served even though the giant tenant still has work outstanding.
    for (const org of small.slice(0, 40)) {
      expect(await remindersFor(t, org.orgId)).toHaveLength(2);
    }
    const giantAfterFirst = await t.run((ctx) => Promise.all(giantIds.map((id) => ctx.db.get(id))));
    expect(giantAfterFirst.filter((row) => row?.status === "OVERDUE").length).toBeLessThan(300);

    await drainScheduled(t);

    for (const org of small) {
      const reminders = await remindersFor(t, org.orgId);
      expect(reminders).toHaveLength(2);
      const own = await t.run(async (ctx) =>
        Promise.all(reminders.map(async (r) => (await ctx.db.get(r.receivableId!))?.orgId))
      );
      expect(own.every((id) => id === org.orgId)).toBe(true);
    }
    const giantCounts = receivableReminderCounts(await remindersFor(t, giant.orgId));
    expect(giantCounts.size).toBe(300);
    expect([...giantCounts.values()].every((n) => n === 1)).toBe(true);
    const total = await t.run(async (ctx) => (await ctx.db.query("collectionReminders").collect()).length);
    expect(total).toBe(300 + 54 * 2);
  });

  describe("large windows continue on native pagination cursors", () => {
    async function pendingFunctions(t: ReminderT) {
      const rows = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      return rows.filter((row) => row.state.kind === "pending");
    }

    test("a static cohort several pages long is reminded exactly once per row, however many share a date", async () => {
      const t = startClock();
      const org = await seedOrg(t, "multipage");
      // 450 rows on ONE due date and 450 cheques on ONE cheque date: more than two
      // 200-row pages each, with every row tied on the window's sort field.
      const receivables = await addReceivables(t, org, 450, () => NOW + DAY);
      const cheques = await addCheques(t, org, 450, () => NOW + 2 * DAY);

      await runCronToCompletion(t);

      const reminders = await remindersFor(t, org.orgId);
      const receivableCounts = receivableReminderCounts(reminders);
      expect(receivableCounts.size).toBe(450);
      expect(receivables.every((id) => receivableCounts.get(id) === 1)).toBe(true);
      const chequeCounts = new Map<string, number>();
      for (const reminder of reminders) {
        if (reminder.chequeId) chequeCounts.set(reminder.chequeId, (chequeCounts.get(reminder.chequeId) ?? 0) + 1);
      }
      expect(chequeCounts.size).toBe(450);
      expect(cheques.every((id) => chequeCounts.get(id) === 1)).toBe(true);
    });

    test("rows deleted and inserted between two hops of one window never cause a surviving row to be skipped", async () => {
      const t = startClock();
      const org = await seedOrg(t, "betweenhops");
      const initial = await addReceivables(t, org, 450, () => NOW + DAY);

      // First hop only: the child handles one page and leaves its continuation pending.
      await t.mutation(internal.collections.processReminderRange, {
        orgId: org.orgId, step: 1, cursor: null, now: NOW,
      });
      expect(await pendingFunctions(t)).toHaveLength(1);
      const handledFirst = new Set(
        (await remindersFor(t, org.orgId)).map((reminder) => reminder.receivableId)
      );
      expect(handledFirst.size).toBeGreaterThan(0);
      expect(handledFirst.size).toBeLessThan(450);

      // Between hops: drop rows on both sides of the cursor, add rows sharing the date.
      const handled = initial.filter((id) => handledFirst.has(id));
      const unhandled = initial.filter((id) => !handledFirst.has(id));
      const removed = [...handled.slice(0, 5), ...unhandled.slice(0, 5), ...unhandled.slice(-5)];
      await t.run(async (ctx) => {
        for (const id of removed) await ctx.db.delete(id);
      });
      const added = await addReceivables(t, org, 30, () => NOW + DAY);

      await drainScheduled(t);

      const counts = receivableReminderCounts(await remindersFor(t, org.orgId));
      const survivors = [...initial.filter((id) => !removed.includes(id)), ...added];
      expect(survivors.every((id) => counts.get(id) === 1)).toBe(true);
      expect(removed.filter((id) => !handledFirst.has(id) && counts.has(id))).toEqual([]);
    });

    test("tenants whose windows fit never schedule a child function", async () => {
      const t = startClock();
      for (let index = 0; index < 49; index += 1) {
        const org = await seedOrg(t, `fits${index}`);
        await addReceivables(t, org, 1, () => NOW - DAY);
        await addReceivables(t, org, 1, () => NOW + DAY);
        await addReceivables(t, org, 1, () => NOW + DAY, "PARTIALLY_PAID");
        await addCheques(t, org, 1, () => NOW + DAY);
      }

      const first = await t.mutation(internal.collections.processDailyCollectionReminders, {});

      expect(first).toMatchObject({ isDone: true, queued: 49 * 4, markedOverdue: 49 });
      expect(await pendingFunctions(t)).toHaveLength(0);
    });

    test("a sweep of fifty worst-case tenants schedules exactly 50 x (15 + 1) + 1 functions", async () => {
      const t = startClock();
      for (let index = 0; index < 50; index += 1) {
        const org = await seedOrg(t, `heavy${index}`);
        // A phone makes every reminder schedule a provider send.
        await t.run((ctx) => ctx.db.patch(org.customerId, { phone: "+962790000009" }));
        // Worst case for one org: 11 overdue sends, a due-soon window too big for the
        // 4 units left (one child), then 3 more overdue sends exhaust the 15-unit
        // budget with the next overdue step still overflowing (one resume).
        await addReceivables(t, org, 11, (i) => NOW - DAY - i * 1_000);
        await addReceivables(t, org, 20, (i) => NOW + DAY + i * 1_000);
        await addReceivables(t, org, 10, (i) => NOW - DAY - i * 1_000, "PARTIALLY_PAID");
      }
      // The 51st tenant forces the sweep's own next-page continuation.
      await seedOrg(t, "heavy50");

      const first = await t.mutation(internal.collections.processDailyCollectionReminders, {});

      expect(first.isDone).toBe(false);
      // Per org: 14 sends + 1 window child + 1 resume = 16 (the 15 budget units plus the
      // resume); plus the single page continuation. 50 * 16 + 1, below the 1000 limit.
      expect(await pendingFunctions(t)).toHaveLength(801);
      // Seeds 50 tenants x 41 rows: about 3s on an idle machine, past the 5s default
      // under CI load, so it carries the explicit budget other heavy suites use.
    }, 30_000);

    test("a window step that is not a due-soon or cheque window is rejected before anything is read", async () => {
      const t = startClock();
      const org = await seedOrg(t, "badstep");
      const [due] = await addReceivables(t, org, 1, () => NOW - DAY);

      for (const step of [0, 7, -1, 1.5]) {
        await expect(
          t.mutation(internal.collections.processReminderRange, { orgId: org.orgId, step, cursor: null, now: NOW })
        ).rejects.toThrow("Invalid collection reminder window step");
      }
      expect((await t.run((ctx) => ctx.db.get(due)))?.status).toBe("OPEN");
      expect(await remindersFor(t, org.orgId)).toHaveLength(0);
    });

    test("an invalid resume step is rejected without touching any row", async () => {
      const t = startClock();
      const org = await seedOrg(t, "badresume");
      const [due] = await addReceivables(t, org, 1, () => NOW - DAY);

      // The live missing/false cohorts now occupy steps0..13; step7 is valid.
      for (const step of [14, -1, 1.5, Number.NaN]) {
        await expect(
          t.mutation(internal.collections.processDailyCollectionReminders, { now: NOW, resume: { orgId: org.orgId, step } })
        ).rejects.toThrow("Invalid collection reminder resume step");
      }
      expect((await t.run((ctx) => ctx.db.get(due)))?.status).toBe("OPEN");
      expect(await remindersFor(t, org.orgId)).toHaveLength(0);
    });

    test("every scheduled hop keeps the sweep's original now when the wall clock moves on", async () => {
      const t = startClock();
      // First org: overdue overflow (=> resume hop), then a 300-row due-soon window (=> child hops,
      // more than one 200-row page). 49 small orgs fill the first page; the last org only exists
      // on the sweep's page-continuation hop.
      const big = await seedOrg(t, "anchorbig");
      const overdue = await addReceivables(t, big, 20, (i) => NOW - DAY - i * 1_000);
      const bigDue = await addReceivables(t, big, 300, (i) => NOW + DAY + i * 1_000);
      const smallDue: Id<"receivables">[] = [];
      for (let index = 0; index < 50; index += 1) {
        const org = await seedOrg(t, `anchorsmall${index}`);
        smallDue.push(...(await addReceivables(t, org, 1, () => NOW + DAY)));
      }

      await t.mutation(internal.collections.processDailyCollectionReminders, {});
      // Two days later every continuation would see the due-soon rows as already overdue
      // (or outside the window) if it recomputed now instead of carrying the sweep's.
      vi.setSystemTime(NOW + 2 * DAY);
      await drainScheduled(t);

      const rows = await t.run(async (ctx) => ({
        overdue: await Promise.all(overdue.map((id) => ctx.db.get(id))),
        due: await Promise.all([...bigDue, ...smallDue].map((id) => ctx.db.get(id))),
        reminders: await ctx.db.query("collectionReminders").collect(),
      }));
      expect(rows.overdue.every((row) => row?.status === "OVERDUE" && row.updatedAt === NOW)).toBe(true);
      expect(rows.due.every((row) => row?.status === "OPEN")).toBe(true);
      const dueSoon = new Map<string, number>();
      for (const reminder of rows.reminders) {
        if (reminder.messageType === "DUE_SOON" && reminder.receivableId) {
          dueSoon.set(reminder.receivableId, (dueSoon.get(reminder.receivableId) ?? 0) + 1);
        }
      }
      expect(dueSoon.size).toBe(350);
      expect([...bigDue, ...smallDue].every((id) => dueSoon.get(id) === 1)).toBe(true);
      expect(rows.reminders.filter((r) => r.messageType === "OVERDUE")).toHaveLength(20);
    });
  });

  describe("the 20-hour cooldown reads the exact recent rows, never a prefix of history", () => {
    const COOLDOWN = 20 * 60 * 60 * 1000;
    type Reminder = Doc<"collectionReminders">;

    async function addHistory(
      t: ReminderT,
      org: Org,
      spec: {
        receivableId?: Id<"receivables">;
        chequeId?: Id<"postDatedCheques">;
        messageType: Reminder["messageType"];
        status: Reminder["status"];
        createdAt: number;
        count?: number;
      }
    ) {
      await t.run(async (ctx) => {
        for (let index = 0; index < (spec.count ?? 1); index += 1) {
          await ctx.db.insert("collectionReminders", {
            orgId: org.orgId,
            customerId: org.customerId,
            receivableId: spec.receivableId,
            chequeId: spec.chequeId,
            channel: "MANUAL",
            messageType: spec.messageType,
            status: spec.status,
            scheduledAt: spec.createdAt,
            createdAt: spec.createdAt,
          });
        }
      });
    }

    async function newRowsFor(
      t: ReminderT,
      org: Org,
      match: (reminder: Reminder) => boolean,
      seeded: number
    ) {
      const all = await remindersFor(t, org.orgId);
      return all.filter(match).length - seeded;
    }

    test("a recent valid row behind hundreds of older rows still suppresses a receivable reminder", async () => {
      const t = startClock();
      const org = await seedOrg(t, "longhist");
      const [due] = await addReceivables(t, org, 1, () => NOW + DAY);
      // Hundreds of expired rows first (oldest in _creationTime order), then the
      // one row inside the cooldown. A reader that caps a prefix never sees it.
      await addHistory(t, org, { receivableId: due, messageType: "DUE_SOON", status: "SENT", createdAt: NOW - 30 * DAY, count: 300 });
      await addHistory(t, org, { receivableId: due, messageType: "DUE_SOON", status: "SENT", createdAt: NOW - 3_600_000 });

      await runCronToCompletion(t);

      expect(await newRowsFor(t, org, (r) => r.receivableId === due, 301)).toBe(0);
    });

    test.each(["PENDING", "SENT", "SKIPPED"] as const)(
      "a recent %s row suppresses; a recent FAILED run in front of it does not hide it",
      async (status) => {
        const t = startClock();
        const org = await seedOrg(t, `dedupe${status}`);
        const [due] = await addReceivables(t, org, 1, () => NOW + DAY);
        await addHistory(t, org, { receivableId: due, messageType: "DUE_SOON", status: "FAILED", createdAt: NOW - 3_600_000, count: 120 });
        await addHistory(t, org, { receivableId: due, messageType: "DUE_SOON", status, createdAt: NOW - 2 * 3_600_000 });

        await runCronToCompletion(t);

        expect(await newRowsFor(t, org, (r) => r.receivableId === due, 121)).toBe(0);
      }
    );

    test("recent FAILED rows alone, or an expired valid row, never suppress a fresh reminder", async () => {
      const t = startClock();
      const org = await seedOrg(t, "failedonly");
      const [failedOnly] = await addReceivables(t, org, 1, () => NOW + DAY);
      const [expiredValid] = await addReceivables(t, org, 1, () => NOW + DAY);
      await addHistory(t, org, { receivableId: failedOnly, messageType: "DUE_SOON", status: "FAILED", createdAt: NOW - 1_000, count: 150 });
      await addHistory(t, org, { receivableId: expiredValid, messageType: "DUE_SOON", status: "SENT", createdAt: NOW - COOLDOWN - 1 });
      await addHistory(t, org, { receivableId: expiredValid, messageType: "DUE_SOON", status: "FAILED", createdAt: NOW - 1_000 });

      await runCronToCompletion(t);

      expect(await newRowsFor(t, org, (r) => r.receivableId === failedOnly, 150)).toBe(1);
      expect(await newRowsFor(t, org, (r) => r.receivableId === expiredValid, 2)).toBe(1);
    });

    test("the cooldown edge is inclusive: exactly 20h old suppresses, 1ms older does not", async () => {
      const t = startClock();
      const org = await seedOrg(t, "edge");
      const [onEdge, pastEdge] = await addReceivables(t, org, 2, () => NOW + DAY);
      const [chequeOnEdge, chequePastEdge] = await addCheques(t, org, 2, (i) => NOW + DAY + i);
      await addHistory(t, org, { receivableId: onEdge, messageType: "DUE_SOON", status: "SENT", createdAt: NOW - COOLDOWN });
      await addHistory(t, org, { receivableId: pastEdge, messageType: "DUE_SOON", status: "SENT", createdAt: NOW - COOLDOWN - 1 });
      await addHistory(t, org, { chequeId: chequeOnEdge, messageType: "CHEQUE_UPCOMING", status: "PENDING", createdAt: NOW - COOLDOWN });
      await addHistory(t, org, { chequeId: chequePastEdge, messageType: "CHEQUE_UPCOMING", status: "PENDING", createdAt: NOW - COOLDOWN - 1 });

      await runCronToCompletion(t);

      expect(await newRowsFor(t, org, (r) => r.receivableId === onEdge, 1)).toBe(0);
      expect(await newRowsFor(t, org, (r) => r.receivableId === pastEdge, 1)).toBe(1);
      expect(await newRowsFor(t, org, (r) => r.chequeId === chequeOnEdge, 1)).toBe(0);
      expect(await newRowsFor(t, org, (r) => r.chequeId === chequePastEdge, 1)).toBe(1);
    });

    test("cheque history is read per cheque: long history, FAILED in front, and no match from a sibling cheque", async () => {
      const t = startClock();
      const org = await seedOrg(t, "chequehist");
      const [shared] = await addReceivables(t, org, 1, () => NOW + 30 * DAY);
      const [suppressed, sibling, failedFront] = await addCheques(t, org, 3, (i) => NOW + DAY + i, { receivableId: shared });
      await addHistory(t, org, { chequeId: suppressed, receivableId: shared, messageType: "CHEQUE_UPCOMING", status: "SENT", createdAt: NOW - 30 * DAY, count: 250 });
      await addHistory(t, org, { chequeId: suppressed, receivableId: shared, messageType: "CHEQUE_UPCOMING", status: "SENT", createdAt: NOW - 3_600_000 });
      await addHistory(t, org, { chequeId: failedFront, receivableId: shared, messageType: "CHEQUE_UPCOMING", status: "FAILED", createdAt: NOW - 1_000, count: 120 });
      await addHistory(t, org, { chequeId: failedFront, receivableId: shared, messageType: "CHEQUE_UPCOMING", status: "SKIPPED", createdAt: NOW - 3_600_000 });

      await runCronToCompletion(t);

      expect(await newRowsFor(t, org, (r) => r.chequeId === suppressed, 251)).toBe(0);
      expect(await newRowsFor(t, org, (r) => r.chequeId === failedFront, 121)).toBe(0);
      // The sibling shares the receivable but has no reminder of its own.
      expect(await newRowsFor(t, org, (r) => r.chequeId === sibling, 0)).toBe(1);
    });

    test("returning two cheques of one receivable reminds the customer once per cheque", async () => {
      // CHEQUE_RETURNED carries both ids; its cooldown is keyed by the cheque, so the
      // first bounce must not swallow the second cheque's notice (it did when keyed by receivable).
      const t = startClock();
      const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);
      const receivableId = await insertReceivable(t, { orgId, customerId, createdBy: userId, dueDate: NOW + 30 * DAY });
      const [first, second] = await t.run(async (ctx) => {
        const ids: Id<"postDatedCheques">[] = [];
        for (const chequeNumber of ["RET-1", "RET-2"]) {
          ids.push(await ctx.db.insert("postDatedCheques", {
            orgId, customerId, receivableId, bank: "Return Bank", chequeNumber,
            chequeDate: NOW + DAY, amount: 50, status: "HELD",
            createdBy: userId, createdAt: NOW, updatedAt: NOW,
          }));
        }
        return ids;
      });

      await asFinance.mutation(api.collections.returnCheque, { orgId, chequeId: first, returnReason: "NSF" });
      await asFinance.mutation(api.collections.returnCheque, { orgId, chequeId: second, returnReason: "NSF" });

      const returned = (await t.run((ctx) =>
        ctx.db.query("collectionReminders").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
      )).filter((reminder) => reminder.messageType === "CHEQUE_RETURNED");
      expect(returned.map((reminder) => reminder.chequeId).sort()).toEqual([first, second].sort());
    });

    test("another document's or another message type's recent row never suppresses", async () => {
      const t = startClock();
      const org = await seedOrg(t, "isolation");
      const [target, neighbour] = await addReceivables(t, org, 2, () => NOW + DAY);
      const [cheque, neighbourCheque] = await addCheques(t, org, 2, (i) => NOW + DAY + i);
      await addHistory(t, org, { receivableId: neighbour, messageType: "DUE_SOON", status: "SENT", createdAt: NOW - 1_000 });
      await addHistory(t, org, { receivableId: target, messageType: "OVERDUE", status: "SENT", createdAt: NOW - 1_000 });
      await addHistory(t, org, { chequeId: neighbourCheque, messageType: "CHEQUE_UPCOMING", status: "SENT", createdAt: NOW - 1_000 });
      await addHistory(t, org, { chequeId: cheque, messageType: "CHEQUE_RETURNED", status: "SENT", createdAt: NOW - 1_000 });

      await runCronToCompletion(t);

      const reminders = await remindersFor(t, org.orgId);
      expect(reminders.filter((r) => r.receivableId === target && r.messageType === "DUE_SOON")).toHaveLength(1);
      expect(reminders.filter((r) => r.receivableId === neighbour && r.messageType === "DUE_SOON")).toHaveLength(1);
      expect(reminders.filter((r) => r.chequeId === cheque && r.messageType === "CHEQUE_UPCOMING")).toHaveLength(1);
      expect(reminders.filter((r) => r.chequeId === neighbourCheque && r.messageType === "CHEQUE_UPCOMING")).toHaveLength(1);
    });
  });
});

describe("refund eligibility", () => {
  test("a cancelled, never-paid receivable cannot be refunded", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);

    // Nothing was ever collected against this receivable.
    const receivableId = await insertReceivable(t, {
      orgId,
      customerId,
      amount: 10_000,
      status: "OPEN",
      createdBy: userId,
    });

    // Writing it off zeroes outstandingAmount and marks it CANCELLED.
    const cancelRequestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Customer defaulted; writing off",
    });
    await asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
      orgId,
      requestId: cancelRequestId,
      status: "APPROVED",
    });

    const cancelled = await t.run((ctx) => ctx.db.get(receivableId));
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.outstandingAmount).toBe(0);

    // paidAmount is derived as originalAmount - outstandingAmount, so a
    // cancelled receivable looks fully paid. Refunding it would disburse real
    // cash and post a GL refund for money that was never collected.
    await expect(
      asFinance.mutation(api.collections.requestApproval, {
        orgId,
        receivableId,
        requestType: "REFUND",
        requestedAmount: 10_000,
        disbursementMethod: "CASH",
        reason: "Refund",
      })
    ).rejects.toThrow(/cancel/i);
  });


  test("a receivable cancelled while a refund request is pending cannot be approved", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, customerId, userId, asFinance, asApprover } = await seedFinanceMember(t);

    // 4,000 of 10,000 genuinely collected, so the refund request is valid now.
    const receivableId = await insertReceivable(t, {
      orgId,
      customerId,
      amount: 10_000,
      outstandingAmount: 6_000,
      status: "PARTIALLY_PAID",
      createdBy: userId,
    });

    const refundRequestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 4_000,
      disbursementMethod: "CASH",
      reason: "Customer returned the vehicle",
    });

    // The receivable is written off while the request sits PENDING, which
    // zeroes outstandingAmount and makes paidAmount read as the full 10,000.
    await t.run((ctx) =>
      ctx.db.patch(receivableId, { status: "CANCELLED", outstandingAmount: 0 })
    );

    await expect(
      asApprover.mutation(api.collections.respondToApproval, { idempotencyKey: crypto.randomUUID(),
        orgId,
        requestId: refundRequestId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/cancelled/i);
  });
});

/**
 * SCRUM-263: recordPayment is a receipt door. It accepted DEPOSIT_APPLIED,
 * stored a POSTED inbound payment, reduced the debt and posted it through the
 * cash-on-hand default, so applying a deposit invented cash that never arrived
 * and left the real deposit free to be applied a second time. A deposit is
 * applied from the deal, by the typed path that moves deposit liability.
 */
describe("SCRUM-263 recordPayment refuses a deposit application", () => {
  const REFUSAL = "A deposit is applied from the deal, not recorded as a new payment.";
  const TRACKED = [
    "collectionPayments",
    "canonicalPayments",
    "paymentAllocations",
    "transactions",
    "accountingEvents",
    "pendingAccountingEvents",
    "journalEntries",
    "journalLines",
    "commandIdempotency",
  ] as const;

  async function counts(t: ReturnType<typeof convexTestWithComponents>) {
    return await t.run(async (ctx) => {
      const out: Record<string, number> = {};
      for (const table of TRACKED) out[table] = (await ctx.db.query(table).take(10_000)).length;
      return out;
    });
  }

  test("refuses DEPOSIT_APPLIED against a receivable and writes nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment 1",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const before = await counts(t);

    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        receivableId,
        amount: 300,
        method: "DEPOSIT_APPLIED",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(REFUSAL);

    expect(await counts(t)).toEqual(before);
    const receivable = await t.run((ctx) => ctx.db.get(receivableId));
    expect(receivable?.outstandingAmount).toBe(1000);
    expect(receivable?.status).toBe("OPEN");
  });

  test("refuses DEPOSIT_APPLIED with no receivable and writes nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);
    const before = await counts(t);

    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        amount: 5,
        method: "DEPOSIT_APPLIED",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(REFUSAL);

    expect(await counts(t)).toEqual(before);
  });

  test("a refused attempt does not consume its idempotency key", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);
    const idempotencyKey = crypto.randomUUID();

    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        idempotencyKey,
        orgId,
        customerId,
        amount: 5,
        method: "DEPOSIT_APPLIED",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(REFUSAL);

    // The same key, now carrying genuine cash, is a first attempt, not a
    // conflicting replay of the refused one.
    const paymentId = await asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey,
      orgId,
      customerId,
      amount: 5,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const payment = await t.run((ctx) => ctx.db.get(paymentId));
    expect(payment?.method).toBe("CASH");
  });

  test("a replay of a DEPOSIT_APPLIED command completed before the fix is refused too (Sol D1)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);
    const idempotencyKey = crypto.randomUUID();
    const paymentDate = Date.now();
    // Exactly what the pre-fix mutation left behind after a successful call:
    // a COMPLETED command whose stored result the wrapper hands back on replay
    // without running the body again.
    await t.run((ctx) =>
      ctx.db.insert("commandIdempotency", {
        orgId,
        operation: "collections.recordPayment",
        idempotencyKey,
        status: "COMPLETED",
        fingerprint: JSON.stringify({
          receivableId: null,
          customerId,
          vehicleId: null,
          saleId: null,
          amount: 5,
          method: "DEPOSIT_APPLIED",
          paymentDate,
          reference: null,
        }),
        result: "stored-result-of-the-old-call",
        createdBy: userId,
        createdAt: paymentDate,
        completedAt: paymentDate,
      })
    );

    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        idempotencyKey,
        orgId,
        customerId,
        amount: 5,
        method: "DEPOSIT_APPLIED",
        paymentDate,
      })
    ).rejects.toThrow(REFUSAL);
  });

  test("genuine inbound methods still record (controls)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);
    // SCRUM-54: bank-bound methods must name an eligible bank; CASH names none.
    const bankAccountId = await insertBank(t, orgId, userId);
    // PAYMENT_LINK is deliberately absent: recordPayment refuses it (SCRUM-571 S1);
    // that refusal is asserted in scrum571ReceiptContainment.test.ts.
    for (const method of ["CASH", "BANK_TRANSFER", "CARD"] as const) {
      const paymentId = await asFinance.mutation(api.collections.recordPayment, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        amount: 5,
        method,
        ...(method === "CASH" ? {} : { bankAccountId }),
        paymentDate: Date.now(),
      });
      const payment = await t.run((ctx) => ctx.db.get(paymentId));
      expect(payment?.method, method).toBe(method);
      expect(payment?.status, method).toBe("POSTED");
    }
  });
});

describe("SCRUM-447 FC cheque face is rounded in its own denomination", () => {
  // Invariant: a cheque row carrying {amountMinor, currency} stores
  // amount === fromMinorUnits(amountMinor, currency). An org can switch
  // currency after a deal froze its economics, so the deal's denomination
  // (JOD, 3dp) can have more decimals than the org's (USD, 2dp).
  async function seedMixedCurrencyDeal() {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const seeded = await seedFinanceMember(t);
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId: seeded.orgId,
        currency: "USD",
        currencySymbol: "$",
        enabledPaymentTypes: [],
      })
    );
    const deal = await seedVehicleQuoteSaleAndApplication(t, seeded);
    await t.run((ctx) =>
      ctx.db.patch(deal.applicationId, { economicsCurrency: "JOD", expectedPaymentMethod: "CHEQUE" })
    );
    return { t, ...seeded, ...deal };
  }

  test("replaceCheque stores the face at the deal currency's precision", async () => {
    const { t, orgId, userId, customerId, vehicleId, applicationId, asFinance } = await seedMixedCurrencyDeal();
    const oldChequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        vehicleId,
        applicationId,
        bank: "FC Bank",
        chequeNumber: "FC-MIX-1",
        chequeDate: Date.now() + 86_400_000,
        amount: 1000,
        status: "HELD",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const newId = await asFinance.mutation(api.collections.replaceCheque, {
      orgId,
      chequeId: oldChequeId,
      bank: "FC Bank",
      chequeNumber: "FC-MIX-2",
      chequeDate: Date.now() + 2 * 86_400_000,
      faceAmount: "1234.567",
    });
    const row = await t.run((ctx) => ctx.db.get(newId));
    expect(row?.currency).toBe("JOD");
    expect(row?.amountMinor).toBe(1_234_567);
    expect(row?.amount).toBe(1234.567);
  });

  test("registerChequeCore rounds a supplied face in its own currency", async () => {
    const { t, orgId, userId, customerId, vehicleId, applicationId } = await seedMixedCurrencyDeal();
    const newId = await t.run((ctx) =>
      registerChequeCore(ctx, {
        orgId,
        customerId,
        vehicleId,
        applicationId,
        bank: "FC Bank",
        chequeNumber: "FC-MIX-3",
        chequeDate: Date.now() + 86_400_000,
        amount: 1234.567,
        amountMinor: 1_234_567,
        currency: "JOD",
        actorId: userId,
      })
    );
    const row = await t.run((ctx) => ctx.db.get(newId));
    expect(row?.amountMinor).toBe(1_234_567);
    expect(row?.amount).toBe(1234.567);
  });
});

async function insertBank(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  createdBy: Id<"users">,
  over: { currency?: string; isActive?: boolean; isDeleted?: boolean; name?: string } = {}
) {
  const now = Date.now();
  return await t.run((ctx) =>
    ctx.db.insert("bankAccounts", {
      orgId, name: over.name ?? "Operating bank", currency: over.currency ?? "JOD", openingBalanceMinor: 0,
      openingBalanceDate: now, isActive: over.isActive ?? true, isReconciliationTarget: false, createdBy,
      createdAt: now, updatedAt: now, isDeleted: over.isDeleted,
    })
  );
}

test("retained-credit payout bank options follow the requested currency", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const s = await seedFinanceMember(t);
  const usdBankId = await t.run((ctx) => ctx.db.insert("bankAccounts", {
    orgId: s.orgId, name: "USD payout bank", currency: "USD", openingBalanceMinor: 0,
    openingBalanceDate: Date.now(), isActive: true, isReconciliationTarget: false,
    createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
  }));
  const usdOptions = await s.asFinance.query(api.collections.listReceiptBankOptions,
    { orgId: s.orgId, currency: "USD" });
  expect(usdOptions.banks.map((bank) => bank._id)).toEqual([usdBankId]);
  const defaultOptions = await s.asFinance.query(api.collections.listReceiptBankOptions,
    { orgId: s.orgId });
  expect(defaultOptions.banks.map((bank) => bank._id)).toEqual([s.bankAccountId]);
});

describe("SCRUM-54 recordPayment names the physical bank of a bank-bound receipt", () => {
  const TRACKED = [
    "collectionPayments", "canonicalPayments", "paymentAllocations", "transactions", "accountingEvents",
    "pendingAccountingEvents", "journalEntries", "journalLines", "commandIdempotency",
  ] as const;

  async function counts(t: ReturnType<typeof convexTestWithComponents>) {
    return await t.run(async (ctx) => {
      const out: Record<string, number> = {};
      for (const table of TRACKED) out[table] = (await ctx.db.query(table).take(10_000)).length;
      return out;
    });
  }

  async function seed() {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seedFinanceMember(t);
    const receivableId = await s.asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      customerId: s.customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment",
      amount: 1000,
      dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const pay = (extra: { method: "BANK_TRANSFER" | "CARD" | "CASH"; bankAccountId?: Id<"bankAccounts"> }) =>
      s.asFinance.mutation(api.collections.recordPayment, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, receivableId, amount: 300, paymentDate: Date.now(), ...extra,
      });
    return { t, ...s, receivableId, pay };
  }

  test.each(["BANK_TRANSFER", "CARD"] as const)("%s without a bank is refused and writes nothing", async (method) => {
    const { t, pay } = await seed();
    const before = await counts(t);
    await expect(pay({ method })).rejects.toThrow("Select the bank account this payment was received into.");
    expect(await counts(t)).toEqual(before);
  });

  test.each([
    ["foreign organization", "The selected bank account was not found in this organization."],
    ["deleted", "The selected bank account was not found in this organization."],
    ["inactive", "The selected bank account is inactive."],
    ["wrong currency", "denominated in USD, but this organization is in JOD."],
  ] as const)("a %s bank is refused and writes nothing", async (kind, message) => {
    const { t, orgId, userId, pay } = await seed();
    let bankAccountId: Id<"bankAccounts">;
    if (kind === "foreign organization") {
      const otherOrg = await t.run((ctx) => ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() }));
      bankAccountId = await insertBank(t, otherOrg, userId);
    } else if (kind === "deleted") bankAccountId = await insertBank(t, orgId, userId, { isDeleted: true });
    else if (kind === "inactive") bankAccountId = await insertBank(t, orgId, userId, { isActive: false });
    else bankAccountId = await insertBank(t, orgId, userId, { currency: "USD" });
    const before = await counts(t);
    await expect(pay({ method: "BANK_TRANSFER", bankAccountId })).rejects.toThrow(message);
    expect(await counts(t)).toEqual(before);
  });

  test("a bank on a CASH receipt is refused and writes nothing", async () => {
    const { t, orgId, userId, pay } = await seed();
    const bankAccountId = await insertBank(t, orgId, userId);
    const before = await counts(t);
    await expect(pay({ method: "CASH", bankAccountId })).rejects.toThrow("applies only to bank transfer or card");
    expect(await counts(t)).toEqual(before);
  });

  test("a valid Bank A receipt carries Bank A on the receipt event; CASH carries none", async () => {
    const { t, orgId, userId, pay } = await seed();
    const bankA = await insertBank(t, orgId, userId, { name: "Bank A" });
    await insertBank(t, orgId, userId, { name: "Bank B" });
    await pay({ method: "CARD", bankAccountId: bankA });
    await pay({ method: "CASH" });
    const payloads = await t.run(async (ctx) =>
      (await ctx.db.query("pendingAccountingEvents").collect())
        .filter((e) => e.eventType === "COLLECTION_PAYMENT")
        .map((e) => e.payload as { paymentMethod?: string; bankAccountId?: string })
    );
    expect(payloads.map((p) => [p.paymentMethod, p.bankAccountId])).toEqual(
      expect.arrayContaining([["CARD", String(bankA)], ["CASH", undefined]])
    );
    expect(payloads).toHaveLength(2);
  });

  test("the same key with a different bank is a different instruction, not a replay", async () => {
    const { t, orgId, userId, asFinance, receivableId } = await seed();
    const bankA = await insertBank(t, orgId, userId, { name: "Bank A" });
    const bankB = await insertBank(t, orgId, userId, { name: "Bank B" });
    const args = { idempotencyKey: "scrum54-same-key", orgId, receivableId, amount: 300, method: "BANK_TRANSFER" as const, paymentDate: 1_700_000_000_000 };
    await asFinance.mutation(api.collections.recordPayment, { ...args, bankAccountId: bankA });
    await expect(asFinance.mutation(api.collections.recordPayment, { ...args, bankAccountId: bankB })).rejects.toThrow(
      "Idempotency key reused with different request content."
    );
  });

  test("ruleCollectionPayment puts the bank only on the BANK_ACCOUNT control line", () => {
    const base = { paymentId: "p1", receivedMinor: 300_000, appliedMinor: 200_000, unappliedMinor: 100_000, currency: "JOD", customerId: "c1" };
    const bank = ruleCollectionPayment({ ...base, paymentMethod: "BANK_TRANSFER", bankAccountId: "bankA" });
    expect(bank.lines.map((l) => [l.accountSystemKey, l.bankAccountId])).toEqual([
      [SYSTEM_KEYS.BANK_ACCOUNT, "bankA"],
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, undefined],
      [SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY, undefined],
    ]);
    expect(() => ruleCollectionPayment({ ...base, paymentMethod: "BANK_TRANSFER" })).toThrow(/bank account is required/);
    expect(() => ruleCollectionPayment({ ...base, paymentMethod: "CASH", bankAccountId: "bankA" })).toThrow(/non-bank/);
    const cash = ruleCollectionPayment({ ...base, paymentMethod: "CASH" });
    expect(cash.lines.every((l) => l.bankAccountId === undefined)).toBe(true);
  });
});
