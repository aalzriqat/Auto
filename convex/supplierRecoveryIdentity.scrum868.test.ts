import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { renameSupplier, seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { fromMinorUnits } from "./utils/money";

const modules = import.meta.glob("./**/*.ts");
const tables = Object.keys(schema.tables);

// Freeze the scheduler clock so pre-existing jobs cannot change state while
// a refusal's no-write snapshot is measured. No application module is mocked.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function setup() {
  const t = convexTestWithComponents(schema, modules);
  registerRateLimiter(t);
  const orgId = await t.run(ctx => ctx.db.insert("organizations", { name: "P4a", createdAt: Date.now() }));
  const userId = await t.run(ctx => ctx.db.insert("users", { clerkId: "p4a", email: "p4a@example.test", name: "Owner" }));
  await t.run(async ctx => {
    const roleId = await ctx.db.insert("roles", { orgId, name: "Owner", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
  });
  const owner = t.withIdentity({ subject: "p4a", clerkId: "p4a" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const supplierId = await seedSupplier(t, { orgId, userId, displayName: "Canonical supplier", version: 3 });
  const vehicleId = await t.run(ctx => ctx.db.insert("vehicles", {
    orgId, vin: "P4A-CAR", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
    color: "White", fuelType: "Gas", transmission: "Auto", status: "AVAILABLE",
    sellingPrice: fromMinorUnits(12500000, "JOD"), sourceType: "SOURCED",
    sourceCost: fromMinorUnits(9500000, "JOD"), sourcedFromName: "Intake snapshot", sourcedSupplierId: supplierId,
  }));
  const args = {
    orgId, vehicleId, vendorSupplierId: supplierId, title: "Supplier transport", amount: fromMinorUnits(200000, "JOD"),
    date: Date.now() - 60000, category: "TRANSPORT" as const, status: "PAID" as const,
    costBearer: "SUPPLIER" as const, paymentMethod: "CASH" as const, idempotencyKey: "p4a-cost",
  };
  return { t, orgId, userId, owner, supplierId, vehicleId, args };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function expectIdentityRefusal(s: Setup, call: () => Promise<unknown>) {
  const before = await dbSnapshot(s.t, tables);
  const scheduledBefore = await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  await expect(call()).rejects.toMatchObject({ data: { code: "SUPPLIER_IDENTITY_UNRESOLVED" } });
  expect(await dbSnapshot(s.t, tables)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduledBefore);
}

describe("SCRUM-868 P4a canonical recovery identity", () => {
  test.each(["PENDING", "PAID"] as const)("%s creation refuses a name-only supplier with no partial state", async status => {
    const s = await setup();
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourcedSupplierId: undefined }));
    await expectIdentityRefusal(s, () => s.owner.mutation(api.expenses.create, { ...s.args, status }));
  });

  test("creation with neither id nor name still returns the coded identity refusal", async () => {
    const s = await setup();
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourcedSupplierId: undefined, sourcedFromName: undefined }));
    await expectIdentityRefusal(s, () => s.owner.mutation(api.expenses.create, s.args));
  });

  test.each(["foreign", "missing"] as const)("creation refuses a %s supplier id without partial state", async kind => {
    const s = await setup();
    await s.t.run(async ctx => {
      if (kind === "foreign") {
        const otherOrg = await ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() });
        await ctx.db.patch(s.supplierId, { orgId: otherOrg });
      } else {
        await ctx.db.delete(s.supplierId);
      }
    });
    await expectIdentityRefusal(s, () => s.owner.mutation(api.expenses.create, s.args));
  });

  test.each(["bearer edit", "vehicle edit", "pending edit", "payment"] as const)("%s rechecks the effective supplier before any write", async door => {
    const s = await setup();
    const expenseId = await s.owner.mutation(api.expenses.create, {
      ...s.args, status: "PENDING", costBearer: door === "bearer edit" ? "SHOWROOM" : "SUPPLIER",
      vendorSupplierId: door === "bearer edit" ? undefined : s.supplierId,
    });
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourcedSupplierId: undefined }));
    await expectIdentityRefusal(s, () => s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId, vendorSupplierId: s.supplierId,
      ...(door === "bearer edit" ? { costBearer: "SUPPLIER" as const } : {}),
      ...(door === "vehicle edit" ? { vehicleId: s.vehicleId } : {}),
      ...(door === "pending edit" ? { title: "Edited supplier transport" } : {}),
      ...(door === "payment" ? { status: "PAID" as const } : {}),
    }));
  });

  test.each(["create", "pay pending"] as const)("%s stores the canonical id and one master snapshot without an intake name", async door => {
    const s = await setup();
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourcedFromName: undefined }));
    const expenseId = await s.owner.mutation(api.expenses.create, { ...s.args, status: door === "create" ? "PAID" : "PENDING" });
    if (door === "pay pending") {
      await s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId, vendorSupplierId: s.supplierId, status: "PAID" });
    }
    const recovery = await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique());
    expect(recovery).toMatchObject({
      expenseId, supplierId: s.supplierId, sourcedFromName: "Canonical supplier", supplierSnapshotVersion: 3,
      amountDueMinor: 200000, amountRecoveredMinor: 0, receiptSeq: 0, status: "OPEN", currency: "JOD",
    });
    const lines = await s.t.run(ctx => ctx.db.query("journalLines").collect());
    expect(lines.map(line => [line.debitMinor, line.creditMinor]).sort()).toEqual([[0, 200000], [200000, 0]]);
  });

  test("retry preserves the first canonical snapshot and creates no second money effect", async () => {
    const s = await setup();
    const first = await s.owner.mutation(api.expenses.create, s.args);
    await renameSupplier(s.t, s.supplierId, "Renamed supplier");
    const before = await dbSnapshot(s.t, tables);
    expect(await s.owner.mutation(api.expenses.create, s.args)).toBe(first);
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
    expect(await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique())).toMatchObject({
      supplierId: s.supplierId, sourcedFromName: "Canonical supplier", supplierSnapshotVersion: 3, amountDueMinor: 200000,
    });
  });

  test("an inactive linked supplier remains serviceable under the existing completion policy", async () => {
    const s = await setup();
    const expenseId = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING" });
    await s.t.run(ctx => ctx.db.patch(s.supplierId, { status: "INACTIVE" }));
    await s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId, vendorSupplierId: s.supplierId, status: "PAID" });
    expect(await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique())).toMatchObject({
      supplierId: s.supplierId, sourcedFromName: "Canonical supplier", supplierSnapshotVersion: 3, amountDueMinor: 200000,
    });
  });

  test("receipt advancement refuses an id-less recovery and a foreign stored supplier", async () => {
    const s = await setup();
    await s.owner.mutation(api.expenses.create, s.args);
    const recovery = await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique());
    if (!recovery || recovery.origin === "OPENING") throw new Error("native recovery fixture missing");
    const receiptArgs = { orgId: s.orgId, recoveryId: recovery._id, amountMinor: 80000, method: "CASH" as const, receivedDate: Date.now(), idempotencyKey: "p4a-receipt" };
    await s.t.run(ctx => ctx.db.patch(recovery._id, { supplierId: undefined }));
    await expectIdentityRefusal(s, () => s.owner.mutation(api.supplierCostRecoveries.recordReceipt, receiptArgs));
    await s.t.run(async ctx => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Foreign", createdAt: Date.now() });
      await ctx.db.patch(s.supplierId, { orgId: otherOrg });
      await ctx.db.patch(recovery._id, { supplierId: s.supplierId });
    });
    await expectIdentityRefusal(s, () => s.owner.mutation(api.supplierCostRecoveries.recordReceipt, receiptArgs));
  });

  test("terminal legacy recovery with a missing vehicle remains readable and is never rewritten", async () => {
    const s = await setup();
    await s.owner.mutation(api.expenses.create, s.args);
    const recovery = await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique());
    if (!recovery || recovery.origin === "OPENING") throw new Error("native recovery fixture missing");
    await s.t.run(async ctx => {
      await ctx.db.patch(recovery._id, { supplierId: undefined, supplierSnapshotVersion: undefined, sourcedFromName: "Legacy supplier", status: "RECOVERED", amountRecoveredMinor: 200000 });
      await ctx.db.delete(s.vehicleId);
    });
    const before = await dbSnapshot(s.t, tables);
    for (let read = 0; read < 2; read += 1) {
      const result = await s.owner.query(api.supplierCostRecoveries.list, { orgId: s.orgId });
      expect(result).toMatchObject({ complete: true, items: [{
        _id: recovery._id, sourcedFromName: "Legacy supplier", amountDueMinor: 200000,
        amountRecoveredMinor: 200000, remainingMinor: 0, status: "RECOVERED", vehicleLabel: null,
      }] });
    }
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
    expect(await s.owner.mutation(api.expenses.create, s.args)).toBe(recovery.expenseId);
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
  });
});
