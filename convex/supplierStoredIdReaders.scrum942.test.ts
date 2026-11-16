/**
 * NON-PILOT-CERTIFYING: opens the pilot-closed supplier receipt reversal door
 * to test stored-id ownership and historical reversal mechanics behind its refusal.
 */
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { renameSupplier, seedSupplier } from "../test-utils/supplierFixture";
import { api, internal } from "./_generated/api";
import schema from "./schema";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
// Historical reversal mechanics only. Production's pilot switch stays closed.
vi.mock("./utils/supplierSettlementContainment", async (importOriginal) =>
  (
    await import("../test-utils/supplierSettlementSwitches")
  ).openSupplierSettlementDoors(
    await importOriginal<
      typeof import("./utils/supplierSettlementContainment")
    >(),
  ),
);

const modules = import.meta.glob("./**/*.*s");
const NOW = Date.parse("2026-11-10T09:00:00Z");
type Harness = ReturnType<typeof convexTestWithComponents>;
const harnesses: Harness[] = [];
async function finishHarnesses() {
  try {
    for (const t of harnesses.splice(0))
      await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}
afterEach(finishHarnesses);

async function seed(state: "foreign" | "deleted" | "live") {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, modules);
  harnesses.push(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      name: "Synthetic A",
      createdAt: NOW,
    });
    const foreignOrgId = await ctx.db.insert("organizations", {
      name: "Synthetic B",
      createdAt: NOW,
    });
    const userId = await ctx.db.insert("users", {
      clerkId: "scrum942",
      name: "Synthetic operator",
      email: "scrum942@example.test",
    });
    const roleId = await ctx.db.insert("roles", {
      orgId,
      name: "Custom finance",
      permissions: [
        "manage:finance",
        "view:finance",
        "view:cost_price",
        "create:expenses",
        "view:expenses",
        "delete:vehicles",
      ],
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    });
    return { orgId, foreignOrgId, userId, roleId };
  });
  const supplierId = await seedSupplier(t, {
    ...ids,
    displayName: "Synthetic supplier",
  });
  const targets = await t.run(async (ctx) => {
    const common = {
      make: "ProtectedMake",
      model: "ProtectedModel",
      year: 2026,
      vin: "SCRUM942-PROTECTED-VIN",
      mileage: 1,
      color: "White",
      fuelType: "Gas",
      transmission: "Auto",
      sellingPrice: 11,
      sourceCost: 7,
      status: "AVAILABLE" as const,
      sourceType: "SOURCED" as const,
      sourcedFromName: "Synthetic supplier",
      sourcedSupplierId: supplierId,
    };
    const vehicleId = await ctx.db.insert("vehicles", {
      ...common,
      orgId: ids.orgId,
    });
    // The traced product writers reject foreign ids. These direct writes model corrupted or historical links.
    // Deletion is a later lifecycle state, not proof that the original link was invalid.
    const targetVehicleId = await ctx.db.insert("vehicles", {
      ...common,
      make: "TargetMake",
      model: "TargetModel",
      trim: "TrimSentinel",
      year: 2025,
      vin: "942-TARGET-VIN",
      orgId: state === "foreign" ? ids.foreignOrgId : ids.orgId,
      isDeleted: state === "deleted",
    });
    const expenseId = await ctx.db.insert("expenses", {
      orgId: ids.orgId,
      vehicleId,
      title: "Visible expense",
      amount: 2,
      date: NOW - 1000,
      category: "TRANSPORT",
      status: "PAID",
    });
    const targetExpenseId = await ctx.db.insert("expenses", {
      orgId: state === "foreign" ? ids.foreignOrgId : ids.orgId,
      vehicleId: targetVehicleId,
      title: "SCRUM942 protected expense title",
      amount: 2,
      date: NOW - 1000,
      category: "TRANSPORT",
      status: "PAID",
      isDeleted: state === "deleted",
    });
    const customerId = await ctx.db.insert("customers", {
      orgId: ids.orgId,
      firstName: "Synthetic",
      lastName: "Buyer",
    });
    const saleId = await ctx.db.insert("sales", {
      orgId: ids.orgId,
      vehicleId,
      customerId,
      salespersonId: ids.userId,
      salePrice: 11,
      saleDate: NOW - 1000,
      status: "COMPLETED",
    });
    const claimId = await ctx.db.insert("vehicleSupplierReceivables", {
      orgId: ids.orgId,
      vehicleId,
      saleId,
      supplierId,
      sourcedFromName: "Synthetic supplier",
      amountDue: 2,
      currency: "JOD",
      status: "OPEN",
      createdBy: ids.userId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const recoveryId = await ctx.db.insert("supplierCostRecoveries", {
      orgId: ids.orgId,
      vehicleId,
      expenseId,
      supplierId,
      sourcedFromName: "Synthetic supplier",
      amountDueMinor: 2000,
      amountRecoveredMinor: 0,
      currency: "JOD",
      status: "OPEN",
      receiptSeq: 0,
      sourceEventKey: "synthetic942",
      createdBy: ids.userId,
      createdAt: NOW,
      updatedAt: NOW,
      agreedDueDate: NOW,
    });
    return {
      vehicleId,
      targetVehicleId,
      expenseId,
      targetExpenseId,
      claimId,
      recoveryId,
    };
  });
  return {
    t,
    ...ids,
    ...targets,
    supplierId,
    asUser: t.withIdentity({ subject: "scrum942" }),
  };
}

// Load lazy modules in a disposable fixture; every test still seeds its own DB.
beforeAll(async () => {
  try {
    const s = await seed("live");
    await s.asUser.query(api.supplierReceivables.list, { orgId: s.orgId });
  } finally {
    await finishHarnesses();
  }
});

async function receivableVehicle(state: "foreign" | "deleted") {
  const s = await seed(state);
  await s.t.run((ctx) =>
    ctx.db.patch(s.claimId, { vehicleId: s.targetVehicleId }),
  );
  const response = await s.asUser.query(api.supplierReceivables.list, {
    orgId: s.orgId,
  });
  expect(JSON.stringify(response)).not.toContain("SCRUM942-PROTECTED-VIN");
  expect(JSON.stringify(response)).not.toContain("ProtectedMake");
  expect(response.items).toHaveLength(1);
  expect(response.items[0]).toMatchObject({
    _id: s.claimId,
    vehicleLabel: "Vehicle",
    remainingAmount: 2,
  });
  expect(response.items[0]?.vin).toBeUndefined();
  expect({ vehicleLabel: response.items[0]?.vehicleLabel, vin: response.items[0]?.vin })
    .toStrictEqual({ vehicleLabel: "Vehicle", vin: undefined });
}

test("receivables list hides a foreign stored vehicle", async () => {
  await receivableVehicle("foreign");
});
test("receivables list hides a deleted stored vehicle", async () => {
  await receivableVehicle("deleted");
});

async function recoveryVehicle(state: "foreign" | "deleted") {
  const s = await seed(state);
  await s.t.run((ctx) =>
    ctx.db.patch(s.recoveryId, { vehicleId: s.targetVehicleId }),
  );
  const response = await s.asUser.query(api.supplierCostRecoveries.list, {
    orgId: s.orgId,
  });
  expect(JSON.stringify(response)).not.toContain("ProtectedMake");
  expect(response.items).toEqual([
    {
      _id: s.recoveryId,
      vehicleId: s.targetVehicleId,
      expenseId: s.expenseId,
      sourcedFromName: "Synthetic supplier",
      currency: "JOD",
      amountDueMinor: 2000,
      amountRecoveredMinor: 0,
      remainingMinor: 2000,
      status: "OPEN",
      sourcePostingState: "NONE",
      expenseTitle: "Visible expense",
      vehicleLabel: null,
      createdAt: NOW,
    },
  ]);
}

test("recoveries list hides a foreign stored vehicle", async () => {
  await recoveryVehicle("foreign");
});
test("recoveries list hides a deleted stored vehicle", async () => {
  await recoveryVehicle("deleted");
});

async function recoveryExpense(state: "foreign" | "deleted") {
  const s = await seed(state);
  await s.t.run((ctx) =>
    ctx.db.patch(s.recoveryId, { expenseId: s.targetExpenseId }),
  );
  const response = await s.asUser.query(api.supplierCostRecoveries.list, {
    orgId: s.orgId,
  });
  expect(JSON.stringify(response)).not.toContain(
    "SCRUM942 protected expense title",
  );
  expect(response.items).toHaveLength(1);
  expect(response.items[0]).toMatchObject({
    _id: s.recoveryId,
    expenseTitle: null,
    vehicleLabel: "2026 ProtectedMake ProtectedModel",
    remainingMinor: 2000,
  });
}

test("recoveries list hides a foreign stored expense", async () => {
  await recoveryExpense("foreign");
});
test("recoveries list hides a deleted stored expense", async () => {
  await recoveryExpense("deleted");
});

async function recordedReceipt(state: "foreign" | "deleted" | "live") {
  const s = await seed(state);
  await s.asUser.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
  await s.asUser.mutation(api.accountingPeriods.create, {
    orgId: s.orgId,
    startDate: Date.UTC(2026, 0, 1),
    endDate: Date.UTC(2026, 11, 31),
    fiscalYear: 2026,
    periodNumber: 1,
  });
  const periods = await s.asUser.query(api.accountingPeriods.list, {
    orgId: s.orgId,
  });
  const periodId = periods[0]?._id;
  if (!periodId) throw new Error("Missing seeded period");
  await s.asUser.mutation(api.accountingPeriods.open, {
    orgId: s.orgId,
    periodId,
  });
  const expenseId = await s.asUser.mutation(api.expenses.create, {
    orgId: s.orgId,
    vehicleId: s.vehicleId,
    vendorSupplierId: s.supplierId,
    title: "Synthetic recoverable cost",
    amount: 2,
    date: NOW - 1000,
    category: "TRANSPORT",
    status: "PAID",
    paymentMethod: "CASH",
    costBearer: "SUPPLIER",
    idempotencyKey: "942expense",
  });
  const recovery = await s.t.run((ctx) =>
    ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_expense", (q) =>
        q.eq("orgId", s.orgId).eq("expenseId", expenseId),
      )
      .unique(),
  );
  if (!recovery) throw new Error("Missing seeded recovery");
  const receipt = await s.asUser.mutation(
    api.supplierCostRecoveries.recordReceipt,
    {
      orgId: s.orgId,
      recoveryId: recovery._id,
      amountMinor: 1000,
      method: "CASH",
      receivedDate: NOW - 500,
      idempotencyKey: "942receipt",
    },
  );
  return { s, recovery, receipt };
}

async function reversal(state: "foreign" | "deleted") {
  const { s, recovery, receipt } = await recordedReceipt(state);
  // Plant the invalid stored reference after a real receipt and its journal have been recorded.
  // Keep SOURCED on the target so the old stock-car refusal cannot mask this check.
  await s.t.run((ctx) =>
    ctx.db.patch(recovery._id, { vehicleId: s.targetVehicleId }),
  );
  const before = await s.t.run(async (ctx) => ({
    receipt: await ctx.db.get(receipt.receiptId),
    recovery: await ctx.db.get(recovery._id),
    events: await ctx.db.query("accountingEvents").collect(),
    entries: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
    commands: await ctx.db.query("commandIdempotency").collect(),
  }));
  await expect(
    s.asUser.mutation(api.supplierCostRecoveries.reverseReceipt, {
      orgId: s.orgId,
      receiptId: receipt.receiptId,
      reason: "Synthetic correction",
      reversalDate: NOW,
      idempotencyKey: "942reverse",
    }),
  ).rejects.toThrow(
    "This car is no longer a sourced vehicle, so its supplier cost recoveries are closed and cannot be reversed.",
  );
  const after = await s.t.run(async (ctx) => ({
    receipt: await ctx.db.get(receipt.receiptId),
    recovery: await ctx.db.get(recovery._id),
    events: await ctx.db.query("accountingEvents").collect(),
    entries: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
    commands: await ctx.db.query("commandIdempotency").collect(),
  }));
  expect(after).toEqual(before);
}

test("receipt reversal refuses a foreign stored sourced vehicle", async () => {
  await reversal("foreign");
});
test("receipt reversal retains a deleted local sourced vehicle and its receipt pair", async () => {
  const { s, recovery, receipt } = await recordedReceipt("live");
  await s.asUser.mutation(api.vehicles.softDelete, { orgId: s.orgId, vehicleId: s.vehicleId });
  expect((await s.t.run(ctx => ctx.db.get(s.vehicleId)))?.isDeleted).toBe(true);
  // Main admits a later receipt on the same historical recovery without reading the vehicle.
  const later = await s.asUser.mutation(api.supplierCostRecoveries.recordReceipt, {
    orgId: s.orgId, recoveryId: recovery._id, amountMinor: 500, method: "CASH", receivedDate: NOW,
    idempotencyKey: "942deletedlater",
  });
  expect(later).toMatchObject({ amountRecoveredMinor: 1500, remainingMinor: 500, status: "PARTIALLY_RECOVERED" });
  const result = await s.asUser.mutation(api.supplierCostRecoveries.reverseReceipt, {
    orgId: s.orgId, receiptId: receipt.receiptId, reason: "Synthetic correction", reversalDate: NOW, idempotencyKey: "942deletedreverse",
  });
  expect(result).toMatchObject({ amountRecoveredMinor: 500, remainingMinor: 1500, status: "PARTIALLY_RECOVERED" });
  expect(await s.t.run(ctx => ctx.db.get(receipt.receiptId))).toMatchObject({ status: "REVERSED", amountMinor: 1000 });
  expect(await s.t.run(ctx => ctx.db.get(later.receiptId))).toMatchObject({ status: "LIVE", amountMinor: 500 });
  expect(await s.t.run(ctx => ctx.db.get(recovery._id))).toMatchObject({ amountDueMinor: 2000, amountRecoveredMinor: 500, status: "PARTIALLY_RECOVERED" });
});

// No public function reaches the repair worker or the alert worker. Exercise their registered internal entries.
async function repairVehicle(state: "foreign" | "deleted") {
  const s = await seed(state);
  await s.t.run((ctx) =>
    ctx.db.patch(s.claimId, {
      vehicleId: s.targetVehicleId,
      supplierId: undefined,
    }),
  );
  const response = await s.t.mutation(
    internal.supplierIdentityRepair.repairPage,
    { orgId: s.orgId, phase: "RECEIVABLES", cursor: null },
  );
  expect(response).toMatchObject({ examined: 1, repaired: 0, unresolved: 1 });
  expect(
    (await s.t.run((ctx) => ctx.db.get(s.claimId)))?.supplierId,
  ).toBeUndefined();
}

test("supplier identity repair ignores a foreign stored vehicle", async () => {
  await repairVehicle("foreign");
});
test("supplier identity repair retains deleted stored vehicle history", async () => {
  const s = await seed("deleted");
  await s.t.run(ctx => ctx.db.patch(s.claimId, { vehicleId: s.targetVehicleId, supplierId: undefined }));
  expect(await s.t.mutation(internal.supplierIdentityRepair.repairPage, { orgId: s.orgId, phase: "RECEIVABLES", cursor: null })).toMatchObject({ examined: 1, repaired: 1, unresolved: 0 });
  expect((await s.t.run(ctx => ctx.db.get(s.claimId)))?.supplierId).toBe(s.supplierId);
});

async function alertRole(state: "foreign" | "deleted") {
  const s = await seed(state);
  // A deliberately inconsistent membership for the foreign case; normal membership writers scope roles.
  await s.t.run((ctx) =>
    ctx.db.patch(s.roleId, {
      orgId: state === "foreign" ? s.foreignOrgId : s.orgId,
      isDeleted: state === "deleted",
    }),
  );
  const response = await s.t.mutation(
    internal.supplierDueAlerts.processOrgSupplierDueAlerts,
    { orgId: s.orgId, kind: "RECOVERY", now: NOW },
  );
  expect(response).toEqual({ alerted: 0, skipped: 0 });
  const notifications = await s.t.run((ctx) =>
    ctx.db.query("notifications").collect(),
  );
  expect(notifications.map((row) => row.userId)).not.toContain(s.userId);
}

test("supplier alerts ignore a foreign stored membership role", async () => {
  await alertRole("foreign");
});
test("supplier alerts ignore a deleted stored membership role", async () => {
  await alertRole("deleted");
});

async function measureHandler(s: Awaited<ReturnType<typeof seed>>, registered: unknown, args: unknown) {
  if (typeof registered !== "function" || !("_handler" in registered) || typeof registered._handler !== "function") {
    throw new Error("Registered handler unavailable");
  }
  const handler = registered._handler;
  return s.asUser.run(async ctx => {
    const gets = vi.spyOn(ctx.db, "get");
    const inserts = vi.spyOn(ctx.db, "insert");
    const patches = vi.spyOn(ctx.db, "patch");
    const replaces = vi.spyOn(ctx.db, "replace");
    const deletes = vi.spyOn(ctx.db, "delete");
    try {
      const response: unknown = await handler(ctx, args);
      return {
        response,
        readIds: gets.mock.calls.map((call: readonly unknown[]) => String(call[1] === undefined ? call[0] : call[1])),
        writes: inserts.mock.calls.length + patches.mock.calls.length + replaces.mock.calls.length + deletes.mock.calls.length,
      };
    } finally {
      gets.mockRestore();
      inserts.mockRestore();
      patches.mockRestore();
      replaces.mockRestore();
      deletes.mockRestore();
    }
  });
}

function assertSingleTargetReads(label: string, measured: Awaited<ReturnType<typeof measureHandler>>, targets: string[]) {
  const targetGets = targets.map(id => measured.readIds.filter(readId => readId === id).length);
  console.info("SCRUM942_IO " + JSON.stringify({ reader: label, gets: measured.readIds.length, targetGets, writes: measured.writes }));
  expect(targetGets).toEqual(targets.map(() => 1));
}

test("receivable metadata uses one existing vehicle read and no writes", async () => {
  const s = await seed("live");
  const measured = await measureHandler(s, (await import("./supplierReceivables")).list, { orgId: s.orgId });
  expect(measured.response).toMatchObject({ items: [{ _id: s.claimId, vehicleLabel: "2026 ProtectedMake ProtectedModel", vin: "SCRUM942-PROTECTED-VIN" }] });
  assertSingleTargetReads("receivables.list.vehicle", measured, [s.vehicleId]);
  expect(measured.writes).toBe(0);
});

test("recovery metadata uses one existing read per target and no writes", async () => {
  const s = await seed("live");
  const measured = await measureHandler(s, (await import("./supplierCostRecoveries")).list, { orgId: s.orgId });
  expect(measured.response).toMatchObject({ items: [{ _id: s.recoveryId, vehicleLabel: "2026 ProtectedMake ProtectedModel", expenseTitle: "Visible expense" }] });
  assertSingleTargetReads("recoveries.list.vehicle+expense", measured, [s.vehicleId, s.expenseId]);
  expect(measured.writes).toBe(0);
});

test("receipt reversal uses one existing vehicle read", async () => {
  const { s, receipt } = await recordedReceipt("live");
  const measured = await measureHandler(s, (await import("./supplierCostRecoveries")).reverseReceipt, {
    orgId: s.orgId, receiptId: receipt.receiptId, reason: "Synthetic correction", reversalDate: NOW, idempotencyKey: "942io",
  });
  expect(measured.response).toMatchObject({ amountRecoveredMinor: 0, remainingMinor: 2000, status: "OPEN" });
  expect((await s.t.run(ctx => ctx.db.get(receipt.receiptId)))?.status).toBe("REVERSED");
  assertSingleTargetReads("reverseReceipt.vehicle", measured, [s.vehicleId]);
});

test("identity repair uses one existing vehicle read", async () => {
  const s = await seed("live");
  await s.t.run(ctx => ctx.db.patch(s.claimId, { supplierId: undefined }));
  const measured = await measureHandler(s, (await import("./supplierIdentityRepair")).repairPage, {
    orgId: s.orgId, phase: "RECEIVABLES", cursor: null,
  });
  expect(measured.response).toMatchObject({ examined: 1, repaired: 1, unresolved: 0 });
  expect((await s.t.run(ctx => ctx.db.get(s.claimId)))?.supplierId).toBe(s.supplierId);
  assertSingleTargetReads("identityRepair.vehicle", measured, [s.vehicleId]);
});

test("supplier alerts use one existing role read", async () => {
  const s = await seed("live");
  const measured = await measureHandler(s, (await import("./supplierDueAlerts")).processOrgSupplierDueAlerts, {
    orgId: s.orgId, kind: "RECOVERY", now: NOW,
  });
  expect(measured.response).toEqual({ alerted: 1, skipped: 0 });
  const notifications = await s.t.run(ctx => ctx.db.query("notifications").collect());
  expect(notifications.map(row => row.userId)).toEqual([s.userId]);
  assertSingleTargetReads("supplierAlerts.role", measured, [s.roleId]);
});

// Exact display expectations come from the ADR, independently of ownership helpers.
// The original vehicle/expense remain present with different content as source sentinels.
const metadataVehicleOracle = [
  { state: "live", seedState: "live", status: "AVAILABLE", sourceType: "STOCK", label: "2025 TargetMake TargetModel", vin: "942-TARGET-VIN" },
  { state: "deletedUnsold", seedState: "deleted", status: "AVAILABLE", sourceType: "STOCK", label: null, vin: undefined },
  { state: "deletedSold", seedState: "deleted", status: "SOLD", sourceType: "STOCK", label: null, vin: undefined },
  { state: "deletedSourced", seedState: "deleted", status: "AVAILABLE", sourceType: "SOURCED", label: null, vin: undefined },
  { state: "foreignSold", seedState: "foreign", status: "SOLD", sourceType: "STOCK", label: null, vin: undefined },
  { state: "foreignUnsold", seedState: "foreign", status: "AVAILABLE", sourceType: "STOCK", label: null, vin: undefined },
  { state: "missing", seedState: "live", status: "AVAILABLE", sourceType: "STOCK", label: null, vin: undefined },
  { state: "liveSold", seedState: "live", status: "SOLD", sourceType: "STOCK", label: "2025 TargetMake TargetModel", vin: "942-TARGET-VIN" },
  { state: "liveSourced", seedState: "live", status: "AVAILABLE", sourceType: "SOURCED", label: "2025 TargetMake TargetModel", vin: "942-TARGET-VIN" },
] as const;

async function metadataFixture(cell: (typeof metadataVehicleOracle)[number]) {
  const s = await seed(cell.seedState);
  await s.t.run(async ctx => {
    if (cell.state === "missing") await ctx.db.delete(s.targetVehicleId);
    else await ctx.db.patch(s.targetVehicleId, { status: cell.status, sourceType: cell.sourceType });
    await ctx.db.patch(s.claimId, { vehicleId: s.targetVehicleId });
    await ctx.db.patch(s.recoveryId, { vehicleId: s.targetVehicleId });
  });
  return s;
}

type MetadataState = (typeof metadataVehicleOracle)[number]["state"];
function metadataCell(state: MetadataState) {
  const cell = metadataVehicleOracle.find(candidate => candidate.state === state);
  if (!cell) throw new Error("Unknown metadata state");
  return cell;
}

async function receivableProjection(state: MetadataState) {
    const cell = metadataCell(state);
    const s = await metadataFixture(cell);
    const response = await s.asUser.query(api.supplierReceivables.list, { orgId: s.orgId });
    expect(response.complete).toBe(true);
    expect(response.items).toHaveLength(1);
    expect({ _id: response.items[0]?._id, amountDue: response.items[0]?.amountDue,
      remainingAmount: response.items[0]?.remainingAmount, status: response.items[0]?.status, currency: response.items[0]?.currency })
      .toStrictEqual({ _id: s.claimId, amountDue: 2, remainingAmount: 2, status: "OPEN", currency: "JOD" });
    expect({ vehicleLabel: response.items[0]?.vehicleLabel, vin: response.items[0]?.vin }, cell.state)
      .toStrictEqual({ vehicleLabel: cell.label ?? "Vehicle", vin: cell.vin });
}

function recoveryProjection(s: Awaited<ReturnType<typeof seed>>, vehicleLabel: string | null, expenseTitle: string | null, expenseId = s.expenseId) {
  return {
    _id: s.recoveryId, vehicleId: s.targetVehicleId, expenseId, sourcedFromName: "Synthetic supplier", currency: "JOD",
    amountDueMinor: 2000, amountRecoveredMinor: 0, remainingMinor: 2000, status: "OPEN", sourcePostingState: "NONE",
    expenseTitle, vehicleLabel, createdAt: NOW,
  };
}

async function recoveryVehicleProjection(state: MetadataState) {
    const cell = metadataCell(state);
    const s = await metadataFixture(cell);
    const response = await s.asUser.query(api.supplierCostRecoveries.list, { orgId: s.orgId });
    expect(response, cell.state).toStrictEqual({ complete: true, items: [recoveryProjection(s, cell.label, "Visible expense")] });
}

const expenseDisplayOracle = [
    { state: "live", seedState: "live", title: "SCRUM942 protected expense title" },
    { state: "deleted", seedState: "deleted", title: null },
    { state: "foreign", seedState: "foreign", title: null },
    { state: "absent", seedState: "live", title: null },
  ] as const;

async function recoveryExpenseProjection(state: (typeof expenseDisplayOracle)[number]["state"]) {
    const cell = expenseDisplayOracle.find(candidate => candidate.state === state);
    if (!cell) throw new Error("Unknown expense state");
    const s = await seed(cell.seedState);
    await s.t.run(async ctx => {
      await ctx.db.patch(s.recoveryId, { expenseId: s.targetExpenseId });
      if (cell.state === "absent") await ctx.db.delete(s.targetExpenseId);
    });
    const response = await s.asUser.query(api.supplierCostRecoveries.list, { orgId: s.orgId });
    expect(response, cell.state).toStrictEqual({ complete: true, items: [{ ...recoveryProjection(s, "2026 ProtectedMake ProtectedModel", cell.title, s.targetExpenseId), vehicleId: s.vehicleId }] });
}

test("942r8 receivable vehicle live", async () => { await receivableProjection("live"); });
test("942r8 receivable vehicle deletedUnsold", async () => { await receivableProjection("deletedUnsold"); });
test("942r8 receivable vehicle deletedSold", async () => { await receivableProjection("deletedSold"); });
test("942r8 receivable vehicle deletedSourced", async () => { await receivableProjection("deletedSourced"); });
test("942r8 receivable vehicle foreignSold", async () => { await receivableProjection("foreignSold"); });
test("942r8 receivable vehicle foreignUnsold", async () => { await receivableProjection("foreignUnsold"); });
test("942r8 receivable vehicle missing", async () => { await receivableProjection("missing"); });
test("942r8 receivable vehicle liveSold", async () => { await receivableProjection("liveSold"); });
test("942r8 receivable vehicle liveSourced", async () => { await receivableProjection("liveSourced"); });
test("942r8 recovery vehicle live", async () => { await recoveryVehicleProjection("live"); });
test("942r8 recovery vehicle deletedUnsold", async () => { await recoveryVehicleProjection("deletedUnsold"); });
test("942r8 recovery vehicle deletedSold", async () => { await recoveryVehicleProjection("deletedSold"); });
test("942r8 recovery vehicle deletedSourced", async () => { await recoveryVehicleProjection("deletedSourced"); });
test("942r8 recovery vehicle foreignSold", async () => { await recoveryVehicleProjection("foreignSold"); });
test("942r8 recovery vehicle foreignUnsold", async () => { await recoveryVehicleProjection("foreignUnsold"); });
test("942r8 recovery vehicle missing", async () => { await recoveryVehicleProjection("missing"); });
test("942r8 recovery vehicle liveSold", async () => { await recoveryVehicleProjection("liveSold"); });
test("942r8 recovery vehicle liveSourced", async () => { await recoveryVehicleProjection("liveSourced"); });
test("942r8 recovery expense live", async () => { await recoveryExpenseProjection("live"); });
test("942r8 recovery expense deleted", async () => { await recoveryExpenseProjection("deleted"); });
test("942r8 recovery expense foreign", async () => { await recoveryExpenseProjection("foreign"); });
test("942r8 recovery expense absent", async () => { await recoveryExpenseProjection("absent"); });

type ReadSeed = Awaited<ReturnType<typeof seed>>;
async function payableForReaders(s: ReadSeed) {
  return await s.t.run(ctx => ctx.db.insert("vehicleSupplierPayables", {
    orgId: s.orgId, vehicleId: s.vehicleId, supplierId: s.supplierId, sourcedFromName: "Synthetic supplier",
    currency: "JOD", amountDue: 5, status: "PENDING", createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
  }));
}

type BankState = "local" | "foreign" | "deleted" | "inactive" | "currency" | "missing";
async function bankChoices(state: BankState) {
  const s = await seed("live");
  const payableId = await payableForReaders(s);
  const banks = await s.t.run(async ctx => {
    const fields = { orgId: s.orgId, currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: NOW,
      isActive: true, isReconciliationTarget: true, createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
      iban: "SYNTHETIC-IBAN", accountNumber: "SYNTHETIC-ACCOUNT" };
    const allowedId = await ctx.db.insert("bankAccounts", { ...fields, name: "AllowedBank" });
    const selectedId = await ctx.db.insert("bankAccounts", { ...fields, name: "SelectedBank",
      orgId: state === "foreign" ? s.foreignOrgId : s.orgId, isDeleted: state === "deleted",
      isActive: state !== "inactive", currency: state === "currency" ? "USD" : "JOD" });
    if (state === "missing") await ctx.db.delete(selectedId);
    return { allowedId, selectedId };
  });
  const expected = state === "local" ? [
    { _id: banks.allowedId, name: "AllowedBank", currency: "JOD" },
    { _id: banks.selectedId, name: "SelectedBank", currency: "JOD" },
  ] : [{ _id: banks.allowedId, name: "AllowedBank", currency: "JOD" }];
  const args = { orgId: s.orgId };
  const responses = [
    await s.asUser.query(api.sourcingPayables.listPaymentBankOptions, { ...args, payableId }),
    await s.asUser.query(api.supplierReceivables.listReceiptBankOptions, { ...args, receivableId: s.claimId }),
    await s.asUser.query(api.supplierCostRecoveries.listReceiptBankOptions, { ...args, recoveryId: s.recoveryId }),
  ];
  for (const response of responses) expect(response).toStrictEqual({ banks: expected, truncated: false });
}

test("942r9 supplier bank pickers preserve exact local choices without account details", async () => { await bankChoices("local"); });
test("942r9 supplier bank pickers exclude a foreign bank independently", async () => { await bankChoices("foreign"); });
test("942r9 supplier bank pickers exclude a deleted bank independently", async () => { await bankChoices("deleted"); });
test("942r9 supplier bank pickers exclude an inactive bank independently", async () => { await bankChoices("inactive"); });
test("942r9 supplier bank pickers exclude a different currency independently", async () => { await bankChoices("currency"); });
test("942r9 supplier bank pickers exclude a missing bank independently", async () => { await bankChoices("missing"); });

type RootDoor = "payableBank" | "claimBank" | "recoveryBank" | "receipts" | "get";
async function refusedReaderRoot(door: RootDoor, state: "foreign" | "missing") {
  const s = await seed("live");
  const payableId = await payableForReaders(s);
  const id = { payableBank: payableId, get: payableId, claimBank: s.claimId, recoveryBank: s.recoveryId, receipts: s.recoveryId }[door];
  await s.t.run(async ctx => {
    if (state === "missing") await ctx.db.delete(id);
    else await ctx.db.patch(id, { orgId: s.foreignOrgId });
  });
  const args = { orgId: s.orgId };
  if (door === "get") {
    expect(await s.asUser.query(api.sourcingPayables.get, { ...args, payableId })).toBeNull();
    return;
  }
  if (door === "payableBank") await expect(s.asUser.query(api.sourcingPayables.listPaymentBankOptions, { ...args, payableId }))
    .rejects.toThrow("Record not found in this organization.");
  if (door === "claimBank") await expect(s.asUser.query(api.supplierReceivables.listReceiptBankOptions, { ...args, receivableId: s.claimId }))
    .rejects.toThrow("Supplier receivable not found.");
  if (door === "recoveryBank") await expect(s.asUser.query(api.supplierCostRecoveries.listReceiptBankOptions, { ...args, recoveryId: s.recoveryId }))
    .rejects.toThrow("Supplier cost recovery not found.");
  if (door === "receipts") await expect(s.asUser.query(api.supplierCostRecoveries.listReceipts, { ...args, recoveryId: s.recoveryId }))
    .rejects.toThrow("Supplier cost recovery not found.");
}

test("942r9 payable bank picker refuses a foreign root", async () => { await refusedReaderRoot("payableBank", "foreign"); });
test("942r9 payable bank picker refuses a missing root", async () => { await refusedReaderRoot("payableBank", "missing"); });
test("942r9 claim bank picker refuses a foreign root", async () => { await refusedReaderRoot("claimBank", "foreign"); });
test("942r9 claim bank picker refuses a missing root", async () => { await refusedReaderRoot("claimBank", "missing"); });
test("942r9 recovery bank picker refuses a foreign root", async () => { await refusedReaderRoot("recoveryBank", "foreign"); });
test("942r9 recovery bank picker refuses a missing root", async () => { await refusedReaderRoot("recoveryBank", "missing"); });
test("942r9 recovery receipts refuse a foreign root", async () => { await refusedReaderRoot("receipts", "foreign"); });
test("942r9 recovery receipts refuse a missing root", async () => { await refusedReaderRoot("receipts", "missing"); });
test("942r9 payable get hides a foreign root", async () => { await refusedReaderRoot("get", "foreign"); });
test("942r9 payable get hides a missing root", async () => { await refusedReaderRoot("get", "missing"); });

async function receiptProjection(bankState: "local" | "foreign" | "deleted" | "missing" | "absent") {
  const s = await seed("live");
  const { bankId, receiptId } = await s.t.run(async ctx => {
    await ctx.db.insert("bankAccounts", { orgId: s.orgId, name: "CompetingBank", currency: "JOD",
      openingBalanceMinor: 0, openingBalanceDate: NOW, isActive: true, isReconciliationTarget: true,
      createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
    const bankId = await ctx.db.insert("bankAccounts", { orgId: bankState === "foreign" ? s.foreignOrgId : s.orgId,
      name: "BankSecret", accountNumber: "SYNTHETIC-SECRET", currency: "JOD", openingBalanceMinor: 0,
      openingBalanceDate: NOW, isActive: true, isDeleted: bankState === "deleted", isReconciliationTarget: true,
      createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
    const receiptId = await ctx.db.insert("supplierCostRecoveryReceipts", {
      orgId: s.orgId, recoveryId: s.recoveryId, vehicleId: s.vehicleId, seq: 1, amountMinor: 1000,
      currency: "JOD", method: "BANK_TRANSFER", bankAccountId: bankState === "absent" ? undefined : bankId,
      receivedDate: NOW - 1000, reference: "ReceiptReference", notes: "PrivateNote", idempotencyKey: "942r9-receipt",
      status: "LIVE", createdBy: s.userId, createdAt: NOW,
    });
    if (bankState === "missing") await ctx.db.delete(bankId);
    return { bankId, receiptId };
  });
  expect(await s.asUser.query(api.supplierCostRecoveries.listReceipts, { orgId: s.orgId, recoveryId: s.recoveryId }))
    .toStrictEqual([{
      _id: receiptId, seq: 1, amountMinor: 1000, currency: "JOD", method: "BANK_TRANSFER",
      bankAccountId: bankState === "absent" ? null : bankId, receivedDate: NOW - 1000,
      reference: "ReceiptReference", status: "LIVE", reversedAt: null,
    }]);
}

test("942r9 receipt returns the local bank id without joining its details", async () => { await receiptProjection("local"); });
test("942r9 receipt returns the stored foreign bank id without disclosing bank details", async () => { await receiptProjection("foreign"); });
test("942r9 receipt retains a deleted bank id without joining its details", async () => { await receiptProjection("deleted"); });
test("942r9 receipt retains a missing bank id without joining its details", async () => { await receiptProjection("missing"); });
test("942r9 receipt absent bank returns an explicit null", async () => { await receiptProjection("absent"); });

const postingOracle = {
  absent: { event: null, queued: null, state: "NONE", due: 2, cost: 0 },
  posted: { event: "POSTED", queued: "FAILED", state: "POSTED", due: 4, cost: 2 },
  reversed: { event: "REVERSED", queued: "PENDING", state: "REVERSED", due: 2, cost: 0 },
  pending: { event: "PENDING", queued: "PENDING", state: "PENDING", due: 2, cost: 0 },
  failed: { event: "FAILED", queued: "FAILED", state: "FAILED", due: 2, cost: 0 },
  foreignEvent: { event: "POSTED", queued: null, state: "NONE", due: 2, cost: 0 },
  foreignQueue: { event: null, queued: "PENDING", state: "NONE", due: 2, cost: 0 },
} as const;

async function postingProjection(state: keyof typeof postingOracle) {
  const cell = postingOracle[state];
  const s = await seed("live");
  await s.t.run(async ctx => {
    if (cell.event) await ctx.db.insert("accountingEvents", {
      orgId: state === "foreignEvent" ? s.foreignOrgId : s.orgId, eventType: "EXPENSE_POSTED",
      sourceType: "expenses", sourceId: String(s.expenseId), eventVersion: 1, idempotencyKey: "synthetic942",
      occurredAt: NOW, accountingDate: NOW, currency: "JOD", payload: {}, status: cell.event,
      createdBy: s.userId, createdAt: NOW,
    });
    if (cell.queued) await ctx.db.insert("pendingAccountingEvents", {
      orgId: state === "foreignQueue" ? s.foreignOrgId : s.orgId, kind: "POST", status: cell.queued,
      idempotencyKey: "synthetic942", accountingDate: NOW, actorId: s.userId, attempts: 1,
      createdAt: NOW, sourceType: "expenses", sourceId: String(s.expenseId),
    });
    // A different-key local posting must never answer for this recovery's source.
    await ctx.db.insert("accountingEvents", {
      orgId: s.orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: String(s.expenseId),
      eventVersion: 1, idempotencyKey: "other-key", occurredAt: NOW, accountingDate: NOW,
      currency: "JOD", payload: {}, status: "POSTED", createdBy: s.userId, createdAt: NOW,
    });
  });
  const list = await s.asUser.query(api.supplierCostRecoveries.list, { orgId: s.orgId });
  expect(list).toStrictEqual({ complete: true, items: [{ ...recoveryProjection(s, "2026 ProtectedMake ProtectedModel", "Visible expense"), vehicleId: s.vehicleId, sourcePostingState: cell.state }] });
  expect(await s.asUser.query(api.supplierReceivables.outstandingSummary, { orgId: s.orgId }))
    .toStrictEqual({ totalDue: cell.due, totalReceived: 0, totalOutstanding: cell.due, disputedAmount: 0,
      costRecoveryOutstanding: cell.cost, complete: true, bySupplier: [{ supplierId: s.supplierId,
        sourcedFromName: "Synthetic supplier", snapshots: ["Synthetic supplier"], outstanding: cell.due,
        claims: state === "posted" ? 2 : 1 }] });
}

test("942r9 posting missing source ignores a different local key", async () => { await postingProjection("absent"); });
test("942r9 posting local posted source outranks its failed queue", async () => { await postingProjection("posted"); });
test("942r9 posting reversed source outranks its pending queue", async () => { await postingProjection("reversed"); });
test("942r9 posting pending source remains outside outstanding recovery totals", async () => { await postingProjection("pending"); });
test("942r9 posting failed source remains outside outstanding recovery totals", async () => { await postingProjection("failed"); });
test("942r9 posting ignores a foreign event with the exact local source key", async () => { await postingProjection("foreignEvent"); });
test("942r9 posting ignores a foreign queue with the exact local source key", async () => { await postingProjection("foreignQueue"); });

async function supplierGrouping(state: "local" | "foreign" | "missing" | "unlinked" | "bothUnlinked" | "recoveryForeign" | "recoveryMissing" | "inactive" | "recoveryInactive") {
  const s = await seed("live");
  const secondSupplier = await seedSupplier(s.t, { orgId: s.orgId, userId: s.userId, displayName: "Another master name" });
  await renameSupplier(s.t, s.supplierId, "MasterNameSentinel");
  const claimUnlinked = state === "unlinked" || state === "bothUnlinked";
  const recoveryUnlinked = state === "bothUnlinked";
  await s.t.run(async ctx => {
    await ctx.db.patch(s.claimId, { supplierId: claimUnlinked ? undefined : s.supplierId });
    if (state === "foreign") await ctx.db.patch(s.supplierId, { orgId: s.foreignOrgId });
    if (state === "missing") await ctx.db.delete(s.supplierId);
    if (state === "recoveryForeign") await ctx.db.patch(secondSupplier, { orgId: s.foreignOrgId });
    if (state === "recoveryMissing") await ctx.db.delete(secondSupplier);
    if (state === "inactive") await ctx.db.patch(s.supplierId, { status: "INACTIVE" });
    if (state === "recoveryInactive") await ctx.db.patch(secondSupplier, { status: "INACTIVE" });
    await ctx.db.patch(s.recoveryId, { supplierId: recoveryUnlinked ? undefined : secondSupplier });
    await ctx.db.insert("accountingEvents", {
      orgId: s.orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: String(s.expenseId),
      eventVersion: 1, idempotencyKey: "synthetic942", occurredAt: NOW, accountingDate: NOW,
      currency: "JOD", payload: {}, status: "POSTED", createdBy: s.userId, createdAt: NOW,
    });
  });
  const response = await s.asUser.query(api.supplierReceivables.outstandingSummary, { orgId: s.orgId });
  expect({ ...response, bySupplier: response.bySupplier.map(row => ({ ...row, supplierId: row.supplierId ?? null })) })
    .toStrictEqual({ totalDue: 4, totalReceived: 0, totalOutstanding: 4, disputedAmount: 0, costRecoveryOutstanding: 2,
      complete: true, bySupplier: [
        { supplierId: claimUnlinked ? null : s.supplierId, sourcedFromName: "Synthetic supplier", snapshots: ["Synthetic supplier"], outstanding: 2, claims: 1 },
        { supplierId: recoveryUnlinked ? null : secondSupplier, sourcedFromName: "Synthetic supplier", snapshots: ["Synthetic supplier"], outstanding: 2, claims: 1 },
      ] });
}

test("942r9 summary separates same-name obligations by stored supplier id", async () => { await supplierGrouping("local"); });
test("942r9 summary uses the stored foreign supplier id without joining its name", async () => { await supplierGrouping("foreign"); });
test("942r9 summary retains a missing supplier identity snapshot", async () => { await supplierGrouping("missing"); });
test("942r9 summary keeps an unlinked claim separate from a named supplier", async () => { await supplierGrouping("unlinked"); });
test("942r9 summary separates two unlinked obligations with the same frozen name", async () => { await supplierGrouping("bothUnlinked"); });
test("942r9 summary retains the recovery stored foreign supplier identity", async () => { await supplierGrouping("recoveryForeign"); });
test("942r9 summary retains the recovery missing supplier identity", async () => { await supplierGrouping("recoveryMissing"); });
test("942r9 summary retains an inactive claim supplier identity", async () => { await supplierGrouping("inactive"); });
test("942r9 summary retains an inactive recovery supplier identity", async () => { await supplierGrouping("recoveryInactive"); });

async function indexedRootScope(family: "payable" | "claim" | "recovery") {
  const s = await seed("live");
  const payableId = await payableForReaders(s);
  await s.t.run(async ctx => {
    const id = { payable: payableId, claim: s.claimId, recovery: s.recoveryId }[family];
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Missing root fixture");
    await ctx.db.patch(id, { orgId: s.foreignOrgId });
    if (family === "recovery") await ctx.db.insert("accountingEvents", {
      orgId: s.orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: String(s.expenseId),
      eventVersion: 1, idempotencyKey: "synthetic942", occurredAt: NOW, accountingDate: NOW,
      currency: "JOD", payload: {}, status: "POSTED", createdBy: s.userId, createdAt: NOW,
    });
  });
  const args = { orgId: s.orgId };
  if (family === "payable") {
    for (const status of [undefined, "PENDING"] as const) {
      expect(await s.asUser.query(api.sourcingPayables.list, { ...args, status })).toStrictEqual([]);
      expect(await s.asUser.query(api.sourcingPayables.listBounded, { ...args, status })).toStrictEqual({ complete: true, items: [] });
    }
  }
  if (family === "claim") for (const status of [undefined, "OPEN"] as const) {
    expect(await s.asUser.query(api.supplierReceivables.list, { ...args, status })).toStrictEqual({ complete: true, items: [] });
  }
  if (family === "recovery") for (const status of [undefined, "OPEN"] as const) {
    expect(await s.asUser.query(api.supplierCostRecoveries.list, { ...args, status })).toStrictEqual({ complete: true, items: [] });
  }
  const summary = await s.asUser.query(api.supplierReceivables.outstandingSummary, args);
  expect({ due: summary.totalDue, received: summary.totalReceived, outstanding: summary.totalOutstanding, cost: summary.costRecoveryOutstanding })
    .toStrictEqual(family === "claim" ? { due: 0, received: 0, outstanding: 0, cost: 0 } : { due: 2, received: 0, outstanding: 2, cost: 0 });
}

test("942r9 payable indexes exclude a foreign root with local join targets", async () => { await indexedRootScope("payable"); });
test("942r9 claim indexes exclude a foreign root with local join targets", async () => { await indexedRootScope("claim"); });
test("942r9 recovery indexes exclude a foreign root with local join targets", async () => { await indexedRootScope("recovery"); });

async function receiptScope(state: "local" | "foreign" | "sibling") {
  const s = await seed("live");
  await s.t.run(async ctx => {
    let recoveryId = s.recoveryId;
    if (state === "sibling") {
      recoveryId = await ctx.db.insert("supplierCostRecoveries", {
        orgId: s.orgId, vehicleId: s.vehicleId, expenseId: s.expenseId, sourcedFromName: "Other recovery",
        amountDueMinor: 9000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 1,
        sourceEventKey: "other-source", createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
      });
    }
    await ctx.db.insert("supplierCostRecoveryReceipts", { orgId: state === "foreign" ? s.foreignOrgId : s.orgId,
      recoveryId, vehicleId: s.vehicleId, seq: 2, amountMinor: 9000, currency: "JOD", method: "CASH",
      receivedDate: NOW, idempotencyKey: "scope-receipt", status: "LIVE", createdBy: s.userId, createdAt: NOW });
  });
  const response = await s.asUser.query(api.supplierCostRecoveries.listReceipts, { orgId: s.orgId, recoveryId: s.recoveryId });
  if (state === "local") {
    expect(response).toHaveLength(1);
    expect({ amountMinor: response[0]?.amountMinor, seq: response[0]?.seq }).toStrictEqual({ amountMinor: 9000, seq: 2 });
  } else expect(response).toStrictEqual([]);
}

test("942r9 receipt index retains a local receipt for the requested recovery", async () => { await receiptScope("local"); });
test("942r9 receipt index excludes a foreign receipt for the local recovery", async () => { await receiptScope("foreign"); });
test("942r9 receipt index excludes a local receipt for a sibling recovery", async () => { await receiptScope("sibling"); });

type OpeningDamage = "none" | "foreignDraft" | "missingDraft" | "unpostedDraft" | "foreignAccount" | "missingAccount" | "inactiveAccount" | "foreignJournal" | "missingJournal" | "reversedJournal" | "foreignLine" | "missingLine" | "wrongJournalSource" | "wrongLineJournal";
async function openingReaderSeed() {
  const s = await seed("live");
  const source = await s.t.run(async ctx => {
    const counterpartId = await ctx.db.insert("chartOfAccounts", {
      orgId: s.orgId, code: "942R9-EQUITY", name: "Opening counterpart", type: "EQUITY", normalBalance: "CREDIT",
      active: true, isControlAccount: false, allowManualPosting: true, createdAt: NOW, updatedAt: NOW,
    });
    const accountId = await ctx.db.insert("chartOfAccounts", {
      orgId: s.orgId, code: "942R9-ASSET", name: "Opening control", type: "ASSET", normalBalance: "DEBIT",
      active: true, isControlAccount: false, allowManualPosting: true, createdAt: NOW, updatedAt: NOW,
    });
    const journalId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId, journalNumber: "942R9-OPENING", accountingDate: NOW, sourceType: "cutover",
      sourceId: String(s.orgId), category: "OPENING_BALANCE", memo: "Synthetic opening", status: "POSTED",
      currency: "JOD", postedBy: s.userId, postedAt: NOW, createdAt: NOW,
    });
    const draftId = await ctx.db.insert("openingBalanceDrafts", {
      orgId: s.orgId, status: "POSTED", currency: "JOD", asOfDate: NOW, createdBy: s.userId, createdAt: NOW,
      journalEntryId: journalId, lines: [{ accountId, debitMinor: 3000, creditMinor: 0 }, { accountId: counterpartId, debitMinor: 0, creditMinor: 3000 }],
      allocations: [{ kind: "SUPPLIER_RECOVERABLE", rowKey: "942r9-opening", accountId, amountMinor: 3000,
        counterpartyName: "Synthetic supplier", supplierId: s.supplierId, title: "Opening title", purpose: "CLAIM" }],
      allocationResults: [{ kind: "SUPPLIER_RECOVERABLE", rowKey: "942r9-opening", recoveryId: s.recoveryId }],
    });
    await ctx.db.replace(s.recoveryId, {
      orgId: s.orgId, origin: "OPENING", openingBalanceDraftId: draftId, openingRowKey: "942r9-opening",
      title: "Opening title", purpose: "CLAIM", sourcedFromName: "Synthetic supplier", supplierId: s.supplierId,
      currency: "JOD", amountDueMinor: 3000, amountRecoveredMinor: 0, status: "OPEN", receiptSeq: 0,
      createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
    });
    const lineId = await ctx.db.insert("journalLines", { orgId: s.orgId, journalEntryId: journalId, accountId,
      lineNumber: 1, debitMinor: 3000, creditMinor: 0, currency: "JOD", scale: 1000, accountingDate: NOW });
    await ctx.db.insert("journalLines", { orgId: s.orgId, journalEntryId: journalId, accountId: counterpartId,
      lineNumber: 2, debitMinor: 0, creditMinor: 3000, currency: "JOD", scale: 1000, accountingDate: NOW });
    return { accountId, journalId, draftId, lineId };
  });
  return { ...s, ...source };
}

async function damageOpening(s: Awaited<ReturnType<typeof openingReaderSeed>>, damage: OpeningDamage) {
  await s.t.run(async ctx => {
    if (damage === "foreignDraft") await ctx.db.patch(s.draftId, { orgId: s.foreignOrgId });
    if (damage === "missingDraft") await ctx.db.delete(s.draftId);
    if (damage === "unpostedDraft") await ctx.db.patch(s.draftId, { status: "VOIDED" });
    if (damage === "foreignAccount") await ctx.db.patch(s.accountId, { orgId: s.foreignOrgId });
    if (damage === "missingAccount") await ctx.db.delete(s.accountId);
    if (damage === "inactiveAccount") await ctx.db.patch(s.accountId, { active: false });
    if (damage === "foreignJournal") await ctx.db.patch(s.journalId, { orgId: s.foreignOrgId });
    if (damage === "missingJournal") await ctx.db.delete(s.journalId);
    if (damage === "reversedJournal") await ctx.db.patch(s.journalId, { status: "REVERSED" });
    if (damage === "foreignLine") await ctx.db.patch(s.lineId, { orgId: s.foreignOrgId });
    if (damage === "missingLine") await ctx.db.delete(s.lineId);
    if (damage === "wrongJournalSource") await ctx.db.patch(s.journalId, { sourceId: String(s.foreignOrgId) });
    if (damage === "wrongLineJournal") {
      const otherJournalId = await ctx.db.insert("journalEntries", {
        orgId: s.orgId, journalNumber: "942R9-OTHER", accountingDate: NOW, sourceType: "synthetic",
        sourceId: "other-source", category: "MANUAL", memo: "Competing journal", status: "POSTED",
        currency: "JOD", postedBy: s.userId, postedAt: NOW, createdAt: NOW,
      });
      await ctx.db.patch(s.lineId, { journalEntryId: otherJournalId });
    }
  });
}

async function openingReaderProjection(damage: OpeningDamage) {
  const s = await openingReaderSeed();
  await damageOpening(s, damage);
  const args = { orgId: s.orgId };
  if (damage !== "none") {
    await expect(s.asUser.query(api.supplierCostRecoveries.list, args))
      .rejects.toThrow("The opening obligation basis cannot be verified. Ask finance to review it before settlement.");
    await expect(s.asUser.query(api.supplierReceivables.outstandingSummary, args))
      .rejects.toThrow("The opening obligation basis cannot be verified. Ask finance to review it before settlement.");
    return;
  }
  expect(await s.asUser.query(api.supplierCostRecoveries.list, args)).toStrictEqual({ complete: true, items: [openingRecoveryProjection(s)] });
  expect(await s.asUser.query(api.supplierReceivables.outstandingSummary, args)).toStrictEqual({
    totalDue: 5, totalReceived: 0, totalOutstanding: 5, disputedAmount: 0, costRecoveryOutstanding: 3, complete: true,
    bySupplier: [{ supplierId: s.supplierId, sourcedFromName: "Synthetic supplier", snapshots: ["Synthetic supplier"], outstanding: 5, claims: 2 }],
  });
}

function openingRecoveryProjection(s: ReadSeed) {
  return { _id: s.recoveryId, sourcedFromName: "Synthetic supplier", currency: "JOD",
    amountDueMinor: 3000, amountRecoveredMinor: 0, remainingMinor: 3000, status: "OPEN", sourcePostingState: "POSTED",
    expenseTitle: "Opening title", vehicleLabel: null, createdAt: NOW };
}

test("942r9 opening readers preserve a verified local source without native metadata joins", async () => { await openingReaderProjection("none"); });
test("942r9 opening readers refuse a foreign draft independently", async () => { await openingReaderProjection("foreignDraft"); });
test("942r9 opening readers refuse a missing draft independently", async () => { await openingReaderProjection("missingDraft"); });
test("942r9 opening readers refuse an unposted draft independently", async () => { await openingReaderProjection("unpostedDraft"); });
test("942r9 opening readers refuse a foreign account independently", async () => { await openingReaderProjection("foreignAccount"); });
test("942r9 opening readers refuse a missing account independently", async () => { await openingReaderProjection("missingAccount"); });
test("942r9 opening readers refuse an inactive account independently", async () => { await openingReaderProjection("inactiveAccount"); });
test("942r9 opening readers refuse a foreign journal independently", async () => { await openingReaderProjection("foreignJournal"); });
test("942r9 opening readers refuse a missing journal independently", async () => { await openingReaderProjection("missingJournal"); });
test("942r9 opening readers refuse a reversed journal independently", async () => { await openingReaderProjection("reversedJournal"); });
test("942r9 opening readers refuse a foreign journal line independently", async () => { await openingReaderProjection("foreignLine"); });
test("942r9 opening readers refuse a missing journal line independently", async () => { await openingReaderProjection("missingLine"); });
test("942r9 opening readers refuse a journal naming another source organization", async () => { await openingReaderProjection("wrongJournalSource"); });
test("942r9 opening readers refuse a control line attached to another journal", async () => { await openingReaderProjection("wrongLineJournal"); });

async function openingReferenceMismatch(state: "result" | "supplier") {
  const s = await openingReaderSeed();
  const otherSupplierId = await seedSupplier(s.t, { orgId: s.orgId, userId: s.userId, displayName: "Other supplier master" });
  await s.t.run(async ctx => {
    const draft = await ctx.db.get(s.draftId);
    if (!draft?.allocations) throw new Error("Missing opening fixture allocation");
    if (state === "supplier") {
      await ctx.db.patch(s.draftId, { allocations: draft.allocations.map(row => ({ ...row, supplierId: otherSupplierId })) });
      return;
    }
    const wrongRecoveryId = await ctx.db.insert("supplierCostRecoveries", {
      orgId: s.orgId, vehicleId: s.vehicleId, expenseId: s.expenseId, sourcedFromName: "Other recovery",
      amountDueMinor: 9000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0,
      sourceEventKey: "other-recovery", createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
    });
    // Keep a genuine but stale id, without a sibling root that could mask the comparison.
    await ctx.db.delete(wrongRecoveryId);
    await ctx.db.patch(s.draftId, { allocationResults: [{ kind: "SUPPLIER_RECOVERABLE", rowKey: "942r9-opening", recoveryId: wrongRecoveryId }] });
  });
  const args = { orgId: s.orgId };
  await expect(s.asUser.query(api.supplierCostRecoveries.list, args))
    .rejects.toThrow("The opening obligation cannot be verified. Ask finance to review it before settlement.");
  await expect(s.asUser.query(api.supplierReceivables.outstandingSummary, args))
    .rejects.toThrow("The opening obligation cannot be verified. Ask finance to review it before settlement.");
}

test("942r9 opening readers refuse a mismatched result recovery id", async () => { await openingReferenceMismatch("result"); });
test("942r9 opening readers refuse a mismatched supplier id with the same frozen name", async () => { await openingReferenceMismatch("supplier"); });

async function nativeOpeningReference(state: "foreign" | "other" | "unposted") {
  const s = await seed("live");
  await s.t.run(async ctx => {
    let referencedId = s.recoveryId;
    if (state === "other") {
      referencedId = await ctx.db.insert("supplierCostRecoveries", {
        orgId: s.orgId, vehicleId: s.vehicleId, expenseId: s.expenseId, sourcedFromName: "Other recovery",
        amountDueMinor: 9000, amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0,
        sourceEventKey: "other-recovery", createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
      });
      await ctx.db.delete(referencedId);
    }
    await ctx.db.insert("openingBalanceDrafts", {
      orgId: state === "foreign" ? s.foreignOrgId : s.orgId, status: state === "unposted" ? "VOIDED" : "POSTED",
      asOfDate: NOW, createdBy: s.userId, createdAt: NOW, lines: [],
      allocationResults: [{ kind: "SUPPLIER_RECOVERABLE", rowKey: "other-opening", recoveryId: referencedId }],
    });
  });
  expect(await s.asUser.query(api.supplierCostRecoveries.list, { orgId: s.orgId }))
    .toStrictEqual({ complete: true, items: [{ ...recoveryProjection(s, "2026 ProtectedMake ProtectedModel", "Visible expense"), vehicleId: s.vehicleId }] });
  expect(await s.asUser.query(api.supplierReceivables.outstandingSummary, { orgId: s.orgId }))
    .toStrictEqual({ totalDue: 2, totalReceived: 0, totalOutstanding: 2, disputedAmount: 0, costRecoveryOutstanding: 0,
      complete: true, bySupplier: [{ supplierId: s.supplierId, sourcedFromName: "Synthetic supplier", snapshots: ["Synthetic supplier"], outstanding: 2, claims: 1 }] });
}

test("942r9 opening parent scan ignores a result naming another recovery id", async () => { await nativeOpeningReference("other"); });
test("942r9 opening parent scan ignores an unposted local draft claiming a native recovery", async () => { await nativeOpeningReference("unposted"); });
test("942r9 opening parent scan ignores a foreign posted draft claiming a native recovery", async () => { await nativeOpeningReference("foreign"); });

async function legacyOpeningReference(state: "allocationMissing" | "rootMissing" | "bothMissing" | "wrongName") {
  const s = await openingReaderSeed();
  await s.t.run(async ctx => {
    const draft = await ctx.db.get(s.draftId);
    const allocation = draft?.allocations?.[0];
    if (allocation?.kind !== "SUPPLIER_RECOVERABLE") throw new Error("Missing opening fixture allocation");
    const unlinked = { ...allocation };
    delete unlinked.supplierId;
    if (state !== "rootMissing") await ctx.db.patch(s.draftId, {
      allocations: [{ ...unlinked, counterpartyName: state === "wrongName" ? "Legacy mismatch" : "Synthetic supplier" }],
    });
    if (state !== "allocationMissing") await ctx.db.patch(s.recoveryId, { supplierId: undefined });
  });
  const args = { orgId: s.orgId };
  if (state !== "bothMissing") {
    await expect(s.asUser.query(api.supplierCostRecoveries.list, args))
      .rejects.toThrow("The opening obligation cannot be verified. Ask finance to review it before settlement.");
    await expect(s.asUser.query(api.supplierReceivables.outstandingSummary, args))
      .rejects.toThrow("The opening obligation cannot be verified. Ask finance to review it before settlement.");
    return;
  }
  expect(await s.asUser.query(api.supplierCostRecoveries.list, args))
    .toStrictEqual({ complete: true, items: [openingRecoveryProjection(s)] });
  expect(await s.asUser.query(api.supplierReceivables.outstandingSummary, args)
    .then(summary => ({ ...summary, bySupplier: summary.bySupplier.map(row => ({ ...row, supplierId: row.supplierId ?? null })) })))
    .toStrictEqual({ totalDue: 5, totalReceived: 0, totalOutstanding: 5, disputedAmount: 0, costRecoveryOutstanding: 3,
      complete: true, bySupplier: [
        { supplierId: null, sourcedFromName: "Synthetic supplier", snapshots: ["Synthetic supplier"], outstanding: 3, claims: 1 },
        { supplierId: s.supplierId, sourcedFromName: "Synthetic supplier", snapshots: ["Synthetic supplier"], outstanding: 2, claims: 1 },
      ] });
}

test("942r9 opening readers refuse an allocation missing its supplier id independently", async () => { await legacyOpeningReference("allocationMissing"); });
test("942r9 opening readers refuse a root missing its supplier id independently", async () => { await legacyOpeningReference("rootMissing"); });
test("942r9 opening readers retain a legacy source with both supplier ids absent", async () => { await legacyOpeningReference("bothMissing"); });
test("942r9 opening readers refuse mismatched legacy names when both supplier ids are absent", async () => { await legacyOpeningReference("wrongName"); });
