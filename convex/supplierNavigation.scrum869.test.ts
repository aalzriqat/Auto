import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
const NOW = Date.parse("2026-11-10T09:00:00Z");
const vehicles = makeFunctionReference<"query">("supplierRelationships:vehicles");
afterEach(() => vi.useRealTimers());

async function seed(permissions = ["view:finance", "view:cost_price", "view:vehicles", "view:sales", "view:expenses", "manage:finance"]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, modules);
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

describe("supplier navigation by canonical id", () => {
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
    expect(page).toEqual({ page: [{ vehicleId: s.vehicleId, label: "2024 Toyota Camry", model: "SOURCED", status: "AVAILABLE", href: null }], isDone: true, continueCursor: expect.any(String), pageStatus: null, splitCursor: null });
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
    await payable(s); // A SOURCED vehicle's payable must not become an owned relationship.
    expect((await related(s, "OWNED")).page).toEqual([]);
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "STOCK", sourcedSupplierId: undefined, status: "SOLD" }));
    expect((await related(s, "OWNED")).page).toEqual([{ vehicleId: s.vehicleId, label: "2024 Toyota Camry", model: "OWNED_ON_ACCOUNT", status: "SOLD", href: `/${s.orgId}/vehicles?supplierVehicleId=${s.vehicleId}` }]);
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

  test("invalid stored money returns a coded generic error without exposing technical detail", async () => {
    const s = await seed();
    await payable(s, { amountDue: Number.NaN });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(outstanding(s)).rejects.toThrow(/SUPPLIER_NAVIGATION_UNAVAILABLE/);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
