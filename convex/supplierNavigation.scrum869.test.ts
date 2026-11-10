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


// SCRUM-941 round 3: each literal test below binds one declared navigation door row.
type TargetPermission = "view:sales" | "view:vehicles" | "manage:finance";
type HiddenState = "foreign" | "deleted";
const seedViewer = (permission: TargetPermission, allowed: boolean) =>
  seed(["view:finance", "view:cost_price", ...(allowed ? [permission] : [])]);

async function hideVehicle(s: Seed, state: HiddenState) {
  await s.t.run(ctx => ctx.db.patch(s.vehicleId, {
    year: 2037, make: "NAV941-MAKE", model: "NAV941-MODEL",
    ...(state === "foreign" ? { orgId: s.foreignOrg } : { isDeleted: true }),
  }));
}

function expectNoVehicleLabel(result: Awaited<ReturnType<typeof outstanding>>) {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("2037");
  expect(serialized).not.toContain("NAV941-MAKE");
  expect(serialized).not.toContain("NAV941-MODEL");
}

function expectNoVehicle(result: Awaited<ReturnType<typeof outstanding>>, s: Seed) {
  expect(JSON.stringify(result)).not.toContain(s.vehicleId);
  expectNoVehicleLabel(result);
}

async function expectHiddenSale(state: HiddenState, financed: boolean, sales: boolean) {
  const s = await seedViewer("view:sales", sales);
  const { saleId, applicationId } = await financedSale(s);
  await s.t.run(ctx => ctx.db.patch(saleId, {
    ...(state === "foreign" ? { orgId: s.foreignOrg } : { isDeleted: true }),
    ...(!financed ? { applicationId: undefined } : {}), dealNumber: 941703,
  }));
  const result = await outstanding(s);
  expect(result.receivable.rows.map(row => row.context)).toStrictEqual([{
    role: "AR", occurredAt: NOW, counterparty: "Synthetic supplier payer", source: null, vehicleSource: null,
  }]);
  expect(JSON.stringify(result)).not.toContain(financed ? applicationId : saleId);
  expect(JSON.stringify(result)).not.toContain("941703");
}

async function openingFixture(state: "foreign" | "pending" | "posted", finance: boolean) {
  const s = await seedViewer("manage:finance", finance);
  const draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", {
    orgId: state === "foreign" ? s.foreignOrg : s.orgId, status: state === "pending" ? "PENDING_APPROVAL" : "POSTED",
    lines: [], asOfDate: NOW, createdBy: s.userId, createdAt: NOW,
  }));
  await s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", {
    orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Synthetic opening supplier", amountDue: 10,
    currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
    origin: "OPENING", openingBalanceDraftId: draftId, openingRowKey: "AP1", openingKind: "SUPPLIER_PAYABLE", title: "Synthetic local opening invoice",
  }));
  return { s, draftId };
}

async function expenseVehicleFixture(vehicles: boolean) {
  const s = await seedViewer("view:vehicles", vehicles);
  const expenseId = await s.t.run(async ctx => {
    const id = await ctx.db.insert("expenses", { orgId: s.orgId, vehicleId: s.vehicleId, title: "Synthetic vehicle transport", amount: 20, date: NOW, category: "TRANSPORT", status: "PAID" });
    await ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, expenseId: id, sourceEventKey: "vehicle-door", sourcedFromName: "Synthetic supplier bearer", amountDueMinor: 20000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
    return id;
  });
  return { s, expenseId };
}

async function expectHiddenExpenseVehicle(state: HiddenState, vehicles: boolean) {
  const { s, expenseId } = await expenseVehicleFixture(vehicles);
  await hideVehicle(s, state);
  const result = await outstanding(s);
  expect(result.receivable.rows.map(row => row.context)).toStrictEqual([{
    role: "AR", occurredAt: NOW, counterparty: "Synthetic supplier bearer",
    source: { kind: "EXPENSE", id: expenseId, label: "Synthetic vehicle transport", href: null }, vehicleSource: null,
  }]);
  expectNoVehicle(result, s);
}

async function expectHiddenNativeVehicle(state: HiddenState) {
  const s = await seedViewer("view:vehicles", true);
  await payable(s);
  await hideVehicle(s, state);
  const result = await outstanding(s);
  expect(result.payable.rows.map(row => row.context.source)).toStrictEqual([null]);
  expectNoVehicle(result, s);
}

async function expectHiddenSaleVehicle(state: HiddenState, vehicles: boolean) {
  const s = await seed(["view:finance", "view:cost_price", "view:sales", ...(vehicles ? ["view:vehicles"] : [])]);
  const { saleId } = await financedSale(s);
  await s.t.run(ctx => ctx.db.patch(saleId, { applicationId: undefined }));
  await hideVehicle(s, state);
  const result = await outstanding(s);
  expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
    kind: "SALE", id: saleId, label: `#941 · ${saleId}`, href: `/${s.orgId}/sales/${saleId}/deal`,
  }]);
  expectNoVehicleLabel(result);
}

// SCRUM-941 round 4: public-query cells, independent literal expected labels.
async function expectVehicleCell(cell: { shape: "native" | "cash" | "financed"; target: "local" | "foreign" | "deleted"; sales: boolean; vehicles: boolean }) {
  const s = await seed(["view:finance", "view:cost_price", ...(cell.sales ? ["view:sales"] : []), ...(cell.vehicles ? ["view:vehicles"] : [])]);
  const ids = cell.shape === "native" ? null : await financedSale(s);
  if (ids && cell.shape === "cash") await s.t.run(ctx => ctx.db.patch(ids.saleId, { applicationId: undefined }));
  if (!ids) await payable(s);
  if (cell.target !== "local") await hideVehicle(s, cell.target);
  const result = await outstanding(s);
  if (ids) {
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: cell.shape === "financed" ? "APPLICATION" : "SALE",
      id: cell.shape === "financed" ? ids.applicationId : ids.saleId,
      label: cell.target === "local" ? "#941 · 2024 Toyota Camry" : `#941 · ${ids.saleId}`,
      href: cell.sales ? (cell.shape === "financed" ? `/${s.orgId}/applications/${ids.applicationId}/deal` : `/${s.orgId}/sales/${ids.saleId}/deal`) : null,
    }]);
    if (cell.target !== "local") expectNoVehicleLabel(result);
  } else {
    expect(result.payable.rows.map(row => row.context.source)).toStrictEqual([cell.target === "local" ? {
      kind: "VEHICLE", id: s.vehicleId, label: "2024 Toyota Camry",
      href: cell.vehicles ? `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}` : null,
    } : null]);
    if (cell.target !== "local") expectNoVehicle(result, s);
  }
}

async function expectUnpostedOpening(status: Exclude<Doc<"openingBalanceDrafts">["status"], "POSTED">, finance: boolean) {
  const { s, draftId } = await openingFixture("posted", finance);
  await s.t.run(ctx => ctx.db.patch(draftId, { status }));
  const result = await outstanding(s);
  expect(result.payable.rows.map(row => row.context.source)).toStrictEqual([null]);
  expect(JSON.stringify(result)).not.toContain(draftId);
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


  // SCRUM-941 declared doors: literal registrations are required by the scenario library.
  test("foreign cash sale enrichment discloses no source for a viewer without sales", async () => {
    await expectHiddenSale("foreign", false, false);
  });

  test("deleted cash sale enrichment discloses no source for a viewer without sales", async () => {
    await expectHiddenSale("deleted", false, false);
  });

  test("foreign financed sale enrichment discloses no source for a viewer without sales", async () => {
    await expectHiddenSale("foreign", true, false);
  });

  test("foreign financed sale enrichment discloses no source for a viewer with sales", async () => {
    await expectHiddenSale("foreign", true, true);
  });

  test("deleted financed sale enrichment discloses no source for a viewer without sales", async () => {
    await expectHiddenSale("deleted", true, false);
  });

  test("deleted financed sale enrichment discloses no source for a viewer with sales", async () => {
    await expectHiddenSale("deleted", true, true);
  });

  test("cash supplier sale keeps its label without a link for a viewer without sales", async () => {
    const s = await seedViewer("view:sales", false);
    const { saleId } = await financedSale(s);
    await s.t.run(ctx => ctx.db.patch(saleId, { applicationId: undefined }));
    expect((await outstanding(s)).receivable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "SALE", id: saleId, label: "#941 · 2024 Toyota Camry", href: null,
    }]);
  });

  test("foreign opening draft discloses no source for a viewer without finance management", async () => {
    const { s, draftId } = await openingFixture("foreign", false);
    const result = await outstanding(s);
    expect(result.payable.rows.map(row => row.context.source)).toStrictEqual([null]);
    expect(JSON.stringify(result)).not.toContain(draftId);
  });

  test("pending opening draft yields no source even for a finance manager", async () => {
    const { s, draftId } = await openingFixture("pending", true);
    const result = await outstanding(s);
    expect(result.payable.rows.map(row => row.context.source)).toStrictEqual([null]);
    expect(JSON.stringify(result)).not.toContain(draftId);
  });

  test("posted opening keeps its label without a link for a viewer without finance management", async () => {
    const { s, draftId } = await openingFixture("posted", false);
    expect((await outstanding(s)).payable.rows.map(row => row.context.source)).toStrictEqual([{
      kind: "OPENING", id: draftId, label: "Synthetic local opening invoice", href: null,
    }]);
  });

  test("expense keeps its source but hides a foreign vehicle for a viewer without vehicles", async () => {
    await expectHiddenExpenseVehicle("foreign", false);
  });

  test("expense keeps its source but hides a foreign vehicle for a viewer with vehicles", async () => {
    await expectHiddenExpenseVehicle("foreign", true);
  });

  test("expense keeps its source but hides a deleted vehicle for a viewer without vehicles", async () => {
    await expectHiddenExpenseVehicle("deleted", false);
  });

  test("expense keeps its source but hides a deleted vehicle for a viewer with vehicles", async () => {
    await expectHiddenExpenseVehicle("deleted", true);
  });

  test("foreign native vehicle yields no source for a vehicle viewer", async () => {
    await expectHiddenNativeVehicle("foreign");
  });

  test("local sale label hides its foreign vehicle for a viewer without vehicles", async () => {
    await expectHiddenSaleVehicle("foreign", false);
  });

  test("local sale label hides its foreign vehicle for a viewer with vehicles", async () => {
    await expectHiddenSaleVehicle("foreign", true);
  });

  test("deleted native vehicle yields no source for a vehicle viewer", async () => {
    await expectHiddenNativeVehicle("deleted");
  });

  test("local sale label hides its deleted vehicle for a viewer without vehicles", async () => {
    await expectHiddenSaleVehicle("deleted", false);
  });

  test("local sale label hides its deleted vehicle for a viewer with vehicles", async () => {
    await expectHiddenSaleVehicle("deleted", true);
  });

  test("expense vehicle keeps its label without a link for a viewer without vehicles", async () => {
    const { s, expenseId } = await expenseVehicleFixture(false);
    expect((await outstanding(s)).receivable.rows.map(row => ({ source: row.context.source, vehicleSource: row.context.vehicleSource }))).toStrictEqual([{
      source: { kind: "EXPENSE", id: expenseId, label: "Synthetic vehicle transport", href: null },
      vehicleSource: { kind: "VEHICLE", id: s.vehicleId, label: "2024 Toyota Camry", href: null },
    }]);
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
  // SCRUM-941: literal titles bind the full door-axis coverage and scenario records.
  test("local native vehicle keeps its label with sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "native", target: "local", sales: true, vehicles: false });
  });

  test("local native vehicle keeps its label without sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "native", target: "local", sales: false, vehicles: true });
  });

  test("foreign native vehicle discloses no source with sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "native", target: "foreign", sales: true, vehicles: true });
  });

  test("foreign native vehicle discloses no source with sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "native", target: "foreign", sales: true, vehicles: false });
  });

  test("deleted native vehicle discloses no source with sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "native", target: "deleted", sales: true, vehicles: true });
  });

  test("deleted native vehicle discloses no source with sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "native", target: "deleted", sales: true, vehicles: false });
  });

  test("cash sale keeps its local vehicle label with sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "cash", target: "local", sales: true, vehicles: true });
  });

  test("cash sale keeps its local vehicle label with sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "cash", target: "local", sales: true, vehicles: false });
  });

  test("cash sale keeps its local vehicle label without sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "cash", target: "local", sales: false, vehicles: true });
  });

  test("cash sale hides its foreign vehicle label without sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "cash", target: "foreign", sales: false, vehicles: true });
  });

  test("cash sale hides its foreign vehicle label without sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "cash", target: "foreign", sales: false, vehicles: false });
  });

  test("cash sale hides its deleted vehicle label without sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "cash", target: "deleted", sales: false, vehicles: true });
  });

  test("cash sale hides its deleted vehicle label without sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "cash", target: "deleted", sales: false, vehicles: false });
  });

  test("financed sale keeps its local vehicle label with sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "local", sales: true, vehicles: true });
  });

  test("financed sale keeps its local vehicle label without sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "local", sales: false, vehicles: true });
  });

  test("financed sale hides its foreign vehicle label with sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "foreign", sales: true, vehicles: true });
  });

  test("financed sale hides its foreign vehicle label with sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "foreign", sales: true, vehicles: false });
  });

  test("financed sale hides its foreign vehicle label without sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "foreign", sales: false, vehicles: true });
  });

  test("financed sale hides its foreign vehicle label without sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "foreign", sales: false, vehicles: false });
  });

  test("financed sale hides its deleted vehicle label with sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "deleted", sales: true, vehicles: true });
  });

  test("financed sale hides its deleted vehicle label with sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "deleted", sales: true, vehicles: false });
  });

  test("financed sale hides its deleted vehicle label without sales and with vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "deleted", sales: false, vehicles: true });
  });

  test("financed sale hides its deleted vehicle label without sales and without vehicles", async () => {
    await expectVehicleCell({ shape: "financed", target: "deleted", sales: false, vehicles: false });
  });

  test("pending approval opening yields no source without finance management", async () => {
    await expectUnpostedOpening("PENDING_APPROVAL", false);
  });

  test("rejected opening yields no source with finance management", async () => {
    await expectUnpostedOpening("REJECTED", true);
  });

  test("rejected opening yields no source without finance management", async () => {
    await expectUnpostedOpening("REJECTED", false);
  });

  test("voided opening yields no source with finance management", async () => {
    await expectUnpostedOpening("VOIDED", true);
  });

  test("voided opening yields no source without finance management", async () => {
    await expectUnpostedOpening("VOIDED", false);
  });


});


// SCRUM-941 round 5: cells seed and read back their own state before the public query.
type NavigationCell = Readonly<Record<string, string>>;
type NavigationTarget = { orgId?: Doc<"organizations">["_id"]; isDeleted?: boolean } | null;

function assertNavigationTarget(doc: NavigationTarget, state: string, s: Seed, message: string) {
  if (state === "missing") { expect(doc, message).toBeNull(); return; }
  expect(doc, message).not.toBeNull();
  expect(doc?.orgId, message).toBe(state === "foreign" ? s.foreignOrg : s.orgId);
  expect(doc?.isDeleted === true, message).toBe(state === "deleted");
}

async function navigationCell(door: string, cell: NavigationCell) {
  const message = `${door}: ${JSON.stringify(cell)}`;
  const values: Readonly<Record<string, readonly string[]>> = {
    shape: ["native", "cash", "financed", "expense"], target: ["local", "foreign", "deleted", "missing"],
    dealNumber: ["with", "without"], vehicle: ["local", "hidden"],
    viewSales: ["with", "without"], viewVehicles: ["with", "without"], manageFinance: ["with", "without"],
    status: ["POSTED", "PENDING_APPROVAL", "REJECTED", "VOIDED"],
  };
  for (const [axis, value] of Object.entries(cell)) expect(values[axis], message).toContain(value);
  const permissions = ["view:finance", "view:cost_price", ...(cell.viewSales === "with" ? ["view:sales"] : []),
    ...(cell.viewVehicles === "with" ? ["view:vehicles"] : []), ...(cell.manageFinance === "with" ? ["manage:finance"] : [])];
  const s = await seed(permissions);
  const opening = door.startsWith("opening");
  const shape = cell.shape ?? (opening ? "opening" : "expense");
  const vehicleDoor = door === "expense vehicle lookup" || door === "native or sale vehicle lookup";
  const vehicleState = vehicleDoor ? cell.target : cell.vehicle === "hidden" ? "foreign" : "local";
  let sale: Awaited<ReturnType<typeof financedSale>> | null = null;
  let expenseId: Doc<"expenses">["_id"] | null = null;
  let draftId: Doc<"openingBalanceDrafts">["_id"] | null = null;
  let obligationId: Doc<"vehicleSupplierPayables">["_id"] | Doc<"vehicleSupplierReceivables">["_id"] | Doc<"supplierCostRecoveries">["_id"];
  if (opening) {
    draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId,
      status: cell.status as Doc<"openingBalanceDrafts">["status"], lines: [], asOfDate: NOW, createdBy: s.userId, createdAt: NOW }));
    obligationId = await s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", { orgId: s.orgId, supplierId: s.supplierId,
      sourcedFromName: "Synthetic opening supplier", amountDue: 10, currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId,
      createdAt: NOW, updatedAt: NOW, origin: "OPENING", openingBalanceDraftId: draftId!, openingRowKey: "AP1",
      openingKind: "SUPPLIER_PAYABLE", title: "Synthetic local opening invoice" }));
  } else if (shape === "expense") {
    expenseId = await s.t.run(ctx => ctx.db.insert("expenses", { orgId: s.orgId, vehicleId: s.vehicleId,
      title: "Synthetic vehicle transport", amount: 20, date: NOW, category: "TRANSPORT", status: "PAID" }));
    obligationId = await s.t.run(ctx => ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId,
      vehicleId: s.vehicleId, expenseId: expenseId!, sourceEventKey: "round-five-cell", sourcedFromName: "Synthetic supplier bearer",
      amountDueMinor: 20000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0,
      createdBy: s.userId, createdAt: NOW, updatedAt: NOW }));
  } else if (shape === "native") {
    obligationId = await payable(s);
  } else {
    sale = await financedSale(s);
    await s.t.run(ctx => ctx.db.patch(sale!.saleId, { dealNumber: cell.dealNumber === "without" ? undefined : 941,
      ...(shape === "cash" ? { applicationId: undefined } : {}) }));
    const rows = await s.t.run(ctx => ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(2));
    expect(rows.length, message).toBe(1);
    obligationId = rows[0]!._id;
  }
  await s.t.run(async ctx => {
    if (sale) {
      const doc = await ctx.db.get(sale.saleId);
      expect(doc?.dealNumber, message).toBe(cell.dealNumber === "without" ? undefined : 941);
      expect(doc?.applicationId, message).toBe(shape === "cash" ? undefined : sale.applicationId);
    }
    if (draftId) expect((await ctx.db.get(draftId))?.status, message).toBe(cell.status);
    if (shape === "native") expect(await ctx.db.query("sales").take(1), message).toStrictEqual([]);
  });
  if (!opening && vehicleState !== "local") {
    if (vehicleState === "missing") await s.t.run(ctx => ctx.db.delete(s.vehicleId));
    else await hideVehicle(s, vehicleState === "deleted" ? "deleted" : "foreign");
  }
  const targetId = vehicleDoor ? s.vehicleId : opening ? draftId : door === "application lookup" ? sale?.applicationId : shape === "expense" ? expenseId : sale?.saleId;
  if (!vehicleDoor && cell.target !== "local") {
    expect(targetId, message).toBeTruthy();
    if (cell.target === "missing") await s.t.run(ctx => ctx.db.delete(targetId!));
    else await s.t.run(ctx => ctx.db.patch(targetId!, cell.target === "foreign" ? { orgId: s.foreignOrg } : { isDeleted: true }));
  }
  // Read-back assertions precede the query: an impossible or mis-seeded cell fails here.
  await s.t.run(async ctx => {
    expect((await ctx.db.get(s.roleId))?.permissions, message).toStrictEqual(permissions);
    const obligation = await ctx.db.get(obligationId);
    expect(obligation, message).not.toBeNull();
    expect(obligation && "vehicleId" in obligation, message).toBe(!opening);
    if (!opening) expect(obligation && "origin" in obligation ? obligation.origin : undefined, message).not.toBe("OPENING");
    if (shape !== "expense") expect(obligation && "expenseId" in obligation, message).toBe(false);
    if (opening) expect(obligation, message).toMatchObject({ origin: "OPENING", openingBalanceDraftId: draftId });
    else if (shape === "expense") expect(obligation, message).toMatchObject({ expenseId, vehicleId: s.vehicleId });
    else expect(obligation, message).toMatchObject({ vehicleId: s.vehicleId, ...(sale ? { saleId: sale.saleId } : {}) });
    if (!opening) assertNavigationTarget(await ctx.db.get(s.vehicleId), vehicleState, s, message);
    if (targetId) assertNavigationTarget(await ctx.db.get(targetId), cell.target, s, message);
    if (sale) {
      const doc = await ctx.db.get(sale.saleId);
      if (!(door === "sale lookup" && cell.target === "missing")) {
        expect(doc?.dealNumber, message).toBe(cell.dealNumber === "without" ? undefined : 941);
        expect(doc?.applicationId, message).toBe(shape === "cash" ? undefined : sale.applicationId);
      }
      if (door !== "application lookup") assertNavigationTarget(await ctx.db.get(sale.applicationId), "local", s, message);
    }
    if (draftId && cell.target !== "missing") expect((await ctx.db.get(draftId))?.status, message).toBe(cell.status);
    if (shape === "native") expect(obligation && "saleId" in obligation ? obligation.saleId : undefined, message).toBeUndefined();
  });
  const result = await outstanding(s);
  const rows = opening || shape === "native" ? result.payable.rows : result.receivable.rows;
  const visibleVehicle = vehicleState === "local";
  const vehicleSource = visibleVehicle ? { kind: "VEHICLE", id: s.vehicleId, label: "2024 Toyota Camry",
    href: cell.viewVehicles === "with" ? `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}` : null } : null;
  let source: object | null = null;
  let separateVehicle: object | null = null;
  if (opening) {
    if (cell.target === "local" && cell.status === "POSTED") source = { kind: "OPENING", id: draftId,
      label: "Synthetic local opening invoice", href: cell.manageFinance === "with" ? `/${s.orgId}/accounting?section=settings` : null };
  } else if (shape === "expense") {
    if (door !== "expense lookup" || cell.target === "local") {
      source = { kind: "EXPENSE", id: expenseId, label: "Synthetic vehicle transport", href: null };
      separateVehicle = vehicleSource;
    }
  } else if (shape === "native") source = vehicleSource;
  else if (sale && (door !== "sale lookup" || cell.target === "local")) {
    const applicationVisible = shape === "financed" && (door !== "application lookup" || cell.target === "local");
    const suffix = visibleVehicle ? "2024 Toyota Camry" : sale.saleId;
    source = { kind: applicationVisible ? "APPLICATION" : "SALE", id: applicationVisible ? sale.applicationId : sale.saleId,
      label: cell.dealNumber === "without" ? suffix : `#941 · ${suffix}`,
      href: cell.viewSales === "with" && (shape === "cash" || applicationVisible) ?
        (applicationVisible ? `/${s.orgId}/applications/${sale.applicationId}/deal` : `/${s.orgId}/sales/${sale.saleId}/deal`) : null };
  }
  expect(rows.map(row => row.context), message).toStrictEqual([{
    role: opening || shape === "native" ? "AP" : "AR", occurredAt: NOW,
    counterparty: opening ? "Synthetic opening supplier" : shape === "native" ? "Original supplier snapshot" : shape === "expense" ? "Synthetic supplier bearer" : "Synthetic supplier payer",
    source, vehicleSource: separateVehicle,
  }]);
}

async function navigationCells(door: string, axes: readonly string[], cells: readonly (readonly string[])[]) {
  for (const tuple of cells) {
    expect(tuple.length, `${door}: ${JSON.stringify(tuple)}`).toBe(axes.length);
    await navigationCell(door, Object.fromEntries(axes.map((axis, index) => [axis, tuple[index]!])));
  }
}

test("sale lookup refuses foreign targets across every navigation condition", async () => {
  await navigationCells("sale lookup", ["shape", "target", "viewSales", "dealNumber", "vehicle"], [
    ["cash", "foreign", "with", "with", "local"],
    ["cash", "foreign", "with", "with", "hidden"],
    ["cash", "foreign", "with", "without", "local"],
    ["cash", "foreign", "with", "without", "hidden"],
    ["cash", "foreign", "without", "with", "local"],
    ["cash", "foreign", "without", "with", "hidden"],
    ["cash", "foreign", "without", "without", "local"],
    ["cash", "foreign", "without", "without", "hidden"],
    ["financed", "foreign", "with", "with", "local"],
    ["financed", "foreign", "with", "with", "hidden"],
    ["financed", "foreign", "with", "without", "local"],
    ["financed", "foreign", "with", "without", "hidden"],
    ["financed", "foreign", "without", "with", "local"],
    ["financed", "foreign", "without", "with", "hidden"],
    ["financed", "foreign", "without", "without", "local"],
    ["financed", "foreign", "without", "without", "hidden"],
  ]);
});

test("sale lookup checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("sale lookup", ["shape", "target", "viewSales", "dealNumber", "vehicle"], [
    ["cash", "local", "with", "with", "local"],
    ["cash", "local", "with", "with", "hidden"],
    ["cash", "local", "with", "without", "local"],
    ["cash", "local", "with", "without", "hidden"],
    ["cash", "local", "without", "with", "local"],
    ["cash", "local", "without", "with", "hidden"],
    ["cash", "local", "without", "without", "local"],
    ["cash", "local", "without", "without", "hidden"],
    ["cash", "deleted", "with", "with", "local"],
    ["cash", "deleted", "with", "with", "hidden"],
    ["cash", "deleted", "with", "without", "local"],
    ["cash", "deleted", "with", "without", "hidden"],
    ["cash", "deleted", "without", "with", "local"],
    ["cash", "deleted", "without", "with", "hidden"],
    ["cash", "deleted", "without", "without", "local"],
    ["cash", "deleted", "without", "without", "hidden"],
    ["cash", "missing", "with", "with", "local"],
    ["cash", "missing", "with", "with", "hidden"],
    ["cash", "missing", "with", "without", "local"],
    ["cash", "missing", "with", "without", "hidden"],
    ["cash", "missing", "without", "with", "local"],
    ["cash", "missing", "without", "with", "hidden"],
    ["cash", "missing", "without", "without", "local"],
    ["cash", "missing", "without", "without", "hidden"],
    ["financed", "local", "with", "with", "local"],
    ["financed", "local", "with", "with", "hidden"],
    ["financed", "local", "with", "without", "local"],
    ["financed", "local", "with", "without", "hidden"],
    ["financed", "local", "without", "with", "local"],
    ["financed", "local", "without", "with", "hidden"],
    ["financed", "local", "without", "without", "local"],
    ["financed", "local", "without", "without", "hidden"],
    ["financed", "deleted", "with", "with", "local"],
    ["financed", "deleted", "with", "with", "hidden"],
    ["financed", "deleted", "with", "without", "local"],
    ["financed", "deleted", "with", "without", "hidden"],
    ["financed", "deleted", "without", "with", "local"],
    ["financed", "deleted", "without", "with", "hidden"],
    ["financed", "deleted", "without", "without", "local"],
    ["financed", "deleted", "without", "without", "hidden"],
    ["financed", "missing", "with", "with", "local"],
    ["financed", "missing", "with", "with", "hidden"],
    ["financed", "missing", "with", "without", "local"],
    ["financed", "missing", "with", "without", "hidden"],
    ["financed", "missing", "without", "with", "local"],
    ["financed", "missing", "without", "with", "hidden"],
    ["financed", "missing", "without", "without", "local"],
    ["financed", "missing", "without", "without", "hidden"],
  ]);
});

test("sales link gate checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("sales link gate", ["shape", "target", "viewSales", "dealNumber", "vehicle"], [
    ["cash", "local", "with", "with", "local"],
    ["cash", "local", "with", "with", "hidden"],
    ["cash", "local", "with", "without", "local"],
    ["cash", "local", "with", "without", "hidden"],
    ["cash", "local", "without", "with", "local"],
    ["cash", "local", "without", "with", "hidden"],
    ["cash", "local", "without", "without", "local"],
    ["cash", "local", "without", "without", "hidden"],
    ["financed", "local", "with", "with", "local"],
    ["financed", "local", "with", "with", "hidden"],
    ["financed", "local", "with", "without", "local"],
    ["financed", "local", "with", "without", "hidden"],
    ["financed", "local", "without", "with", "local"],
    ["financed", "local", "without", "with", "hidden"],
    ["financed", "local", "without", "without", "local"],
    ["financed", "local", "without", "without", "hidden"],
  ]);
});

test("application lookup refuses foreign targets across every navigation condition", async () => {
  await navigationCells("application lookup", ["shape", "target", "viewSales", "dealNumber", "vehicle"], [
    ["financed", "foreign", "with", "with", "local"],
    ["financed", "foreign", "with", "with", "hidden"],
    ["financed", "foreign", "with", "without", "local"],
    ["financed", "foreign", "with", "without", "hidden"],
    ["financed", "foreign", "without", "with", "local"],
    ["financed", "foreign", "without", "with", "hidden"],
    ["financed", "foreign", "without", "without", "local"],
    ["financed", "foreign", "without", "without", "hidden"],
  ]);
});

test("application lookup checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("application lookup", ["shape", "target", "viewSales", "dealNumber", "vehicle"], [
    ["financed", "local", "with", "with", "local"],
    ["financed", "local", "with", "with", "hidden"],
    ["financed", "local", "with", "without", "local"],
    ["financed", "local", "with", "without", "hidden"],
    ["financed", "local", "without", "with", "local"],
    ["financed", "local", "without", "with", "hidden"],
    ["financed", "local", "without", "without", "local"],
    ["financed", "local", "without", "without", "hidden"],
    ["financed", "missing", "with", "with", "local"],
    ["financed", "missing", "with", "with", "hidden"],
    ["financed", "missing", "with", "without", "local"],
    ["financed", "missing", "with", "without", "hidden"],
    ["financed", "missing", "without", "with", "local"],
    ["financed", "missing", "without", "with", "hidden"],
    ["financed", "missing", "without", "without", "local"],
    ["financed", "missing", "without", "without", "hidden"],
  ]);
});

test("opening lookup refuses foreign targets across every navigation condition", async () => {
  await navigationCells("opening lookup", ["target", "status", "manageFinance"], [
    ["foreign", "POSTED", "with"],
    ["foreign", "POSTED", "without"],
    ["foreign", "PENDING_APPROVAL", "with"],
    ["foreign", "PENDING_APPROVAL", "without"],
    ["foreign", "REJECTED", "with"],
    ["foreign", "REJECTED", "without"],
    ["foreign", "VOIDED", "with"],
    ["foreign", "VOIDED", "without"],
  ]);
});

test("opening lookup checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("opening lookup", ["target", "status", "manageFinance"], [
    ["local", "POSTED", "with"],
    ["local", "POSTED", "without"],
    ["local", "PENDING_APPROVAL", "with"],
    ["local", "PENDING_APPROVAL", "without"],
    ["local", "REJECTED", "with"],
    ["local", "REJECTED", "without"],
    ["local", "VOIDED", "with"],
    ["local", "VOIDED", "without"],
    ["missing", "POSTED", "with"],
    ["missing", "POSTED", "without"],
    ["missing", "PENDING_APPROVAL", "with"],
    ["missing", "PENDING_APPROVAL", "without"],
    ["missing", "REJECTED", "with"],
    ["missing", "REJECTED", "without"],
    ["missing", "VOIDED", "with"],
    ["missing", "VOIDED", "without"],
  ]);
});

test("opening status gate checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("opening status gate", ["target", "status", "manageFinance"], [
    ["local", "POSTED", "with"],
    ["local", "POSTED", "without"],
    ["local", "PENDING_APPROVAL", "with"],
    ["local", "PENDING_APPROVAL", "without"],
    ["local", "REJECTED", "with"],
    ["local", "REJECTED", "without"],
    ["local", "VOIDED", "with"],
    ["local", "VOIDED", "without"],
  ]);
});

test("opening link gate checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("opening link gate", ["target", "status", "manageFinance"], [
    ["local", "POSTED", "with"],
    ["local", "POSTED", "without"],
  ]);
});

test("expense lookup refuses foreign targets across every navigation condition", async () => {
  await navigationCells("expense lookup", ["target", "vehicle", "viewVehicles"], [
    ["foreign", "local", "with"],
    ["foreign", "local", "without"],
    ["foreign", "hidden", "with"],
    ["foreign", "hidden", "without"],
  ]);
});

test("expense lookup checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("expense lookup", ["target", "vehicle", "viewVehicles"], [
    ["local", "local", "with"],
    ["local", "local", "without"],
    ["local", "hidden", "with"],
    ["local", "hidden", "without"],
    ["deleted", "local", "with"],
    ["deleted", "local", "without"],
    ["deleted", "hidden", "with"],
    ["deleted", "hidden", "without"],
    ["missing", "local", "with"],
    ["missing", "local", "without"],
    ["missing", "hidden", "with"],
    ["missing", "hidden", "without"],
  ]);
});

test("expense vehicle lookup refuses foreign targets across every navigation condition", async () => {
  await navigationCells("expense vehicle lookup", ["target", "viewVehicles"], [
    ["foreign", "with"],
    ["foreign", "without"],
  ]);
});

test("expense vehicle lookup checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("expense vehicle lookup", ["target", "viewVehicles"], [
    ["local", "with"],
    ["local", "without"],
    ["deleted", "with"],
    ["deleted", "without"],
    ["missing", "with"],
    ["missing", "without"],
  ]);
});

test("native or sale vehicle lookup refuses foreign targets across every navigation condition", async () => {
  await navigationCells("native or sale vehicle lookup", ["shape", "target", "viewSales", "viewVehicles", "dealNumber"], [
    ["native", "foreign", "with", "with", "without"],
    ["native", "foreign", "with", "without", "without"],
    ["native", "foreign", "without", "with", "without"],
    ["native", "foreign", "without", "without", "without"],
    ["cash", "foreign", "with", "with", "with"],
    ["cash", "foreign", "with", "with", "without"],
    ["cash", "foreign", "with", "without", "with"],
    ["cash", "foreign", "with", "without", "without"],
    ["cash", "foreign", "without", "with", "with"],
    ["cash", "foreign", "without", "with", "without"],
    ["cash", "foreign", "without", "without", "with"],
    ["cash", "foreign", "without", "without", "without"],
    ["financed", "foreign", "with", "with", "with"],
    ["financed", "foreign", "with", "with", "without"],
    ["financed", "foreign", "with", "without", "with"],
    ["financed", "foreign", "with", "without", "without"],
    ["financed", "foreign", "without", "with", "with"],
    ["financed", "foreign", "without", "with", "without"],
    ["financed", "foreign", "without", "without", "with"],
    ["financed", "foreign", "without", "without", "without"],
  ]);
});

test("native or sale vehicle lookup checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("native or sale vehicle lookup", ["shape", "target", "viewSales", "viewVehicles", "dealNumber"], [
    ["native", "local", "with", "with", "without"],
    ["native", "local", "with", "without", "without"],
    ["native", "local", "without", "with", "without"],
    ["native", "local", "without", "without", "without"],
    ["native", "deleted", "with", "with", "without"],
    ["native", "deleted", "with", "without", "without"],
    ["native", "deleted", "without", "with", "without"],
    ["native", "deleted", "without", "without", "without"],
    ["native", "missing", "with", "with", "without"],
    ["native", "missing", "with", "without", "without"],
    ["native", "missing", "without", "with", "without"],
    ["native", "missing", "without", "without", "without"],
    ["cash", "local", "with", "with", "with"],
    ["cash", "local", "with", "with", "without"],
    ["cash", "local", "with", "without", "with"],
    ["cash", "local", "with", "without", "without"],
    ["cash", "local", "without", "with", "with"],
    ["cash", "local", "without", "with", "without"],
    ["cash", "local", "without", "without", "with"],
    ["cash", "local", "without", "without", "without"],
    ["cash", "deleted", "with", "with", "with"],
    ["cash", "deleted", "with", "with", "without"],
    ["cash", "deleted", "with", "without", "with"],
    ["cash", "deleted", "with", "without", "without"],
    ["cash", "deleted", "without", "with", "with"],
    ["cash", "deleted", "without", "with", "without"],
    ["cash", "deleted", "without", "without", "with"],
    ["cash", "deleted", "without", "without", "without"],
    ["cash", "missing", "with", "with", "with"],
    ["cash", "missing", "with", "with", "without"],
    ["cash", "missing", "with", "without", "with"],
    ["cash", "missing", "with", "without", "without"],
    ["cash", "missing", "without", "with", "with"],
    ["cash", "missing", "without", "with", "without"],
    ["cash", "missing", "without", "without", "with"],
    ["cash", "missing", "without", "without", "without"],
    ["financed", "local", "with", "with", "with"],
    ["financed", "local", "with", "with", "without"],
    ["financed", "local", "with", "without", "with"],
    ["financed", "local", "with", "without", "without"],
    ["financed", "local", "without", "with", "with"],
    ["financed", "local", "without", "with", "without"],
    ["financed", "local", "without", "without", "with"],
    ["financed", "local", "without", "without", "without"],
    ["financed", "deleted", "with", "with", "with"],
    ["financed", "deleted", "with", "with", "without"],
    ["financed", "deleted", "with", "without", "with"],
    ["financed", "deleted", "with", "without", "without"],
    ["financed", "deleted", "without", "with", "with"],
    ["financed", "deleted", "without", "with", "without"],
    ["financed", "deleted", "without", "without", "with"],
    ["financed", "deleted", "without", "without", "without"],
    ["financed", "missing", "with", "with", "with"],
    ["financed", "missing", "with", "with", "without"],
    ["financed", "missing", "with", "without", "with"],
    ["financed", "missing", "with", "without", "without"],
    ["financed", "missing", "without", "with", "with"],
    ["financed", "missing", "without", "with", "without"],
    ["financed", "missing", "without", "without", "with"],
    ["financed", "missing", "without", "without", "without"],
  ]);
});

test("vehicle link gate checks local deleted and missing targets across every navigation condition", async () => {
  await navigationCells("vehicle link gate", ["shape", "target", "viewVehicles"], [
    ["native", "local", "with"],
    ["native", "local", "without"],
    ["expense", "local", "with"],
    ["expense", "local", "without"],
  ]);
});
