/** Shipped-config supplier display, historical decision and recipient regressions. No pilot door is mocked. */
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedSupplier } from "../test-utils/supplierFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { ownedSupplierDocument, supplierDecisionDocument } from "./utils/supplierDocumentOwnership";
import type { Id } from "./_generated/dataModel";

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

async function seed(literalDisplayTimestamp = false) {
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
    // A fresh clock tick makes the display fixture's generated timestamp literal.
    if (literalDisplayTimestamp) vi.setSystemTime(NOW + 10_000);
    const vehicleId = await ctx.db.insert("vehicles", { ...vehicle, orgId: ids.orgId });
    if (literalDisplayTimestamp) vi.setSystemTime(NOW);
    const foreignVehicleId = await ctx.db.insert("vehicles", { ...vehicle, orgId: ids.otherOrgId, make: "Foreign", model: "Sentinel", vin: "942-FOREIGN-VIN", sellingPrice: 97, status: "SOLD" });
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
    await Promise.all([import("./sales"), import("./customers")]);
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
  return { row: list[0]!, boundedRow: bounded.items[0]!, detail };
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
      // A local downstream customer makes the sale boundary independently observable.
      const foreignSale = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.otherOrgId, vehicleId: s.foreignVehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 13, saleDate: NOW, status: "PENDING" }));
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
  for (const [surface, row] of [["list", hidden.row], ["listBounded", hidden.boundedRow]] as const) {
    expect({ vehicleDesc: row.vehicleDesc, vehicleVin: row.vehicleVin, customerName: row.customerName }, surface)
      .toStrictEqual(target === "vehicle"
        ? { vehicleDesc: "Unknown Vehicle", vehicleVin: undefined, customerName: "Local Buyer" }
        : { vehicleDesc: "2026 Protected Car", vehicleVin: "942R4VIN", customerName: null });
  }
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
  const hidden = await s.asUser.query(api.sourcingPayables.listPipeline, { orgId: s.orgId });
  expect(hidden).toHaveLength(1);
  expect(hidden[0]).toMatchObject({
    _id: s.vehicleId, vehicleDesc: "2026 Protected Car", vin: "942R4VIN", status: "AVAILABLE",
    arrivedAt: null, hasArrived: false, isHeld: false, sourcedFromName: "Synthetic supplier",
    sourceCost: 7, sellingPrice: 11, customerName: null, depositTotal: 0,
  });
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

async function originControl(kind: "missing" | "sale" | "sold") {
  for (const door of ["markPaid", "recordPartialPayment"] as const) {
    const s = await seed(); await accounting(s);
    await s.t.run(async ctx => {
      if (kind === "missing") await ctx.db.delete(s.vehicleId); // Historical absent target; no public hard-delete door.
      else if (kind === "sold") await ctx.db.patch(s.vehicleId, { status: "SOLD" });
      else {
        const saleId = await ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "COMPLETED" });
        // This branch never consumes vehicle status for posting; the sale defines its COGS origin.
        await ctx.db.patch(s.payableId, { saleId, vehicleId: s.foreignVehicleId });
      }
    });
    await payment(s, door);
    const events = await s.t.run(ctx => ctx.db.query("accountingEvents").collect());
    expect(events.filter(e => e.eventType === "SUPPLIER_PAYMENT_SETTLED")).toMatchObject([{ status: "POSTED", payload: { costOrigin: kind === "missing" ? "VEHICLE_INVENTORY" : "COGS", amountMinor: door === "markPaid" ? 5000 : 2000 } }]);
  }
}
test("supplier payments preserve main missing vehicle fallback", async () => { await originControl("missing"); });
test("sale-linked supplier payments retain COGS without consuming vehicle status", async () => { await originControl("sale"); });
test("sold local supplier payments retain their historical COGS origin", async () => { await originControl("sold"); });

test("identity repair preserves the foreign vehicle reason and leaves identity absent", async () => {
  const s = await seed();
  const claimId = await s.t.run(async ctx => {
    await ctx.db.patch(s.foreignVehicleId, { sourceType: "SOURCED" });
    const saleId = await ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "COMPLETED" });
    return await ctx.db.insert("vehicleSupplierReceivables", { orgId: s.orgId, vehicleId: s.foreignVehicleId, saleId, sourcedFromName: "Synthetic supplier", amountDue: 2, currency: "JOD", status: "OPEN", createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
  });
  expect(await s.t.mutation(internal.supplierIdentityRepair.repairPage, { orgId: s.orgId, phase: "RECEIVABLES", cursor: null })).toMatchObject({ examined: 1, repaired: 0, unresolved: 1, byReason: { VEHICLE_OTHER_ORG: 1, NO_VEHICLE: 0 } });
  expect((await s.t.run(ctx => ctx.db.get(claimId)))?.supplierId).toBeUndefined();
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
  await s.t.run(async ctx => {
    await ctx.db.patch(s.vehicleId, { sourceType: "SOURCED", sourcedFromName: "Synthetic supplier", sourceCost: 7 });
    await ctx.db.insert("vehicleReservations", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, status: "ACTIVE", reservedBy: s.userId, reservedAt: NOW });
  });
  const saleId = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "PENDING" }));
  await s.t.run(ctx => ctx.db.patch(s.payableId, { saleId }));
  const sourcing = await import("./sourcingPayables");
  for (const [label, registered, args, targets] of [
    ["list", sourcing.list, { orgId: s.orgId }, [s.vehicleId, saleId, s.customerId]],
    ["listBounded", sourcing.listBounded, { orgId: s.orgId }, [s.vehicleId, saleId, s.customerId]],
    ["get", sourcing.get, { orgId: s.orgId, payableId: s.payableId }, [s.vehicleId, saleId, s.customerId]],
    ["listPipeline", sourcing.listPipeline, { orgId: s.orgId }, [s.customerId]],
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
        if (label === "listPipeline") expect(response).toMatchObject([{ _id: s.vehicleId, customerName: "Local Buyer" }]);
        const readIds = get.mock.calls.map((call: readonly unknown[]) => String(call[1] === undefined ? call[0] : call[1]));
        const writes = insert.mock.calls.length + patch.mock.calls.length + replace.mock.calls.length + remove.mock.calls.length;
        expect(targets.map(id => readIds.filter(readId => readId === id).length)).toEqual(targets.map(() => 1));
        expect(writes).toBe(0);
        console.info("SCRUM942_IO " + JSON.stringify({ reader: "sourcing." + label, gets: readIds.length, writes }));
      } finally { get.mockRestore(); insert.mockRestore(); patch.mockRestore(); replace.mockRestore(); remove.mockRestore(); }
    });
  }
});

async function sampleIo(s: Seed, registered: unknown, args: unknown, label: string) {
  if (typeof registered !== "function" || !("_handler" in registered) || typeof registered._handler !== "function") throw new Error("Registered handler unavailable");
  const handler = registered._handler;
  return await s.asUser.run(async ctx => {
    const get = vi.spyOn(ctx.db, "get"), insert = vi.spyOn(ctx.db, "insert"), patch = vi.spyOn(ctx.db, "patch");
    const replace = vi.spyOn(ctx.db, "replace"), remove = vi.spyOn(ctx.db, "delete");
    try {
      const response: unknown = await handler(ctx, args);
      const ids = get.mock.calls.map((call: readonly unknown[]) => String(call[1] === undefined ? call[0] : call[1]));
      const writes = insert.mock.calls.length + patch.mock.calls.length + replace.mock.calls.length + remove.mock.calls.length;
      console.info("SCRUM942_IO " + JSON.stringify({ reader: label, gets: ids.length, writes, vehicleGets: ids.filter(id => id === s.vehicleId).length, customerGets: ids.filter(id => id === s.customerId).length }));
      return { response, ids, writes };
    } finally { get.mockRestore(); insert.mockRestore(); patch.mockRestore(); replace.mockRestore(); remove.mockRestore(); }
  });
}

test("supplier payment decisions reuse their existing vehicle reads", async () => {
  const sourcing = await import("./sourcingPayables");
  for (const door of ["markPaid", "recordPartialPayment"] as const) {
    const s = await seed(); await accounting(s);
    const args = { orgId: s.orgId, payableId: s.payableId, paymentMethod: "CASH", idempotencyKey: "942r4io", ...(door === "markPaid" ? { taxAmount: 1 } : { amount: 2 }) };
    const measured = await sampleIo(s, sourcing[door], args, "sourcing." + door);
    // Full VAT settlement also revalidates the vehicle in the posting engine (SCRUM-782).
    expect(measured.ids.filter(id => id === s.vehicleId)).toHaveLength(door === "markPaid" ? 3 : 1);
    expect(measured.writes).toBeGreaterThan(0);
    expect(await s.t.run(ctx => ctx.db.get(s.payableId))).toMatchObject({ amountPaid: door === "markPaid" ? 5 : 2, status: door === "markPaid" ? "PAID" : "PARTIALLY_PAID" });
  }
});

test("deleted sale display read budgets preserve the payable without writes", async () => {
  const s = await seed();
  const saleId = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "PENDING" }));
  await s.t.run(ctx => ctx.db.patch(s.payableId, { saleId }));
  await s.asUser.mutation(api.sales.softDelete, { orgId: s.orgId, saleId });
  const sourcing = await import("./sourcingPayables");
  for (const door of ["list", "listBounded", "get"] as const) {
    const measured = await sampleIo(s, sourcing[door], { orgId: s.orgId, ...(door === "get" ? { payableId: s.payableId } : {}) }, "sourcing." + door + ".deletedSale");
    expect(measured.ids.filter(id => id === s.vehicleId)).toHaveLength(1);
    expect(measured.ids.filter(id => id === saleId)).toHaveLength(1);
    // The budget allows main's one customer get; the main/candidate experiment measures its removal.
    expect(measured.ids.filter(id => id === s.customerId).length).toBeLessThanOrEqual(1);
    expect(measured.writes).toBe(0);
    if (door === "get") expect(measured.response).toMatchObject({ _id: s.payableId, amountDue: 5 });
    else if (door === "list") expect(measured.response).toMatchObject([{ _id: s.payableId, amountDue: 5 }]);
    else expect(measured.response).toMatchObject({ complete: true, items: [{ _id: s.payableId, amountDue: 5 }] });
  }
});

// Literal oracle: ADR 2026-11-10 and SCRUM-781. All five surfaces consume each row.
// Partial payment has no VAT argument: VAT credit is inapplicable on that door.
const decisionMatrix = {
  live: { list: true, listBounded: true, get: true, vat: true, origin: "VEHICLE_INVENTORY", refused: false, vehicle: "local", vehicleDesc: "2026 Protected Car", vehicleVin: "942R4VIN" },
  deletedUnsold: { list: true, listBounded: true, get: true, vat: true, origin: "VEHICLE_INVENTORY", refused: false, vehicle: null, vehicleDesc: "Unknown Vehicle", vehicleVin: undefined },
  deletedSold: { list: true, listBounded: true, get: true, vat: true, origin: "COGS", refused: false, vehicle: null, vehicleDesc: "Unknown Vehicle", vehicleVin: undefined },
  deletedSourced: { list: false, listBounded: false, get: false, vat: false, origin: "VEHICLE_INVENTORY", refused: false, vehicle: null, vehicleDesc: "Unknown Vehicle", vehicleVin: undefined },
  foreignSold: { list: false, listBounded: false, get: false, vat: false, origin: null, refused: true, vehicle: null, vehicleDesc: "Unknown Vehicle", vehicleVin: undefined },
  foreignUnsold: { list: false, listBounded: false, get: false, vat: false, origin: null, refused: true, vehicle: null, vehicleDesc: "Unknown Vehicle", vehicleVin: undefined },
  missing: { list: false, listBounded: false, get: false, vat: false, origin: "VEHICLE_INVENTORY", refused: false, vehicle: null, vehicleDesc: "Unknown Vehicle", vehicleVin: undefined },
} as const;
type DecisionState = keyof typeof decisionMatrix;

async function decisionFixture(state: DecisionState) {
  const s = await seed();
  await accounting(s);
  if (state === "missing") await s.t.run(ctx => ctx.db.delete(s.vehicleId));
  else if (state === "foreignSold" || state === "foreignUnsold") {
    await s.t.run(async ctx => {
      await ctx.db.patch(s.foreignVehicleId, { status: state === "foreignSold" ? "SOLD" : "AVAILABLE" });
      await ctx.db.patch(s.payableId, { vehicleId: s.foreignVehicleId });
    });
  } else if (state !== "live") {
    await s.asUser.mutation(api.vehicles.softDelete, { orgId: s.orgId, vehicleId: s.vehicleId });
    // SOLD + deleted is retained historical data; the public delete door refuses SOLD.
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, {
      status: state === "deletedSold" ? "SOLD" : "AVAILABLE",
      sourceType: state === "deletedSourced" ? "SOURCED" : "STOCK",
    }));
    expect((await s.t.run(ctx => ctx.db.get(s.vehicleId)))?.isDeleted).toBe(true);
  }
  return s;
}

async function assertDecisionViews(s: Seed, expected: (typeof decisionMatrix)[DecisionState]) {
  const args = { orgId: s.orgId };
  const list = await s.asUser.query(api.sourcingPayables.list, args);
  const bounded = await s.asUser.query(api.sourcingPayables.listBounded, args);
  const detail = await s.asUser.query(api.sourcingPayables.get, { ...args, payableId: s.payableId });
  expect(list).toMatchObject([{ _id: s.payableId, amountDue: 5, settlementAmountMinor: 5000, vatReclassAllowed: expected.list }]);
  expect(bounded).toMatchObject({ complete: true, items: [{ _id: s.payableId, amountDue: 5, settlementAmountMinor: 5000, vatReclassAllowed: expected.listBounded }] });
  expect(detail).toMatchObject({ _id: s.payableId, amountDue: 5, vatReclassAllowed: expected.get });
  // Display liveness is independent of the historical money decisions above.
  // The oracle is fixture literals, not a document read back through the join.
  const expectedVehicle = expected.vehicle === "local" ? {
    _id: s.vehicleId, orgId: s.orgId,
    make: "Protected", model: "Car", year: 2026, vin: "942R4VIN",
    mileage: 1, color: "White", fuelType: "Gas", transmission: "Auto",
    sellingPrice: 11, status: "AVAILABLE", sourceType: "STOCK", sourcedSupplierId: s.supplierId,
  } : null;
  // convex-test assigns a fractional system timestamp; it is not display data.
  const vehicle = detail?.vehicle;
  const vehicleFields = vehicle ? (({ _creationTime, ...fields }) => {
    expect(_creationTime).toBeTypeOf("number");
    return fields;
  })(vehicle) : vehicle;
  expect({ vehicle: vehicleFields, sale: detail?.sale, customerName: detail?.customerName }, "get display")
    .toStrictEqual({ vehicle: expectedVehicle, sale: null, customerName: null });
  const expectedDisplay = [{ vehicleDesc: expected.vehicleDesc, vehicleVin: expected.vehicleVin, customerName: null }];
  expect(list.map(row => ({ vehicleDesc: row.vehicleDesc, vehicleVin: row.vehicleVin, customerName: row.customerName })), "list display")
    .toStrictEqual(expectedDisplay);
  expect(bounded.items.map(row => ({ vehicleDesc: row.vehicleDesc, vehicleVin: row.vehicleVin, customerName: row.customerName })), "listBounded display")
    .toStrictEqual(expectedDisplay);
}

async function assertRefusal(s: Seed, door: "markPaid" | "recordPartialPayment", code: string, tax?: number) {
  const before = await dbSnapshot(s.t, Object.keys(schema.tables));
  await expect(payment(s, door, tax)).rejects.toMatchObject({ data: { code } });
  expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
}

async function assertDecisionPosting(s: Seed, door: "markPaid" | "recordPartialPayment", state: DecisionState) {
  const expected = decisionMatrix[state];
  const tax = door === "markPaid" && expected.vat ? 1 : undefined;
  const first = await payment(s, door, tax);
  const posted = await dbSnapshot(s.t, Object.keys(schema.tables));
  expect(await payment(s, door, tax)).toEqual(first);
  expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(posted);
  const amountMinor = door === "markPaid" ? 5000 : 2000;
  expect(await s.t.run(ctx => ctx.db.get(s.payableId))).toMatchObject({
    amountDue: 5, amountPaid: door === "markPaid" ? 5 : 2,
    status: door === "markPaid" ? "PAID" : "PARTIALLY_PAID", paymentSeq: 1,
  });
  const events = await s.t.run(ctx => ctx.db.query("accountingEvents").collect());
  expect(events.filter(e => e.eventType === "SUPPLIER_PAYMENT_SETTLED")).toMatchObject([
    { status: "POSTED", eventVersion: 1, payload: { costOrigin: expected.origin, amountMinor, currency: "JOD" } },
  ]);
  const accounts = await s.t.run(ctx => ctx.db.query("chartOfAccounts").collect());
  const lines = await s.t.run(ctx => ctx.db.query("journalLines").collect());
  const credit = (key: string) => lines.filter(l => l.accountId === accounts.find(a => a.systemKey === key)?._id).map(l => l.creditMinor);
  expect(credit("CASH_ON_HAND")).toEqual([amountMinor]);
  const payableAccount = accounts.find(a => a.systemKey === "ACCOUNTS_PAYABLE_SUPPLIERS");
  expect(lines.filter(l => l.accountId === payableAccount?._id).map(l => l.debitMinor)).toEqual([amountMinor]);
  if (tax) {
    expect(events[0]?.payload).toMatchObject({ taxMinor: 1000 });
    expect(credit(expected.origin === "COGS" ? "COST_OF_VEHICLES_SOLD" : "VEHICLE_INVENTORY")).toEqual([1000]);
    expect(credit(expected.origin === "COGS" ? "VEHICLE_INVENTORY" : "COST_OF_VEHICLES_SOLD")).toEqual([]);
    const vat = accounts.find(a => a.systemKey === "VAT_RECEIVABLE");
    expect(lines.filter(l => l.accountId === vat?._id).map(l => l.debitMinor)).toEqual([1000]);
  } else {
    expect(credit("COST_OF_VEHICLES_SOLD")).toEqual([]);
    expect(credit("VEHICLE_INVENTORY")).toEqual([]);
  }
}

async function decisionCell(state: DecisionState) {
  const expected = decisionMatrix[state];
  // Two isolated fixtures per state, rather than one per reader/command cell.
  for (const door of ["markPaid", "recordPartialPayment"] as const) {
    const s = await decisionFixture(state);
    await assertDecisionViews(s, expected);
    if (door === "markPaid" && !expected.vat) await assertRefusal(s, door, "CONSIGNED_PAYABLE_VAT_REFUSED", 1);
    if (expected.refused) {
      await assertRefusal(s, door, "SUPPLIER_PAYMENT_REFUSED");
      // Refusal must leave the same key usable after the stored pointer is repaired.
      await s.t.run(ctx => ctx.db.patch(s.payableId, { vehicleId: s.vehicleId }));
      await assertDecisionPosting(s, door, "live");
    } else await assertDecisionPosting(s, door, state);
  }
}

test("supplier decision matrix live vehicle agrees on all five surfaces", async () => { await decisionCell("live"); });
test("supplier decision matrix deleted local unsold agrees on all five surfaces", async () => { await decisionCell("deletedUnsold"); });
test("supplier decision matrix deleted local SOLD agrees on all five surfaces", async () => { await decisionCell("deletedSold"); });
test("supplier decision matrix deleted local SOURCED refuses VAT on all surfaces", async () => { await decisionCell("deletedSourced"); });
test("supplier decision matrix foreign SOLD refuses on all five surfaces", async () => { await decisionCell("foreignSold"); });
test("supplier decision matrix foreign unsold refuses on all five surfaces", async () => { await decisionCell("foreignUnsold"); });
test("supplier decision matrix missing vehicle preserves the explicit fallback", async () => { await decisionCell("missing"); });

function ownershipContract(predicate: typeof ownedSupplierDocument, deleted: "absent" | "history") {
  const orgId = "local" as Id<"organizations">;
  for (const doc of [null, { orgId: null }, { orgId: undefined }, {}, { orgId: "foreign" }]) {
    expect(predicate(doc, orgId)).toBeNull();
  }
  const live = { orgId };
  const historical = { orgId, isDeleted: true };
  expect(predicate(live, orgId)).toBe(live);
  expect(predicate(historical, orgId)).toBe(deleted === "history" ? historical : null);
}
test("supplier display ownership fails closed for null undefined missing and foreign organizations", () => { ownershipContract(ownedSupplierDocument, "absent"); });
test("supplier decision ownership fails closed for invalid organizations and retains deleted history", () => { ownershipContract(supplierDecisionDocument, "history"); });

// Display policy is independent of the history/posting oracle above (ADR SCRUM-942).
// A competing local document and a newer foreign document distinguish source selection.
async function displaySeed() {
  const s = await seed(true);
  const joined = await s.t.run(async ctx => {
    const otherCustomerId = await ctx.db.insert("customers", { orgId: s.orgId, firstName: "Competing", lastName: "Customer" });
    const otherVehicleId = await ctx.db.insert("vehicles", { orgId: s.orgId, make: "Competing", model: "Local", year: 2024, vin: "942-LOCAL-SENTINEL", mileage: 2, color: "Blue", fuelType: "Gas", transmission: "Auto", sellingPrice: 73, status: "AVAILABLE", sourceType: "STOCK" });
    vi.setSystemTime(NOW + 20_000);
    const saleId = await ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "PENDING" });
    vi.setSystemTime(NOW);
    await ctx.db.insert("sales", { orgId: s.orgId, vehicleId: otherVehicleId, customerId: otherCustomerId, salespersonId: s.userId, salePrice: 73, saleDate: NOW - 2000, status: "CANCELLED" });
    await ctx.db.insert("sales", { orgId: s.otherOrgId, vehicleId: s.foreignVehicleId, customerId: s.foreignCustomerId, salespersonId: s.userId, salePrice: 97, saleDate: NOW - 3000, status: "COMPLETED" });
    await ctx.db.patch(s.payableId, { saleId });
    return { saleId };
  });
  return { ...s, ...joined };
}

type DisplaySeed = Awaited<ReturnType<typeof displaySeed>>;
type DisplayState = DecisionState | "liveSold" | "liveSourced";
const displayVehicleOracle = {
  live: { visible: true, status: "AVAILABLE", sourceType: "STOCK", description: "2026 Protected Car", vin: "942R4VIN" },
  deletedUnsold: { visible: false, status: "AVAILABLE", sourceType: "STOCK", description: "Unknown Vehicle", vin: undefined },
  deletedSold: { visible: false, status: "SOLD", sourceType: "STOCK", description: "Unknown Vehicle", vin: undefined },
  deletedSourced: { visible: false, status: "AVAILABLE", sourceType: "SOURCED", description: "Unknown Vehicle", vin: undefined },
  foreignSold: { visible: false, status: "SOLD", sourceType: "STOCK", description: "Unknown Vehicle", vin: undefined },
  foreignUnsold: { visible: false, status: "AVAILABLE", sourceType: "STOCK", description: "Unknown Vehicle", vin: undefined },
  missing: { visible: false, status: "AVAILABLE", sourceType: "STOCK", description: "Unknown Vehicle", vin: undefined },
  liveSold: { visible: true, status: "SOLD", sourceType: "STOCK", description: "2026 Protected Car", vin: "942R4VIN" },
  liveSourced: { visible: true, status: "AVAILABLE", sourceType: "SOURCED", description: "2026 Protected Car", vin: "942R4VIN" },
} as const;

async function setDisplayVehicleState(s: Seed, state: DisplayState) {
  await s.t.run(async ctx => {
    if (state === "missing") { await ctx.db.delete(s.vehicleId); return; }
    const expected = displayVehicleOracle[state];
    const foreign = state === "foreignSold" || state === "foreignUnsold";
    const id = foreign ? s.foreignVehicleId : s.vehicleId;
    // Deleted SOLD is retained historical/corrupted data, not a public delete transition.
    await ctx.db.patch(id, { status: expected.status, sourceType: expected.sourceType, isDeleted: state.startsWith("deleted") ? true : undefined });
    if (foreign) await ctx.db.patch(s.payableId, { vehicleId: id });
  });
}

function displaySale(s: DisplaySeed, customerId = s.customerId) {
  return { _id: s.saleId, orgId: s.orgId, vehicleId: s.vehicleId, customerId, salespersonId: s.userId, salePrice: 11, saleDate: NOW, status: "PENDING" };
}

function displayVehicle(s: Seed, state: DisplayState = "live") {
  const expected = displayVehicleOracle[state];
  return expected.visible ? {
    _id: s.vehicleId, orgId: s.orgId, make: "Protected", model: "Car", year: 2026, vin: "942R4VIN",
    mileage: 1, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 11,
    status: expected.status, sourceType: expected.sourceType, sourcedSupplierId: s.supplierId,
  } : null;
}

function displayFields<T extends { _creationTime: number }>(doc: T | null | undefined, creationTime: number) {
  if (!doc) return doc;
  const { _creationTime, ...fields } = doc;
  expect(_creationTime).toBe(creationTime);
  return fields;
}

async function assertPayableProjection(s: DisplaySeed, expected: {
  vehicle: ReturnType<typeof displayVehicle>;
  sale: ReturnType<typeof displaySale> | null;
  customerName: string | null;
  description: string;
  vin: string | undefined;
}, cell: string) {
  const response = await views(s);
  for (const row of [response.row, response.boundedRow]) {
    expect({ vehicleDesc: row.vehicleDesc, vehicleVin: row.vehicleVin, customerName: row.customerName }, cell)
      .toStrictEqual({ vehicleDesc: expected.description, vehicleVin: expected.vin, customerName: expected.customerName });
  }
  expect({ vehicle: displayFields(response.detail?.vehicle, NOW + 10_000), sale: displayFields(response.detail?.sale, NOW + 20_000), customerName: response.detail?.customerName }, cell)
    .toStrictEqual({ vehicle: expected.vehicle, sale: expected.sale, customerName: expected.customerName });
}

async function payableVehicleProjection(state: DisplayState) {
    const s = await displaySeed();
    await setDisplayVehicleState(s, state);
    await assertPayableProjection(s, { vehicle: displayVehicle(s, state), sale: displaySale(s), customerName: "Local Buyer", description: displayVehicleOracle[state].description, vin: displayVehicleOracle[state].vin }, state);
}

const customerDisplayOracle = [
  { state: "live", name: "Local Buyer" }, { state: "deleted", name: null },
  { state: "foreign", name: null }, { state: "absent", name: null },
] as const;

type DisplayObjectState = (typeof customerDisplayOracle)[number]["state"];
function customerCell(state: DisplayObjectState) {
  const cell = customerDisplayOracle.find(candidate => candidate.state === state);
  if (!cell) throw new Error("Unknown display state");
  return cell;
}

async function payableSaleProjection(state: DisplayObjectState) {
    const cell = customerCell(state);
    const s = await displaySeed();
    await s.t.run(async ctx => {
      if (cell.state === "absent") await ctx.db.delete(s.saleId);
      else if (cell.state === "deleted") await ctx.db.patch(s.saleId, { isDeleted: true });
      // Keep its customer local so customer admission cannot mask sale admission.
      else if (cell.state === "foreign") await ctx.db.patch(s.saleId, { orgId: s.otherOrgId });
    });
    await assertPayableProjection(s, { vehicle: displayVehicle(s), sale: cell.state === "live" ? displaySale(s) : null, customerName: cell.name, description: "2026 Protected Car", vin: "942R4VIN" }, cell.state);
}

async function payableCustomerProjection(state: DisplayObjectState) {
    const cell = customerCell(state);
    const s = await displaySeed();
    const customerId = cell.state === "foreign" ? s.foreignCustomerId : s.customerId;
    await s.t.run(async ctx => {
      await ctx.db.patch(s.saleId, { customerId });
      if (cell.state === "deleted") await ctx.db.patch(s.customerId, { isDeleted: true });
      if (cell.state === "absent") await ctx.db.delete(s.customerId);
    });
    await assertPayableProjection(s, { vehicle: displayVehicle(s), sale: displaySale(s, customerId), customerName: cell.name, description: "2026 Protected Car", vin: "942R4VIN" }, cell.state);
}

type PipelineShape = "reservation" | "direct" | "slicedPrimary" | "slicedSecondary";
async function pipelineDisplaySeed(shape: PipelineShape, state: (typeof customerDisplayOracle)[number]["state"]) {
  const s = await seed();
  await s.t.run(async ctx => {
    await ctx.db.patch(s.vehicleId, { sourceType: "SOURCED", sourceCost: 7, sourcedFromName: "Synthetic supplier", trim: "PipelineTrim", arrivedAt: NOW - 1000, createdAt: NOW });
    const fallbackId = await ctx.db.insert("customers", { orgId: s.orgId, firstName: "Fallback", lastName: "Sentinel" });
    const customerId = state === "foreign" ? s.foreignCustomerId : s.customerId;
    await ctx.db.insert("vehicleReservations", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: shape === "reservation" ? customerId : fallbackId, status: "ACTIVE", reservedBy: s.userId, reservedAt: NOW });
    if (shape === "reservation") return;
    const primaryId = shape === "slicedSecondary" ? await ctx.db.insert("vehicles", { orgId: s.orgId, make: "Competing", model: "Primary", year: 2024, vin: "942-PRIMARY-SENTINEL", mileage: 2, color: "Blue", fuelType: "Gas", transmission: "Auto", sellingPrice: 31, sourceType: "STOCK", status: "AVAILABLE" }) : s.vehicleId;
    const depositId = await ctx.db.insert("deposits", { orgId: s.orgId, vehicleId: primaryId, customerId, amount: 2, status: "HELD", holdActive: true, createdBy: s.userId, createdAt: NOW });
    if (shape !== "direct") await ctx.db.insert("depositVehicleHolds", { orgId: s.orgId, vehicleId: s.vehicleId, depositId, active: true, createdAt: NOW });
    await ctx.db.insert("deposits", { orgId: s.orgId, vehicleId: s.vehicleId, customerId: fallbackId, amount: 19, status: "HELD", holdActive: false, createdBy: s.userId, createdAt: NOW });
  });
  if (state === "deleted") await s.asUser.mutation(api.customers.softDelete, { orgId: s.orgId, customerId: s.customerId });
  if (state === "absent") await s.t.run(ctx => ctx.db.delete(s.customerId));
  return s;
}

async function pipelineProjection(shape: PipelineShape, state: DisplayObjectState) {
    const cell = customerCell(state);
    const s = await pipelineDisplaySeed(shape, cell.state);
    const response = await s.asUser.query(api.sourcingPayables.listPipeline, { orgId: s.orgId });
    expect(response, shape + "." + cell.state).toStrictEqual([{
      _id: s.vehicleId, vehicleDesc: "2026 Protected Car PipelineTrim", vin: "942R4VIN", status: "AVAILABLE",
      arrivedAt: NOW - 1000, hasArrived: true, isHeld: shape !== "reservation", sourcedFromName: "Synthetic supplier",
      sourceCost: 7, sellingPrice: 11, customerName: cell.name, depositTotal: shape === "reservation" ? 0 : 2, daysWaiting: 0,
    }]);
}

async function pipelineVehicleExclusion(shape: PipelineShape, state: Exclude<DecisionState, "live">) {
    const s = await pipelineDisplaySeed(shape, "live");
    await s.t.run(async ctx => {
      if (state === "missing") { await ctx.db.delete(s.vehicleId); return; }
      await ctx.db.patch(s.vehicleId, {
        orgId: state.startsWith("foreign") ? s.otherOrgId : s.orgId,
        isDeleted: state.startsWith("deleted"),
        sourceType: state === "deletedSourced" || state.startsWith("foreign") ? "SOURCED" : "STOCK",
        status: state === "deletedSold" || state === "foreignSold" ? "SOLD" : "AVAILABLE",
      });
    });
    expect(await s.asUser.query(api.sourcingPayables.listPipeline, { orgId: s.orgId }), shape + "." + state).toStrictEqual([]);
}

// Literal titles are one-to-one with the scenario records; helpers share the fixture and oracle.
test("942r8 payable vehicle live", async () => { await payableVehicleProjection("live"); });
test("942r8 payable vehicle deletedUnsold", async () => { await payableVehicleProjection("deletedUnsold"); });
test("942r8 payable vehicle deletedSold", async () => { await payableVehicleProjection("deletedSold"); });
test("942r8 payable vehicle deletedSourced", async () => { await payableVehicleProjection("deletedSourced"); });
test("942r8 payable vehicle foreignSold", async () => { await payableVehicleProjection("foreignSold"); });
test("942r8 payable vehicle foreignUnsold", async () => { await payableVehicleProjection("foreignUnsold"); });
test("942r8 payable vehicle missing", async () => { await payableVehicleProjection("missing"); });
test("942r8 payable vehicle liveSold", async () => { await payableVehicleProjection("liveSold"); });
test("942r8 payable vehicle liveSourced", async () => { await payableVehicleProjection("liveSourced"); });
test("942r8 payable sale live", async () => { await payableSaleProjection("live"); });
test("942r8 payable sale deleted", async () => { await payableSaleProjection("deleted"); });
test("942r8 payable sale foreign", async () => { await payableSaleProjection("foreign"); });
test("942r8 payable sale absent", async () => { await payableSaleProjection("absent"); });
test("942r8 payable customer live", async () => { await payableCustomerProjection("live"); });
test("942r8 payable customer deleted", async () => { await payableCustomerProjection("deleted"); });
test("942r8 payable customer foreign", async () => { await payableCustomerProjection("foreign"); });
test("942r8 payable customer absent", async () => { await payableCustomerProjection("absent"); });
test("942r8 pipeline reservation customer live", async () => { await pipelineProjection("reservation", "live"); });
test("942r8 pipeline reservation customer deleted", async () => { await pipelineProjection("reservation", "deleted"); });
test("942r8 pipeline reservation customer foreign", async () => { await pipelineProjection("reservation", "foreign"); });
test("942r8 pipeline reservation customer absent", async () => { await pipelineProjection("reservation", "absent"); });
test("942r8 pipeline direct customer live", async () => { await pipelineProjection("direct", "live"); });
test("942r8 pipeline direct customer deleted", async () => { await pipelineProjection("direct", "deleted"); });
test("942r8 pipeline direct customer foreign", async () => { await pipelineProjection("direct", "foreign"); });
test("942r8 pipeline direct customer absent", async () => { await pipelineProjection("direct", "absent"); });
test("942r8 pipeline slicedPrimary customer live", async () => { await pipelineProjection("slicedPrimary", "live"); });
test("942r8 pipeline slicedPrimary customer deleted", async () => { await pipelineProjection("slicedPrimary", "deleted"); });
test("942r8 pipeline slicedPrimary customer foreign", async () => { await pipelineProjection("slicedPrimary", "foreign"); });
test("942r8 pipeline slicedPrimary customer absent", async () => { await pipelineProjection("slicedPrimary", "absent"); });
test("942r8 pipeline slicedSecondary customer live", async () => { await pipelineProjection("slicedSecondary", "live"); });
test("942r8 pipeline slicedSecondary customer deleted", async () => { await pipelineProjection("slicedSecondary", "deleted"); });
test("942r8 pipeline slicedSecondary customer foreign", async () => { await pipelineProjection("slicedSecondary", "foreign"); });
test("942r8 pipeline slicedSecondary customer absent", async () => { await pipelineProjection("slicedSecondary", "absent"); });
test("942r8 pipeline reservation vehicle deletedUnsold", async () => { await pipelineVehicleExclusion("reservation", "deletedUnsold"); });
test("942r8 pipeline reservation vehicle deletedSold", async () => { await pipelineVehicleExclusion("reservation", "deletedSold"); });
test("942r8 pipeline reservation vehicle deletedSourced", async () => { await pipelineVehicleExclusion("reservation", "deletedSourced"); });
test("942r8 pipeline reservation vehicle foreignSold", async () => { await pipelineVehicleExclusion("reservation", "foreignSold"); });
test("942r8 pipeline reservation vehicle foreignUnsold", async () => { await pipelineVehicleExclusion("reservation", "foreignUnsold"); });
test("942r8 pipeline reservation vehicle missing", async () => { await pipelineVehicleExclusion("reservation", "missing"); });
test("942r8 pipeline direct vehicle deletedUnsold", async () => { await pipelineVehicleExclusion("direct", "deletedUnsold"); });
test("942r8 pipeline direct vehicle deletedSold", async () => { await pipelineVehicleExclusion("direct", "deletedSold"); });
test("942r8 pipeline direct vehicle deletedSourced", async () => { await pipelineVehicleExclusion("direct", "deletedSourced"); });
test("942r8 pipeline direct vehicle foreignSold", async () => { await pipelineVehicleExclusion("direct", "foreignSold"); });
test("942r8 pipeline direct vehicle foreignUnsold", async () => { await pipelineVehicleExclusion("direct", "foreignUnsold"); });
test("942r8 pipeline direct vehicle missing", async () => { await pipelineVehicleExclusion("direct", "missing"); });
test("942r8 pipeline slicedPrimary vehicle deletedUnsold", async () => { await pipelineVehicleExclusion("slicedPrimary", "deletedUnsold"); });
test("942r8 pipeline slicedPrimary vehicle deletedSold", async () => { await pipelineVehicleExclusion("slicedPrimary", "deletedSold"); });
test("942r8 pipeline slicedPrimary vehicle deletedSourced", async () => { await pipelineVehicleExclusion("slicedPrimary", "deletedSourced"); });
test("942r8 pipeline slicedPrimary vehicle foreignSold", async () => { await pipelineVehicleExclusion("slicedPrimary", "foreignSold"); });
test("942r8 pipeline slicedPrimary vehicle foreignUnsold", async () => { await pipelineVehicleExclusion("slicedPrimary", "foreignUnsold"); });
test("942r8 pipeline slicedPrimary vehicle missing", async () => { await pipelineVehicleExclusion("slicedPrimary", "missing"); });
test("942r8 pipeline slicedSecondary vehicle deletedUnsold", async () => { await pipelineVehicleExclusion("slicedSecondary", "deletedUnsold"); });
test("942r8 pipeline slicedSecondary vehicle deletedSold", async () => { await pipelineVehicleExclusion("slicedSecondary", "deletedSold"); });
test("942r8 pipeline slicedSecondary vehicle deletedSourced", async () => { await pipelineVehicleExclusion("slicedSecondary", "deletedSourced"); });
test("942r8 pipeline slicedSecondary vehicle foreignSold", async () => { await pipelineVehicleExclusion("slicedSecondary", "foreignSold"); });
test("942r8 pipeline slicedSecondary vehicle foreignUnsold", async () => { await pipelineVehicleExclusion("slicedSecondary", "foreignUnsold"); });
test("942r8 pipeline slicedSecondary vehicle missing", async () => { await pipelineVehicleExclusion("slicedSecondary", "missing"); });

async function populatedDisplayDocuments(s: DisplaySeed) {
  return await s.t.run(async ctx => {
    const branchId = await ctx.db.insert("branches", { orgId: s.orgId, name: "Display fixture", isActive: true });
    const openingBalanceDraftId = await ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId, status: "PENDING_APPROVAL", lines: [], asOfDate: NOW, createdBy: s.userId, createdAt: NOW });
    const quoteId = await ctx.db.insert("quotes", { orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 11, downPayment: 2, termMonths: 12, status: "DRAFT", createdBy: s.userId, createdAt: NOW });
    const applicationId = await ctx.db.insert("financeApplications", { orgId: s.orgId, quoteId, customerId: s.customerId, vehicleId: s.vehicleId, salespersonId: s.userId, status: "DRAFT", createdAt: NOW, updatedAt: NOW });
    const leadId = await ctx.db.insert("leads", { orgId: s.orgId, customerId: s.customerId, source: "Synthetic", stage: "NEW" });
    const canonicalReceivableDocumentId = await ctx.db.insert("receivableDocuments", { orgId: s.orgId, documentType: "INVOICE", documentNumber: "942R8", payerType: "CUSTOMER", customerId: s.customerId, sourceType: "SALE", sourceId: s.saleId, originalAmountMinor: 11000, currency: "JOD", scale: 1000, issueDate: NOW, dueDate: NOW, status: "OPEN", createdAt: NOW, createdBy: s.userId });
    const commissionBankAccountId = await ctx.db.insert("bankAccounts", { orgId: s.orgId, name: "Synthetic bank", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: NOW, isActive: true, isReconciliationTarget: true, createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
    const imageId = await ctx.storage.store(new Blob(["synthetic"]));
    // These fixture literals also specify the expected raw-document content. No production helper computes them.
    const vehicle = {
      openingStockImportId: "942R8-import", openingStockRowId: 8, openingBalanceDraftId, branchId,
      trim: "Touring", purchasePrice: 7, landedCostTotal: 8, minimumProfit: 1, preHoldStatus: "SOURCING" as const,
      soldBySaleId: s.saleId, sourcedFromName: "Synthetic supplier", sourceCost: 7, arrivedAt: NOW - 1000,
      notes: "Selected vehicle notes", imageIds: [imageId], inspectionStatus: "SELF_REPORTED" as const,
      accidentDisclosed: true, ownerCount: 2, dealerGuarantee: false, createdAt: NOW - 2000,
      addedBy: s.userId, updatedBy: s.userId, updatedAt: NOW, isDeleted: false, deletedAt: NOW - 3000, deletedBy: "Synthetic-restored",
    };
    const sale = {
      branchId, idempotencyKey: "942R8-sale", taxRate: 16, taxAmount: 1, dealerFees: 2, downPayment: 3,
      tradeInVehicleId: s.foreignVehicleId, tradeInValue: 4, financingType: "CASH" as const, loanAmount: 5, apr: 6, termMonths: 12,
      warrantySold: 7, gapSold: 8, warrantyCost: 2, warrantyTermMonths: 24, gapCost: 3, gapTermMonths: 36,
      applicationId, quoteId, leadId, supplierSettlementRoute: "THROUGH_DEALERSHIP" as const,
      consignedMarginMinor: 2000, consignedMarginCurrency: "JOD", commissionBase: { approvedMinor: 11000, contributionMinor: 1000, currency: "JOD" },
      financedNetRevenue: { minor: 10000, currency: "JOD", considerationMinor: 11000 }, consignedSupplierEntitlementMinor: 7000,
      consignedSupplierConcessionMinor: 1000, consignedSupplierGrossReceiptMinor: 9000, canonicalReceivableDocumentId,
      glPostingRequired: true, commissionAmount: 1, commissionAdjustmentSeq: 2, commissionPaidAt: NOW,
      commissionPaidBy: s.userId, commissionPaymentMethod: "BANK_TRANSFER" as const, commissionBankAccountId,
      commissionPaymentIdempotencyKey: "942R8-commission", deletedAt: NOW - 3000, deletedBy: "Synthetic-restored", dealNumber: 9428,
    };
    await ctx.db.patch(s.vehicleId, vehicle);
    await ctx.db.patch(s.saleId, sale);
    return { vehicle, sale };
  });
}

test("942r8 populated joins preserve every optional display field", async () => {
  const s = await displaySeed();
  const populated = await populatedDisplayDocuments(s);
  await assertPayableProjection(s, {
    vehicle: { ...displayVehicle(s)!, ...populated.vehicle }, sale: { ...displaySale(s), ...populated.sale },
    customerName: "Local Buyer", description: "2026 Protected Car Touring", vin: "942R4VIN",
  }, "all optional fields");
});
