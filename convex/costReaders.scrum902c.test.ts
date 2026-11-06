/**
 * SCRUM-902 class sweep, owner ruling "Yes, gate all" (SCRUM-902 c24475). The readers left unruled in the first follow-up
 * are classified in docs/adr/2026-11-04-supplier-sourcing-readers-cost-permission.md. Cost-bearing ones need
 * view:cost_price: the GL statements (trial balance, income statement with COGS, balance sheet with inventory) and the
 * account activity reader refuse; the salesperson performance and expenses reports return null, like the sales report.
 * Test names are literal: the regression library binds a scenario to one named test.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seed(tag: string, permissions: string[]) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S902c ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "U" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Custom", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const accountId = await t.run((ctx) =>
    ctx.db.insert("chartOfAccounts", {
      orgId, code: "1300", name: "Vehicle Inventory", type: "ASSET", normalBalance: "DEBIT",
      isControlAccount: false, allowManualPosting: false, active: true, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  return { t, orgId, accountId, as };
}

const FINANCE = ["view:finance"];
const FINANCE_AND_COST = [...FINANCE, "view:cost_price"];
const REPORTS = ["view:reports"];
const REPORTS_AND_COST = [...REPORTS, "view:cost_price"];
const NAMES_COST = /view:cost_price/;
const NOW = Date.now();
const RANGE = { startDate: NOW - 86_400_000, endDate: NOW + 86_400_000 };
const GL_RANGE = { fromDate: NOW - 86_400_000, toDate: NOW + 86_400_000 };

async function checklistFor(tag: string, permissions: string[]) {
  const s = await seed(tag, permissions);
  const periodId = await s.t.run((ctx) => ctx.db.insert("accountingPeriods", {
    orgId: s.orgId, fiscalYear: 2026, periodNumber: 1, startDate: 0, endDate: Date.now() + 86_400_000,
    status: "OPEN", createdAt: 0,
  }));
  return s.as.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId });
}

describe("SCRUM-902 GL statements and account activity", () => {
  test("accountingPeriods.closeChecklist: finance without cost is refused (SCRUM-858 merge)", async () => {
    await expect(checklistFor("closefinance", FINANCE)).rejects.toThrow(NAMES_COST);
  });
  test("accountingPeriods.closeChecklist: cost without finance is refused (SCRUM-858 merge negative control)", async () => {
    await expect(checklistFor("closecost", ["view:cost_price"])).rejects.toThrow(/view:finance/);
  });
  test("accountingPeriods.closeChecklist: finance and cost still read (SCRUM-858 merge positive control)", async () => {
    await expect(checklistFor("closeboth", FINANCE_AND_COST)).resolves.toMatchObject({
      supplierRecoverablesReconciliation: { status: "AVAILABLE", isReconciled: true },
    });
  });
  test("accountingReports.trialBalance: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("tb", FINANCE);
    await expect(s.as.query(api.accountingReports.trialBalance, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("accountingReports.incomeStatement: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("is", FINANCE);
    await expect(s.as.query(api.accountingReports.incomeStatement, { orgId: s.orgId, ...GL_RANGE })).rejects.toThrow(NAMES_COST);
  });
  test("accountingReports.balanceSheet: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("bs", FINANCE);
    await expect(s.as.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate: NOW })).rejects.toThrow(NAMES_COST);
  });
  test("accountingLedger.getAccountActivity: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("aa", FINANCE);
    await expect(
      s.as.query(api.accountingLedger.getAccountActivity, {
        orgId: s.orgId, accountId: s.accountId, paginationOpts: { numItems: 5, cursor: null },
      })
    ).rejects.toThrow(NAMES_COST);
  });
  test("GL statements and account activity: a role holding both view:finance and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("glboth", FINANCE_AND_COST);
    await expect(s.as.query(api.accountingReports.trialBalance, { orgId: s.orgId })).resolves.toBeDefined();
    await expect(s.as.query(api.accountingReports.incomeStatement, { orgId: s.orgId, ...GL_RANGE })).resolves.toBeDefined();
    await expect(s.as.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate: NOW })).resolves.toBeDefined();
    await expect(
      s.as.query(api.accountingLedger.getAccountActivity, {
        orgId: s.orgId, accountId: s.accountId, paginationOpts: { numItems: 5, cursor: null },
      })
    ).resolves.toBeDefined();
  });
  test("GL statements and account activity: view:cost_price without view:finance is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("glcost", ["view:cost_price"]);
    await expect(s.as.query(api.accountingReports.trialBalance, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
    await expect(s.as.query(api.accountingReports.balanceSheet, { orgId: s.orgId, asOfDate: NOW })).rejects.toThrow(/view:finance/);
  });
  test("accountingReports.subledgerReconciliation: AR only, not cost-bearing, so view:finance alone still reads (SCRUM-902 class control)", async () => {
    const s = await seed("sub", FINANCE);
    await expect(s.as.query(api.accountingReports.subledgerReconciliation, { orgId: s.orgId })).resolves.toBeDefined();
  });
});

describe("SCRUM-902 salesperson performance and expenses reports", () => {
  test("reports.getSalespersonPerformance: a role with view:reports but without view:cost_price gets null, not per-rep profit (SCRUM-902)", async () => {
    const s = await seed("perf", REPORTS);
    expect(await s.as.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, ...RANGE })).toBeNull();
  });
  test("reports.getExpensesReport: a role with view:reports but without view:cost_price gets null, not vehicle landed-cost expenses (SCRUM-902)", async () => {
    const s = await seed("exp", REPORTS);
    expect(await s.as.query(api.reports.getExpensesReport, { orgId: s.orgId, ...RANGE })).toBeNull();
  });
  test("salesperson performance and expenses reports: a role holding both view:reports and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("rpboth3", REPORTS_AND_COST);
    expect(await s.as.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, ...RANGE })).not.toBeNull();
    expect(await s.as.query(api.reports.getExpensesReport, { orgId: s.orgId, ...RANGE })).not.toBeNull();
  });
  test("salesperson performance and expenses reports: view:cost_price without view:reports is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("rpcost3", ["view:cost_price"]);
    await expect(s.as.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, ...RANGE })).rejects.toThrow(/view:reports/);
    await expect(s.as.query(api.reports.getExpensesReport, { orgId: s.orgId, ...RANGE })).rejects.toThrow(/view:reports/);
  });
});
