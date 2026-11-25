/**
 * SCRUM-928 phase 2: every Sales & Profit report row foots on screen and reconciles to the deal page.
 * All figures are read through the public queries (getSalesAndProfitReport, financedDealOverview), never helpers.
 *
 * Row identities (major units, one included row so card totals equal the row):
 *   I1  sum(sign * amount) over profitLines                = netProfit  (profit before commissions)
 *   I2  netProfit - commissionsTotal                       = netProfitAfterCommissions (the deal page net)
 *   I3  card totals                                        = sum of the included rows
 *   I4  recognizedRevenue - totalCost                      = netProfit
 * Literals come from the fixture in test-utils/reportDealFixture (SOURCED financed: before 1133.7, commission 110,
 * after 1023.7; cash: before 1900, after 1790; unsettled legacy fee: before 985, after 875).
 * Evidence boundary: convex-test only, not the Convex runtime and not production data.
 */
import { describe, expect, test } from "vitest";
import { DATE, reportDealFixture as fixture } from "../test-utils/reportDealFixture";
import { seedSaleInvoice } from "../test-utils/saleInvoiceFixtures";
import { api } from "./_generated/api";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Report = NonNullable<Awaited<ReturnType<Fixture["report"]>>>;

function expectRowFoots(report: Report, expected: { before: number; after: number; commissions: number }) {
  expect(report.sales).toHaveLength(1);
  const row = report.sales[0];
  const lines = row.profitLines ?? [];
  expect(lines.length).toBeGreaterThan(0);
  // I1: the served working adds up to the column the reader sees.
  const worked = lines.reduce((total, line) => total + line.sign * line.amount, 0);
  expect(worked).toBeCloseTo(row.netProfit as number, 6);
  expect(row.netProfit).toBe(expected.before);
  // I2
  expect((row.netProfit as number) - (row.commissionsTotal as number)).toBeCloseTo(row.netProfitAfterCommissions as number, 6);
  expect(row.commissionsTotal).toBe(expected.commissions);
  expect(row.netProfitAfterCommissions).toBe(expected.after);
  // I4
  expect((row.recognizedRevenue as number) - (row.totalCost as number)).toBeCloseTo(row.netProfit as number, 6);
  // I3
  expect(report.totalProfit).toBeCloseTo(row.netProfit as number, 6);
  expect(report.totalRevenue).toBeCloseTo(row.recognizedRevenue as number, 6);
  expect(report.totalCost).toBeCloseTo(row.totalCost as number, 6);
  expect(report.totalNetProfitAfterCommissions).toBeCloseTo(row.netProfitAfterCommissions as number, 6);
  // The commission is a column of its own: the working before commissions never carries it.
  expect(lines.some((line) => (line.key as string) === "COMMISSIONS")).toBe(false);
}

describe("SCRUM-928 report rows foot and reconcile to the deal page", () => {
  test("cash sale: working foots to 1900, 110 commission, 1790 after", async () => {
    const s = await fixture({ cash: true });
    expectRowFoots((await s.report())!, { before: 1900, after: 1790, commissions: 110 });
    expect((await s.report())!.sales[0].profitClassification ?? null).toBeNull();
  });

  test("financed in-stock deal with dealer contribution: working foots to 1133.7 and matches the deal page", async () => {
    const s = await fixture({ stock: true });
    const report = (await s.report())!;
    expectRowFoots(report, { before: 1133.7, after: 1023.7, commissions: 110 });
    const overview = await s.asUser.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId! });
    const page = overview?.financialSummary?.profitBeforeCommissions;
    expect(page).toMatchObject({ available: true, amountMinor: 1133700 });
    // Same lines, same order, same signs as the deal page working.
    const row = report.sales[0];
    expect((row.profitLines ?? []).map((l) => [l.key, l.sign, Math.round(l.amount * 1000)])).toEqual(
      page && page.available ? page.lines.map((l) => [l.key, l.sign, l.amountMinor]) : "deal page profitBeforeCommissions missing",
    );
    expect(overview?.financialSummary?.profit).toMatchObject({ available: true, amountMinor: 1023700 });
  });

  test("SOURCED financed deal (consignment): working foots to 1133.7 and shows the supplier share as a deduction", async () => {
    const s = await fixture();
    const report = (await s.report())!;
    expectRowFoots(report, { before: 1133.7, after: 1023.7, commissions: 110 });
    const keys = (report.sales[0].profitLines ?? []).map((line) => line.key as string);
    expect(keys).toContain("SUPPLIER_SETTLEMENT");
    expect(keys).not.toContain("VEHICLE_COST");
  });

  test("estimated, unsettled deal: row foots to 985 and is marked as an estimate", async () => {
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
        customerId: s.customerId, originalMinor: 100000, openMinor: 100000, posting: "POSTED" });
    });
    const report = (await s.report())!;
    expectRowFoots(report, { before: 985, after: 875, commissions: 110 });
    expect(report.sales[0].profitClassification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("unknown profit shows as unavailable with no working, never as zero", async () => {
    const s = await fixture();
    await s.t.run((ctx) => ctx.db.patch(s.feeId!, { actualAmountMinor: Number.NaN }));
    const row = (await s.report())!.sales[0];
    expect(row.netProfit).toBeNull();
    expect(row.profitLines ?? []).toEqual([]);
    expect(row.profitUnavailableReason).toBe("ExpensesUnreadable");
  });

  test("without view:commissions the row keeps its working and the deal page serves no before-commissions subtotal", async () => {
    const s = await fixture({ without: "view:commissions" });
    const row = (await s.report())!.sales[0];
    expect(row.netProfitAfterCommissions).toBeNull();
    expect(row.commissionsTotal).toBeNull();
    const lines = row.profitLines ?? [];
    expect(lines.reduce((total, line) => total + line.sign * line.amount, 0)).toBeCloseTo(1133.7, 6);
    expect(lines.some((line) => (line.key as string) === "COMMISSIONS")).toBe(false);
    const overview = await s.asUser.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId! });
    expect(overview?.financialSummary).not.toHaveProperty("profitBeforeCommissions");
  });

  test("without view:cost_price the report is null, so no working can leak", async () => {
    const s = await fixture({ without: "view:cost_price" });
    expect(await s.report()).toBeNull();
  });
});
