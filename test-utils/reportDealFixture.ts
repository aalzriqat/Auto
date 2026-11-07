import { convexTestWithComponents, registerRateLimiter } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { ALL_PERMISSIONS } from "../convex/utils/permissions";

export const DATE = Date.UTC(2026, 10, 7);
const modules = import.meta.glob("../convex/**/*.*s");

export async function reportDealFixture(options: { cash?: boolean; stock?: boolean; direct?: boolean; without?: string } = {}) {
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
      supplierSettlementRoute: options.direct === false ? "THROUGH_DEALERSHIP" : "DIRECT_TO_SUPPLIER",
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
    return { orgId, userId, roleId, customerId, vehicleId, saleId, applicationId, expenseId, feeId };
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
