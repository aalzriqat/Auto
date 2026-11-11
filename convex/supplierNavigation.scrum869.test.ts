// Base-choice/each-choice design: Ammann and Offutt, Introduction to Software Testing, input-space partitioning
// (https://cs.gmu.edu/~offutt/softwaretest/edition1/exer-student.pdf), with focused pairwise interactions (https://csrc.nist.gov/pubs/sp/800/142/final).
// The fingerprint and form allowlist, not the cross product, close arbitrary predicates over these axes.
// Every gate denies a viewer who holds every permission except the gate's own, and admits a viewer who holds only the gate's own (plus the public query prerequisites).
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { outstanding as outstandingRegistration, settled as settledRegistration } from "./supplierStatement";
import { vehicles as relationshipRegistration } from "./supplierRelationships";
import { PERMISSIONS } from "./utils/permissions";
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
function expectedSaleVehicleCell(cell: { shape: "native" | "cash" | "financed"; target: "local" | "foreign" | "deleted"; sales: boolean; vehicles: boolean }, s: Seed, ids: Awaited<ReturnType<typeof financedSale>>) {
  return {
      kind: cell.shape === "financed" ? "APPLICATION" : "SALE",
      id: cell.shape === "financed" ? ids.applicationId : ids.saleId,
      label: cell.target === "local" ? "#941 · 2024 Toyota Camry" : `#941 · ${ids.saleId}`,
      href: cell.sales ? (cell.shape === "financed" ? `/${s.orgId}/applications/${ids.applicationId}/deal` : `/${s.orgId}/sales/${ids.saleId}/deal`) : null,
  };
}
function expectedNativeVehicleCell(cell: { shape: "native" | "cash" | "financed"; target: "local" | "foreign" | "deleted"; sales: boolean; vehicles: boolean }, s: Seed) {
  return cell.target === "local" ? {
      kind: "VEHICLE", id: s.vehicleId, label: "2024 Toyota Camry",
      href: cell.vehicles ? `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}` : null,
    } : null;
}

async function expectVehicleCell(cell: { shape: "native" | "cash" | "financed"; target: "local" | "foreign" | "deleted"; sales: boolean; vehicles: boolean }) {
  const s = await seed(["view:finance", "view:cost_price", ...(cell.sales ? ["view:sales"] : []), ...(cell.vehicles ? ["view:vehicles"] : [])]);
  const ids = cell.shape === "native" ? null : await financedSale(s);
  if (ids && cell.shape === "cash") await s.t.run(ctx => ctx.db.patch(ids.saleId, { applicationId: undefined }));
  if (!ids) await payable(s);
  if (cell.target !== "local") await hideVehicle(s, cell.target);
  const result = await outstanding(s);
  if (ids) {
    expect(result.receivable.rows.map(row => row.context.source)).toStrictEqual([expectedSaleVehicleCell(cell, s, ids)]);
    if (cell.target !== "local") expectNoVehicleLabel(result);
  } else {
    expect(result.payable.rows.map(row => row.context.source)).toStrictEqual([expectedNativeVehicleCell(cell, s)]);
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


// Multiple permission axes compose: deny axes are removed from the complement;
// if every axis admits, only those gates and the query prerequisites are seeded.
// Two deal numbers cannot exclude every arithmetic predicate; the fingerprint and operator allowlist close the rest.
type NavigationCell = Readonly<Record<string, string>>;
type NavigationOutcome = "none" | "opening" | "opening+link" | "expense" | "expense+vehicle" | "expense+vehicle+link" | "vehicle" | "vehicle+link" | "sale" | "sale+link" | "application" | "application+link";
type NavigationLabel = "none" | "opening" | "expense" | "vehicle" | "number+vehicle" | "id" | "number+id" | "second+vehicle" | "second+id";
type NavigationTarget = { orgId?: Doc<"organizations">["_id"]; isDeleted?: boolean } | null;
type NavigationFixture = {
  s: Seed;
  shape: string;
  sale: Awaited<ReturnType<typeof financedSale>> | null;
  expenseId: Doc<"expenses">["_id"] | null;
  draftId: Doc<"openingBalanceDrafts">["_id"] | null;
  obligationId: Doc<"vehicleSupplierPayables">["_id"] | Doc<"vehicleSupplierReceivables">["_id"] | Doc<"supplierCostRecoveries">["_id"];
};
const NAVIGATION_DEAL_NUMBERS: Readonly<Record<string, number | undefined>> = { with: 941, without: undefined, second: 942 };
const NAVIGATION_PERMISSIONS = { viewSales: PERMISSIONS.VIEW_SALES, viewVehicles: PERMISSIONS.VIEW_VEHICLES, manageFinance: PERMISSIONS.MANAGE_FINANCE };

function navigationPermissions(cell: NavigationCell): string[] {
  const axes = Object.entries(NAVIGATION_PERMISSIONS).filter(([axis]) => axis in cell);
  const denied: string[] = axes.filter(([axis]) => cell[axis] === "without").map(([,permission]) => permission);
  const included: string[] = axes.filter(([axis]) => cell[axis] === "with").map(([,permission]) => permission);
  const available = denied.length ? Object.values(PERMISSIONS).filter(permission => !denied.includes(permission)) : included;
  return [...new Set([PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_COST_PRICE, ...available])].sort();
}

function assertNavigationTarget(doc: NavigationTarget, state: string, s: Seed, message: string) {
  if (state === "missing") { expect(doc, message).toBeNull(); return; }
  expect(doc, message).not.toBeNull();
  expect(doc?.orgId, message).toBe(state === "foreign" ? s.foreignOrg : s.orgId);
  expect(doc?.isDeleted === true, message).toBe(state === "deleted");
}

function navigationTargets(f: NavigationFixture) {
  return { saleTarget: f.sale?.saleId, applicationTarget: f.sale?.applicationId,
    expenseTarget: f.expenseId, draftTarget: f.draftId, vehicle: f.shape === "opening" ? null : f.s.vehicleId };
}

async function seedNavigationCell(cell: NavigationCell, message: string): Promise<NavigationFixture> {
  const s = await seed(navigationPermissions(cell));
  const shape = cell.shape!;
  let sale: NavigationFixture["sale"] = null;
  let expenseId: NavigationFixture["expenseId"] = null;
  let draftId: NavigationFixture["draftId"] = null;
  let obligationId: NavigationFixture["obligationId"];
  if (shape === "opening") {
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
      vehicleId: s.vehicleId, expenseId: expenseId!, sourceEventKey: "round-six-cell", sourcedFromName: "Synthetic supplier bearer",
      amountDueMinor: 20000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0,
      createdBy: s.userId, createdAt: NOW, updatedAt: NOW }));
  } else if (shape === "native") {
    obligationId = await payable(s);
  } else {
    sale = await financedSale(s);
    await s.t.run(ctx => ctx.db.patch(sale!.saleId, { dealNumber: NAVIGATION_DEAL_NUMBERS[cell.dealNumber ?? "with"],
      ...(shape === "cash" ? { applicationId: undefined } : {}), status: (cell.saleStatus ?? "COMPLETED") as Doc<"sales">["status"] }));
    const rows = await s.t.run(ctx => ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(2));
    expect(rows.length, message).toBe(1);
    obligationId = rows[0]!._id;
  }
  const timestamps: Readonly<Record<string, number>> = { valid: NOW, fractional: 1.5, "positive-overflow": 8640000000000001, "negative-overflow": -8640000000000001 };
  await s.t.run(ctx => ctx.db.patch(obligationId, { createdAt: timestamps[cell.timestamp ?? "valid"]! }));
  const fixture = { s, shape, sale, expenseId, draftId, obligationId };
  await readBackNavigationIdentity(fixture, cell, message);
  for (const [axis, id] of Object.entries(navigationTargets(fixture))) {
    if (!id || !cell[axis] || cell[axis] === "local") continue;
    if (cell[axis] === "missing") await s.t.run(ctx => ctx.db.delete(id));
    else await s.t.run(ctx => ctx.db.patch(id, cell[axis] === "foreign" ? { orgId: s.foreignOrg } : { isDeleted: true }));
  }
  return fixture;
}

async function readBackNavigationIdentity(f: NavigationFixture, cell: NavigationCell, message: string) {
  await f.s.t.run(async ctx => {
    if (f.sale) {
      const doc = await ctx.db.get(f.sale.saleId);
      expect(doc?.dealNumber, message).toBe(NAVIGATION_DEAL_NUMBERS[cell.dealNumber ?? "with"]);
      expect(doc?.status, message).toBe(cell.saleStatus ?? "COMPLETED");
      expect(doc?.applicationId, message).toBe(f.shape === "cash" ? undefined : f.sale.applicationId);
    }
    if (f.draftId) expect((await ctx.db.get(f.draftId))?.status, message).toBe(cell.status);
    if (f.shape === "native") expect(await ctx.db.query("sales").take(1), message).toStrictEqual([]);
  });
}

async function readBackNavigationCell(f: NavigationFixture, cell: NavigationCell, message: string) {
  const {s, shape, sale, expenseId, draftId, obligationId} = f;
  await s.t.run(async ctx => {
    expect((await ctx.db.get(s.roleId))?.permissions, `${message}: exact seeded permissions ${JSON.stringify(navigationPermissions(cell))}`).toStrictEqual(navigationPermissions(cell));
    const obligation = await ctx.db.get(obligationId);
    expect(obligation, message).not.toBeNull();
    const timestamps: Readonly<Record<string, number>> = { valid: NOW, fractional: 1.5, "positive-overflow": 8640000000000001, "negative-overflow": -8640000000000001 };
    expect(obligation?.createdAt, message).toBe(timestamps[cell.timestamp ?? "valid"]);
    expect(obligation && "vehicleId" in obligation, message).toBe(shape !== "opening");
    if (shape !== "opening") expect(obligation && "origin" in obligation ? obligation.origin : undefined, message).not.toBe("OPENING");
    if (shape !== "expense") expect(obligation && "expenseId" in obligation, message).toBe(false);
    const identity = { opening: {origin: "OPENING", openingBalanceDraftId: draftId}, expense: {expenseId, vehicleId: s.vehicleId},
      native: {vehicleId: s.vehicleId}, cash: {vehicleId: s.vehicleId, saleId: sale?.saleId}, financed: {vehicleId: s.vehicleId, saleId: sale?.saleId} };
    expect(obligation, message).toMatchObject(identity[shape as keyof typeof identity]);
    for (const [axis, id] of Object.entries(navigationTargets(f))) {
      if (id) assertNavigationTarget(await ctx.db.get(id), cell[axis] ?? "local", s, message);
    }
    if (shape === "native") expect(obligation && "saleId" in obligation ? obligation.saleId : undefined, message).toBeUndefined();
  });
}

async function readBackNavigationDocumentFields(f: NavigationFixture, cell: NavigationCell, message: string) {
  const {s, shape, sale, draftId} = f;
  await s.t.run(async ctx => {
    if (sale && cell.saleTarget !== "missing") {
      const doc = await ctx.db.get(sale.saleId);
      expect(doc?.dealNumber, message).toBe(NAVIGATION_DEAL_NUMBERS[cell.dealNumber ?? "with"]);
      expect(doc?.status, message).toBe(cell.saleStatus ?? "COMPLETED");
      expect(doc?.applicationId, message).toBe(shape === "cash" ? undefined : sale.applicationId);
    }
    if (draftId && cell.draftTarget !== "missing") expect((await ctx.db.get(draftId))?.status, message).toBe(cell.status);
  });
}

function expectedNavigationOutcome(f: NavigationFixture, outcome: NavigationOutcome, labelKind: NavigationLabel) {
  const {s, sale, expenseId, draftId} = f;
  const labels = { none: "", opening: "Synthetic local opening invoice", expense: "Synthetic vehicle transport",
    vehicle: "2024 Toyota Camry", "number+vehicle": "#941 · 2024 Toyota Camry", id: sale?.saleId, "number+id": `#941 · ${sale?.saleId}`, "second+vehicle": "#942 · 2024 Toyota Camry", "second+id": `#942 · ${sale?.saleId}` };
  const source = (kind: string, id: unknown, href: string | null) => ({kind, id, label: labels[labelKind], href});
  const vehicle = (href: string | null) => ({ kind: "VEHICLE", id: s.vehicleId, label: "2024 Toyota Camry", href });
  const vehicleHref = `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}`;
  // This is an outcome-name lookup. It never inspects the input axes.
  const outcomes = {
    none: {source: null, vehicleSource: null},
    opening: {source: source("OPENING", draftId, null), vehicleSource: null},
    "opening+link": {source: source("OPENING", draftId, `/${s.orgId}/accounting?section=settings`), vehicleSource: null},
    expense: {source: source("EXPENSE", expenseId, null), vehicleSource: null},
    "expense+vehicle": {source: source("EXPENSE", expenseId, null), vehicleSource: vehicle(null)},
    "expense+vehicle+link": {source: source("EXPENSE", expenseId, null), vehicleSource: vehicle(vehicleHref)},
    vehicle: {source: vehicle(null), vehicleSource: null},
    "vehicle+link": {source: vehicle(vehicleHref), vehicleSource: null},
    sale: {source: source("SALE", sale?.saleId, null), vehicleSource: null},
    "sale+link": {source: source("SALE", sale?.saleId, `/${s.orgId}/sales/${sale?.saleId}/deal`), vehicleSource: null},
    application: {source: source("APPLICATION", sale?.applicationId, null), vehicleSource: null},
    "application+link": {source: source("APPLICATION", sale?.applicationId, `/${s.orgId}/applications/${sale?.applicationId}/deal`), vehicleSource: null},
  };
  return outcomes[outcome];
}

async function navigationCell(door: string, cell: NavigationCell, outcome: NavigationOutcome, labelKind: NavigationLabel) {
  const message = `${door}: ${JSON.stringify(cell)} => ${outcome}/${labelKind}`;
  const f = await seedNavigationCell(cell, message);
  await readBackNavigationCell(f, cell, message);
  await readBackNavigationDocumentFields(f, cell, message);
  const result = await outstanding(f.s);
  const contexts = {
    opening: {role: "AP", counterparty: "Synthetic opening supplier"}, native: {role: "AP", counterparty: "Original supplier snapshot"},
    expense: {role: "AR", counterparty: "Synthetic supplier bearer"}, cash: {role: "AR", counterparty: "Synthetic supplier payer"}, financed: {role: "AR", counterparty: "Synthetic supplier payer"},
  };
  const rows = f.shape === "opening" || f.shape === "native" ? result.payable.rows : result.receivable.rows;
  expect(rows.map(row => row.context), message).toStrictEqual([{
    ...contexts[f.shape as keyof typeof contexts], occurredAt: cell.timestamp === "valid" ? NOW : null, ...expectedNavigationOutcome(f, outcome, labelKind),
  }]);
}

async function navigationCells(door: string, axes: readonly string[], cells: readonly (readonly string[])[]) {
  const values: Readonly<Record<string, readonly string[]>> = {
    shape: ["native", "cash", "financed", "expense", "opening"], saleTarget: ["local", "foreign", "deleted", "missing"],
    applicationTarget: ["local", "foreign", "missing"], expenseTarget: ["local", "foreign", "deleted", "missing"],
    draftTarget: ["local", "foreign", "missing"], vehicle: ["local", "foreign", "deleted", "missing"], dealNumber: ["with", "without", "second"],
    timestamp: ["valid", "fractional", "positive-overflow", "negative-overflow"], saleStatus: ["COMPLETED", "CANCELLED"],
    viewSales: ["with", "without"], viewVehicles: ["with", "without"], manageFinance: ["with", "without"], status: ["POSTED", "PENDING_APPROVAL", "REJECTED", "VOIDED"],
  };
  for (const tuple of cells) {
    expect(tuple.length, `${door}: ${JSON.stringify(tuple)}`).toBe(axes.length + 2);
    const cell = Object.fromEntries(axes.map((axis, index) => [axis, tuple[index]!]));
    for (const [axis, value] of Object.entries(cell)) expect(values[axis], `${door}: ${JSON.stringify(cell)}`).toContain(value);
    await navigationCell(door, cell, tuple[axes.length] as NavigationOutcome, tuple[axes.length + 1] as NavigationLabel);
  }
}

test("sale lookup checks local deleted and missing targets across every navigation condition", async () => {
 await navigationCells("sale lookup", ["shape","saleTarget","applicationTarget","viewSales","dealNumber","vehicle","timestamp","saleStatus"], [
  ["cash","local","local","with","with","local","valid","COMPLETED","sale+link","number+vehicle"],
  ["cash","local","local","with","with","local","valid","CANCELLED","sale+link","number+vehicle"],
  ["cash","local","local","with","with","local","fractional","COMPLETED","sale+link","number+vehicle"],
  ["cash","local","local","with","with","local","positive-overflow","COMPLETED","sale+link","number+vehicle"],
  ["cash","local","local","with","with","local","negative-overflow","COMPLETED","sale+link","number+vehicle"],
  ["cash","local","local","with","second","local","valid","COMPLETED","sale+link","second+vehicle"],
  ["cash","local","local","with","with","foreign","valid","COMPLETED","sale+link","number+id"],
  ["cash","local","local","with","with","deleted","valid","COMPLETED","sale+link","number+id"],
  ["cash","local","local","with","with","missing","valid","COMPLETED","sale+link","number+id"],
  ["cash","local","local","with","without","local","valid","COMPLETED","sale+link","vehicle"],
  ["cash","local","local","with","without","foreign","valid","COMPLETED","sale+link","id"],
  ["cash","local","local","with","without","deleted","valid","COMPLETED","sale+link","id"],
  ["cash","local","local","with","without","missing","valid","COMPLETED","sale+link","id"],
  ["cash","local","local","without","with","local","valid","COMPLETED","sale","number+vehicle"],
  ["cash","local","local","without","with","local","valid","CANCELLED","sale","number+vehicle"],
  ["cash","local","local","without","with","local","fractional","COMPLETED","sale","number+vehicle"],
  ["cash","local","local","without","with","local","positive-overflow","COMPLETED","sale","number+vehicle"],
  ["cash","local","local","without","with","local","negative-overflow","COMPLETED","sale","number+vehicle"],
  ["cash","local","local","without","second","local","valid","COMPLETED","sale","second+vehicle"],
  ["cash","local","local","without","with","foreign","valid","COMPLETED","sale","number+id"],
  ["cash","local","local","without","with","deleted","valid","COMPLETED","sale","number+id"],
  ["cash","local","local","without","with","missing","valid","COMPLETED","sale","number+id"],
  ["cash","local","local","without","without","local","valid","COMPLETED","sale","vehicle"],
  ["cash","local","local","without","without","foreign","valid","COMPLETED","sale","id"],
  ["cash","local","local","without","without","deleted","valid","COMPLETED","sale","id"],
  ["cash","local","local","without","without","missing","valid","COMPLETED","sale","id"],
  ["cash","deleted","local","with","with","local","valid","COMPLETED","none","none"],
  ["cash","deleted","local","with","with","local","valid","CANCELLED","none","none"],
  ["cash","deleted","local","with","with","foreign","valid","COMPLETED","none","none"],
  ["cash","deleted","local","with","with","deleted","valid","COMPLETED","none","none"],
  ["cash","deleted","local","with","with","missing","valid","COMPLETED","none","none"],
  ["cash","deleted","local","with","without","local","valid","COMPLETED","none","none"],
  ["cash","deleted","local","with","without","foreign","valid","COMPLETED","none","none"],
  ["cash","deleted","local","with","without","deleted","valid","COMPLETED","none","none"],
  ["cash","deleted","local","with","without","missing","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","with","local","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","with","local","valid","CANCELLED","none","none"],
  ["cash","deleted","local","without","with","foreign","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","with","deleted","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","with","missing","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","without","local","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","without","foreign","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","without","deleted","valid","COMPLETED","none","none"],
  ["cash","deleted","local","without","without","missing","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","with","local","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","with","local","valid","CANCELLED","none","none"],
  ["cash","missing","local","with","with","foreign","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","with","deleted","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","with","missing","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","without","local","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","without","foreign","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","without","deleted","valid","COMPLETED","none","none"],
  ["cash","missing","local","with","without","missing","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","with","local","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","with","local","valid","CANCELLED","none","none"],
  ["cash","missing","local","without","with","foreign","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","with","deleted","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","with","missing","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","without","local","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","without","foreign","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","without","deleted","valid","COMPLETED","none","none"],
  ["cash","missing","local","without","without","missing","valid","COMPLETED","none","none"],
 ]);
});

test("sale lookup checks local deleted and missing targets for financed sales across every navigation condition", async () => {
 await navigationCells("sale lookup", ["shape","saleTarget","applicationTarget","viewSales","dealNumber","vehicle","timestamp","saleStatus"], [
  ["financed","local","local","with","with","local","valid","COMPLETED","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","valid","CANCELLED","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","fractional","COMPLETED","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","positive-overflow","COMPLETED","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","negative-overflow","COMPLETED","application+link","number+vehicle"],
  ["financed","local","local","with","second","local","valid","COMPLETED","application+link","second+vehicle"],
  ["financed","local","local","with","with","foreign","valid","COMPLETED","application+link","number+id"],
  ["financed","local","local","with","with","deleted","valid","COMPLETED","application+link","number+id"],
  ["financed","local","local","with","with","missing","valid","COMPLETED","application+link","number+id"],
  ["financed","local","local","with","without","local","valid","COMPLETED","application+link","vehicle"],
  ["financed","local","local","with","without","foreign","valid","COMPLETED","application+link","id"],
  ["financed","local","local","with","without","deleted","valid","COMPLETED","application+link","id"],
  ["financed","local","local","with","without","missing","valid","COMPLETED","application+link","id"],
  ["financed","local","local","without","with","local","valid","COMPLETED","application","number+vehicle"],
  ["financed","local","local","without","with","local","valid","CANCELLED","application","number+vehicle"],
  ["financed","local","local","without","with","local","fractional","COMPLETED","application","number+vehicle"],
  ["financed","local","local","without","with","local","positive-overflow","COMPLETED","application","number+vehicle"],
  ["financed","local","local","without","with","local","negative-overflow","COMPLETED","application","number+vehicle"],
  ["financed","local","local","without","second","local","valid","COMPLETED","application","second+vehicle"],
  ["financed","local","local","without","with","foreign","valid","COMPLETED","application","number+id"],
  ["financed","local","local","without","with","deleted","valid","COMPLETED","application","number+id"],
  ["financed","local","local","without","with","missing","valid","COMPLETED","application","number+id"],
  ["financed","local","local","without","without","local","valid","COMPLETED","application","vehicle"],
  ["financed","local","local","without","without","foreign","valid","COMPLETED","application","id"],
  ["financed","local","local","without","without","deleted","valid","COMPLETED","application","id"],
  ["financed","local","local","without","without","missing","valid","COMPLETED","application","id"],
  ["financed","local","foreign","with","with","local","valid","COMPLETED","sale","number+vehicle"],
  ["financed","local","foreign","with","with","foreign","valid","COMPLETED","sale","number+id"],
  ["financed","local","foreign","with","with","deleted","valid","COMPLETED","sale","number+id"],
  ["financed","local","foreign","with","with","missing","valid","COMPLETED","sale","number+id"],
  ["financed","local","foreign","with","without","local","valid","COMPLETED","sale","vehicle"],
  ["financed","local","foreign","with","without","foreign","valid","COMPLETED","sale","id"],
  ["financed","local","foreign","with","without","deleted","valid","COMPLETED","sale","id"],
  ["financed","local","foreign","with","without","missing","valid","COMPLETED","sale","id"],
  ["financed","local","foreign","without","with","local","valid","COMPLETED","sale","number+vehicle"],
  ["financed","local","foreign","without","with","foreign","valid","COMPLETED","sale","number+id"],
  ["financed","local","foreign","without","with","deleted","valid","COMPLETED","sale","number+id"],
  ["financed","local","foreign","without","with","missing","valid","COMPLETED","sale","number+id"],
  ["financed","local","foreign","without","without","local","valid","COMPLETED","sale","vehicle"],
  ["financed","local","foreign","without","without","foreign","valid","COMPLETED","sale","id"],
  ["financed","local","foreign","without","without","deleted","valid","COMPLETED","sale","id"],
  ["financed","local","foreign","without","without","missing","valid","COMPLETED","sale","id"],
  ["financed","local","missing","with","with","local","valid","COMPLETED","sale","number+vehicle"],
  ["financed","local","missing","with","with","foreign","valid","COMPLETED","sale","number+id"],
  ["financed","local","missing","with","with","deleted","valid","COMPLETED","sale","number+id"],
  ["financed","local","missing","with","with","missing","valid","COMPLETED","sale","number+id"],
  ["financed","local","missing","with","without","local","valid","COMPLETED","sale","vehicle"],
  ["financed","local","missing","with","without","foreign","valid","COMPLETED","sale","id"],
  ["financed","local","missing","with","without","deleted","valid","COMPLETED","sale","id"],
  ["financed","local","missing","with","without","missing","valid","COMPLETED","sale","id"],
  ["financed","local","missing","without","with","local","valid","COMPLETED","sale","number+vehicle"],
  ["financed","local","missing","without","with","foreign","valid","COMPLETED","sale","number+id"],
  ["financed","local","missing","without","with","deleted","valid","COMPLETED","sale","number+id"],
  ["financed","local","missing","without","with","missing","valid","COMPLETED","sale","number+id"],
  ["financed","local","missing","without","without","local","valid","COMPLETED","sale","vehicle"],
  ["financed","local","missing","without","without","foreign","valid","COMPLETED","sale","id"],
  ["financed","local","missing","without","without","deleted","valid","COMPLETED","sale","id"],
  ["financed","local","missing","without","without","missing","valid","COMPLETED","sale","id"],
  ["financed","deleted","local","with","with","local","valid","COMPLETED","none","none"],
  ["financed","deleted","local","with","with","local","valid","CANCELLED","none","none"],
  ["financed","deleted","local","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","local","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","local","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","local","with","without","local","valid","COMPLETED","none","none"],
  ["financed","deleted","local","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","local","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","local","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","with","local","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","with","local","valid","CANCELLED","none","none"],
  ["financed","deleted","local","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","without","local","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","local","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","with","local","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","without","local","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","with","local","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","without","local","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","foreign","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","with","local","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","without","local","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","with","local","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","without","local","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","deleted","missing","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","with","local","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","with","local","valid","CANCELLED","none","none"],
  ["financed","missing","local","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","without","local","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","local","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","with","local","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","with","local","valid","CANCELLED","none","none"],
  ["financed","missing","local","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","without","local","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","local","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","with","local","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","without","local","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","with","local","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","without","local","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","foreign","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","with","local","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","without","local","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","missing","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","with","local","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","without","local","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","missing","missing","without","without","missing","valid","COMPLETED","none","none"],
 ]);
});

test("sale lookup refuses foreign targets across every navigation condition", async () => {
 await navigationCells("sale lookup", ["shape","saleTarget","applicationTarget","viewSales","dealNumber","vehicle","timestamp","saleStatus"], [
  ["cash","foreign","local","with","with","local","valid","COMPLETED","none","none"],
  ["cash","foreign","local","with","with","local","valid","CANCELLED","none","none"],
  ["cash","foreign","local","with","with","foreign","valid","COMPLETED","none","none"],
  ["cash","foreign","local","with","with","deleted","valid","COMPLETED","none","none"],
  ["cash","foreign","local","with","with","missing","valid","COMPLETED","none","none"],
  ["cash","foreign","local","with","without","local","valid","COMPLETED","none","none"],
  ["cash","foreign","local","with","without","foreign","valid","COMPLETED","none","none"],
  ["cash","foreign","local","with","without","deleted","valid","COMPLETED","none","none"],
  ["cash","foreign","local","with","without","missing","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","with","local","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","with","local","valid","CANCELLED","none","none"],
  ["cash","foreign","local","without","with","foreign","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","with","deleted","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","with","missing","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","without","local","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","without","foreign","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","without","deleted","valid","COMPLETED","none","none"],
  ["cash","foreign","local","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","with","local","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","with","local","valid","CANCELLED","none","none"],
  ["financed","foreign","local","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","without","local","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","local","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","with","local","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","with","local","valid","CANCELLED","none","none"],
  ["financed","foreign","local","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","without","local","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","local","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","with","local","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","without","local","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","with","local","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","without","local","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","foreign","without","without","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","with","local","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","with","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","with","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","with","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","without","local","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","without","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","without","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","with","without","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","with","local","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","with","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","with","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","with","missing","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","without","local","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","without","foreign","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","without","deleted","valid","COMPLETED","none","none"],
  ["financed","foreign","missing","without","without","missing","valid","COMPLETED","none","none"],
 ]);
});

test("sales link gate checks local targets across every navigation condition", async () => {
 await navigationCells("sales link gate", ["shape","saleTarget","applicationTarget","viewSales","dealNumber","vehicle","timestamp"], [
  ["cash","local","local","with","with","local","valid","sale+link","number+vehicle"],
  ["cash","local","local","with","with","local","fractional","sale+link","number+vehicle"],
  ["cash","local","local","with","with","local","positive-overflow","sale+link","number+vehicle"],
  ["cash","local","local","with","with","local","negative-overflow","sale+link","number+vehicle"],
  ["cash","local","local","with","second","local","valid","sale+link","second+vehicle"],
  ["cash","local","local","with","with","foreign","valid","sale+link","number+id"],
  ["cash","local","local","with","with","deleted","valid","sale+link","number+id"],
  ["cash","local","local","with","with","missing","valid","sale+link","number+id"],
  ["cash","local","local","with","without","local","valid","sale+link","vehicle"],
  ["cash","local","local","with","without","foreign","valid","sale+link","id"],
  ["cash","local","local","with","without","deleted","valid","sale+link","id"],
  ["cash","local","local","with","without","missing","valid","sale+link","id"],
  ["cash","local","local","without","with","local","valid","sale","number+vehicle"],
  ["cash","local","local","without","with","local","fractional","sale","number+vehicle"],
  ["cash","local","local","without","with","local","positive-overflow","sale","number+vehicle"],
  ["cash","local","local","without","with","local","negative-overflow","sale","number+vehicle"],
  ["cash","local","local","without","second","local","valid","sale","second+vehicle"],
  ["cash","local","local","without","with","foreign","valid","sale","number+id"],
  ["cash","local","local","without","with","deleted","valid","sale","number+id"],
  ["cash","local","local","without","with","missing","valid","sale","number+id"],
  ["cash","local","local","without","without","local","valid","sale","vehicle"],
  ["cash","local","local","without","without","foreign","valid","sale","id"],
  ["cash","local","local","without","without","deleted","valid","sale","id"],
  ["cash","local","local","without","without","missing","valid","sale","id"],
  ["financed","local","local","with","with","local","valid","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","fractional","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","positive-overflow","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","negative-overflow","application+link","number+vehicle"],
  ["financed","local","local","with","second","local","valid","application+link","second+vehicle"],
  ["financed","local","local","with","with","foreign","valid","application+link","number+id"],
  ["financed","local","local","with","with","deleted","valid","application+link","number+id"],
  ["financed","local","local","with","with","missing","valid","application+link","number+id"],
  ["financed","local","local","with","without","local","valid","application+link","vehicle"],
  ["financed","local","local","with","without","foreign","valid","application+link","id"],
  ["financed","local","local","with","without","deleted","valid","application+link","id"],
  ["financed","local","local","with","without","missing","valid","application+link","id"],
  ["financed","local","local","without","with","local","valid","application","number+vehicle"],
  ["financed","local","local","without","with","local","fractional","application","number+vehicle"],
  ["financed","local","local","without","with","local","positive-overflow","application","number+vehicle"],
  ["financed","local","local","without","with","local","negative-overflow","application","number+vehicle"],
  ["financed","local","local","without","second","local","valid","application","second+vehicle"],
  ["financed","local","local","without","with","foreign","valid","application","number+id"],
  ["financed","local","local","without","with","deleted","valid","application","number+id"],
  ["financed","local","local","without","with","missing","valid","application","number+id"],
  ["financed","local","local","without","without","local","valid","application","vehicle"],
  ["financed","local","local","without","without","foreign","valid","application","id"],
  ["financed","local","local","without","without","deleted","valid","application","id"],
  ["financed","local","local","without","without","missing","valid","application","id"],
  ["financed","local","foreign","with","with","local","valid","sale","number+vehicle"],
  ["financed","local","foreign","with","with","foreign","valid","sale","number+id"],
  ["financed","local","foreign","with","with","deleted","valid","sale","number+id"],
  ["financed","local","foreign","with","with","missing","valid","sale","number+id"],
  ["financed","local","foreign","with","without","local","valid","sale","vehicle"],
  ["financed","local","foreign","with","without","foreign","valid","sale","id"],
  ["financed","local","foreign","with","without","deleted","valid","sale","id"],
  ["financed","local","foreign","with","without","missing","valid","sale","id"],
  ["financed","local","foreign","without","with","local","valid","sale","number+vehicle"],
  ["financed","local","foreign","without","with","foreign","valid","sale","number+id"],
  ["financed","local","foreign","without","with","deleted","valid","sale","number+id"],
  ["financed","local","foreign","without","with","missing","valid","sale","number+id"],
  ["financed","local","foreign","without","without","local","valid","sale","vehicle"],
  ["financed","local","foreign","without","without","foreign","valid","sale","id"],
  ["financed","local","foreign","without","without","deleted","valid","sale","id"],
  ["financed","local","foreign","without","without","missing","valid","sale","id"],
  ["financed","local","missing","with","with","local","valid","sale","number+vehicle"],
  ["financed","local","missing","with","with","foreign","valid","sale","number+id"],
  ["financed","local","missing","with","with","deleted","valid","sale","number+id"],
  ["financed","local","missing","with","with","missing","valid","sale","number+id"],
  ["financed","local","missing","with","without","local","valid","sale","vehicle"],
  ["financed","local","missing","with","without","foreign","valid","sale","id"],
  ["financed","local","missing","with","without","deleted","valid","sale","id"],
  ["financed","local","missing","with","without","missing","valid","sale","id"],
  ["financed","local","missing","without","with","local","valid","sale","number+vehicle"],
  ["financed","local","missing","without","with","foreign","valid","sale","number+id"],
  ["financed","local","missing","without","with","deleted","valid","sale","number+id"],
  ["financed","local","missing","without","with","missing","valid","sale","number+id"],
  ["financed","local","missing","without","without","local","valid","sale","vehicle"],
  ["financed","local","missing","without","without","foreign","valid","sale","id"],
  ["financed","local","missing","without","without","deleted","valid","sale","id"],
  ["financed","local","missing","without","without","missing","valid","sale","id"],
 ]);
});

test("application lookup checks local deleted and missing targets across every navigation condition", async () => {
 await navigationCells("application lookup", ["shape","saleTarget","applicationTarget","viewSales","dealNumber","vehicle","timestamp"], [
  ["financed","local","local","with","with","local","valid","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","fractional","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","positive-overflow","application+link","number+vehicle"],
  ["financed","local","local","with","with","local","negative-overflow","application+link","number+vehicle"],
  ["financed","local","local","with","second","local","valid","application+link","second+vehicle"],
  ["financed","local","local","with","with","foreign","valid","application+link","number+id"],
  ["financed","local","local","with","with","deleted","valid","application+link","number+id"],
  ["financed","local","local","with","with","missing","valid","application+link","number+id"],
  ["financed","local","local","with","without","local","valid","application+link","vehicle"],
  ["financed","local","local","with","without","foreign","valid","application+link","id"],
  ["financed","local","local","with","without","deleted","valid","application+link","id"],
  ["financed","local","local","with","without","missing","valid","application+link","id"],
  ["financed","local","local","without","with","local","valid","application","number+vehicle"],
  ["financed","local","local","without","with","local","fractional","application","number+vehicle"],
  ["financed","local","local","without","with","local","positive-overflow","application","number+vehicle"],
  ["financed","local","local","without","with","local","negative-overflow","application","number+vehicle"],
  ["financed","local","local","without","second","local","valid","application","second+vehicle"],
  ["financed","local","local","without","with","foreign","valid","application","number+id"],
  ["financed","local","local","without","with","deleted","valid","application","number+id"],
  ["financed","local","local","without","with","missing","valid","application","number+id"],
  ["financed","local","local","without","without","local","valid","application","vehicle"],
  ["financed","local","local","without","without","foreign","valid","application","id"],
  ["financed","local","local","without","without","deleted","valid","application","id"],
  ["financed","local","local","without","without","missing","valid","application","id"],
  ["financed","local","missing","with","with","local","valid","sale","number+vehicle"],
  ["financed","local","missing","with","with","foreign","valid","sale","number+id"],
  ["financed","local","missing","with","with","deleted","valid","sale","number+id"],
  ["financed","local","missing","with","with","missing","valid","sale","number+id"],
  ["financed","local","missing","with","without","local","valid","sale","vehicle"],
  ["financed","local","missing","with","without","foreign","valid","sale","id"],
  ["financed","local","missing","with","without","deleted","valid","sale","id"],
  ["financed","local","missing","with","without","missing","valid","sale","id"],
  ["financed","local","missing","without","with","local","valid","sale","number+vehicle"],
  ["financed","local","missing","without","with","foreign","valid","sale","number+id"],
  ["financed","local","missing","without","with","deleted","valid","sale","number+id"],
  ["financed","local","missing","without","with","missing","valid","sale","number+id"],
  ["financed","local","missing","without","without","local","valid","sale","vehicle"],
  ["financed","local","missing","without","without","foreign","valid","sale","id"],
  ["financed","local","missing","without","without","deleted","valid","sale","id"],
  ["financed","local","missing","without","without","missing","valid","sale","id"],
 ]);
});

test("application lookup refuses foreign targets across every navigation condition", async () => {
 await navigationCells("application lookup", ["shape","saleTarget","applicationTarget","viewSales","dealNumber","vehicle","timestamp"], [
  ["financed","local","foreign","with","with","local","valid","sale","number+vehicle"],
  ["financed","local","foreign","with","with","foreign","valid","sale","number+id"],
  ["financed","local","foreign","with","with","deleted","valid","sale","number+id"],
  ["financed","local","foreign","with","with","missing","valid","sale","number+id"],
  ["financed","local","foreign","with","without","local","valid","sale","vehicle"],
  ["financed","local","foreign","with","without","foreign","valid","sale","id"],
  ["financed","local","foreign","with","without","deleted","valid","sale","id"],
  ["financed","local","foreign","with","without","missing","valid","sale","id"],
  ["financed","local","foreign","without","with","local","valid","sale","number+vehicle"],
  ["financed","local","foreign","without","with","foreign","valid","sale","number+id"],
  ["financed","local","foreign","without","with","deleted","valid","sale","number+id"],
  ["financed","local","foreign","without","with","missing","valid","sale","number+id"],
  ["financed","local","foreign","without","without","local","valid","sale","vehicle"],
  ["financed","local","foreign","without","without","foreign","valid","sale","id"],
  ["financed","local","foreign","without","without","deleted","valid","sale","id"],
  ["financed","local","foreign","without","without","missing","valid","sale","id"],
 ]);
});

test("opening lookup checks local deleted and missing targets across every navigation condition", async () => {
 await navigationCells("opening lookup", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","with","fractional","opening+link","opening"],
  ["opening","local","POSTED","with","positive-overflow","opening+link","opening"],
  ["opening","local","POSTED","with","negative-overflow","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","local","POSTED","without","fractional","opening","opening"],
  ["opening","local","POSTED","without","positive-overflow","opening","opening"],
  ["opening","local","POSTED","without","negative-overflow","opening","opening"],
  ["opening","local","PENDING_APPROVAL","with","valid","none","none"],
  ["opening","local","PENDING_APPROVAL","without","valid","none","none"],
  ["opening","local","REJECTED","with","valid","none","none"],
  ["opening","local","REJECTED","without","valid","none","none"],
  ["opening","local","VOIDED","with","valid","none","none"],
  ["opening","local","VOIDED","without","valid","none","none"],
  ["opening","missing","POSTED","with","valid","none","none"],
  ["opening","missing","POSTED","without","valid","none","none"],
  ["opening","missing","PENDING_APPROVAL","with","valid","none","none"],
  ["opening","missing","PENDING_APPROVAL","without","valid","none","none"],
  ["opening","missing","REJECTED","with","valid","none","none"],
  ["opening","missing","REJECTED","without","valid","none","none"],
  ["opening","missing","VOIDED","with","valid","none","none"],
  ["opening","missing","VOIDED","without","valid","none","none"],
 ]);
});

test("opening lookup refuses foreign targets across every navigation condition", async () => {
 await navigationCells("opening lookup", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","foreign","POSTED","with","valid","none","none"],
  ["opening","foreign","POSTED","without","valid","none","none"],
  ["opening","foreign","PENDING_APPROVAL","with","valid","none","none"],
  ["opening","foreign","PENDING_APPROVAL","without","valid","none","none"],
  ["opening","foreign","REJECTED","with","valid","none","none"],
  ["opening","foreign","REJECTED","without","valid","none","none"],
  ["opening","foreign","VOIDED","with","valid","none","none"],
  ["opening","foreign","VOIDED","without","valid","none","none"],
 ]);
});

test("opening status gate checks local targets across every navigation condition", async () => {
 await navigationCells("opening status gate", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","with","fractional","opening+link","opening"],
  ["opening","local","POSTED","with","positive-overflow","opening+link","opening"],
  ["opening","local","POSTED","with","negative-overflow","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","local","POSTED","without","fractional","opening","opening"],
  ["opening","local","POSTED","without","positive-overflow","opening","opening"],
  ["opening","local","POSTED","without","negative-overflow","opening","opening"],
  ["opening","local","PENDING_APPROVAL","with","valid","none","none"],
  ["opening","local","PENDING_APPROVAL","without","valid","none","none"],
  ["opening","local","REJECTED","with","valid","none","none"],
  ["opening","local","REJECTED","without","valid","none","none"],
  ["opening","local","VOIDED","with","valid","none","none"],
  ["opening","local","VOIDED","without","valid","none","none"],
 ]);
});

test("opening link gate checks local targets across every navigation condition", async () => {
 await navigationCells("opening link gate", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","with","fractional","opening+link","opening"],
  ["opening","local","POSTED","with","positive-overflow","opening+link","opening"],
  ["opening","local","POSTED","with","negative-overflow","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","local","POSTED","without","fractional","opening","opening"],
  ["opening","local","POSTED","without","positive-overflow","opening","opening"],
  ["opening","local","POSTED","without","negative-overflow","opening","opening"],
 ]);
});

test("expense lookup checks local deleted and missing targets across every navigation condition", async () => {
 await navigationCells("expense lookup", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["expense","local","local","with","valid","expense+vehicle+link","expense"],
  ["expense","local","local","with","fractional","expense+vehicle+link","expense"],
  ["expense","local","local","with","positive-overflow","expense+vehicle+link","expense"],
  ["expense","local","local","with","negative-overflow","expense+vehicle+link","expense"],
  ["expense","local","local","without","valid","expense+vehicle","expense"],
  ["expense","local","local","without","fractional","expense+vehicle","expense"],
  ["expense","local","local","without","positive-overflow","expense+vehicle","expense"],
  ["expense","local","local","without","negative-overflow","expense+vehicle","expense"],
  ["expense","local","foreign","with","valid","expense","expense"],
  ["expense","local","foreign","without","valid","expense","expense"],
  ["expense","local","deleted","with","valid","expense","expense"],
  ["expense","local","deleted","without","valid","expense","expense"],
  ["expense","local","missing","with","valid","expense","expense"],
  ["expense","local","missing","without","valid","expense","expense"],
  ["expense","deleted","local","with","valid","none","none"],
  ["expense","deleted","local","without","valid","none","none"],
  ["expense","deleted","foreign","with","valid","none","none"],
  ["expense","deleted","foreign","without","valid","none","none"],
  ["expense","deleted","deleted","with","valid","none","none"],
  ["expense","deleted","deleted","without","valid","none","none"],
  ["expense","deleted","missing","with","valid","none","none"],
  ["expense","deleted","missing","without","valid","none","none"],
  ["expense","missing","local","with","valid","none","none"],
  ["expense","missing","local","without","valid","none","none"],
  ["expense","missing","foreign","with","valid","none","none"],
  ["expense","missing","foreign","without","valid","none","none"],
  ["expense","missing","deleted","with","valid","none","none"],
  ["expense","missing","deleted","without","valid","none","none"],
  ["expense","missing","missing","with","valid","none","none"],
  ["expense","missing","missing","without","valid","none","none"],
 ]);
});

test("expense lookup refuses foreign targets across every navigation condition", async () => {
 await navigationCells("expense lookup", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["expense","foreign","local","with","valid","none","none"],
  ["expense","foreign","local","without","valid","none","none"],
  ["expense","foreign","foreign","with","valid","none","none"],
  ["expense","foreign","foreign","without","valid","none","none"],
  ["expense","foreign","deleted","with","valid","none","none"],
  ["expense","foreign","deleted","without","valid","none","none"],
  ["expense","foreign","missing","with","valid","none","none"],
  ["expense","foreign","missing","without","valid","none","none"],
 ]);
});

test("expense vehicle lookup checks local deleted and missing targets across every navigation condition", async () => {
 await navigationCells("expense vehicle lookup", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["expense","local","local","with","valid","expense+vehicle+link","expense"],
  ["expense","local","local","with","fractional","expense+vehicle+link","expense"],
  ["expense","local","local","with","positive-overflow","expense+vehicle+link","expense"],
  ["expense","local","local","with","negative-overflow","expense+vehicle+link","expense"],
  ["expense","local","local","without","valid","expense+vehicle","expense"],
  ["expense","local","local","without","fractional","expense+vehicle","expense"],
  ["expense","local","local","without","positive-overflow","expense+vehicle","expense"],
  ["expense","local","local","without","negative-overflow","expense+vehicle","expense"],
  ["expense","local","deleted","with","valid","expense","expense"],
  ["expense","local","deleted","without","valid","expense","expense"],
  ["expense","local","missing","with","valid","expense","expense"],
  ["expense","local","missing","without","valid","expense","expense"],
 ]);
});

test("expense vehicle lookup refuses foreign targets across every navigation condition", async () => {
 await navigationCells("expense vehicle lookup", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["expense","local","foreign","with","valid","expense","expense"],
  ["expense","local","foreign","without","valid","expense","expense"],
 ]);
});

test("native or sale vehicle lookup checks local deleted and missing targets across every navigation condition", async () => {
 await navigationCells("native or sale vehicle lookup", ["shape","saleTarget","applicationTarget","vehicle","viewSales","viewVehicles","dealNumber","timestamp"], [
  ["native","local","local","local","with","with","without","valid","vehicle+link","vehicle"],
  ["native","local","local","local","with","with","without","fractional","vehicle+link","vehicle"],
  ["native","local","local","local","with","with","without","positive-overflow","vehicle+link","vehicle"],
  ["native","local","local","local","with","with","without","negative-overflow","vehicle+link","vehicle"],
  ["native","local","local","local","with","without","without","valid","vehicle","vehicle"],
  ["native","local","local","local","with","without","without","fractional","vehicle","vehicle"],
  ["native","local","local","local","with","without","without","positive-overflow","vehicle","vehicle"],
  ["native","local","local","local","with","without","without","negative-overflow","vehicle","vehicle"],
  ["native","local","local","local","without","with","without","valid","vehicle+link","vehicle"],
  ["native","local","local","local","without","with","without","fractional","vehicle+link","vehicle"],
  ["native","local","local","local","without","with","without","positive-overflow","vehicle+link","vehicle"],
  ["native","local","local","local","without","with","without","negative-overflow","vehicle+link","vehicle"],
  ["native","local","local","local","without","without","without","valid","vehicle","vehicle"],
  ["native","local","local","deleted","with","with","without","valid","none","none"],
  ["native","local","local","deleted","with","without","without","valid","none","none"],
  ["native","local","local","deleted","without","with","without","valid","none","none"],
  ["native","local","local","deleted","without","without","without","valid","none","none"],
  ["native","local","local","missing","with","with","without","valid","none","none"],
  ["native","local","local","missing","with","without","without","valid","none","none"],
  ["native","local","local","missing","without","with","without","valid","none","none"],
  ["native","local","local","missing","without","without","without","valid","none","none"],
  ["cash","local","local","local","with","with","with","valid","sale+link","number+vehicle"],
  ["cash","local","local","local","with","with","with","fractional","sale+link","number+vehicle"],
  ["cash","local","local","local","with","with","with","positive-overflow","sale+link","number+vehicle"],
  ["cash","local","local","local","with","with","with","negative-overflow","sale+link","number+vehicle"],
  ["cash","local","local","local","with","with","second","valid","sale+link","second+vehicle"],
  ["cash","local","local","local","with","with","without","valid","sale+link","vehicle"],
  ["cash","local","local","local","with","without","with","valid","sale+link","number+vehicle"],
  ["cash","local","local","local","with","without","with","fractional","sale+link","number+vehicle"],
  ["cash","local","local","local","with","without","with","positive-overflow","sale+link","number+vehicle"],
  ["cash","local","local","local","with","without","with","negative-overflow","sale+link","number+vehicle"],
  ["cash","local","local","local","with","without","second","valid","sale+link","second+vehicle"],
  ["cash","local","local","local","with","without","without","valid","sale+link","vehicle"],
  ["cash","local","local","local","without","with","with","valid","sale","number+vehicle"],
  ["cash","local","local","local","without","with","with","fractional","sale","number+vehicle"],
  ["cash","local","local","local","without","with","with","positive-overflow","sale","number+vehicle"],
  ["cash","local","local","local","without","with","with","negative-overflow","sale","number+vehicle"],
  ["cash","local","local","local","without","with","second","valid","sale","second+vehicle"],
  ["cash","local","local","local","without","with","without","valid","sale","vehicle"],
  ["cash","local","local","local","without","without","with","valid","sale","number+vehicle"],
  ["cash","local","local","local","without","without","without","valid","sale","vehicle"],
  ["cash","local","local","deleted","with","with","with","valid","sale+link","number+id"],
  ["cash","local","local","deleted","with","with","without","valid","sale+link","id"],
  ["cash","local","local","deleted","with","without","with","valid","sale+link","number+id"],
  ["cash","local","local","deleted","with","without","without","valid","sale+link","id"],
  ["cash","local","local","deleted","without","with","with","valid","sale","number+id"],
  ["cash","local","local","deleted","without","with","without","valid","sale","id"],
  ["cash","local","local","deleted","without","without","with","valid","sale","number+id"],
  ["cash","local","local","deleted","without","without","without","valid","sale","id"],
  ["cash","local","local","missing","with","with","with","valid","sale+link","number+id"],
  ["cash","local","local","missing","with","with","without","valid","sale+link","id"],
  ["cash","local","local","missing","with","without","with","valid","sale+link","number+id"],
  ["cash","local","local","missing","with","without","without","valid","sale+link","id"],
  ["cash","local","local","missing","without","with","with","valid","sale","number+id"],
  ["cash","local","local","missing","without","with","without","valid","sale","id"],
  ["cash","local","local","missing","without","without","with","valid","sale","number+id"],
  ["cash","local","local","missing","without","without","without","valid","sale","id"],
  ["financed","local","local","local","with","with","with","valid","application+link","number+vehicle"],
  ["financed","local","local","local","with","with","with","fractional","application+link","number+vehicle"],
  ["financed","local","local","local","with","with","with","positive-overflow","application+link","number+vehicle"],
  ["financed","local","local","local","with","with","with","negative-overflow","application+link","number+vehicle"],
  ["financed","local","local","local","with","with","second","valid","application+link","second+vehicle"],
  ["financed","local","local","local","with","with","without","valid","application+link","vehicle"],
  ["financed","local","local","local","with","without","with","valid","application+link","number+vehicle"],
  ["financed","local","local","local","with","without","with","fractional","application+link","number+vehicle"],
  ["financed","local","local","local","with","without","with","positive-overflow","application+link","number+vehicle"],
  ["financed","local","local","local","with","without","with","negative-overflow","application+link","number+vehicle"],
  ["financed","local","local","local","with","without","second","valid","application+link","second+vehicle"],
  ["financed","local","local","local","with","without","without","valid","application+link","vehicle"],
  ["financed","local","local","local","without","with","with","valid","application","number+vehicle"],
  ["financed","local","local","local","without","with","with","fractional","application","number+vehicle"],
  ["financed","local","local","local","without","with","with","positive-overflow","application","number+vehicle"],
  ["financed","local","local","local","without","with","with","negative-overflow","application","number+vehicle"],
  ["financed","local","local","local","without","with","second","valid","application","second+vehicle"],
  ["financed","local","local","local","without","with","without","valid","application","vehicle"],
  ["financed","local","local","local","without","without","with","valid","application","number+vehicle"],
  ["financed","local","local","local","without","without","without","valid","application","vehicle"],
  ["financed","local","local","deleted","with","with","with","valid","application+link","number+id"],
  ["financed","local","local","deleted","with","with","without","valid","application+link","id"],
  ["financed","local","local","deleted","with","without","with","valid","application+link","number+id"],
  ["financed","local","local","deleted","with","without","without","valid","application+link","id"],
  ["financed","local","local","deleted","without","with","with","valid","application","number+id"],
  ["financed","local","local","deleted","without","with","without","valid","application","id"],
  ["financed","local","local","deleted","without","without","with","valid","application","number+id"],
  ["financed","local","local","deleted","without","without","without","valid","application","id"],
  ["financed","local","local","missing","with","with","with","valid","application+link","number+id"],
  ["financed","local","local","missing","with","with","without","valid","application+link","id"],
  ["financed","local","local","missing","with","without","with","valid","application+link","number+id"],
  ["financed","local","local","missing","with","without","without","valid","application+link","id"],
  ["financed","local","local","missing","without","with","with","valid","application","number+id"],
  ["financed","local","local","missing","without","with","without","valid","application","id"],
  ["financed","local","local","missing","without","without","with","valid","application","number+id"],
  ["financed","local","local","missing","without","without","without","valid","application","id"],
  ["financed","local","foreign","local","with","with","with","valid","sale","number+vehicle"],
  ["financed","local","foreign","local","with","with","without","valid","sale","vehicle"],
  ["financed","local","foreign","local","with","without","with","valid","sale","number+vehicle"],
  ["financed","local","foreign","local","with","without","without","valid","sale","vehicle"],
  ["financed","local","foreign","local","without","with","with","valid","sale","number+vehicle"],
  ["financed","local","foreign","local","without","with","without","valid","sale","vehicle"],
  ["financed","local","foreign","local","without","without","with","valid","sale","number+vehicle"],
  ["financed","local","foreign","local","without","without","without","valid","sale","vehicle"],
  ["financed","local","foreign","deleted","with","with","with","valid","sale","number+id"],
  ["financed","local","foreign","deleted","with","with","without","valid","sale","id"],
  ["financed","local","foreign","deleted","with","without","with","valid","sale","number+id"],
  ["financed","local","foreign","deleted","with","without","without","valid","sale","id"],
  ["financed","local","foreign","deleted","without","with","with","valid","sale","number+id"],
  ["financed","local","foreign","deleted","without","with","without","valid","sale","id"],
  ["financed","local","foreign","deleted","without","without","with","valid","sale","number+id"],
  ["financed","local","foreign","deleted","without","without","without","valid","sale","id"],
  ["financed","local","foreign","missing","with","with","with","valid","sale","number+id"],
  ["financed","local","foreign","missing","with","with","without","valid","sale","id"],
  ["financed","local","foreign","missing","with","without","with","valid","sale","number+id"],
  ["financed","local","foreign","missing","with","without","without","valid","sale","id"],
  ["financed","local","foreign","missing","without","with","with","valid","sale","number+id"],
  ["financed","local","foreign","missing","without","with","without","valid","sale","id"],
  ["financed","local","foreign","missing","without","without","with","valid","sale","number+id"],
  ["financed","local","foreign","missing","without","without","without","valid","sale","id"],
  ["financed","local","missing","local","with","with","with","valid","sale","number+vehicle"],
  ["financed","local","missing","local","with","with","without","valid","sale","vehicle"],
  ["financed","local","missing","local","with","without","with","valid","sale","number+vehicle"],
  ["financed","local","missing","local","with","without","without","valid","sale","vehicle"],
  ["financed","local","missing","local","without","with","with","valid","sale","number+vehicle"],
  ["financed","local","missing","local","without","with","without","valid","sale","vehicle"],
  ["financed","local","missing","local","without","without","with","valid","sale","number+vehicle"],
  ["financed","local","missing","local","without","without","without","valid","sale","vehicle"],
  ["financed","local","missing","deleted","with","with","with","valid","sale","number+id"],
  ["financed","local","missing","deleted","with","with","without","valid","sale","id"],
  ["financed","local","missing","deleted","with","without","with","valid","sale","number+id"],
  ["financed","local","missing","deleted","with","without","without","valid","sale","id"],
  ["financed","local","missing","deleted","without","with","with","valid","sale","number+id"],
  ["financed","local","missing","deleted","without","with","without","valid","sale","id"],
  ["financed","local","missing","deleted","without","without","with","valid","sale","number+id"],
  ["financed","local","missing","deleted","without","without","without","valid","sale","id"],
  ["financed","local","missing","missing","with","with","with","valid","sale","number+id"],
  ["financed","local","missing","missing","with","with","without","valid","sale","id"],
  ["financed","local","missing","missing","with","without","with","valid","sale","number+id"],
  ["financed","local","missing","missing","with","without","without","valid","sale","id"],
  ["financed","local","missing","missing","without","with","with","valid","sale","number+id"],
  ["financed","local","missing","missing","without","with","without","valid","sale","id"],
  ["financed","local","missing","missing","without","without","with","valid","sale","number+id"],
  ["financed","local","missing","missing","without","without","without","valid","sale","id"],
 ]);
});

test("native or sale vehicle lookup refuses foreign targets across every navigation condition", async () => {
 await navigationCells("native or sale vehicle lookup", ["shape","saleTarget","applicationTarget","vehicle","viewSales","viewVehicles","dealNumber","timestamp"], [
  ["native","local","local","foreign","with","with","without","valid","none","none"],
  ["native","local","local","foreign","with","without","without","valid","none","none"],
  ["native","local","local","foreign","without","with","without","valid","none","none"],
  ["native","local","local","foreign","without","without","without","valid","none","none"],
  ["cash","local","local","foreign","with","with","with","valid","sale+link","number+id"],
  ["cash","local","local","foreign","with","with","without","valid","sale+link","id"],
  ["cash","local","local","foreign","with","without","with","valid","sale+link","number+id"],
  ["cash","local","local","foreign","with","without","without","valid","sale+link","id"],
  ["cash","local","local","foreign","without","with","with","valid","sale","number+id"],
  ["cash","local","local","foreign","without","with","without","valid","sale","id"],
  ["cash","local","local","foreign","without","without","with","valid","sale","number+id"],
  ["cash","local","local","foreign","without","without","without","valid","sale","id"],
  ["financed","local","local","foreign","with","with","with","valid","application+link","number+id"],
  ["financed","local","local","foreign","with","with","without","valid","application+link","id"],
  ["financed","local","local","foreign","with","without","with","valid","application+link","number+id"],
  ["financed","local","local","foreign","with","without","without","valid","application+link","id"],
  ["financed","local","local","foreign","without","with","with","valid","application","number+id"],
  ["financed","local","local","foreign","without","with","without","valid","application","id"],
  ["financed","local","local","foreign","without","without","with","valid","application","number+id"],
  ["financed","local","local","foreign","without","without","without","valid","application","id"],
  ["financed","local","foreign","foreign","with","with","with","valid","sale","number+id"],
  ["financed","local","foreign","foreign","with","with","without","valid","sale","id"],
  ["financed","local","foreign","foreign","with","without","with","valid","sale","number+id"],
  ["financed","local","foreign","foreign","with","without","without","valid","sale","id"],
  ["financed","local","foreign","foreign","without","with","with","valid","sale","number+id"],
  ["financed","local","foreign","foreign","without","with","without","valid","sale","id"],
  ["financed","local","foreign","foreign","without","without","with","valid","sale","number+id"],
  ["financed","local","foreign","foreign","without","without","without","valid","sale","id"],
  ["financed","local","missing","foreign","with","with","with","valid","sale","number+id"],
  ["financed","local","missing","foreign","with","with","without","valid","sale","id"],
  ["financed","local","missing","foreign","with","without","with","valid","sale","number+id"],
  ["financed","local","missing","foreign","with","without","without","valid","sale","id"],
  ["financed","local","missing","foreign","without","with","with","valid","sale","number+id"],
  ["financed","local","missing","foreign","without","with","without","valid","sale","id"],
  ["financed","local","missing","foreign","without","without","with","valid","sale","number+id"],
  ["financed","local","missing","foreign","without","without","without","valid","sale","id"],
 ]);
});

test("vehicle link gate checks local targets across every navigation condition", async () => {
 await navigationCells("vehicle link gate", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["native","local","local","with","valid","vehicle+link","vehicle"],
  ["native","local","local","with","fractional","vehicle+link","vehicle"],
  ["native","local","local","with","positive-overflow","vehicle+link","vehicle"],
  ["native","local","local","with","negative-overflow","vehicle+link","vehicle"],
  ["native","local","local","without","valid","vehicle","vehicle"],
  ["native","local","local","without","fractional","vehicle","vehicle"],
  ["native","local","local","without","positive-overflow","vehicle","vehicle"],
  ["native","local","local","without","negative-overflow","vehicle","vehicle"],
  ["expense","local","local","with","valid","expense+vehicle+link","expense"],
  ["expense","local","local","with","fractional","expense+vehicle+link","expense"],
  ["expense","local","local","with","positive-overflow","expense+vehicle+link","expense"],
  ["expense","local","local","with","negative-overflow","expense+vehicle+link","expense"],
  ["expense","local","local","without","valid","expense+vehicle","expense"],
  ["expense","local","local","without","fractional","expense+vehicle","expense"],
  ["expense","local","local","without","positive-overflow","expense+vehicle","expense"],
  ["expense","local","local","without","negative-overflow","expense+vehicle","expense"],
 ]);
});

// Independent literal copy: adding or removing a production permission requires review here.
const NAVIGATION_PERMISSION_UNIVERSE: readonly string[] = [
  "view:org",
  "edit:org",
  "view:users",
  "manage:users",
  "manage:roles",
  "view:vehicles",
  "create:vehicles",
  "create:vehicles:request",
  "edit:vehicles",
  "edit:vehicles:request",
  "delete:vehicles",
  "view:vehicle_info",
  "view:vehicle_leads",
  "view:vehicle_expenses",
  "view:vehicle_tasks",
  "view:vehicle_test_drives",
  "view:vehicle_work_orders",
  "view:vehicle_valuations",
  "edit:vehicle_valuations",
  "view:customers",
  "create:customers",
  "create:customers:request",
  "edit:customers",
  "edit:customers:request",
  "delete:customers",
  "view:leads",
  "create:leads",
  "create:leads:request",
  "edit:leads",
  "edit:leads:request",
  "delete:leads",
  "view:sales",
  "create:sales",
  "create:sales:request",
  "edit:sales",
  "edit:sales:request",
  "delete:sales",
  "view:expenses",
  "create:expenses",
  "create:expenses:request",
  "edit:expenses",
  "edit:expenses:request",
  "delete:expenses",
  "view:tasks",
  "create:tasks",
  "edit:tasks",
  "delete:tasks",
  "view:reports",
  "view:settings",
  "manage:settings",
  "website.view",
  "website.manage",
  "website.publish",
  "website.domain.manage",
  "website.leads.manage",
  "website.analytics.view",
  "view:finance",
  "manage:finance",
  "reopen:accounting_periods",
  "view:cost_price",
  "view:commissions",
  "manage:commissions",
  "view:payroll",
  "manage:payroll",
  "approve:requests",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "manage:supplier_settlement",
  "cancel:closed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
  "marketplace:settings",
  "marketplace:respond",
  "marketplace:analytics"
];
test("supplier navigation denied and admitted fixtures pin the full permission complement for every link gate", async () => {
  expect([...NAVIGATION_PERMISSION_UNIVERSE].sort(), "literal permission universe must match production").toStrictEqual(Object.values(PERMISSIONS).sort());
  const profiles: readonly { gate: string; cell: NavigationCell; expected: readonly string[] }[] = [
    { gate: "sales denied", cell: { shape: "cash", viewSales: "without" }, expected: NAVIGATION_PERMISSION_UNIVERSE.filter(permission => permission !== "view:sales") },
    { gate: "sales admitted", cell: { shape: "cash", viewSales: "with" }, expected: ["view:finance", "view:cost_price", "view:sales"] },
    { gate: "application denied", cell: { shape: "financed", viewSales: "without" }, expected: NAVIGATION_PERMISSION_UNIVERSE.filter(permission => permission !== "view:sales") },
    { gate: "application admitted", cell: { shape: "financed", viewSales: "with" }, expected: ["view:finance", "view:cost_price", "view:sales"] },
    { gate: "opening denied", cell: { shape: "opening", status: "POSTED", manageFinance: "without" }, expected: NAVIGATION_PERMISSION_UNIVERSE.filter(permission => permission !== "manage:finance") },
    { gate: "opening admitted", cell: { shape: "opening", status: "POSTED", manageFinance: "with" }, expected: ["view:finance", "view:cost_price", "manage:finance"] },
    { gate: "vehicle denied", cell: { shape: "native", viewVehicles: "without" }, expected: NAVIGATION_PERMISSION_UNIVERSE.filter(permission => permission !== "view:vehicles") },
    { gate: "vehicle admitted", cell: { shape: "native", viewVehicles: "with" }, expected: ["view:finance", "view:cost_price", "view:vehicles"] },
  ];
  for (const entry of profiles) {
    const fixture = await seedNavigationCell(entry.cell, entry.gate);
    const role = await fixture.s.t.run(ctx => ctx.db.get(fixture.s.roleId));
    expect(role?.permissions, entry.gate).toStrictEqual([...entry.expected].sort());
  }
});
