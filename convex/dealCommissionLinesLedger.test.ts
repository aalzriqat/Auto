/**
 * Extra employee commission lines on a deal reach the ledger and payroll.
 *
 * A line (purchase / execution / another sale commission) is accrued when it is
 * registered on a COMPLETED sale (Dr Commission Expense / Cr Commission Payable,
 * dated at the sale), reversed when it is removed or the sale is cancelled, and
 * paid through the line employee's payslip. These tests drive the public API and
 * read the ledger back; the expected figures are worked out by hand.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const PERMISSIONS = [
  "create:sales", "view:sales", "edit:sales", "view:vehicles", "view:commissions", "manage:commissions",
  "view:finance", "manage:finance", "view:payroll", "manage:payroll", "view:reports",
];

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Lines Dealer ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const mkUser = (key: string, name: string) =>
    t.run((ctx) => ctx.db.insert("users", { clerkId: `${key}_${suffix}`, email: `${key}.${suffix}@example.com`, name }));
  const userId = await mkUser("rep", "Rep");
  const managerId = await mkUser("mgr", "Manager");
  const buyerId = await mkUser("buyer", "Buyer");
  const executorId = await mkUser("exec", "Executor");
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMISSIONS, isSystemOwnerRole: true })
  );
  for (const member of [userId, managerId, buyerId, executorId]) {
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: member, roleId }));
  }
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"], commissionMode: "MANUAL" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN-${suffix}`, make: "Honda", model: "Accord", year: 2020, color: "Black",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 50000, purchasePrice: 10000, sellingPrice: 15000, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "John", lastName: "Doe", email: `${suffix}.c@example.com` })
  );
  const asAdmin = t.withIdentity({ subject: `rep_${suffix}`, clerkId: `rep_${suffix}` });
  const asManager = t.withIdentity({ subject: `mgr_${suffix}`, clerkId: `mgr_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  for (const period of await asAdmin.query(api.accountingPeriods.list, { orgId })) {
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }
  return { t, orgId, userId, managerId, buyerId, executorId, vehicleId, customerId, asAdmin, asManager, fiscalYear };
}
type Dealer = Awaited<ReturnType<typeof seedDealer>>;

async function netMinor(d: Dealer, systemKey: string, side: "credit" | "debit"): Promise<number> {
  return await d.t.run(async (ctx) => {
    const account = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", d.orgId).eq("systemKey", systemKey))
      .unique();
    if (!account) return 0;
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account", (q) => q.eq("orgId", d.orgId).eq("accountId", account._id))
      .collect();
    return lines.reduce((s, l) => s + (side === "credit" ? l.creditMinor - l.debitMinor : l.debitMinor - l.creditMinor), 0);
  });
}
const payable = (d: Dealer) => netMinor(d, "COMMISSION_PAYABLE", "credit");
const expense = (d: Dealer) => netMinor(d, "COMMISSION_EXPENSE", "debit");

async function completedSale(d: Dealer, saleDate = Date.UTC(d.fiscalYear, 0, 15)) {
  return await d.asAdmin.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: d.orgId, vehicleId: d.vehicleId, customerId: d.customerId,
    salespersonId: d.userId, salePrice: 15000, saleDate, status: "COMPLETED", financingType: "CASH",
  });
}
const addLine = (d: Dealer, saleId: Id<"sales">, kind: "SALE" | "PURCHASE" | "EXECUTION", employeeId: Id<"users">, amount: number) =>
  d.asAdmin.mutation(api.dealCommissions.addLine, { orgId: d.orgId, saleId, kind, employeeId, amount });
const runPayroll = async (d: Dealer) => {
  const runId = await d.asAdmin.mutation(api.payroll.createRun, { orgId: d.orgId, periodYear: d.fiscalYear, periodMonth: 1 });
  await d.asAdmin.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
  return runId;
};

describe("accrual", () => {
  test("a line accrues on a completed sale: owner's example 50 + 25 JOD (fils)", async () => {
    const d = await seedDealer("accrue");
    const saleId = await completedSale(d);
    await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    await addLine(d, saleId, "EXECUTION", d.executorId, 25);
    expect(await payable(d)).toBe(75_000);
    expect(await expense(d)).toBe(75_000);
  });

  test("the accrual is dated at the sale and carries the line, not the sale's own commission key", async () => {
    const d = await seedDealer("dated");
    const saleDate = Date.UTC(d.fiscalYear, 0, 15);
    const saleId = await completedSale(d, saleDate);
    const lineId = await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    const events = await d.t.run((ctx) => ctx.db.query("accountingEvents").collect());
    const accrual = events.find((e) => e.eventType === "COMMISSION_ACCRUED");
    expect(accrual?.accountingDate).toBe(saleDate);
    expect(accrual?.sourceType).toBe("dealCommissionLines");
    expect(accrual?.sourceId).toBe(lineId);
    expect(accrual?.payload?.lineId).toBe(lineId);
    expect(accrual?.payload?.salespersonId).toBe(d.buyerId);
  });

  test("a line does not disturb the salesperson's own commission accrual or its correction", async () => {
    const d = await seedDealer("independent");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 50 });
    await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 60 });
    expect(await payable(d)).toBe(110_000);
  });

  test("a draft sale cannot take a line (nothing is earned yet)", async () => {
    const d = await seedDealer("draft");
    const saleId = await d.asAdmin.mutation(api.sales.createDraft, {
      orgId: d.orgId, vehicleId: d.vehicleId, customerId: d.customerId, salespersonId: d.userId,
      salePrice: 15000, saleDate: Date.now(), financingType: "CASH",
    });
    await expect(addLine(d, saleId, "PURCHASE", d.buyerId, 50)).rejects.toThrow(/completed/i);
    expect(await d.t.run((ctx) => ctx.db.query("dealCommissionLines").collect())).toHaveLength(0);
  });

  test("a sale whose period is closed refuses a new line, and nothing is written", async () => {
    const d = await seedDealer("closed");
    const saleId = await completedSale(d);
    const period = (await d.asAdmin.query(api.accountingPeriods.list, { orgId: d.orgId }))[0];
    const checklist = await d.asAdmin.query(api.accountingPeriods.closeChecklist, { orgId: d.orgId, periodId: period._id });
    await d.asAdmin.mutation(api.accountingPeriods.close, {
      orgId: d.orgId, periodId: period._id, acknowledgedWarnings: checklist.warnings,
      overrideReason: checklist.canClose ? undefined : "test fixture",
    });
    await expect(addLine(d, saleId, "PURCHASE", d.buyerId, 50)).rejects.toThrow();
    expect(await d.t.run((ctx) => ctx.db.query("dealCommissionLines").collect())).toHaveLength(0);
    expect(await payable(d)).toBe(0);
  });
});

describe("removal and cancellation reverse the accrual", () => {
  test("removing an unpaid line reverses its accrual to zero and keeps the history", async () => {
    const d = await seedDealer("remove");
    const saleId = await completedSale(d);
    const keep = await addLine(d, saleId, "EXECUTION", d.executorId, 25);
    const lineId = await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    await d.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: d.orgId, lineId });
    expect(await payable(d)).toBe(25_000);
    expect(await expense(d)).toBe(25_000);
    const rows = await d.t.run((ctx) => ctx.db.query("dealCommissionLines").collect());
    expect(rows.find((r) => r._id === keep)?.removedAt).toBeUndefined();
    expect(rows.find((r) => r._id === lineId)?.removedAt).toBeTypeOf("number");
  });

  test("cancelling the sale reverses the sale commission and every line", async () => {
    const d = await seedDealer("cancel");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 50 });
    await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    await addLine(d, saleId, "EXECUTION", d.executorId, 25);
    expect(await payable(d)).toBe(125_000);
    await d.asManager.mutation(api.sales.update, { orgId: d.orgId, saleId, status: "CANCELLED" } as never);
    expect(await payable(d)).toBe(0);
    expect(await expense(d)).toBe(0);
    const view = await d.asAdmin.query(api.dealCommissions.forSale, { orgId: d.orgId, saleId });
    expect(view.totalMinor).toBe(0);
  });
});

describe("payroll pays the line employee", () => {
  test("a payslip carries the line commission, payment clears the payable, the line reads paid", async () => {
    const d = await seedDealer("payroll");
    const saleId = await completedSale(d);
    const lineId = await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    const runId = await runPayroll(d);
    const items = await d.t.run((ctx) => ctx.db.query("payrollItems").collect());
    const item = items.find((i) => i.userId === d.buyerId);
    expect(item?.commissionMinor).toBe(50_000);
    expect(item?.commissionLineIds).toEqual([lineId]);
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    expect(await payable(d)).toBe(0);
    expect(await expense(d)).toBe(50_000);
    const line = await d.t.run((ctx) => ctx.db.get(lineId));
    expect(line?.paidAt).toBeTypeOf("number");
  });

  test("the salesperson's commission and a line for another employee go on separate payslips", async () => {
    const d = await seedDealer("payroll2");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 50 });
    await addLine(d, saleId, "EXECUTION", d.executorId, 25);
    const runId = await runPayroll(d);
    const items = await d.t.run((ctx) => ctx.db.query("payrollItems").collect());
    expect(items.find((i) => i.userId === d.userId)?.commissionMinor).toBe(50_000);
    expect(items.find((i) => i.userId === d.executorId)?.commissionMinor).toBe(25_000);
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    expect(await payable(d)).toBe(0);
  });

  test("a removed line is not swept into the run", async () => {
    const d = await seedDealer("payroll_removed");
    const saleId = await completedSale(d);
    const lineId = await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    await d.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: d.orgId, lineId });
    await expect(
      d.asAdmin.mutation(api.payroll.createRun, { orgId: d.orgId, periodYear: d.fiscalYear, periodMonth: 1 })
    ).rejects.toThrow(/Nothing to pay/);
  });

  test("removing a line after approval sends the run back for re-approval", async () => {
    const d = await seedDealer("payroll_drift");
    const saleId = await completedSale(d);
    const lineId = await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    await addLine(d, saleId, "EXECUTION", d.executorId, 25);
    const runId = await runPayroll(d);
    await d.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: d.orgId, lineId });
    const result = await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    expect(result.status).toBe("NEEDS_REAPPROVAL");
    await d.asAdmin.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    expect(await payable(d)).toBe(0);
    expect(await expense(d)).toBe(25_000);
  });

  test("a paid line cannot be removed, and its sale cannot be cancelled", async () => {
    const d = await seedDealer("paid_locked");
    const saleId = await completedSale(d);
    const lineId = await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    const runId = await runPayroll(d);
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    await expect(d.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: d.orgId, lineId })).rejects.toThrow(/paid/i);
    await expect(
      d.asManager.mutation(api.sales.update, { orgId: d.orgId, saleId, status: "CANCELLED" } as never)
    ).rejects.toThrow(/commission has been paid|paid/i);
    expect(await payable(d)).toBe(0);
    expect(await expense(d)).toBe(50_000);
  });
});

describe("reconciliation", () => {
  test("Commission Payable reconciles with lines, before and after payment", async () => {
    const d = await seedDealer("recon");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 50 });
    await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    const before = await d.asAdmin.query(api.accountingReports.commissionPayableReconciliation, { orgId: d.orgId });
    expect(before.isReconciled).toBe(true);
    expect(before.byCurrency.JOD.glBalanceMinor).toBe(100_000);
    const runId = await runPayroll(d);
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    const after = await d.asAdmin.query(api.accountingReports.commissionPayableReconciliation, { orgId: d.orgId });
    expect(after.isReconciled).toBe(true);
  });

  test("a removed line leaves the reconciliation clean", async () => {
    const d = await seedDealer("recon_removed");
    const saleId = await completedSale(d);
    const lineId = await addLine(d, saleId, "PURCHASE", d.buyerId, 50);
    await d.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: d.orgId, lineId });
    const recon = await d.asAdmin.query(api.accountingReports.commissionPayableReconciliation, { orgId: d.orgId });
    expect(recon.isReconciled).toBe(true);
  });
});

describe("reconciliation with a line-only payment", () => {
  test("a paid line leaves the sale commission unaffected and the payable reconciled", async () => {
    const d = await seedDealer("recon_line_only");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 50 });
    await addLine(d, saleId, "EXECUTION", d.executorId, 25);
    const runId = await d.asAdmin.mutation(api.payroll.createRun, { orgId: d.orgId, periodYear: d.fiscalYear, periodMonth: 1 });
    await d.asAdmin.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    // Pay only the line employee's slip: drop the salesperson's from the run.
    const items = await d.t.run((ctx) => ctx.db.query("payrollItems").collect());
    const repItem = items.find((i) => i.userId === d.userId)!;
    await d.t.run((ctx) => ctx.db.delete(repItem._id));
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    const recon = await d.asAdmin.query(api.accountingReports.commissionPayableReconciliation, { orgId: d.orgId });
    expect(recon.byCurrency.JOD.glBalanceMinor).toBe(50_000);
    expect(recon.isReconciled).toBe(true);
  });
});

describe("row cap", () => {
  test("a sale past the row cap refuses new lines, so cancel can never miss one", async () => {
    const d = await seedDealer("rowcap");
    const saleId = await completedSale(d);
    for (let i = 0; i < 100; i++) {
      await d.t.run((ctx) =>
        ctx.db.insert("dealCommissionLines", {
          orgId: d.orgId, saleId, kind: "PURCHASE", employeeId: d.buyerId, amountMinor: 1000, currency: "JOD",
          createdBy: d.userId, removedAt: Date.now(), removedBy: d.userId,
        })
      );
    }
    await expect(addLine(d, saleId, "PURCHASE", d.buyerId, 50)).rejects.toThrow(/too many/i);
    expect(await payable(d)).toBe(0);
  });
});
