/**
 * SCRUM-1000: the settlement-evidence (PENDING) reads of a report are bounded by the pending rows of THIS report,
 * never by the organization's lifetime sale history or by other tenants' allocations.
 * Evidence boundary: convex-test only; rows are counted at the db proxy, not measured on the Convex runtime.
 */
import { expect, test } from "vitest";
import { omit, withoutSystemFields } from "convex-helpers";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { DATE, reportDealFixture } from "../../test-utils/reportDealFixture";
import { seedSaleInvoice } from "../../test-utils/saleInvoiceFixtures";
import { loadReportDealFigures } from "./reportDealFigures";

type RowReads = Map<string, number>;

/** Counts the rows every indexed table read hands back, whichever terminal the reader uses. */
function rowCountingDb(db: QueryCtx["db"], rows: RowReads): QueryCtx["db"] {
  const count = (table: string, result: unknown) => {
    const n = Array.isArray(result) ? result.length : result ? 1 : 0;
    rows.set(table, (rows.get(table) ?? 0) + n);
    return result;
  };
  const wrapIndexed = (indexed: object, table: string) => new Proxy(indexed, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "take" || property === "first" || property === "collect" || property === "unique") {
        return async (...args: unknown[]) => count(table, await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property !== "query") return Reflect.get(target, property);
      return (table: TableNames) => {
        const query = target.query(table);
        return new Proxy(query, {
          get(q, p) {
            if (p === "withIndex") return (...a: unknown[]) => wrapIndexed((q.withIndex as (...x: unknown[]) => object)(...a), table);
            return Reflect.get(q, p);
          },
        });
      };
    },
  });
}

/** Two settled, fully paid financed deals whose profit differs settled/unsettled, so both take the PENDING path. */
async function pendingPair(afterFirstInvoice?: (ctx: MutationCtx, s: { orgId: Id<"organizations">; userId: Id<"users"> }) => Promise<void>) {
  const s = await reportDealFixture();
  const sales = await s.t.runUnwrapped(async (ctx) => {
    const [vehicle, app, sale, fee, expense, quote] = await Promise.all([ctx.db.get(s.vehicleId), ctx.db.get(s.applicationId!),
      ctx.db.get(s.saleId), ctx.db.get(s.feeId!), ctx.db.get(s.expenseId), ctx.db.get(s.applicationId!).then((a) => a ? ctx.db.get(a.quoteId) : null)]);
    if (!vehicle || !app || !sale || !fee || !expense || !quote) throw new Error("Missing financed fixture");
    const batch: Doc<"sales">[] = [];
    for (let index = 0; index < 2; index += 1) {
      const vehicleId = await ctx.db.insert("vehicles", withoutSystemFields(vehicle));
      const quoteId = await ctx.db.insert("quotes", { ...withoutSystemFields(quote), vehicleId });
      const applicationId = await ctx.db.insert("financeApplications", { ...omit(app, ["_id", "_creationTime", "finalizedSaleId"]),
        vehicleId, quoteId, estimatedDealerBorneExpensesMinor: 600000, supplierDisbursedAmountMinor: 12000000 });
      const saleId = await ctx.db.insert("sales", { ...withoutSystemFields(sale), vehicleId, applicationId });
      await ctx.db.patch(applicationId, { finalizedSaleId: saleId });
      await ctx.db.insert("expenses", { ...withoutSystemFields(expense), vehicleId });
      await ctx.db.insert("financeDealFees", { ...withoutSystemFields(fee), applicationId, reconciledAt: DATE });
      await ctx.db.insert("vehicleSupplierReceivables", { orgId: s.orgId, vehicleId, saleId, sourcedFromName: "Supplier", amountDue: 2100,
        amountReceived: 2100, currency: "JOD", status: "PAID", createdBy: s.userId, createdAt: DATE, updatedAt: DATE });
      await seedSaleInvoice(ctx, { orgId: s.orgId, saleId, userId: s.userId, customerId: s.customerId,
        originalMinor: 100000, openMinor: 0, posting: "POSTED" });
      if (index === 0 && afterFirstInvoice) await afterFirstInvoice(ctx, s);
      const completed = await ctx.db.get(saleId);
      if (!completed) throw new Error("Missing batch sale");
      batch.push(completed);
    }
    return batch;
  });
  return { ...s, sales };
}

async function loadCounting(s: Awaited<ReturnType<typeof pendingPair>>) {
  const rows: RowReads = new Map();
  const figures = await s.t.run((ctx) => loadReportDealFigures({ ...ctx, db: rowCountingDb(ctx.db, rows) },
    { orgId: s.orgId, sales: s.sales, orgCurrency: "JOD", callsAlreadySpent: 0 }));
  return { rows, figures };
}

test("pending path reads only the events of its own pending sales, not the org's sale history", async () => {
  const s = await pendingPair();
  await s.t.run(async (ctx) => {
    for (let index = 0; index < 40; index += 1) {
      await ctx.db.insert("accountingEvents", { orgId: s.orgId, eventType: "SALE_COMPLETED", sourceType: "sales", sourceId: `unrelated${index}`,
        eventVersion: 1, idempotencyKey: `sale_completed_unrelated${index}`, occurredAt: DATE, accountingDate: DATE, currency: "JOD",
        payload: {}, status: "POSTED", createdBy: s.userId, createdAt: DATE });
    }
  });
  const { rows, figures } = await loadCounting(s);
  expect(figures).toHaveLength(2);
  expect(rows.get("accountingEvents")).toBe(2);
});

test("pending path counts no allocation of another invoice lying between two pending invoice ids", async () => {
  const foreign: Id<"receivableDocuments">[] = [];
  // Created between the two pending invoices, so it lies inside the id range the old range read covered.
  const s = await pendingPair(async (ctx, seed) => {
    for (let index = 0; index < 3; index += 1) {
      const foreignId = await ctx.db.insert("receivableDocuments", { orgId: seed.orgId, documentType: "INVOICE", documentNumber: `FOREIGN-${index}`,
        payerType: "CUSTOMER", sourceType: "sales", sourceId: `foreign${index}`, originalAmountMinor: 1000, currency: "JOD", scale: 3,
        issueDate: DATE, dueDate: DATE, status: "OPEN", createdAt: DATE, createdBy: seed.userId });
      const paymentId = await ctx.db.insert("canonicalPayments", { orgId: seed.orgId, direction: "IN", payerType: "CUSTOMER", method: "CASH",
        amountMinor: 1000, currency: "JOD", scale: 3, status: "SETTLED", idempotencyKey: `foreign-${index}`, createdBy: seed.userId, createdAt: DATE });
      await ctx.db.insert("paymentAllocations", { orgId: seed.orgId, paymentId, receivableDocumentId: foreignId, amountMinor: 1000, currency: "JOD",
        scale: 3, allocationDate: DATE, status: "ACTIVE", createdBy: seed.userId, createdAt: DATE });
      foreign.push(foreignId);
    }
  });
  const [low, high] = s.sales.map((sale) => sale.canonicalReceivableDocumentId as string).sort();
  expect(foreign.every((id) => id > low && id < high)).toBe(true);
  const { rows } = await loadCounting(s);
  // One payment allocation per pending invoice (seedSaleInvoice pays each in full); nothing else is read.
  expect(rows.get("paymentAllocations")).toBe(2);
});
