/**
 * Phase 5 tests: ledger-backed reporting (trial balance, P&L, balance sheet,
 * AR aging, subledger reconciliation).  All reports are computed from posted
 * journalLines — the GL — not from the legacy transactions table.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedReportingDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Reporting Dealer", createdAt: Date.now() })
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

    await asUser.mutation(api.subledger.createReceivable, {
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
    expect(aging.rows).toHaveLength(1);
    expect(aging.totalOutstandingMinor).toBe(100000);
    // 45 days overdue → days60 bucket (31-60 days)
    expect(aging.buckets.days60).toBe(100000);
  });

  test("paid receivable does not appear in aging report", async () => {
    const { t, orgId, asUser } = await seedReportingDealer();
    const now = Date.now();

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Paid", lastName: "Customer" })
    );

    const recId = await asUser.mutation(api.subledger.createReceivable, {
      orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
      sourceType: "sales", sourceId: "sale_paid_aging",
      originalAmountMinor: 5000, currency: "JOD",
      issueDate: now, dueDate: now - 10 * 86400_000,
    });
    const payId = await asUser.mutation(api.subledger.recordPayment, {
      orgId, direction: "IN", customerId, method: "CASH",
      amountMinor: 5000, currency: "JOD", idempotencyKey: "pay_paid_aging",
    });
    await asUser.mutation(api.subledger.allocate, {
      orgId, paymentId: payId, receivableDocumentId: recId, amountMinor: 5000,
    });

    const aging = await asUser.query(api.accountingReports.arAging, { orgId, asOfDate: now });
    expect(aging.rows).toHaveLength(0);
    expect(aging.totalOutstandingMinor).toBe(0);
  });
});

describe("Phase 5 — subledger reconciliation", () => {
  test("empty system is reconciled", async () => {
    const { orgId, asUser } = await seedReportingDealer();
    const recon = await asUser.query(api.accountingReports.subledgerReconciliation, { orgId });
    expect(recon.isReconciled).toBe(true);
    expect(recon.discrepancyMinor).toBe(0);
  });
});
