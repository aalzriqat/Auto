/**
 * SCRUM-902 follow-up, owner ruling "Yes, gate all" (SCRUM-902, answering ADR Q1-Q4). Supplier cost recoveries, the sales
 * and inventory reports, the supplier and inventory reconciliations and the journal readers carry acquisition cost, so
 * each needs view:cost_price (OWASP A01:2021 / API3:2023). Readers a screen subscribes to while it loads (the two reports)
 * return null; readers behind a screen that already checks the permission refuse. ADR
 * docs/adr/2026-11-04-supplier-sourcing-readers-cost-permission.md. Test names are literal: the regression library binds a
 * scenario to one named test. The dashboard cases live in dashboardCostPermissions.test.ts.
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
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S902b ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "U" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Custom", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `S902B${tag}`.slice(0, 17), make: "Kia", model: "Sportage", year: 2023, mileage: 0, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12500, status: "AVAILABLE",
      sourceType: "SOURCED", sourceCost: 9500, sourcedFromName: "Amman Importer Co",
    })
  );
  const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  return { t, orgId, userId, vehicleId, as };
}

const FINANCE = ["view:finance", "manage:finance"];
const FINANCE_AND_COST = [...FINANCE, "view:cost_price"];
const REPORTS = ["view:reports"];
const REPORTS_AND_COST = [...REPORTS, "view:cost_price"];
const NAMES_COST = /view:cost_price/;
const RANGE = { startDate: Date.now() - 86_400_000, endDate: Date.now() + 86_400_000 };
const FIRST_PAGE = { numItems: 5, cursor: null };

describe("SCRUM-902 supplierCostRecoveries readers", () => {
  test("supplierCostRecoveries.list: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("rclist", FINANCE);
    await expect(s.as.query(api.supplierCostRecoveries.list, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("supplierCostRecoveries.listReceipts: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("rcrec", FINANCE);
    const recoveryId = await s.t.run(async (ctx) => {
      const expenseId = await ctx.db.insert("expenses", {
        orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport", amount: 200, date: Date.now(), category: "TRANSPORT", status: "PAID",
      } as never);
      return ctx.db.insert("supplierCostRecoveries", {
        orgId: s.orgId, vehicleId: s.vehicleId, expenseId, sourceEventKey: "ev_s902", sourcedFromName: "Amman Importer Co",
        amountDueMinor: 200_000, amountRecoveredMinor: 0, currency: "JOD", receiptSeq: 0, status: "OPEN",
        createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    await expect(
      s.as.query(api.supplierCostRecoveries.listReceipts, { orgId: s.orgId, recoveryId })
    ).rejects.toThrow(NAMES_COST);
  });
  test("supplierCostRecoveries readers: a role holding both view:finance and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("rcboth", FINANCE_AND_COST);
    expect(await s.as.query(api.supplierCostRecoveries.list, { orgId: s.orgId })).toEqual({ items: [], complete: true });
  });
  test("supplierCostRecoveries readers: view:cost_price without view:finance is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("rccost", ["view:cost_price"]);
    await expect(s.as.query(api.supplierCostRecoveries.list, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
  });
});

describe("SCRUM-902 reports", () => {
  test("reports.getSalesAndProfitReport: a role with view:reports but without view:cost_price gets null, not cost and profit (SCRUM-902)", async () => {
    const s = await seed("rpsales", REPORTS);
    expect(await s.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...RANGE })).toBeNull();
  });
  test("reports.getInventoryReport: a role with view:reports but without view:cost_price gets null, not purchase price and investment (SCRUM-902)", async () => {
    const s = await seed("rpinv", REPORTS);
    expect(await s.as.query(api.reports.getInventoryReport, { orgId: s.orgId })).toBeNull();
  });
  test("reports: a role holding both view:reports and view:cost_price still gets both reports (SCRUM-902 positive control)", async () => {
    const s = await seed("rpboth", REPORTS_AND_COST);
    const sales = await s.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...RANGE });
    expect(sales).toMatchObject({ sales: [] });
    const inventory = await s.as.query(api.reports.getInventoryReport, { orgId: s.orgId });
    expect(inventory).toMatchObject({ sourcedCount: 1, sourcedCommitment: 9500 });
  });
  test("reports: view:cost_price without view:reports is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("rpcost", ["view:cost_price"]);
    await expect(s.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...RANGE })).rejects.toThrow(/view:reports/);
    await expect(s.as.query(api.reports.getInventoryReport, { orgId: s.orgId })).rejects.toThrow(/view:reports/);
  });
});

describe("SCRUM-902 reconciliations and journal readers", () => {
  test("accountingReports.supplierPayablesReconciliation: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("rcpay", FINANCE);
    await expect(s.as.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("accountingReports.supplierReceivablesReconciliation: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("rcrcv", FINANCE);
    await expect(s.as.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("accountingReports.vehicleInventoryReconciliation: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("rcinv", FINANCE);
    await expect(s.as.query(api.accountingReports.vehicleInventoryReconciliation, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("accountingLedger.listJournalEntries: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("jelist", FINANCE);
    await expect(
      s.as.query(api.accountingLedger.listJournalEntries, { orgId: s.orgId, paginationOpts: FIRST_PAGE })
    ).rejects.toThrow(NAMES_COST);
  });
  test("accountingLedger.getJournalEntry: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("jeget", FINANCE);
    const journalEntryId = await s.t.run(async (ctx) => {
      const periodId = await ctx.db.insert("accountingPeriods", {
        orgId: s.orgId, fiscalYear: 2026, periodNumber: 1, startDate: 0, endDate: 1, status: "OPEN", createdAt: 0,
      } as never);
      return ctx.db.insert("journalEntries", {
        orgId: s.orgId, periodId, journalNumber: "JE-1", accountingDate: 0, memo: "m", sourceType: "MANUAL", sourceId: "x",
        category: "MANUAL", status: "POSTED", postedBy: s.userId, postedAt: 0, createdAt: 0,
      });
    });
    await expect(
      s.as.query(api.accountingLedger.getJournalEntry, { orgId: s.orgId, journalEntryId })
    ).rejects.toThrow(NAMES_COST);
  });
  test("reconciliations and journal readers: a role holding both view:finance and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("rcboth2", FINANCE_AND_COST);
    await expect(s.as.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId })).resolves.toBeDefined();
    await expect(s.as.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId })).resolves.toBeDefined();
    await expect(s.as.query(api.accountingReports.vehicleInventoryReconciliation, { orgId: s.orgId })).resolves.toBeDefined();
    const page = await s.as.query(api.accountingLedger.listJournalEntries, { orgId: s.orgId, paginationOpts: FIRST_PAGE });
    expect(page.page).toEqual([]);
  });
  test("reconciliations and journal readers: view:cost_price without view:finance is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("rccost2", ["view:cost_price"]);
    await expect(s.as.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
    await expect(
      s.as.query(api.accountingLedger.listJournalEntries, { orgId: s.orgId, paginationOpts: FIRST_PAGE })
    ).rejects.toThrow(/view:finance/);
  });
});
