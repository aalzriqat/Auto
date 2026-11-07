import { describe, expect, test } from "vitest";
import { DATE, reportDealFixture as fixture } from "../test-utils/reportDealFixture";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { seedSaleInvoice } from "../test-utils/saleInvoiceFixtures";

async function expectParity(s: Awaited<ReturnType<typeof fixture>>, amount: number, before: number) {
  const deal = await s.deal();
  expect(deal.profit).toMatchObject({ available: true, amountMinor: amount });
  const report = await s.report();
  expect(report).not.toBeNull();
  expect(report!.sales).toHaveLength(1);
  const row = report!.sales[0];
  expect(row.netProfit).toBe(before);
  expect(row.netProfitAfterCommissions).toBe(amount / 1000);
  expect(row.salePrice).toBe(deal.price! / 1000);
  expect(row.salePrice).toBe(12100);
  expect(report!.totalProfit).toBe(before);
  expect(report!.totalNetProfitAfterCommissions).toBe(amount / 1000);
  expect(report!.totalRevenue - report!.totalCost).toBeCloseTo(report!.totalProfit, 8);
  const reps = await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE });
  expect(reps?.[0].totalProfit).toBe(before);
  expect(reps?.[0].totalNetProfitAfterCommissions).toBe(amount / 1000);
}

describe("SCRUM-928 report matches the deal page", () => {
  // Scenario records require one non-parameterized registration per binding.
  test("owner before sale commission: MANAGER SOURCED financed", async () => {
    await expectSaleCommissionSplit({ role: "MANAGER", cash: false, before: 1133.7, after: 1023.7, pageMinor: 1023700 });
  });
  test("owner before sale commission: ADMIN SOURCED financed", async () => {
    await expectSaleCommissionSplit({ role: "ADMIN", cash: false, before: 1133.7, after: 1023.7, pageMinor: 1023700 });
  });
  test("owner before sale commission: MANAGER CASH", async () => {
    await expectSaleCommissionSplit({ role: "MANAGER", cash: true, before: 1900, after: 1790, pageMinor: 1790000 });
  });
  test("owner before sale commission: ADMIN CASH", async () => {
    await expectSaleCommissionSplit({ role: "ADMIN", cash: true, before: 1900, after: 1790, pageMinor: 1790000 });
  });
  async function expectSaleCommissionSplit({ role, cash, before, after, pageMinor }: {
    role: "MANAGER" | "ADMIN"; cash: boolean; before: number; after: number; pageMinor: number;
  }) {
    const s = await fixture({ cash });
    await s.t.run(async (ctx) => {
      await ctx.db.insert("orgSettings", {
        orgId: s.orgId, currency: "JOD", currencySymbol: "JOD", enabledPaymentTypes: [], commissionMode: "MANUAL",
      });
      await ctx.db.patch(s.saleId, { commissionAmount: undefined });
    });
    // Use the public sale-commission door with the shipped pilot configuration.
    await s.asUser.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId: s.saleId, commissionAmount: 110 });
    expect((await s.deal()).profit).toMatchObject({ available: true, amountMinor: pageMinor });
    await s.t.run(async (ctx) => {
      const manager = DEFAULT_ROLE_TEMPLATES.find((template) => template.name === "MANAGER");
      if (!manager) throw new Error("MANAGER template missing");
      await ctx.db.patch(s.roleId, { name: role, permissions: role === "MANAGER" ? manager.permissions : ALL_PERMISSIONS });
    });
    const report = await s.report();
    expect(report!.sales[0]).toMatchObject({ netProfit: before, netProfitAfterCommissions: after, commissionsTotal: 110 });
    expect(report).toMatchObject({ totalProfit: before, totalNetProfitAfterCommissions: after, totalCommissions: 110, commissionIncompleteSaleCount: 0 });
    expect(await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE }))
      .toMatchObject([{ totalProfit: before, totalNetProfitAfterCommissions: after, totalCommissions: 110, commissionIncompleteSaleCount: 0 }]);
  }
  test("pending commissions keep SOURCED financed profit available", async () => {
    await expectPendingCommissions({ cash: false, before: 1133.7 });
  });
  test("pending commissions keep CASH profit available", async () => {
    await expectPendingCommissions({ cash: true, before: 1900 });
  });
  async function expectPendingCommissions({ cash, before }: { cash: boolean; before: number }) {
    const s = await fixture({ cash });
    await s.t.run((ctx) => ctx.db.patch(s.saleId, { commissionAmount: undefined }));
    expect((await s.deal()).profit).toEqual({ available: false, reason: "CommissionsPending" });
    expect(await s.report()).toMatchObject({
      totalProfit: before, totalNetProfitAfterCommissions: 0, commissionIncompleteSaleCount: 1, unknownMarginSaleCount: 0,
      sales: [{ netProfit: before, netProfitAfterCommissions: null, commissionPending: true, profitUnavailableReason: null, includedInTotals: true }],
    });
    expect(await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE }))
      .toMatchObject([{ totalProfit: before, totalNetProfitAfterCommissions: 0, commissionIncompleteSaleCount: 1, marginComplete: true }]);
  }
  test("SOURCED DIRECT: 1023.700 net and 12100 customer price, including fee, expense and commissions", async () => {
    await expectParity(await fixture(), 1023700, 1133.7);
  });
  test("financed STOCK uses the same management net", async () => {
    await expectParity(await fixture({ stock: true }), 1023700, 1133.7);
  });
  test("cash without an application uses the cash cockpit management net", async () => {
    await expectParity(await fixture({ cash: true }), 1790000, 1900);
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
  test("without view:commissions, reports retain profit and withhold commission fields", async () => {
    const s = await fixture({ without: "view:commissions" });
    expect((await s.deal()).profit).toEqual({ available: false, reason: "CommissionAccessRequired" });
    const overview = await s.asUser.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId! });
    expect(overview?.financialSummary).not.toHaveProperty("profitBeforeCommissions");
    const report = await s.report();
    expect(report!.sales[0].netProfit).toBe(1133.7);
    expect(report!.sales[0].salePrice).toBe(12100);
    expect(report!.sales[0].profitUnavailableReason).toBeNull();
    expect(report!.sales[0].netProfitAfterCommissions).toBeNull();
    expect(report!.sales[0].commissionsTotal).toBeNull();
    expect(report!.sales[0].commissionPending).toBe(false);
    expect(report!.totalProfit).toBe(1133.7);
    expect(report!.totalRevenue).toBe(1885);
    expect(report!.totalCost).toBeCloseTo(751.3, 8);
    expect(report!.unknownMarginSaleCount).toBe(0);
    expect(report!.totalCommissions).toBeNull();
    expect(report!.totalNetProfitAfterCommissions).toBeNull();
    expect(report!.commissionIncompleteSaleCount).toBeNull();
    const performance = await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE });
    expect(performance).toMatchObject([{
      totalRevenue: 1885, totalProfit: 1133.7, marginComplete: true,
      totalCommissions: null, totalNetProfitAfterCommissions: null, commissionIncompleteSaleCount: null,
    }]);
  });
  test("without view:cost_price, report remains null", async () => {
    const s = await fixture({ without: "view:cost_price" });
    expect(await s.report()).toBeNull();
    expect((await s.deal()).profit).toEqual({ available: false, reason: "CostAccessRequired" });
  });
  test("a late fee actual updates both live figures", async () => {
    const s = await fixture();
    await s.t.run((ctx) => ctx.db.patch(s.feeId!, { actualAmountMinor: 500000 }));
    await expectParity(s, 975000, 1085);
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
    await expectParity(s, 1023700, 1133.7);
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
    await expectParity(s, 1023700, 1133.7);
  });
  test("THROUGH_SHOWROOM reads this sale's supplier payable", async () => {
    const s = await fixture({ direct: false });
    await s.t.run(async (ctx) => {
      await ctx.db.insert("vehicleSupplierPayables", {
        orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, sourcedFromName: "Supplier",
        amountDue: 9900, currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId, createdAt: DATE, updatedAt: DATE,
      });
    });
    await expectParity(s, 1023700, 1133.7);
  });
  test("legacy forecast above actual keeps unsettled before and after profit", async () => {
    await expectLegacyFeeBasis({ settled: false, pending: false, before: 985 });
  });
  test("legacy forecast above actual uses settled before and after profit", async () => {
    await expectLegacyFeeBasis({ settled: true, pending: false, before: 1133.7 });
  });
  test("pending commissions preserve unsettled forecast profit", async () => {
    await expectLegacyFeeBasis({ settled: false, pending: true, before: 985 });
  });
  test("pending commissions preserve settled actual profit", async () => {
    await expectLegacyFeeBasis({ settled: true, pending: true, before: 1133.7 });
  });
  async function expectLegacyFeeBasis({ settled, pending, before }: { settled: boolean; pending: boolean; before: number }) {
    const s = await fixture();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.applicationId!, { estimatedDealerBorneExpensesMinor: 600000, supplierDisbursedAmountMinor: 12000000 });
      await ctx.db.patch(s.feeId!, { reconciledAt: DATE });
      await ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, sourcedFromName: "Supplier",
        amountDue: 2100, amountReceived: 2100, currency: "JOD", status: "PAID",
        createdBy: s.userId, createdAt: DATE, updatedAt: DATE,
      });
      await seedSaleInvoice(ctx, { orgId: s.orgId, saleId: s.saleId, userId: s.userId,
        customerId: s.customerId, originalMinor: 100000, openMinor: settled ? 0 : 100000, posting: "POSTED" });
      if (pending) await ctx.db.patch(s.saleId, { commissionAmount: undefined });
    });
    if (!pending) await expectParity(s, settled ? 1023700 : 875000, before);
    else {
      expect((await s.deal()).profit).toEqual({ available: false, reason: "CommissionsPending" });
      expect(await s.report()).toMatchObject({ totalProfit: before, sales: [{ netProfit: before, netProfitAfterCommissions: null }], commissionIncompleteSaleCount: 1 });
      expect(await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE }))
        .toMatchObject([{ totalProfit: before, totalNetProfitAfterCommissions: 0, commissionIncompleteSaleCount: 1 }]);
    }
  }
  test("an unreadable legal invoice does not fall back to a readable quotation", async () => {
    const s = await fixture();
    await s.t.run((ctx) => ctx.db.patch(s.applicationId!, { legalInvoiceAmountMinor: Number.NaN }));
    expect((await s.deal()).price).toBeUndefined();
    expect((await s.report())!.sales[0].salePrice).toBeNull();
    expect((await s.report())!.sales[0].salePriceUnavailableReason).toBe("UNSAFE_AMOUNT");
  });
  test("removed preparation expense changes both management nets", async () => {
    const s = await fixture();
    await s.t.run((ctx) => ctx.db.patch(s.expenseId, { isDeleted: true }));
    await expectParity(s, 1323700, 1433.7);
  });
  test("Keep today's view: without view:finance, reports retain figures with report and cost access", async () => {
    const s = await fixture({ without: "view:finance" });
    expect((await s.deal()).profit).toBeUndefined();
    const report = await s.report();
    expect(report!.sales[0]).toMatchObject({
      netProfit: 1133.7, netProfitAfterCommissions: 1023.7, salePrice: 12100,
      profitUnavailableReason: null, salePriceUnavailableReason: null, includedInTotals: true,
    });
    const performance = await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE });
    await s.t.run((ctx) => ctx.db.patch(s.roleId, { permissions: ALL_PERMISSIONS }));
    const withFinance = await s.report();
    const { commissionBase: _commissionBase, consignedSupplierConcessionMinor: _concession, ...financeRow } = withFinance!.sales[0];
    expect(report).toEqual({ ...withFinance, sales: [financeRow] });
    expect(performance).toEqual(await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE }));
  });
  test.each([
    { cash: true, label: "CASH", net: 1790, before: 1900 },
    { cash: false, label: "SOURCED financed", net: 1023.7, before: 1133.7 },
  ])("MANAGER template sees the owner's report figures for $label", async ({ cash, net, before }) => {
    const manager = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "MANAGER");
    if (!manager) throw new Error("MANAGER template missing");
    expect(manager.permissions).toEqual(expect.arrayContaining(["view:reports", "view:cost_price", "view:commissions"]));
    expect(manager.permissions).not.toContain("view:finance");
    const s = await fixture({ cash });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.roleId, { name: "OWNER", isSystemOwnerRole: true });
      const roleId = await ctx.db.insert("roles", { orgId: s.orgId, ...manager, isSystemOwnerRole: false });
      const userId = await ctx.db.insert("users", { clerkId: "manager", email: "manager@example.com", name: "Manager" });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
    });
    const asManager = s.t.withIdentity({ subject: "manager" });
    const args = { orgId: s.orgId, startDate: DATE, endDate: DATE };
    const ownerReport = await s.report();
    const managerReport = await asManager.query(api.reports.getSalesAndProfitReport, args);
    expect(managerReport!.sales[0]).toMatchObject({ salePrice: 12100, netProfit: before, netProfitAfterCommissions: net });
    const { commissionBase: _commissionBase, consignedSupplierConcessionMinor: _concession, ...ownerRow } = ownerReport!.sales[0];
    expect(managerReport).toEqual({ ...ownerReport, sales: [ownerRow] });
    const ownerPerformance = await s.asUser.query(api.reports.getSalespersonPerformance, args);
    expect(ownerPerformance).toMatchObject([{ totalProfit: before, totalNetProfitAfterCommissions: net }]);
    expect(await asManager.query(api.reports.getSalespersonPerformance, args)).toEqual(ownerPerformance);
  });
  test("fee evidence uses application linkage even if its tenant stamp is inconsistent", async () => {
    const s = await fixture();
    await s.t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other", createdAt: DATE });
      await ctx.db.patch(s.feeId!, { orgId: otherOrgId });
    });
    await expectParity(s, 1023700, 1133.7);
  });
});
