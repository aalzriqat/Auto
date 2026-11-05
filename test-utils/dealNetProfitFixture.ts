import { convexTestWithComponents } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { ALL_PERMISSIONS } from "../convex/utils/permissions";

/** Synthetic reader fixture. Inserts include legacy/corrupt shapes intentionally. */
export async function seedDealNetProfit(
  modules: Record<string, () => Promise<unknown>>,
  sourceType: "SOURCED" | "STOCK" = "SOURCED",
  financed = true
) {
  const t = convexTestWithComponents(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic net profit", createdAt: 1 });
    const userId = await ctx.db.insert("users", { clerkId: "net-profit-reader", email: "net@example.invalid" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JOD", enabledPaymentTypes: [] });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "SYNTHETIC908", make: "Example", model: "Fixture", year: 2026, mileage: 0,
      color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12_100,
      status: "SOLD", sourceType, purchasePrice: 9_900, sourceCost: 9_900, sourcedFromName: "Synthetic supplier",
    });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 12_100, downPayment: 0, termMonths: 12,
      status: "ACCEPTED", createdBy: userId, createdAt: 1,
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, customerId, vehicleId, quoteId, salespersonId: userId, status: "APPROVED",
      economicsCurrency: "JOD", approvedDealerPurchaseAmountMinor: 12_100_000,
      dealerContributionMinor: 315_000, createdAt: 1, updatedAt: 1,
    });
    const saleId = await ctx.db.insert("sales", {
      orgId, customerId, vehicleId, salespersonId: userId, salePrice: 12_100, saleDate: 1,
      status: "COMPLETED", commissionAmount: 0, consignedMarginMinor: 2_200_000,
      consignedMarginCurrency: "JOD", consignedSupplierEntitlementMinor: 9_900_000,
      ...(financed ? { applicationId } : {}),
    });
    if (financed) await ctx.db.patch(applicationId, { finalizedSaleId: saleId });
    if (sourceType === "SOURCED") await ctx.db.insert("vehicleSupplierPayables", {
      orgId, vehicleId, saleId, sourcedFromName: "Synthetic supplier", amountDue: 9_900, amountPaid: 0,
      currency: "JOD", status: "DUE_ON_SALE", createdBy: userId, createdAt: 1, updatedAt: 1,
    });
    const feeId = await ctx.db.insert("financeDealFees", {
      orgId, applicationId, currency: "JOD", feeType: "FINANCE_COMPANY_FEE", actualAmountMinor: 451_300,
      paidBy: "DEALER", paidTo: "FINANCE_COMPANY", accountingTreatment: "SELLING_EXPENSE",
      includedInQuotation: false, deductedFromSettlement: false, refundable: false,
      source: "MANUAL",
      createdBy: userId, createdAt: 1, updatedAt: 1,
    });
    const expenseIds = [];
    for (const amount of [200, 87.5, 15, 12]) {
      expenseIds.push(await ctx.db.insert("expenses", {
        orgId, vehicleId, title: "Synthetic car expense", amount, date: 1,
        category: "OTHER", status: "PAID", accountingTreatment: "PERIOD_EXPENSE",
      }));
    }
    const commissionIds = [];
    for (const amountMinor of [85_000, 25_000]) {
      commissionIds.push(await ctx.db.insert("dealCommissionLines", {
        orgId, saleId, employeeId: userId, kind: "EXECUTION", currency: "JOD", amountMinor, createdBy: userId,
      }));
    }
    return { orgId, userId, roleId, vehicleId, applicationId, saleId, feeId, expenseIds, commissionIds };
  });
  const asOwner = t.withIdentity({ subject: "net-profit-reader" });
  const read = async () => {
    if (!financed) return (await asOwner.query(api.sales.dealCockpit, { orgId: ids.orgId, saleId: ids.saleId }))?.money?.managementNetProfit;
    return (await asOwner.query(api.dealOverview.financedDealOverview, {
      orgId: ids.orgId, applicationId: ids.applicationId,
    }))?.financialSummary?.profit;
  };
  const expense = async (patch: Partial<Doc<"expenses">>) => t.run((ctx) => ctx.db.patch(ids.expenseIds[0], patch));
  return { t, ...ids, asOwner, read, expense };
}
