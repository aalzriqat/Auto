/**
 * SCRUM-230 — the monthly fixed-asset depreciation and F&I commission
 * recognition crons must (1) isolate one item's failure from every other item
 * in the cross-org run and (2) catch up every missed calendar month, each dated
 * in its own month, exactly once.
 *
 * Invariant: every calendar month an ACTIVE asset / deferral is eligible for is
 * posted exactly once, dated in its own month (occurredAt = min(endOfMonth(m),
 * now)), whichever run first succeeds — unless the item leaves ACTIVE first.
 * One item's failure never prevents any other item (any org) being processed.
 *
 * Forcing a throw: a real data condition wherever one exists — an unsupported
 * currency on the row (scaleForCurrency refuses it inside the posting engine),
 * or a REVERSED accounting event already holding the month's idempotency key.
 * The F&I mutation turns the latter into a counted skip, so its mid-catch-up
 * throw alone uses a narrowly scoped vi.spyOn on the posting hook (call #2).
 *
 * Clock: Date only is faked (so _creationTime and "now" are explicit);
 * timers stay real except inside drainOutbox, where the scheduler needs them.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { drainEntries } from "./accountingOutbox";
import * as workflowHooks from "./accounting/workflowHooks";
import * as webhookLog from "./utils/webhookLog";
import { firstOfferableMonthIndex, yearMonthFromIndex, yearMonthIndex } from "./utils/expenseAmortization";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

const PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "view:vehicles",
  "create:expenses", "edit:expenses", "view:expenses",
  "create:sales", "view:sales", "view:commissions", "manage:commissions",
  "view:finance", "manage:finance", "view:reports", "reopen:accounting_periods",
];

const FEB_10 = Date.UTC(2026, 1, 10, 9, 0, 0);
const APR_15 = Date.UTC(2026, 3, 15, 9, 0, 0);

type Harness = ReturnType<typeof convexTestWithComponents>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FEB_10);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── seeding ──────────────────────────────────────────────────────────────────

async function seedOrg(t: Harness, suffix: string, periods: "wide" | "closedJanFeb" = "wide") {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `SCRUM-230 Dealer ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${suffix}`, email: `${suffix}@example.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId, commissionRate: 10 }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Jane", lastName: "Doe", email: `${suffix}.cust@example.com` })
  );
  const asOwner = t.withIdentity({ subject: `owner_${suffix}`, clerkId: `owner_${suffix}` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

  if (periods === "wide") {
    await asOwner.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2026, periodNumber: 1,
    });
    const [period] = await asOwner.query(api.accountingPeriods.list, { orgId });
    await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  } else {
    await asOwner.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2026, 1, 28, 23, 59, 59, 999),
      fiscalYear: 2026, periodNumber: 1,
    });
    await asOwner.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(2026, 2, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2026, periodNumber: 2,
    });
    for (const p of await asOwner.query(api.accountingPeriods.list, { orgId })) {
      await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: p._id });
    }
  }
  return { orgId, userId, asOwner, customerId };
}

type Org = Awaited<ReturnType<typeof seedOrg>>;

async function capitalizeAsset(org: Org, name: string) {
  return await org.asOwner.mutation(api.fixedAssets.capitalize, {
    idempotencyKey: crypto.randomUUID(),
    orgId: org.orgId,
    name,
    purchaseDate: Date.now(),
    costMinor: 1_200_000,
    usefulLifeMonths: 12,
  });
}

async function createDeferral(t: Harness, org: Org, tag: string) {
  const vehicleId = await org.asOwner.mutation(api.vehicles.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: org.orgId,
    vin: `1HGCM82633A${tag}`, make: "Honda", model: "Accord", year: 2020, mileage: 10000, color: "White",
    fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20000, status: "AVAILABLE", sourceType: "STOCK",
    purchasePrice: 10000, purchasePaymentMethod: "CASH",
  });
  const saleId = await org.asOwner.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: org.orgId, vehicleId, customerId: org.customerId, salespersonId: org.userId,
    salePrice: 15000, warrantySold: 500, warrantyCost: 300, warrantyTermMonths: 12,
    saleDate: Date.now(), status: "COMPLETED",
  });
  const deferral = await t.run((ctx) =>
    ctx.db.query("dealerProductDeferrals").withIndex("by_sale", (q) => q.eq("saleId", saleId)).first()
  );
  expect(deferral).not.toBeNull();
  return deferral!._id;
}

// ─── observation ──────────────────────────────────────────────────────────────

const monthOf = (ts: number) => yearMonthFromIndex(yearMonthIndex(ts));

async function depreciationEvents(t: Harness, orgId: Id<"organizations">) {
  const rows = await t.run((ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", "DEPRECIATION_POSTED")).collect()
  );
  return rows.sort((a, b) => a._creationTime - b._creationTime);
}

async function fiEvents(t: Harness, orgId: Id<"organizations">) {
  const rows = await t.run((ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", "FI_COMMISSION_RECOGNIZED")).collect()
  );
  return rows.sort((a, b) => a.eventVersion - b.eventVersion);
}

async function cronReports(t: Harness, source: string) {
  const rows = await t.run((ctx) => ctx.db.query("webhookLogs").take(500));
  return rows.filter((r) => r.source === source);
}

async function pendingDepreciation(t: Harness, orgId: Id<"organizations">) {
  const rows = await t.run((ctx) =>
    ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING")).collect()
  );
  return rows.filter((r) => r.eventType === "DEPRECIATION_POSTED");
}

async function glBalanceMinor(t: Harness, orgId: Id<"organizations">, systemKey: string) {
  const account = await t.run((ctx) =>
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey)).unique()
  );
  const lines = await t.run((ctx) => ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
  return lines.filter((l) => l.accountId === account!._id).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
}

const runDepreciation = (t: Harness): Promise<string> => t.action(internal.crons.triggerFixedAssetDepreciation, {});
const runRecognition = (t: Harness): Promise<string> => t.action(internal.crons.triggerFiCommissionRecognition, {});

/** The queued-post drain needs the scheduler's timers; restore the Date-only fake afterwards. */
async function drainOutbox(t: Harness, orgId: Id<"organizations">) {
  const now = Date.now();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now });
  try {
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING")).take(50);
      for (const row of rows) if (row.dispatchState === undefined) await ctx.db.patch(row._id, { nextActionAt: undefined });
      return await drainEntries(ctx, rows);
    });
    for (let pass = 0; pass < 10; pass += 1) {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const queued = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()))
        .filter((f) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
      if (queued === 0) break;
    }
  } finally {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  }
}

// ─── 7. the pure helper ───────────────────────────────────────────────────────

describe("firstOfferableMonthIndex", () => {
  const idx = (ym: string) => yearMonthIndex(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 15));

  test("creation month is INCLUSIVE when nothing was posted and the start date is earlier", () => {
    expect(firstOfferableMonthIndex({ createdAt: Date.UTC(2026, 1, 28, 23, 59), startAt: Date.UTC(2025, 5, 1) })).toBe(idx("2026-02"));
  });

  test("last posted month + 1 wins when it is later than creation and start", () => {
    expect(
      firstOfferableMonthIndex({ lastPostedYearMonth: "2026-03", createdAt: Date.UTC(2026, 0, 5), startAt: Date.UTC(2026, 0, 1) })
    ).toBe(idx("2026-04"));
  });

  test("last posted month + 1 rolls over a year end", () => {
    expect(firstOfferableMonthIndex({ lastPostedYearMonth: "2025-12", createdAt: Date.UTC(2025, 0, 5) })).toBe(idx("2026-01"));
  });

  test("a depreciation start date later than creation and last posted bounds the first month", () => {
    expect(
      firstOfferableMonthIndex({ lastPostedYearMonth: "2026-01", createdAt: Date.UTC(2026, 0, 5), startAt: Date.UTC(2026, 5, 1) })
    ).toBe(idx("2026-06"));
  });

  test("a deferral has no start date: creation month, or last recognized + 1", () => {
    expect(firstOfferableMonthIndex({ createdAt: Date.UTC(2026, 2, 31, 23, 59, 59) })).toBe(idx("2026-03"));
    expect(firstOfferableMonthIndex({ lastPostedYearMonth: "2026-05", createdAt: Date.UTC(2026, 2, 1) })).toBe(idx("2026-06"));
  });

  test("a last-posted month earlier than the creation month does not reach back before creation", () => {
    expect(firstOfferableMonthIndex({ lastPostedYearMonth: "2025-01", createdAt: Date.UTC(2026, 2, 1) })).toBe(idx("2026-03"));
  });
});

// ─── 1 + 4. isolation ─────────────────────────────────────────────────────────

describe("one item's failure never starves another org", () => {
  test("depreciation: org A's poisoned asset (first in scan order) does not stop org B", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const a = await seedOrg(t, "iso_a");
    const b = await seedOrg(t, "iso_b");
    const assetA = await capitalizeAsset(a, "Poisoned");
    await capitalizeAsset(b, "Healthy");
    await t.run((ctx) => ctx.db.patch(assetA, { currency: "ZZZ" })); // the posting engine refuses an unknown currency

    const summary = await runDepreciation(t);

    expect(await depreciationEvents(t, b.orgId)).toHaveLength(1);
    expect(await depreciationEvents(t, a.orgId)).toHaveLength(0);
    expect(summary).toMatch(/1 failed/);
    const reports = await cronReports(t, "fixed-asset-depreciation");
    expect(reports.some((r) => r.status === "error" && r.error?.includes("currency"))).toBe(true);
  });

  test("recognition: org A's poisoned deferral (first in scan order) does not stop org B", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const a = await seedOrg(t, "isf_a");
    const b = await seedOrg(t, "isf_b");
    const deferralA = await createDeferral(t, a, "000001");
    await createDeferral(t, b, "000002");
    await t.run((ctx) => ctx.db.patch(deferralA, { currency: "ZZZ" }));

    const summary = await runRecognition(t);

    expect(await fiEvents(t, b.orgId)).toHaveLength(1);
    expect(await fiEvents(t, a.orgId)).toHaveLength(0);
    expect(summary).toMatch(/1 failed/);
  });

  test("a recorder that itself throws cannot break isolation (depreciation)", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const a = await seedOrg(t, "rec_a");
    const b = await seedOrg(t, "rec_b");
    const assetA = await capitalizeAsset(a, "Poisoned");
    await capitalizeAsset(b, "Healthy");
    await t.run((ctx) => ctx.db.patch(assetA, { currency: "ZZZ" }));

    const original = webhookLog.recordWebhookLog;
    // Only the per-item failure rows fail to record; the run-level summary row still writes.
    vi.spyOn(webhookLog, "recordWebhookLog").mockImplementation(async (ctx, args) => {
      if (args.status === "error" && /item/i.test(args.summary)) throw new Error("recorder down");
      return await original(ctx, args);
    });

    const summary = await runDepreciation(t);

    expect(await depreciationEvents(t, b.orgId)).toHaveLength(1);
    expect(summary).toMatch(/1 failed/);
  });
});

// ─── 2 + 3. catch-up ──────────────────────────────────────────────────────────

describe("catch-up posts every missed month in its own month", () => {
  test("depreciation: three missed months -> three POSTED events, each dated in its own month", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const org = await seedOrg(t, "cu_dep");
    const assetId = await capitalizeAsset(org, "Van"); // created Feb 10
    vi.setSystemTime(APR_15);

    const summary = await runDepreciation(t);

    const events = await depreciationEvents(t, org.orgId);
    expect(events.map((e) => e.status)).toEqual(["POSTED", "POSTED", "POSTED"]);
    expect(events.map((e) => e.idempotencyKey.slice(-7))).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(events.map((e) => monthOf(e.occurredAt))).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(events[2].occurredAt).toBe(APR_15); // the current month is dated as-of-now, never the future
    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.monthsDepreciated).toBe(3);
    expect(asset?.accumulatedDepreciationMinor).toBe(300_000);
    expect(summary).toMatch(/posted 1\/1/);

    // A second run in the same month is a no-op.
    await runDepreciation(t);
    expect(await depreciationEvents(t, org.orgId)).toHaveLength(3);
  });

  test("recognition: three missed months -> eventVersion 1..3, each dated in its own month", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const org = await seedOrg(t, "cu_fi");
    await createDeferral(t, org, "000003"); // created Feb 10
    vi.setSystemTime(APR_15);

    const summary = await runRecognition(t);

    const events = await fiEvents(t, org.orgId);
    expect(events.map((e) => e.eventVersion)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.status)).toEqual(["POSTED", "POSTED", "POSTED"]);
    expect(events.map((e) => monthOf(e.occurredAt))).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(summary).toMatch(/posted 1\/1/);
  });

  test("depreciation: a throw at month 2 stops the item there; the next run posts month 2 then 3 in order", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const org = await seedOrg(t, "mid_dep");
    const assetId = await capitalizeAsset(org, "Van");
    vi.setSystemTime(APR_15);
    const userId = org.userId;
    // A REVERSED event already owns March's idempotency key: posting it throws.
    const poisonId = await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId: org.orgId, eventType: "DEPRECIATION_POSTED", sourceType: "fixedAssets",
        sourceId: `depr_${assetId}_2026-03`, eventVersion: 1, idempotencyKey: `depr_${assetId}_2026-03`,
        occurredAt: Date.UTC(2026, 2, 31), accountingDate: Date.UTC(2026, 2, 31), currency: "JOD",
        payload: {}, status: "REVERSED", createdBy: userId, createdAt: Date.now(),
      })
    );

    const first = await runDepreciation(t);
    expect(first).toMatch(/1 failed/);
    let asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.lastDepreciatedYearMonth).toBe("2026-02"); // April was NOT posted past the failed March
    expect((await depreciationEvents(t, org.orgId)).filter((e) => e.status === "POSTED")).toHaveLength(1);

    await t.run((ctx) => ctx.db.delete(poisonId));
    await runDepreciation(t);

    asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.lastDepreciatedYearMonth).toBe("2026-04");
    const posted = (await depreciationEvents(t, org.orgId)).filter((e) => e.status === "POSTED");
    expect(posted.map((e) => e.idempotencyKey.slice(-7))).toEqual(["2026-02", "2026-03", "2026-04"]);
  });

  test("recognition: a throw at month 2 stops the item there; the next run posts month 2 then 3 in order", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const org = await seedOrg(t, "mid_fi");
    const deferralId = await createDeferral(t, org, "000004");
    vi.setSystemTime(APR_15);

    const original = workflowHooks.hookFiCommissionRecognized;
    let calls = 0;
    const spy = vi.spyOn(workflowHooks, "hookFiCommissionRecognized").mockImplementation(async (ctx, args) => {
      calls += 1;
      if (calls === 2) throw new Error("injected failure at month 2");
      return await original(ctx, args);
    });

    const first = await runRecognition(t);
    expect(first).toMatch(/1 failed/);
    expect(calls).toBe(2); // month 3 was never attempted
    let deferral = await t.run((ctx) => ctx.db.get(deferralId));
    expect(deferral?.monthsRecognized).toBe(1);

    spy.mockRestore();
    await runRecognition(t);

    deferral = await t.run((ctx) => ctx.db.get(deferralId));
    expect(deferral?.monthsRecognized).toBe(3);
    const events = await fiEvents(t, org.orgId);
    expect(events.map((e) => e.eventVersion)).toEqual([1, 2, 3]);
    expect(events.map((e) => monthOf(e.occurredAt))).toEqual(["2026-02", "2026-03", "2026-04"]);
  });
});

// ─── 5. closed period ─────────────────────────────────────────────────────────

describe("a back-dated month into a closed period is queued in its own month, never posted into the current one", () => {
  test("queued -> blocks the close checklist -> reopen + drain -> subledger equals GL", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const org = await seedOrg(t, "closed_dep", "closedJanFeb");
    const assetId = await capitalizeAsset(org, "Van"); // created Feb 10, inside period 1

    const [p1] = (await org.asOwner.query(api.accountingPeriods.list, { orgId: org.orgId }))
      .sort((x, y) => x.startDate - y.startDate);
    const checklist = await org.asOwner.query(api.accountingPeriods.closeChecklist, { orgId: org.orgId, periodId: p1._id });
    await org.asOwner.mutation(api.accountingPeriods.close, {
      orgId: org.orgId, periodId: p1._id, acknowledgedWarnings: checklist.warnings,
    });

    vi.setSystemTime(APR_15);
    await runDepreciation(t);

    // Feb is queued dated in February; Mar + Apr posted into the open period.
    const pending = await pendingDepreciation(t, org.orgId);
    expect(pending).toHaveLength(1);
    expect(monthOf(pending[0].accountingDate)).toBe("2026-02");
    expect((await depreciationEvents(t, org.orgId)).map((e) => monthOf(e.occurredAt))).toEqual(["2026-03", "2026-04"]);

    const blocked = await org.asOwner.query(api.accountingPeriods.closeChecklist, { orgId: org.orgId, periodId: p1._id });
    expect(blocked.canClose).toBe(false);
    expect(blocked.pendingOutboxEventCount).toBe(1);

    await org.asOwner.mutation(api.accountingPeriods.reopen, { orgId: org.orgId, periodId: p1._id, reason: "post missed depreciation" });
    await drainOutbox(t, org.orgId);

    const events = await depreciationEvents(t, org.orgId);
    expect(events.map((e) => monthOf(e.occurredAt)).sort()).toEqual(["2026-02", "2026-03", "2026-04"]);
    const asset = await t.run((ctx) => ctx.db.get(assetId));
    // Subledger (asset.accumulatedDepreciationMinor) equals what reached the GL.
    expect(asset?.accumulatedDepreciationMinor).toBe(300_000);
    expect(-(await glBalanceMinor(t, org.orgId, "ACCUMULATED_DEPRECIATION"))).toBe(300_000);
  });
});

// ─── 6. abnormal vs done ──────────────────────────────────────────────────────

describe("abnormal stop reasons are counted apart from normal completions", () => {
  test("ledger_occurrence_conflict is reported as abnormal, not as a routine skip", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const org = await seedOrg(t, "abn_fi");
    const deferralId = await createDeferral(t, org, "000005");
    // The ledger already holds occurrence 1 of this deferral under another key.
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId: org.orgId, eventType: "FI_COMMISSION_RECOGNIZED", sourceType: "dealerProductDeferrals",
        sourceId: deferralId.toString(), eventVersion: 1, idempotencyKey: "foreign_key_for_occurrence_1",
        occurredAt: Date.now(), accountingDate: Date.now(), currency: "JOD", payload: {},
        status: "POSTED", createdBy: org.userId, createdAt: Date.now(),
      })
    );

    const summary = await runRecognition(t);

    expect(summary).toMatch(/1 stopped abnormally \(ledger_occurrence_conflict=1\)/);
    expect(summary).toMatch(/0 failed/);
    expect(await fiEvents(t, org.orgId)).toHaveLength(1); // only the foreign row; nothing new posted
  });

  test("a clean run reports zero abnormal stops", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const org = await seedOrg(t, "abn_ok");
    await capitalizeAsset(org, "Van");

    const summary = await runDepreciation(t);

    expect(summary).toMatch(/0 stopped abnormally/);
    expect(summary).toMatch(/0 failed/);
  });
});
