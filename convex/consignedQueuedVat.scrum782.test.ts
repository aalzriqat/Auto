/**
 * SCRUM-782 / SCRUM-760 c23812 ruling 1: old queued consigned VAT must
 * quarantine visibly, without inventing input VAT or reducing COGS.
 * These are serial convex-test checks, not Convex runtime or OCC evidence.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { makeDue, quiesceScheduler, settleOutbox, withFrozenScheduler } from "../test-utils/outboxWork";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { enqueuePendingPost } from "./accountingOutbox";
import { postAccountingEvent, type PostCommand } from "./accounting/postingEngine";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const newTest = () => convexTestWithComponents(schema, MODULE_GLOB);
type T = ReturnType<typeof newTest>;
const REFUSAL = /supplier.*VAT.*operator review/i;

async function seedOrg(t: T) {
  const now = Date.now();
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "S782", createdAt: now }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "s782", email: "s782@example.com", name: "Owner" }));
  await t.run(async (ctx) => {
    const roleId = await ctx.db.insert("roles", {
      orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true,
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
  });
  const as = t.withIdentity({ subject: "s782", clerkId: "s782" });
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  const periodId = await as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  await as.mutation(api.accountingPeriods.open, { orgId, periodId });
  await quiesceScheduler(t);
  return { orgId, userId, as, periodId };
}

/** PAID + nonzero tax is the persisted shape markPaid could write before #690. */
async function legacyPayment(t: T, orgId: Id<"organizations">, userId: Id<"users">) {
  const now = Date.now();
  return await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "S782" + crypto.randomUUID(), make: "Kia", model: "Sportage", year: 2023, mileage: 0, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20000, status: "SOLD",
      sourceType: "SOURCED", sourcedFromName: "Supplier", sourceCost: 18000,
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer" });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId, salePrice: 20000, saleDate: now, status: "COMPLETED",
    });
    const payableId = await ctx.db.insert("vehicleSupplierPayables", {
      orgId, vehicleId, saleId, sourcedFromName: "Supplier", amountDue: 18000, amountPaid: 18000,
      currency: "JOD", status: "PAID", taxAmount: 2000, paymentMethod: "CASH",
      createdBy: userId, createdAt: now, updatedAt: now,
    });
    const cmd: PostCommand = {
      orgId, eventType: "SUPPLIER_PAYMENT_SETTLED", sourceType: "vehicleSupplierPayables", sourceId: payableId,
      eventVersion: 1, idempotencyKey: `supplier_payment_settled_${payableId}_1`, accountingDate: now,
      occurredAt: now, currency: "JOD", actorId: userId,
      payload: { payableId, sourcedFromName: "Supplier", amountMinor: 18_000_000, taxMinor: 2_000_000,
        currency: "JOD", paymentMethod: "CASH", costOrigin: "COGS" },
    };
    return { vehicleId, payableId, saleId, cmd };
  });
}

async function footprint(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => ({
    events: await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
    journals: await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
    lines: await ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
    snapshots: (await ctx.db.query("accountBalanceSnapshots").collect()).filter((row) => row.orgId === orgId),
  }));
}

async function accountLines(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const lines = await ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
    return await Promise.all(lines.map(async (line) => ({
      key: (await ctx.db.get(line.accountId))?.systemKey, debit: line.debitMinor, credit: line.creditMinor,
    })));
  });
}

async function queuedRow(t: T, orgId: Id<"organizations">, key: string) {
  return await t.run((ctx) => ctx.db.query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", key)).unique());
}

describe("SCRUM-782 queued consigned supplier VAT", () => {
  test("cron ticks with only valid period holds schedule no work or parked-range scans", async () => {
    const t = newTest();
    const { orgId, userId } = await seedOrg(t);
    const owned = await legacyPayment(t, orgId, userId);
    const zeroVat = await legacyPayment(t, orgId, userId);
    zeroVat.cmd.payload.taxMinor = 0;
    await t.run(async (ctx) => {
      await ctx.db.patch(owned.payableId, { saleId: undefined });
      await ctx.db.patch(owned.vehicleId, { sourceType: "STOCK" });
      await ctx.db.patch(zeroVat.payableId, { taxAmount: 0 });
      for (const payment of [owned, zeroVat]) {
        await ctx.db.insert("pendingAccountingEvents", {
          ...payment.cmd, kind: "POST", status: "PENDING", attempts: 0,
          createdAt: Date.now(), dispatchState: "PERIOD_HELD", holdKind: "PERIOD",
        });
      }
    });
    const before = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    await withFrozenScheduler(async () => {
      for (let tick = 0; tick < 3; tick += 1) {
        expect(await t.mutation(internal.accountingOutbox.dispatchDueOutboxWork, {}))
          .toEqual({ dispatched: 0, observed: 0 });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
      }
    });
    // SCRUM-807 measures persisted scheduler work, including scans that never
    // claim a row. Checking only claim generations missed the round-2 defect.
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(before);
  });

  test("legacy queued consigned VAT dead-letters visibly without a VAT or COGS journal", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t);
    const { payableId, cmd } = await legacyPayment(t, orgId, userId);
    await t.run((ctx) => enqueuePendingPost(ctx, cmd, "No open period when paid"));
    const before = await footprint(t, orgId);
    const payableBefore = await t.run((ctx) => ctx.db.get(payableId));

    await settleOutbox(t, orgId);

    const postedAccounts = await t.run(async (ctx) => {
      const lines = await ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      return await Promise.all(lines.map(async (line) => (await ctx.db.get(line.accountId))?.systemKey));
    });
    expect(postedAccounts.filter((key) => key === "VAT_RECEIVABLE" || key === "COST_OF_VEHICLES_SOLD")).toEqual([]);
    const refused = await queuedRow(t, orgId, cmd.idempotencyKey);
    expect(refused?.lastError).toMatch(REFUSAL);
    expect(refused?.attempts).toBe(1);
    expect(refused?.dispatchState).toBeUndefined();
    expect(refused?.resolvedAt).toBeUndefined();
    expect(refused?.nextActionAt).toBeGreaterThan(Date.now());
    // Compare whole records: catches removals, replacements and snapshot writes too.
    expect(await footprint(t, orgId)).toEqual(before);

    for (let attempt = 1; attempt < 10; attempt += 1) {
      await makeDue(t, orgId);
      await settleOutbox(t, orgId);
    }
    const failed = await queuedRow(t, orgId, cmd.idempotencyKey);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.attempts).toBe(10);
    expect(failed?.payload).toEqual(cmd.payload);
    expect(await t.run((ctx) => ctx.db.get(payableId))).toEqual(payableBefore);
    expect(await footprint(t, orgId)).toEqual(before);
    const visible = await as.query(api.accountingSetup.listFailedEvents, {
      orgId, paginationOpts: { numItems: 20, cursor: null },
    });
    expect(visible.page).toEqual(expect.arrayContaining([expect.objectContaining({ _id: failed?._id, status: "FAILED" })]));
    const reconciliation = await as.query(api.accountingReports.supplierPayablesReconciliation, { orgId });
    expect(reconciliation).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "PENDING_POSTINGS", isReconciled: false });
    expect((await as.query(api.vatReport.generateVatSummary, { orgId })).inputVatMinor).toBe(0);

    // Retry is a request, not correction: unchanged bad evidence must refuse again.
    await as.mutation(api.accountingOutbox.retryFailed, { orgId, pendingEventId: failed!._id });
    await settleOutbox(t, orgId);
    expect((await queuedRow(t, orgId, cmd.idempotencyKey))?.lastError).toMatch(REFUSAL);
    expect(await footprint(t, orgId)).toEqual(before);
  });

  test("direct posting of consigned VAT refuses before creating any financial record", async () => {
    const t = newTest();
    const { orgId, userId } = await seedOrg(t);
    const { cmd } = await legacyPayment(t, orgId, userId);
    const before = await footprint(t, orgId);
    await expect(t.run((ctx) => postAccountingEvent(ctx, cmd))).rejects.toThrow(REFUSAL);
    expect(await footprint(t, orgId)).toEqual(before);
  });

  test("invalid consigned VAT consumes attempts before a missing-period hold", async () => {
    const t = newTest();
    const { orgId, userId, periodId } = await seedOrg(t);
    const { cmd } = await legacyPayment(t, orgId, userId);
    await t.run(async (ctx) => {
      await ctx.db.delete(periodId);
      await enqueuePendingPost(ctx, cmd, "No open period when paid");
    });
    await settleOutbox(t, orgId);
    const row = await queuedRow(t, orgId, cmd.idempotencyKey);
    expect(row).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(row?.lastError).toMatch(REFUSAL);
    expect(row?.dispatchState).toBeUndefined();
    expect(row?.holdKind).toBeUndefined();
    expect((await footprint(t, orgId)).lines).toEqual([]);
  });

  test.each(["drain", "migration"] as const)("already period-held consigned VAT reaches quarantine through %s", async (door) => {
    const t = newTest();
    const { orgId, userId, periodId } = await seedOrg(t);
    const bad = await legacyPayment(t, orgId, userId);
    const zeroVat = await legacyPayment(t, orgId, userId);
    const owned = await legacyPayment(t, orgId, userId);
    zeroVat.cmd.payload.taxMinor = 0;
    await t.run(async (ctx) => {
      await ctx.db.delete(periodId);
      await ctx.db.patch(zeroVat.payableId, { taxAmount: 0 });
      await ctx.db.patch(owned.payableId, { saleId: undefined });
      await ctx.db.patch(owned.vehicleId, { sourceType: "STOCK" });
      for (const payment of [bad, zeroVat, owned]) {
        await enqueuePendingPost(ctx, payment.cmd, "No open period when paid");
        const row = await ctx.db.query("pendingAccountingEvents")
          .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", payment.cmd.idempotencyKey)).unique();
        if (!row) throw new Error("Fixture did not enqueue the payment");
        await ctx.db.patch(row._id, {
          dispatchState: "PERIOD_HELD", holdKind: "PERIOD", nextActionAt: undefined,
          lastError: "Waiting to post: No open accounting period covers this date.",
        });
      }
    });
    const controlsBefore = await Promise.all([zeroVat, owned].map((p) => queuedRow(t, orgId, p.cmd.idempotencyKey)));
    const payableBefore = await t.run((ctx) => ctx.db.get(bad.payableId));
    const before = await footprint(t, orgId);

    await withFrozenScheduler(async () => {
      if (door === "drain") await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
      else expect(await t.mutation(internal.accountingOutbox.recoverPeriodHeldSupplierVat, {}))
        .toEqual({ status: "READY", reclassified: 1 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    });

    const refused = await queuedRow(t, orgId, bad.cmd.idempotencyKey);
    expect(refused).toMatchObject({ status: "PENDING", attempts: 1, payload: bad.cmd.payload });
    expect(refused?.lastError).toMatch(REFUSAL);
    expect(refused?.dispatchState).toBeUndefined();
    expect(refused?.holdKind).toBeUndefined();
    expect(await footprint(t, orgId)).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(bad.payableId))).toEqual(payableBefore);
    expect(await Promise.all([zeroVat, owned].map((p) => queuedRow(t, orgId, p.cmd.idempotencyKey)))).toEqual(controlsBefore);
    if (door === "migration") {
      const checkpoint = await t.run((ctx) => ctx.db.query("supplierVatHoldMigration").unique());
      expect(checkpoint?.completedAt).toEqual(expect.any(Number));
      const jobsBefore = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(await t.mutation(internal.accountingOutbox.recoverPeriodHeldSupplierVat, {}))
        .toEqual({ status: "READY", reclassified: 0 });
      expect(await t.run((ctx) => ctx.db.query("supplierVatHoldMigration").unique())).toEqual(checkpoint);
      expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(jobsBefore);
      expect(await footprint(t, orgId)).toEqual(before);
    }
  });

  test("rollout migration resumes beyond the first page of valid period holds", async () => {
    const t = newTest();
    const { orgId, userId, periodId } = await seedOrg(t);
    const valid = await legacyPayment(t, orgId, userId);
    const bad = await legacyPayment(t, orgId, userId);
    valid.cmd.payload.taxMinor = 0;
    await t.run(async (ctx) => {
      await ctx.db.delete(periodId);
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("pendingAccountingEvents", {
          ...valid.cmd, idempotencyKey: `valid-held-${index}`, kind: "POST", status: "PENDING",
          attempts: 0, createdAt: Date.now(), dispatchState: "PERIOD_HELD", holdKind: "PERIOD",
        });
      }
      await enqueuePendingPost(ctx, bad.cmd, "Legacy period hold");
      const row = await ctx.db.query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", bad.cmd.idempotencyKey)).unique();
      if (!row) throw new Error("Fixture did not enqueue the payment");
      await ctx.db.patch(row._id, { dispatchState: "PERIOD_HELD", holdKind: "PERIOD" });
    });
    const before = await footprint(t, orgId);
    expect(await t.mutation(internal.accountingOutbox.recoverPeriodHeldSupplierVat, {}))
      .toEqual({ status: "MORE", reclassified: 0 });
    const checkpoint = await t.run((ctx) => ctx.db.query("supplierVatHoldMigration").unique());
    expect(checkpoint?.cursor).toEqual(expect.any(String));
    expect(checkpoint?.completedAt).toBeUndefined();
    expect((await queuedRow(t, orgId, bad.cmd.idempotencyKey))?.dispatchState).toBe("PERIOD_HELD");
    await withFrozenScheduler(async () => {
      expect(await t.mutation(internal.accountingOutbox.recoverPeriodHeldSupplierVat, {}))
        .toEqual({ status: "READY", reclassified: 1 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    });
    expect(await queuedRow(t, orgId, bad.cmd.idempotencyKey)).toMatchObject({ attempts: 1 });
    expect((await queuedRow(t, orgId, bad.cmd.idempotencyKey))?.lastError).toMatch(REFUSAL);
    const held = await t.run((ctx) => ctx.db.query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING")).collect());
    expect(held.filter((row) => row.dispatchState === "PERIOD_HELD")).toHaveLength(101);
    expect(await footprint(t, orgId)).toEqual(before);
  });

  async function historicalTaxedReplay(door: "direct" | "outbox"): Promise<void> {
    const t = newTest();
    const { orgId, userId, periodId } = await seedOrg(t);
    const { payableId, vehicleId, saleId, cmd } = await legacyPayment(t, orgId, userId);
    // Seed a historical VAT journal through the real engine, then restore the
    // consigned evidence. No production guard is mocked or disabled.
    await t.run(async (ctx) => {
      await ctx.db.patch(payableId, { saleId: undefined });
      await ctx.db.patch(vehicleId, { sourceType: "STOCK" });
    });
    const original = await t.run((ctx) => postAccountingEvent(ctx, cmd));
    expect(original.alreadyPosted).toBe(false);
    expect(await accountLines(t, orgId)).toEqual([
      { key: "ACCOUNTS_PAYABLE_SUPPLIERS", debit: 18_000_000, credit: 0 },
      { key: "CASH_ON_HAND", debit: 0, credit: 18_000_000 },
      { key: "VAT_RECEIVABLE", debit: 2_000_000, credit: 0 },
      { key: "COST_OF_VEHICLES_SOLD", debit: 0, credit: 2_000_000 },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(payableId, { saleId });
      await ctx.db.patch(vehicleId, { sourceType: "SOURCED" });
      await ctx.db.delete(periodId);
      if (door === "outbox") await enqueuePendingPost(ctx, cmd, "Legacy duplicate");
    });
    const before = await footprint(t, orgId);
    if (door === "direct") {
      expect(await t.run((ctx) => postAccountingEvent(ctx, cmd))).toEqual({ ...original, alreadyPosted: true });
    } else {
      await settleOutbox(t, orgId);
      expect(await queuedRow(t, orgId, cmd.idempotencyKey)).toMatchObject({
        status: "POSTED", attempts: 1, resultEventId: original.eventId,
      });
    }
    // Idempotency acknowledges history; it does not repair the historical VAT.
    expect(await footprint(t, orgId)).toEqual(before);
  }

  test("historical taxed settlement exact replay through direct returns the posted occurrence", () => historicalTaxedReplay("direct"));
  test("historical taxed settlement exact replay through outbox returns the posted occurrence", () => historicalTaxedReplay("outbox"));

  async function historicalReplayCollision(
    door: "direct" | "outbox",
    collision: "economics" | "source" | "key" | "reserved key",
  ): Promise<void> {
    const t = newTest();
    const { orgId, userId } = await seedOrg(t);
    const { payableId, vehicleId, cmd } = await legacyPayment(t, orgId, userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(payableId, { saleId: undefined });
      await ctx.db.patch(vehicleId, { sourceType: "STOCK" });
    });
    const original = await t.run((ctx) => postAccountingEvent(ctx, cmd));
    expect(original.alreadyPosted).toBe(false);
    if (collision === "economics") cmd.payload.amountMinor = 17_000_000;
    if (collision === "source") cmd.sourceId = "different-payable";
    if (collision === "key") cmd.idempotencyKey += "_different";
    if (collision === "reserved key") {
      cmd.idempotencyKey = "occv_untrusted";
      const eventId = original.eventId;
      if (!eventId) throw new Error("Fixture did not post the payment");
      await t.run((ctx) => ctx.db.patch(eventId, { idempotencyKey: cmd.idempotencyKey }));
    }
    const before = await footprint(t, orgId);
    if (door === "direct") {
      await expect(t.run((ctx) => postAccountingEvent(ctx, cmd))).rejects.toThrow(/SCRUM-249|reserved/i);
    } else {
      await t.run((ctx) => enqueuePendingPost(ctx, cmd, "Legacy non-exact replay"));
      await settleOutbox(t, orgId);
      expect(await queuedRow(t, orgId, cmd.idempotencyKey)).toMatchObject({
        attempts: 1, lastError: expect.stringMatching(/^SUPPLIER_REPLAY_REFUSED:/),
      });
    }
    expect(await footprint(t, orgId)).toEqual(before);
  }

  // The library requires a literal test registration for its executable binding.
  test("historical taxed settlement through outbox refuses a replay collision in economics", () =>
    historicalReplayCollision("outbox", "economics"));
  test.each([
    ["direct", "economics"], ["direct", "source"], ["direct", "key"], ["direct", "reserved key"],
    ["outbox", "source"], ["outbox", "key"], ["outbox", "reserved key"],
  ] as const)("historical taxed settlement through %s refuses a replay collision in %s", historicalReplayCollision);

  test("valid zero-VAT consigned payment posts gross beside a quarantined predecessor and does not duplicate", async () => {
    const t = newTest();
    const { orgId, userId } = await seedOrg(t);
    const bad = await legacyPayment(t, orgId, userId);
    const good = await legacyPayment(t, orgId, userId);
    good.cmd.payload.taxMinor = 0;
    await t.run(async (ctx) => {
      await ctx.db.patch(good.payableId, { taxAmount: 0 });
      await enqueuePendingPost(ctx, bad.cmd, "Legacy VAT");
      await enqueuePendingPost(ctx, good.cmd, "No open period when paid");
    });
    await settleOutbox(t, orgId);
    expect((await queuedRow(t, orgId, bad.cmd.idempotencyKey))?.lastError).toMatch(REFUSAL);
    expect((await queuedRow(t, orgId, good.cmd.idempotencyKey))?.status).toBe("POSTED");
    const lines = await accountLines(t, orgId);
    expect(lines).toEqual([
      { key: "ACCOUNTS_PAYABLE_SUPPLIERS", debit: 18_000_000, credit: 0 },
      { key: "CASH_ON_HAND", debit: 0, credit: 18_000_000 },
    ]);
    const beforeRetry = await footprint(t, orgId);
    await settleOutbox(t, orgId);
    const replay = await t.run((ctx) => postAccountingEvent(ctx, good.cmd));
    expect(replay.alreadyPosted).toBe(true);
    expect(await footprint(t, orgId)).toEqual(beforeRetry);
  });

  test.each(["AVAILABLE", "SOLD"] as const)("queued OWNED ON_ACCOUNT VAT retains its reclass when vehicle is %s", async (status) => {
    const t = newTest();
    const { orgId, userId } = await seedOrg(t);
    const { payableId, vehicleId, cmd } = await legacyPayment(t, orgId, userId);
    cmd.payload.costOrigin = status === "SOLD" ? "COGS" : "VEHICLE_INVENTORY";
    await t.run(async (ctx) => {
      await ctx.db.patch(payableId, { saleId: undefined });
      await ctx.db.patch(vehicleId, { sourceType: "STOCK", status });
      await enqueuePendingPost(ctx, cmd, "No open period when paid");
    });
    await settleOutbox(t, orgId);
    expect((await queuedRow(t, orgId, cmd.idempotencyKey))?.status).toBe("POSTED");
    expect(await accountLines(t, orgId)).toEqual([
      { key: "ACCOUNTS_PAYABLE_SUPPLIERS", debit: 18_000_000, credit: 0 },
      { key: "CASH_ON_HAND", debit: 0, credit: 18_000_000 },
      { key: "VAT_RECEIVABLE", debit: 2_000_000, credit: 0 },
      { key: status === "SOLD" ? "COST_OF_VEHICLES_SOLD" : "VEHICLE_INVENTORY", debit: 0, credit: 2_000_000 },
    ]);
  });

  test.each([
    "sale-linked vehicle now stock", "sourced without sale", "missing vehicle", "missing payable",
    "foreign payable", "foreign vehicle", "mismatched payload payable",
  ] as const)("queued VAT fails closed for %s", async (shape) => {
    const t = newTest();
    const { orgId, userId } = await seedOrg(t);
    const { payableId, vehicleId, cmd } = await legacyPayment(t, orgId, userId);
    await t.run(async (ctx) => {
      if (shape === "sale-linked vehicle now stock") await ctx.db.patch(vehicleId, { sourceType: "STOCK" });
      if (shape === "sourced without sale" || shape === "missing vehicle" || shape === "foreign vehicle") {
        await ctx.db.patch(payableId, { saleId: undefined });
      }
      if (shape === "missing vehicle") await ctx.db.delete(vehicleId);
      if (shape === "missing payable") await ctx.db.delete(payableId);
      if (shape === "foreign payable" || shape === "foreign vehicle") {
        const otherOrg = await ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() });
        if (shape === "foreign payable") await ctx.db.patch(payableId, { orgId: otherOrg });
        else await ctx.db.patch(vehicleId, { orgId: otherOrg, sourceType: "STOCK" });
      }
      if (shape === "mismatched payload payable") cmd.payload.payableId = "unverified";
      await enqueuePendingPost(ctx, cmd, "Legacy VAT");
    });
    const before = await footprint(t, orgId);
    await settleOutbox(t, orgId);
    expect((await queuedRow(t, orgId, cmd.idempotencyKey))?.lastError).toMatch(REFUSAL);
    expect((await queuedRow(t, orgId, cmd.idempotencyKey))?.attempts).toBe(1);
    expect(await footprint(t, orgId)).toEqual(before);
  });

});
