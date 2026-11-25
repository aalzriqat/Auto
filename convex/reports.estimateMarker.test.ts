/**
 * SCRUM-1000: a Sales & Profit report row carries the same estimate marker as its deal page.
 * Both are read through the public queries (getSalesAndProfitReport, financedDealOverview), never helpers.
 * Literals come from test-utils/reportDealFixture (financed in-stock deal: before commissions 1133.7, commission 110,
 * after commissions 1023.7).
 * Evidence boundary: convex-test only, not the Convex runtime and not production data.
 */
import { describe, expect, test } from "vitest";
import { DATE, reportDealFixture as fixture } from "../test-utils/reportDealFixture";
import { seedSaleInvoice } from "../test-utils/saleInvoiceFixtures";
import { api } from "./_generated/api";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function settleDeal(s: Fixture) {
  await s.t.run(async (ctx) => {
    await ctx.db.patch(s.applicationId!, { settlementStatus: "FULLY_SETTLED", supplierDisbursedAmountMinor: 12000000 });
    await ctx.db.patch(s.feeId!, { reconciledAt: DATE });
    await seedSaleInvoice(ctx, { orgId: s.orgId, saleId: s.saleId, userId: s.userId,
      customerId: s.customerId, originalMinor: 100000, openMinor: 0, posting: "POSTED" });
  });
}

async function bothClassifications(s: Fixture) {
  const row = (await s.report())!.sales[0];
  const overview = await s.asUser.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId! });
  const page = overview?.financialSummary?.profitBeforeCommissions;
  return { row, page };
}

describe("SCRUM-1000 report row estimate marker matches the deal page", () => {
  test("settled financed deal whose profit does not depend on settlement: row and deal page both read ACTUAL_UNPOSTABLE", async () => {
    const s = await fixture({ stock: true });
    await settleDeal(s);
    const { row, page } = await bothClassifications(s);
    expect(page).toMatchObject({ available: true, amountMinor: 1133700, classification: "ACTUAL_UNPOSTABLE" });
    expect(row.netProfit).toBe(1133.7);
    expect(row.commissionsTotal).toBe(110);
    expect(row.netProfitAfterCommissions).toBe(1023.7);
    expect(row.profitClassification).toBe("ACTUAL_UNPOSTABLE");
  });

  test("unsettled financed deal: row and deal page both read ESTIMATED_AWAITING_SETTLEMENT", async () => {
    const s = await fixture({ stock: true });
    const { row, page } = await bothClassifications(s);
    expect(page).toMatchObject({ available: true, amountMinor: 1133700, classification: "ESTIMATED_AWAITING_SETTLEMENT" });
    expect(row.netProfit).toBe(1133.7);
    expect(row.profitClassification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("settled consigned financed deal: row and deal page both read ACTUAL_UNPOSTABLE", async () => {
    const s = await fixture();
    await settleDeal(s);
    await s.t.run((ctx) => ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, sourcedFromName: "Supplier",
      amountDue: 2100, amountReceived: 2100, currency: "JOD", status: "PAID",
      createdBy: s.userId, createdAt: DATE, updatedAt: DATE,
    }));
    const { row, page } = await bothClassifications(s);
    expect(page).toMatchObject({ available: true, amountMinor: 1133700, classification: "ACTUAL_UNPOSTABLE" });
    expect(row.netProfit).toBe(1133.7);
    expect(row.profitClassification).toBe("ACTUAL_UNPOSTABLE");
  });

  test("settling the deal moves the marker and no amount", async () => {
    const s = await fixture({ stock: true });
    const before = (await s.report())!.sales[0];
    await settleDeal(s);
    const after = (await s.report())!.sales[0];
    expect([after.netProfit, after.commissionsTotal, after.netProfitAfterCommissions, after.recognizedRevenue, after.totalCost])
      .toEqual([before.netProfit, before.commissionsTotal, before.netProfitAfterCommissions, before.recognizedRevenue, before.totalCost]);
    expect([before.netProfit, before.commissionsTotal, before.netProfitAfterCommissions]).toEqual([1133.7, 110, 1023.7]);
  });
});
