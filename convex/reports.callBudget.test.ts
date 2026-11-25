/**
 * SCRUM-1000: a report's whole query function stays within Convex's 4,096 db.get + db.query calls on both sides of the
 * switch between per-key and single-range settlement-evidence reads. convex-test ENFORCES the limit here
 * (`transactionLimits`), counted over the entire public query, caller included. Figures are read through the public
 * queries only. Evidence boundary: convex-test, not the Convex runtime; the rate-limiter component's own reads are not
 * visible to this meter and are covered by QUERY_CALL_RESERVE.
 *
 * Arithmetic for N pending financed deals, each with its own salesperson, invoice, journal and legacy quote:
 *   per-key calls  = caller + 6 child ranges + 5N (vehicle, application, invoice, journal, quote) + 2N (event, allocations)
 *   Sales & Profit : caller = 6 (user, org, membership, role, sales range, org currency)   -> 7N + 12 + 32 reserve <= 4096, N <= 578
 *   Performance    : caller = 6 + N (one user get per salesperson)                          -> 8N + 12 + 32 reserve <= 4096, N <= 506
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import { omit, withoutSystemFields } from "convex-helpers";
import { DATE, reportDealFixture } from "../test-utils/reportDealFixture";
import { seedSaleInvoice } from "../test-utils/saleInvoiceFixtures";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const strategies = vi.hoisted(() => [] as string[]);
vi.mock("./utils/reportSettlementEvidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/reportSettlementEvidence")>();
  return {
    ...actual,
    readSettlementEvidence: async (...args: Parameters<typeof actual.readSettlementEvidence>) => {
      const result = await actual.readSettlementEvidence(...args);
      strategies.push((result as { strategy?: string }).strategy ?? "UNREPORTED");
      return result;
    },
  };
});

const SALES_BELOW = 578;
const SALES_ABOVE = 584;
const PERFORMANCE_BELOW = 506;
const PERFORMANCE_ABOVE = 520;
const TOTAL = SALES_ABOVE;

type World = Awaited<ReturnType<typeof seedWorld>>;
let world: World;

async function seedWorld() {
  const s = await reportDealFixture({ transactionLimits: true });
  const template = await s.t.runUnwrapped(async (ctx) => {
    const [vehicle, app, sale, fee, expense] = await Promise.all([ctx.db.get(s.vehicleId), ctx.db.get(s.applicationId!),
      ctx.db.get(s.saleId), ctx.db.get(s.feeId!), ctx.db.get(s.expenseId)]);
    const quote = app ? await ctx.db.get(app.quoteId) : null;
    if (!vehicle || !app || !sale || !fee || !expense || !quote) throw new Error("Missing financed fixture");
    return { vehicle: withoutSystemFields(vehicle), app: omit(app, ["_id", "_creationTime", "finalizedSaleId"]),
      sale: withoutSystemFields(sale), fee: withoutSystemFields(fee), expense: withoutSystemFields(expense), quote: withoutSystemFields(quote) };
  });
  const saleIds: Id<"sales">[] = [];
  for (let index = 0; index < TOTAL; index += 1) {
    saleIds.push(await s.t.runUnwrapped(async (ctx) => {
      const salespersonId = await ctx.db.insert("users", { clerkId: `rep-${index}`, email: `rep-${index}@example.com`, name: `Rep ${index}` });
      const vehicleId = await ctx.db.insert("vehicles", template.vehicle);
      const quoteId = await ctx.db.insert("quotes", { ...template.quote, vehicleId });
      const applicationId = await ctx.db.insert("financeApplications", { ...template.app, vehicleId, quoteId,
        estimatedDealerBorneExpensesMinor: 600000, supplierDisbursedAmountMinor: 12000000 });
      const saleId = await ctx.db.insert("sales", { ...template.sale, vehicleId, applicationId, salespersonId });
      await ctx.db.patch(applicationId, { finalizedSaleId: saleId });
      await ctx.db.insert("expenses", { ...template.expense, vehicleId });
      await ctx.db.insert("financeDealFees", { ...template.fee, applicationId, reconciledAt: DATE });
      await ctx.db.insert("vehicleSupplierReceivables", { orgId: s.orgId, vehicleId, saleId, sourcedFromName: "Supplier", amountDue: 2100,
        amountReceived: 2100, currency: "JOD", status: "PAID", createdBy: s.userId, createdAt: DATE, updatedAt: DATE });
      await seedSaleInvoice(ctx, { orgId: s.orgId, saleId, userId: s.userId, customerId: s.customerId,
        originalMinor: 100000, openMinor: 0, posting: "POSTED" });
      return saleId;
    }));
  }
  // The fixture's own deal is outside the batch.
  await s.t.runUnwrapped((ctx) => ctx.db.patch(s.saleId, { isDeleted: true }));
  return { ...s, batch: saleIds };
}

/** Exactly `count` of the seeded deals are live; the rest are deleted and so outside both reports. */
async function liveDeals(count: number) {
  for (let from = 0; from < TOTAL; from += 150) {
    await world.t.runUnwrapped(async (ctx) => {
      for (let index = from; index < Math.min(from + 150, TOTAL); index += 1) await ctx.db.patch(world.batch[index], { isDeleted: index >= count ? true : undefined });
    });
  }
  strategies.length = 0;
}

beforeAll(async () => { world = await seedWorld(); }, 300000);

async function salesReport(count: number) {
  await liveDeals(count);
  const report = await world.asUser.query(api.reports.getSalesAndProfitReport, { orgId: world.orgId, startDate: DATE, endDate: DATE });
  return report!;
}

async function performance(count: number) {
  await liveDeals(count);
  return await world.asUser.query(api.reports.getSalespersonPerformance, { orgId: world.orgId, startDate: DATE, endDate: DATE });
}

function expectActualRows(rows: Awaited<ReturnType<typeof salesReport>>["sales"], count: number) {
  expect(rows).toHaveLength(count);
  for (const row of rows) {
    expect(row.profitClassification).toBe("ACTUAL_UNPOSTABLE");
    expect(row.netProfit).toBe(1133.7);
    expect(row.commissionsTotal).toBe(110);
    expect(row.netProfitAfterCommissions).toBe(1023.7);
  }
}

describe("SCRUM-1000 whole-query call budget of the report evidence reads", () => {
  test("Sales and Profit just below the switch reads per key, stays within 4096 calls and reads ACTUAL", async () => {
    const report = await salesReport(SALES_BELOW);
    expect(strategies).toEqual(["PER_KEY"]);
    expectActualRows(report.sales, SALES_BELOW);
  }, 120000);

  test("Sales and Profit just above the switch falls back to ranges, stays within 4096 calls and reads ACTUAL", async () => {
    const report = await salesReport(SALES_ABOVE);
    expect(strategies).toEqual(["RANGE"]);
    expectActualRows(report.sales, SALES_ABOVE);
  }, 120000);

  test("Salesperson Performance just below the switch reads per key and stays within 4096 calls", async () => {
    const rows = await performance(PERFORMANCE_BELOW);
    expect(strategies).toEqual(["PER_KEY"]);
    expect(rows).toHaveLength(PERFORMANCE_BELOW);
    for (const row of rows) expect(row.totalProfit).toBe(1133.7);
  }, 120000);

  test("Salesperson Performance just above the switch falls back to ranges and stays within 4096 calls", async () => {
    const rows = await performance(PERFORMANCE_ABOVE);
    expect(strategies).toEqual(["RANGE"]);
    expect(rows).toHaveLength(PERFORMANCE_ABOVE);
    for (const row of rows) expect(row.totalProfit).toBe(1133.7);
  }, 120000);
});
