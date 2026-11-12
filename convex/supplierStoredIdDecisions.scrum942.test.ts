/** Shipped-config supplier display, historical decision and recipient regressions. No pilot door is mocked. */
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedSupplier } from "../test-utils/supplierFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ALL_PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
const modules = import.meta.glob("./**/*.*s");
const NOW = Date.parse("2026-11-10T09:00:00Z");
const harnesses: ReturnType<typeof convexTestWithComponents>[] = [];
async function finish() {
  try {
    for (const t of harnesses.splice(0)) await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally { vi.useRealTimers(); }
}
afterEach(finish);

async function seed() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, modules);
  harnesses.push(t);
  const ids = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic local", createdAt: NOW });
    const otherOrgId = await ctx.db.insert("organizations", { name: "Synthetic foreign", createdAt: NOW });
    const userId = await ctx.db.insert("users", { clerkId: "942r4", name: "Operator", email: "942r4@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "Owner", isSystemOwnerRole: true, permissions: ALL_PERMISSIONS });
    await ctx.db.insert("memberships", { orgId, roleId, userId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: NOW, updatedAt: NOW });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, otherOrgId, userId, roleId };
  });
  const supplierId = await seedSupplier(t, { ...ids, displayName: "Synthetic supplier" });
  const rows = await t.run(async ctx => {
    const vehicle = { make: "Protected", model: "Car", year: 2026, vin: "942R4VIN", mileage: 1, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 11, status: "AVAILABLE" as const, sourceType: "STOCK" as const, sourcedSupplierId: supplierId };
    const vehicleId = await ctx.db.insert("vehicles", { ...vehicle, orgId: ids.orgId });
    const foreignVehicleId = await ctx.db.insert("vehicles", { ...vehicle, orgId: ids.otherOrgId, status: "SOLD" });
    const customerId = await ctx.db.insert("customers", { orgId: ids.orgId, firstName: "Local", lastName: "Buyer" });
    const foreignCustomerId = await ctx.db.insert("customers", { orgId: ids.otherOrgId, firstName: "Foreign", lastName: "Secret" });
    const payableId = await ctx.db.insert("vehicleSupplierPayables", { orgId: ids.orgId, vehicleId, supplierId, sourcedFromName: "Synthetic supplier", currency: "JOD", amountDue: 5, status: "PENDING", createdBy: ids.userId, createdAt: NOW, updatedAt: NOW });
    return { vehicleId, foreignVehicleId, customerId, foreignCustomerId, payableId };
  });
  return { t, ...ids, ...rows, supplierId, asUser: t.withIdentity({ subject: "942r4" }) };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function accounting(s: Seed) {
  await s.asUser.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
  await s.asUser.mutation(api.accountingPeriods.create, { orgId: s.orgId, startDate: Date.UTC(2026, 0, 1), endDate: Date.UTC(2026, 11, 31), fiscalYear: 2026, periodNumber: 1 });
  const period = (await s.asUser.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
  if (!period) throw new Error("Missing period");
  await s.asUser.mutation(api.accountingPeriods.open, { orgId: s.orgId, periodId: period._id });
}
beforeAll(async () => {
  try {
    const s = await seed();
    await accounting(s);
    await s.asUser.query(api.sourcingPayables.list, { orgId: s.orgId });
    await s.asUser.query(api.vehicles.get, { orgId: s.orgId, vehicleId: s.vehicleId });
    await import("@testing-library/react");
  } finally { await finish(); }
});

async function views(s: Seed) {
  const args = { orgId: s.orgId };
  const list = await s.asUser.query(api.sourcingPayables.list, args);
  const bounded = await s.asUser.query(api.sourcingPayables.listBounded, args);
  const detail = await s.asUser.query(api.sourcingPayables.get, { ...args, payableId: s.payableId });
  expect(list).toHaveLength(1);
  expect(bounded.complete).toBe(true);
  expect(bounded.items).toEqual(list);
  expect(list[0]).toMatchObject({ _id: s.payableId, amountDue: 5, status: "PENDING", settlementAmountMinor: 5000 });
  expect(detail).toMatchObject({ _id: s.payableId, amountDue: 5, status: "PENDING" });
  return { row: list[0]!, detail };
}

async function display(target: "vehicle" | "sale" | "customer", state: "foreign" | "deleted") {
  const s = await seed();
  const saleId = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "PENDING" }));
  await s.t.run(ctx => ctx.db.patch(s.payableId, { saleId }));
  const live = await views(s);
  expect(live.row).toMatchObject({ vehicleDesc: "2026 Protected Car", vehicleVin: "942R4VIN", customerName: "Local Buyer" });
  expect(live.detail?.vehicle?._id).toBe(s.vehicleId);
  expect(live.detail?.sale?._id).toBe(saleId);
  if (target === "vehicle") {
    if (state === "foreign") await s.t.run(ctx => ctx.db.patch(s.payableId, { vehicleId: s.foreignVehicleId }));
    else {
      await s.asUser.mutation(api.vehicles.softDelete, { orgId: s.orgId, vehicleId: s.vehicleId });
      expect((await s.t.run(ctx => ctx.db.get(s.vehicleId)))?.isDeleted).toBe(true);
    }
  } else if (target === "sale") {
    if (state === "foreign") {
      const foreignSale = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.otherOrgId, vehicleId: s.foreignVehicleId, customerId: s.foreignCustomerId, salespersonId: s.userId, salePrice: 13, saleDate: NOW, status: "PENDING" }));
      await s.t.run(ctx => ctx.db.patch(s.payableId, { saleId: foreignSale }));
    } else {
      await s.asUser.mutation(api.sales.softDelete, { orgId: s.orgId, saleId });
      expect((await s.t.run(ctx => ctx.db.get(saleId)))?.isDeleted).toBe(true);
    }
  } else if (state === "foreign") await s.t.run(ctx => ctx.db.patch(saleId, { customerId: s.foreignCustomerId }));
  else {
    // Delete an unreferenced customer through the real door, then plant the stale stored pointer.
    const deletedCustomerId = await s.t.run(ctx => ctx.db.insert("customers", { orgId: s.orgId, firstName: "Deleted", lastName: "Secret" }));
    await s.asUser.mutation(api.customers.softDelete, { orgId: s.orgId, customerId: deletedCustomerId });
    expect((await s.t.run(ctx => ctx.db.get(deletedCustomerId)))?.isDeleted).toBe(true);
    await s.t.run(ctx => ctx.db.patch(saleId, { customerId: deletedCustomerId }));
  }
  const hidden = await views(s);
  if (target === "vehicle") {
    expect(hidden.row.vehicleDesc).toBe("Unknown Vehicle");
    expect(hidden.row.vehicleVin).toBeUndefined();
    expect(hidden.detail?.vehicle).toBeNull();
  } else {
    expect(hidden.row.customerName).toBeNull();
    expect(hidden.detail?.customerName).toBeNull();
    if (target === "sale") expect(hidden.detail?.sale).toBeNull();
    else expect(hidden.detail?.sale?._id).toBe(saleId);
  }
}
test("sourcing displays hide a foreign vehicle without changing the payable", async () => { await display("vehicle", "foreign"); });
test("sourcing displays hide a deleted vehicle without changing the payable", async () => { await display("vehicle", "deleted"); });
test("sourcing displays hide a foreign sale without changing the payable", async () => { await display("sale", "foreign"); });
test("sourcing displays hide a deleted sale without changing the payable", async () => { await display("sale", "deleted"); });
test("sourcing displays hide a foreign customer without changing the payable", async () => { await display("customer", "foreign"); });
test("sourcing displays hide a deleted customer without changing the payable", async () => { await display("customer", "deleted"); });

async function pipeline(state: "foreign" | "deleted") {
  const s = await seed();
  await s.t.run(async ctx => {
    await ctx.db.patch(s.vehicleId, { sourceType: "SOURCED", sourcedFromName: "Synthetic supplier", sourceCost: 7 });
    await ctx.db.insert("vehicleReservations", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, status: "ACTIVE", reservedBy: s.userId, reservedAt: NOW });
  });
  const live = await s.asUser.query(api.sourcingPayables.listPipeline, { orgId: s.orgId });
  expect(live).toMatchObject([{ _id: s.vehicleId, customerName: "Local Buyer", depositTotal: 0, sourceCost: 7 }]);
  if (state === "deleted") {
    await s.asUser.mutation(api.customers.softDelete, { orgId: s.orgId, customerId: s.customerId });
    expect((await s.t.run(ctx => ctx.db.get(s.customerId)))?.isDeleted).toBe(true);
  } else await s.t.run(async ctx => {
    const reservation = await ctx.db.query("vehicleReservations").first();
    if (!reservation) throw new Error("Missing reservation");
    await ctx.db.patch(reservation._id, { customerId: s.foreignCustomerId });
  });
  expect(await s.asUser.query(api.sourcingPayables.listPipeline, { orgId: s.orgId })).toEqual([{ ...live[0], customerName: null }]);
}
test("sourcing pipeline hides a foreign reservation customer", async () => { await pipeline("foreign"); });
test("sourcing pipeline hides a deleted reservation customer", async () => { await pipeline("deleted"); });

async function payment(s: Seed, door: "markPaid" | "recordPartialPayment", taxAmount?: number) {
  const args = { orgId: s.orgId, payableId: s.payableId, paymentMethod: "CASH" as const, idempotencyKey: "942r4payment" };
  if (door === "markPaid") return await s.asUser.mutation(api.sourcingPayables.markPaid, { ...args, taxAmount });
  return await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, { ...args, amount: 2 });
}
async function foreignPayment(door: "markPaid" | "recordPartialPayment") {
  const s = await seed(); await accounting(s);
  await s.t.run(ctx => ctx.db.patch(s.payableId, { vehicleId: s.foreignVehicleId }));
  const before = await dbSnapshot(s.t, Object.keys(schema.tables));
  await expect(payment(s, door)).rejects.toMatchObject({ data: { code: "SUPPLIER_PAYMENT_REFUSED" } });
  expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
  // An atomic refusal does not poison the command key. Retry with a valid source.
  await s.t.run(ctx => ctx.db.patch(s.payableId, { vehicleId: s.vehicleId }));
  await payment(s, door);
  expect((await s.t.run(ctx => ctx.db.get(s.payableId)))?.amountPaid).toBe(door === "markPaid" ? 5 : 2);
}
test("markPaid refuses a foreign cost origin atomically", async () => { await foreignPayment("markPaid"); });
test("partial payment refuses a foreign cost origin atomically", async () => { await foreignPayment("recordPartialPayment"); });

async function deletedPayment(door: "markPaid" | "recordPartialPayment") {
  const s = await seed(); await accounting(s);
  await s.asUser.mutation(api.vehicles.softDelete, { orgId: s.orgId, vehicleId: s.vehicleId });
  expect((await s.t.run(ctx => ctx.db.get(s.vehicleId)))?.isDeleted).toBe(true);
  const projected = await views(s);
  expect(projected.row.vatReclassAllowed).toBe(true);
  expect(projected.detail?.vatReclassAllowed).toBe(true);
  expect(projected.row.vehicleDesc).toBe("Unknown Vehicle");
  expect(projected.detail?.vehicle).toBeNull();
  await payment(s, door, door === "markPaid" ? 1 : undefined);
  expect(await s.t.run(ctx => ctx.db.get(s.payableId))).toMatchObject({ status: door === "markPaid" ? "PAID" : "PARTIALLY_PAID", amountDue: 5, amountPaid: door === "markPaid" ? 5 : 2 });
  const events = await s.t.run(ctx => ctx.db.query("accountingEvents").collect());
  expect(events.filter(e => e.eventType === "SUPPLIER_PAYMENT_SETTLED")).toMatchObject([{ status: "POSTED", payload: { costOrigin: "VEHICLE_INVENTORY", amountMinor: door === "markPaid" ? 5000 : 2000 } }]);
  const accounts = await s.t.run(ctx => ctx.db.query("chartOfAccounts").collect());
  const account = (key: string) => accounts.find(a => a.systemKey === key)?._id;
  const lines = await s.t.run(ctx => ctx.db.query("journalLines").collect());
  expect(lines.filter(l => l.accountId === account("CASH_ON_HAND")).map(l => l.creditMinor)).toEqual([door === "markPaid" ? 5000 : 2000]);
  if (door === "markPaid") {
    expect(lines.filter(l => l.accountId === account("VAT_RECEIVABLE")).map(l => l.debitMinor)).toEqual([1000]);
    expect(lines.filter(l => l.accountId === account("VEHICLE_INVENTORY")).map(l => l.creditMinor)).toEqual([1000]);
  }
}
test("markPaid keeps deleted local vehicle VAT and cost origin history", async () => { await deletedPayment("markPaid"); });
test("partial payment keeps deleted local vehicle cost origin history", async () => { await deletedPayment("recordPartialPayment"); });

test("markPaid VAT refuses a foreign vehicle with its existing coded reason", async () => {
  const s = await seed(); await accounting(s);
  await s.t.run(ctx => ctx.db.patch(s.payableId, { vehicleId: s.foreignVehicleId }));
  const before = await dbSnapshot(s.t, Object.keys(schema.tables));
  await expect(payment(s, "markPaid", 1)).rejects.toMatchObject({ data: { code: "CONSIGNED_PAYABLE_VAT_REFUSED" } });
  expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
  expect((await views(s)).row.vatReclassAllowed).toBe(false);
});

test("identity repair retains a deleted local sourced vehicle and admits its later receipt", async () => {
  const s = await seed(); await accounting(s);
  const recoveryId = await s.t.run(async ctx => {
    await ctx.db.patch(s.vehicleId, { sourceType: "SOURCED", sourcedFromName: "Synthetic supplier" });
    const saleId = await ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "COMPLETED" });
    return await ctx.db.insert("vehicleSupplierReceivables", { orgId: s.orgId, vehicleId: s.vehicleId, saleId, sourcedFromName: "Synthetic supplier", amountDue: 2, currency: "JOD", status: "OPEN", createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
  });
  await s.asUser.mutation(api.vehicles.softDelete, { orgId: s.orgId, vehicleId: s.vehicleId });
  expect((await s.t.run(ctx => ctx.db.get(s.vehicleId)))?.isDeleted).toBe(true);
  const result = await s.t.mutation(internal.supplierIdentityRepair.repairPage, { orgId: s.orgId, phase: "RECEIVABLES", cursor: null });
  expect(result).toMatchObject({ examined: 1, repaired: 1, unresolved: 0 });
  expect((await s.t.run(ctx => ctx.db.get(recoveryId)))?.supplierId).toBe(s.supplierId);
  await s.asUser.mutation(api.supplierReceivables.recordReceipt, { orgId: s.orgId, receivableId: recoveryId, amount: 1, receiptMethod: "CASH", receivedAt: NOW, idempotencyKey: "942r4receipt" });
  expect(await s.t.run(ctx => ctx.db.get(recoveryId))).toMatchObject({ amountDue: 2, amountReceived: 1, status: "PARTIALLY_PAID" });
});

async function roleAlert(owner: boolean, deleted: boolean) {
  const s = await seed();
  await s.t.run(async ctx => {
    await ctx.db.patch(s.roleId, { name: owner ? "Owner" : "Custom finance", isSystemOwnerRole: owner, isDeleted: deleted, permissions: owner ? [] : ["view:finance", "view:cost_price"] });
    await ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, vehicleId: s.vehicleId, expenseId: await ctx.db.insert("expenses", { orgId: s.orgId, title: "Synthetic", amount: 2, date: NOW, category: "TRANSPORT" }), supplierId: s.supplierId, sourcedFromName: "Synthetic supplier", amountDueMinor: 2000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, sourceEventKey: "942r4cost", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, agreedDueDate: NOW });
  });
  expect(await s.t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, kind: "RECOVERY", now: NOW })).toEqual({ alerted: deleted ? 0 : 1, skipped: 0 });
  const notifications = await s.t.run(ctx => ctx.db.query("notifications").collect());
  expect(notifications.map(n => n.userId)).toEqual(deleted ? [] : [s.userId]);
}
test("supplier alerts exclude a deleted system Owner role", async () => { await roleAlert(true, true); });
test("supplier alerts include a live system Owner role", async () => { await roleAlert(true, false); });
test("supplier alerts exclude a deleted custom finance role", async () => { await roleAlert(false, true); });
test("supplier alerts include a live custom finance role", async () => { await roleAlert(false, false); });

test("sourcing readers reuse their existing target reads without writes", async () => {
  const s = await seed();
  const saleId = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "PENDING" }));
  await s.t.run(ctx => ctx.db.patch(s.payableId, { saleId }));
  const sourcing = await import("./sourcingPayables");
  for (const [label, registered, args, targets] of [
    ["list", sourcing.list, { orgId: s.orgId }, [s.vehicleId, saleId, s.customerId]],
    ["listBounded", sourcing.listBounded, { orgId: s.orgId }, [s.vehicleId, saleId, s.customerId]],
    ["get", sourcing.get, { orgId: s.orgId, payableId: s.payableId }, [s.vehicleId, saleId, s.customerId]],
    ["listPipeline", sourcing.listPipeline, { orgId: s.orgId }, []],
  ] as const) {
    const callable: unknown = registered;
    if (typeof callable !== "function" || !("_handler" in callable) || typeof callable._handler !== "function") throw new Error("Registered handler unavailable");
    const handler = callable._handler;
    await s.asUser.run(async ctx => {
      const get = vi.spyOn(ctx.db, "get");
      const insert = vi.spyOn(ctx.db, "insert");
      const patch = vi.spyOn(ctx.db, "patch");
      const replace = vi.spyOn(ctx.db, "replace");
      const remove = vi.spyOn(ctx.db, "delete");
      try {
        // Call through the registered production query inside its real authenticated DB context.
        const response: unknown = await handler(ctx, args);
        expect(response).toBeDefined();
        const readIds = get.mock.calls.map((call: readonly unknown[]) => String(call.length === 2 ? call[1] : call[0]));
        const writes = insert.mock.calls.length + patch.mock.calls.length + replace.mock.calls.length + remove.mock.calls.length;
        expect(targets.map(id => readIds.filter(readId => readId === id).length)).toEqual(targets.map(() => 1));
        expect(writes).toBe(0);
        console.info("SCRUM942_IO " + JSON.stringify({ reader: "sourcing." + label, gets: readIds.length, writes }));
      } finally { get.mockRestore(); insert.mockRestore(); patch.mockRestore(); replace.mockRestore(); remove.mockRestore(); }
    });
  }
});
