/**
 * Phase 5 tests: ledger-backed reporting (trial balance, P&L, balance sheet,
 * AR aging, subledger reconciliation).  All reports are computed from posted
 * journalLines — the GL — not from the legacy transactions table.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedReportingDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Reporting Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "rep_user", email: "rep@example.com", name: "Rep User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:sales", "manage:finance", "view:finance", "create:expenses", "view:expenses", "create:customers"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: "rep_user", clerkId: "rep_user" });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const periods = await asUser.query(api.accountingPeriods.list, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, asUser };
}

describe("Phase 5 — trial balance", () => {
  test("trial balance is balanced after posting an expense", async () => {
    const { orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: "exp_tb_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "exp_tb_001_key",
      payload: { expenseId: "exp_tb_001", amountMinor: 50000, currency: "JOD" },
    });

    const tb = await asUser.query(api.accountingReports.trialBalance, { orgId });
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebits).toBe(tb.totalCredits);
    expect(tb.totalDebits).toBeGreaterThan(0);
  });

  test("empty org has empty trial balance", async () => {
    const { orgId, asUser } = await seedReportingDealer();
    const tb = await asUser.query(api.accountingReports.trialBalance, { orgId });
    expect(tb.rows).toHaveLength(0);
    expect(tb.isBalanced).toBe(true);
  });

  test("bounded trial balance scans posted lines inside the requested date window", async () => {
    const { orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: "exp_tb_bounded_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "exp_tb_bounded_001_key",
      payload: { expenseId: "exp_tb_bounded_001", amountMinor: 65000, currency: "JOD" },
    });

    const tb = await asUser.query(api.accountingReports.trialBalance, {
      orgId,
      fromDate: now - 1_000,
      toDate: now + 1_000,
    });

    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebits).toBe(65000);
    expect(tb.totalCredits).toBe(65000);
  });
});

describe("Phase 5 — income statement", () => {
  test("P&L shows revenue after a sale event", async () => {
    const { t, orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "P5", lastName: "Customer" })
    );

    await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "SALE_COMPLETED",
      sourceType: "sales",
      sourceId: "sale_pl_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "sale_pl_001_key",
      payload: {
        saleId: "sale_pl_001",
        saleAmountMinor: 20000000,
        currency: "JOD",
        customerId: customerId.toString(),
      },
    });

    const pl = await asUser.query(api.accountingReports.incomeStatement, {
      orgId,
      fromDate: now - 86400_000,
      toDate: now + 86400_000,
    });

    expect(pl.totalRevenue).toBeGreaterThan(0);
    expect(pl.revenueRows.length).toBeGreaterThan(0);
  });

  test("P&L shows expenses in expense rows", async () => {
    const { orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: "exp_pl_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "exp_pl_001_key",
      payload: { expenseId: "exp_pl_001", amountMinor: 75000, currency: "JOD" },
    });

    const pl = await asUser.query(api.accountingReports.incomeStatement, {
      orgId, fromDate: now - 86400_000, toDate: now + 86400_000,
    });
    expect(pl.totalExpenses).toBeGreaterThan(0);
    expect(pl.expenseRows.length).toBeGreaterThan(0);
  });
});

describe("Phase 5 — AR aging", () => {
  test("open receivable appears in aging report", async () => {
    const { t, orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Aging", lastName: "Customer" })
    );

    await asUser.mutation(internal.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "sales",
      sourceId: "sale_aging_001",
      originalAmountMinor: 100000,
      currency: "JOD",
      issueDate: now,
      dueDate: now - 45 * 86400_000,
    });

    const aging = await asUser.query(api.accountingReports.arAging, { orgId, asOfDate: now });
    expect(aging.currencies).toEqual(["JOD"]);
    expect(aging.byCurrency.JOD.rows).toHaveLength(1);
    expect(aging.byCurrency.JOD.totalOutstandingMinor).toBe(100000);
    // 45 days overdue → days60 bucket (31-60 days)
    expect(aging.byCurrency.JOD.buckets.days60).toBe(100000);
  });

  test("paid receivable does not appear in aging report", async () => {
    const { t, orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Paid", lastName: "Customer" })
    );

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_paid_aging",
      originalAmountMinor: 5000, currency: "JOD",
      issueDate: now, dueDate: now - 10 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "pay_paid_aging",
    });
    await asUser.mutation(internal.subledger.allocate, {
      orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 5000,
    });

    // Query strictly after the allocation actually committed — not the
    // pre-mutation "now" snapshot, whose millisecond value can predate the
    // allocation's own createdAt and would make it look not-yet-active.
    const aging = await asUser.query(api.accountingReports.arAging, { orgId, asOfDate: Date.now() });
    expect(aging.currencies).toEqual([]);
  });

  test("a historical asOfDate before a since-reversed allocation still counts it as paid", async () => {
    const { t, orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Reversal", lastName: "Customer" })
    );

    const recId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_reversed_alloc",
      originalAmountMinor: 5000, currency: "JOD",
      issueDate: now, dueDate: now - 10 * 86400_000,
    });
    const payId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "pay_reversed_alloc",
    });
    const allocationId = await asUser.mutation(internal.subledger.allocate, {
      orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 5000,
    });

    // Snapshot a point in time strictly after the allocation was created but
    // strictly before it gets reversed below. A real delay (not just two
    // back-to-back Date.now() calls) guarantees the reversal's own Date.now()
    // lands in a later millisecond — without it this is flaky, since a fast
    // test can call both within the same millisecond.
    const asOfBeforeReversal = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await asUser.mutation(internal.subledger.reverseAllocationMutation, {
      orgId, allocationId,
    });

    // As of the snapshot, the payment had fully settled the receivable — the
    // later reversal (which flips the original allocation row's CURRENT
    // status to REVERSED) must not retroactively make this historical
    // snapshot look outstanding.
    const historicalAging = await asUser.query(api.accountingReports.arAging, {
      orgId, asOfDate: asOfBeforeReversal,
    });
    expect(historicalAging.currencies).toEqual([]);

    // A present-day query (after the reversal) must show it outstanding again.
    const currentAging = await asUser.query(api.accountingReports.arAging, {
      orgId, asOfDate: Date.now(),
    });
    expect(currentAging.byCurrency.JOD.totalOutstandingMinor).toBe(5000);
  });

  test("aging report buckets current, 30, 60, 90, and over-90 day receivables", async () => {
    const { t, orgId, asUser } = await seedReportingDealer();
    const now = Date.now();
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Bucket", lastName: "Customer" })
    );
    const receivables = [
      { sourceId: "aging_current", amount: 10_000, dueDate: now + 86400_000, bucket: "current" },
      { sourceId: "aging_30", amount: 20_000, dueDate: now - 15 * 86400_000, bucket: "days30" },
      { sourceId: "aging_60", amount: 30_000, dueDate: now - 45 * 86400_000, bucket: "days60" },
      { sourceId: "aging_90", amount: 40_000, dueDate: now - 75 * 86400_000, bucket: "days90" },
      { sourceId: "aging_over_90", amount: 50_000, dueDate: now - 100 * 86400_000, bucket: "over90" },
    ] as const;

    for (const receivable of receivables) {
      await asUser.mutation(internal.subledger.createReceivable, {
        orgId,
        documentType: "INVOICE",
        payerType: "CUSTOMER",
        customerId,
        sourceType: "sales",
        sourceId: receivable.sourceId,
        originalAmountMinor: receivable.amount,
        currency: "JOD",
        issueDate: now - 110 * 86400_000,
        dueDate: receivable.dueDate,
      });
    }

    const aging = await asUser.query(api.accountingReports.arAging, { orgId, asOfDate: now });
    for (const receivable of receivables) {
      expect(aging.byCurrency.JOD.buckets[receivable.bucket]).toBe(receivable.amount);
    }
    expect(aging.byCurrency.JOD.totalOutstandingMinor).toBe(150_000);
  });
});

describe("Phase 5 — subledger reconciliation", () => {
  test("empty system is reconciled", async () => {
    const { orgId, asUser } = await seedReportingDealer();
    const recon = await asUser.query(api.accountingReports.subledgerReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
    expect(recon.currencies).toEqual([]);
  });

  test("partial receivable allocations reduce subledger outstanding for reconciliation", async () => {
    const { t, orgId, userId, asUser } = await seedReportingDealer();
    const now = Date.now();
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Recon", lastName: "Customer" })
    );
    const receivableDocumentId = await asUser.mutation(internal.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "sales",
      sourceId: "sale_recon_partial",
      originalAmountMinor: 100_000,
      currency: "JOD",
      issueDate: now,
      dueDate: now + 30 * 86400_000,
    });
    const paymentId = await asUser.mutation(internal.subledger.recordPayment, {
      orgId,
      direction: "IN",
      customerId,
      method: "CASH",
      amountMinor: 25_000,
      currency: "JOD",
      idempotencyKey: "payment_recon_partial",
    });
    await asUser.mutation(internal.subledger.allocate, {
      orgId,
      paymentId,
      receivableDocumentId,
      amountMinor: 25_000,
    });

    await t.run(async (ctx) => {
      const arAccount = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "ACCOUNTS_RECEIVABLE_CUSTOMERS"))
        .unique();
      if (!arAccount) throw new Error("AR account was not initialized");
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId,
        journalNumber: "JRN-RECON-PARTIAL",
        accountingDate: now,
        sourceType: "sales",
        sourceId: "sale_recon_partial",
        category: "SYSTEM",
        memo: "Partial reconciliation fixture",
        status: "POSTED",
        currency: "JOD",
        postedBy: userId,
        postedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("journalLines", {
        orgId,
        journalEntryId,
        lineNumber: 1,
        accountId: arAccount._id,
        debitMinor: 75_000,
        creditMinor: 0,
        currency: "JOD",
        scale: 3,
        accountingDate: now,
      });
    });

    const recon = await asUser.query(api.accountingReports.subledgerReconciliation, {
      orgId,
      toDate: now + 1_000,
    });
    expect(recon.byCurrency.JOD.glArBalanceMinor).toBe(75_000);
    expect(recon.byCurrency.JOD.subledgerOutstandingMinor).toBe(75_000);
    expect(recon.isReconciled).toBe(true);
  });
});
