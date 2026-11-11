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
type CallerAudit = { expected: readonly (readonly string[])[]; asserted: (readonly string[])[]; message: string };
const callerAudits: CallerAudit[] = [];
// Literal oracle independent of runner entry; census checks these against declared cells.
const EXPECTED_CALLER_RECEIPTS: Readonly<Record<string, number>> = {
  "settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales": 4,
  "settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales": 4,
  "settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales": 6,
  "settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales": 6,
  "settled opening AP preserves the viewer gate and refuses foreign or missing drafts": 4,
  "settled opening AR preserves the viewer gate and refuses foreign or missing drafts": 4,
  "settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles": 4,
  "settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources": 6,
  "relationship query preserves the viewer vehicle permission for sourced and owned rows": 4,
  "sale lookup checks local deleted and missing targets across every navigation condition": 62,
  "sale lookup checks local deleted and missing targets for financed sales across every navigation condition": 58,
  "sale lookup checks deleted and missing financed sales across every navigation condition": 100,
  "sale lookup refuses foreign targets across every navigation condition": 68,
  "sales link gate checks local targets across every navigation condition": 80,
  "application lookup checks local deleted and missing targets across every navigation condition": 40,
  "application lookup refuses foreign targets across every navigation condition": 16,
  "opening lookup checks local deleted and missing targets across every navigation condition": 22,
  "opening lookup refuses foreign targets across every navigation condition": 8,
  "opening status gate checks local targets across every navigation condition": 14,
  "opening link gate checks local targets across every navigation condition": 8,
  "expense lookup checks local deleted and missing targets across every navigation condition": 30,
  "expense lookup refuses foreign targets across every navigation condition": 8,
  "expense vehicle lookup checks local deleted and missing targets across every navigation condition": 12,
  "expense vehicle lookup refuses foreign targets across every navigation condition": 2,
  "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition": 141,
  "native or sale vehicle lookup refuses foreign targets across every navigation condition": 36,
  "vehicle link gate checks local targets across every navigation condition": 16,
  "settled multi-row AP and AR preserve denied and allowed source links": 16,
  "outstanding multi-row AP and AR preserve denied and allowed source links": 16,
  "settled partially recovered opening and expense rows preserve denied and allowed viewer gates": 4,
  "relationship multi-row large and endCursor pages preserve both viewer gates": 12,
  "settled multi-row cross-permission viewers cannot substitute another navigation gate": 8,
  "outstanding multi-row cross-permission viewers cannot substitute another navigation gate": 8,
  "outstanding partially recovered opening and expense rows preserve denied and allowed viewer gates": 4,
  "settled distinct cached vehicle and sale targets preserve every AP and AR context": 4,
  "settled distinct cached application expense and opening targets preserve every context": 6,
  "settled renamed roles retain denied and admitted navigation gates": 6,
  "outstanding distinct cached vehicle and sale targets preserve every AP and AR context": 4,
  "outstanding distinct cached application expense and opening targets preserve every context": 6,
  "outstanding renamed roles retain denied and admitted navigation gates": 6,
  "relationship renamed roles and SOLD status preserve both viewer gates": 8,
  "relationship other makes and non-null continuation preserve both viewer gates": 8,
  "owned relationships refuse distinct deleted and foreign vehicles beside valid stock": 4,
  "settled mixed AP and AR keep independent denied and admitted gates": 4,
  "outstanding mixed AP and AR keep independent denied and admitted gates": 4
};
afterEach(() => {
  try {
    const title = expect.getState().currentTestName;
    const expected = title === undefined ? undefined : EXPECTED_CALLER_RECEIPTS[title];
    if (expected !== undefined) {
      expect(callerAudits.length, title + ": bound registration must open exactly one audit").toBe(1);
      expect(callerAudits.flatMap(audit => audit.asserted).length, title + ": literal declared receipt count").toBe(expected);
    }
    for (const audit of callerAudits) verifyCallerAssertions(audit);
  } finally { callerAudits.splice(0); vi.useRealTimers(); }
});

function beginCallerAssertions(cells: readonly (readonly string[])[], message: string): CallerAudit {
  const audit: CallerAudit = { expected: cells.map(tuple => [...tuple]), asserted: [], message };
  callerAudits.push(audit);
  return audit;
}
function verifyCallerAssertions(audit: CallerAudit) {
  expect(audit.asserted, audit.message + ": every handed caller cell must execute its result assertion exactly once").toStrictEqual(audit.expected);
}
function assertCallerResult(actual: unknown, expected: unknown, audit: CallerAudit, tuple: readonly string[], message: string) {
  const before = expect.getState().assertionCalls;
  expect(actual, message).toStrictEqual(expected);
  const expectCalls = expect.getState().assertionCalls - before;
  expect(expectCalls, message + ": result expect call must execute once").toBe(1);
  audit.asserted.push(tuple);
}

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

async function settleReadBound(s: Seed, obligationId?: NavigationFixture["obligationId"]) {
  await s.t.run(async ctx => {
    const existingControl = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", q => q.eq("orgId", s.orgId).eq("systemKey", SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS)).unique();
    const accountId = existingControl?._id ?? await ctx.db.insert("chartOfAccounts", { orgId: s.orgId, code: "1240", name: "Synthetic control", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, allowManualPosting: false, active: true, systemKey: SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS, createdAt: NOW, updatedAt: NOW });
    const payables = await ctx.db.query("vehicleSupplierPayables").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(100);
    for (const row of payables.filter(row => !obligationId || row._id === obligationId)) await ctx.db.patch(row._id, { status: "PAID", amountPaid: 10 });
    const recoveries = await ctx.db.query("supplierCostRecoveries").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(100);
    for (const row of recoveries.filter(row => !obligationId || row._id === obligationId)) await ctx.db.patch(row._id, { status: row.amountDueMinor === 20000 ? "PARTIALLY_RECOVERED" : "RECOVERED", amountRecoveredMinor: 10000 });
    const claims = await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(100);
    for (const row of claims.filter(row => !obligationId || row._id === obligationId)) {
      await ctx.db.patch(row._id, { status: "PAID", amountReceived: 10, receiptSeq: 1 });
      const journalEntryId = await ctx.db.insert("journalEntries", { orgId: s.orgId, journalNumber: `read-${row._id}`, accountingDate: NOW, sourceType: "vehicleSupplierReceivables", sourceId: row._id, category: "SYSTEM", memo: "Synthetic receipt", status: "POSTED", currency: "JOD", postedBy: s.userId, postedAt: NOW, createdAt: NOW });
      await ctx.db.insert("journalLines", { orgId: s.orgId, journalEntryId, accountId, lineNumber: 1, debitMinor: 0, creditMinor: 10000, currency: "JOD", scale: 3, accountingDate: NOW });
    }
  });
}

// SCRUM-943: one base per reachable source and role, then vary its gate or target.
// Applications and opening drafts have no isDeleted field. Missing targets exercise
// their absent-document outcome; no deleted-document coverage is claimed for them.
// Native no-sale vehicles occur in AP only; expense recoveries occur in AR only.
test("settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales", async () => {
 await navigationCells("settled cash sale AP", ["shape","saleTarget","viewSales","timestamp"], [
  ["cash","local","with","valid","sale+link","number+vehicle"],
  ["cash","local","without","valid","sale","number+vehicle"],
  ["cash","foreign","with","valid","none","none"],
  ["cash","deleted","with","valid","none","none"],
 ], "settled", "AP");
});
test("settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales", async () => {
 await navigationCells("settled cash sale AR", ["shape","saleTarget","viewSales","timestamp"], [
  ["cash","local","with","valid","sale+link","number+vehicle"],
  ["cash","local","without","valid","sale","number+vehicle"],
  ["cash","foreign","with","valid","none","none"],
  ["cash","deleted","with","valid","none","none"],
 ], "settled", "AR");
});
test("settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales", async () => {
 await navigationCells("settled application AP", ["shape","saleTarget","applicationTarget","viewSales","timestamp"], [
  ["financed","local","local","with","valid","application+link","number+vehicle"],
  ["financed","local","local","without","valid","application","number+vehicle"],
  ["financed","local","foreign","with","valid","sale","number+vehicle"],
  ["financed","local","missing","with","valid","sale","number+vehicle"],
  ["financed","foreign","local","with","valid","none","none"],
  ["financed","deleted","local","with","valid","none","none"],
 ], "settled", "AP");
});
test("settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales", async () => {
 await navigationCells("settled application AR", ["shape","saleTarget","applicationTarget","viewSales","timestamp"], [
  ["financed","local","local","with","valid","application+link","number+vehicle"],
  ["financed","local","local","without","valid","application","number+vehicle"],
  ["financed","local","foreign","with","valid","sale","number+vehicle"],
  ["financed","local","missing","with","valid","sale","number+vehicle"],
  ["financed","foreign","local","with","valid","none","none"],
  ["financed","deleted","local","with","valid","none","none"],
 ], "settled", "AR");
});
test("settled opening AP preserves the viewer gate and refuses foreign or missing drafts", async () => {
 await navigationCells("settled opening AP", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","foreign","POSTED","with","valid","none","none"],
  ["opening","missing","POSTED","with","valid","none","none"],
 ], "settled", "AP");
});
test("settled opening AR preserves the viewer gate and refuses foreign or missing drafts", async () => {
 await navigationCells("settled opening AR", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","foreign","POSTED","with","valid","none","none"],
  ["opening","missing","POSTED","with","valid","none","none"],
 ], "settled", "AR");
});
test("settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", async () => {
 await navigationCells("settled native vehicle AP", ["shape","vehicle","viewVehicles","timestamp"], [
  ["native","local","with","valid","vehicle+link","vehicle"],
  ["native","local","without","valid","vehicle","vehicle"],
  ["native","foreign","with","valid","none","none"],
  ["native","deleted","with","valid","none","none"],
 ], "settled", "AP");
});
test("settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources", async () => {
 await navigationCells("settled expense vehicle AR", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["expense","local","local","with","valid","expense+vehicle+link","expense"],
  ["expense","local","local","without","valid","expense+vehicle","expense"],
  ["expense","foreign","local","with","valid","none","none"],
  ["expense","deleted","local","with","valid","none","none"],
  ["expense","local","foreign","with","valid","expense","expense"],
  ["expense","local","deleted","with","valid","expense","expense"],
 ], "settled", "AR");
});

test("relationship query preserves the viewer vehicle permission for sourced and owned rows", async () => {
  await relationshipCells([
    ["SOURCED", "without", "SOURCED", "none"],
    ["SOURCED", "with", "SOURCED", "vehicle"],
    ["OWNED", "without", "OWNED_ON_ACCOUNT", "none"],
    ["OWNED", "with", "OWNED_ON_ACCOUNT", "vehicle"],
  ]);
});

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

async function seedNavigationOpening(s: Seed, draftId: Doc<"openingBalanceDrafts">["_id"], role?: string) {
  const common = { orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Synthetic opening supplier",
    currency: "JOD", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, origin: "OPENING" as const,
    openingBalanceDraftId: draftId, openingRowKey: "AP1", title: "Synthetic local opening invoice" };
  return role === "AR"
    ? s.t.run(ctx => ctx.db.insert("supplierCostRecoveries", { ...common, amountDueMinor: 20000, amountRecoveredMinor: 0, status: "OPEN", receiptSeq: 0, purpose: "CLAIM" as const }))
    : s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", { ...common, amountDue: 10, status: "DUE_ON_SALE", openingKind: "SUPPLIER_PAYABLE" as const }));
}

async function seedNavigationCell(cell: NavigationCell, message: string, existing?: Seed): Promise<NavigationFixture> {
  const s = existing ?? await seed(navigationPermissions(cell));
  if (cell.roleName) await s.t.run(ctx => ctx.db.patch(s.roleId, { name: cell.roleName }));
  const shape = cell.shape!;
  let sale: NavigationFixture["sale"] = null;
  let expenseId: NavigationFixture["expenseId"] = null;
  let draftId: NavigationFixture["draftId"] = null;
  let obligationId: NavigationFixture["obligationId"];
  if (shape === "opening") {
    draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId,
      status: cell.status as Doc<"openingBalanceDrafts">["status"], lines: [], asOfDate: NOW, createdBy: s.userId, createdAt: NOW }));
    obligationId = await seedNavigationOpening(s, draftId, cell.role);
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
    const rows = await s.t.run(async ctx => (await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", q => q.eq("orgId", s.orgId)).take(10)).filter(row => row.saleId === sale!.saleId));
    expect(rows.length, message).toBe(1);
    obligationId = cell.role === "AP" ? await payable(s, { saleId: sale.saleId }) : rows[0]!._id;
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


async function duplicateNavigationObligation(f: NavigationFixture, message: string) {
  const copied = await duplicateNavigationPayable(f, message) ?? await duplicateNavigationClaim(f, message);
  if (copied) return copied;
  return f.s.t.run(async ctx => {
    const id = ctx.db.normalizeId("supplierCostRecoveries", f.obligationId);
    if (!id) throw new Error(message);
    const row = await ctx.db.get(id);
    if (!row) throw new Error(message);
    const { _id, _creationTime, ...fields } = row;
    return ctx.db.insert("supplierCostRecoveries", { ...fields, ...("expenseId" in fields ? { sourceEventKey: "second-navigation-cell" } : {}) });
  });
}
async function duplicateNavigationPayable(f: NavigationFixture, message: string) {
  return f.s.t.run(async ctx => {
    const id = ctx.db.normalizeId("vehicleSupplierPayables", f.obligationId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) throw new Error(message);
    const { _id, _creationTime, ...fields } = row;
    return ctx.db.insert("vehicleSupplierPayables", fields);
  });
}
async function duplicateNavigationClaim(f: NavigationFixture, message: string) {
  return f.s.t.run(async ctx => {
    const id = ctx.db.normalizeId("vehicleSupplierReceivables", f.obligationId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) throw new Error(message);
    const { _id, _creationTime, ...fields } = row;
    return ctx.db.insert("vehicleSupplierReceivables", fields);
  });
}

async function assertPartialRecovery(f: NavigationFixture, message: string) {
  await f.s.t.run(async ctx => {
    const row = await ctx.db.get(f.obligationId);
    expect(row, message).toMatchObject({ amountDueMinor: 20000, amountRecoveredMinor: 10000, status: "PARTIALLY_RECOVERED" });
  });
}

type RelationshipKind = "SOURCED" | "OWNED";
type RelationshipCondition = "single" | "multiple" | "large" | "endCursor" | "cursor" | "renamed" | "sold" | "otherMake" | "mixed-deleted" | "mixed-foreign";
type RelationshipBase = readonly [kind: RelationshipKind, permission: "with" | "without", model: "SOURCED" | "OWNED_ON_ACCOUNT", link: "none" | "vehicle"];
type RelationshipCell = RelationshipBase | readonly [...RelationshipBase, condition: RelationshipCondition];
function validateRelationshipCell(tuple: RelationshipCell, message: string) {
  expect(tuple.length, message).toBeGreaterThanOrEqual(4);
  expect(tuple.length, message).toBeLessThanOrEqual(5);
  const [kind, permission, model, link, condition = "single"] = tuple;
  expect(["SOURCED", "OWNED"], message + ": kind").toContain(kind);
  expect(["with", "without"], message + ": permission").toContain(permission);
  expect(["SOURCED", "OWNED_ON_ACCOUNT"], message + ": model").toContain(model);
  expect(["none", "vehicle"], message + ": link").toContain(link);
  expect(["single", "multiple", "large", "endCursor", "cursor", "renamed", "sold", "otherMake", "mixed-deleted", "mixed-foreign"], message + ": condition").toContain(condition);
}
async function seedRelationshipCell(tuple: RelationshipCell, message: string) {
  const [kind, permission, model, link, condition = "single"] = tuple;
  const f = await seedNavigationCell({ shape: "native", viewVehicles: permission, timestamp: "valid" }, message);
  await readBackNavigationCell(f, { shape: "native", viewVehicles: permission, timestamp: "valid" }, message);
  if (kind === "OWNED") await f.s.t.run(ctx => ctx.db.patch(f.s.vehicleId, { sourceType: "STOCK" }));
  await prepareRelationshipVariation(f.s, condition);
  const expected = [{ id: kind === "OWNED" ? f.obligationId : f.s.vehicleId, vehicleId: f.s.vehicleId,
    label: condition === "otherMake" ? "2024 BMW Camry" : "2024 Toyota Camry", model, status: condition === "sold" ? "SOLD" : "AVAILABLE",
    href: link === "vehicle" ? `/${f.s.orgId}/vehicles?supplierVehicleId=${f.s.vehicleId}` : null }];
  if (["multiple", "large", "endCursor", "cursor", "mixed-deleted", "mixed-foreign"].includes(condition)) {
    const second = await duplicateRelationship(f.s, kind);
    if (condition.startsWith("mixed-")) {
      await f.s.t.run(ctx => ctx.db.patch(second.vehicleId, condition === "mixed-deleted" ? { isDeleted: true } : { orgId: f.s.foreignOrg, make: "BMW" }));
      return { f, expected };
    }
    expected.push({ ...expected[0]!, id: second.id, vehicleId: second.vehicleId,
      href: link === "vehicle" ? `/${f.s.orgId}/vehicles?supplierVehicleId=${second.vehicleId}` : null });
  }
  return { f, expected };
}
async function relationshipCells(cells: readonly RelationshipCell[]) {
  expect(cells.length, "vehicles/project: relationship caller cells must be non-empty").toBeGreaterThan(0);
  const audit = beginCallerAssertions(cells, "vehicles/project relationshipCells");
  for (const tuple of cells) {
    const [kind, permission, , , condition = "single"] = tuple;
    const message = `vehicles/project: relationship ${kind}/${permission}/${condition}`;
    validateRelationshipCell(tuple, message);
    const { f, expected } = await seedRelationshipCell(tuple, message);
    const paginationOpts = await relationshipPagination(f.s, kind, condition, message, expected.at(-1)!.vehicleId);
    const pageSizes = { single: 25, multiple: 25, large: 26, endCursor: 1, cursor: 1, renamed: 25, sold: 25, otherMake: 25, "mixed-deleted": 25, "mixed-foreign": 25 };
    expect(paginationOpts.numItems, message + ": requested page size").toBe(pageSizes[condition]);
    if (condition === "endCursor") {
      expect(paginationOpts.endCursor, message + ": endCursor must reach the query").toEqual(expect.any(String));
      expected.shift();
    }
    if (condition === "cursor") {
      expect(paginationOpts.cursor, message + ": non-null continuation").toEqual(expect.any(String));
      expected.pop();
    }
    const result = await f.s.asUser.query(vehicles, { orgId: f.s.orgId, supplierId: f.s.supplierId, kind, paginationOpts });
    assertCallerResult(result.page.toSorted((a: { vehicleId: string }, b: { vehicleId: string }) => a.vehicleId.localeCompare(b.vehicleId)),
      expected.toSorted((a, b) => a.vehicleId.localeCompare(b.vehicleId)), audit, tuple, message);
  }
  verifyCallerAssertions(audit);
}
async function relationshipPagination(s: Seed, kind: RelationshipKind, condition: RelationshipCondition, message: string, newestVehicleId: Seed["vehicleId"]) {
  const paginationOpts: { numItems: number; cursor: string | null; endCursor?: string } = { numItems: condition === "large" ? 26 : 25, cursor: null };
  if (condition === "endCursor" || condition === "cursor") {
    const first = await related(s, kind, { numItems: 1, cursor: null });
    expect(first.page.length, message).toBe(1);
    expect(first.page[0]?.vehicleId, message + ": endCursor requires newest-first ordering").toBe(newestVehicleId);
    expect(first.isDone, message).toBe(false);
    expect(first.continueCursor.length, message).toBeGreaterThan(0);
    if (condition === "cursor") paginationOpts.cursor = first.continueCursor;
    else paginationOpts.endCursor = first.continueCursor;
    paginationOpts.numItems = 1;
  }
  return paginationOpts;
}

async function duplicateRelationship(s: Seed, kind: RelationshipKind) {
  return s.t.run(async ctx => {
    const row = await ctx.db.get(s.vehicleId);
    if (!row) throw new Error("vehicles/project: missing synthetic vehicle");
    const { _id, _creationTime, ...fields } = row;
    const vehicleId = await ctx.db.insert("vehicles", fields);
    const id = kind === "OWNED" ? await ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, supplierId: s.supplierId, vehicleId, sourcedFromName: "Second supplier snapshot", amountDue: 10,
      currency: "JOD", status: "DUE_ON_SALE", createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
    }) : vehicleId;
    return { id, vehicleId };
  });
}

async function prepareNavigationState(f: NavigationFixture, cell: NavigationCell, queryName: "outstanding" | "settled", message: string) {
  if (cell.recovery === "partial") await f.s.t.run(ctx => ctx.db.patch(f.obligationId, { amountRecoveredMinor: 10000, status: "PARTIALLY_RECOVERED" }));
  const duplicateId = cell.rowCount === "two" ? await duplicateNavigationObligation(f, message) : null;
  if (queryName === "settled") {
    await settleReadBound(f.s, f.obligationId);
    if (duplicateId) await settleReadBound(f.s, duplicateId);
  }
  if (cell.recovery === "partial") await assertPartialRecovery(f, message);
}

function assertNavigationAmounts(rows: readonly unknown[], cell: NavigationCell, queryName: "outstanding" | "settled", message: string) {
  if (cell.recovery === "partial") {
    if (queryName === "settled") expect(rows, message).toMatchObject([{ status: "PARTIALLY_RECOVERED", dueMinor: 20000, settledMinor: 10000, settlement: "PARTIAL" }]);
    else expect(rows, message + ": partial recovery remains outstanding").toMatchObject([{ outstandingMinor: 10000 }]);
  }
  if (queryName === "settled") expect(rows.map(row => row && typeof row === "object" && "settledMinor" in row ? row.settledMinor : null), message).toStrictEqual(cell.rowCount === "two" ? [10000, 10000] : [10000]);
}

async function navigationCell(door: string, cell: NavigationCell, outcome: NavigationOutcome, labelKind: NavigationLabel, queryName: "outstanding" | "settled", audit: CallerAudit, tuple: readonly string[]) {
  const message = `${door}: ${JSON.stringify(cell)} => ${outcome}/${labelKind}`;
  if (cell.sectionPair) return crossSectionNavigationCell(cell, outcome, labelKind, queryName, audit, tuple, message);
  if (cell.mixTarget) return mixedNavigationCell(cell, outcome, labelKind, queryName, audit, tuple, message);
  const f = await seedNavigationCell(cell, message);
  await readBackNavigationCell(f, cell, message);
  await readBackNavigationDocumentFields(f, cell, message);
  await prepareNavigationState(f, cell, queryName, message);
  const result = queryName === "settled"
    ? await f.s.asUser.query(api.supplierStatement.settled, { orgId: f.s.orgId, supplierId: f.s.supplierId })
    : await outstanding(f.s);
  const contexts = {
    opening: {role: "AP", counterparty: "Synthetic opening supplier"}, native: {role: "AP", counterparty: "Original supplier snapshot"},
    expense: {role: "AR", counterparty: "Synthetic supplier bearer"}, cash: {role: "AR", counterparty: "Synthetic supplier payer"}, financed: {role: "AR", counterparty: "Synthetic supplier payer"},
  };
  const role = cell.role ?? contexts[f.shape as keyof typeof contexts].role;
  const rows = role === "AP" ? result.payable.rows : result.receivable.rows;
  assertNavigationAmounts(rows, cell, queryName, message);
  await assertAdditionalReceivable(f, cell, outcome, labelKind, queryName, result.receivable.rows, message);
  const expectedContext = {
    ...contexts[f.shape as keyof typeof contexts], role, ...(cell.role === "AP" && f.sale ? { counterparty: "Original supplier snapshot" } : {}),
    occurredAt: cell.timestamp === "valid" ? NOW : null, ...expectedNavigationOutcome(f, outcome, labelKind),
  };
  assertCallerResult(rows.map(row => row.context), cell.rowCount === "two" ? [expectedContext, expectedContext] : [expectedContext], audit, tuple, message);
}

async function navigationCells(door: string, axes: readonly string[], cells: readonly (readonly string[])[], queryName: "outstanding" | "settled" = "outstanding", role?: "AP" | "AR") {
  const values: Readonly<Record<string, readonly string[]>> = {
    sectionPair: ["vehicle-expense", "sale-opening"], arOutcome: ["opening", "opening+link", "expense+vehicle", "expense+vehicle+link"], arLabel: ["opening", "expense"],
    roleName: ["Custom", "Limited reviewer"], mixTarget: ["vehicle", "saleTarget", "applicationTarget", "expenseTarget", "draftTarget"],
    mixState: ["deleted", "foreign", "missing"], validOutcome: ["vehicle+link", "sale+link", "application+link", "expense+vehicle+link", "opening+link"],
    validLabel: ["vehicle", "number+vehicle", "expense", "opening"],
    role: ["AP", "AR"], rowCount: ["two"], recovery: ["partial"],
    shape: ["native", "cash", "financed", "expense", "opening"], saleTarget: ["local", "foreign", "deleted", "missing"],
    applicationTarget: ["local", "foreign", "missing"], expenseTarget: ["local", "foreign", "deleted", "missing"],
    draftTarget: ["local", "foreign", "missing"], vehicle: ["local", "foreign", "deleted", "missing"], dealNumber: ["with", "without", "second"],
    timestamp: ["valid", "fractional", "positive-overflow", "negative-overflow"], saleStatus: ["COMPLETED", "CANCELLED"],
    viewSales: ["with", "without"], viewVehicles: ["with", "without"], manageFinance: ["with", "without"], status: ["POSTED", "PENDING_APPROVAL", "REJECTED", "VOIDED"],
  };
  expect(cells.length, `${door}: caller cells must be non-empty`).toBeGreaterThan(0);
  const audit = beginCallerAssertions(cells, door);
  for (const tuple of cells) {
    expect(tuple.length, `${door}: ${JSON.stringify(tuple)}`).toBe(axes.length + 2);
    const cell = Object.fromEntries(axes.map((axis, index) => [axis, tuple[index]!]));
    for (const [axis, value] of Object.entries(cell)) expect(values[axis], `${door}: ${JSON.stringify(cell)}`).toContain(value);
    await navigationCell(door, role ? { ...cell, role } : cell, tuple[axes.length] as NavigationOutcome, tuple[axes.length + 1] as NavigationLabel, queryName, audit, tuple);
  }
  verifyCallerAssertions(audit);
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
 ]);
});

test("sale lookup checks deleted and missing financed sales across every navigation condition", async () => {
 await navigationCells("sale lookup", ["shape","saleTarget","applicationTarget","viewSales","dealNumber","vehicle","timestamp","saleStatus"], [
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

test("settled multi-row AP and AR preserve denied and allowed source links", async () => {
 await navigationCells("settled multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","without","without","without","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","without","without","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","without","without","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","without","without","without","two","valid","POSTED","expense+vehicle","expense"],
  ["cash","AP","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["cash","AR","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["financed","AP","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["financed","AR","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["native","AP","with","with","with","two","valid","POSTED","vehicle+link","vehicle"],
  ["opening","AP","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["opening","AR","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["expense","AR","with","with","with","two","valid","POSTED","expense+vehicle+link","expense"],
 ], "settled");
});

test("outstanding multi-row AP and AR preserve denied and allowed source links", async () => {
 await navigationCells("outstanding multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","without","without","without","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","without","without","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","without","without","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","without","without","without","two","valid","POSTED","expense+vehicle","expense"],
  ["cash","AP","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["cash","AR","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["financed","AP","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["financed","AR","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["native","AP","with","with","with","two","valid","POSTED","vehicle+link","vehicle"],
  ["opening","AP","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["opening","AR","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["expense","AR","with","with","with","two","valid","POSTED","expense+vehicle+link","expense"],
 ], "outstanding");
});

test("settled partially recovered opening and expense rows preserve denied and allowed viewer gates", async () => {
 await navigationCells("settled partial recovery caller", ["shape","role","manageFinance","viewVehicles","status","recovery","timestamp"], [
  ["opening","AR","without","without","POSTED","partial","valid","opening","opening"],
  ["opening","AR","with","with","POSTED","partial","valid","opening+link","opening"],
  ["expense","AR","without","without","POSTED","partial","valid","expense+vehicle","expense"],
  ["expense","AR","with","with","POSTED","partial","valid","expense+vehicle+link","expense"],
 ], "settled");
});

test("relationship multi-row large and endCursor pages preserve both viewer gates", async () => {
 await relationshipCells([
  ["SOURCED","without","SOURCED","none","multiple"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","multiple"],
  ["SOURCED","without","SOURCED","none","large"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","large"],
  ["SOURCED","without","SOURCED","none","endCursor"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","endCursor"],
  ["SOURCED","with","SOURCED","vehicle","multiple"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","multiple"],
  ["SOURCED","with","SOURCED","vehicle","large"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","large"],
  ["SOURCED","with","SOURCED","vehicle","endCursor"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","endCursor"],
 ]);
});


test("settled multi-row cross-permission viewers cannot substitute another navigation gate", async () => {
 await navigationCells("settled cross-permission multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","with","with","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","with","with","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","with","with","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","with","with","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","with","without","with","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","with","with","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","with","with","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","with","without","with","two","valid","POSTED","expense+vehicle","expense"],
 ], "settled");
});

test("outstanding multi-row cross-permission viewers cannot substitute another navigation gate", async () => {
 await navigationCells("outstanding cross-permission multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","with","with","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","with","with","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","with","with","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","with","with","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","with","without","with","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","with","with","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","with","with","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","with","without","with","two","valid","POSTED","expense+vehicle","expense"],
 ], "outstanding");
});

test("outstanding partially recovered opening and expense rows preserve denied and allowed viewer gates", async () => {
 await navigationCells("outstanding partial recovery caller", ["shape","role","manageFinance","viewVehicles","status","recovery","timestamp"], [
  ["opening","AR","without","without","POSTED","partial","valid","opening","opening"],
  ["opening","AR","with","with","POSTED","partial","valid","opening+link","opening"],
  ["expense","AR","without","without","POSTED","partial","valid","expense+vehicle","expense"],
  ["expense","AR","with","with","POSTED","partial","valid","expense+vehicle+link","expense"],
 ], "outstanding");
});

test("caller assertion helpers reject mismatches and require exactly one real receipt", () => {
  const tuple = ["contract-cell"];
  const audit: CallerAudit = { expected: [["contract-cell"]], asserted: [], message: "assertion helper contract" };
  expect(() => assertCallerResult({ value: 1, extra: undefined }, { value: 1 }, audit, tuple, "strict mismatch")).toThrow();
  expect(audit.asserted).toStrictEqual([]);
  expect(() => verifyCallerAssertions(audit), "missing receipt must fail").toThrow();
  assertCallerResult({ value: 1 }, { value: 1 }, audit, tuple, "matching result");
  expect(audit.asserted).toStrictEqual([["contract-cell"]]);
  expect(() => verifyCallerAssertions(audit)).not.toThrow();
});

test("caller matcher canaries refuse known false strict and partial comparisons", () => {
  expect(() => expect({ value: 1 }).toStrictEqual({ value: 2 }), "toStrictEqual must reject a known false value").toThrow();
  expect(() => expect({ value: 1 }).toMatchObject({ value: 2 }), "toMatchObject must reject a known false value").toThrow();
});


async function assertAdditionalReceivable(f: NavigationFixture, cell: NavigationCell, outcome: NavigationOutcome, label: NavigationLabel,
  queryName: "outstanding" | "settled", rows: readonly { context: unknown }[], message: string) {
  if (cell.role !== "AP" || !f.sale || queryName !== "outstanding") return;
  expect(rows.map(row => row.context), message + ": seeded extra AR must retain its own gate").toStrictEqual([{
    role: "AR", occurredAt: cell.timestamp === "valid" ? NOW : null, counterparty: "Synthetic supplier payer",
    ...expectedNavigationOutcome(f, outcome, label),
  }]);
}

async function distinctNavigationVehicle(s: Seed): Promise<Seed> {
  const vehicleId = await s.t.run(async ctx => {
    const vehicle = await ctx.db.get(s.vehicleId);
    if (!vehicle) throw new Error("distinct navigation fixture needs its known vehicle");
    const { _id, _creationTime, ...fields } = vehicle;
    return ctx.db.insert("vehicles", fields);
  });
  return { ...s, vehicleId };
}

function mixedExpectedSections(f: NavigationFixture, outcome: NavigationOutcome, label: NavigationLabel) {
  const source = expectedNavigationOutcome(f, outcome, label);
  const context = (role: "AP" | "AR", counterparty: string) => ({ role, occurredAt: NOW, counterparty, ...source });
  const payable = {
    native: [context("AP", "Original supplier snapshot")], cash: [context("AP", "Original supplier snapshot")],
    financed: [context("AP", "Original supplier snapshot")], opening: [context("AP", "Synthetic opening supplier")], expense: [],
  };
  const receivable = {
    native: [], cash: [context("AR", "Synthetic supplier payer")], financed: [context("AR", "Synthetic supplier payer")],
    opening: [], expense: [context("AR", "Synthetic supplier bearer")],
  };
  return { payable: payable[f.shape as keyof typeof payable], receivable: receivable[f.shape as keyof typeof receivable] };
}

async function mixedNavigationCell(cell: NavigationCell, hiddenOutcome: NavigationOutcome, hiddenLabel: NavigationLabel,
  queryName: "outstanding" | "settled", audit: CallerAudit, tuple: readonly string[], message: string) {
  const base = { shape: cell.shape!, role: "AP", viewSales: "with", viewVehicles: "with", manageFinance: "with", timestamp: "valid", status: "POSTED" };
  const valid = await seedNavigationCell(base, message);
  const hiddenCell = { ...base, [cell.mixTarget!]: cell.mixState! };
  const hidden = await seedNavigationCell(hiddenCell, message, await distinctNavigationVehicle(valid.s));
  if (cell.mixTarget === "vehicle" && cell.mixState === "foreign") await hidden.s.t.run(ctx => ctx.db.patch(hidden.s.vehicleId, { make: "BMW" }));
  await readBackNavigationCell(valid, base, message);
  await readBackNavigationCell(hidden, hiddenCell, message);
  if (queryName === "settled") await settleReadBound(valid.s);
  const result = queryName === "settled"
    ? await valid.s.asUser.query(api.supplierStatement.settled, { orgId: valid.s.orgId, supplierId: valid.s.supplierId })
    : await outstanding(valid.s);
  const expectedValid = mixedExpectedSections(valid, cell.validOutcome as NavigationOutcome, cell.validLabel as NavigationLabel);
  const expectedHidden = mixedExpectedSections(hidden, hiddenOutcome, hiddenLabel);
  const sort = (contexts: readonly unknown[]) => contexts.toSorted((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assertCallerResult({ payable: sort(result.payable.rows.map(row => row.context)), receivable: sort(result.receivable.rows.map(row => row.context)) },
    { payable: sort([...expectedValid.payable, ...expectedHidden.payable]), receivable: sort([...expectedValid.receivable, ...expectedHidden.receivable]) }, audit, tuple, message);
}

async function prepareRelationshipVariation(s: Seed, condition: RelationshipCondition) {
  if (condition === "renamed") await s.t.run(ctx => ctx.db.patch(s.roleId, { name: "Limited reviewer" }));
  if (condition === "sold") await s.t.run(ctx => ctx.db.patch(s.vehicleId, { status: "SOLD" }));
  if (condition === "otherMake") await s.t.run(ctx => ctx.db.patch(s.vehicleId, { make: "BMW" }));
}

test("settled distinct cached vehicle and sale targets preserve every AP and AR context", async () => {
 await navigationCells("settled mixed vehicle/sale", ["shape","mixTarget","mixState","validOutcome","validLabel"], [["native","vehicle","deleted","vehicle+link","vehicle","none","none"],["native","vehicle","foreign","vehicle+link","vehicle","none","none"],["cash","saleTarget","deleted","sale+link","number+vehicle","none","none"],["cash","saleTarget","foreign","sale+link","number+vehicle","none","none"]], "settled");
});

test("settled distinct cached application expense and opening targets preserve every context", async () => {
 await navigationCells("settled mixed application/expense/opening", ["shape","mixTarget","mixState","validOutcome","validLabel"], [["financed","applicationTarget","missing","application+link","number+vehicle","sale","number+vehicle"],["financed","applicationTarget","foreign","application+link","number+vehicle","sale","number+vehicle"],["expense","expenseTarget","deleted","expense+vehicle+link","expense","none","none"],["expense","expenseTarget","foreign","expense+vehicle+link","expense","none","none"],["opening","draftTarget","foreign","opening+link","opening","none","none"],["opening","draftTarget","missing","opening+link","opening","none","none"]], "settled");
});

test("settled renamed roles retain denied and admitted navigation gates", async () => {
 await navigationCells("settled renamed caller", ["shape","roleName","viewSales","viewVehicles","manageFinance","timestamp","status"], [["cash","Limited reviewer","without","without","without","valid","POSTED","sale","number+vehicle"],["cash","Limited reviewer","with","without","without","valid","POSTED","sale+link","number+vehicle"],["native","Limited reviewer","without","without","without","valid","POSTED","vehicle","vehicle"],["native","Limited reviewer","without","with","without","valid","POSTED","vehicle+link","vehicle"],["opening","Limited reviewer","without","without","without","valid","POSTED","opening","opening"],["opening","Limited reviewer","without","without","with","valid","POSTED","opening+link","opening"]], "settled");
});

test("outstanding distinct cached vehicle and sale targets preserve every AP and AR context", async () => {
 await navigationCells("outstanding mixed vehicle/sale", ["shape","mixTarget","mixState","validOutcome","validLabel"], [["native","vehicle","deleted","vehicle+link","vehicle","none","none"],["native","vehicle","foreign","vehicle+link","vehicle","none","none"],["cash","saleTarget","deleted","sale+link","number+vehicle","none","none"],["cash","saleTarget","foreign","sale+link","number+vehicle","none","none"]], "outstanding");
});

test("outstanding distinct cached application expense and opening targets preserve every context", async () => {
 await navigationCells("outstanding mixed application/expense/opening", ["shape","mixTarget","mixState","validOutcome","validLabel"], [["financed","applicationTarget","missing","application+link","number+vehicle","sale","number+vehicle"],["financed","applicationTarget","foreign","application+link","number+vehicle","sale","number+vehicle"],["expense","expenseTarget","deleted","expense+vehicle+link","expense","none","none"],["expense","expenseTarget","foreign","expense+vehicle+link","expense","none","none"],["opening","draftTarget","foreign","opening+link","opening","none","none"],["opening","draftTarget","missing","opening+link","opening","none","none"]], "outstanding");
});

test("outstanding renamed roles retain denied and admitted navigation gates", async () => {
 await navigationCells("outstanding renamed caller", ["shape","roleName","viewSales","viewVehicles","manageFinance","timestamp","status"], [["cash","Limited reviewer","without","without","without","valid","POSTED","sale","number+vehicle"],["cash","Limited reviewer","with","without","without","valid","POSTED","sale+link","number+vehicle"],["native","Limited reviewer","without","without","without","valid","POSTED","vehicle","vehicle"],["native","Limited reviewer","without","with","without","valid","POSTED","vehicle+link","vehicle"],["opening","Limited reviewer","without","without","without","valid","POSTED","opening","opening"],["opening","Limited reviewer","without","without","with","valid","POSTED","opening+link","opening"]], "outstanding");
});

test("relationship renamed roles and SOLD status preserve both viewer gates", async () => {
 await relationshipCells([["SOURCED","without","SOURCED","none","renamed"],["SOURCED","with","SOURCED","vehicle","renamed"],["OWNED","without","OWNED_ON_ACCOUNT","none","renamed"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","renamed"],["SOURCED","without","SOURCED","none","sold"],["SOURCED","with","SOURCED","vehicle","sold"],["OWNED","without","OWNED_ON_ACCOUNT","none","sold"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","sold"]]);
});

test("relationship other makes and non-null continuation preserve both viewer gates", async () => {
 await relationshipCells([["SOURCED","without","SOURCED","none","otherMake"],["SOURCED","with","SOURCED","vehicle","otherMake"],["OWNED","without","OWNED_ON_ACCOUNT","none","otherMake"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","otherMake"],["SOURCED","without","SOURCED","none","cursor"],["SOURCED","with","SOURCED","vehicle","cursor"],["OWNED","without","OWNED_ON_ACCOUNT","none","cursor"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","cursor"]]);
});

test("owned relationships refuse distinct deleted and foreign vehicles beside valid stock", async () => {
 await relationshipCells([["OWNED","without","OWNED_ON_ACCOUNT","none","mixed-deleted"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","mixed-deleted"],["OWNED","without","OWNED_ON_ACCOUNT","none","mixed-foreign"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","mixed-foreign"]]);
});

async function crossSectionNavigationCell(cell: NavigationCell, apOutcome: NavigationOutcome, apLabel: NavigationLabel,
  queryName: "outstanding" | "settled", audit: CallerAudit, tuple: readonly string[], message: string) {
  const pair = cell.sectionPair === "vehicle-expense";
  const base = { ...cell, role: "AP", timestamp: "valid", status: "POSTED" };
  const ap = await seedNavigationCell({ ...base, shape: pair ? "native" : "cash" }, message);
  const ar = await seedNavigationCell({ ...base, role: "AR", shape: pair ? "expense" : "opening" }, message, await distinctNavigationVehicle(ap.s));
  if (queryName === "settled") await settleReadBound(ap.s);
  const result = queryName === "settled"
    ? await ap.s.asUser.query(api.supplierStatement.settled, { orgId: ap.s.orgId, supplierId: ap.s.supplierId }) : await outstanding(ap.s);
  const expectedAP = mixedExpectedSections(ap, apOutcome, apLabel);
  const arContext = { role: "AR", occurredAt: NOW, counterparty: pair ? "Synthetic supplier bearer" : "Synthetic opening supplier",
    ...expectedNavigationOutcome(ar, cell.arOutcome as NavigationOutcome, cell.arLabel as NavigationLabel) };
  const sort = (rows: readonly unknown[]) => rows.toSorted((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assertCallerResult({ payable: sort(result.payable.rows.map(row => row.context)), receivable: sort(result.receivable.rows.map(row => row.context)) },
    { payable: sort(expectedAP.payable), receivable: sort([...expectedAP.receivable, arContext]) }, audit, tuple, message);
}

test("settled mixed AP and AR keep independent denied and admitted gates", async () => {
 await navigationCells("settled mixed sections", ["sectionPair","viewSales","viewVehicles","manageFinance","arOutcome","arLabel"], [["vehicle-expense","with","without","with","expense+vehicle","expense","vehicle","vehicle"],["vehicle-expense","with","with","with","expense+vehicle+link","expense","vehicle+link","vehicle"],["sale-opening","without","with","without","opening","opening","sale","number+vehicle"],["sale-opening","with","with","with","opening+link","opening","sale+link","number+vehicle"]], "settled");
});

test("outstanding mixed AP and AR keep independent denied and admitted gates", async () => {
 await navigationCells("outstanding mixed sections", ["sectionPair","viewSales","viewVehicles","manageFinance","arOutcome","arLabel"], [["vehicle-expense","with","without","with","expense+vehicle","expense","vehicle","vehicle"],["vehicle-expense","with","with","with","expense+vehicle+link","expense","vehicle+link","vehicle"],["sale-opening","without","with","without","opening","opening","sale","number+vehicle"],["sale-opening","with","with","with","opening+link","opening","sale+link","number+vehicle"]], "outstanding");
});
