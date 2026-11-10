import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { outstanding as outstandingRegistration, settled as settledRegistration } from "./supplierStatement";
import { vehicles as relationshipRegistration } from "./supplierRelationships";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const modules = import.meta.glob("./**/*.*s");
const NOW = Date.parse("2026-11-10T09:00:00Z");
const vehicles = makeFunctionReference<"query">("supplierRelationships:vehicles");
afterEach(() => vi.useRealTimers());

async function seed(permissions = ["view:finance", "view:cost_price", "view:vehicles", "view:sales", "view:expenses", "manage:finance"], transactionLimits = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, modules, { transactionLimits });
  const orgId = await t.run(ctx => ctx.db.insert("organizations", { name: "Synthetic dealer", createdAt: NOW }));
  const foreignOrg = await t.run(ctx => ctx.db.insert("organizations", { name: "Other dealer", createdAt: NOW }));
  const userId = await t.run(ctx => ctx.db.insert("users", { clerkId: "navigation", email: "synthetic@example.test", name: "Operator" }));
  const roleId = await t.run(ctx => ctx.db.insert("roles", { orgId, name: "Custom", permissions }));
  await t.run(ctx => ctx.db.insert("memberships", { orgId, roleId, userId }));
  await t.run(ctx => ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: NOW, updatedAt: NOW }));
  const supplierId = await seedSupplier(t, { orgId, userId, displayName: "Same name" });
  const otherId = await seedSupplier(t, { orgId, userId, displayName: "Same name" });
  const foreignSupplier = await seedSupplier(t, { orgId: foreignOrg, userId, displayName: "Same name" });
  const asUser = t.withIdentity({ subject: "navigation" });
  const vehicleId = await t.run(ctx => ctx.db.insert("vehicles", {
    orgId, make: "Toyota", model: "Camry", year: 2024, mileage: 1, color: "White", fuelType: "Gas",
    transmission: "Auto", sellingPrice: 13000, sourceCost: 9500, status: "AVAILABLE", sourceType: "SOURCED", sourcedSupplierId: supplierId,
  }));
  return { t, orgId, foreignOrg, foreignSupplier, userId, roleId, supplierId, otherId, vehicleId, asUser };
}
type Seed = Awaited<ReturnType<typeof seed>>;
async function payable(s: Seed, patch: Partial<Extract<Doc<"vehicleSupplierPayables">, { vehicleId: unknown }>> = {}) {
  return s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", {
    orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, sourcedFromName: "Original supplier snapshot",
    amountDue: 9500, currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...patch,
  }));
}
const outstanding = (s: Seed) => s.asUser.query(api.supplierStatement.outstanding, { orgId: s.orgId, supplierId: s.supplierId, nowMs: NOW });
const related = (s: Seed, kind = "SOURCED", paginationOpts = { numItems: 25, cursor: null as string | null }) =>
  s.asUser.query(vehicles, { orgId: s.orgId, supplierId: s.supplierId, kind, paginationOpts });

async function financedSale(s: Seed) {
  return s.t.run(async ctx => {
    const customerId = await ctx.db.insert("customers", { orgId: s.orgId, firstName: "Synthetic", lastName: "Buyer" });
    const companyId = await ctx.db.insert("financeCompanies", { orgId: s.orgId, name: "Synthetic lender", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 3 });
    const quoteId = await ctx.db.insert("quotes", { orgId: s.orgId, vehicleId: s.vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000, totalFinancedAmount: 10000, termMonths: 24, status: "DRAFT", companyId, createdBy: s.userId, createdAt: NOW });
    const applicationId = await ctx.db.insert("financeApplications", { orgId: s.orgId, vehicleId: s.vehicleId, customerId, companyId, quoteId, salespersonId: s.userId, status: "CLOSED", createdAt: NOW, updatedAt: NOW });
    const saleId = await ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId, salespersonId: s.userId, applicationId, salePrice: 12000, saleDate: NOW, status: "COMPLETED", dealNumber: 941 });
    await ctx.db.insert("vehicleSupplierReceivables", { orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, saleId, sourcedFromName: "Synthetic supplier payer", amountDue: 3000, currency: "JOD", status: "OPEN", createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
    return { saleId, applicationId };
  });
}

async function measureHandler(s: Seed, registered: unknown, args: unknown) {
  if (typeof registered !== "function" || !("_handler" in registered) || typeof registered._handler !== "function") throw new Error("Registered handler unavailable");
  const handler = registered._handler;
  return s.asUser.run(async ctx => {
    const reads = vi.spyOn(ctx.db, "get"); // Call-through: every recorded get performs actual harness I/O.
    try {
      const response: unknown = await handler(ctx, args);
      return { response, gets: reads.mock.calls.length };
    } finally { reads.mockRestore(); }
  });
}

async function seedReadBound(s: Seed, unique: boolean) {
  const targets = await s.t.run(async ctx => {
    const customerId = await ctx.db.insert("customers", { orgId: s.orgId, firstName: "Synthetic", lastName: "Buyer" });
    const companyId = await ctx.db.insert("financeCompanies", { orgId: s.orgId, name: "Synthetic", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 3 });
    const original = await ctx.db.get(s.vehicleId);
    if (!original) throw new Error("Missing fixture");
    const { _id, _creationTime, ...vehicleFields } = original;
    const vehicleIds = [];
    const saleIds = [];
    const expenseIds = [];
    for (let index = 0; index < (unique ? 300 : 1); index += 1) {
      const vehicleId = await ctx.db.insert("vehicles", { ...vehicleFields });
      vehicleIds.push(vehicleId);
      if (index < 200) {
        const quoteId = await ctx.db.insert("quotes", { orgId: s.orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000, totalFinancedAmount: 10000, termMonths: 24, status: "DRAFT", companyId, createdBy: s.userId, createdAt: NOW });
        const applicationId = await ctx.db.insert("financeApplications", { orgId: s.orgId, vehicleId, customerId, companyId, quoteId, salespersonId: s.userId, status: "CLOSED", createdAt: NOW, updatedAt: NOW });
        saleIds.push(await ctx.db.insert("sales", { orgId: s.orgId, vehicleId, customerId, salespersonId: s.userId, salePrice: 12000, saleDate: NOW, status: "COMPLETED", supplierSettlementRoute: "THROUGH_DEALERSHIP", applicationId }));
      }
      if (index >= 200 || !unique) expenseIds.push(await ctx.db.insert("expenses", { orgId: s.orgId, vehicleId, title: "Synthetic invoice", amount: 20, date: NOW, category: "TRANSPORT", status: "PAID" }));
    }
    return { vehicleIds, saleIds, expenseIds };
  });
  await s.t.run(async ctx => {
    for (let index = 0; index < 100; index += 1) {
      const common = { orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Synthetic supplier", currency: "JOD", createdBy: s.userId, createdAt: NOW, updatedAt: NOW };
      const payableVehicle = targets.vehicleIds[unique ? index : 0]!;
      await ctx.db.insert("vehicleSupplierPayables", { ...common, vehicleId: payableVehicle, saleId: targets.saleIds[unique ? index : 0]!, amountDue: 10, status: "DUE_ON_SALE" });
      await ctx.db.insert("vehicleSupplierReceivables", { ...common, vehicleId: targets.vehicleIds[unique ? index + 100 : 0]!, saleId: targets.saleIds[unique ? index + 100 : 0]!, amountDue: 10, status: "OPEN" });
      await ctx.db.insert("supplierCostRecoveries", { ...common, vehicleId: targets.vehicleIds[unique ? index + 200 : 0]!, expenseId: targets.expenseIds[unique ? index : 0]!, sourceEventKey: `read-${index}`, amountDueMinor: 10000, amountRecoveredMinor: 0, receiptSeq: 0, status: "OPEN" });
    }
  });
}

async function settleReadBound(s: Seed) {
  await s.t.run(async ctx => {
    const accountId = await ctx.db.insert("chartOfAccounts", { orgId: s.orgId, code: "1240", name: "Synthetic control", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, allowManualPosting: false, active: true, systemKey: SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS, createdAt: NOW, updatedAt: NOW });
    const payables = await ctx.db.query("vehicleSupplierPayables").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(100);
    for (const row of payables) await ctx.db.patch(row._id, { status: "PAID", amountPaid: 10 });
    const recoveries = await ctx.db.query("supplierCostRecoveries").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(100);
    for (const row of recoveries) await ctx.db.patch(row._id, { status: "RECOVERED", amountRecoveredMinor: 10000 });
    const claims = await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(100);
    for (const row of claims) {
      await ctx.db.patch(row._id, { status: "PAID", amountReceived: 10, receiptSeq: 1 });
      const journalEntryId = await ctx.db.insert("journalEntries", { orgId: s.orgId, journalNumber: `read-${row._id}`, accountingDate: NOW, sourceType: "vehicleSupplierReceivables", sourceId: row._id, category: "SYSTEM", memo: "Synthetic receipt", status: "POSTED", currency: "JOD", postedBy: s.userId, postedAt: NOW, createdAt: NOW });
      await ctx.db.insert("journalLines", { orgId: s.orgId, journalEntryId, accountId, lineNumber: 1, debitMinor: 0, creditMinor: 10000, currency: "JOD", scale: 3, accountingDate: NOW });
    }
  });
}

describe("supplier navigation by canonical id", () => {
  test("100 rows per family with distinct targets use at most 803 actual gets per outstanding handler", async () => {
    const s = await seed();
    await seedReadBound(s, true);
    const { response, gets } = await measureHandler(s, outstandingRegistration, { orgId: s.orgId, supplierId: s.supplierId, nowMs: NOW });
    expect(response).toMatchObject({ payable: { complete: true, totals: [{ currency: "JOD", grossMinor: 1_000_000 }] }, receivable: { complete: true, totals: [{ currency: "JOD", grossMinor: 2_000_000 }] } });
    console.info(`SUPPLIER_GETS distinct outstanding: ${gets}`);
    expect(gets).toBe(803);
  });

  test("100 rows per family sharing targets read each source once across money and decoration", async () => {
    const s = await seed();
    await seedReadBound(s, false);
    const { response, gets } = await measureHandler(s, outstandingRegistration, { orgId: s.orgId, supplierId: s.supplierId, nowMs: NOW });
    expect(response).toMatchObject({ payable: { complete: true }, receivable: { complete: true } });
    console.info(`SUPPLIER_GETS shared outstanding: ${gets}`);
    expect(gets).toBe(7);
  });

  test("100 settled rows per family with distinct targets use at most 803 actual gets per handler", async () => {
    const s = await seed();
    await seedReadBound(s, true);
    await settleReadBound(s);
    const { response, gets } = await measureHandler(s, settledRegistration, { orgId: s.orgId, supplierId: s.supplierId });
    expect(response).toMatchObject({ payable: { complete: true, totals: [{ currency: "JOD", settledMinor: 1_000_000 }] }, receivable: { complete: true, totals: [{ currency: "JOD", settledMinor: 2_000_000 }] } });
    console.info(`SUPPLIER_GETS distinct settled: ${gets}`);
    expect(gets).toBe(803);
  });

  test("owned relationships sharing a vehicle spend one vehicle get per call", async () => {
    const s = await seed();
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "STOCK" }));
    for (let index = 0; index < 50; index += 1) await payable(s);
    const { response, gets } = await measureHandler(s, relationshipRegistration, { orgId: s.orgId, supplierId: s.supplierId, kind: "OWNED", paginationOpts: { numItems: 50, cursor: null } });
    expect(response).toMatchObject({ isDone: false });
    console.info(`SUPPLIER_GETS shared relationships: ${gets}`);
    expect(gets).toBe(4);
  });

  test("two purchase obligations for one vehicle retain distinct stable relationship ids across pages", async () => {
    const s = await seed();
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "STOCK" }));
    const firstId = await payable(s, { status: "PAID", amountPaid: 9500 });
    const secondId = await payable(s);
    const first = await related(s, "OWNED", { numItems: 1, cursor: null });
    expect(first.isDone).toBe(false);
    const second = await related(s, "OWNED", { numItems: 1, cursor: first.continueCursor });
    expect(second.isDone).toBe(true);
    const rows = [...first.page, ...second.page];
    expect(rows.map((row: { vehicleId: string }) => row.vehicleId)).toEqual([s.vehicleId, s.vehicleId]);
    expect(new Set(rows.map((row: { id: string }) => row.id))).toEqual(new Set([firstId, secondId]));
  });

  test("decoration exhaustion preserves every computed payable row and complete money totals", async () => {
    const s = await seed(undefined, true);
    const id = await payable(s);
    const withoutHeavyLinks = await outstanding(s);
    const draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId, status: "POSTED", lines: [], asOfDate: NOW, createdBy: s.userId, createdAt: NOW }));
    for (let index = 0; index < 20; index += 1) {
      await s.t.run(ctx => ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Synthetic", amountDueMinor: 1000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, createdBy: s.userId, createdAt: NOW, updatedAt: NOW, origin: "OPENING", openingBalanceDraftId: draftId, openingRowKey: `row-${index}`, title: "n".repeat(900_000), purpose: "CLAIM" }));
    }
    const exhausted = await outstanding(s);
    expect(exhausted.receivable.incompleteReason).toBe("READ_BUDGET");
    expect(exhausted.payable.rows.map(row => row.id)).toEqual([id]);
    expect(exhausted.payable.totals).toEqual(withoutHeavyLinks.payable.totals);
    expect(exhausted.payable.totals).toEqual([{ currency: "JOD", grossMinor: 9_500_000, disputedMinor: 0, overdueMinor: 0 }]);
    expect(exhausted.payable.complete).toBe(true);
    expect(exhausted.payable.rows[0].context).toMatchObject({ source: null, vehicleSource: null });
  });

  test("statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows", async () => {
    const s = await seed();
    const id = await payable(s);
    await payable(s, { supplierId: s.otherId });
    await payable(s, { supplierId: undefined });
    const result = await outstanding(s);
    expect(result.payable.rows.map(row => row.id)).toEqual([id]);
    expect(result.payable.rows[0]).toMatchObject({
      outstandingMinor: 9_500_000, currency: "JOD",
      context: { role: "AP", occurredAt: NOW, counterparty: "Original supplier snapshot", source: {
        kind: "VEHICLE", id: s.vehicleId, label: "2024 Toyota Camry", href: `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}`,
      } },
    });
  });

  test("settled rows keep their source context and the actual minor-unit amount", async () => {
    const s = await seed();
    await payable(s, { status: "PAID", amountPaid: 9500, paidAt: NOW });
    const result = await s.asUser.query(api.supplierStatement.settled, { orgId: s.orgId, supplierId: s.supplierId });
    expect(result.payable.rows[0]).toMatchObject({ settledMinor: 9_500_000, context: { role: "AP", counterparty: "Original supplier snapshot", occurredAt: NOW, source: { kind: "VEHICLE" } } });
  });

  test("P5 opening payable and recovery navigate to the posted opening rather than a vehicle", async () => {
    const s = await seed();
    const draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId, status: "POSTED", lines: [], asOfDate: NOW, createdBy: s.userId, createdAt: NOW }));
    await s.t.run(async ctx => {
      await ctx.db.insert("vehicleSupplierPayables", { orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Opening supplier", amountDue: 10, currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, origin: "OPENING", openingBalanceDraftId: draftId, openingRowKey: "AP1", openingKind: "SUPPLIER_PAYABLE", title: "Opening invoice" });
      await ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Opening supplier", amountDueMinor: 20000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, createdBy: s.userId, createdAt: NOW, updatedAt: NOW, origin: "OPENING", openingBalanceDraftId: draftId, openingRowKey: "AR1", title: "Opening claim", purpose: "CLAIM" });
    });
    const result = await outstanding(s);
    expect(result.payable.rows[0]).toMatchObject({ context: { role: "AP", source: { kind: "OPENING", id: draftId, label: "Opening invoice", href: `/${s.orgId}/accounting?section=settings` } } });
    expect(result.receivable.rows[0]).toMatchObject({ context: { role: "AR", counterparty: "Opening supplier", source: { kind: "OPENING", label: "Opening claim" } } });
  });

  test("sale and expense sources use existing record screens and supplier economic role", async () => {
    const s = await seed();
    const customerId = await s.t.run(ctx => ctx.db.insert("customers", { orgId: s.orgId, firstName: "Synthetic", lastName: "Buyer" }));
    const saleId = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId, salespersonId: s.userId, salePrice: 12000, saleDate: NOW, status: "COMPLETED" }));
    await s.t.run(async ctx => {
      await ctx.db.insert("vehicleSupplierReceivables", { orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, saleId, sourcedFromName: "Supplier payer", amountDue: 3000, currency: "JOD", status: "OPEN", createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
      const expenseId = await ctx.db.insert("expenses", { orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport invoice", amount: 20, date: NOW, category: "TRANSPORT", status: "PAID" });
      await ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, expenseId, sourceEventKey: "KEY_1", sourcedFromName: "Supplier bearer", amountDueMinor: 20000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
    });
    const result = await outstanding(s);
    expect(result.receivable.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: expect.objectContaining({ role: "AR", counterparty: "Supplier payer", source: expect.objectContaining({ kind: "SALE", id: saleId, href: `/${s.orgId}/sales/${saleId}/deal` }) }) }),
      expect.objectContaining({ context: expect.objectContaining({ counterparty: "Supplier bearer", source: expect.objectContaining({ kind: "EXPENSE", label: "Transport invoice", href: null }), vehicleSource: expect.objectContaining({ kind: "VEHICLE", id: s.vehicleId, label: "2024 Toyota Camry", href: `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}` }) }) }),
    ]));
  });

  // SCRUM-941: the applications/[applicationId]/deal route and its view:sales guard,
  // plus ADR 2026-11-10-supplier-statement-links-and-relationships, define these oracles.
  test("financed supplier sale links to its same-organization application for a sales viewer", async () => {
    const s = await seed(["view:finance", "view:cost_price", "view:sales"]);
    const { applicationId } = await financedSale(s);
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "APPLICATION", id: applicationId, label: "#941 · 2024 Toyota Camry",
      href: `/${s.orgId}/applications/${applicationId}/deal`,
    }]);
  });

  test("financed supplier sale preserves its application label without a link for a viewer without sales", async () => {
    const s = await seed(["view:finance", "view:cost_price"]);
    const { applicationId } = await financedSale(s);
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "APPLICATION", id: applicationId, label: "#941 · 2024 Toyota Camry", href: null,
    }]);
  });

  test("financed supplier sale with a foreign application exposes only the local sale without a link", async () => {
    const s = await seed(["view:finance", "view:cost_price", "view:sales"]);
    const { saleId, applicationId } = await financedSale(s);
    await s.t.run(ctx => ctx.db.patch(applicationId, { orgId: s.foreignOrg }));
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "SALE", id: saleId, label: "#941 · 2024 Toyota Camry", href: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(applicationId);
    expect(JSON.stringify(result)).not.toContain(s.foreignOrg);
  });

  test("financed supplier sale with a deleted application exposes only the local sale without a link", async () => {
    const s = await seed(["view:finance", "view:cost_price", "view:sales"]);
    const { saleId, applicationId } = await financedSale(s);
    await s.t.run(ctx => ctx.db.delete(applicationId));
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "SALE", id: saleId, label: "#941 · 2024 Toyota Camry", href: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(applicationId);
  });

  test("financed supplier sale with a foreign application exposes only the local sale for a viewer without sales", async () => {
    const s = await seed(["view:finance", "view:cost_price"]);
    const { saleId, applicationId } = await financedSale(s);
    await s.t.run(ctx => ctx.db.patch(applicationId, { orgId: s.foreignOrg }));
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "SALE", id: saleId, label: "#941 · 2024 Toyota Camry", href: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(applicationId);
    expect(JSON.stringify(result)).not.toContain(s.foreignOrg);
  });

  test("financed supplier sale with a deleted application exposes only the local sale for a viewer without sales", async () => {
    const s = await seed(["view:finance", "view:cost_price"]);
    const { saleId, applicationId } = await financedSale(s);
    await s.t.run(ctx => ctx.db.delete(applicationId));
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "SALE", id: saleId, label: "#941 · 2024 Toyota Camry", href: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(applicationId);
  });

  test("foreign sale enrichment discloses no source, sale id or deal number", async () => {
    const s = await seed();
    const { saleId } = await financedSale(s);
    await s.t.run(ctx => ctx.db.patch(saleId, { orgId: s.foreignOrg, applicationId: undefined, dealNumber: 941701 }));
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context)).toStrictEqual([{
      role: "AR", occurredAt: NOW, counterparty: "Synthetic supplier payer", source: null, vehicleSource: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(saleId);
    expect(JSON.stringify(result)).not.toContain("941701");
    expect(JSON.stringify(result)).not.toContain(s.foreignOrg);
  });

  test("deleted sale enrichment discloses no source, sale id or deal number", async () => {
    const s = await seed();
    const { saleId } = await financedSale(s);
    await s.t.run(ctx => ctx.db.patch(saleId, { isDeleted: true, applicationId: undefined, dealNumber: 941702 }));
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context)).toStrictEqual([{
      role: "AR", occurredAt: NOW, counterparty: "Synthetic supplier payer", source: null, vehicleSource: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(saleId);
    expect(JSON.stringify(result)).not.toContain("941702");
    expect(JSON.stringify(result)).not.toContain(s.foreignOrg);
  });

  test("foreign expense enrichment discloses no source, expense id or title", async () => {
    const s = await seed();
    const expenseId = await s.t.run(async ctx => {
      const id = await ctx.db.insert("expenses", { orgId: s.foreignOrg, vehicleId: s.vehicleId, title: "Synthetic foreign transport 941", amount: 20, date: NOW, category: "TRANSPORT", status: "PAID" });
      await ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, expenseId: id, sourceEventKey: "foreign-expense", sourcedFromName: "Synthetic supplier bearer", amountDueMinor: 20000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
      return id;
    });
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context)).toStrictEqual([{
      role: "AR", occurredAt: NOW, counterparty: "Synthetic supplier bearer", source: null, vehicleSource: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(expenseId);
    expect(JSON.stringify(result)).not.toContain("Synthetic foreign transport 941");
    expect(JSON.stringify(result)).not.toContain(s.foreignOrg);
  });

  test("deleted expense enrichment discloses no source, expense id or title", async () => {
    const s = await seed();
    const expenseId = await s.t.run(async ctx => {
      const id = await ctx.db.insert("expenses", { orgId: s.orgId, vehicleId: s.vehicleId, title: "Synthetic deleted transport 941", amount: 20, date: NOW, category: "TRANSPORT", status: "PAID", isDeleted: true });
      await ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, expenseId: id, sourceEventKey: "deleted-expense", sourcedFromName: "Synthetic supplier bearer", amountDueMinor: 20000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
      return id;
    });
    const result = await outstanding(s);
    expect(result.receivable.rows.map(row => row.context)).toStrictEqual([{
      role: "AR", occurredAt: NOW, counterparty: "Synthetic supplier bearer", source: null, vehicleSource: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(expenseId);
    expect(JSON.stringify(result)).not.toContain("Synthetic deleted transport 941");
    expect(JSON.stringify(result)).not.toContain(s.foreignOrg);
  });

  test("foreign opening draft enrichment discloses no source or draft id", async () => {
    const s = await seed();
    const draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId: s.foreignOrg, status: "POSTED", lines: [], asOfDate: NOW, memo: "Synthetic foreign opening 941", createdBy: s.userId, createdAt: NOW }));
    await s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", { orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Synthetic opening supplier", amountDue: 10, currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, origin: "OPENING", openingBalanceDraftId: draftId, openingRowKey: "AP1", openingKind: "SUPPLIER_PAYABLE", title: "Synthetic local opening invoice" }));
    const result = await outstanding(s);
    expect(result.payable.rows.map(row => row.context)).toStrictEqual([{
      role: "AP", occurredAt: NOW, counterparty: "Synthetic opening supplier", source: null, vehicleSource: null,
    }]);
    expect(JSON.stringify(result)).not.toContain(draftId);
    expect(JSON.stringify(result)).not.toContain("Synthetic foreign opening 941");
    expect(JSON.stringify(result)).not.toContain(s.foreignOrg);
  });

  test("missing target permissions preserve labels without links and foreign or deleted targets disclose no label", async () => {
    const s = await seed(["view:finance", "view:cost_price"]);
    await payable(s);
    expect((await outstanding(s)).payable.rows[0]).toMatchObject({ context: { source: { label: "2024 Toyota Camry", href: null } } });
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { orgId: s.foreignOrg, make: "FOREIGN SECRET" }));
    const foreign = await outstanding(s);
    expect(foreign.payable.rows[0]).toMatchObject({ context: { source: null } });
    expect(JSON.stringify(foreign)).not.toContain("FOREIGN SECRET");
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { orgId: s.orgId, isDeleted: true }));
    expect((await outstanding(s)).payable.rows[0]).toMatchObject({ context: { source: null } });
  });

  test("finance without cost gets exactly stock metadata and cannot read statement costs", async () => {
    const s = await seed(["view:finance"]);
    await payable(s);
    const page = await related(s);
    expect(page).toEqual({ page: [{ id: s.vehicleId, vehicleId: s.vehicleId, label: "2024 Toyota Camry", model: "SOURCED", status: "AVAILABLE", href: null }], isDone: true, continueCursor: expect.any(String), pageStatus: null, splitCursor: null });
    await expect(outstanding(s)).rejects.toThrow(/FORBIDDEN|Missing required permission/);
    await expect(s.asUser.query(api.supplierStatement.settled, { orgId: s.orgId, supplierId: s.supplierId })).rejects.toThrow(/FORBIDDEN|Missing required permission/);
  });

  test("relationship pages include only linked sourced or owned on-account vehicles, including sold stock", async () => {
    const s = await seed();
    await s.t.run(async ctx => {
      const original = await ctx.db.get(s.vehicleId);
      if (!original) throw new Error("fixture vehicle missing");
      const { _id, _creationTime, ...fields } = original;
      await ctx.db.insert("vehicles", { ...fields, sourcedSupplierId: s.otherId });
      await ctx.db.insert("vehicles", { ...fields, sourcedSupplierId: undefined });
      await ctx.db.insert("vehicles", { ...fields, isDeleted: true });
    });
    expect((await related(s)).page.map((row: { vehicleId: string }) => row.vehicleId)).toEqual([s.vehicleId]);
    const purchaseId = await payable(s); // A SOURCED vehicle's payable must not become an owned relationship.
    expect((await related(s, "OWNED")).page).toEqual([]);
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "STOCK", sourcedSupplierId: undefined, status: "SOLD" }));
    expect((await related(s, "OWNED")).page).toEqual([{ id: purchaseId, vehicleId: s.vehicleId, label: "2024 Toyota Camry", model: "OWNED_ON_ACCOUNT", status: "SOLD", href: `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}` }]);
  });

  test("relationship bound returns an incomplete page and continuation reaches the remaining vehicle", async () => {
    const s = await seed();
    await s.t.run(async ctx => {
      const row = await ctx.db.get(s.vehicleId);
      if (!row) throw new Error("fixture missing");
      const { _id, _creationTime, ...fields } = row;
      await ctx.db.insert("vehicles", { ...fields, model: "Corolla" });
    });
    const first = await related(s, "SOURCED", { numItems: 1, cursor: null });
    expect(first.isDone).toBe(false);
    expect(first.page).toHaveLength(1);
    const second = await related(s, "SOURCED", { numItems: 1, cursor: first.continueCursor });
    expect(second.isDone).toBe(true);
    expect(second.page).toHaveLength(1);
    expect(second.page[0].vehicleId).not.toBe(first.page[0].vehicleId);
  });

  test("public readers refuse foreign suppliers, foreign organizations and callers without finance", async () => {
    const s = await seed();
    await expect(s.asUser.query(vehicles, { orgId: s.orgId, supplierId: s.foreignSupplier, kind: "SOURCED", paginationOpts: { numItems: 25, cursor: null } })).rejects.toThrow("Supplier not found.");
    await expect(s.asUser.query(vehicles, { orgId: s.foreignOrg, supplierId: s.foreignSupplier, kind: "SOURCED", paginationOpts: { numItems: 25, cursor: null } })).rejects.toThrow(/UNAUTHORIZED/);
    await expect(s.asUser.query(api.supplierStatement.outstanding, { orgId: s.orgId, supplierId: s.foreignSupplier, nowMs: NOW })).rejects.toThrow("Supplier not found.");
    await s.t.run(ctx => ctx.db.patch(s.roleId, { permissions: [] }));
    await expect(related(s)).rejects.toThrow(/FORBIDDEN/);
  });

  test("a distant endCursor cannot widen the relationship read bound", async () => {
    const s = await seed();
    await s.t.run(async ctx => {
      const vehicle = await ctx.db.get(s.vehicleId);
      if (!vehicle) throw new Error("fixture missing");
      const { _id, _creationTime, ...fields } = vehicle;
      for (let index = 0; index < 51; index += 1) await ctx.db.insert("vehicles", { ...fields, model: `Stock ${index}` });
    });
    const first = await related(s, "SOURCED", { numItems: 50, cursor: null });
    const last = await related(s, "SOURCED", { numItems: 25, cursor: first.continueCursor });
    const wide = await s.asUser.query(vehicles, { orgId: s.orgId, supplierId: s.supplierId, kind: "SOURCED", paginationOpts: { numItems: 1, cursor: null, endCursor: last.continueCursor, maximumRowsRead: 1000000 } });
    expect(wide.page.length).toBeLessThanOrEqual(50);
    expect(wide.pageStatus).toBe("SplitRequired");
    expect(wide.splitCursor).toEqual(expect.any(String));
    expect(wide.isDone).toBe(false);
  });

  test("invalid stored money keeps the money reader error contract", async () => {
    const s = await seed();
    const id = await payable(s, { amountDue: Number.NaN });
    const expected = "Amount NaN JOD overflows safe integer when converted to minor units.";
    await expect(outstanding(s)).rejects.toThrow(expected);
    await s.t.run(ctx => ctx.db.patch(id, { status: "PAID", amountPaid: 1 }));
    await expect(s.asUser.query(api.supplierStatement.settled, { orgId: s.orgId, supplierId: s.supplierId })).rejects.toThrow(expected);
  });
});
