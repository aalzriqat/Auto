/**
 * SCRUM-869 slice 1 - one supplier's outstanding A/P and A/R, kept apart (ADR
 * docs/adr/2026-11-03-supplier-statement-outstanding-query.md). Read-only.
 *
 * Evidence boundary: convex-test only (no runtime read limits, no OCC) and seeded rows, not
 * production data. Amounts use the 3-decimal JOD scale, so 9,500 JOD is 9_500_000 minor units.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.*s");
const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T09:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

async function seed(tag: string, permissions: string[] = ["view:finance"]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `ST ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "ST User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Finance", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
      fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: 9_500,
    })
  );
  const supplierId = await addSupplier(t, orgId, "Amman Importer Co", userId);
  return { t, orgId, userId, asUser, customerId, vehicleId, supplierId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

function addSupplier(t: ReturnType<typeof convexTestWithComponents>, orgId: Id<"organizations">, displayName: string, userId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db.insert("suppliers", {
      orgId, displayName, displayNameKey: displayName.toLowerCase(), status: "ACTIVE", origin: "MANUAL", version: 1, createdBy: userId, updatedBy: userId,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as never)
  );
}

const addPayable = (s: Seed, fields: Record<string, unknown> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co", amountDue: 9_500,
      currency: "JOD", status: "DUE_ON_SALE", paymentDueDate: NOW - 10 * DAY, createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
      ...fields,
    } as never)
  );

const addReceivable = async (s: Seed, fields: Record<string, unknown> = {}) => {
  const saleId = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 12_500, saleDate: NOW - 40 * DAY, status: "COMPLETED",
    } as never)
  );
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co",
      amountDue: 3_000, currency: "JOD", status: "OPEN", agreedDueDate: NOW + 5 * DAY, createdBy: s.userId,
      createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );
};

const addRecovery = (s: Seed, fields: Record<string, unknown> = {}) =>
  s.t.run(async (ctx) => {
    const expenseId = await ctx.db.insert("expenses", {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport", amount: 200, date: NOW - DAY, category: "TRANSPORT", status: "PAID",
    } as never);
    return await ctx.db.insert("supplierCostRecoveries", {
      orgId: s.orgId, vehicleId: s.vehicleId, expenseId, supplierId: s.supplierId, sourceEventKey: `ev_${Math.random()}`,
      sourcedFromName: "Amman Importer Co", amountDueMinor: 200_000, amountRecoveredMinor: 0, currency: "JOD",
      receiptSeq: 0, status: "OPEN", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...fields,
    } as never);
  });

const statement = (s: Seed, supplierId: Id<"suppliers"> = s.supplierId, extra: Record<string, unknown> = {}) =>
  s.asUser.query(api.supplierStatement.outstanding, { orgId: s.orgId, supplierId, nowMs: NOW, ...extra } as never);

describe("SCRUM-869 supplier statement: outstanding A/P and A/R", () => {
  test("scenario 5: the same supplier's A/P and A/R stay in two sections and are never netted", async () => {
    const s = await seed("s5");
    await addPayable(s); // we owe 9,500 JOD
    await addReceivable(s); // they owe 3,000 JOD
    const r = await statement(s);

    expect(r.payable.rows.map((x: { outstandingMinor: number }) => x.outstandingMinor)).toEqual([9_500_000]);
    expect(r.receivable.rows.map((x: { outstandingMinor: number }) => x.outstandingMinor)).toEqual([3_000_000]);
    expect(r.payable.totals).toEqual([{ currency: "JOD", grossMinor: 9_500_000, disputedMinor: 0, overdueMinor: 9_500_000 }]);
    expect(r.receivable.totals).toEqual([{ currency: "JOD", grossMinor: 3_000_000, disputedMinor: 0, overdueMinor: 0 }]);
    // No net, balance or difference figure anywhere in the result.
    expect(Object.keys(r).sort()).toEqual(["payable", "receivable", "supplierId"]);
    const keys: string[] = [];
    JSON.stringify(r, (k, v) => (keys.push(k), v));
    expect(keys.filter((k) => /net|balance|diff|offset/i.test(k))).toEqual([]);
  });

  test("a cost recovery is A/R, labelled by kind, and joins the receivable total of its own currency only", async () => {
    const s = await seed("rec");
    await addReceivable(s);
    await addRecovery(s);
    await addReceivable(s, { currency: "USD", amountDue: 100 });
    const r = await statement(s);
    expect(r.receivable.rows.map((x: { kind: string }) => x.kind).sort()).toEqual(["RECEIVABLE", "RECEIVABLE", "RECOVERY"]);
    const byCurrency = Object.fromEntries(r.receivable.totals.map((t: { currency: string; grossMinor: number }) => [t.currency, t.grossMinor]));
    expect(byCurrency).toEqual({ JOD: 3_200_000, USD: 10_000 });
    expect(r.payable.rows).toEqual([]);
  });

  test("another supplier's rows, settled rows and cancelled rows are excluded; a dispute stays inside the gross", async () => {
    const s = await seed("filter");
    const other = await addSupplier(s.t, s.orgId, "Other Importer", s.userId);
    await addPayable(s, { supplierId: other });
    await addPayable(s, { status: "PAID", amountPaid: 9_500 });
    await addPayable(s, { status: "CANCELLED" });
    await addPayable(s, { status: "DISPUTED", amountDue: 1_000 });
    const r = await statement(s);
    expect(r.payable.rows).toHaveLength(1);
    expect(r.payable.totals).toEqual([{ currency: "JOD", grossMinor: 1_000_000, disputedMinor: 1_000_000, overdueMinor: 1_000_000 }]);
  });

  test("a partly paid payable shows only the remainder", async () => {
    const s = await seed("part");
    await addPayable(s, { status: "PARTIALLY_PAID", amountPaid: 4_000 });
    const r = await statement(s);
    expect(r.payable.totals[0].grossMinor).toBe(5_500_000);
  });

  test("a section over the read bound reports complete=false and never claims a total", async () => {
    const s = await seed("bound");
    for (let i = 0; i < 101; i += 1) await addPayable(s, { amountDue: 1 });
    const r = await statement(s);
    expect(r.payable.complete).toBe(false);
    expect(r.payable.rows).toHaveLength(100);
    expect(r.receivable.complete).toBe(true);
  });

  test("tenancy and permission: foreign supplier, other org, missing view:finance and a stale clock all refuse", async () => {
    const a = await seed("ta");
    // Same harness instance on purpose: two convexTest instances hand out identical ids.
    const orgB = await a.t.run((ctx) => ctx.db.insert("organizations", { name: "ST other", createdAt: Date.now() }));
    await a.t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId: orgB, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    const supplierB = await addSupplier(a.t, orgB, "Foreign Supplier", a.userId);
    await expect(statement(a, supplierB), "foreign supplier in own org").rejects.toThrow();
    await expect(
      a.asUser.query(api.supplierStatement.outstanding, { orgId: orgB, supplierId: supplierB, nowMs: NOW } as never),
      "other org"
    ).rejects.toThrow();
    const noFinance = await seed("tc", ["view:vehicles"]);
    await expect(statement(noFinance), "no finance").rejects.toThrow();
    await expect(statement(a, a.supplierId, { nowMs: NOW + 5 * DAY }), "stale clock").rejects.toThrow(/nowMs/);
  });
});
