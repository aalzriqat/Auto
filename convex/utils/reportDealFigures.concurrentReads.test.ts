import { expect, test } from "vitest";
import { omit, withoutSystemFields } from "convex-helpers";
import type { QueryCtx } from "../_generated/server";
import type { Doc, TableNames } from "../_generated/dataModel";
import { DATE, reportDealFixture } from "../../test-utils/reportDealFixture";
import { seedSaleInvoice } from "../../test-utils/saleInvoiceFixtures";
import { loadReportDealFigures } from "./reportDealFigures";

type ReportQuery = ReturnType<QueryCtx["db"]["query"]>;
type MeasureRead = <T>(key: string, read: () => Promise<T>) => Promise<T>;

function measuredIndex(query: ReturnType<ReportQuery["withIndex"]>, table: TableNames, measure: MeasureRead) {
  return new Proxy(query, {
    get(target, property) {
      if (property === "take") return (count: number) => measure(`query:${table}`, () => target.take(count));
      return Reflect.get(target, property);
    },
  });
}

function measuredQuery(query: ReportQuery, table: TableNames, measure: MeasureRead) {
  return new Proxy(query, {
    get(target, property) {
      if (property === "withIndex") {
        return (...args: Parameters<ReportQuery["withIndex"]>) => measuredIndex(target.withIndex(...args), table, measure);
      }
      return Reflect.get(target, property);
    },
  });
}

/** Delay real database promises so immediately resolved harness reads cannot hide fan-out. */
function measuredReader(db: QueryCtx["db"]) {
  let inFlight = 0;
  let maximum = 0;
  const reads = new Map<string, number>();
  async function measure<T>(key: string, read: () => Promise<T>): Promise<T> {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    reads.set(key, (reads.get(key) ?? 0) + 1);
    try {
      const pending = read();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return await pending;
    } finally {
      inFlight -= 1;
    }
  }
  const measuredDb = new Proxy(db, {
    get(target, property) {
      if (property === "get") {
        return (id: Parameters<typeof db.get>[0]) => measure(String(id), () => target.get(id));
      }
      if (property === "query") {
        return (table: TableNames) => measuredQuery(target.query(table), table, measure);
      }
      return Reflect.get(target, property);
    },
  });
  return { db: measuredDb, reads, maximum: () => maximum, outstanding: () => inFlight };
}

async function financedBatch() {
  const s = await reportDealFixture();
  const sales = await s.t.runUnwrapped(async (ctx) => {
    const vehicle = await ctx.db.get(s.vehicleId);
    const app = await ctx.db.get(s.applicationId!);
    const sale = await ctx.db.get(s.saleId);
    const fee = await ctx.db.get(s.feeId!);
    const expense = await ctx.db.get(s.expenseId);
    const quote = app ? await ctx.db.get(app.quoteId) : null;
    if (!vehicle || !app || !sale || !fee || !expense || !quote) throw new Error("Missing financed fixture");
    const vehicleFields = withoutSystemFields(vehicle);
    const appFields = omit(app, ["_id", "_creationTime", "finalizedSaleId"]);
    const saleFields = withoutSystemFields(sale);
    const feeFields = withoutSystemFields(fee);
    const expenseFields = withoutSystemFields(expense);
    const quoteFields = withoutSystemFields(quote);
    const batch: Doc<"sales">[] = [];
    for (let index = 0; index < 800; index += 1) {
      const vehicleId = await ctx.db.insert("vehicles", vehicleFields);
      const quoteId = await ctx.db.insert("quotes", { ...quoteFields, vehicleId });
      const applicationId = await ctx.db.insert("financeApplications", { ...appFields, vehicleId, quoteId,
        estimatedDealerBorneExpensesMinor: 600000, supplierDisbursedAmountMinor: 12000000 });
      const saleId = await ctx.db.insert("sales", { ...saleFields, vehicleId, applicationId });
      await ctx.db.patch(applicationId, { finalizedSaleId: saleId });
      await ctx.db.insert("expenses", { ...expenseFields, vehicleId });
      await ctx.db.insert("financeDealFees", { ...feeFields, applicationId, reconciledAt: DATE });
      await ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId, vehicleId, saleId, sourcedFromName: "Supplier", amountDue: 2100,
        amountReceived: 2100, currency: "JOD", status: "PAID", createdBy: s.userId, createdAt: DATE, updatedAt: DATE,
      });
      await seedSaleInvoice(ctx, { orgId: s.orgId, saleId, userId: s.userId,
        customerId: s.customerId, originalMinor: 100000, openMinor: 0, posting: "POSTED" });
      const completedSale = await ctx.db.get(saleId);
      if (!completedSale) throw new Error("Missing batch sale");
      batch.push(completedSale);
    }
    return batch.reverse();
  });
  return { ...s, sales };
}

test("SCRUM-928: 800 distinct financed deals keep every read phase within 100 outstanding operations", async () => {
  const s = await financedBatch();
  await s.t.run(async (ctx) => {
    const meter = measuredReader(ctx.db);
    const figures = await loadReportDealFigures({ ...ctx, db: meter.db }, { orgId: s.orgId, sales: s.sales, orgCurrency: "JOD" });
    console.info(`SCRUM-928 measured maximum outstanding reads: ${meter.maximum()}`);
    expect(figures.map((figure) => figure.sale._id)).toEqual(s.sales.map((sale) => sale._id));
    expect(figures).toHaveLength(800);
    for (const figure of figures) {
      expect(figure.profitBeforeCommissions).toMatchObject({ available: true, amountMinor: 1133700 });
      expect(figure.profit).toMatchObject({ available: true, amountMinor: 1023700 });
      expect(figure.salePrice).toBe(12100);
    }
    // These counts prove invoice, journal and legacy quotation phases actually ran.
    const documentReads = [...meter.reads.entries()].filter(([key]) => !key.startsWith("query:"));
    expect(documentReads).toHaveLength(4000);
    expect(documentReads.every(([, count]) => count === 1)).toBe(true);
    expect(meter.reads.get("query:paymentAllocations")).toBe(1);
    expect(meter.reads.get("query:accountingEvents")).toBe(1);
    expect(meter.outstanding()).toBe(0);
    expect(meter.maximum()).toBeGreaterThan(0);
    expect(meter.maximum()).toBeLessThanOrEqual(100);
  });
}, 30000);
