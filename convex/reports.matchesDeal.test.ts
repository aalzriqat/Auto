import { describe, expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

const DATE = Date.UTC(2026, 10, 7);
const modules = import.meta.glob("./**/*.*s");

async function fixture(options: { cash?: boolean; stock?: boolean; direct?: boolean; without?: string } = {}) {
  const t = convexTestWithComponents(schema, modules);
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Report parity", createdAt: DATE });
    const userId = await ctx.db.insert("users", { clerkId: "parity", email: "parity@example.com", name: "Reporter" });
    const roleId = await ctx.db.insert("roles", {
      orgId, name: "Report operator", isSystemOwnerRole: false,
      permissions: ALL_PERMISSIONS.filter((p) => p !== options.without),
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "PARITY0003", make: "Toyota", model: "Camry", year: 2024,
      mileage: 100, color: "White", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 12100, status: "SOLD",
      ...(options.stock || options.cash
        ? { sourceType: "STOCK" as const, purchasePrice: 9900 }
        : { sourceType: "SOURCED" as const, sourceCost: 9900, sourcedFromName: "Supplier" }),
    });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 11785, downPayment: 0,
      termMonths: 60, status: "ACCEPTED", createdBy: userId, createdAt: DATE,
    });
    const applicationId = options.cash ? null : await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId, status: "CLOSED",
      economicsCurrency: "JOD", targetSellingAmountMinor: 13000000,
      submittedQuotationMinor: 12200000, legalInvoiceAmountMinor: 12100000,
      approvedDealerPurchaseAmountMinor: 12000000, dealerContributionMinor: 215000,
      estimatedDealerBorneExpensesMinor: 451300,
      supplierSettlementRoute: options.direct === false ? "THROUGH_SHOWROOM" : "DIRECT_TO_SUPPLIER",
      createdAt: DATE, updatedAt: DATE,
    });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId, salePrice: options.cash ? 12100 : 11785,
      saleDate: DATE, status: "COMPLETED", financingType: options.cash ? "CASH" : "FINANCED",
      commissionAmount: 110,
      ...(applicationId ? { applicationId } : {}),
      ...(!options.stock && !options.cash ? {
        supplierSettlementRoute: options.direct === false ? "THROUGH_DEALERSHIP" as const : "DIRECT_TO_SUPPLIER" as const,
        consignedMarginMinor: 2100000, consignedMarginCurrency: "JOD",
        consignedSupplierEntitlementMinor: 9900000, consignedSupplierGrossReceiptMinor: 12000000,
        financedNetRevenue: { minor: 1885000, currency: "JOD", considerationMinor: 12000000 },
      } : {}),
    });
    if (applicationId) await ctx.db.patch(applicationId, { finalizedSaleId: saleId });
    const expenseId = await ctx.db.insert("expenses", {
      orgId, vehicleId, title: "Showroom maintenance", amount: 300,
      date: DATE, category: "MAINTENANCE", status: "PAID", accountingTreatment: "PERIOD_EXPENSE",
    });
    const feeId = applicationId ? await ctx.db.insert("financeDealFees", {
      orgId, applicationId, feeType: "FINANCE_COMPANY_FEE", currency: "JOD", actualAmountMinor: 451300,
      paidBy: "DEALER", paidTo: "FINANCE_COMPANY", accountingTreatment: "FINANCE_COMPANY_COMMISSION",
      includedInQuotation: false, deductedFromSettlement: false, refundable: false, source: "MANUAL",
      createdBy: userId, createdAt: DATE, updatedAt: DATE,
    }) : null;
    return { orgId, userId, customerId, vehicleId, saleId, applicationId, expenseId, feeId };
  });
  const asUser = t.withIdentity({ subject: "parity" });
  const report = () => asUser.query(api.reports.getSalesAndProfitReport, { orgId: ids.orgId, startDate: DATE, endDate: DATE });
  const deal = async () => {
    if (ids.applicationId) {
      const overview = await asUser.query(api.dealOverview.financedDealOverview, { orgId: ids.orgId, applicationId: ids.applicationId });
      return { profit: overview?.financialSummary?.profit, price: overview?.financialSummary?.customerSalePrice?.amountMinor };
    }
    const cockpit = await asUser.query(api.sales.dealCockpit, { orgId: ids.orgId, saleId: ids.saleId });
    return { profit: cockpit?.money?.managementNetProfit, price: 12100000 };
  };
  return { t, ...ids, asUser, report, deal };
}

async function expectParity(s: Awaited<ReturnType<typeof fixture>>, amount: number) {
  const deal = await s.deal();
  expect(deal.profit).toMatchObject({ available: true, amountMinor: amount });
  const report = await s.report();
  expect(report).not.toBeNull();
  expect(report!.sales).toHaveLength(1);
  const row = report!.sales[0];
  expect(row.netProfit).toBe(amount / 1000);
  expect(row.netProfitAfterCommissions).toBe(amount / 1000);
  expect(row.salePrice).toBe(deal.price! / 1000);
  expect(row.salePrice).toBe(12100);
  expect(report!.totalProfit).toBe(amount / 1000);
  expect(report!.totalNetProfitAfterCommissions).toBe(amount / 1000);
  expect(report!.totalRevenue - report!.totalCost).toBeCloseTo(report!.totalProfit, 8);
  const reps = await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE });
  expect(reps?.[0].totalProfit).toBe(amount / 1000);
  expect(reps?.[0].totalNetProfitAfterCommissions).toBe(amount / 1000);
}

describe("SCRUM-928 report matches the deal page", () => {
  test("SOURCED DIRECT: 1023.700 net and 12100 customer price, including fee, expense and commissions", async () => {
    await expectParity(await fixture(), 1023700);
  });
  test("financed STOCK uses the same management net", async () => {
    await expectParity(await fixture({ stock: true }), 1023700);
  });
  test("cash without an application uses the cash cockpit management net", async () => {
    await expectParity(await fixture({ cash: true }), 1790000);
  });
  test.each([
    ["unreadable", Number.NaN, "JOD", "ExpensesUnreadable"],
    ["mixed currency", 451300, "USD", "ExpensesMixedDenomination"],
  ])("%s fee makes both profits unavailable", async (_label, actualAmountMinor, currency, reason) => {
    const s = await fixture();
    await s.t.run((ctx) => ctx.db.patch(s.feeId!, { actualAmountMinor, currency }));
    expect((await s.deal()).profit).toEqual({ available: false, reason });
    const report = await s.report();
    expect(report!.sales[0].netProfit).toBeNull();
    expect(report!.sales[0].netProfitAfterCommissions).toBeNull();
    expect(report!.sales[0]).toMatchObject({ profitUnavailableReason: reason });
    expect(report!.unknownMarginSaleCount).toBe(1);
  });
  test("without view:commissions, both withhold management net", async () => {
    const s = await fixture({ without: "view:commissions" });
    expect((await s.deal()).profit).toEqual({ available: false, reason: "CommissionAccessRequired" });
    const report = await s.report();
    expect(report!.sales[0].netProfit).toBeNull();
    expect(report!.sales[0].netProfitAfterCommissions).toBeNull();
    expect(report!.sales[0].commissionsTotal).toBeNull();
  });
  test("without view:cost_price, report remains null", async () => {
    const s = await fixture({ without: "view:cost_price" });
    expect(await s.report()).toBeNull();
    expect((await s.deal()).profit).toEqual({ available: false, reason: "CostAccessRequired" });
  });
  test("a late fee actual updates both live figures", async () => {
    const s = await fixture();
    await s.t.run((ctx) => ctx.db.patch(s.feeId!, { actualAmountMinor: 500000 }));
    await expectParity(s, 975000);
  });
  test("deleted and supplier-borne expenses stay excluded", async () => {
    const s = await fixture();
    await s.t.run(async (ctx) => {
      const expense = await ctx.db.get(s.expenseId);
      if (!expense) throw new Error("fixture missing expense");
      const { _id: _id, _creationTime: _creationTime, ...fields } = expense;
      await ctx.db.insert("expenses", { ...fields, amount: 700, isDeleted: true });
      await ctx.db.insert("expenses", { ...fields, amount: 900, costBearer: "SUPPLIER" });
    });
    await expectParity(s, 1023700);
  });
  test("cancelled and deleted sibling sales on the same vehicle stay excluded", async () => {
    const s = await fixture();
    await s.t.run(async (ctx) => {
      const sale = await ctx.db.get(s.saleId);
      if (!sale) throw new Error("fixture missing sale");
      const { _id: _id, _creationTime: _creationTime, ...fields } = sale;
      await ctx.db.insert("sales", { ...fields, status: "CANCELLED" });
      await ctx.db.insert("sales", { ...fields, isDeleted: true });
    });
    await expectParity(s, 1023700);
  });
});
