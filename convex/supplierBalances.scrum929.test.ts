import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { renderNotification } from "../lib/notifications/render";

const MODULES = import.meta.glob("./**/*.*s");
const NOW = Date.parse("2026-11-07T09:00:00Z");
const DAY = 86_400_000;
// Named references let the new public contract run red before its module exists.
interface CurrencyBalance {
  currency: string;
  payableMinor: number;
  receivableMinor: number;
  netMinor: number;
  overduePayableMinor: number;
  overdueReceivableMinor: number;
  disputedPayableMinor: number;
  disputedReceivableMinor: number;
  oldestDueDate: string | null;
}
interface BalanceRow { supplierId: Id<"suppliers">; supplier: string; complete: boolean; currencies: CurrencyBalance[] }
interface BalancePage { page: BalanceRow[]; complete: boolean; isDone: boolean; continueCursor: string }
const list = makeFunctionReference<"query", { orgId: Id<"organizations">; nowMs: number; cursor?: string | null }, BalancePage>("supplierBalances:list");
const get = makeFunctionReference<"query", { orgId: Id<"organizations">; supplierId: Id<"suppliers">; nowMs: number }, BalanceRow>("supplierBalances:get");

afterEach(() => vi.useRealTimers());

async function seed(tag: string, permissions = ["view:finance", "view:cost_price"], plan: "professional" | "free" = "professional", transactionLimits = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, MODULES, { transactionLimits });
  const orgId = await t.run(ctx => ctx.db.insert("organizations", { name: tag, createdAt: NOW }));
  const subscriptionId = await t.run(ctx => ctx.db.insert("subscriptions", { orgId, plan, status: "active", createdAt: NOW, updatedAt: NOW }));
  const userId = await t.run(ctx => ctx.db.insert("users", { clerkId: tag, name: "Reader", email: `${tag}@example.com` }));
  const roleId = await t.run(ctx => ctx.db.insert("roles", { orgId, name: "Reader", permissions }));
  await t.run(ctx => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const supplierId = await t.run(ctx => ctx.db.insert("suppliers", {
    orgId, displayName: "Current supplier", displayNameKey: "current supplier", status: "ACTIVE", origin: "MANUAL",
    version: 1, createdBy: userId, updatedBy: userId, createdAt: NOW, updatedAt: NOW,
  }));
  const vehicleId = await t.run(ctx => ctx.db.insert("vehicles", {
    orgId, vin: tag, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White", fuelType: "Gas",
    transmission: "Auto", sellingPrice: 12500, status: "AVAILABLE", sourceType: "SOURCED", sourcedFromName: "Old name", sourceCost: 9500,
  }));
  const customerId = await t.run(ctx => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Fixture" }));
  const saleId = await t.run(ctx => ctx.db.insert("sales", { orgId, vehicleId, customerId, salespersonId: userId, salePrice: 12500, saleDate: NOW, status: "COMPLETED" }));
  return { t, orgId, userId, roleId, subscriptionId, supplierId, vehicleId, saleId, asUser: t.withIdentity({ subject: tag, clerkId: tag }) };
}
type Seed = Awaited<ReturnType<typeof seed>>;
const payable = (s: Seed, fields: Partial<Extract<Doc<"vehicleSupplierPayables">, { vehicleId: Id<"vehicles"> }>> = {}) => s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", {
  orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, sourcedFromName: "Old name", amountDue: 9500,
  currency: "JOD", status: "DUE_ON_SALE", paymentDueDate: NOW - DAY, createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...fields,
}));
const receivable = (s: Seed, fields: Partial<Doc<"vehicleSupplierReceivables">> = {}) => s.t.run(ctx => ctx.db.insert("vehicleSupplierReceivables", {
  orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, saleId: s.saleId, sourcedFromName: "Old name", amountDue: 3000,
  currency: "JOD", status: "OPEN", agreedDueDate: NOW + DAY, createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...fields,
}));
const recovery = (s: Seed, fields: Partial<Extract<Doc<"supplierCostRecoveries">, { vehicleId: Id<"vehicles"> }>> = {}) => s.t.run(async ctx => {
  const expenseId = await ctx.db.insert("expenses", { orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport", amount: 200, date: NOW, category: "TRANSPORT", status: "PAID" });
  return ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId, vehicleId: s.vehicleId, expenseId,
    sourceEventKey: String(expenseId), sourcedFromName: "Old name", amountDueMinor: 200000, amountRecoveredMinor: 0, currency: "JOD",
    receiptSeq: 0, status: "OPEN", agreedDueDate: NOW - DAY, createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...fields });
});
const report = (s: Seed, extra = {}) => s.asUser.query(list, { orgId: s.orgId, nowMs: NOW, ...extra });

describe("SCRUM-929 supplier balances", () => {
  test("each supplier/currency equals the statement to the minor unit, including dispute and recovery", async () => {
    const s = await seed("equal");
    await payable(s, { amountDue: 9500.001, amountPaid: 4000, status: "DISPUTED" });
    await receivable(s);
    await recovery(s);
    const second = await s.t.run(ctx => ctx.db.insert("suppliers", { orgId: s.orgId, displayName: "Second", displayNameKey: "second", status: "INACTIVE", origin: "MANUAL", version: 1, createdBy: s.userId, updatedBy: s.userId, createdAt: NOW, updatedAt: NOW }));
    await payable(s, { supplierId: second, amountDue: 1.234 });
    const r = await report(s);
    expect(r.complete).toBe(true);
    expect(r.page).toHaveLength(2);
    expect(r.page.find(row => row.supplierId === s.supplierId)?.currencies).toEqual([{
      currency: "JOD", payableMinor: 5500001, receivableMinor: 3200000, netMinor: -2300001,
      overduePayableMinor: 5500001, overdueReceivableMinor: 200000, disputedPayableMinor: 5500001, disputedReceivableMinor: 0, oldestDueDate: "2026-11-06",
    }]);
    expect(r.page.find(row => row.supplierId === second)?.currencies[0]?.payableMinor).toBe(1234);
    for (const row of r.page) {
      const statement = await s.asUser.query(api.supplierStatement.outstanding, { orgId: s.orgId, supplierId: row.supplierId, nowMs: NOW });
      for (const c of row.currencies) {
        expect(c.payableMinor).toBe(statement.payable.totals.find(t => t.currency === c.currency)?.grossMinor ?? 0);
        expect(c.receivableMinor).toBe(statement.receivable.totals.find(t => t.currency === c.currency)?.grossMinor ?? 0);
      }
      expect(await s.asUser.query(get, { orgId: s.orgId, supplierId: row.supplierId, nowMs: NOW })).toEqual(row);
    }
  });
  test("two currencies remain separate; cancelled claims and same-day settled recoveries disappear", async () => {
    const s = await seed("currency");
    await payable(s);
    await receivable(s, { currency: "USD", amountDue: 12.34 });
    await receivable(s, { status: "CANCELLED" });
    const id = await recovery(s);
    await s.t.run(ctx => ctx.db.patch(id, { status: "RECOVERED", amountRecoveredMinor: 200000 }));
    const r = await report(s);
    expect(r.page[0]?.currencies.map(c => [c.currency, c.payableMinor, c.receivableMinor, c.netMinor])).toEqual([["JOD", 9500000, 0, -9500000], ["USD", 0, 1234, 1234]]);
  });
  test("renamed suppliers retain id attribution; unlinked legacy rows are outside statement scope", async () => {
    const s = await seed("rename");
    await payable(s);
    await payable(s, { supplierId: undefined, amountDue: 500 });
    await s.t.run(ctx => ctx.db.patch(s.supplierId, { displayName: "Renamed supplier" }));
    const r = await report(s);
    expect(r.page[0]).toMatchObject({ supplierId: s.supplierId, supplier: "Renamed supplier", currencies: [{ payableMinor: 9500000 }] });
  });
  test("an oversized obligation family withholds every figure for that supplier", async () => {
    const s = await seed("bound");
    for (let i = 0; i < 101; i += 1) await payable(s, { amountDue: 1 });
    await receivable(s);
    const r = await report(s);
    expect(r.complete).toBe(false);
    expect(r.page[0]).toMatchObject({ complete: false, currencies: [] });
  });
  test("a multi-page registry is partial, can be paged, and never claims a complete book on a continuation", async () => {
    const s = await seed("pages");
    for (let i = 0; i < 5; i += 1) await s.t.run(ctx => ctx.db.insert("suppliers", { orgId: s.orgId, displayName: `S${i}`, displayNameKey: `s${i}`, status: "ACTIVE", origin: "MANUAL", version: 1, createdBy: s.userId, updatedBy: s.userId, createdAt: NOW, updatedAt: NOW }));
    const first = await report(s);
    expect(first.complete).toBe(false);
    expect(first.isDone).toBe(false);
    expect(first.page).toHaveLength(5);
    const next = await report(s, { cursor: first.continueCursor });
    expect(next.isDone).toBe(true);
    expect(next.complete).toBe(false);
    expect(new Set([...first.page, ...next.page].map(r => r.supplierId)).size).toBe(6);
  });
  test("large linked rows exhaust shared byte headroom truthfully", async () => {
    const s = await seed("bytes", undefined, undefined, true);
    for (let i = 0; i < 20; i += 1) await payable(s, { amountDue: 1, paymentNotes: "n".repeat(900000) });
    const r = await report(s);
    expect(r.complete).toBe(false);
    expect(r.page[0]).toMatchObject({ complete: false, currencies: [] });
  });
  test("Amman midnight changes only overdue aging from the explicit clock argument", async () => {
    const s = await seed("midnight");
    await payable(s, { paymentDueDate: Date.parse("2026-11-07T20:00:00Z") });
    const before = await report(s, { nowMs: Date.parse("2026-11-07T20:59:59Z") });
    const after = await report(s, { nowMs: Date.parse("2026-11-07T21:00:00Z") });
    expect(before.page[0]?.currencies[0]?.overduePayableMinor).toBe(0);
    expect(after.page[0]?.currencies[0]?.overduePayableMinor).toBe(9500000);
    expect(after.page[0]?.currencies[0]?.payableMinor).toBe(9500000);
  });
  test.each([{ permissions: ["view:finance"] }, { permissions: ["view:cost_price"] }, { permissions: [] }])("requires both statement permissions: $permissions", async ({ permissions }) => {
    const s = await seed(`permission${permissions.join("")}`, permissions);
    await expect(report(s)).rejects.toThrow(/permission|authorized|access/i);
  });
  test("requires accounting plan and authentication, refuses foreign tenant and supplier", async () => {
    const s = await seed("auth");
    const foreignOrg = await s.t.run(ctx => ctx.db.insert("organizations", { name: "Foreign", createdAt: NOW }));
    const foreignSupplier = await s.t.run(ctx => ctx.db.insert("suppliers", { orgId: foreignOrg, displayName: "Secret", displayNameKey: "secret", status: "ACTIVE", origin: "MANUAL", version: 1, createdBy: s.userId, updatedBy: s.userId, createdAt: NOW, updatedAt: NOW }));
    await expect(s.t.query(list, { orgId: s.orgId, nowMs: NOW })).rejects.toThrow(/auth/i);
    await expect(report(s, { orgId: foreignOrg })).rejects.toThrow();
    await expect(s.asUser.query(get, { orgId: s.orgId, supplierId: foreignSupplier, nowMs: NOW })).rejects.toThrow(/not found/i);
    expect((await report(s)).page.map(r => r.supplier)).toEqual(["Current supplier"]);
    await s.t.run(ctx => ctx.db.patch(s.subscriptionId, { plan: "free" }));
    await expect(report(s)).rejects.toThrow(/upgrade|feature|plan/i);
  });
  test.each([NaN, Infinity, 1.5, 8.64e15 + 1])("refuses invalid clock %s", async nowMs => {
    const s = await seed("clock");
    await expect(report(s, { nowMs })).rejects.toThrow(/time|clock|nowMs/i);
  });
});

describe("SCRUM-929 alert destinations and confidentiality", () => {
  test.each(["PAYABLE", "RECEIVABLE", "RECOVERY"] as const)("%s links stored supplier identity and renders direction, once per step", async kind => {
    const s = await seed(`alert${kind}`);
    if (kind === "PAYABLE") await payable(s, { paymentDueDate: NOW });
    else if (kind === "RECEIVABLE") await receivable(s, { agreedDueDate: NOW });
    else await recovery(s, { agreedDueDate: NOW });
    await s.t.run(ctx => ctx.db.patch(s.supplierId, { displayName: "Renamed supplier" }));
    const args = { orgId: s.orgId, now: NOW, kind };
    await s.t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, args);
    await s.t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, args);
    const rows = await s.t.run(ctx => ctx.db.query("notifications").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.link).toBe(`/${s.orgId}/suppliers/${s.supplierId}`);
    expect(rows[0]?.data?.supplier).toBe("Renamed supplier");
    const message = renderNotification("en", rows[0]!.type!, rows[0]!.data).message;
    expect(message).toContain(kind === "PAYABLE" ? "You owe supplier Renamed supplier" : "Supplier Renamed supplier owes you");
  });
  test.each(["missing", "foreign", "deleted"])("%s supplier falls back to balances without leaking a name", async mode => {
    const s = await seed(`fallback${mode}`);
    if (mode === "foreign") {
      const org = await s.t.run(ctx => ctx.db.insert("organizations", { name: "Other", createdAt: NOW }));
      await s.t.run(ctx => ctx.db.patch(s.supplierId, { orgId: org, displayName: "Secret supplier" }));
    }
    if (mode === "deleted") await s.t.run(ctx => ctx.db.delete(s.supplierId));
    await payable(s, { paymentDueDate: NOW, ...(mode === "missing" ? { supplierId: undefined } : {}) });
    await s.t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW, kind: "PAYABLE" });
    const rows = await s.t.run(ctx => ctx.db.query("notifications").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.link).toBe(`/${s.orgId}/suppliers/balances`);
    expect(rows[0]?.data).not.toHaveProperty("supplier");
  });
  test("non-cost recipient receives neither amount nor supplier name; direction remains useful", async () => {
    const s = await seed("redacted", ["view:finance"]);
    await payable(s, { paymentDueDate: NOW });
    await s.t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW, kind: "PAYABLE" });
    const rows = await s.t.run(ctx => ctx.db.query("notifications").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).not.toHaveProperty("amount");
    expect(rows[0]?.data).not.toHaveProperty("supplier");
    expect(renderNotification("en", rows[0]!.type!, rows[0]!.data).message).toBe("You owe a supplier, due 2026-11-07.");
  });
});
