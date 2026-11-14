/**
 * NON-PILOT-CERTIFYING: opens the pilot-closed supplier receipt reversal door
 * to test stored-id ownership and historical reversal mechanics behind its refusal.
 */
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedSupplier } from "../test-utils/supplierFixture";
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
        readIds: gets.mock.calls.map((call: readonly unknown[]) => String(call.length === 2 ? call[1] : call[0])),
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
